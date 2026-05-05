"""
hegg.store
==========

SQLite-backed time-series store for :class:`~hegg.reading.HeggReading` objects.

Readings are stored verbatim (1 s resolution) and queried in time-bucketed
aggregates so the frontend does not have to receive 600k+ raw rows for a
week-long chart.

Schema
------

A single ``readings`` table indexed on Unix-millisecond timestamp.  WAL mode
is enabled so the Flask reader thread does not block the UDP writer thread.

Retention
---------

Call :meth:`HeggStore.prune` periodically (e.g. every hour) to delete rows
older than :data:`RETENTION_DAYS`.  The unified launcher does this on a
background timer.
"""

import json
import os
import sqlite3
import threading
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Optional, Union

from hegg.reading import HeggReading

#: Fallback database filename used by default_db_path() and HeggStore.
_DEFAULT_DB_NAME: str = "hegg.db"

#: Number of days of raw readings to retain.
RETENTION_DAYS: int = 7


def default_db_path() -> str:
    """Return a sensible default path for the SQLite database.

    Resolution order:

    1. ``HEGG_DB`` environment variable, if set.
    2. ``/var/lib/hegg/hegg.db`` if the directory exists and is writable
       (i.e. we are running as the ``hegg`` system user on a production host).
    3. ``db/hegg.db`` relative to the repository root (present working
       directory) if that directory exists — useful for local dev.
    4. ``hegg.db`` in the current working directory as a last resort.

    Returns:
        Absolute or relative path string suitable for :class:`HeggStore`.
    """
    # 1. Explicit environment override.
    env = os.getenv("HEGG_DB")
    if env:
        return env

    # 2. Production system path.
    system_dir = "/var/lib/hegg"
    if os.path.isdir(system_dir) and os.access(system_dir, os.W_OK):
        return os.path.join(system_dir, _DEFAULT_DB_NAME)

    # 3. db/ subdirectory in the current working directory (dev layout).
    db_dir = os.path.join(os.getcwd(), "db")
    if os.path.isdir(db_dir):
        return os.path.join(db_dir, _DEFAULT_DB_NAME)

    # 4. Flat file next to wherever we are running from.
    return _DEFAULT_DB_NAME


_DDL = """
CREATE TABLE IF NOT EXISTS readings (
    id         INTEGER PRIMARY KEY,
    ts         INTEGER NOT NULL,
    serial     TEXT    NOT NULL,
    delivered  REAL    NOT NULL,
    returned   REAL    NOT NULL,
    voltage_l1 REAL    NOT NULL,
    voltage_l2 REAL    NOT NULL,
    voltage_l3 REAL    NOT NULL,
    current_l1 REAL    NOT NULL,
    current_l2 REAL    NOT NULL,
    current_l3 REAL    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ts ON readings (ts);

CREATE TABLE IF NOT EXISTS events (
    id     INTEGER PRIMARY KEY,
    ts     INTEGER NOT NULL,
    serial TEXT    NOT NULL,
    raw    TEXT    NOT NULL,
    UNIQUE (ts, serial)
);
CREATE INDEX IF NOT EXISTS idx_events_ts ON events (ts);

CREATE TABLE IF NOT EXISTS summaries (
    id                       INTEGER PRIMARY KEY,
    ts                       INTEGER NOT NULL UNIQUE,
    serial                   TEXT    NOT NULL,
    swVersion                INTEGER,
    equipment_id             TEXT,
    model                    TEXT,
    wifiRSSI                 INTEGER,
    energy_delivered_tariff1 REAL,
    energy_delivered_tariff2 REAL,
    energy_returned_tariff1  REAL,
    energy_returned_tariff2  REAL,
    gas_delivered            REAL
);
CREATE INDEX IF NOT EXISTS idx_summaries_ts ON summaries (ts);
"""

_INSERT = """
INSERT INTO readings
    (ts, serial, delivered, returned,
     voltage_l1, voltage_l2, voltage_l3,
     current_l1, current_l2, current_l3)
VALUES (?,?,?,?,?,?,?,?,?,?)
"""

_QUERY = """
SELECT
    (ts / ?) * ? AS bucket,
    AVG(delivered),
    AVG(returned),
    AVG(voltage_l1), AVG(voltage_l2), AVG(voltage_l3),
    AVG(current_l1), AVG(current_l2), AVG(current_l3)
FROM readings
WHERE ts >= ?
GROUP BY bucket
ORDER BY bucket ASC
"""


class HeggStore:
    """Thread-safe SQLite store for Hegg energy readings.

    Uses a per-thread connection pool with WAL journal mode to allow
    concurrent reads from Flask threads alongside writes from the UDP
    listener thread.

    Args:
        path: Filesystem path to the SQLite database file.
    """

    def __init__(self, path: Union[str, Path] = _DEFAULT_DB_NAME) -> None:
        self._path = str(path)
        self._local = threading.local()
        self._write_lock = threading.Lock()
        # Trigger schema creation on the calling thread's connection.
        self._conn()

    def _conn(self) -> sqlite3.Connection:
        """Return (or create) the per-thread SQLite connection.

        Creates the schema on first use for each thread.  The DDL uses
        ``CREATE TABLE IF NOT EXISTS`` throughout, so it is safe to run on
        every new connection — including per-thread Flask connections and
        ``:memory:`` databases used in tests.

        Returns:
            An open :class:`sqlite3.Connection` for the current thread.
        """
        if not hasattr(self._local, "conn"):
            conn = sqlite3.connect(self._path, check_same_thread=False)
            conn.execute("PRAGMA journal_mode=WAL")
            conn.execute("PRAGMA synchronous=NORMAL")
            conn.executescript(_DDL)
            self._migrate(conn)
            conn.commit()
            self._local.conn = conn
        return self._local.conn

    # Columns renamed from store-internal names to wire format names (2026-05).
    _COLUMN_RENAMES = [
        ("summaries", "sw_version",          "swVersion"),
        ("summaries", "wifi_rssi",            "wifiRSSI"),
        ("summaries", "energy_delivered_t1",  "energy_delivered_tariff1"),
        ("summaries", "energy_delivered_t2",  "energy_delivered_tariff2"),
        ("summaries", "energy_returned_t1",   "energy_returned_tariff1"),
        ("summaries", "energy_returned_t2",   "energy_returned_tariff2"),
    ]

    def _migrate(self, conn: sqlite3.Connection) -> None:
        """Apply idempotent column renames to an existing database.

        Uses ``ALTER TABLE … RENAME COLUMN`` (SQLite 3.25+).  Each statement
        is attempted individually; if the old column does not exist (fresh DB
        or already migrated), the OperationalError is silently ignored.

        Args:
            conn: Open SQLite connection on which to run the migrations.
        """
        for table, old, new in self._COLUMN_RENAMES:
            try:
                conn.execute(
                    f"ALTER TABLE {table} RENAME COLUMN {old} TO {new}"
                )
                conn.commit()
            except sqlite3.OperationalError:
                pass  # already renamed, or old column never existed

    def insert(self, reading: HeggReading) -> None:
        """Persist a single reading.

        Thread-safe: a write lock serialises concurrent inserts.

        Args:
            reading: The parsed reading to store.
        """
        ts_ms = int(reading.timestamp.timestamp() * 1000)
        params = (
            ts_ms, reading.serial,
            reading.power_delivered, reading.power_returned,
            reading.voltage_l1, reading.voltage_l2, reading.voltage_l3,
            reading.current_l1, reading.current_l2, reading.current_l3,
        )
        with self._write_lock:
            conn = self._conn()
            conn.execute(_INSERT, params)
            conn.commit()

    def _row_to_dict(self, row: tuple) -> dict:
        """Convert a raw SQLite row tuple to a reading dict.

        Args:
            row: Tuple of (ts_ms, serial, delivered, returned,
                 voltage_l1..l3, current_l1..l3).

        Returns:
            Dict with string ``timestamp`` (ISO 8601 UTC) and numeric fields.
        """
        ts = datetime.fromtimestamp(row[0] / 1000, tz=timezone.utc).isoformat()
        return {
            "timestamp":       ts,
            "serial":          row[1],
            "power_delivered": row[2],
            "power_returned":  row[3],
            "voltage_l1": row[4], "voltage_l2": row[5], "voltage_l3": row[6],
            "current_l1": row[7], "current_l2": row[8], "current_l3": row[9],
        }

    def query_raw_since(self, since_ts_ms: int, limit: int = 0) -> list:
        """Return individual (non-aggregated) readings newer than *since_ts_ms*.

        Intended for the SSE stream endpoint, which polls this every second
        to tail new rows in insertion order.

        Args:
            since_ts_ms: Unix timestamp in milliseconds (exclusive lower bound).
            limit:       Maximum rows to return; 0 means no limit.

        Returns:
            List of reading dicts ordered oldest-first.
        """
        sql = (
            "SELECT ts, serial, delivered, returned, "
            "voltage_l1, voltage_l2, voltage_l3, "
            "current_l1, current_l2, current_l3 "
            "FROM readings WHERE ts > ? ORDER BY ts ASC"
        )
        params: list = [since_ts_ms]
        if limit:
            sql += " LIMIT ?"
            params.append(limit)
        rows = self._conn().execute(sql, params).fetchall()
        return [self._row_to_dict(r) for r in rows]

    def query(self, since: datetime, bucket_seconds: int = 60) -> list:
        """Return bucketed average readings since *since*.

        Each bucket covers *bucket_seconds* seconds and contains the average
        of all readings that fall within it.

        Args:
            since:          Start of the query window (UTC).
            bucket_seconds: Aggregation bucket width in seconds.

        Returns:
            List of dicts with keys matching :meth:`~hegg.reading.HeggReading.to_dict`,
            plus ``timestamp`` as an ISO 8601 string (bucket midpoint, UTC).
        """
        bucket_ms = bucket_seconds * 1000
        since_ms = int(since.timestamp() * 1000)
        rows = self._conn().execute(_QUERY, (bucket_ms, bucket_ms, since_ms)).fetchall()

        result = []
        for r in rows:
            ts = datetime.fromtimestamp(r[0] / 1000, tz=timezone.utc).isoformat()
            result.append({
                "timestamp":       ts,
                "power_delivered": r[1],
                "power_returned":  r[2],
                "voltage_l1": r[3], "voltage_l2": r[4], "voltage_l3": r[5],
                "current_l1": r[6], "current_l2": r[7], "current_l3": r[8],
            })
        return result

    def insert_event(self, data: dict) -> None:
        """Store a raw event packet (e.g. a minute-summary) as JSON.

        Duplicate (ts, serial) pairs are silently ignored.

        Args:
            data: Full parsed packet dict.  Must contain ``timestamp`` and
                  ``serial`` keys.
        """
        ts_str = data.get("timestamp", "")
        try:
            ts_dt = datetime.fromisoformat(ts_str.rstrip("Z") + "+00:00")
            ts_ms = int(ts_dt.timestamp() * 1000)
        except (ValueError, AttributeError):
            ts_ms = int(datetime.now(timezone.utc).timestamp() * 1000)

        serial = data.get("serial", "unknown")
        with self._write_lock:
            self._conn().execute(
                "INSERT OR IGNORE INTO events (ts, serial, raw) VALUES (?,?,?)",
                (ts_ms, serial, json.dumps(data)),
            )
            self._conn().commit()

    def query_events(self, limit: int = 50) -> list:
        """Return recent event packets, newest first.

        Args:
            limit: Maximum number of rows to return.

        Returns:
            List of raw dicts (as stored), newest first.
        """
        rows = self._conn().execute(
            "SELECT raw FROM events ORDER BY ts DESC LIMIT ?", (limit,)
        ).fetchall()
        return [json.loads(r[0]) for r in rows]

    def insert_summary(self, data: dict) -> None:
        """Store a minute-summary packet into the ``summaries`` table.

        Duplicate timestamps are ignored (UNIQUE constraint).

        Args:
            data: Parsed summary packet dict.
        """
        ts_str = data.get("timestamp", "")
        try:
            ts_dt = datetime.fromisoformat(ts_str.rstrip("Z") + "+00:00")
            ts_ms = int(ts_dt.timestamp() * 1000)
        except (ValueError, AttributeError):
            ts_ms = int(datetime.now(timezone.utc).timestamp() * 1000)

        with self._write_lock:
            self._conn().execute(
                """
                INSERT OR IGNORE INTO summaries
                    (ts, serial, swVersion, equipment_id, model, wifiRSSI,
                     energy_delivered_tariff1, energy_delivered_tariff2,
                     energy_returned_tariff1,  energy_returned_tariff2, gas_delivered)
                VALUES (?,?,?,?,?,?,?,?,?,?,?)
                """,
                (
                    ts_ms,
                    data.get("serial"),
                    data.get("swVersion"),
                    data.get("equipment_id"),
                    data.get("model"),
                    data.get("wifiRSSI"),
                    data.get("energy_delivered_tariff1"),
                    data.get("energy_delivered_tariff2"),
                    data.get("energy_returned_tariff1"),
                    data.get("energy_returned_tariff2"),
                    data.get("gas_delivered"),
                ),
            )
            self._conn().commit()

    def latest_reading(self) -> "Optional[HeggReading]":
        """Return the most recent 1-second reading, or ``None`` if the store is empty.

        Constructs a :class:`~hegg.reading.HeggReading` directly from the DB
        row to avoid any timestamp-format ambiguity.

        Returns:
            The newest :class:`~hegg.reading.HeggReading`, or ``None``.
        """
        from hegg.reading import HeggReading
        row = self._conn().execute(
            "SELECT ts, serial, delivered, returned, "
            "voltage_l1, voltage_l2, voltage_l3, "
            "current_l1, current_l2, current_l3 "
            "FROM readings ORDER BY ts DESC LIMIT 1"
        ).fetchone()
        if row is None:
            return None
        return HeggReading(
            timestamp=datetime.fromtimestamp(row[0] / 1000, tz=timezone.utc),
            serial=row[1],
            power_delivered=row[2],
            power_returned=row[3],
            voltage_l1=row[4],
            voltage_l2=row[5],
            voltage_l3=row[6],
            current_l1=row[7],
            current_l2=row[8],
            current_l3=row[9],
        )

    def latest_summary(self) -> dict:
        """Return the most recent summary packet, or an empty dict.

        Returns:
            Dict with summary fields, or ``{}`` if no summary has been stored.
        """
        row = self._conn().execute(
            """
            SELECT ts, serial, swVersion, equipment_id, model, wifiRSSI,
                   energy_delivered_tariff1, energy_delivered_tariff2,
                   energy_returned_tariff1,  energy_returned_tariff2, gas_delivered
            FROM summaries ORDER BY ts DESC LIMIT 1
            """
        ).fetchone()
        if row is None:
            return {}
        return {
            "timestamp":               datetime.fromtimestamp(row[0] / 1000, tz=timezone.utc).isoformat(),
            "serial":                  row[1],
            "swVersion":               row[2],
            "equipment_id":            row[3],
            "model":                   row[4],
            "wifiRSSI":                row[5],
            "energy_delivered_tariff1": row[6],
            "energy_delivered_tariff2": row[7],
            "energy_returned_tariff1":  row[8],
            "energy_returned_tariff2":  row[9],
            "gas_delivered":            row[10],
        }

    def summary_delta(self, hours: int) -> dict:
        """Compute cumulative deltas over the last *hours* hours.

        Subtracts the oldest summary within the window from the most recent
        one, giving the change in meter readings (kWh delivered/returned,
        gas) over the selected period.

        Args:
            hours: Number of hours to look back.

        Returns:
            Dict with keys ``energy_delivered``, ``energy_returned``,
            ``gas_delivered`` (all floats), or ``{}`` if fewer than two
            summary rows exist in the window.
        """
        since_ms = int(
            (datetime.now(timezone.utc) - timedelta(hours=hours)).timestamp() * 1000
        )
        oldest = self._conn().execute(
            """
            SELECT energy_delivered_tariff1, energy_delivered_tariff2,
                   energy_returned_tariff1,  energy_returned_tariff2, gas_delivered
            FROM summaries WHERE ts >= ? ORDER BY ts ASC LIMIT 1
            """,
            (since_ms,),
        ).fetchone()
        latest = self._conn().execute(
            """
            SELECT energy_delivered_tariff1, energy_delivered_tariff2,
                   energy_returned_tariff1,  energy_returned_tariff2, gas_delivered
            FROM summaries ORDER BY ts DESC LIMIT 1
            """
        ).fetchone()
        if oldest is None or latest is None:
            return {}

        def _v(row, i): return row[i] or 0.0

        return {
            "energy_delivered_tariff1": _v(latest, 0) - _v(oldest, 0),
            "energy_delivered_tariff2": _v(latest, 1) - _v(oldest, 1),
            "energy_returned_tariff1":  _v(latest, 2) - _v(oldest, 2),
            "energy_returned_tariff2":  _v(latest, 3) - _v(oldest, 3),
            "gas_delivered":            _v(latest, 4) - _v(oldest, 4),
        }

    def prune(self) -> int:
        """Delete readings and events older than :data:`RETENTION_DAYS`.

        Returns:
            Number of rows deleted.
        """
        cutoff_ms = int(
            (datetime.now(timezone.utc) - timedelta(days=RETENTION_DAYS)).timestamp() * 1000
        )
        with self._write_lock:
            conn = self._conn()
            cur1 = conn.execute("DELETE FROM readings WHERE ts < ?", (cutoff_ms,))
            cur2 = conn.execute("DELETE FROM events WHERE ts < ?", (cutoff_ms,))
            cur3 = conn.execute("DELETE FROM summaries WHERE ts < ?", (cutoff_ms,))
            conn.commit()
        return cur1.rowcount + cur2.rowcount + cur3.rowcount

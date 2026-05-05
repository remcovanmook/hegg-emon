"""
hegg.store
==========

SQLite-backed time-series store for :class:`~hegg.listener.HeggReading` objects.

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

import sqlite3
import threading
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Union

from hegg.listener import HeggReading

#: Number of days of raw readings to retain.
RETENTION_DAYS: int = 7

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

    def __init__(self, path: Union[str, Path] = "hegg.db") -> None:
        self._path = str(path)
        self._local = threading.local()
        self._write_lock = threading.Lock()
        # Initialise schema on the calling thread's connection.
        self._conn().executescript(_DDL)
        self._conn().commit()

    def _conn(self) -> sqlite3.Connection:
        """Return (or create) the per-thread SQLite connection.

        Returns:
            An open :class:`sqlite3.Connection` for the current thread.
        """
        if not hasattr(self._local, "conn"):
            conn = sqlite3.connect(self._path, check_same_thread=False)
            conn.execute("PRAGMA journal_mode=WAL")
            conn.execute("PRAGMA synchronous=NORMAL")
            self._local.conn = conn
        return self._local.conn

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
            List of dicts with keys matching :meth:`~hegg.listener.HeggReading.to_dict`,
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

    def prune(self) -> int:
        """Delete readings older than :data:`RETENTION_DAYS`.

        Returns:
            Number of rows deleted.
        """
        cutoff_ms = int(
            (datetime.now(timezone.utc) - timedelta(days=RETENTION_DAYS)).timestamp() * 1000
        )
        with self._write_lock:
            conn = self._conn()
            cur = conn.execute("DELETE FROM readings WHERE ts < ?", (cutoff_ms,))
            conn.commit()
        return cur.rowcount

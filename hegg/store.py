"""
hegg.store
==========

Tiered time-series store for :class:`~hegg.reading.HeggReading` objects.

Pipeline
--------

::

    1 Hz UDP samples ──► in-memory ring buffer  (1 hour,    1 s)
                       └► readings_10s          (6 hours,  10 s)
                       └► readings_1m           (3 days,   60 s)
                       └► readings_1h           (1 year,   1 h)

The ring buffer absorbs the 1 Hz write rate so we no longer commit to
SQLite once per second.  Whenever an incoming sample crosses a one-minute
boundary, the just-closed minute is flushed: 6 × ``readings_10s`` rows
plus 1 × ``readings_1m`` row, in a single transaction.  The hourly
rollup into ``readings_1h`` runs from :meth:`HeggStore.prune`.

Reads are dispatched by window length:

==============  ==================  ===============
Window          Source              Resolution
==============  ==================  ===============
≤ 1 hour        ring buffer         1 second
≤ 6 hours       ``readings_10s``    10 seconds
≤ 3 days        ``readings_1m``     1 minute
> 3 days        ``readings_1h``     1 hour
==============  ==================  ===============

A query whose window spans a tier boundary (e.g. 90 minutes) is served
entirely from the coarser tier — the live tail loses 1 s resolution once
the window exceeds 1 hour.

Crash durability: up to one in-flight minute of 1 Hz samples lives only
in RAM and is lost on an unclean shutdown.  Older data is durable.
"""

import json
import logging
import os
import sqlite3
import threading
from collections import deque
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import List, Optional, Tuple, Union

from hegg.reading import HeggReading

logger = logging.getLogger(__name__)

#: Fallback database filename used by default_db_path() and HeggStore.
_DEFAULT_DB_NAME: str = "hegg.db"

#: Days of summaries / events / prices retained.
RETENTION_DAYS: int = 7

#: Ring-buffer length in samples (1 Hz × 3600 s = 1 hour).
_RING_MAXLEN: int = 3600

# Bucket widths in milliseconds.
_BUCKET_10S_MS: int = 10_000
_BUCKET_1M_MS:  int = 60_000
_BUCKET_1H_MS:  int = 3_600_000

# Tier-specific retention windows in milliseconds.
_RETAIN_10S_MS: int = 6   * 60 * 60 * 1000          # 6 hours
_RETAIN_1M_MS:  int = 3   * 24 * 60 * 60 * 1000     # 3 days
_RETAIN_1H_MS:  int = 365 * 24 * 60 * 60 * 1000     # 1 year


# ---------------------------------------------------------------------------
# Process-shared instance cache
# ---------------------------------------------------------------------------
#
# The ring buffer holding the live 1 Hz tail lives in RAM, so independent
# `HeggStore` instances within a single process do NOT see each other's
# writes until the minute-flush hits disk.  Inside ``hegg_server.py`` the
# collector, Prometheus poll, dashboard, and price fetcher all run in the
# same process and must share a buffer; ``get_store(path)`` returns the
# same instance for the same path so they do.
#
# Tests construct ``HeggStore(":memory:")`` directly (bypassing the cache)
# to keep per-test isolation.

_STORE_CACHE: dict = {}
_STORE_CACHE_LOCK = threading.Lock()


def get_store(path) -> "HeggStore":
    """Return a process-shared :class:`HeggStore` for *path*.

    All callers within the same process that pass the same path receive
    the same instance — required for the in-memory ring buffer to be
    visible to readers (Prometheus, dashboard) and not just the writer
    (collector).

    Args:
        path: Filesystem path to the SQLite database, or any value
              accepted by :class:`HeggStore`.
    """
    key = str(path)
    with _STORE_CACHE_LOCK:
        store = _STORE_CACHE.get(key)
        if store is None:
            store = HeggStore(path)
            _STORE_CACHE[key] = store
        return store


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
    env = os.getenv("HEGG_DB")
    if env:
        return env

    system_dir = "/var/lib/hegg"
    if os.path.isdir(system_dir) and os.access(system_dir, os.W_OK):
        return os.path.join(system_dir, _DEFAULT_DB_NAME)

    db_dir = os.path.join(os.getcwd(), "db")
    if os.path.isdir(db_dir):
        return os.path.join(db_dir, _DEFAULT_DB_NAME)

    return _DEFAULT_DB_NAME


# ---------------------------------------------------------------------------
# Schema
# ---------------------------------------------------------------------------

# Columns for every rollup tier are identical — only the bucket width of
# `ts` differs.  Each row holds the mean of all 1 Hz samples that fell in
# its bucket plus `n`, the sample count, so coarser tiers can compute
# weighted means without going back to the source samples.
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

CREATE TABLE IF NOT EXISTS readings_10s (
    ts              INTEGER NOT NULL,
    serial          TEXT    NOT NULL,
    n               INTEGER NOT NULL,
    delivered_mean  REAL    NOT NULL,
    returned_mean   REAL    NOT NULL,
    voltage_l1_mean REAL    NOT NULL,
    voltage_l2_mean REAL    NOT NULL,
    voltage_l3_mean REAL    NOT NULL,
    current_l1_mean REAL    NOT NULL,
    current_l2_mean REAL    NOT NULL,
    current_l3_mean REAL    NOT NULL,
    UNIQUE (ts, serial)
);
CREATE INDEX IF NOT EXISTS idx_10s_ts ON readings_10s (ts);

CREATE TABLE IF NOT EXISTS readings_1m (
    ts              INTEGER NOT NULL,
    serial          TEXT    NOT NULL,
    n               INTEGER NOT NULL,
    delivered_mean  REAL    NOT NULL,
    returned_mean   REAL    NOT NULL,
    voltage_l1_mean REAL    NOT NULL,
    voltage_l2_mean REAL    NOT NULL,
    voltage_l3_mean REAL    NOT NULL,
    current_l1_mean REAL    NOT NULL,
    current_l2_mean REAL    NOT NULL,
    current_l3_mean REAL    NOT NULL,
    UNIQUE (ts, serial)
);
CREATE INDEX IF NOT EXISTS idx_1m_ts ON readings_1m (ts);

CREATE TABLE IF NOT EXISTS readings_1h (
    ts              INTEGER NOT NULL,
    serial          TEXT    NOT NULL,
    n               INTEGER NOT NULL,
    delivered_mean  REAL    NOT NULL,
    returned_mean   REAL    NOT NULL,
    voltage_l1_mean REAL    NOT NULL,
    voltage_l2_mean REAL    NOT NULL,
    voltage_l3_mean REAL    NOT NULL,
    current_l1_mean REAL    NOT NULL,
    current_l2_mean REAL    NOT NULL,
    current_l3_mean REAL    NOT NULL,
    UNIQUE (ts, serial)
);
CREATE INDEX IF NOT EXISTS idx_1h_ts ON readings_1h (ts);

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

CREATE TABLE IF NOT EXISTS prices (
    ts_start      INTEGER NOT NULL UNIQUE,
    ts_end        INTEGER NOT NULL,
    price_eur_kwh REAL    NOT NULL,
    price_origin  TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_prices_ts ON prices (ts_start);

CREATE TABLE IF NOT EXISTS gas_prices (
    ts_start      INTEGER NOT NULL UNIQUE,
    ts_end        INTEGER NOT NULL,
    price_eur_m3  REAL    NOT NULL,
    price_origin  TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_gas_prices_ts ON gas_prices (ts_start);

CREATE TABLE IF NOT EXISTS weather_forecast (
    ts            INTEGER NOT NULL UNIQUE,
    temperature_c REAL    NOT NULL,
    solar_wm2     REAL    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_weather_ts ON weather_forecast (ts);
"""

_ROLLUP_INSERT_TEMPLATE = """
INSERT OR REPLACE INTO {table}
    (ts, serial, n,
     delivered_mean, returned_mean,
     voltage_l1_mean, voltage_l2_mean, voltage_l3_mean,
     current_l1_mean, current_l2_mean, current_l3_mean)
VALUES (?,?,?,?,?,?,?,?,?,?,?)
"""

_ROLLUP_SELECT_COLS = (
    "ts, n, "
    "delivered_mean, returned_mean, "
    "voltage_l1_mean, voltage_l2_mean, voltage_l3_mean, "
    "current_l1_mean, current_l2_mean, current_l3_mean"
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _floor_ms(ts_ms: int, bucket_ms: int) -> int:
    return (ts_ms // bucket_ms) * bucket_ms


def _ts_ms(reading: HeggReading) -> int:
    return int(reading.timestamp.timestamp() * 1000)


def _mean_tuple(samples: List[HeggReading]) -> Tuple[float, ...]:
    """Return (delivered, returned, v1, v2, v3, c1, c2, c3) means."""
    n = len(samples)
    return (
        sum(s.power_delivered for s in samples) / n,
        sum(s.power_returned  for s in samples) / n,
        sum(s.voltage_l1      for s in samples) / n,
        sum(s.voltage_l2      for s in samples) / n,
        sum(s.voltage_l3      for s in samples) / n,
        sum(s.current_l1      for s in samples) / n,
        sum(s.current_l2      for s in samples) / n,
        sum(s.current_l3      for s in samples) / n,
    )


def _rollup_row_to_dict(row: tuple) -> dict:
    """Convert a rollup-table row to the public reading-dict shape.

    Row layout: (ts, n, delivered_mean, returned_mean,
                 v1_mean, v2_mean, v3_mean, c1_mean, c2_mean, c3_mean)
    """
    ts = datetime.fromtimestamp(row[0] / 1000, tz=timezone.utc).isoformat()
    return {
        "timestamp":       ts,
        "power_delivered": row[2],
        "power_returned":  row[3],
        "voltage_l1": row[4], "voltage_l2": row[5], "voltage_l3": row[6],
        "current_l1": row[7], "current_l2": row[8], "current_l3": row[9],
    }


# ---------------------------------------------------------------------------
# Ring buffer
# ---------------------------------------------------------------------------

class _RingBuffer:
    """Thread-safe ring buffer of :class:`HeggReading` instances.

    `deque.append` is atomic under the GIL but iteration during concurrent
    appends is not — so every read/write goes through the lock and snapshots
    a list before returning.
    """

    def __init__(self, maxlen: int = _RING_MAXLEN) -> None:
        self._buf: deque = deque(maxlen=maxlen)
        self._lock = threading.Lock()

    def append(self, reading: HeggReading) -> None:
        with self._lock:
            self._buf.append(reading)

    def latest(self) -> Optional[HeggReading]:
        with self._lock:
            return self._buf[-1] if self._buf else None

    def since(self, ts_ms: int) -> List[HeggReading]:
        """Return samples with `ts > ts_ms`, oldest first."""
        with self._lock:
            return [r for r in self._buf if _ts_ms(r) > ts_ms]

    def in_range(self, start_ms: int, end_ms: int) -> List[HeggReading]:
        """Return samples with `start_ms <= ts < end_ms`, oldest first."""
        with self._lock:
            return [r for r in self._buf
                    if start_ms <= _ts_ms(r) < end_ms]

    def snapshot(self) -> List[HeggReading]:
        with self._lock:
            return list(self._buf)

    def __len__(self) -> int:
        with self._lock:
            return len(self._buf)


# ---------------------------------------------------------------------------
# Store
# ---------------------------------------------------------------------------

class HeggStore:
    """Thread-safe tiered store for Hegg energy readings.

    The 1 Hz write hot-path lives entirely in the in-memory ring buffer.
    Disk writes fire only when a sample crosses a one-minute bucket
    boundary, batching 6 × 10-second rows + 1 × 1-minute row per
    transaction.

    Args:
        path: Filesystem path to the SQLite database file.
    """

    def __init__(self, path: Union[str, Path] = _DEFAULT_DB_NAME) -> None:
        self._path = str(path)
        self._local = threading.local()
        self._write_lock = threading.Lock()
        self._buffer = _RingBuffer()
        # Bucket bookkeeping; protected by self._write_lock.
        self._last_1m_bucket: Optional[int] = None
        # Trigger schema creation on the calling thread's connection.
        self._conn()
        self._backfill_legacy()
        self._warm_start()

    # -- connection / schema ------------------------------------------------

    def _conn(self) -> sqlite3.Connection:
        if not hasattr(self._local, "conn"):
            conn = sqlite3.connect(self._path, check_same_thread=False)
            conn.execute("PRAGMA journal_mode=WAL")
            conn.execute("PRAGMA synchronous=NORMAL")
            conn.executescript(_DDL)
            conn.commit()
            self._local.conn = conn
        return self._local.conn

    def _backfill_legacy(self) -> None:
        """One-time migration from the legacy 1 Hz ``readings`` table.

        When the new tiered store first attaches to a database that was
        populated by the previous design, the rollup tables are mostly
        empty even though ``readings`` may hold a week of 1 Hz history.
        This method aggregates that history into the three rollup tiers so
        the dashboard sees its full back-catalogue immediately.

        Idempotency uses ``PRAGMA user_version``: backfill runs while
        ``user_version == 0`` and ``readings`` is non-empty, then bumps
        the version to 1 in the same transaction.  ``INSERT OR IGNORE``
        means buckets already populated by the live flush path are kept
        as-is, so it's safe to run after the live writer has produced a
        few minutes of rollup rows.

        Per-tier retention is honoured so rows that ``prune()`` would
        immediately delete are not inserted.
        """
        conn = self._conn()
        if conn.execute("PRAGMA user_version").fetchone()[0] >= 1:
            return
        has_legacy = conn.execute("SELECT 1 FROM readings LIMIT 1").fetchone()
        if not has_legacy:
            # Empty legacy table — leave user_version=0 so a future startup
            # against a populated `readings` (e.g. a migrated DB) still
            # triggers backfill.  The check is a single indexed-table probe.
            return

        now_ms = int(datetime.now(timezone.utc).timestamp() * 1000)
        plans = (
            ("readings_10s", _BUCKET_10S_MS, now_ms - _RETAIN_10S_MS),
            ("readings_1m",  _BUCKET_1M_MS,  now_ms - _RETAIN_1M_MS),
            ("readings_1h",  _BUCKET_1H_MS,  now_ms - _RETAIN_1H_MS),
        )

        logger.info("Backfilling rollup tiers from legacy `readings` table")
        with self._write_lock:
            with conn:
                for table, bucket_ms, since_ms in plans:
                    sql = f"""
                        INSERT OR IGNORE INTO {table}
                            (ts, serial, n,
                             delivered_mean, returned_mean,
                             voltage_l1_mean, voltage_l2_mean, voltage_l3_mean,
                             current_l1_mean, current_l2_mean, current_l3_mean)
                        SELECT (ts / {bucket_ms}) * {bucket_ms} AS bucket,
                               serial,
                               COUNT(*),
                               AVG(delivered),  AVG(returned),
                               AVG(voltage_l1), AVG(voltage_l2), AVG(voltage_l3),
                               AVG(current_l1), AVG(current_l2), AVG(current_l3)
                        FROM readings
                        WHERE ts >= ?
                        GROUP BY bucket, serial
                    """
                    cur = conn.execute(sql, (since_ms,))
                    logger.info("  %s: %d rows", table, cur.rowcount)
                conn.execute("PRAGMA user_version = 1")

    def _warm_start(self) -> None:
        """Prefill the ring buffer from the most recent ``readings_10s`` rows.

        After a restart the live tail is empty until the first packet arrives;
        this gives :meth:`latest_reading`, the SSE stream, and short-window
        history queries a non-empty starting point at 10 s resolution.

        Each row is inflated into a synthetic :class:`HeggReading` placed at
        the bucket start.  Resolution is reduced (10 s rather than 1 s) but
        this is strictly better than `None`.
        """
        rows = self._conn().execute(
            f"SELECT {_ROLLUP_SELECT_COLS}, serial "
            "FROM readings_10s ORDER BY ts DESC LIMIT ?",
            (_RING_MAXLEN // 10,),
        ).fetchall()
        if not rows:
            return
        # Reverse to oldest-first so the deque ends with the newest.
        for row in reversed(rows):
            ts_ms, _n, dl, rt, v1, v2, v3, c1, c2, c3 = row[:10]
            serial = row[10]
            reading = HeggReading(
                timestamp=datetime.fromtimestamp(ts_ms / 1000, tz=timezone.utc),
                serial=serial,
                power_delivered=dl, power_returned=rt,
                voltage_l1=v1, voltage_l2=v2, voltage_l3=v3,
                current_l1=c1, current_l2=c2, current_l3=c3,
            )
            self._buffer.append(reading)
        # Seed the bucket cursor so the first real insert doesn't try to
        # flush every minute since the warm-start row.
        latest = self._buffer.latest()
        if latest is not None:
            self._last_1m_bucket = _floor_ms(_ts_ms(latest), _BUCKET_1M_MS)

    # -- write path ---------------------------------------------------------

    def insert(self, reading: HeggReading) -> None:
        """Append a 1 Hz sample to the ring buffer; flush if a minute closed.

        Thread-safe: appends are lock-protected; the disk flush is
        serialised on the write lock.
        """
        self._buffer.append(reading)
        ts = _ts_ms(reading)
        new_bucket = _floor_ms(ts, _BUCKET_1M_MS)

        with self._write_lock:
            if self._last_1m_bucket is None:
                # First sample we've seen — nothing is closed yet.
                self._last_1m_bucket = new_bucket
                return
            if new_bucket <= self._last_1m_bucket:
                # Handle massive backward clock jumps (e.g., > 1 hour)
                if self._last_1m_bucket - new_bucket > 3600_000:
                    logger.warning("Clock jumped backward significantly; resetting 1m bucket anchor.")
                    self._last_1m_bucket = new_bucket
                return
            self._flush_minutes(self._last_1m_bucket, new_bucket)
            self._last_1m_bucket = new_bucket

    def _flush_minutes(self, from_bucket: int, to_bucket: int) -> None:
        """Flush every closed minute in ``[from_bucket, to_bucket)``.

        For each minute we aggregate samples currently in the ring buffer
        whose timestamp falls in that minute, write up to 6 ``readings_10s``
        rows and 1 ``readings_1m`` row.  All inserts share one transaction
        so readers never see a half-written minute.

        Caller must hold ``self._write_lock``.
        """
        snapshot = self._buffer.snapshot()
        if not snapshot:
            return

        rows_10s: List[Tuple] = []
        rows_1m:  List[Tuple] = []

        # We may have skipped many minutes (clock jump, very late sample) —
        # only minutes that actually have samples in the buffer can be flushed.
        # Group samples by (1m bucket, serial).
        by_minute: dict = {}
        for s in snapshot:
            sm = _floor_ms(_ts_ms(s), _BUCKET_1M_MS)
            if not (from_bucket <= sm < to_bucket):
                continue
            by_minute.setdefault((sm, s.serial), []).append(s)

        if not by_minute:
            return

        for (minute_ts, serial), minute_samples in by_minute.items():
            # 10-second buckets within the minute.
            by_10s: dict = {}
            for s in minute_samples:
                tb = _floor_ms(_ts_ms(s), _BUCKET_10S_MS)
                by_10s.setdefault(tb, []).append(s)
            for tb, bucket_samples in by_10s.items():
                m = _mean_tuple(bucket_samples)
                rows_10s.append((tb, serial, len(bucket_samples), *m))
            m = _mean_tuple(minute_samples)
            rows_1m.append((minute_ts, serial, len(minute_samples), *m))

        conn = self._conn()
        with conn:
            conn.executemany(
                _ROLLUP_INSERT_TEMPLATE.format(table="readings_10s"),
                rows_10s,
            )
            conn.executemany(
                _ROLLUP_INSERT_TEMPLATE.format(table="readings_1m"),
                rows_1m,
            )

    # -- read path ----------------------------------------------------------

    def latest_reading(self) -> "Optional[HeggReading]":
        """Return the most recent reading, or ``None`` if the buffer is empty.

        Returns:
            The newest :class:`~hegg.reading.HeggReading`, or ``None``.
        """
        return self._buffer.latest()

    def query_raw_since(self, since_ts_ms: int, limit: int = 0) -> list:
        """Return individual (non-aggregated) readings newer than *since_ts_ms*.

        Served from the in-memory ring buffer; the SSE stream polls this
        every second.

        Args:
            since_ts_ms: Unix timestamp in milliseconds (exclusive lower bound).
            limit:       Maximum rows to return; 0 means no limit.

        Returns:
            List of reading dicts ordered oldest-first.
        """
        rows = self._buffer.since(since_ts_ms)
        if limit and len(rows) > limit:
            rows = rows[-limit:]
        return [_reading_to_dict(r) for r in rows]

    def query(self, since: datetime, bucket_seconds: int = 60) -> list:
        """Return bucketed averages since *since*.

        Tier dispatch by total window length:

        - ≤  1 hour → ring buffer (1 s)
        - ≤  6 hours → ``readings_10s`` (10 s)
        - ≤  3 days → ``readings_1m`` (60 s)
        - >  3 days → ``readings_1h`` (3600 s)

        ``bucket_seconds`` may widen the bucket within a tier but cannot go
        below the tier's native resolution.

        Args:
            since:          Start of the query window (UTC).
            bucket_seconds: Aggregation bucket width in seconds.

        Returns:
            List of dicts with the same shape as :meth:`HeggReading.to_dict`,
            ``timestamp`` set to the bucket start (UTC ISO 8601).
        """
        now = datetime.now(timezone.utc)
        window_s = max(0.0, (now - since).total_seconds())
        since_ms = int(since.timestamp() * 1000)

        # Small grace on the upper bounds: the caller in `app.py` computes
        # `since = datetime.now() - timedelta(hours=N)` slightly *before*
        # `query()` resamples `now`, so a "1 hour" request lands at
        # window_s ≈ 3600.0+ε and would otherwise miss the ring tier.
        if window_s <= 3600 + 60:
            return self._query_ring(since_ms, bucket_seconds)
        if window_s <= 6 * 3600 + 60:
            return self._query_table("readings_10s", since_ms,
                                     max(bucket_seconds, 10))
        if window_s <= 3 * 86400 + 60:
            return self._query_table("readings_1m", since_ms,
                                     max(bucket_seconds, 60))
        return self._query_table("readings_1h", since_ms,
                                 max(bucket_seconds, 3600))

    def _query_ring(self, since_ms: int, bucket_seconds: int) -> list:
        bucket_ms = max(1, bucket_seconds) * 1000
        samples = self._buffer.since(since_ms - 1)  # inclusive of since_ms
        if not samples:
            return []
        by_bucket: dict = {}
        for s in samples:
            b = _floor_ms(_ts_ms(s), bucket_ms)
            by_bucket.setdefault(b, []).append(s)
        out = []
        for b in sorted(by_bucket):
            m = _mean_tuple(by_bucket[b])
            ts = datetime.fromtimestamp(b / 1000, tz=timezone.utc).isoformat()
            out.append({
                "timestamp":       ts,
                "power_delivered": m[0],
                "power_returned":  m[1],
                "voltage_l1": m[2], "voltage_l2": m[3], "voltage_l3": m[4],
                "current_l1": m[5], "current_l2": m[6], "current_l3": m[7],
            })
        return out

    def _query_table(self, table: str, since_ms: int, bucket_seconds: int) -> list:
        """Read from a rollup table, optionally regrouping into a wider bucket.

        Wider buckets use ``SUM(field_mean * n) / SUM(n)`` so a row that
        averaged more samples weighs proportionally more.
        """
        bucket_ms = bucket_seconds * 1000
        sql = f"""
            SELECT (ts / ?) * ? AS bucket,
                   SUM(n),
                   SUM(delivered_mean  * n) / SUM(n),
                   SUM(returned_mean   * n) / SUM(n),
                   SUM(voltage_l1_mean * n) / SUM(n),
                   SUM(voltage_l2_mean * n) / SUM(n),
                   SUM(voltage_l3_mean * n) / SUM(n),
                   SUM(current_l1_mean * n) / SUM(n),
                   SUM(current_l2_mean * n) / SUM(n),
                   SUM(current_l3_mean * n) / SUM(n)
            FROM {table}
            WHERE ts >= ?
            GROUP BY bucket
            ORDER BY bucket ASC
        """
        rows = self._conn().execute(
            sql, (bucket_ms, bucket_ms, since_ms),
        ).fetchall()
        return [_rollup_row_to_dict(r) for r in rows]

    # -- maintenance --------------------------------------------------------

    def _rollup_hour(self, conn: sqlite3.Connection, now_ms: int) -> int:
        """Aggregate ``readings_1m`` rows for closed hours into ``readings_1h``.

        Looks back at any ``readings_1m`` row in a closed hour that does not
        yet have a matching ``readings_1h`` row.  Uses ``SUM(mean*n)/SUM(n)``
        so missing minutes don't bias the hourly mean.

        Caller must hold ``self._write_lock``.

        Returns:
            Number of hour rows written.
        """
        cur_hour = _floor_ms(now_ms, _BUCKET_1H_MS)
        sql = """
            INSERT OR REPLACE INTO readings_1h
                (ts, serial, n,
                 delivered_mean, returned_mean,
                 voltage_l1_mean, voltage_l2_mean, voltage_l3_mean,
                 current_l1_mean, current_l2_mean, current_l3_mean)
            SELECT (ts / ?) * ?,
                   serial,
                   SUM(n),
                   SUM(delivered_mean  * n) / SUM(n),
                   SUM(returned_mean   * n) / SUM(n),
                   SUM(voltage_l1_mean * n) / SUM(n),
                   SUM(voltage_l2_mean * n) / SUM(n),
                   SUM(voltage_l3_mean * n) / SUM(n),
                   SUM(current_l1_mean * n) / SUM(n),
                   SUM(current_l2_mean * n) / SUM(n),
                   SUM(current_l3_mean * n) / SUM(n)
            FROM readings_1m
            WHERE ts < ?
            GROUP BY (ts / ?) * ?, serial
        """
        cur = conn.execute(
            sql,
            (_BUCKET_1H_MS, _BUCKET_1H_MS, cur_hour,
             _BUCKET_1H_MS, _BUCKET_1H_MS),
        )
        return cur.rowcount

    def prune(self) -> int:
        """Run the hourly rollup, then delete data past each tier's retention.

        Tier retention:

        - ``readings_10s``: 6 hours
        - ``readings_1m``:  3 days
        - ``readings_1h``:  1 year
        - ``events``, ``summaries``: :data:`RETENTION_DAYS`

        Returns:
            Total number of rows deleted across all tables.
        """
        now_ms = int(datetime.now(timezone.utc).timestamp() * 1000)
        cutoff_legacy_ms = now_ms - RETENTION_DAYS * 24 * 60 * 60 * 1000

        with self._write_lock:
            conn = self._conn()
            self._rollup_hour(conn, now_ms)

            cur_10s = conn.execute(
                "DELETE FROM readings_10s WHERE ts < ?",
                (now_ms - _RETAIN_10S_MS,),
            )
            cur_1m = conn.execute(
                "DELETE FROM readings_1m WHERE ts < ?",
                (now_ms - _RETAIN_1M_MS,),
            )
            cur_1h = conn.execute(
                "DELETE FROM readings_1h WHERE ts < ?",
                (now_ms - _RETAIN_1H_MS,),
            )
            cur_events = conn.execute(
                "DELETE FROM events WHERE ts < ?", (cutoff_legacy_ms,),
            )
            cur_summaries = conn.execute(
                "DELETE FROM summaries WHERE ts < ?", (cutoff_legacy_ms,),
            )
            conn.commit()
        return (
            cur_10s.rowcount + cur_1m.rowcount + cur_1h.rowcount
            + cur_events.rowcount + cur_summaries.rowcount
        )

    # -- events -------------------------------------------------------------

    def insert_event(self, data: dict) -> None:
        """Store a raw event packet (e.g. an unknown payload) as JSON.

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
            conn = self._conn()
            conn.execute(
                "INSERT OR IGNORE INTO events (ts, serial, raw) VALUES (?,?,?)",
                (ts_ms, serial, json.dumps(data)),
            )
            conn.commit()

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

    # -- summaries ----------------------------------------------------------

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
            conn = self._conn()
            conn.execute(
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
            conn.commit()

    def latest_summary(self) -> dict:
        """Return the most recent summary packet, or an empty dict."""
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

        Args:
            hours: Number of hours to look back.

        Returns:
            Dict with delta fields, or ``{}`` if fewer than two summary
            rows exist in the window.
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

    # -- prices -------------------------------------------------------------

    def insert_prices(self, rows: list) -> None:
        """Store hourly price rows fetched from the energyforecast.de API."""
        with self._write_lock:
            conn = self._conn()
            conn.executemany(
                """INSERT OR REPLACE INTO prices
                       (ts_start, ts_end, price_eur_kwh, price_origin)
                   VALUES (?, ?, ?, ?)""",
                [
                    (r["ts_start"], r["ts_end"], r["price_eur_kwh"], r["price_origin"])
                    for r in rows
                ],
            )
            conn.commit()

    def insert_gas_prices(self, rows: list) -> None:
        """Store daily gas price rows fetched from the EnergyZero API."""
        with self._write_lock:
            conn = self._conn()
            conn.executemany(
                """INSERT OR REPLACE INTO gas_prices
                       (ts_start, ts_end, price_eur_m3, price_origin)
                   VALUES (?, ?, ?, ?)""",
                [
                    (r["ts_start"], r["ts_end"], r["price_eur_m3"], r["price_origin"])
                    for r in rows
                ],
            )
            conn.commit()

    def insert_weather(self, rows: list) -> None:
        """Store hourly weather forecasts from Open-Meteo API."""
        with self._write_lock:
            conn = self._conn()
            conn.executemany(
                """INSERT OR REPLACE INTO weather_forecast
                       (ts, temperature_c, solar_wm2)
                   VALUES (?, ?, ?)""",
                [
                    (r["ts"], r["temperature_c"], r["solar_wm2"])
                    for r in rows
                ],
            )
            conn.commit()

    def current_price(self) -> dict:
        """Return the price entry whose window covers the current UTC moment."""
        now_ms = int(datetime.now(timezone.utc).timestamp() * 1000)
        row = self._conn().execute(
            """SELECT ts_start, ts_end, price_eur_kwh, price_origin
               FROM prices
               WHERE ts_start <= ? AND ts_end > ?
               ORDER BY ts_start DESC LIMIT 1""",
            (now_ms, now_ms),
        ).fetchone()
        if row is None:
            return {}
        return {
            "ts_start":      row[0],
            "ts_end":        row[1],
            "price_eur_kwh": row[2],
            "price_origin":  row[3],
        }

    def prices_window(self, hours: int = 24) -> list:
        """Return price entries from `now - hours` through all available data."""
        since_ms = int(
            (datetime.now(timezone.utc) - timedelta(hours=hours)).timestamp() * 1000
        )
        rows = self._conn().execute(
            """SELECT ts_start, ts_end, price_eur_kwh, price_origin
               FROM prices
               WHERE ts_start >= ?
               ORDER BY ts_start ASC""",
            (since_ms,),
        ).fetchall()
        return [
            {
                "ts_start":      r[0],
                "ts_end":        r[1],
                "price_eur_kwh": r[2],
                "price_origin":  r[3],
            }
            for r in rows
        ]

    def gas_prices_window(self, hours: int = 24) -> list:
        """Return gas price entries from `now - hours` through all available data."""
        since_ms = int(
            (datetime.now(timezone.utc) - timedelta(hours=hours)).timestamp() * 1000
        )
        rows = self._conn().execute(
            """SELECT ts_start, ts_end, price_eur_m3, price_origin
               FROM gas_prices
               WHERE ts_end >= ?
               ORDER BY ts_start ASC""",
            (since_ms,),
        ).fetchall()
        return [
            {
                "ts_start":      r[0],
                "ts_end":        r[1],
                "price_eur_m3":  r[2],
                "price_origin":  r[3],
            }
            for r in rows
        ]

    def weather_window(self, hours: int = 24) -> list:
        """Return weather forecast entries from `now - hours` through all available data."""
        since_ms = int(
            (datetime.now(timezone.utc) - timedelta(hours=hours)).timestamp() * 1000
        )
        rows = self._conn().execute(
            """SELECT ts, temperature_c, solar_wm2
               FROM weather_forecast
               WHERE ts >= ?
               ORDER BY ts ASC""",
            (since_ms,),
        ).fetchall()
        return [
            {
                "ts":            r[0],
                "temperature_c": r[1],
                "solar_wm2":     r[2],
            }
            for r in rows
        ]

    def has_current_prices(self) -> bool:
        """Return True if the DB contains a price entry for the current hour."""
        return bool(self.current_price())

    def has_current_gas_prices(self) -> bool:
        """Return True if the DB contains a gas price entry for the current time."""
        now_ms = int(datetime.now(timezone.utc).timestamp() * 1000)
        row = self._conn().execute(
            """SELECT 1 FROM gas_prices
               WHERE ts_start <= ? AND ts_end > ?
               LIMIT 1""",
            (now_ms, now_ms),
        ).fetchone()
        return bool(row)

    def hourly_consumption(self, hours: int = 24) -> list:
        """Return per-hour energy and gas consumption deltas from `summaries`.

        For each UTC hour in the requested window, takes the last summary row
        in that hour (highest ``ts``) and computes the delta against the
        previous hour's last row.  One extra hour before the window is fetched
        to compute the first delta.

        Args:
            hours: Historical window in hours (default 24).

        Returns:
            List of dicts, one per complete hour, with keys:

            - ``ts``                       — hour start, Unix ms (UTC)
            - ``energy_delivered_tariff1`` — kWh imported on T1
            - ``energy_delivered_tariff2`` — kWh imported on T2
            - ``energy_returned_tariff1``  — kWh exported on T1
            - ``energy_returned_tariff2``  — kWh exported on T2
            - ``gas_delivered``            — m³ gas consumed
        """
        now      = datetime.now(timezone.utc)
        now_ms   = int(now.timestamp() * 1000)
        since_ms = int((now - timedelta(hours=hours + 1)).timestamp() * 1000)

        rows = self._conn().execute(
            """
            SELECT s.ts,
                   s.energy_delivered_tariff1, s.energy_delivered_tariff2,
                   s.energy_returned_tariff1,  s.energy_returned_tariff2,
                   s.gas_delivered
            FROM summaries s
            INNER JOIN (
                SELECT (ts / 3600000) * 3600000 AS hour_ts, MAX(ts) AS max_ts
                FROM summaries
                WHERE ts >= ? AND ts <= ?
                GROUP BY hour_ts
            ) h ON s.ts = h.max_ts
            ORDER BY s.ts ASC
            """,
            (since_ms, now_ms),
        ).fetchall()

        window_start_ms = int((now - timedelta(hours=hours)).timestamp() * 1000)

        def _d(a, b):
            return round((a or 0.0) - (b or 0.0), 4)

        result = []
        prev   = None
        for row in rows:
            ts, d1, d2, r1, r2, gas = row
            hour_ts = (ts // 3_600_000) * 3_600_000
            if prev is not None and hour_ts >= window_start_ms:
                result.append({
                    "ts":                       hour_ts,
                    "energy_delivered_tariff1": _d(d1,  prev[1]),
                    "energy_delivered_tariff2": _d(d2,  prev[2]),
                    "energy_returned_tariff1":  _d(r1,  prev[3]),
                    "energy_returned_tariff2":  _d(r2,  prev[4]),
                    "gas_delivered":            _d(gas, prev[5]),
                })
            prev = row

        return result


def _reading_to_dict(r: HeggReading) -> dict:
    """Public reading-dict shape (matches HeggReading.to_dict)."""
    return {
        "timestamp":       r.timestamp.isoformat(),
        "serial":          r.serial,
        "power_delivered": r.power_delivered,
        "power_returned":  r.power_returned,
        "voltage_l1": r.voltage_l1, "voltage_l2": r.voltage_l2, "voltage_l3": r.voltage_l3,
        "current_l1": r.current_l1, "current_l2": r.current_l2, "current_l3": r.current_l3,
    }

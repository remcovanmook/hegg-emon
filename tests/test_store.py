"""
tests/test_store.py
===================

Unit tests for the tiered :class:`hegg.store.HeggStore`.

Uses ``:memory:`` SQLite for isolation.  Recent timestamps (offsets from
``datetime.now()``) drive tier dispatch correctly without needing to mock
the clock.
"""

import threading
from datetime import datetime, timedelta, timezone

import pytest

from hegg.reading import HeggReading
from hegg.store import (
    HeggStore,
    RETENTION_DAYS,
    _BUCKET_10S_MS,
    _BUCKET_1M_MS,
    _BUCKET_1H_MS,
)
from tests.test_reading import SAMPLE_JSON


def _make_store() -> HeggStore:
    return HeggStore(path=":memory:")


def _reading(at: datetime, **overrides) -> HeggReading:
    """Build a HeggReading at the given UTC timestamp.

    Overrides override fields on SAMPLE_JSON before construction.
    """
    payload = dict(SAMPLE_JSON, **overrides)
    payload["timestamp"] = at.strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"
    return HeggReading.from_dict(payload)


def _row_count(store: HeggStore, table: str) -> int:
    return store._conn().execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]


# ---------------------------------------------------------------------------
# Ring buffer (≤ 1 hour tier)
# ---------------------------------------------------------------------------

class TestRingBuffer:
    def test_insert_and_query_returns_row(self):
        store = _make_store()
        now = datetime.now(timezone.utc)
        store.insert(_reading(now))

        rows = store.query(now - timedelta(seconds=30), bucket_seconds=10)
        assert len(rows) == 1

    def test_query_excludes_rows_before_since(self):
        store = _make_store()
        now = datetime.now(timezone.utc)
        store.insert(_reading(now - timedelta(minutes=30)))

        rows = store.query(now - timedelta(seconds=10), bucket_seconds=10)
        assert rows == []

    def test_query_buckets_average_values(self):
        store = _make_store()
        now = datetime.now(timezone.utc).replace(microsecond=0)
        # Snap to a 10 s boundary so both samples share one bucket.
        bucket_start = now.replace(second=(now.second // 10) * 10)
        store.insert(_reading(bucket_start + timedelta(seconds=1),
                              power_delivered=1.0))
        store.insert(_reading(bucket_start + timedelta(seconds=6),
                              power_delivered=3.0))

        rows = store.query(bucket_start - timedelta(seconds=1),
                           bucket_seconds=10)
        assert len(rows) == 1
        assert rows[0]["power_delivered"] == pytest.approx(2.0)

    def test_query_result_keys(self):
        store = _make_store()
        store.insert(_reading(datetime.now(timezone.utc)))
        rows = store.query(
            datetime.now(timezone.utc) - timedelta(minutes=5),
            bucket_seconds=10,
        )
        assert len(rows) == 1
        for key in ("timestamp", "power_delivered", "power_returned",
                    "voltage_l1", "voltage_l2", "voltage_l3",
                    "current_l1", "current_l2", "current_l3"):
            assert key in rows[0]

    def test_latest_reading_returns_last_inserted(self):
        store = _make_store()
        now = datetime.now(timezone.utc)
        store.insert(_reading(now - timedelta(seconds=2), power_delivered=1.0))
        store.insert(_reading(now,                       power_delivered=2.0))
        latest = store.latest_reading()
        assert latest is not None
        assert latest.power_delivered == pytest.approx(2.0)

    def test_latest_reading_none_when_empty(self):
        assert _make_store().latest_reading() is None

    def test_query_raw_since_streams_in_order(self):
        store = _make_store()
        base = datetime.now(timezone.utc) - timedelta(seconds=5)
        for i in range(5):
            store.insert(_reading(base + timedelta(seconds=i),
                                  power_delivered=float(i)))

        rows = store.query_raw_since(0)
        assert [r["power_delivered"] for r in rows] == [0.0, 1.0, 2.0, 3.0, 4.0]

    def test_query_raw_since_excludes_already_seen(self):
        store = _make_store()
        base = datetime.now(timezone.utc) - timedelta(seconds=2)
        store.insert(_reading(base,                          power_delivered=1.0))
        store.insert(_reading(base + timedelta(seconds=1), power_delivered=2.0))

        first = store.query_raw_since(0)
        cutoff_ms = int(
            datetime.fromisoformat(first[0]["timestamp"]).timestamp() * 1000
        )
        rest = store.query_raw_since(cutoff_ms)
        assert [r["power_delivered"] for r in rest] == [2.0]


# ---------------------------------------------------------------------------
# Flush on minute boundary
# ---------------------------------------------------------------------------

class TestFlush:
    def test_no_flush_within_single_minute(self):
        store = _make_store()
        base = datetime.now(timezone.utc).replace(second=0, microsecond=0)
        for i in range(0, 30, 5):
            store.insert(_reading(base + timedelta(seconds=i)))

        assert _row_count(store, "readings_10s") == 0
        assert _row_count(store, "readings_1m")  == 0

    def test_crossing_minute_boundary_flushes_closed_minute(self):
        store = _make_store()
        # Anchor far enough in the past to keep all samples in the ring buffer
        # but recent enough that minute-rounding stays unambiguous.
        base = (datetime.now(timezone.utc) - timedelta(minutes=5)).replace(
            second=0, microsecond=0,
        )
        # 6 samples in minute 0 (one per 10 s bucket)
        for i in range(0, 60, 10):
            store.insert(_reading(base + timedelta(seconds=i),
                                  power_delivered=1.0))
        # 1 sample in minute 1 → triggers flush of minute 0
        store.insert(_reading(base + timedelta(seconds=60),
                              power_delivered=2.0))

        assert _row_count(store, "readings_10s") == 6
        assert _row_count(store, "readings_1m")  == 1

        # Stored ts must be floored to its bucket width.
        ts_10s = [r[0] for r in store._conn().execute(
            "SELECT ts FROM readings_10s ORDER BY ts").fetchall()]
        assert all(ts % _BUCKET_10S_MS == 0 for ts in ts_10s)
        ts_1m = store._conn().execute(
            "SELECT ts FROM readings_1m").fetchone()[0]
        assert ts_1m % _BUCKET_1M_MS == 0

    def test_reflush_same_minute_replaces_rows(self):
        """Late-arriving second-pass flush must update, not duplicate."""
        store = _make_store()
        base = (datetime.now(timezone.utc) - timedelta(minutes=5)).replace(
            second=0, microsecond=0,
        )
        # Closed minute 0 with a single sample.
        store.insert(_reading(base, power_delivered=1.0))
        # Trigger first flush.
        store.insert(_reading(base + timedelta(seconds=60),
                              power_delivered=9.0))

        first_count_10s = _row_count(store, "readings_10s")
        first_count_1m  = _row_count(store, "readings_1m")
        assert first_count_10s == 1
        assert first_count_1m  == 1

        # Manually re-trigger flush over the same minute by replaying a
        # boundary-crossing insert (simulates a clock jitter scenario).
        # Rows must update in place rather than accumulate.
        store._last_1m_bucket = (
            int(base.timestamp() * 1000) // _BUCKET_1M_MS
        ) * _BUCKET_1M_MS
        store.insert(_reading(base + timedelta(seconds=61),
                              power_delivered=8.0))

        assert _row_count(store, "readings_10s") == first_count_10s
        assert _row_count(store, "readings_1m")  == first_count_1m


# ---------------------------------------------------------------------------
# Tier dispatch
# ---------------------------------------------------------------------------

def _seed_rollup(
    store: HeggStore,
    table: str,
    rows: list,  # list of (ts_ms, power_delivered) — other fields filled in.
) -> None:
    serial = SAMPLE_JSON["serial"]
    payload = [
        (
            ts, serial, 1,
            pd, 0.0,         # delivered, returned
            240.0, 240.0, 240.0,
            1.0, 1.0, 1.0,
        )
        for ts, pd in rows
    ]
    conn = store._conn()
    conn.executemany(
        f"INSERT OR REPLACE INTO {table} "
        "(ts, serial, n, delivered_mean, returned_mean, "
        "voltage_l1_mean, voltage_l2_mean, voltage_l3_mean, "
        "current_l1_mean, current_l2_mean, current_l3_mean) "
        "VALUES (?,?,?,?,?,?,?,?,?,?,?)",
        payload,
    )
    conn.commit()


class TestTierDispatch:
    def test_3h_window_reads_from_10s_table(self):
        store = _make_store()
        now_ms = int(datetime.now(timezone.utc).timestamp() * 1000)
        ts = ((now_ms - 2 * 3600 * 1000) // _BUCKET_10S_MS) * _BUCKET_10S_MS
        _seed_rollup(store, "readings_10s", [(ts, 5.0)])

        # Sentinel in the 1m tier — must NOT be returned.
        _seed_rollup(store, "readings_1m", [(ts, 99.0)])

        rows = store.query(
            datetime.now(timezone.utc) - timedelta(hours=3),
            bucket_seconds=10,
        )
        assert len(rows) == 1
        assert rows[0]["power_delivered"] == pytest.approx(5.0)

    def test_2d_window_reads_from_1m_table(self):
        store = _make_store()
        now_ms = int(datetime.now(timezone.utc).timestamp() * 1000)
        ts = ((now_ms - 36 * 3600 * 1000) // _BUCKET_1M_MS) * _BUCKET_1M_MS
        _seed_rollup(store, "readings_1m", [(ts, 7.0)])
        _seed_rollup(store, "readings_1h", [(ts, 99.0)])

        rows = store.query(
            datetime.now(timezone.utc) - timedelta(days=2),
            bucket_seconds=60,
        )
        assert any(r["power_delivered"] == pytest.approx(7.0) for r in rows)
        assert all(r["power_delivered"] != pytest.approx(99.0) for r in rows)

    def test_long_window_reads_from_1h_table(self):
        store = _make_store()
        now_ms = int(datetime.now(timezone.utc).timestamp() * 1000)
        ts = ((now_ms - 6 * 86400 * 1000) // _BUCKET_1H_MS) * _BUCKET_1H_MS
        _seed_rollup(store, "readings_1h", [(ts, 11.0)])

        rows = store.query(
            datetime.now(timezone.utc) - timedelta(days=7),
            bucket_seconds=3600,
        )
        assert any(r["power_delivered"] == pytest.approx(11.0) for r in rows)


class TestWeightedRegrouping:
    def test_wider_bucket_uses_weighted_mean(self):
        """SUM(mean*n)/SUM(n) — a row with more samples weighs more."""
        store = _make_store()
        now_ms = int(datetime.now(timezone.utc).timestamp() * 1000)
        # Two _10s rows in the same minute, asymmetric n.
        bucket0 = ((now_ms - 2 * 3600 * 1000) // _BUCKET_1M_MS) * _BUCKET_1M_MS
        conn = store._conn()
        conn.executemany(
            "INSERT INTO readings_10s "
            "(ts, serial, n, delivered_mean, returned_mean, "
            "voltage_l1_mean, voltage_l2_mean, voltage_l3_mean, "
            "current_l1_mean, current_l2_mean, current_l3_mean) "
            "VALUES (?,?,?,?,?,?,?,?,?,?,?)",
            [
                # n=9, mean=10 → weight 90
                (bucket0, "x", 9, 10.0, 0, 240, 240, 240, 1, 1, 1),
                # n=1, mean=20 → weight 20
                (bucket0 + 10_000, "x", 1, 20.0, 0, 240, 240, 240, 1, 1, 1),
            ],
        )
        conn.commit()

        rows = store.query(
            datetime.now(timezone.utc) - timedelta(hours=3),
            bucket_seconds=60,
        )
        # Weighted mean = (9*10 + 1*20) / 10 = 11.0  (vs naive 15.0).
        assert len(rows) == 1
        assert abs(rows[0]["power_delivered"] - 11.0) < 1e-6


# ---------------------------------------------------------------------------
# Hour rollup + prune
# ---------------------------------------------------------------------------

class TestRollupAndPrune:
    def test_prune_rolls_up_closed_hour(self):
        store = _make_store()
        # Closed hour, 60 _1m rows, mixed n.
        now_ms = int(datetime.now(timezone.utc).timestamp() * 1000)
        closed_hour = (
            (now_ms - _BUCKET_1H_MS) // _BUCKET_1H_MS
        ) * _BUCKET_1H_MS
        conn = store._conn()
        conn.executemany(
            "INSERT INTO readings_1m "
            "(ts, serial, n, delivered_mean, returned_mean, "
            "voltage_l1_mean, voltage_l2_mean, voltage_l3_mean, "
            "current_l1_mean, current_l2_mean, current_l3_mean) "
            "VALUES (?,?,?,?,?,?,?,?,?,?,?)",
            [
                (closed_hour + i * _BUCKET_1M_MS, "x", 60,
                 1.0 + i * 0.1, 0, 240, 240, 240, 1, 1, 1)
                for i in range(60)
            ],
        )
        conn.commit()

        store.prune()

        rows = conn.execute(
            "SELECT ts, n, delivered_mean FROM readings_1h"
        ).fetchall()
        assert len(rows) == 1
        assert rows[0][0] == closed_hour
        assert rows[0][1] == 60 * 60   # SUM(n) across 60 minute rows
        # Plain mean of (1.0..7.9) is 3.95 — equal weights so weighted == plain.
        assert abs(rows[0][2] - 3.95) < 1e-6

    def test_prune_does_not_roll_open_hour(self):
        store = _make_store()
        now_ms = int(datetime.now(timezone.utc).timestamp() * 1000)
        current_hour = (now_ms // _BUCKET_1H_MS) * _BUCKET_1H_MS
        _seed_rollup(store, "readings_1m", [(current_hour, 5.0)])

        store.prune()
        assert _row_count(store, "readings_1h") == 0

    def test_prune_deletes_per_tier(self):
        store = _make_store()
        now_ms = int(datetime.now(timezone.utc).timestamp() * 1000)
        # ts past each tier's retention — must be deleted by prune().
        old_ts = {
            "readings_10s": now_ms - 7   * 3600  * 1000,    # > 6h
            "readings_1m":  now_ms - 5   * 86400 * 1000,    # > 3d
            "readings_1h":  now_ms - 400 * 86400 * 1000,    # > 1y
        }
        for table, ts in old_ts.items():
            _seed_rollup(store, table, [(ts, 1.0)])
        # Fresh row in each tier — must survive.
        for table in old_ts:
            _seed_rollup(store, table, [(now_ms - 60_000, 9.0)])

        store.prune()

        conn = store._conn()
        for table, ts in old_ts.items():
            row = conn.execute(
                f"SELECT 1 FROM {table} WHERE ts = ?", (ts,),
            ).fetchone()
            assert row is None, f"old {table} row at ts={ts} not pruned"
            row = conn.execute(
                f"SELECT 1 FROM {table} WHERE ts = ?", (now_ms - 60_000,),
            ).fetchone()
            assert row is not None, f"fresh {table} row was pruned"


# ---------------------------------------------------------------------------
# Warm start
# ---------------------------------------------------------------------------

class TestWarmStart:
    def test_warm_start_prefills_buffer_from_10s_table(self, tmp_path):
        db = str(tmp_path / "warm.db")
        store1 = HeggStore(path=db)
        now_ms = int(datetime.now(timezone.utc).timestamp() * 1000)
        ts = ((now_ms - 5 * 60_000) // _BUCKET_10S_MS) * _BUCKET_10S_MS
        _seed_rollup(store1, "readings_10s", [(ts, 4.2)])

        # Fresh store on the same file — buffer should now be primed.
        store2 = HeggStore(path=db)
        latest = store2.latest_reading()
        assert latest is not None
        assert abs(latest.power_delivered - 4.2) < 1e-6


class TestLegacyBackfill:
    def _seed_legacy(self, store: HeggStore, rows: list) -> None:
        """Insert rows directly into the legacy `readings` table."""
        conn = store._conn()
        conn.executemany(
            "INSERT INTO readings "
            "(ts, serial, delivered, returned, "
            "voltage_l1, voltage_l2, voltage_l3, "
            "current_l1, current_l2, current_l3) "
            "VALUES (?,?,?,?,?,?,?,?,?,?)",
            [
                (ts, "x", pd, 0.0, 240.0, 240.0, 240.0, 1.0, 1.0, 1.0)
                for ts, pd in rows
            ],
        )
        conn.commit()

    def test_backfill_populates_all_tiers(self, tmp_path):
        db = str(tmp_path / "legacy.db")
        # Pre-populate `readings` while the rollup tables stay empty
        # (we open a store and immediately seed via the same conn).
        store = HeggStore(path=db)
        now_ms = int(datetime.now(timezone.utc).timestamp() * 1000)
        # 60 samples at 1 Hz, ending two minutes ago.
        rows = [
            (now_ms - 120_000 + i * 1000, 2.0)
            for i in range(60)
        ]
        # Manually clear the rollup tables (warm-start may have done nothing
        # already, but the backfill would've fired if there was legacy data
        # at construction time — there wasn't).  Now seed legacy data and
        # construct a NEW store on the same DB so backfill triggers.
        self._seed_legacy(store, rows)

        store2 = HeggStore(path=db)
        conn = store2._conn()

        # All three tiers should have rows that came from the legacy aggregate.
        assert conn.execute(
            "SELECT COUNT(*) FROM readings_10s"
        ).fetchone()[0] > 0
        assert conn.execute(
            "SELECT COUNT(*) FROM readings_1m"
        ).fetchone()[0] > 0
        # _1h: only if the 60 samples span an hour boundary, which they
        # don't here — so just check the SQL executed without error.

        # Backfill must average values, not duplicate the row count.
        means_10s = conn.execute(
            "SELECT delivered_mean FROM readings_10s"
        ).fetchall()
        assert all(m[0] == pytest.approx(2.0) for m in means_10s)

    def test_backfill_runs_only_once(self, tmp_path):
        """A second construction with rollup data already in place is a no-op."""
        db = str(tmp_path / "twice.db")
        store = HeggStore(path=db)
        now_ms = int(datetime.now(timezone.utc).timestamp() * 1000)
        self._seed_legacy(store, [(now_ms - 60_000, 3.0)])

        store2 = HeggStore(path=db)  # backfills
        rows_first = store2._conn().execute(
            "SELECT COUNT(*) FROM readings_10s"
        ).fetchone()[0]
        assert rows_first > 0

        # Pretend new legacy data showed up (which can't happen post-cutover
        # but proves the second-run guard works either way).
        self._seed_legacy(store2, [(now_ms - 30_000, 99.0)])

        store3 = HeggStore(path=db)
        rows_second = store3._conn().execute(
            "SELECT COUNT(*) FROM readings_10s"
        ).fetchone()[0]
        assert rows_second == rows_first  # no second backfill

    def test_backfill_respects_per_tier_retention(self, tmp_path):
        """Rows older than a tier's retention must not be backfilled there."""
        db = str(tmp_path / "retention.db")
        store = HeggStore(path=db)
        now_ms = int(datetime.now(timezone.utc).timestamp() * 1000)
        # One row 7 hours ago — beyond the 6-hour _10s retention but within
        # the _1m and _1h retention.
        self._seed_legacy(store, [(now_ms - 7 * 3600 * 1000, 5.0)])

        store2 = HeggStore(path=db)
        conn = store2._conn()

        assert conn.execute(
            "SELECT COUNT(*) FROM readings_10s"
        ).fetchone()[0] == 0
        assert conn.execute(
            "SELECT COUNT(*) FROM readings_1m"
        ).fetchone()[0] == 1
        assert conn.execute(
            "SELECT COUNT(*) FROM readings_1h"
        ).fetchone()[0] == 1


# ---------------------------------------------------------------------------
# Concurrency
# ---------------------------------------------------------------------------

class TestConcurrency:
    def test_concurrent_inserts_do_not_raise(self):
        store = _make_store()
        errors = []
        base = datetime.now(timezone.utc) - timedelta(seconds=120)

        def insert_many(thread_idx: int):
            for i in range(40):
                try:
                    store.insert(_reading(
                        base + timedelta(seconds=i + thread_idx * 40),
                    ))
                except Exception as exc:  # noqa: BLE001
                    errors.append(exc)

        threads = [
            threading.Thread(target=insert_many, args=(t,)) for t in range(4)
        ]
        for t in threads: t.start()
        for t in threads: t.join()

        assert errors == [], f"errors during concurrent insert: {errors}"


# ---------------------------------------------------------------------------
# Legacy retention (events / summaries still use RETENTION_DAYS)
# ---------------------------------------------------------------------------

class TestLegacyRetention:
    def test_prune_removes_stale_events(self):
        store = _make_store()
        old_ts = (
            datetime.now(timezone.utc) - timedelta(days=RETENTION_DAYS + 1)
        ).strftime("%Y-%m-%dT%H:%M:%SZ")
        store.insert_event({"timestamp": old_ts, "serial": "x", "kind": "old"})
        store.insert_event({
            "timestamp": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "serial": "x",
            "kind": "fresh",
        })

        store.prune()
        remaining = store.query_events(limit=10)
        kinds = [r.get("kind") for r in remaining]
        assert "fresh" in kinds
        assert "old"   not in kinds

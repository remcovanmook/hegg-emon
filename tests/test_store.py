"""
tests/test_store.py
===================

Unit tests for hegg.store.HeggStore.

Uses an in-memory SQLite database (path=":memory:") for isolation.
"""

import time
from datetime import datetime, timedelta, timezone

import pytest

from hegg.reading import HeggReading
from hegg.store import HeggStore, RETENTION_DAYS
from tests.test_reading import SAMPLE_JSON


def _make_store() -> HeggStore:
    """Return a fresh in-memory store."""
    return HeggStore(path=":memory:")


def _make_reading(offset_seconds: int = 0) -> HeggReading:
    """Build a HeggReading offset_seconds from SAMPLE_JSON timestamp."""
    base = datetime(2026, 5, 5, 8, 21, 25, tzinfo=timezone.utc)
    ts = (base + timedelta(seconds=offset_seconds)).strftime("%Y-%m-%dT%H:%M:%SZ")
    return HeggReading.from_dict(dict(SAMPLE_JSON, timestamp=ts))


class TestHeggStore:
    def test_insert_and_query_returns_row(self):
        store = _make_store()
        r = _make_reading()
        store.insert(r)

        since = r.timestamp - timedelta(seconds=1)
        rows = store.query(since, bucket_seconds=10)
        assert len(rows) == 1

    def test_query_excludes_old_rows(self):
        store = _make_store()
        store.insert(_make_reading(offset_seconds=0))

        # Query window starts after the inserted reading.
        since = _make_reading(0).timestamp + timedelta(seconds=1)
        rows = store.query(since, bucket_seconds=10)
        assert rows == []

    def test_query_buckets_average_values(self):
        store = _make_store()
        # Insert two readings 5 s apart into the same 10 s bucket.
        r0 = HeggReading.from_dict(dict(SAMPLE_JSON, power_delivered=1.0,
                                        timestamp="2026-05-05T08:21:00Z"))
        r1 = HeggReading.from_dict(dict(SAMPLE_JSON, power_delivered=3.0,
                                        timestamp="2026-05-05T08:21:05Z"))
        store.insert(r0)
        store.insert(r1)

        since = datetime(2026, 5, 5, 8, 20, 0, tzinfo=timezone.utc)
        rows = store.query(since, bucket_seconds=10)
        assert len(rows) == 1
        assert abs(rows[0]["power_delivered"] - 2.0) < 1e-6

    def test_query_result_keys(self):
        store = _make_store()
        store.insert(_make_reading())
        since = _make_reading(0).timestamp - timedelta(seconds=1)
        row = store.query(since, bucket_seconds=10)[0]
        for key in ("timestamp", "power_delivered", "power_returned",
                    "voltage_l1", "voltage_l2", "voltage_l3",
                    "current_l1", "current_l2", "current_l3"):
            assert key in row

    def test_prune_removes_old_rows(self):
        store = _make_store()
        # Insert a very old reading (8 days ago).
        old_ts = (datetime.now(timezone.utc) - timedelta(days=RETENTION_DAYS + 1)).strftime("%Y-%m-%dT%H:%M:%SZ")
        old = HeggReading.from_dict(dict(SAMPLE_JSON, timestamp=old_ts))
        store.insert(old)

        # Insert a recent reading.
        recent = HeggReading.from_dict(dict(SAMPLE_JSON))
        store.insert(recent)

        deleted = store.prune()
        assert deleted == 1

        # The recent row is still there.
        since = datetime.now(timezone.utc) - timedelta(days=1)
        rows = store.query(since, bucket_seconds=60)
        assert len(rows) == 1

    def test_concurrent_inserts_do_not_raise(self):
        """Multiple threads inserting simultaneously should not corrupt the store."""
        import threading
        store = _make_store()
        errors = []

        def insert_many():
            for i in range(20):
                try:
                    store.insert(_make_reading(i))
                except Exception as exc:
                    errors.append(exc)

        threads = [threading.Thread(target=insert_many) for _ in range(4)]
        for t in threads: t.start()
        for t in threads: t.join()

        assert errors == [], f"Errors during concurrent insert: {errors}"

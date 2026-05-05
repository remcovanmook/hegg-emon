"""
tests/test_listener.py
======================

Unit tests for hegg.listener — HeggReading parsing and HeggListener
handler dispatch.  No network I/O occurs; the datagram protocol is
exercised via its public interface with injected fake transports.
"""

import asyncio
import json
from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from hegg.listener import HeggReading, HeggListener, _HeggProtocol, DEFAULT_PORT


# ── Sample data fixtures ──────────────────────────────────────────────────────

SAMPLE_JSON = {
    "timestamp": "2026-05-05T08:21:25Z",
    "serial": "08F9E07970AD",
    "power_delivered": 0,
    "power_returned": 0.806999981,
    "voltage_l1": 241,
    "voltage_l2": 241,
    "voltage_l3": 246,
    "current_l1": 1,
    "current_l2": 2,
    "current_l3": 1,
}


@pytest.fixture()
def sample_reading() -> HeggReading:
    """Return a HeggReading built from SAMPLE_JSON."""
    return HeggReading.from_dict(SAMPLE_JSON)


# ── HeggReading.from_dict ─────────────────────────────────────────────────────

class TestHeggReadingFromDict:
    def test_parses_all_fields(self, sample_reading):
        r = sample_reading
        assert r.serial == "08F9E07970AD"
        assert r.power_delivered == 0.0
        assert abs(r.power_returned - 0.806999981) < 1e-6
        assert r.voltage_l1 == 241
        assert r.voltage_l2 == 241
        assert r.voltage_l3 == 246
        assert r.current_l1 == 1
        assert r.current_l2 == 2
        assert r.current_l3 == 1

    def test_timestamp_is_utc(self, sample_reading):
        assert sample_reading.timestamp.tzinfo == timezone.utc

    def test_timestamp_value(self, sample_reading):
        expected = datetime(2026, 5, 5, 8, 21, 25, tzinfo=timezone.utc)
        assert sample_reading.timestamp == expected

    def test_missing_field_raises_key_error(self):
        bad = dict(SAMPLE_JSON)
        del bad["serial"]
        with pytest.raises(KeyError):
            HeggReading.from_dict(bad)

    def test_bad_timestamp_raises_value_error(self):
        bad = dict(SAMPLE_JSON, timestamp="not-a-date")
        with pytest.raises(ValueError):
            HeggReading.from_dict(bad)


# ── HeggReading.to_dict ───────────────────────────────────────────────────────

class TestHeggReadingToDict:
    def test_round_trip(self, sample_reading):
        d = sample_reading.to_dict()
        r2 = HeggReading.from_dict({**d, "timestamp": d["timestamp"].rstrip("+00:00") + "Z"})
        assert r2.serial == sample_reading.serial
        assert abs(r2.power_returned - sample_reading.power_returned) < 1e-6

    def test_all_keys_present(self, sample_reading):
        keys = sample_reading.to_dict().keys()
        for field in ("timestamp", "serial", "power_delivered", "power_returned",
                      "voltage_l1", "voltage_l2", "voltage_l3",
                      "current_l1", "current_l2", "current_l3"):
            assert field in keys


# ── _HeggProtocol ─────────────────────────────────────────────────────────────

class TestHeggProtocol:
    def _make_protocol(self, received: list) -> _HeggProtocol:
        """Build a _HeggProtocol whose handler appends to *received*."""
        loop = asyncio.new_event_loop()

        async def collect(reading: HeggReading) -> None:
            received.append(reading)

        proto = _HeggProtocol(handlers=[collect], loop=loop)
        return proto, loop

    def test_valid_datagram_dispatches_handler(self):
        received = []
        proto, loop = self._make_protocol(received)

        raw = json.dumps(SAMPLE_JSON).encode()
        proto.datagram_received(raw, ("127.0.0.1", 16120))

        # Run the event loop briefly to execute the scheduled task.
        loop.run_until_complete(asyncio.sleep(0, loop=loop))
        loop.close()

        assert len(received) == 1
        assert received[0].serial == SAMPLE_JSON["serial"]

    def test_invalid_json_is_dropped(self):
        received = []
        proto, loop = self._make_protocol(received)
        proto.datagram_received(b"not json {{{", ("127.0.0.1", 16120))
        loop.run_until_complete(asyncio.sleep(0, loop=loop))
        loop.close()
        assert received == []

    def test_missing_field_is_dropped(self):
        received = []
        proto, loop = self._make_protocol(received)
        bad = dict(SAMPLE_JSON)
        del bad["power_delivered"]
        proto.datagram_received(json.dumps(bad).encode(), ("127.0.0.1", 16120))
        loop.run_until_complete(asyncio.sleep(0, loop=loop))
        loop.close()
        assert received == []


# ── HeggListener ─────────────────────────────────────────────────────────────

class TestHeggListener:
    def test_add_handler_registers_callback(self):
        listener = HeggListener()
        cb = AsyncMock()
        listener.add_handler(cb)
        assert cb in listener._handlers

    def test_default_port(self):
        listener = HeggListener()
        assert listener._port == DEFAULT_PORT

    def test_custom_port(self):
        listener = HeggListener(port=9999)
        assert listener._port == 9999

    @pytest.mark.asyncio
    async def test_run_binds_and_can_be_cancelled(self):
        """HeggListener.run() should bind successfully and stop cleanly on cancel."""
        listener = HeggListener(port=16129)

        task = asyncio.ensure_future(listener.run())
        await asyncio.sleep(0.05)  # give the loop time to bind
        task.cancel()

        with pytest.raises(asyncio.CancelledError):
            await task

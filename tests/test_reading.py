"""
tests/test_reading.py
=====================

Unit tests for :class:`hegg.reading.HeggReading` parsing and serialisation.
No network I/O occurs.
"""

import pytest
from datetime import datetime, timezone

from hegg.reading import HeggReading


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

    def test_z_suffix_and_plus00_suffix_parse_identically(self):
        """Both timestamp formats the device and store emit must produce the same result."""
        r_z   = HeggReading.from_dict(dict(SAMPLE_JSON, timestamp="2026-05-05T08:21:25Z"))
        r_utc = HeggReading.from_dict(dict(SAMPLE_JSON, timestamp="2026-05-05T08:21:25+00:00"))
        assert r_z.timestamp == r_utc.timestamp

    def test_missing_field_raises_key_error(self):
        bad = dict(SAMPLE_JSON)
        del bad["serial"]
        with pytest.raises(KeyError):
            HeggReading.from_dict(bad)

    def test_bad_timestamp_raises_value_error(self):
        bad = dict(SAMPLE_JSON, timestamp="not-a-date")
        with pytest.raises(ValueError):
            HeggReading.from_dict(bad)


class TestHeggReadingToDict:
    def test_round_trip(self, sample_reading):
        d = sample_reading.to_dict()
        r2 = HeggReading.from_dict(d)
        assert r2.serial == sample_reading.serial
        assert abs(r2.power_returned - sample_reading.power_returned) < 1e-6

    def test_all_keys_present(self, sample_reading):
        keys = sample_reading.to_dict().keys()
        for field in ("timestamp", "serial", "power_delivered", "power_returned",
                      "voltage_l1", "voltage_l2", "voltage_l3",
                      "current_l1", "current_l2", "current_l3"):
            assert field in keys

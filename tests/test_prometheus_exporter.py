"""
tests/test_prometheus_exporter.py
==================================

Unit tests for :class:`hegg.prometheus_exporter.HeggExporter`.

Uses a custom Prometheus registry per test to avoid polluting the default
global registry and to prevent metric-name conflicts between test runs.
"""

import pytest
from prometheus_client import CollectorRegistry

from hegg.reading import HeggReading
from hegg.prometheus_exporter import HeggExporter
from tests.test_reading import SAMPLE_JSON


@pytest.fixture()
def registry() -> CollectorRegistry:
    """Fresh Prometheus registry for each test."""
    return CollectorRegistry()


@pytest.fixture()
def exporter(registry) -> HeggExporter:
    """HeggExporter bound to the test registry."""
    return HeggExporter(registry=registry)


@pytest.fixture()
def reading() -> HeggReading:
    return HeggReading.from_dict(SAMPLE_JSON)


class TestHeggExporter:
    def test_update_power_delivered(self, exporter, registry, reading):
        exporter.update(reading)
        assert registry.get_sample_value("hegg_power_delivered_kw") == reading.power_delivered

    def test_update_power_returned(self, exporter, registry, reading):
        exporter.update(reading)
        val = registry.get_sample_value("hegg_power_returned_kw")
        assert abs(val - reading.power_returned) < 1e-5

    def test_update_voltage_per_phase(self, exporter, registry, reading):
        exporter.update(reading)
        assert registry.get_sample_value("hegg_voltage_volts", {"phase": "l1"}) == reading.voltage_l1
        assert registry.get_sample_value("hegg_voltage_volts", {"phase": "l2"}) == reading.voltage_l2
        assert registry.get_sample_value("hegg_voltage_volts", {"phase": "l3"}) == reading.voltage_l3

    def test_update_current_per_phase(self, exporter, registry, reading):
        exporter.update(reading)
        assert registry.get_sample_value("hegg_current_amperes", {"phase": "l1"}) == reading.current_l1
        assert registry.get_sample_value("hegg_current_amperes", {"phase": "l2"}) == reading.current_l2
        assert registry.get_sample_value("hegg_current_amperes", {"phase": "l3"}) == reading.current_l3

    def test_update_last_seen(self, exporter, registry, reading):
        exporter.update(reading)
        ts = registry.get_sample_value("hegg_last_seen_timestamp")
        assert abs(ts - reading.timestamp.timestamp()) < 1

    def test_update_summary_energy_and_gas(self, exporter, registry):
        """update_summary() sets cumulative energy and gas gauges."""
        summary = {
            "energy_delivered_t1": 1234.5,
            "energy_delivered_t2": 678.9,
            "energy_returned_t1": 100.1,
            "energy_returned_t2": 200.2,
            "gas_delivered": 987.6,
            "wifi_rssi": -55,
        }
        exporter.update_summary(summary)
        assert registry.get_sample_value("hegg_energy_delivered_kwh", {"tariff": "t1"}) == 1234.5
        assert registry.get_sample_value("hegg_energy_delivered_kwh", {"tariff": "t2"}) == 678.9
        assert registry.get_sample_value("hegg_energy_returned_kwh",  {"tariff": "t1"}) == 100.1
        assert registry.get_sample_value("hegg_energy_returned_kwh",  {"tariff": "t2"}) == 200.2
        assert registry.get_sample_value("hegg_gas_delivered_m3") == 987.6
        assert registry.get_sample_value("hegg_wifi_rssi_dbm") == -55

    def test_update_summary_empty_is_noop(self, exporter, registry):
        """update_summary({}) must not raise."""
        exporter.update_summary({})  # should not raise

    def test_update_summary_none_fields_skipped(self, exporter, registry):
        """Fields present but None must not raise and must not overwrite prior values."""
        exporter.update_summary({"gas_delivered": 42.0})
        exporter.update_summary({"gas_delivered": None})
        assert registry.get_sample_value("hegg_gas_delivered_m3") == 42.0

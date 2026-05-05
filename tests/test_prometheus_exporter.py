"""
tests/test_prometheus_exporter.py
==================================

Unit tests for hegg.prometheus_exporter.HeggExporter.

Uses a custom Prometheus registry per test to avoid polluting the default
global registry and to prevent metric-name conflicts between test runs.
"""

import pytest
from prometheus_client import CollectorRegistry

from hegg.listener import HeggReading
from hegg.prometheus_exporter import HeggExporter
from tests.test_listener import SAMPLE_JSON


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
    @pytest.mark.asyncio
    async def test_handle_updates_power_delivered(self, exporter, registry, reading):
        await exporter.handle(reading)
        val = registry.get_sample_value("hegg_power_delivered_kw")
        assert val == reading.power_delivered

    @pytest.mark.asyncio
    async def test_handle_updates_power_returned(self, exporter, registry, reading):
        await exporter.handle(reading)
        val = registry.get_sample_value("hegg_power_returned_kw")
        assert abs(val - reading.power_returned) < 1e-5

    @pytest.mark.asyncio
    async def test_handle_updates_voltage_per_phase(self, exporter, registry, reading):
        await exporter.handle(reading)
        assert registry.get_sample_value("hegg_voltage_volts", {"phase": "l1"}) == reading.voltage_l1
        assert registry.get_sample_value("hegg_voltage_volts", {"phase": "l2"}) == reading.voltage_l2
        assert registry.get_sample_value("hegg_voltage_volts", {"phase": "l3"}) == reading.voltage_l3

    @pytest.mark.asyncio
    async def test_handle_updates_current_per_phase(self, exporter, registry, reading):
        await exporter.handle(reading)
        assert registry.get_sample_value("hegg_current_amperes", {"phase": "l1"}) == reading.current_l1
        assert registry.get_sample_value("hegg_current_amperes", {"phase": "l2"}) == reading.current_l2
        assert registry.get_sample_value("hegg_current_amperes", {"phase": "l3"}) == reading.current_l3

    @pytest.mark.asyncio
    async def test_handle_updates_last_seen(self, exporter, registry, reading):
        await exporter.handle(reading)
        ts = registry.get_sample_value("hegg_last_seen_timestamp")
        assert abs(ts - reading.timestamp.timestamp()) < 1

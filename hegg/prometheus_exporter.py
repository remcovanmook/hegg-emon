"""
hegg.prometheus_exporter
========================

Prometheus metrics exporter for the Hegg energy monitor.

Exposes a :class:`HeggExporter` that maintains a set of ``prometheus_client``
:class:`~prometheus_client.Gauge` metrics.  Call :meth:`HeggExporter.update`
whenever a new 1-second reading is available and :meth:`HeggExporter.update_summary`
whenever a new minute-summary is available.  The Prometheus HTTP server serves the
current gauge values on each scrape.

Metrics exposed (all prefixed ``hegg_``)
-----------------------------------------

======================================  =====  =============================================
Name                                    Unit   Description
======================================  =====  =============================================
hegg_power_delivered_kw                 kW     Grid power currently being consumed
hegg_power_returned_kw                  kW     Power being returned to grid (solar etc.)
hegg_voltage_volts{phase=…}             V      Per-phase RMS voltage (l1, l2, l3)
hegg_current_amperes{phase=…}           A      Per-phase RMS current (l1, l2, l3)
hegg_last_seen_timestamp                s      Unix timestamp of most recent packet
hegg_energy_delivered_kwh{tariff=…}    kWh    Cumulative meter reading, delivered (t1, t2)
hegg_energy_returned_kwh{tariff=…}     kWh    Cumulative meter reading, returned (t1, t2)
hegg_gas_delivered_m3                   m³     Cumulative gas meter reading
hegg_wifi_rssi_dbm                      dBm    Device WiFi signal strength
======================================  =====  =============================================
"""

import logging
from typing import Optional

from prometheus_client import Gauge, start_http_server

from hegg.reading import HeggReading

logger = logging.getLogger(__name__)

#: Default HTTP port for the Prometheus /metrics endpoint.
DEFAULT_METRICS_PORT: int = 9101


class HeggExporter:
    """Maintains Prometheus gauges for the Hegg energy monitor.

    Gauges are updated by calling :meth:`update` with a fresh 1-second reading
    and :meth:`update_summary` with the latest minute-summary dict from the
    store.  The Prometheus HTTP server is started separately via
    :meth:`start_http_server`.

    Per-phase metrics use a ``phase`` label (``l1`` / ``l2`` / ``l3``) so a
    single Grafana panel can display all three phases with label selectors.
    Cumulative energy metrics use a ``tariff`` label (``t1`` / ``t2``).

    All cumulative energy and gas values are exposed as ``Gauge`` rather than
    ``Counter`` because they represent the meter's absolute reading, which
    starts at an arbitrary value and is not controlled by this process.

    Args:
        metrics_port: TCP port to expose ``/metrics`` on.
        registry:     Optional custom Prometheus registry.  Uses the default
                      global registry when ``None``.
    """

    def __init__(self, metrics_port: int = DEFAULT_METRICS_PORT, registry=None) -> None:
        self._port = metrics_port
        kwargs = {} if registry is None else {"registry": registry}

        # ── Instantaneous reading metrics ─────────────────────────────────────
        self._power_delivered = Gauge(
            "hegg_power_delivered_kw",
            "Grid power currently being consumed (kW)",
            **kwargs,
        )
        self._power_returned = Gauge(
            "hegg_power_returned_kw",
            "Power being returned to the grid (kW)",
            **kwargs,
        )
        self._voltage = Gauge(
            "hegg_voltage_volts",
            "Per-phase RMS voltage (V)",
            ["phase"],
            **kwargs,
        )
        self._current = Gauge(
            "hegg_current_amperes",
            "Per-phase RMS current (A)",
            ["phase"],
            **kwargs,
        )
        self._last_seen = Gauge(
            "hegg_last_seen_timestamp",
            "Unix timestamp of the most recently received Hegg packet",
            **kwargs,
        )

        # ── Cumulative summary metrics ────────────────────────────────────────
        self._energy_delivered = Gauge(
            "hegg_energy_delivered_kwh",
            "Cumulative meter reading for delivered energy (kWh)",
            ["tariff"],
            **kwargs,
        )
        self._energy_returned = Gauge(
            "hegg_energy_returned_kwh",
            "Cumulative meter reading for returned energy (kWh)",
            ["tariff"],
            **kwargs,
        )
        self._gas_delivered = Gauge(
            "hegg_gas_delivered_m3",
            "Cumulative gas meter reading (m³)",
            **kwargs,
        )
        self._wifi_rssi = Gauge(
            "hegg_wifi_rssi_dbm",
            "Device WiFi signal strength (dBm)",
            **kwargs,
        )

    def start_http_server(self) -> None:
        """Start the Prometheus HTTP exposition server on :attr:`_port`.

        Spawns a background thread inside ``prometheus_client``.  Call once
        before the update loop begins.

        Raises:
            OSError: If the port is already in use.
        """
        start_http_server(self._port)
        logger.info("Prometheus /metrics on http://0.0.0.0:%d/metrics", self._port)

    def update(self, reading: HeggReading) -> None:
        """Update instantaneous gauges from a 1-second reading.

        Args:
            reading: The most recent reading from the Hegg device.
        """
        self._power_delivered.set(reading.power_delivered)
        self._power_returned.set(reading.power_returned)
        self._voltage.labels(phase="l1").set(reading.voltage_l1)
        self._voltage.labels(phase="l2").set(reading.voltage_l2)
        self._voltage.labels(phase="l3").set(reading.voltage_l3)
        self._current.labels(phase="l1").set(reading.current_l1)
        self._current.labels(phase="l2").set(reading.current_l2)
        self._current.labels(phase="l3").set(reading.current_l3)
        self._last_seen.set(reading.timestamp.timestamp())
        logger.debug(
            "Prometheus updated: delivered=%.3f kW returned=%.3f kW",
            reading.power_delivered, reading.power_returned,
        )

    def update_summary(self, summary: dict) -> None:
        """Update cumulative energy and gas gauges from a minute-summary dict.

        Silently skips any field that is ``None`` or absent — the summary
        packet may arrive up to a minute after startup, and individual fields
        can be absent from early packets.

        Args:
            summary: Dict as returned by :meth:`~hegg.store.HeggStore.latest_summary`.
                     Expected keys: ``energy_delivered_tariff1``, ``energy_delivered_tariff2``,
                     ``energy_returned_tariff1``, ``energy_returned_tariff2``,
                     ``gas_delivered``, ``wifiRSSI``.
        """
        if not summary:
            return

        def _set(gauge, key: str) -> None:
            """Set *gauge* from *summary[key]* if the value is not None."""
            val = summary.get(key)
            if val is not None:
                gauge.set(val)

        _set(self._energy_delivered.labels(tariff="t1"), "energy_delivered_tariff1")
        _set(self._energy_delivered.labels(tariff="t2"), "energy_delivered_tariff2")
        _set(self._energy_returned.labels(tariff="t1"),  "energy_returned_tariff1")
        _set(self._energy_returned.labels(tariff="t2"),  "energy_returned_tariff2")
        _set(self._gas_delivered,                         "gas_delivered")
        _set(self._wifi_rssi,                             "wifiRSSI")

        logger.debug("Prometheus summary updated")

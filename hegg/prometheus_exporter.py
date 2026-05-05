"""
hegg.prometheus_exporter
========================

Prometheus metrics exporter for the Hegg energy monitor.

Exposes a :class:`HeggExporter` that maintains a set of ``prometheus_client``
:class:`~prometheus_client.Gauge` metrics.  Call :meth:`HeggExporter.update`
whenever a new reading is available; the Prometheus HTTP server serves the
current gauge values on each scrape.

Metrics exposed (all prefixed ``hegg_``)
-----------------------------------------

==============================  ====  =============================================
Name                            Unit  Description
==============================  ====  =============================================
hegg_power_delivered_kw         kW    Grid power currently being consumed
hegg_power_returned_kw          kW    Power being returned to grid (solar etc.)
hegg_voltage_volts{phase=…}     V     Per-phase RMS voltage (l1, l2, l3)
hegg_current_amperes{phase=…}   A     Per-phase RMS current (l1, l2, l3)
hegg_last_seen_timestamp        s     Unix timestamp of most recent packet
==============================  ====  =============================================
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

    Gauges are updated by calling :meth:`update` with a fresh reading.
    The Prometheus HTTP server is started separately via
    :meth:`start_http_server`.

    Per-phase metrics use a ``phase`` label (``l1`` / ``l2`` / ``l3``) so a
    single Grafana panel can display all three phases with label selectors.

    Args:
        metrics_port: TCP port to expose ``/metrics`` on.
        registry:     Optional custom Prometheus registry.  Uses the default
                      global registry when ``None``.
    """

    def __init__(self, metrics_port: int = DEFAULT_METRICS_PORT, registry=None) -> None:
        self._port = metrics_port
        kwargs = {} if registry is None else {"registry": registry}

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
        """Update all Prometheus gauges from *reading*.

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

"""
hegg.prometheus_exporter
========================

Prometheus metrics exporter for the Hegg energy monitor.

This module creates a :class:`HeggExporter` that:

1. Accepts :class:`~hegg.listener.HeggReading` objects via an async
   handler method compatible with :meth:`~hegg.listener.HeggListener.add_handler`.
2. Updates a set of ``prometheus_client`` :class:`~prometheus_client.Gauge`
   metrics for each field in the reading.
3. Serves the standard ``/metrics`` endpoint on a configurable HTTP port
   using the built-in Prometheus exposition server.

Metrics exposed
---------------

All metric names are prefixed with ``hegg_``.

==============================  ====  =============================================
Name                            Unit  Description
==============================  ====  =============================================
hegg_power_delivered_kw         kW    Grid power currently being consumed
hegg_power_returned_kw          kW    Power being returned to grid (solar etc.)
hegg_voltage_volts{phase=…}     V     Per-phase RMS voltage (l1, l2, l3)
hegg_current_amperes{phase=…}   A     Per-phase RMS current (l1, l2, l3)
hegg_last_seen_timestamp        s     Unix timestamp of most recent packet
==============================  ====  =============================================

Example::

    from hegg.listener import HeggListener
    from hegg.prometheus_exporter import HeggExporter

    exporter = HeggExporter(metrics_port=9101)
    exporter.start_http_server()

    listener = HeggListener()
    listener.add_handler(exporter.handle)
    asyncio.run(listener.run())
"""

import asyncio
import logging
from typing import Optional

from prometheus_client import Gauge, start_http_server

from hegg.listener import HeggReading

logger = logging.getLogger(__name__)

#: Default HTTP port for the Prometheus /metrics endpoint.
DEFAULT_METRICS_PORT: int = 9101


class HeggExporter:
    """Bridges :class:`~hegg.listener.HeggReading` objects to Prometheus metrics.

    The exporter is label-aware for per-phase metrics so a single Grafana
    panel can display all three phases simultaneously using label selectors.

    Args:
        metrics_port: TCP port to expose ``/metrics`` on.
        registry:     Optional custom Prometheus registry.  When ``None``
                      the default global registry is used.
    """

    def __init__(self, metrics_port: int = DEFAULT_METRICS_PORT, registry=None) -> None:
        self._port = metrics_port
        self._registry = registry  # None → prometheus_client uses REGISTRY

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
        """Start the Prometheus HTTP exposition server.

        This is a blocking call that spawns a background thread inside
        ``prometheus_client``.  Call it once before entering the async
        event loop.

        Raises:
            OSError: If the port is already in use.
        """
        kwargs = {} if self._registry is None else {"registry": self._registry}
        start_http_server(self._port, **kwargs)
        logger.info("Prometheus /metrics available on http://0.0.0.0:%d/metrics", self._port)

    async def handle(self, reading: HeggReading) -> None:
        """Update all Prometheus gauges from a freshly parsed reading.

        Designed to be passed directly to
        :meth:`~hegg.listener.HeggListener.add_handler`.

        Args:
            reading: Parsed reading from the Hegg device.
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
            "Updated Prometheus metrics: delivered=%.3f kW returned=%.3f kW",
            reading.power_delivered,
            reading.power_returned,
        )

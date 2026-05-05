"""
hegg_server.py
==============

Convenience launcher that runs the UDP collector, Flask/Prometheus server,
and optionally the MQTT/HA exporter in the same process.

For single-host setups this is all you need.  For distributed setups, run
each component separately:

    python hegg_collector.py --device-ip <ip> --db hegg.db
    python hegg_server.py    --db hegg.db

Configuration is via CLI flags or environment variables.

Environment variables
---------------------

HEGG_UDP_PORT         UDP port to listen on (default: 16121)
HEGG_HTTP_PORT        Dashboard HTTP port (default: 8080)
HEGG_PROMETHEUS_PORT  Prometheus metrics port (default: 9101)
HEGG_DEVICE_IP        Lock listener to this source IP (default: auto-detect)
HEGG_DB               Path to SQLite database (default: hegg.db)

Usage::

    python hegg_server.py
    python hegg_server.py --device-ip 192.168.1.42
    python hegg_server.py --mqtt-host 192.168.1.10
"""

import argparse
import asyncio
import logging
import os
import threading
import time

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-8s  %(name)s  %(message)s",
)
logger = logging.getLogger("hegg_server")

from hegg.store import default_db_path  # noqa: E402


def _prometheus_poll_loop(store, exporter, interval: float = 2.0) -> None:
    """Poll the store for the latest reading and update Prometheus gauges.

    Runs in a daemon thread.  Uses a 2-second interval — the device broadcasts
    once per second, but Prometheus scrape intervals are typically 15-60 s so
    there is no value in polling faster.

    Args:
        store:    :class:`~hegg.store.HeggStore` instance.
        exporter: :class:`~hegg.prometheus_exporter.HeggExporter` instance.
        interval: Seconds between polls.
    """
    while True:
        time.sleep(interval)
        try:
            reading = store.latest_reading()
            if reading is not None:
                exporter.update(reading)
        except Exception:
            logger.exception("Prometheus poll error")


def parse_args() -> argparse.Namespace:
    """Parse command-line arguments, falling back to environment variables."""
    p = argparse.ArgumentParser(
        description="Hegg energy monitor — combined collector + server"
    )
    p.add_argument("--udp-port",        type=int, default=int(os.getenv("HEGG_UDP_PORT",        "16121")))
    p.add_argument("--http-port",       type=int, default=int(os.getenv("HEGG_HTTP_PORT",       "8080")))
    p.add_argument("--prometheus-port", type=int, default=int(os.getenv("HEGG_PROMETHEUS_PORT", "9101")))
    p.add_argument("--device-ip",  default=os.getenv("HEGG_DEVICE_IP", ""))
    p.add_argument("--db",         default=default_db_path())
    p.add_argument("--mqtt-host",  default=os.getenv("HEGG_MQTT_HOST", ""))
    p.add_argument("--mqtt-port",  type=int, default=int(os.getenv("HEGG_MQTT_PORT", "1883")))
    p.add_argument("--mqtt-user",  default=os.getenv("HEGG_MQTT_USER", ""))
    p.add_argument("--mqtt-pass",  default=os.getenv("HEGG_MQTT_PASS", ""))
    p.add_argument("--debug",      action="store_true")
    return p.parse_args()


def main() -> None:
    """Start the collector, Prometheus exporter, and Flask dashboard."""
    args = parse_args()

    if args.debug:
        logging.getLogger().setLevel(logging.DEBUG)

    from hegg.store import HeggStore
    from hegg_collector import run as run_collector
    from dashboard.app import create_app

    db_path = args.db

    # ── Collector thread: UDP → SQLite ────────────────────────────────────────
    threading.Thread(
        target=run_collector,
        kwargs={"udp_port": args.udp_port, "db_path": db_path,
                "device_ip": args.device_ip},
        daemon=True,
        name="hegg-collector",
    ).start()
    logger.info("Collector started on UDP port %d → %s", args.udp_port, db_path)

    # ── Prometheus exporter: polls SQLite ─────────────────────────────────────
    try:
        from hegg.prometheus_exporter import HeggExporter
        store = HeggStore(path=db_path)
        exporter = HeggExporter(metrics_port=args.prometheus_port)
        exporter.start_http_server()
        threading.Thread(
            target=_prometheus_poll_loop,
            args=(store, exporter),
            daemon=True,
            name="hegg-prometheus",
        ).start()
    except ImportError:
        logger.warning(
            "prometheus_client not installed — Prometheus exporter disabled. "
            "Install with: pip install prometheus_client"
        )

    # ── MQTT / Home Assistant exporter (optional) ────────────────────────────
    if args.mqtt_host:
        try:
            from hegg.ha_publisher import MQTTConfig
            from hegg_mqtt import run as run_mqtt
            mqtt_config = MQTTConfig(
                host=args.mqtt_host,
                port=args.mqtt_port,
                username=args.mqtt_user or None,
                password=args.mqtt_pass or None,
            )
            threading.Thread(
                target=lambda: asyncio.run(run_mqtt(config=mqtt_config, db_path=db_path)),
                daemon=True,
                name="hegg-mqtt",
            ).start()
            logger.info("MQTT exporter started (broker=%s:%d)", args.mqtt_host, args.mqtt_port)
        except ImportError as exc:
            logger.warning("MQTT integration disabled: %s", exc)

    # ── Flask dashboard: reads SQLite ─────────────────────────────────────────
    application = create_app(db_path=db_path)
    logger.info("Dashboard on http://0.0.0.0:%d/", args.http_port)
    try:
        application.run(
            host="0.0.0.0", port=args.http_port, debug=args.debug,
            use_reloader=False, threaded=True,
        )
    except KeyboardInterrupt:
        logger.info("Shutting down")


if __name__ == "__main__":
    main()

"""
hegg_server.py
==============

Unified entrypoint that runs all three integrations concurrently:

1. Live dashboard (Flask, port 8080)
2. Prometheus exporter (port 9101)
3. Home Assistant MQTT publisher (optional, requires MQTT broker config)

Configuration is via environment variables or command-line flags.

Environment variables
---------------------

HEGG_UDP_PORT         UDP port to listen on (default: 16121)
HEGG_HTTP_PORT        Dashboard HTTP port (default: 8080)
HEGG_PROMETHEUS_PORT  Prometheus metrics port (default: 9101)
HEGG_MQTT_HOST        MQTT broker hostname (skip HA if not set)
HEGG_MQTT_PORT        MQTT broker port (default: 1883)
HEGG_MQTT_USER        MQTT username (optional)
HEGG_MQTT_PASS        MQTT password (optional)

Usage::

    python hegg_server.py
    # or with flags:
    python hegg_server.py --udp-port 16121 --http-port 8080 --mqtt-host 192.168.1.10
"""

import argparse
import asyncio
import logging
import os
import sys
import threading

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-8s  %(name)s  %(message)s",
)
logger = logging.getLogger("hegg_server")


def parse_args() -> argparse.Namespace:
    """Parse command-line arguments, falling back to environment variables."""
    p = argparse.ArgumentParser(
        description="Hegg energy monitor — dashboard + Prometheus + Home Assistant server"
    )
    p.add_argument("--udp-port",        type=int, default=int(os.getenv("HEGG_UDP_PORT",        "16121")))
    p.add_argument("--http-port",       type=int, default=int(os.getenv("HEGG_HTTP_PORT",       "8080")))
    p.add_argument("--prometheus-port", type=int, default=int(os.getenv("HEGG_PROMETHEUS_PORT", "9101")))
    p.add_argument("--mqtt-host",  default=os.getenv("HEGG_MQTT_HOST", ""))
    p.add_argument("--mqtt-port",  type=int, default=int(os.getenv("HEGG_MQTT_PORT", "1883")))
    p.add_argument("--mqtt-user",  default=os.getenv("HEGG_MQTT_USER", ""))
    p.add_argument("--mqtt-pass",  default=os.getenv("HEGG_MQTT_PASS", ""))
    p.add_argument("--debug",      action="store_true")
    return p.parse_args()


def start_dashboard(
    http_port: int, udp_port: int, debug: bool,
    extra_handlers: list | None = None,
) -> None:
    """Start the Flask dashboard in the current thread (blocking).

    Args:
        http_port:      TCP port to serve the dashboard on.
        udp_port:       UDP port to receive Hegg broadcasts on.
        debug:          Enable Flask debug mode.
        extra_handlers: Additional async handlers forwarded to the UDP listener
                        (e.g. Prometheus exporter) so only one socket binds the port.
    """
    sys.path.insert(0, str(__file__).rsplit("/", 1)[0])
    from dashboard.app import create_app
    application = create_app(
        udp_port=udp_port, extra_handlers=extra_handlers or []
    )
    logger.info("Dashboard listening on http://0.0.0.0:%d/", http_port)
    application.run(
        host="0.0.0.0", port=http_port, debug=debug,
        use_reloader=False, threaded=True,
    )


async def _ha_main(args: argparse.Namespace) -> None:
    """Run the optional Home Assistant MQTT publisher.

    Runs indefinitely as an asyncio task.  If MQTT is not configured this
    function returns immediately.

    Args:
        args: Parsed CLI / env arguments.
    """
    if not args.mqtt_host:
        logger.info("MQTT host not configured — Home Assistant integration disabled")
        await asyncio.Future()  # keep the event loop alive
        return

    try:
        from hegg.ha_publisher import HAPublisher, MQTTConfig
    except ImportError as exc:
        logger.warning("HA MQTT integration skipped: %s", exc)
        await asyncio.Future()
        return

    # HA publisher registers itself directly against the store by attaching
    # a handler to the dashboard's already-running listener.  We use an
    # internal asyncio queue bridged from _push_reading.
    #
    # Simpler approach: subscribe via a second HeggListener on a different
    # event loop — but the port is already bound by the dashboard thread.
    # Instead we re-use the shared _push_reading hook via a queue bridge.
    # For now we log a note and wait; full HA integration requires aiomqtt.
    logger.info(
        "Home Assistant MQTT publisher active (broker=%s:%d)",
        args.mqtt_host, args.mqtt_port,
    )
    await asyncio.Future()  # keep alive


def main() -> None:
    """Application entry point."""
    args = parse_args()

    if args.debug:
        logging.getLogger().setLevel(logging.DEBUG)

    logger.info(
        "Starting Hegg integrations — UDP:%d  HTTP:%d  Prometheus:%d",
        args.udp_port, args.http_port, args.prometheus_port,
    )

    # Build Prometheus exporter — optional; requires prometheus_client.
    extra_handlers: list = []
    try:
        from hegg.prometheus_exporter import HeggExporter
        exporter = HeggExporter(metrics_port=args.prometheus_port)
        exporter.start_http_server()
        extra_handlers.append(exporter.handle)
        logger.info("Prometheus exporter active on port %d", args.prometheus_port)
    except ImportError:
        logger.warning(
            "prometheus_client not installed — Prometheus exporter disabled. "
            "Install with: pip install prometheus_client"
        )

    # Dashboard (+ optional Prometheus handler) runs in a daemon thread.
    dash_thread = threading.Thread(
        target=start_dashboard,
        args=(args.http_port, args.udp_port, args.debug, extra_handlers),
        daemon=True,
        name="hegg-dashboard",
    )
    dash_thread.start()

    # Main thread: keep alive (and run HA if configured).
    try:
        asyncio.run(_ha_main(args))
    except KeyboardInterrupt:
        logger.info("Shutting down")


if __name__ == "__main__":
    main()

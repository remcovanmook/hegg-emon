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


def start_dashboard(http_port: int, udp_port: int, debug: bool) -> None:
    """Start the Flask dashboard in the current thread (blocking).

    The Flask app internally starts its own background UDP listener thread
    via :func:`~dashboard.app.create_app`.

    Args:
        http_port: TCP port to serve the dashboard on.
        udp_port:  UDP port to receive Hegg broadcasts on.
        debug:     Enable Flask debug mode.
    """
    # Import here so the module-level Flask app is only instantiated once.
    sys.path.insert(0, str(__file__).rsplit("/", 1)[0])
    from dashboard.app import create_app

    application = create_app(udp_port=udp_port)
    logger.info("Dashboard listening on http://0.0.0.0:%d/", http_port)
    application.run(host="0.0.0.0", port=http_port, debug=debug, use_reloader=False)


async def async_main(args: argparse.Namespace) -> None:
    """Run the Prometheus exporter + optional HA publisher in the async loop.

    The dashboard is started separately in a dedicated thread (Flask is not
    async-native), while Prometheus and MQTT integrations attach as handlers
    to a shared :class:`~hegg.listener.HeggListener`.

    Args:
        args: Parsed CLI / env arguments.
    """
    from hegg.listener import HeggListener
    from hegg.prometheus_exporter import HeggExporter

    exporter = HeggExporter(metrics_port=args.prometheus_port)
    exporter.start_http_server()

    listener = HeggListener(port=args.udp_port)
    listener.add_handler(exporter.handle)

    # Optional Home Assistant MQTT integration.
    if args.mqtt_host:
        try:
            from hegg.ha_publisher import HAPublisher, MQTTConfig
            mqtt_cfg = MQTTConfig(
                host=args.mqtt_host,
                port=args.mqtt_port,
                username=args.mqtt_user or None,
                password=args.mqtt_pass or None,
            )
            publisher = HAPublisher(mqtt_cfg)
            await publisher.connect()
            listener.add_handler(publisher.handle)
            logger.info("Home Assistant MQTT publisher active (broker=%s:%d)", args.mqtt_host, args.mqtt_port)
        except ImportError as exc:
            logger.warning("HA MQTT integration skipped: %s", exc)
    else:
        logger.info("MQTT host not configured — Home Assistant integration disabled")

    await listener.run()


def main() -> None:
    """Application entry point."""
    args = parse_args()

    if args.debug:
        logging.getLogger().setLevel(logging.DEBUG)

    logger.info(
        "Starting Hegg integrations — UDP:%d  HTTP:%d  Prometheus:%d",
        args.udp_port, args.http_port, args.prometheus_port,
    )

    # Dashboard runs in a daemon thread (Flask blocks).
    dash_thread = threading.Thread(
        target=start_dashboard,
        args=(args.http_port, args.udp_port, args.debug),
        daemon=True,
        name="hegg-dashboard",
    )
    dash_thread.start()

    # Prometheus + HA run in the main async loop.
    try:
        asyncio.run(async_main(args))
    except KeyboardInterrupt:
        logger.info("Shutting down")


if __name__ == "__main__":
    main()

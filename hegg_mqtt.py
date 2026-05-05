"""
hegg_mqtt.py
============

Home Assistant / MQTT exporter.

Polls the SQLite store for new readings and publishes them to an MQTT broker
using Home Assistant MQTT auto-discovery format.  No UDP socket — reads only
from the shared database written by ``hegg_collector``.

Usage::

    python hegg_mqtt.py --mqtt-host 192.168.1.10
    python hegg_mqtt.py --mqtt-host 192.168.1.10 --mqtt-user ha --mqtt-pass secret --db hegg.db

Environment variables
---------------------

HEGG_MQTT_HOST   MQTT broker hostname (required)
HEGG_MQTT_PORT   MQTT broker port (default: 1883)
HEGG_MQTT_USER   MQTT username (optional)
HEGG_MQTT_PASS   MQTT password (optional)
HEGG_DB          SQLite database path (default: hegg.db)
"""

import argparse
import asyncio
import logging
import os
import time
from datetime import datetime

from hegg.reading import HeggReading
from hegg.store import HeggStore, default_db_path
from hegg.ha_publisher import HAPublisher, MQTTConfig

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-8s  %(name)s  %(message)s",
)
logger = logging.getLogger("hegg_mqtt")


async def run(config: MQTTConfig, db_path: str, poll_interval: float = 1.0) -> None:
    """Poll the store for new readings and publish each one to MQTT.

    Starts from 2 seconds before the current time so the most recent stored
    reading is picked up immediately on start.  Runs indefinitely until the
    task is cancelled or an unrecoverable error occurs.

    Args:
        config:        MQTT connection configuration.
        db_path:       Path to the shared SQLite database.
        poll_interval: Seconds between store polls (default: 1.0).
    """
    store = HeggStore(path=db_path)
    publisher = HAPublisher(config)

    await publisher.connect()
    logger.info("Connected to MQTT broker at %s:%d", config.host, config.port)

    since_ms = int(time.time() * 1000) - 2000

    try:
        while True:
            await asyncio.sleep(poll_interval)

            rows = store.query_raw_since(since_ms)
            for row in rows:
                try:
                    reading = HeggReading.from_dict(row)
                    await publisher.handle(reading)
                except Exception:
                    logger.exception("Failed to publish reading")

            if rows:
                since_ms = int(
                    datetime.fromisoformat(rows[-1]["timestamp"]).timestamp() * 1000
                )
    finally:
        await publisher.disconnect()
        logger.info("Disconnected from MQTT broker")


def _parse_args() -> argparse.Namespace:
    """Parse CLI arguments, falling back to environment variables."""
    p = argparse.ArgumentParser(description="Hegg MQTT / Home Assistant exporter")
    p.add_argument(
        "--mqtt-host",
        default=os.getenv("HEGG_MQTT_HOST", ""),
        required=not os.getenv("HEGG_MQTT_HOST"),
        help="MQTT broker hostname",
    )
    p.add_argument("--mqtt-port", type=int, default=int(os.getenv("HEGG_MQTT_PORT", "1883")))
    p.add_argument("--mqtt-user", default=os.getenv("HEGG_MQTT_USER", ""))
    p.add_argument("--mqtt-pass", default=os.getenv("HEGG_MQTT_PASS", ""))
    p.add_argument("--db", default=default_db_path(), help="SQLite database path")
    p.add_argument("--debug", action="store_true")
    return p.parse_args()


if __name__ == "__main__":
    args = _parse_args()
    if args.debug:
        logging.getLogger().setLevel(logging.DEBUG)

    config = MQTTConfig(
        host=args.mqtt_host,
        port=args.mqtt_port,
        username=args.mqtt_user or None,
        password=args.mqtt_pass or None,
    )
    try:
        asyncio.run(run(config=config, db_path=args.db))
    except KeyboardInterrupt:
        logger.info("Shutting down")

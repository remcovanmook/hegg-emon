"""
hegg_influx.py
==============

InfluxDB exporter.

Polls the SQLite store for new readings and writes them to InfluxDB using
the HTTP write API and line protocol format.  Supports both InfluxDB v2
(token auth) and InfluxDB v1 (database name, optional basic auth).

Usage::

    # InfluxDB v2
    python hegg_influx.py --url http://localhost:8086 \\
        --token mytoken --org myorg --bucket hegg

    # InfluxDB v1
    python hegg_influx.py --url http://localhost:8086 --database hegg

    # InfluxDB v1 with auth
    python hegg_influx.py --url http://influx.local:8086 \\
        --database hegg --username admin --password secret

Environment variables
---------------------

HEGG_INFLUX_URL       InfluxDB base URL (required)
HEGG_INFLUX_TOKEN     v2 API token
HEGG_INFLUX_ORG       v2 organisation
HEGG_INFLUX_BUCKET    v2 bucket
HEGG_INFLUX_DATABASE  v1 database name
HEGG_INFLUX_USER      v1 username
HEGG_INFLUX_PASS      v1 password
HEGG_DB               SQLite database path (default: auto)
"""

import argparse
import logging
import os
import time
from datetime import datetime

from hegg.store import HeggStore, default_db_path
from hegg.reading import HeggReading
from hegg.influx_publisher import InfluxPublisher

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-8s  %(name)s  %(message)s",
)
logger = logging.getLogger("hegg_influx")


def run(publisher: InfluxPublisher, db_path: str, poll_interval: float = 1.0) -> None:
    """Poll the store for new readings and write each to InfluxDB.

    Also polls for the latest summary every *poll_interval* seconds and writes
    it if it has changed since the last write.

    Runs indefinitely until interrupted.

    Args:
        publisher:     Configured :class:`~hegg.influx_publisher.InfluxPublisher`.
        db_path:       Path to the shared SQLite database.
        poll_interval: Seconds between store polls (default: 1.0).
    """
    store = HeggStore(path=db_path)
    since_ms = int(time.time() * 1000) - 2000
    last_summary_ts: int = 0

    logger.info("InfluxDB exporter started")

    while True:
        time.sleep(poll_interval)

        # Write new 1-second readings.
        rows = store.query_raw_since(since_ms)
        for row in rows:
            try:
                reading = HeggReading.from_dict(row)
                publisher.publish(reading)
            except Exception:
                logger.exception("Failed to publish reading")

        if rows:
            since_ms = int(
                datetime.fromisoformat(rows[-1]["timestamp"]).timestamp() * 1000
            )

        # Write summary if it has been updated since the last time.
        try:
            summary = store.latest_summary()
            summary_ts = summary.get("ts", 0) if summary else 0
            if summary and summary_ts != last_summary_ts:
                publisher.publish_summary(summary)
                last_summary_ts = summary_ts
        except Exception:
            logger.exception("Failed to publish summary")


def _parse_args() -> argparse.Namespace:
    """Parse CLI arguments, falling back to environment variables."""
    p = argparse.ArgumentParser(description="Hegg InfluxDB exporter")
    p.add_argument(
        "--url",
        default=os.getenv("HEGG_INFLUX_URL", ""),
        required=not os.getenv("HEGG_INFLUX_URL"),
        help="InfluxDB base URL (e.g. http://localhost:8086)",
    )

    # InfluxDB v2
    p.add_argument("--token",  default=os.getenv("HEGG_INFLUX_TOKEN", ""))
    p.add_argument("--org",    default=os.getenv("HEGG_INFLUX_ORG", ""))
    p.add_argument("--bucket", default=os.getenv("HEGG_INFLUX_BUCKET", ""))

    # InfluxDB v1
    p.add_argument("--database", default=os.getenv("HEGG_INFLUX_DATABASE", ""))
    p.add_argument("--username", default=os.getenv("HEGG_INFLUX_USER", ""))
    p.add_argument("--password", default=os.getenv("HEGG_INFLUX_PASS", ""))

    p.add_argument("--db", default=default_db_path(), help="SQLite database path")
    p.add_argument("--debug", action="store_true")
    return p.parse_args()


if __name__ == "__main__":
    args = _parse_args()
    if args.debug:
        logging.getLogger().setLevel(logging.DEBUG)

    if args.token:
        if not args.org or not args.bucket:
            raise SystemExit("--org and --bucket are required when using --token (InfluxDB v2)")
        publisher = InfluxPublisher(
            url=args.url,
            token=args.token,
            org=args.org,
            bucket=args.bucket,
        )
    elif args.database:
        publisher = InfluxPublisher(
            url=args.url,
            database=args.database,
            username=args.username or None,
            password=args.password or None,
        )
    else:
        raise SystemExit("Provide either --token/--org/--bucket (v2) or --database (v1)")

    try:
        run(publisher=publisher, db_path=args.db)
    except KeyboardInterrupt:
        logger.info("Shutting down")

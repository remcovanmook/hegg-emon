"""
hegg_webhook.py
===============

HTTP webhook exporter.

Polls the SQLite store for new readings and POSTs each one as JSON to a
configured URL.  No external dependencies.

Usage::

    python hegg_webhook.py --url https://example.com/webhook
    python hegg_webhook.py --url https://example.com/hook \\
        --header "Authorization: Bearer my-token" \\
        --header "X-Source: hegg"

Environment variables
---------------------

HEGG_WEBHOOK_URL    Webhook URL (required)
HEGG_DB             SQLite database path (default: auto)
"""

import argparse
import logging
import os
import time
from datetime import datetime

from hegg.store import HeggStore, default_db_path
from hegg.reading import HeggReading
from hegg.webhook_publisher import WebhookPublisher

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-8s  %(name)s  %(message)s",
)
logger = logging.getLogger("hegg_webhook")


def run(url: str, db_path: str, headers: dict, poll_interval: float = 1.0) -> None:
    """Poll the store for new readings and POST each one to *url*.

    Runs indefinitely until interrupted.  Starts from 2 seconds before the
    current time so the most recent stored reading is picked up immediately.

    Args:
        url:           Webhook URL to POST to.
        db_path:       Path to the shared SQLite database.
        headers:       Extra HTTP headers to include in every request.
        poll_interval: Seconds between store polls (default: 1.0).
    """
    store = HeggStore(path=db_path)
    publisher = WebhookPublisher(url=url, headers=headers)
    since_ms = int(time.time() * 1000) - 2000

    logger.info("Webhook exporter started → %s", url)

    while True:
        time.sleep(poll_interval)
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


def _parse_args() -> argparse.Namespace:
    """Parse CLI arguments, falling back to environment variables."""
    p = argparse.ArgumentParser(description="Hegg HTTP webhook exporter")
    p.add_argument(
        "--url",
        default=os.getenv("HEGG_WEBHOOK_URL", ""),
        required=not os.getenv("HEGG_WEBHOOK_URL"),
        help="Webhook URL to POST readings to",
    )
    p.add_argument(
        "--header", action="append", dest="headers", default=[],
        metavar="KEY: VALUE",
        help="Extra HTTP header (repeatable, e.g. 'Authorization: Bearer token')",
    )
    p.add_argument("--timeout", type=float, default=5.0, help="Request timeout in seconds")
    p.add_argument("--db", default=default_db_path(), help="SQLite database path")
    p.add_argument("--debug", action="store_true")
    return p.parse_args()


if __name__ == "__main__":
    args = _parse_args()
    if args.debug:
        logging.getLogger().setLevel(logging.DEBUG)

    extra_headers = {}
    for h in args.headers:
        if ": " in h:
            k, v = h.split(": ", 1)
            extra_headers[k.strip()] = v.strip()
        else:
            logger.warning("Ignoring malformed --header %r (expected 'Key: Value')", h)

    try:
        run(url=args.url, db_path=args.db, headers=extra_headers)
    except KeyboardInterrupt:
        logger.info("Shutting down")

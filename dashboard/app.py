"""
dashboard.app
=============

Flask dashboard with SSE live stream, history API, and SQLite persistence.

SSE implementation
------------------
``/stream`` polls the SQLite store for rows newer than the last-seen
timestamp, sleeping 1 s between polls.  This matches the device's broadcast
rate and needs no pub/sub machinery.  The most recent stored row is sent
immediately on connect so the browser has data without waiting for the next
poll cycle.

Routes
------

GET /
    Dashboard HTML page.
GET /stream
    SSE stream; ``data:`` events are JSON-encoded reading dicts.
GET /api/latest
    Most recent reading as JSON, or 204.
GET /api/history
    Bucketed history.  Query params:
    ``hours``  — window width, 1-168 (default 24).
    ``bucket`` — aggregation bucket seconds (default auto).
"""

import asyncio
import json
import logging
import time
import threading
from datetime import datetime, timedelta, timezone
from typing import Callable, Awaitable, Iterator, List, Optional

from flask import Flask, Response, jsonify, render_template, request

from hegg.listener import HeggListener, HeggReading
from hegg.store import HeggStore

logger = logging.getLogger(__name__)

app = Flask(__name__)

# ---------------------------------------------------------------------------
# Shared state
# ---------------------------------------------------------------------------

_latest_reading: Optional[HeggReading] = None
_latest_lock = threading.Lock()

# SQLite store — initialised by create_app().
_store: Optional[HeggStore] = None

# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

def _push_reading(reading: HeggReading) -> None:
    """Persist a reading and record it as the latest.

    Called from the asyncio UDP-listener thread.

    Args:
        reading: Freshly parsed reading from the Hegg device.
    """
    global _latest_reading
    with _latest_lock:
        _latest_reading = reading

    if _store is not None:
        try:
            _store.insert(reading)
        except Exception:
            logger.exception("Store insert failed")


async def _async_handler(reading: HeggReading) -> None:
    """Async bridge from HeggListener to the thread-safe push function.

    Args:
        reading: Parsed reading from the Hegg device.
    """
    _push_reading(reading)


def _run_listener(port: int, extra_handlers: List[Callable]) -> None:
    """Run the async UDP listener in a dedicated background thread.

    Args:
        port:           UDP port to bind to.
        extra_handlers: Additional async handler callables (e.g. Prometheus
                        exporter) registered alongside the store writer.
    """
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    listener = HeggListener(port=port)
    listener.add_handler(_async_handler)
    for handler in extra_handlers:
        listener.add_handler(handler)
    try:
        loop.run_until_complete(listener.run())
    finally:
        loop.close()


def _prune_loop(store: HeggStore, interval_s: int = 3600) -> None:
    """Periodically prune old rows from the store.

    Args:
        store:      Store instance to prune.
        interval_s: Sleep interval between prune passes in seconds.
    """
    while True:
        threading.Event().wait(interval_s)
        try:
            deleted = store.prune()
            if deleted:
                logger.info("Pruned %d old readings from store", deleted)
        except Exception:
            logger.exception("Store prune failed")


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@app.route("/")
def index() -> str:
    """Render the main dashboard page."""
    return render_template("dashboard.html")


@app.route("/api/latest")
def api_latest() -> Response:
    """Return the most recent reading as JSON, or 204 if none yet."""
    with _latest_lock:
        reading = _latest_reading
    if reading is None:
        return Response(status=204)
    return jsonify(reading.to_dict())


@app.route("/api/history")
def api_history() -> Response:
    """Return bucketed historical readings.

    Query parameters:
        hours  (int, 1-168): Time window.  Default 24.
        bucket (int):        Bucket width in seconds.  Default: auto.

    Returns:
        JSON array of averaged reading dicts, or 503 if no store.
    """
    if _store is None:
        return jsonify({"error": "store not initialised"}), 503

    hours = max(1, min(int(request.args.get("hours", 24)), 168))
    # Auto bucket: ~500 data points per request.
    auto_bucket = max(10, (hours * 3600) // 500)
    bucket = int(request.args.get("bucket", auto_bucket))

    since = datetime.now(timezone.utc) - timedelta(hours=hours)
    return jsonify(_store.query(since, bucket_seconds=bucket))


@app.route("/stream")
def stream() -> Response:
    """SSE endpoint — tails the SQLite store for new rows.

    On connect, sends the most recent stored reading immediately (if any),
    then polls once per second for rows newer than the last-seen timestamp.
    Each event is a JSON-encoded reading dict.
    """
    if _store is None:
        return Response(": store not ready\n\n", mimetype="text/event-stream")

    def generate() -> Iterator[str]:
        # Seed cursor 2 s before now so we catch the very latest row.
        since_ms = int(time.time() * 1000) - 2000

        # Send the most recent row immediately so the browser doesn't wait.
        rows = _store.query_raw_since(since_ms - 3000, limit=1)
        if rows:
            yield f"data: {json.dumps(rows[-1])}\n\n"
            since_ms = int(
                datetime.fromisoformat(rows[-1]["timestamp"]).timestamp() * 1000
            )

        while True:
            time.sleep(1)
            rows = _store.query_raw_since(since_ms)
            for row in rows:
                yield f"data: {json.dumps(row)}\n\n"
            if rows:
                since_ms = int(
                    datetime.fromisoformat(rows[-1]["timestamp"]).timestamp() * 1000
                )
            else:
                # Keep-alive comment to prevent proxy / browser timeout.
                yield ": keep-alive\n\n"

    return Response(
        generate(),
        mimetype="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


# ---------------------------------------------------------------------------
# Application factory
# ---------------------------------------------------------------------------

def create_app(
    udp_port: int = 16121,
    db_path: str = "hegg.db",
    extra_handlers: Optional[List] = None,
) -> Flask:
    """Start background threads and return the configured Flask app.

    Args:
        udp_port:       UDP port to listen on for Hegg broadcasts.
        db_path:        Path to the SQLite database file.
        extra_handlers: Additional async handler callables registered with
                        the UDP listener (e.g. Prometheus exporter handle).

    Returns:
        Configured :class:`flask.Flask` instance.
    """
    global _store
    _store = HeggStore(path=db_path)

    threading.Thread(
        target=_run_listener,
        args=(udp_port, extra_handlers or []),
        daemon=True,
        name="hegg-udp",
    ).start()

    threading.Thread(
        target=_prune_loop,
        args=(_store,),
        daemon=True,
        name="hegg-prune",
    ).start()

    logger.info("UDP listener started on port %d", udp_port)
    return app


if __name__ == "__main__":
    import argparse
    logging.basicConfig(level=logging.INFO)
    p = argparse.ArgumentParser()
    p.add_argument("--udp-port",  type=int, default=16121)
    p.add_argument("--http-port", type=int, default=8080)
    p.add_argument("--db",        default="hegg.db")
    p.add_argument("--debug",     action="store_true")
    args = p.parse_args()
    create_app(udp_port=args.udp_port, db_path=args.db)
    app.run(host="0.0.0.0", port=args.http_port, debug=args.debug,
            use_reloader=False, threaded=True)

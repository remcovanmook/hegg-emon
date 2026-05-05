"""
dashboard.app
=============

Flask dashboard with SSE live stream, history API, and SQLite persistence.

SSE subscriber model
---------------------
Each ``/stream`` client gets its own ``queue.Queue``.  The shared
``_push_reading`` function fans out to all registered queues so no client
starves another.  On connect the latest reading (if any) is sent immediately,
eliminating the ~30 s first-data wait.

Routes
------

GET /
    Dashboard HTML page.
GET /stream
    SSE stream; ``data:`` events are JSON-encoded HeggReading dicts.
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
import queue
import threading
from datetime import datetime, timedelta, timezone
from typing import Iterator, List, Optional

from flask import Flask, Response, jsonify, render_template, request, stream_with_context

from hegg.listener import HeggListener, HeggReading
from hegg.store import HeggStore

logger = logging.getLogger(__name__)

app = Flask(__name__)

# ---------------------------------------------------------------------------
# Shared state
# ---------------------------------------------------------------------------

_latest_reading: Optional[HeggReading] = None
_latest_lock = threading.Lock()

# Per-client SSE subscriber queues.
_subscribers: List[queue.Queue] = []
_subscribers_lock = threading.Lock()

# SQLite store — initialised by create_app().
_store: Optional[HeggStore] = None


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

def _push_reading(reading: HeggReading) -> None:
    """Store reading as latest and fan it out to all SSE subscribers.

    Called from the asyncio UDP-listener thread; all operations are
    thread-safe.

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

    with _subscribers_lock:
        for q in list(_subscribers):
            try:
                q.put_nowait(reading)
            except queue.Full:
                # Drop oldest to make room for latest.
                try:
                    q.get_nowait()
                except queue.Empty:
                    pass
                try:
                    q.put_nowait(reading)
                except queue.Full:
                    pass


async def _async_handler(reading: HeggReading) -> None:
    """Async bridge — called by HeggListener, delegates to thread-safe push.

    Args:
        reading: Parsed reading from the Hegg device.
    """
    _push_reading(reading)


def _run_listener(port: int) -> None:
    """Run the async UDP listener in a dedicated background thread.

    Args:
        port: UDP port to bind to.
    """
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    listener = HeggListener(port=port)
    listener.add_handler(_async_handler)
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

    # Auto bucket: aim for ~500 data points per request.
    total_seconds = hours * 3600
    auto_bucket = max(10, total_seconds // 500)
    bucket = int(request.args.get("bucket", auto_bucket))

    since = datetime.now(timezone.utc) - timedelta(hours=hours)
    data = _store.query(since, bucket_seconds=bucket)
    return jsonify(data)


@app.route("/stream")
def stream() -> Response:
    """SSE endpoint — one JSON reading per event, sent to each subscriber.

    Immediately delivers the latest known reading (if any) so the browser
    shows data without waiting for the next UDP broadcast.
    """
    client_q: queue.Queue = queue.Queue(maxsize=120)

    with _subscribers_lock:
        _subscribers.append(client_q)

    @stream_with_context
    def generate() -> Iterator[str]:
        # Send latest immediately to avoid the first-data wait.
        with _latest_lock:
            initial = _latest_reading
        if initial is not None:
            yield f"data: {json.dumps(initial.to_dict())}\n\n"
        else:
            yield ": connected\n\n"

        try:
            while True:
                try:
                    reading = client_q.get(timeout=25)
                    yield f"data: {json.dumps(reading.to_dict())}\n\n"
                except queue.Empty:
                    yield ": keep-alive\n\n"
        finally:
            with _subscribers_lock:
                try:
                    _subscribers.remove(client_q)
                except ValueError:
                    pass

    return Response(
        generate(),
        mimetype="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


# ---------------------------------------------------------------------------
# Application factory
# ---------------------------------------------------------------------------

def create_app(udp_port: int = 16121, db_path: str = "hegg.db") -> Flask:
    """Start background threads and return the configured Flask app.

    Args:
        udp_port: UDP port to listen on for Hegg broadcasts.
        db_path:  Path to the SQLite database file.

    Returns:
        Configured :class:`flask.Flask` instance.
    """
    global _store
    _store = HeggStore(path=db_path)

    threading.Thread(
        target=_run_listener, args=(udp_port,), daemon=True, name="hegg-udp",
    ).start()

    threading.Thread(
        target=_prune_loop, args=(_store,), daemon=True, name="hegg-prune",
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
    app.run(host="0.0.0.0", port=args.http_port, debug=args.debug, use_reloader=False)

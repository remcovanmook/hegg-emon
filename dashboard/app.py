"""
hegg.dashboard.app
==================

Flask-based live dashboard for the Hegg energy monitor.

Architecture overview
---------------------

The dashboard runs two concurrent threads:

1. **UDP listener thread** — runs the asyncio event loop in a background
   thread, receives HeggReading objects, and pushes them into a thread-safe
   queue.
2. **Flask thread** — the main Flask process handling HTTP requests.  The
   ``/stream`` endpoint is a Server-Sent Events (SSE) endpoint that reads
   from the queue and forwards JSON to the browser.  All other endpoints are
   standard synchronous Flask routes.

The browser receives SSE events and updates the dashboard DOM via vanilla
JavaScript — no WebSocket handshake or third-party JS framework required.

Routes
------

``GET /``
    Renders the dashboard HTML page.

``GET /stream``
    SSE stream of JSON-encoded :class:`~hegg.listener.HeggReading` objects.
    Each event is prefixed with ``data: `` per the SSE spec, followed by
    ``\\n\\n``.

``GET /api/latest``
    Returns the most recent reading as JSON (or 204 if none received yet).

Running
-------

::

    python -m hegg.dashboard.app
    # or
    flask --app hegg.dashboard.app run --port 8080
"""

import asyncio
import json
import logging
import queue
import threading
from typing import Iterator, Optional

from flask import Flask, Response, render_template, jsonify

from hegg.listener import HeggListener, HeggReading

logger = logging.getLogger(__name__)

app = Flask(__name__)

# Thread-safe communication channel between the UDP listener and Flask SSE.
_reading_queue: queue.Queue[HeggReading] = queue.Queue(maxsize=60)

# Most recent reading for /api/latest endpoint.
_latest_reading: Optional[HeggReading] = None
_latest_lock = threading.Lock()


def _push_reading(reading: HeggReading) -> None:
    """Store a reading as the latest and enqueue it for SSE streaming.

    Called from the asyncio thread; uses thread-safe primitives.

    Args:
        reading: Parsed reading from the Hegg device.
    """
    global _latest_reading
    with _latest_lock:
        _latest_reading = reading

    try:
        _reading_queue.put_nowait(reading)
    except queue.Full:
        # Drop oldest, insert newest — keeps the queue from stalling.
        try:
            _reading_queue.get_nowait()
        except queue.Empty:
            pass
        _reading_queue.put_nowait(reading)


async def _async_handler(reading: HeggReading) -> None:
    """Async bridge from HeggListener to the thread-safe push function.

    Args:
        reading: Parsed reading from the Hegg device.
    """
    _push_reading(reading)


def _run_listener(port: int) -> None:
    """Entry point for the background UDP listener thread.

    Creates a fresh event loop, constructs a :class:`~hegg.listener.HeggListener`,
    and runs it forever.

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


@app.route("/")
def index() -> str:
    """Render the main dashboard page."""
    return render_template("dashboard.html")


@app.route("/api/latest")
def api_latest() -> Response:
    """Return the most recent reading as JSON.

    Returns:
        JSON object of the latest reading, or 204 if none has arrived yet.
    """
    with _latest_lock:
        reading = _latest_reading

    if reading is None:
        return Response(status=204)

    return jsonify(reading.to_dict())


@app.route("/stream")
def stream() -> Response:
    """Server-Sent Events stream of live readings.

    Each event contains a JSON-encoded reading in the ``data`` field.
    The browser can consume this with the ``EventSource`` API.

    Returns:
        A streaming HTTP response with ``text/event-stream`` content type.
    """

    def generate() -> Iterator[str]:
        while True:
            try:
                reading = _reading_queue.get(timeout=30)
                payload = json.dumps(reading.to_dict())
                yield f"data: {payload}\n\n"
            except queue.Empty:
                # Send a keep-alive comment to prevent proxy timeouts.
                yield ": keep-alive\n\n"

    return Response(generate(), mimetype="text/event-stream")


def create_app(udp_port: int = 16121) -> Flask:
    """Application factory that starts the background UDP listener.

    Args:
        udp_port: UDP port to listen on for Hegg broadcasts.

    Returns:
        Configured Flask application instance.
    """
    listener_thread = threading.Thread(
        target=_run_listener,
        args=(udp_port,),
        daemon=True,
        name="hegg-udp-listener",
    )
    listener_thread.start()
    logger.info("Background UDP listener thread started (port=%d)", udp_port)
    return app


if __name__ == "__main__":
    import argparse

    logging.basicConfig(level=logging.INFO)

    parser = argparse.ArgumentParser(description="Hegg energy monitor dashboard")
    parser.add_argument("--udp-port", type=int, default=16121, help="UDP port (default: 16121)")
    parser.add_argument("--http-port", type=int, default=8080, help="HTTP port (default: 8080)")
    parser.add_argument("--debug", action="store_true", help="Enable Flask debug mode")
    args = parser.parse_args()

    create_app(udp_port=args.udp_port)
    app.run(host="0.0.0.0", port=args.http_port, debug=args.debug, use_reloader=False)

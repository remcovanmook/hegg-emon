"""
dashboard.app
=============

Flask dashboard for the Hegg energy monitor.

Reads exclusively from the shared SQLite store written by ``hegg_collector``.
No UDP socket, no listener threads — this process is a pure consumer.

SSE implementation
------------------
``/stream`` polls the SQLite store for rows newer than the last-seen
timestamp, sleeping 1 s between polls.  The most recent stored row is sent
immediately on connect so the browser has data without waiting for the next
poll cycle.

Routes
------

GET /
    Dashboard HTML page.
GET /stream
    SSE stream; ``data:`` events are JSON-encoded reading dicts.
GET /api/latest
    Most recent 1-second reading as JSON, or 204.
GET /api/summary/latest
    Most recent minute-summary packet as JSON, or 204.
GET /api/summary/delta
    Cumulative energy/gas delta for a time window.
    Query param: ``hours`` (default 24).
GET /api/history
    Bucketed readings.  Query params: ``hours`` (1-168), ``bucket`` (seconds).
GET /api/device
    Device identity: IP, serial, model, SW version, WiFi RSSI.
GET /api/events
    Recent unknown/raw event packets (debug).
"""

import json
import logging
import time
import threading
from datetime import datetime, timedelta, timezone
from typing import Iterator, Optional

from flask import Flask, Response, jsonify, make_response, send_from_directory, request

from hegg.store import HeggStore, default_db_path

logger = logging.getLogger(__name__)

app = Flask(__name__)
app.config["TEMPLATES_AUTO_RELOAD"] = True

# ---------------------------------------------------------------------------
# Shared state — store is set by create_app()
# ---------------------------------------------------------------------------

_store: Optional[HeggStore] = None

# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@app.route("/", methods=["GET"])
def index() -> Response:
    """Render the main dashboard page."""
    return send_from_directory("static", "dashboard.html")


@app.route("/api/latest", methods=["GET"])
def api_latest() -> Response:
    """Return the most recent 1-second reading as JSON, or 204 if none yet."""
    if _store is None:
        return Response(status=503)
    reading = _store.latest_reading()
    if reading is None:
        return Response(status=204)
    return jsonify(reading.to_dict())


@app.route("/api/summary/latest", methods=["GET"])
def api_summary_latest() -> Response:
    """Return the most recent minute-summary packet, or 204."""
    if _store is None:
        return Response(status=503)
    summary = _store.latest_summary()
    if not summary:
        return Response(status=204)
    return jsonify(summary)


@app.route("/api/device", methods=["GET"])
def api_device() -> Response:
    """Return device identity: IP from the store, serial/model from the latest summary.

    The device IP is stored in the summaries table; the most recent summary
    packet is the source of truth for hardware metadata.
    """
    info: dict = {}
    if _store is not None:
        s = _store.latest_summary()
        info["ip"]        = s.get("ip")
        info["serial"]    = s.get("serial")
        info["model"]     = s.get("model")
        info["swVersion"] = s.get("swVersion")
        info["wifiRSSI"]  = s.get("wifiRSSI")
    return jsonify(info)


@app.route("/api/prices", methods=["GET"])
def api_prices() -> Response:
    """Return EPEX spot price entries for the last *hours* hours and all future data in the DB.

    Query parameters:
        hours: Historical look-back in hours (default 24).

    Each entry has ``ts_start`` (Unix ms), ``ts_end`` (Unix ms),
    ``price_eur_kwh`` (raw EPEX spot, no VAT/fees), and ``price_origin``
    (``"actual"`` or ``"forecast"``).  Returns 204 when no data is stored.
    """
    if _store is None:
        return Response(status=204)
    hours = int(request.args.get("hours", 24))
    rows = _store.prices_window(hours=hours)
    if not rows:
        return Response(status=204)
    return jsonify(rows)


@app.route("/api/summary/hourly", methods=["GET"])
def api_summary_hourly() -> Response:
    """Return per-hour energy and gas consumption deltas.

    Computes the delta between consecutive hour-boundary summary rows so the
    frontend receives per-hour consumption rather than cumulative totals.

    Query parameters:
        hours: Historical window in hours (default 24).

    Each entry has ``ts`` (hour start, Unix ms) and per-tariff deltas for
    ``energy_delivered_tariff1/2``, ``energy_returned_tariff1/2``, and
    ``gas_delivered``.  Returns 204 when no data is available.
    """
    if _store is None:
        return Response(status=204)
    hours = int(request.args.get("hours", 24))
    rows = _store.hourly_consumption(hours=hours)
    if not rows:
        return Response(status=204)
    return jsonify(rows)


@app.route("/api/events", methods=["GET"])
def api_events() -> Response:
    """Return recent unknown/raw event packets, newest first (debug endpoint)."""
    if _store is None:
        return jsonify([])
    limit = int(request.args.get("limit", 20))
    return jsonify(_store.query_events(limit=limit))


@app.route("/api/summary/delta", methods=["GET"])
def api_summary_delta() -> Response:
    """Return cumulative energy/gas deltas for a time window.

    Query parameters:
        hours (int): Look-back window in hours.  Defaults to 24.

    Returns:
        JSON dict with per-tariff delivered/returned and gas fields, or 204.
    """
    if _store is None:
        return Response(status=503)
    hours = int(request.args.get("hours", 24))
    delta = _store.summary_delta(hours=hours)
    if not delta:
        return Response(status=204)
    return jsonify(delta)


@app.route("/api/history", methods=["GET"])
def api_history() -> Response:
    """Return bucketed historical readings.

    Query parameters:
        hours  (int, 1-168): Time window.  Default 24.
        bucket (int):        Bucket width in seconds.  Default: auto (~500 pts).

    Returns:
        JSON array of averaged reading dicts, or 503 if the store is not ready.
    """
    if _store is None:
        return make_response(jsonify({"error": "store not initialised"}), 503)

    hours = max(1, min(int(request.args.get("hours", 24)), 168))
    auto_bucket = max(10, (hours * 3600) // 500)
    bucket = int(request.args.get("bucket", auto_bucket))

    since = datetime.now(timezone.utc) - timedelta(hours=hours)
    return jsonify(_store.query(since, bucket_seconds=bucket))


@app.route("/stream", methods=["GET"])
def stream() -> Response:
    """SSE endpoint — tails the SQLite store for new rows.

    On connect, sends the most recent stored reading immediately (if any),
    then polls once per second for rows newer than the last-seen timestamp.
    Each event is a JSON-encoded reading dict.
    """
    if _store is None:
        return Response(": store not ready\n\n", mimetype="text/event-stream")

    def generate() -> Iterator[str]:
        since_ms = int(time.time() * 1000) - 2000

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
                yield ": keep-alive\n\n"

    return Response(
        generate(),
        mimetype="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )

# ---------------------------------------------------------------------------
# Application factory
# ---------------------------------------------------------------------------

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


def create_app(db_path: str = "") -> Flask:
    """Initialise the store and return the configured Flask app.

    Starts one background thread (prune loop).  The UDP collector is a
    separate process (``hegg_collector.py``) and must be running for live
    data to appear.

    Args:
        db_path: Path to the shared SQLite database file.  Resolved via
                 :func:`~hegg.store.default_db_path` if not provided.

    Returns:
        Configured :class:`flask.Flask` instance.
    """
    global _store
    _store = HeggStore(path=db_path or default_db_path())

    threading.Thread(
        target=_prune_loop,
        args=(_store,),
        daemon=True,
        name="hegg-prune",
    ).start()

    return app


if __name__ == "__main__":
    import argparse
    logging.basicConfig(level=logging.INFO)
    p = argparse.ArgumentParser(description="Hegg dashboard server")
    p.add_argument("--http-port", type=int, default=8080)
    p.add_argument("--db", default=default_db_path())
    p.add_argument("--host",       default="0.0.0.0",
                   help="Interface to bind (default: 0.0.0.0)")
    p.add_argument("--debug", action="store_true")
    args = p.parse_args()
    create_app(db_path=args.db)
    app.run(host=args.host, port=args.http_port, debug=args.debug,
            use_reloader=False, threaded=True)

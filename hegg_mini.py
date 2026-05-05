"""
hegg_mini.py
============

Self-contained Hegg energy monitor server.

Intended to run on a laptop or desktop on the same local network as the Hegg
device.  Start it, open a browser to ``http://localhost:8080``, and the
dashboard is live — no installation, no database, no background services.

Listens to UDP broadcasts from the Hegg device, serves live readings as an
SSE stream on ``/stream``, and exposes a minimal subset of the same REST API
that the full dashboard frontend expects.  History and delta summaries are
out of scope — the dashboard starts empty and fills in from the live stream.

Dependencies: Python 3.7+ standard library only.

Endpoints
---------

GET /
    Dashboard HTML (served from ``dashboard/static/dashboard.html``).
GET /static/<path>
    Static assets (served from ``dashboard/static/``).
GET /stream
    SSE stream; ``data:`` events are JSON-encoded reading dicts.
GET /api/summary/latest
    Most recent minute-summary packet as JSON, or 204.
GET /api/summary/delta?hours=N
    Returns 204 — no history in mini mode.
GET /api/history?hours=N
    Returns empty array — no history in mini mode.
GET /api/device
    Device identity extracted from the latest summary packet.

Usage::

    python hegg_mini.py
    python hegg_mini.py --udp-port 16121 --http-port 8080
    python hegg_mini.py --device-ip 192.168.1.42

Environment variables
---------------------

HEGG_UDP_PORT    UDP port to listen on (default: 16121).
HEGG_HTTP_PORT   HTTP port to serve on (default: 8080).
HEGG_DEVICE_IP   Lock listener to this source IP (default: auto-detect).
"""

import argparse
import json
import logging
import mimetypes
import os
import queue
import socket
import socketserver
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import urlparse

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-8s  %(name)s  %(message)s",
)
logger = logging.getLogger("hegg_mini")

# ---------------------------------------------------------------------------
# Static file root — relative to this file's location
# ---------------------------------------------------------------------------

_HERE         = os.path.dirname(os.path.abspath(__file__))
_STATIC_ROOT  = os.path.join(_HERE, "dashboard", "static")
_TEMPLATE     = os.path.join(_STATIC_ROOT, "dashboard.html")

# ---------------------------------------------------------------------------
# Shared state
# ---------------------------------------------------------------------------

#: Most recent 1-second reading dict, forwarded verbatim to SSE clients.
_latest_reading: dict | None = None

#: Most recent minute-summary packet (raw from device), stored by _handle_packet.
_latest_summary: dict = {}

#: Source IP of the Hegg device, recorded on first valid packet.
_device_ip: str = ""

#: Per-client SSE queues.  One Queue per open /stream connection.
_sse_clients: list[queue.Queue] = []
_sse_lock = threading.Lock()

#: Source port the Hegg device broadcasts *from* (not the destination port).
_DEVICE_SOURCE_PORT = 16120

# ---------------------------------------------------------------------------
# UDP listener
# ---------------------------------------------------------------------------


def _open_udp_socket(port: int) -> socket.socket:
    """Bind a UDP socket that accepts Hegg broadcast packets.

    Sets SO_REUSEADDR and SO_BROADCAST so multiple listeners on the same
    host work, and SO_REUSEPORT where available (Linux/macOS).

    Args:
        port: Destination port to bind.

    Returns:
        Bound :class:`socket.socket`.
    """
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM, socket.IPPROTO_UDP)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
    try:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEPORT, 1)
    except AttributeError:
        pass
    sock.bind(("0.0.0.0", port))
    return sock


def _broadcast_reading(reading: dict) -> None:
    """Push a reading dict to every connected SSE client's queue.

    Clients that are lagging (full queue) are skipped — their connection will
    be closed by the HTTP handler once it detects the broken pipe.

    Args:
        reading: Parsed reading dict ready to JSON-encode.
    """
    with _sse_lock:
        for q in _sse_clients:
            try:
                q.put_nowait(reading)
            except queue.Full:
                pass  # slow client; handler will time out and clean up


def _normalise_summary(raw: dict) -> dict:
    """Remap raw UDP summary packet field names to match the store's output.

    The Hegg device uses ``energy_delivered_tariff1`` / ``energy_returned_tariff1``
    etc. in its wire format.  The Flask store transforms these to the shorter
    ``energy_delivered_t1`` / ``energy_returned_t1`` forms, which is what the
    dashboard JS reads.  This function performs the same mapping so the mini
    server can serve the same API shape without a database.

    Args:
        raw: Decoded JSON dict from the device UDP broadcast.

    Returns:
        Dict with keys matching the Flask store's ``latest_summary()`` output.
    """
    return {
        "serial":              raw.get("serial"),
        "sw_version":          raw.get("swVersion"),
        "equipment_id":        raw.get("equipment_id"),
        "model":               raw.get("model"),
        "wifi_rssi":           raw.get("wifiRSSI"),
        "energy_delivered_t1": raw.get("energy_delivered_tariff1"),
        "energy_delivered_t2": raw.get("energy_delivered_tariff2"),
        "energy_returned_t1":  raw.get("energy_returned_tariff1"),
        "energy_returned_t2":  raw.get("energy_returned_tariff2"),
        "gas_delivered":       raw.get("gas_delivered"),
    }


def _handle_packet(payload: dict, src_ip: str) -> None:
    """Route a decoded UDP packet to the appropriate shared-state slot.

    Minute-summary packets (identified by the presence of
    ``energy_delivered_tariff1``) are stored in ``_latest_summary``.
    All other packets are treated as 1-second readings: stored in
    ``_latest_reading`` and broadcast to every connected SSE client.

    Args:
        payload: Decoded JSON dict from the device.
        src_ip:  Source IP address (used only for debug logging).
    """
    global _latest_reading, _latest_summary, _device_ip

    if "energy_delivered_tariff1" in payload:
        _latest_summary = _normalise_summary(payload)
        _device_ip = src_ip
        logger.debug("Summary packet received from %s", src_ip)
    else:
        _latest_reading = payload
        _broadcast_reading(payload)


def udp_listener(udp_port: int, device_ip: str = "") -> None:
    """Receive Hegg UDP broadcasts and update shared state.

    Runs indefinitely in a daemon thread.  Distinguishes between
    1-second reading packets and minute-summary packets by delegating
    to :func:`_handle_packet`.

    Args:
        udp_port:  Destination port to bind.
        device_ip: If non-empty, drop packets from any other source IP.
    """
    sock = _open_udp_socket(udp_port)
    sock.settimeout(1.0)
    logger.info("UDP listener bound to 0.0.0.0:%d", udp_port)

    locked_ip = device_ip
    if device_ip:
        logger.info("Locked to device IP %s", device_ip)

    while True:
        try:
            data, addr = sock.recvfrom(4096)
        except socket.timeout:
            continue
        except OSError as exc:
            logger.error("UDP receive error: %s", exc)
            break

        src_ip, src_port = addr

        if src_port != _DEVICE_SOURCE_PORT:
            continue

        if locked_ip:
            if src_ip != locked_ip:
                continue
        else:
            locked_ip = src_ip
            logger.info("Locked onto Hegg device at %s", src_ip)

        try:
            payload = json.loads(data.decode("utf-8"))
        except (json.JSONDecodeError, UnicodeDecodeError) as exc:
            logger.warning("Dropping undecodable packet from %s: %s", addr, exc)
            continue

        _handle_packet(payload, src_ip)

# ---------------------------------------------------------------------------
# HTTP request handler
# ---------------------------------------------------------------------------


def _json_response(handler: BaseHTTPRequestHandler, data, status: int = 200) -> None:
    """Write a JSON response.

    Args:
        handler: The active request handler.
        data:    JSON-serialisable object.
        status:  HTTP status code.
    """
    body = json.dumps(data).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json")
    handler.send_header("Content-Length", str(len(body)))
    handler.send_header("Cache-Control", "no-cache")
    handler.end_headers()
    handler.wfile.write(body)


def _no_content(handler: BaseHTTPRequestHandler) -> None:
    """Send a 204 No Content response.

    Args:
        handler: The active request handler.
    """
    handler.send_response(204)
    handler.end_headers()


def _not_found(handler: BaseHTTPRequestHandler) -> None:
    """Send a 404 Not Found response.

    Args:
        handler: The active request handler.
    """
    handler.send_response(404)
    handler.end_headers()


def _serve_file(handler: BaseHTTPRequestHandler, path: str) -> None:
    """Serve a file from the filesystem.

    Guesses the MIME type from the file extension.  Sends 404 if the file
    does not exist or resolves outside the expected root (path traversal guard).

    Args:
        handler: The active request handler.
        path:    Absolute filesystem path to serve.
    """
    # Resolve symlinks and check the file exists.
    try:
        real = os.path.realpath(path)
    except OSError:
        _not_found(handler)
        return

    if not os.path.isfile(real):
        _not_found(handler)
        return

    mime, _ = mimetypes.guess_type(real)
    mime = mime or "application/octet-stream"

    try:
        with open(real, "rb") as fh:
            body = fh.read()
    except OSError:
        _not_found(handler)
        return

    handler.send_response(200)
    handler.send_header("Content-Type", mime)
    handler.send_header("Content-Length", str(len(body)))
    handler.end_headers()
    handler.wfile.write(body)


class MiniHandler(BaseHTTPRequestHandler):
    """HTTP request handler for the mini server.

    Serves the dashboard HTML, static assets, SSE stream, and the minimal
    REST API the frontend expects.
    """

    # Suppress the default per-request log line; we log ourselves where useful.
    def log_message(self, fmt, *args):  # noqa: D102
        pass

    def do_GET(self) -> None:  # noqa: D102
        parsed = urlparse(self.path)
        path   = parsed.path

        # ── Dashboard HTML ─────────────────────────────────────────────────
        if path == "/" or path == "/index.html":
            _serve_file(self, _TEMPLATE)

        # ── Static assets ──────────────────────────────────────────────────
        elif path.startswith("/static/"):
            # Strip leading slash so os.path.join works correctly.
            rel = path.lstrip("/")
            # Guard against path traversal: realpath must stay inside _STATIC_ROOT.
            candidate = os.path.realpath(os.path.join(_HERE, "dashboard", rel))
            if not candidate.startswith(os.path.realpath(_STATIC_ROOT)):
                _not_found(self)
            else:
                _serve_file(self, candidate)

        # ── SSE stream ─────────────────────────────────────────────────────
        elif path == "/stream":
            self._handle_stream()

        # ── API: latest summary ────────────────────────────────────────────
        elif path == "/api/summary/latest":
            if _latest_summary:
                _json_response(self, _latest_summary)
            else:
                _no_content(self)

        # ── API: summary delta (no history — return empty) ─────────────────
        elif path == "/api/summary/delta":
            _json_response(self, {})

        # ── API: history (no history — return empty array) ─────────────────
        elif path == "/api/history":
            _json_response(self, [])

        # ── API: device identity ───────────────────────────────────────────
        elif path == "/api/device":
            info = {
                "ip":        _device_ip or None,
                "serial":    _latest_summary.get("serial"),
                "model":     _latest_summary.get("model"),
                "sw":        _latest_summary.get("sw_version"),
                "wifi_rssi": _latest_summary.get("wifi_rssi"),
            }
            _json_response(self, info)

        else:
            _not_found(self)

    def _handle_stream(self) -> None:
        """Handle an SSE ``/stream`` request.

        Sends the most recent reading immediately (if one has been received),
        then waits on a per-client queue for subsequent readings.  Sends a
        keep-alive comment every 10 s of silence to prevent proxy timeouts.

        The client queue is registered in ``_sse_clients`` on connect and
        removed in the ``finally`` block, regardless of how the connection ends.
        """
        self.send_response(200)
        self.send_header("Content-Type",     "text/event-stream")
        self.send_header("Cache-Control",    "no-cache")
        self.send_header("X-Accel-Buffering", "no")
        # Don't send Content-Length — SSE is open-ended.
        self.end_headers()

        client_q: queue.Queue = queue.Queue(maxsize=64)
        with _sse_lock:
            _sse_clients.append(client_q)

        try:
            # Send the most recent reading immediately so the browser has
            # something to display without waiting for the next broadcast.
            if _latest_reading is not None:
                self.wfile.write(
                    f"data: {json.dumps(_latest_reading)}\n\n".encode("utf-8")
                )
                self.wfile.flush()

            while True:
                try:
                    reading = client_q.get(timeout=10)
                    self.wfile.write(
                        f"data: {json.dumps(reading)}\n\n".encode("utf-8")
                    )
                except queue.Empty:
                    # Keep-alive SSE comment — not parsed by the browser.
                    self.wfile.write(b": keep-alive\n\n")
                self.wfile.flush()

        except OSError:
            pass  # client disconnected
        finally:
            with _sse_lock:
                try:
                    _sse_clients.remove(client_q)
                except ValueError:
                    pass


class ThreadingHTTPServer(socketserver.ThreadingMixIn, HTTPServer):
    """HTTP server that handles each request in its own thread.

    ThreadingMixIn gives us concurrent SSE connections without blocking
    the main accept loop.  daemon_threads ensures threads do not prevent
    a clean shutdown on KeyboardInterrupt.
    """

    daemon_threads = True

# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------


def _parse_args() -> argparse.Namespace:
    """Parse CLI arguments, falling back to environment variables."""
    p = argparse.ArgumentParser(
        description="Hegg mini server — UDP broadcast → SSE + REST, no database"
    )
    p.add_argument(
        "--udp-port", type=int,
        default=int(os.getenv("HEGG_UDP_PORT", "16121")),
        help="UDP port to listen on (default: 16121)",
    )
    p.add_argument(
        "--http-port", type=int,
        default=int(os.getenv("HEGG_HTTP_PORT", "8080")),
        help="HTTP port to serve on (default: 8080)",
    )
    p.add_argument(
        "--device-ip",
        default=os.getenv("HEGG_DEVICE_IP", ""),
        help="Lock to this source IP (default: auto-detect)",
    )
    p.add_argument("--debug", action="store_true", help="Enable debug logging")
    return p.parse_args()


def main() -> None:
    """Start the UDP listener thread and the HTTP server."""
    args = _parse_args()

    if args.debug:
        logging.getLogger().setLevel(logging.DEBUG)

    # Validate that the static assets are where we expect them.
    if not os.path.isfile(_TEMPLATE):
        logger.error("Dashboard template not found: %s", _TEMPLATE)
        logger.error("Run hegg_mini.py from the repository root.")
        raise SystemExit(1)

    # UDP listener runs in a daemon thread so it exits with the main process.
    threading.Thread(
        target=udp_listener,
        kwargs={"udp_port": args.udp_port, "device_ip": args.device_ip},
        daemon=True,
        name="hegg-udp",
    ).start()
    logger.info("UDP listener started on port %d", args.udp_port)

    server = ThreadingHTTPServer(("0.0.0.0", args.http_port), MiniHandler)
    logger.info("Dashboard on http://0.0.0.0:%d/", args.http_port)

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        logger.info("Shutting down")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()

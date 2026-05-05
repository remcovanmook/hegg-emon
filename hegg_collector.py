"""
hegg_collector.py
=================

UDP → SQLite ingestion pipeline.

Binds to the Hegg device broadcast port and writes every packet to the
shared SQLite database.  This is the only process that touches the UDP
socket.  All other consumers (dashboard, Prometheus, MQTT) read from
SQLite.

Usage::

    python hegg_collector.py
    python hegg_collector.py --device-ip 192.168.1.42
    python hegg_collector.py --db /var/lib/hegg/hegg.db --udp-port 16121

Environment variables
---------------------

HEGG_UDP_PORT   UDP port to listen on (default: 16121)
HEGG_DEVICE_IP  Lock to this source IP (default: auto-detect)
HEGG_DB         Path to the SQLite database file (default: hegg.db)
"""

import argparse
import json
import logging
import os
import socket

from hegg.reading import HeggReading
from hegg.store import HeggStore

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-8s  %(name)s  %(message)s",
)
logger = logging.getLogger("hegg_collector")

#: Source port the Hegg device broadcasts from.
_DEVICE_SOURCE_PORT: int = 16120


def run(udp_port: int, db_path: str, device_ip: str = "") -> None:
    """Receive Hegg UDP broadcasts and write every packet to SQLite.

    Runs indefinitely until interrupted.  Locks onto the source IP of the
    first valid packet, or the pre-configured *device_ip*.

    Args:
        udp_port:  UDP destination port to bind (default 16121).
        db_path:   Path to the SQLite database file.
        device_ip: Lock to this source IP immediately.  Auto-detects from
                   the first seen packet if empty.
    """
    store = HeggStore(path=db_path)

    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM, socket.IPPROTO_UDP)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
    try:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEPORT, 1)
    except AttributeError:
        pass  # SO_REUSEPORT not available on all platforms
    sock.bind(("0.0.0.0", udp_port))
    sock.settimeout(1.0)
    logger.info("Bound UDP socket to 0.0.0.0:%d", udp_port)

    locked_ip: str = device_ip
    if device_ip:
        logger.info("Locked to device IP %s", device_ip)

    try:
        while True:
            try:
                data, addr = sock.recvfrom(4096)
            except socket.timeout:
                continue

            src_ip, src_port = addr

            # Ignore traffic that did not originate from the device port.
            if src_port != _DEVICE_SOURCE_PORT:
                continue

            # Lock onto the first seen device, or enforce the configured IP.
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

            # Minute-summary packet (contains cumulative energy totals).
            if "energy_delivered_tariff1" in payload:
                try:
                    store.insert_summary(payload)
                except Exception:
                    logger.exception("Summary insert failed")
                continue

            # Standard 1-second reading.
            try:
                reading = HeggReading.from_dict(payload)
                store.insert(reading)
            except (KeyError, ValueError):
                logger.info(
                    "Unknown packet structure from %s — fields: %s",
                    src_ip, sorted(payload.keys()),
                )
                try:
                    store.insert_event(payload)
                except Exception:
                    pass

    finally:
        sock.close()
        logger.info("UDP socket closed")


def _parse_args() -> argparse.Namespace:
    """Parse CLI arguments, falling back to environment variables."""
    p = argparse.ArgumentParser(
        description="Hegg UDP → SQLite collector"
    )
    p.add_argument(
        "--udp-port", type=int,
        default=int(os.getenv("HEGG_UDP_PORT", "16121")),
        help="UDP port to listen on (default: 16121)",
    )
    p.add_argument(
        "--device-ip",
        default=os.getenv("HEGG_DEVICE_IP", ""),
        help="Lock to this source IP (default: auto-detect)",
    )
    p.add_argument(
        "--db",
        default=os.getenv("HEGG_DB", "hegg.db"),
        help="Path to the SQLite database (default: hegg.db)",
    )
    p.add_argument("--debug", action="store_true")
    return p.parse_args()


if __name__ == "__main__":
    args = _parse_args()
    if args.debug:
        logging.getLogger().setLevel(logging.DEBUG)
    try:
        run(udp_port=args.udp_port, db_path=args.db, device_ip=args.device_ip)
    except KeyboardInterrupt:
        logger.info("Shutting down")

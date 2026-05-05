#!/usr/bin/env python3
"""
udp_test.py — standalone UDP reception diagnostic.

Binds to port 16121 and prints every packet received.
Run this independently to verify the Hegg device is reachable
before starting the full server.

Usage::

    python udp_test.py
    python udp_test.py --port 16121
"""

import argparse
import json
import socket
import sys


def main() -> None:
    p = argparse.ArgumentParser(description="Hegg UDP reception test")
    p.add_argument("--port", type=int, default=16121)
    args = p.parse_args()

    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM, socket.IPPROTO_UDP)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
    try:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEPORT, 1)
    except AttributeError:
        pass  # SO_REUSEPORT not available on all platforms

    sock.bind(("0.0.0.0", args.port))
    print(f"Listening on UDP 0.0.0.0:{args.port} — waiting for Hegg broadcasts…", flush=True)
    print("(Ctrl-C to stop)\n", flush=True)

    count = 0
    try:
        while True:
            data, addr = sock.recvfrom(4096)
            count += 1
            try:
                payload = json.loads(data.decode("utf-8"))
                print(f"[{count}] {addr[0]}:{addr[1]}  →  {json.dumps(payload, separators=(',', ':'))}")
            except (json.JSONDecodeError, UnicodeDecodeError):
                print(f"[{count}] {addr[0]}:{addr[1]}  →  (raw) {data!r}")
            sys.stdout.flush()
    except KeyboardInterrupt:
        print(f"\nStopped after {count} packet(s).")
    finally:
        sock.close()


if __name__ == "__main__":
    main()

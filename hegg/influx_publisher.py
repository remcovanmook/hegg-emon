"""
hegg.influx_publisher
=====================

InfluxDB publisher for Hegg energy readings.

Writes readings and minute-summaries to InfluxDB using the HTTP write API
and the line protocol format.  Supports both InfluxDB v2 (token auth) and
InfluxDB v1 (database + optional username/password).

No external dependencies — uses only :mod:`urllib.request` from the standard
library.

Line protocol measurements
--------------------------

``hegg_reading`` — written on every 1-second reading.

  Tags:   ``serial``
  Fields: ``power_delivered``, ``power_returned``,
          ``voltage_l1``, ``voltage_l2``, ``voltage_l3``,
          ``current_l1``, ``current_l2``, ``current_l3``

``hegg_summary`` — written on every minute-summary packet.

  Tags:   ``serial``
  Fields: ``energy_delivered_tariff1``, ``energy_delivered_tariff2``,
          ``energy_returned_tariff1``, ``energy_returned_tariff2``,
          ``gas_delivered``, ``wifiRSSI``
"""

import logging
import urllib.error
import urllib.parse
import urllib.request
from typing import Optional

from hegg.reading import HeggReading

logger = logging.getLogger(__name__)


def _escape_tag(value: str) -> str:
    """Escape a tag value for InfluxDB line protocol.

    Commas, spaces, and equals signs must be escaped with a backslash.

    Args:
        value: Raw tag value string.

    Returns:
        Escaped string safe for use in InfluxDB line protocol tags.
    """
    return value.replace(",", r"\,").replace(" ", r"\ ").replace("=", r"\=")


class InfluxPublisher:
    """Write Hegg readings and summaries to InfluxDB via HTTP.

    Supports InfluxDB v2 (token auth via ``Authorization: Token …`` header)
    and InfluxDB v1 (``/write?db=…`` endpoint with optional HTTP Basic auth).

    Args:
        url:      Base URL of the InfluxDB instance, e.g. ``http://localhost:8086``.
        token:    InfluxDB v2 API token.  If set, uses the v2 ``/api/v2/write`` endpoint.
        org:      InfluxDB v2 organisation name.  Required when *token* is set.
        bucket:   InfluxDB v2 bucket name.  Required when *token* is set.
        database: InfluxDB v1 database name.  Used when *token* is absent.
        username: InfluxDB v1 username (optional).
        password: InfluxDB v1 password (optional).
        timeout:  Request timeout in seconds (default: 5).
    """

    def __init__(
        self,
        url: str,
        token: Optional[str] = None,
        org: Optional[str] = None,
        bucket: Optional[str] = None,
        database: Optional[str] = None,
        username: Optional[str] = None,
        password: Optional[str] = None,
        timeout: float = 5.0,
    ) -> None:
        self._timeout = timeout

        if token:
            # InfluxDB v2
            params = urllib.parse.urlencode({"org": org, "bucket": bucket, "precision": "ns"})
            self._write_url = f"{url.rstrip('/')}/api/v2/write?{params}"
            self._headers = {
                "Authorization": f"Token {token}",
                "Content-Type": "text/plain; charset=utf-8",
            }
        else:
            # InfluxDB v1
            params = urllib.parse.urlencode({"db": database, "precision": "ns"})
            self._write_url = f"{url.rstrip('/')}/write?{params}"
            self._headers = {"Content-Type": "text/plain; charset=utf-8"}
            if username and password:
                import base64
                creds = base64.b64encode(f"{username}:{password}".encode()).decode()
                self._headers["Authorization"] = f"Basic {creds}"

    def _post(self, lines: str) -> bool:
        """Send line protocol data to the InfluxDB write endpoint.

        Args:
            lines: One or more newline-separated line protocol strings.

        Returns:
            ``True`` on HTTP 2xx, ``False`` otherwise.
        """
        data = lines.encode("utf-8")
        req = urllib.request.Request(self._write_url, data=data, headers=self._headers, method="POST")
        try:
            with urllib.request.urlopen(req, timeout=self._timeout) as resp:
                ok = 200 <= resp.status < 300
                if not ok:
                    logger.warning("InfluxDB write returned HTTP %d", resp.status)
                return ok
        except urllib.error.URLError as exc:
            logger.warning("InfluxDB write failed: %s", exc)
            return False

    def publish(self, reading: HeggReading) -> bool:
        """Write a single 1-second reading to the ``hegg_reading`` measurement.

        Args:
            reading: The reading to publish.

        Returns:
            ``True`` on success, ``False`` on HTTP or network error.
        """
        serial = _escape_tag(reading.serial)
        ts_ns = int(reading.timestamp.timestamp() * 1_000_000_000)
        line = (
            f"hegg_reading,serial={serial} "
            f"power_delivered={reading.power_delivered},"
            f"power_returned={reading.power_returned},"
            f"voltage_l1={reading.voltage_l1},"
            f"voltage_l2={reading.voltage_l2},"
            f"voltage_l3={reading.voltage_l3},"
            f"current_l1={reading.current_l1},"
            f"current_l2={reading.current_l2},"
            f"current_l3={reading.current_l3} "
            f"{ts_ns}"
        )
        logger.debug("InfluxDB write: %s", line)
        return self._post(line)

    def publish_summary(self, summary: dict) -> bool:
        """Write a minute-summary to the ``hegg_summary`` measurement.

        Silently returns ``True`` and does nothing if *summary* is empty or
        contains no numeric fields.

        Args:
            summary: Dict as returned by :meth:`~hegg.store.HeggStore.latest_summary`.

        Returns:
            ``True`` on success or if there is nothing to write, ``False`` on
            HTTP or network error.
        """
        if not summary:
            return True

        serial = _escape_tag(str(summary.get("serial", "unknown")))
        ts_raw = summary.get("ts")
        ts_ns = int(ts_raw * 1_000_000) if ts_raw else 0  # ts is stored as Unix ms

        fields = {}
        for key in ("energy_delivered_tariff1", "energy_delivered_tariff2",
                    "energy_returned_tariff1",  "energy_returned_tariff2",
                    "gas_delivered", "wifiRSSI"):
            val = summary.get(key)
            if val is not None:
                fields[key] = val

        if not fields:
            return True

        field_str = ",".join(f"{k}={v}" for k, v in fields.items())
        line = f"hegg_summary,serial={serial} {field_str} {ts_ns}"
        logger.debug("InfluxDB summary write: %s", line)
        return self._post(line)

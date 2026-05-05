"""
hegg.webhook_publisher
======================

HTTP webhook publisher for Hegg energy readings.

On each call to :meth:`WebhookPublisher.publish` the reading is serialised
as JSON and sent via HTTP POST to a configured URL.  No external dependencies
are required — the implementation uses only :mod:`urllib.request` from the
standard library.

Any HTTP 2xx response is treated as success.  Non-2xx responses and network
errors are logged at WARNING level; the caller decides whether to retry.
"""

import json
import logging
import urllib.error
import urllib.request
from typing import Optional

from hegg.reading import HeggReading

logger = logging.getLogger(__name__)


class WebhookPublisher:
    """POST Hegg readings as JSON to an HTTP endpoint.

    Args:
        url:     Full URL to POST to (must include scheme, e.g. ``https://``).
        headers: Additional HTTP headers sent with every request.  Useful for
                 authentication tokens (e.g. ``{"Authorization": "Bearer …"}``).
        timeout: Request timeout in seconds (default: 5).
    """

    def __init__(
        self,
        url: str,
        headers: Optional[dict] = None,
        timeout: float = 5.0,
    ) -> None:
        self._url = url
        self._headers: dict = {"Content-Type": "application/json"}
        if headers:
            self._headers.update(headers)
        self._timeout = timeout

    def publish(self, reading: HeggReading) -> bool:
        """POST a single reading as JSON.

        Args:
            reading: The reading to publish.

        Returns:
            ``True`` if the server responded with a 2xx status, ``False``
            otherwise.  Network errors are caught and logged.
        """
        payload = json.dumps(reading.to_dict()).encode("utf-8")
        req = urllib.request.Request(self._url, data=payload, headers=self._headers, method="POST")
        try:
            with urllib.request.urlopen(req, timeout=self._timeout) as resp:
                ok = 200 <= resp.status < 300
                if not ok:
                    logger.warning("Webhook POST to %s returned HTTP %d", self._url, resp.status)
                else:
                    logger.debug("Webhook POST OK (HTTP %d)", resp.status)
                return ok
        except urllib.error.URLError as exc:
            logger.warning("Webhook POST to %s failed: %s", self._url, exc)
            return False

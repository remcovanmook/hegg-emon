"""
tests/test_webhook_publisher.py
================================

Unit tests for :class:`hegg.webhook_publisher.WebhookPublisher`.

Uses :mod:`unittest.mock` to intercept ``urllib.request.urlopen`` so no
real HTTP connections are made.
"""

from unittest.mock import MagicMock, patch
from hegg.webhook_publisher import WebhookPublisher
from hegg.reading import HeggReading
from tests.test_reading import SAMPLE_JSON


def _make_reading() -> HeggReading:
    return HeggReading.from_dict(SAMPLE_JSON)


def _mock_response(status: int = 200):
    resp = MagicMock()
    resp.status = status
    resp.__enter__ = lambda s: s
    resp.__exit__ = MagicMock(return_value=False)
    return resp


class TestWebhookPublisher:
    def test_publish_posts_json(self):
        """publish() calls urlopen with a POST request containing JSON."""
        reading = _make_reading()
        publisher = WebhookPublisher(url="http://example.com/hook")

        with patch("urllib.request.urlopen", return_value=_mock_response(200)) as mock_open:
            result = publisher.publish(reading)

        assert result is True
        req = mock_open.call_args[0][0]
        assert req.method == "POST"
        assert req.full_url == "http://example.com/hook"
        assert b"power_delivered" in req.data

    def test_publish_returns_false_on_non_2xx(self):
        """Non-2xx response is treated as failure."""
        publisher = WebhookPublisher(url="http://example.com/hook")
        with patch("urllib.request.urlopen", return_value=_mock_response(500)):
            result = publisher.publish(_make_reading())
        assert result is False

    def test_publish_returns_false_on_network_error(self):
        """Network errors are caught and logged; publish() returns False."""
        import urllib.error
        publisher = WebhookPublisher(url="http://example.com/hook")
        with patch("urllib.request.urlopen", side_effect=urllib.error.URLError("refused")):
            result = publisher.publish(_make_reading())
        assert result is False

    def test_custom_headers_are_sent(self):
        """Extra headers provided at construction are included in the request."""
        publisher = WebhookPublisher(
            url="http://example.com/hook",
            headers={"Authorization": "Bearer token123"},
        )
        with patch("urllib.request.urlopen", return_value=_mock_response(200)) as mock_open:
            publisher.publish(_make_reading())

        req = mock_open.call_args[0][0]
        assert req.get_header("Authorization") == "Bearer token123"

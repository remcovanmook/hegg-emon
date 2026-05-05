"""
tests/test_influx_publisher.py
================================

Unit tests for :class:`hegg.influx_publisher.InfluxPublisher`.

Uses :mod:`unittest.mock` to intercept ``urllib.request.urlopen`` so no
real HTTP connections are made.
"""

from unittest.mock import MagicMock, patch
from hegg.influx_publisher import InfluxPublisher, _escape_tag
from hegg.reading import HeggReading
from tests.test_reading import SAMPLE_JSON


def _make_reading() -> HeggReading:
    return HeggReading.from_dict(SAMPLE_JSON)


def _mock_response(status: int = 204):
    resp = MagicMock()
    resp.status = status
    resp.__enter__ = lambda s: s
    resp.__exit__ = MagicMock(return_value=False)
    return resp


def _make_v2_publisher() -> InfluxPublisher:
    return InfluxPublisher(
        url="http://localhost:8086",
        token="mytoken",
        org="myorg",
        bucket="hegg",
    )


def _make_v1_publisher() -> InfluxPublisher:
    return InfluxPublisher(
        url="http://localhost:8086",
        database="hegg",
    )


class TestEscapeTag:
    def test_escapes_comma(self):
        assert _escape_tag("a,b") == r"a\,b"

    def test_escapes_space(self):
        assert _escape_tag("a b") == r"a\ b"

    def test_escapes_equals(self):
        assert _escape_tag("a=b") == r"a\=b"

    def test_plain_value_unchanged(self):
        assert _escape_tag("XYZ123") == "XYZ123"


class TestInfluxPublisherV2:
    def test_publish_posts_line_protocol(self):
        """publish() sends a POST with line protocol body to the v2 write endpoint."""
        pub = _make_v2_publisher()
        with patch("urllib.request.urlopen", return_value=_mock_response(204)) as mock_open:
            result = pub.publish(_make_reading())

        assert result is True
        req = mock_open.call_args[0][0]
        assert "/api/v2/write" in req.full_url
        assert b"hegg_reading" in req.data
        assert b"power_delivered" in req.data

    def test_publish_includes_token_header(self):
        """v2 publisher sets Authorization: Token … header."""
        pub = _make_v2_publisher()
        with patch("urllib.request.urlopen", return_value=_mock_response(204)) as mock_open:
            pub.publish(_make_reading())

        req = mock_open.call_args[0][0]
        assert req.get_header("Authorization") == "Token mytoken"

    def test_publish_returns_false_on_error(self):
        import urllib.error
        pub = _make_v2_publisher()
        with patch("urllib.request.urlopen", side_effect=urllib.error.URLError("refused")):
            assert pub.publish(_make_reading()) is False


class TestInfluxPublisherV1:
    def test_publish_uses_v1_endpoint(self):
        """v1 publisher writes to /write?db=… endpoint."""
        pub = _make_v1_publisher()
        with patch("urllib.request.urlopen", return_value=_mock_response(204)) as mock_open:
            pub.publish(_make_reading())

        req = mock_open.call_args[0][0]
        assert "/write" in req.full_url
        assert "db=hegg" in req.full_url

    def test_basic_auth_header_set(self):
        """v1 publisher with username/password sets Basic auth header."""
        pub = InfluxPublisher(
            url="http://localhost:8086",
            database="hegg",
            username="admin",
            password="secret",
        )
        with patch("urllib.request.urlopen", return_value=_mock_response(204)) as mock_open:
            pub.publish(_make_reading())

        req = mock_open.call_args[0][0]
        assert req.get_header("Authorization").startswith("Basic ")


class TestPublishSummary:
    def test_publish_summary_writes_hegg_summary(self):
        """publish_summary() sends a hegg_summary measurement."""
        pub = _make_v2_publisher()
        summary = {
            "ts":                       1700000000000,
            "serial":                   "TEST01",
            "energy_delivered_tariff1": 100.0,
            "energy_delivered_tariff2": 200.0,
            "energy_returned_tariff1":  10.0,
            "energy_returned_tariff2":  20.0,
            "gas_delivered":            50.0,
            "wifiRSSI":                 -60,
        }
        with patch("urllib.request.urlopen", return_value=_mock_response(204)) as mock_open:
            result = pub.publish_summary(summary)

        assert result is True
        req = mock_open.call_args[0][0]
        assert b"hegg_summary" in req.data
        assert b"energy_delivered_tariff1" in req.data

    def test_publish_summary_empty_returns_true_without_request(self):
        """Empty summary produces no HTTP request and returns True."""
        pub = _make_v2_publisher()
        with patch("urllib.request.urlopen") as mock_open:
            result = pub.publish_summary({})
        assert result is True
        mock_open.assert_not_called()

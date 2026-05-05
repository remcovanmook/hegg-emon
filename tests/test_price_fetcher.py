"""
tests/test_price_fetcher.py
============================

Unit tests for :class:`hegg.price_fetcher.PriceFetcher` and the price
methods on :class:`hegg.store.HeggStore`.

All network calls are intercepted with :mod:`unittest.mock` so no real
HTTP connections are made.
"""

import json
import time
from datetime import datetime, timedelta, timezone
from unittest.mock import MagicMock, patch

import pytest

from hegg.price_fetcher import PriceFetcher, _FETCH_HOUR_UTC


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_api_row(hour_offset: int, price: float, origin: str = "forecast") -> dict:
    """Build a single API response row relative to the current UTC hour."""
    now    = datetime.now(timezone.utc).replace(minute=0, second=0, microsecond=0)
    start  = now + timedelta(hours=hour_offset)
    end    = start + timedelta(hours=1)
    return {
        "start":        start.strftime("%Y-%m-%dT%H:%M:%S.000Z"),
        "end":          end.strftime("%Y-%m-%dT%H:%M:%S.000Z"),
        "price":        price,
        "price_origin": origin,
    }


def _mock_urlopen(rows: list):
    """Return a context-manager mock whose read() returns *rows* as JSON."""
    body = json.dumps(rows).encode("utf-8")
    resp = MagicMock()
    resp.read.return_value = body
    resp.__enter__ = lambda s: s
    resp.__exit__  = MagicMock(return_value=False)
    return resp


# ---------------------------------------------------------------------------
# PriceFetcher._fetch
# ---------------------------------------------------------------------------

class TestPriceFetcherFetch:
    def _fetcher(self):
        store = MagicMock()
        return PriceFetcher(store=store, api_key="testkey", market_zone="NL")

    def test_fetch_returns_normalised_rows(self):
        """_fetch() converts API rows to ts_start/ts_end/price_eur_kwh dicts."""
        rows = [_make_api_row(0, 0.045, "actual"), _make_api_row(1, 0.062, "forecast")]
        fetcher = self._fetcher()
        with patch("urllib.request.urlopen", return_value=_mock_urlopen(rows)):
            result = fetcher._fetch()

        assert len(result) == 2
        assert result[0]["price_eur_kwh"] == pytest.approx(0.045)
        assert result[0]["price_origin"]  == "actual"
        assert result[1]["price_eur_kwh"] == pytest.approx(0.062)
        assert result[1]["price_origin"]  == "forecast"
        # ts_start < ts_end for each row
        assert result[0]["ts_start"] < result[0]["ts_end"]

    def test_fetch_raises_on_non_array_response(self):
        """_fetch() raises ValueError when the API returns a non-array."""
        fetcher = self._fetcher()
        with patch("urllib.request.urlopen", return_value=_mock_urlopen({"error": "bad"})):
            with pytest.raises(ValueError, match="Expected JSON array"):
                fetcher._fetch()

    def test_fetch_includes_market_zone_in_url(self):
        """_fetch() encodes the market_zone query parameter."""
        rows = [_make_api_row(0, 0.05)]
        fetcher = self._fetcher()
        with patch("urllib.request.urlopen", return_value=_mock_urlopen(rows)) as mock_open:
            fetcher._fetch()
        url = mock_open.call_args[0][0].full_url
        assert "market_zone=NL" in url

    def test_fetch_sends_zero_vat_and_fixed_cost(self):
        """_fetch() requests raw spot prices (vat=0, fixed_cost_cent=0)."""
        rows = [_make_api_row(0, 0.05)]
        fetcher = self._fetcher()
        with patch("urllib.request.urlopen", return_value=_mock_urlopen(rows)) as mock_open:
            fetcher._fetch()
        url = mock_open.call_args[0][0].full_url
        assert "vat=0" in url
        assert "fixed_cost_cent=0" in url


# ---------------------------------------------------------------------------
# PriceFetcher._seconds_until_next_fetch
# ---------------------------------------------------------------------------

class TestSecondsUntilNextFetch:
    def test_returns_positive(self):
        secs = PriceFetcher._seconds_until_next_fetch()
        assert 0 < secs <= 86_400

    def test_target_is_14_utc(self):
        """The returned wait puts us within one second of 14:00 UTC tomorrow."""
        secs  = PriceFetcher._seconds_until_next_fetch()
        wake  = datetime.now(timezone.utc) + timedelta(seconds=secs)
        assert wake.hour   == _FETCH_HOUR_UTC
        assert wake.minute == 0
        assert wake.second < 2


# ---------------------------------------------------------------------------
# PriceFetcher.run — startup behaviour
# ---------------------------------------------------------------------------

class TestPriceFetcherRun:
    def test_fetches_on_startup_when_no_current_price(self):
        """run() calls _fetch_and_store() when has_current_prices() is False."""
        store = MagicMock()
        store.has_current_prices.return_value = False
        fetcher = PriceFetcher(store=store, api_key="k")

        # Patch _fetch_and_store to avoid real HTTP and break the while loop.
        call_count = [0]
        def _fake_fetch_and_store():
            call_count[0] += 1
            raise SystemExit(0)  # escape the infinite loop

        fetcher._fetch_and_store = _fake_fetch_and_store
        with pytest.raises(SystemExit):
            fetcher.run()

        assert call_count[0] == 1

    def test_skips_fetch_on_startup_when_prices_current(self):
        """run() skips the startup fetch when has_current_prices() is True."""
        store = MagicMock()
        store.has_current_prices.return_value = True
        fetcher = PriceFetcher(store=store, api_key="k")

        call_count = [0]
        def _fake_wait():
            call_count[0] += 1
            raise SystemExit(0)

        fetcher._seconds_until_next_fetch = staticmethod(lambda: (call_count.__setitem__(0, call_count[0] + 1) or 86400))
        fetcher._fetch_and_store = MagicMock()

        # Prevent infinite loop by raising on the first sleep call.
        with patch("time.sleep", side_effect=SystemExit(0)):
            with pytest.raises(SystemExit):
                fetcher.run()

        fetcher._fetch_and_store.assert_not_called()

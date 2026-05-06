"""
hegg.price_fetcher
==================

Fetches day-ahead hourly electricity prices from the energyforecast.de API
and stores them in the local SQLite ``prices`` table.

Fetch schedule
--------------

*   On startup, checks whether a price entry exists for the current hour.
    If not, fetches immediately.
*   Then schedules one fetch per day at 14:00 UTC.  At that time the EPEX
    day-ahead auction result for the following day is reliably available in
    all supported market zones (NL auction settles at ~13:00 CET; 14:00 UTC
    is 15:00 CET in winter and 16:00 CEST in summer — both safely after the
    publication window).

This keeps API usage to at most two requests on the first day (startup + 14:00)
and exactly one request per subsequent day, well within an API plan's daily
quota.

Wire format
-----------

Endpoint: ``GET /api/v1/predictions/next_48_hours``

Parameters used::

    token=<api_key>
    market_zone=NL
    resolution=HOURLY
    fixed_cost_cent=0   # request raw EPEX spot price
    vat=0               # no VAT mark-up; consumers apply their own

Response: JSON array of ``{start, end, price, price_origin}`` where ``price``
is in EUR/kWh.
"""

import json
import logging
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone

logger = logging.getLogger(__name__)

_API_BASE  = "https://www.energyforecast.de"
_ENDPOINT  = "/api/v1/predictions/next_48_hours"

#: UTC hour at which prices are fetched daily.  14:00 UTC guarantees the
#: day-ahead prices are published regardless of CET/CEST offset.
_FETCH_HOUR_UTC: int = 14


class PriceFetcher:
    """Fetches and stores day-ahead electricity prices from energyforecast.de.

    Intended to run in a daemon thread via :meth:`start`.  On startup it
    checks the DB for a current price entry and fetches only when one is
    absent.  It then sleeps until the next 14:00 UTC and fetches once daily.

    Args:
        store:       :class:`~hegg.store.HeggStore` instance used for persistence.
        api_key:     API token from energyforecast.de.
        market_zone: EPEX bidding zone identifier (default: ``NL``).
    """

    def __init__(self, store, api_key: str, market_zone: str = "NL") -> None:
        self._store       = store
        self._api_key     = api_key
        self._market_zone = market_zone

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _fetch(self) -> list:
        """Call the API and return normalised price rows.

        Requests raw EPEX spot prices by setting ``fixed_cost_cent=0`` and
        ``vat=0``.  Consumers of the data are responsible for applying their
        own tariff markups.

        Returns:
            List of dicts with keys ``ts_start`` (Unix ms), ``ts_end`` (Unix
            ms), ``price_eur_kwh`` (float), ``price_origin`` (str).

        Raises:
            urllib.error.URLError: On any network-level failure.
            ValueError: If the response body is not a valid JSON array or is
                missing required fields.
        """
        params = urllib.parse.urlencode({
            "token":           self._api_key,
            "market_zone":     self._market_zone,
            "resolution":      "HOURLY",
            "fixed_cost_cent": "0",
            "vat":             "0",
        })
        url = f"{_API_BASE}{_ENDPOINT}?{params}"
        req = urllib.request.Request(url, headers={"Accept": "application/json"})
        with urllib.request.urlopen(req, timeout=30) as resp:
            raw = json.loads(resp.read().decode("utf-8"))

        if not isinstance(raw, list):
            raise ValueError(f"Expected JSON array from API, got {type(raw).__name__}")

        rows = []
        for item in raw:
            # The API returns ISO 8601 with a trailing Z.  datetime.fromisoformat
            # accepts Z from Python 3.11+; the replace() call makes this portable.
            start_str = item["start"].rstrip("Z")
            end_str   = item["end"].rstrip("Z")
            start_dt  = datetime.fromisoformat(start_str).replace(tzinfo=timezone.utc)
            end_dt    = datetime.fromisoformat(end_str).replace(tzinfo=timezone.utc)
            rows.append({
                "ts_start":      int(start_dt.timestamp() * 1000),
                "ts_end":        int(end_dt.timestamp() * 1000),
                "price_eur_kwh": float(item["price"]),
                "price_origin":  str(item.get("price_origin", "unknown")),
            })
        return rows

    def _fetch_and_store(self) -> bool:
        """Fetch prices from the API and persist them to the store.

        Returns:
            ``True`` on success, ``False`` if any error was encountered.
        """
        try:
            rows = self._fetch()
            self._store.insert_prices(rows)
            logger.info(
                "Stored %d price entries (market_zone=%s)",
                len(rows), self._market_zone,
            )
            return True
        except urllib.error.HTTPError as exc:
            logger.error("Price fetch HTTP %d: %s", exc.code, exc.reason)
        except urllib.error.URLError as exc:
            logger.error("Price fetch network error: %s", exc.reason)
        except (ValueError, KeyError) as exc:
            logger.error("Price fetch parse error: %s", exc)
        except Exception as exc:
            logger.error("Price fetch unexpected error: %s", exc)
        return False

    @staticmethod
    def _seconds_until_next_fetch() -> float:
        """Return seconds from now until the next 14:00 UTC.

        If 14:00 UTC has already passed today, the result targets 14:00 UTC
        tomorrow.

        Returns:
            Non-negative float number of seconds to sleep.
        """
        now    = datetime.now(timezone.utc)
        target = now.replace(hour=_FETCH_HOUR_UTC, minute=0, second=0, microsecond=0)
        if now >= target:
            target += timedelta(days=1)
        return (target - now).total_seconds()

    # ------------------------------------------------------------------
    # Public interface
    # ------------------------------------------------------------------

    def run(self) -> None:
        """Main fetch loop.  Intended to run in a daemon thread.

        Fetches immediately if the store has no price covering the current
        hour, then waits until the next 14:00 UTC and repeats daily.
        """
        if not self._store.has_current_prices():
            logger.info("No current price in DB — fetching now")
            self._fetch_and_store()
        else:
            logger.info("Current price already in DB — skipping startup fetch")

        while True:
            wait = self._seconds_until_next_fetch()
            logger.debug("Next price fetch in %.0f s (at %02d:00 UTC)", wait, _FETCH_HOUR_UTC)
            threading.Event().wait(wait)
            self._fetch_and_store()

    def start(self) -> threading.Thread:
        """Start the fetch loop in a daemon thread.

        Returns:
            The started :class:`threading.Thread`.
        """
        t = threading.Thread(target=self.run, daemon=True, name="hegg-price-fetcher")
        t.start()
        return t

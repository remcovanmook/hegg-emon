"""
hegg.gas_price_fetcher
======================

Fetches daily day-ahead gas prices (TTF) from the EnergyZero public API
and stores them in the local SQLite ``gas_prices`` table.
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

_API_BASE = "https://api.energyzero.nl/v1/energyprices"

# Day-ahead gas prices usually settle around 15:00 UTC for the next gas day.
_FETCH_HOUR_UTC: int = 15

class GasPriceFetcher:
    """Fetches and stores daily TTF gas prices.

    Intended to run in a daemon thread. Checks for a current price on startup,
    and then schedules one fetch per day at 15:00 UTC.
    """

    def __init__(self, store) -> None:
        self._store = store

    def _fetch(self) -> list:
        now = datetime.now(timezone.utc)
        # Fetch today and tomorrow
        from_date = now.replace(hour=0, minute=0, second=0, microsecond=0)
        till_date = (from_date + timedelta(days=2)).replace(microsecond=999000)

        params = urllib.parse.urlencode({
            "fromDate": from_date.strftime("%Y-%m-%dT%H:%M:%S.000Z"),
            "tillDate": till_date.strftime("%Y-%m-%dT%H:%M:%S.999Z"),
            "interval": "4",
            "usageType": "3",
            "inclBtw": "false",
        })
        url = f"{_API_BASE}?{params}"
        req = urllib.request.Request(url, headers={"Accept": "application/json"})
        
        with urllib.request.urlopen(req, timeout=30) as resp:
            raw = json.loads(resp.read().decode("utf-8"))

        prices = raw.get("Prices", [])
        if not isinstance(prices, list):
            raise ValueError(f"Expected list in Prices, got {type(prices).__name__}")

        rows = []
        for item in prices:
            start_str = item["readingDate"].rstrip("Z")
            # Usually EnergyZero returns naive UTC string
            start_dt = datetime.fromisoformat(start_str).replace(tzinfo=timezone.utc)
            # Gas day is 24 hours
            end_dt = start_dt + timedelta(days=1)
            
            rows.append({
                "ts_start": int(start_dt.timestamp() * 1000),
                "ts_end": int(end_dt.timestamp() * 1000),
                "price_eur_m3": float(item["price"]),
                "price_origin": "actual"
            })
        return rows

    def _fetch_and_store(self) -> bool:
        try:
            rows = self._fetch()
            if rows:
                self._store.insert_gas_prices(rows)
                logger.info("Stored %d gas price entries", len(rows))
            return True
        except Exception as exc:
            logger.error("Gas price fetch error: %s", exc)
        return False

    @staticmethod
    def _seconds_until_next_fetch() -> float:
        now = datetime.now(timezone.utc)
        target = now.replace(hour=_FETCH_HOUR_UTC, minute=0, second=0, microsecond=0)
        if now >= target:
            target += timedelta(days=1)
        return (target - now).total_seconds()

    def run(self) -> None:
        # Check if we have current prices
        if not self._store.has_current_gas_prices():
            logger.info("No current gas price in DB — fetching now")
            self._fetch_and_store()
        else:
            logger.info("Current gas price already in DB — skipping startup fetch")

        while True:
            wait = self._seconds_until_next_fetch()
            logger.debug("Next gas price fetch in %.0f s (at %02d:00 UTC)", wait, _FETCH_HOUR_UTC)
            threading.Event().wait(wait)
            self._fetch_and_store()

    def start(self) -> threading.Thread:
        t = threading.Thread(target=self.run, daemon=True, name="hegg-gas-price-fetcher")
        t.start()
        return t

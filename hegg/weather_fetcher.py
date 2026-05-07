"""
hegg.weather_fetcher
====================

Fetches hourly weather forecasts (temperature and solar radiation) from the
Open-Meteo API and stores them in the local SQLite ``weather_forecast`` table.
"""

import json
import logging
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone

logger = logging.getLogger(__name__)

_API_BASE = "https://api.open-meteo.com/v1/forecast"

class WeatherFetcher:
    """Fetches and stores hourly weather forecasts from Open-Meteo.

    Intended to run in a daemon thread. It fetches on startup and then
    repeats every 6 hours.
    """

    def __init__(self, store, lat: float, lon: float) -> None:
        self._store = store
        self._lat = lat
        self._lon = lon
        # Fetch every 6 hours (21600 seconds)
        self._fetch_interval = 21600

    def _fetch(self) -> list:
        params = urllib.parse.urlencode({
            "latitude": str(self._lat),
            "longitude": str(self._lon),
            "hourly": "temperature_2m,shortwave_radiation",
            "timezone": "UTC"
        })
        url = f"{_API_BASE}?{params}"
        req = urllib.request.Request(url, headers={"Accept": "application/json"})
        with urllib.request.urlopen(req, timeout=30) as resp:
            raw = json.loads(resp.read().decode("utf-8"))

        hourly = raw.get("hourly", {})
        times = hourly.get("time", [])
        temps = hourly.get("temperature_2m", [])
        solar = hourly.get("shortwave_radiation", [])

        rows = []
        for i in range(len(times)):
            try:
                # Open-Meteo returns 'YYYY-MM-DDTHH:MM'
                dt = datetime.fromisoformat(times[i]).replace(tzinfo=timezone.utc)
                ts_ms = int(dt.timestamp() * 1000)
                temp_val = temps[i]
                solar_val = solar[i]
                
                # Filter out nulls from API
                if temp_val is not None and solar_val is not None:
                    rows.append({
                        "ts": ts_ms,
                        "temperature_c": float(temp_val),
                        "solar_wm2": float(solar_val)
                    })
            except Exception:
                continue
        return rows

    def _fetch_and_store(self) -> bool:
        try:
            rows = self._fetch()
            self._store.insert_weather(rows)
            logger.info("Stored %d weather forecast entries for lat=%.2f, lon=%.2f", len(rows), self._lat, self._lon)
            return True
        except Exception as exc:
            logger.error("Weather fetch error: %s", exc)
        return False

    def run(self) -> None:
        self._fetch_and_store()
        while True:
            threading.Event().wait(self._fetch_interval)
            self._fetch_and_store()

    def start(self) -> threading.Thread:
        t = threading.Thread(target=self.run, daemon=True, name="hegg-weather-fetcher")
        t.start()
        return t

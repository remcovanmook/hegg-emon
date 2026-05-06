import sys
import os

sys.path.insert(0, os.path.abspath("."))

from hegg.store import get_store, default_db_path
from hegg.gas_price_fetcher import GasPriceFetcher
from datetime import datetime, timedelta, timezone
import urllib.request, urllib.parse, json

def backfill():
    store = get_store(default_db_path())
    
    now = datetime.now(timezone.utc)
    from_date = (now - timedelta(days=7)).replace(hour=0, minute=0, second=0, microsecond=0)
    till_date = (now + timedelta(days=2)).replace(microsecond=999000)

    params = urllib.parse.urlencode({
        "fromDate": from_date.strftime("%Y-%m-%dT%H:%M:%S.000Z"),
        "tillDate": till_date.strftime("%Y-%m-%dT%H:%M:%S.999Z"),
        "interval": "4",
        "usageType": "3",
        "inclBtw": "false",
    })
    url = f"https://api.energyzero.nl/v1/energyprices?{params}"
    req = urllib.request.Request(url, headers={"Accept": "application/json"})

    print(f"Fetching from {url}")
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            raw = json.loads(resp.read().decode("utf-8"))
        
        prices = raw.get("Prices", [])
        rows = []
        for item in prices:
            start_str = item["readingDate"].rstrip("Z")
            start_dt = datetime.fromisoformat(start_str).replace(tzinfo=timezone.utc)
            end_dt = start_dt + timedelta(days=1)
            
            rows.append({
                "ts_start": int(start_dt.timestamp() * 1000),
                "ts_end": int(end_dt.timestamp() * 1000),
                "price_eur_m3": float(item["price"]),
                "price_origin": "actual"
            })
        
        if rows:
            store.insert_gas_prices(rows)
            print(f"Inserted {len(rows)} gas price rows successfully!")
        else:
            print("No prices returned.")
    except Exception as e:
        print(f"Error: {e}")

if __name__ == "__main__":
    backfill()

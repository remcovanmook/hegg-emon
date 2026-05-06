# Hegg Energy Monitor — Architecture

## Overview

SQLite is the shared data bus.  One writer, multiple independent readers.

```
Hegg device (UDP broadcast, 1 Hz)
        │
        ├──────────────────────────────────────────────┐
        ▼                                              ▼
hegg_collector.py          raw blocking UDP socket    hegg_mini.py
        │                  → HeggStore.insert()       UDP → in-process queue
        ▼                                              │
   hegg.db  (SQLite)                                  ▼
        │                                    ThreadingHTTPServer
   ┌────┴──────────────────┬──────────────────────┐   port 8080
   ▼                       ▼                      ▼
dashboard/app.py    prometheus_exporter.py    ha_publisher.py
Flask + SSE         HeggExporter.update()     (not yet wired)
port 8080           poll loop, port 9101
```

All consumers go through `HeggStore` — no component writes raw SQL except the
store itself.

---

## Components

### `hegg/reading.py`

`HeggReading` dataclass.  No external dependencies.

- `from_dict(data)` — parse from device JSON payload or store dict.  Handles
  both `Z`-suffixed and `+00:00`-suffixed ISO 8601 timestamps.
- `to_dict()` — JSON-serialisable representation.

### `hegg/store.py`

The single SQLite interface.  Everything else imports this.

| Method | Description |
|---|---|
| `insert(reading)` | Append a 1-second reading to the ring buffer; flush if a minute closed |
| `insert_summary(data)` | Write a minute-summary packet |
| `insert_event(data)` | Write an unknown/raw packet |
| `latest_reading()` | Most recent reading from the ring buffer, or `None` |
| `latest_summary()` | Most recent summary as dict, or `{}` |
| `query(since, bucket_seconds)` | Bucketed averages — tier dispatched by window length |
| `query_raw_since(since_ms, limit)` | Live tail from the ring buffer (SSE stream) |
| `summary_delta(hours)` | Cumulative energy/gas delta over a window |
| `query_events(limit)` | Recent raw/unknown packets |
| `prune()` | Roll up closed hours into `readings_1h`; delete data past each tier's retention |

Uses per-thread connections with WAL journal mode.  Schema is created on first
use of each connection, making `":memory:"` safe for concurrent test isolation.

#### Storage tiers

The store is a tiered ring buffer + pre-aggregated SQLite tables.  The 1 Hz
write hot-path lives entirely in RAM; disk writes fire only when an incoming
sample crosses a one-minute boundary.

| Tier | Source             | Resolution | Retention | Read window |
|------|--------------------|------------|-----------|-------------|
| 1    | in-memory deque    | 1 s        | 1 hour    | ≤ 1 hour    |
| 2    | `readings_10s`     | 10 s       | 6 hours   | ≤ 6 hours   |
| 3    | `readings_1m`      | 1 min      | 3 days    | ≤ 3 days    |
| 4    | `readings_1h`      | 1 hour     | 1 year    | > 3 days    |

Each insert appends to the ring buffer and tracks the last seen 1-minute
bucket.  When a sample crosses a bucket boundary, every closed minute is
flushed in a single transaction: 6 × `readings_10s` rows + 1 × `readings_1m`
row.  All `ts` values are floored to the bucket width so `INSERT OR REPLACE`
correctly updates an already-flushed bucket if late samples arrive.

`prune()` rolls every closed hour's `readings_1m` rows into a single
`readings_1h` row using a weighted mean (`SUM(mean*n) / SUM(n)`), then
deletes data past each tier's retention.  No separate maintenance thread
exists; the existing hourly prune timer drives both.

`query()` dispatches by total window length and serves the entire window
from one tier — a 90-minute query is served from `readings_10s` (10 s
resolution end-to-end), not stitched across the ring buffer + 10s table.

On startup the ring buffer is prefilled from the most recent `readings_10s`
rows so `latest_reading()`, the SSE stream, and short-window history are
non-empty before the first new packet arrives (at 10 s rather than 1 s
resolution).

**Crash durability:** up to one in-flight minute of 1 Hz samples lives only
in RAM and is lost on an unclean shutdown.  Tier-2-and-up data is durable
once flushed.

### `hegg_collector.py`

Standalone UDP → SQLite pipeline.  Single responsibility.

- Binds a raw blocking UDP socket on port 16121.
- Filters by source port 16120 (Hegg device) and locks onto the first seen
  device IP (or a pre-configured one).
- Routes packets by content:
  - Minute-summary (contains `energy_delivered_tariff1`) → `store.insert_summary()`
  - Standard 1-second reading → `HeggReading.from_dict()` + `store.insert()`
  - Unknown structure → `store.insert_event()`

Run standalone: `python hegg_collector.py --device-ip <ip> --db hegg.db`

### `dashboard/app.py`

Flask application.  Pure reader — no UDP socket, no threads beyond the prune
loop.

**Routes:**

| Method | Path | Description |
|---|---|---|
| GET | `/` | Dashboard HTML |
| GET | `/stream` | SSE stream of 1-second readings |
| GET | `/api/latest` | Most recent reading (JSON or 204) |
| GET | `/api/summary/latest` | Most recent minute summary (JSON or 204) |
| GET | `/api/summary/delta?hours=N` | Energy/gas delta over N hours |
| GET | `/api/history?hours=N&bucket=S` | Bucketed readings |
| GET | `/api/device` | Device identity from latest summary |
| GET | `/api/events` | Recent unknown packets (debug) |

SSE: `/stream` polls `store.query_raw_since()` every second.  On connect it
sends the most recent row immediately.

Run standalone: `python -m dashboard.app --http-port 8080 --db hegg.db`

### `hegg/prometheus_exporter.py`

`HeggExporter` maintains `prometheus_client` Gauges.

- `update(reading)` — synchronous; updates all gauges from a `HeggReading`.
- `start_http_server()` — starts the Prometheus exposition server.

The update loop runs in `hegg_server.py`: a daemon thread calls
`store.latest_reading()` every 2 seconds and passes the result to
`exporter.update()`.

### `hegg/ha_publisher.py`

Contains `MQTTConfig` and `HAPublisher` with HA MQTT discovery and state
payload logic.  Not yet wired to the store — the polling loop that reads
new readings from SQLite and publishes to MQTT is the missing piece.

### `hegg_mini.py`

Single-file server intended to run on a laptop or desktop on the same local
network as the Hegg device.  Start it, open a browser to `http://localhost:8080`,
and the dashboard is live — no installation, no database, no background services.

Zero external dependencies — Python 3.7+ standard library only.

Receives UDP broadcasts directly and fans them out to SSE clients in the same
process.  History, delta summaries, and Prometheus metrics are out of scope;
the dashboard starts empty and fills in from the live stream.

**Data flow:**

```
UDP packet → udp_listener() thread
  ├─ reading? → _broadcast_reading() → per-client queue.Queue
  │                                         └─► /stream SSE response
  └─ summary? → _latest_summary (in-process dict)
                     └─► /api/summary/latest, /api/device
```

**Endpoints** (same API surface as `dashboard/app.py`):

| Method | Path | Notes |
|---|---|---|
| GET | `/` | `dashboard/static/dashboard.html` served as a plain file |
| GET | `/static/<path>` | Static assets, path-traversal guarded |
| GET | `/stream` | SSE; sends latest reading on connect, then live |
| GET | `/api/summary/latest` | Latest summary dict or 204 |
| GET | `/api/summary/delta` | Always `{}` — no history |
| GET | `/api/history` | Always `[]` — no history |
| GET | `/api/device` | Device identity from latest summary |

Run: `python3 hegg_mini.py [--udp-port 16121] [--http-port 8080] [--device-ip <ip>]`

---

### `hegg_server.py`

Convenience launcher for single-host deployments.  Starts three threads:

| Thread | What it runs |
|---|---|
| `hegg-collector` | `hegg_collector.run()` — UDP → SQLite |
| `hegg-prometheus` | poll loop → `HeggExporter.update()` |
| main | Flask `app.run()` — blocks until interrupt |

---

## Data flow

```
UDP packet arrives at hegg_collector
  │
  ├─ minute summary? ──► store.insert_summary()
  │
  └─ 1-second reading
       │
       ├─► HeggReading.from_dict()
       └─► store.insert()

Flask /stream (per SSE client, its own thread)
  └─ every 1 s: store.query_raw_since()
       └─► yield "data: <json>\n\n"
            └─► browser applyReading() → chart + DOM update

Prometheus poll loop (daemon thread, every 2 s)
  └─ store.latest_reading()
       └─► HeggExporter.update()
            └─► Gauge.set() × 9 metrics
```

---

## Database schema

```sql
-- Pre-aggregated rollup tables.  Identical column shape — only the bucket
-- width of `ts` differs.  `ts` is always floored to its bucket so
-- INSERT OR REPLACE replaces in place if the bucket is re-flushed.
-- `n` is the sample count and is required for weighted regrouping.
CREATE TABLE readings_10s (
    ts              INTEGER NOT NULL,
    serial          TEXT    NOT NULL,
    n               INTEGER NOT NULL,
    delivered_mean  REAL    NOT NULL,   -- kW
    returned_mean   REAL    NOT NULL,   -- kW
    voltage_l1_mean REAL    NOT NULL,
    voltage_l2_mean REAL    NOT NULL,
    voltage_l3_mean REAL    NOT NULL,
    current_l1_mean REAL    NOT NULL,
    current_l2_mean REAL    NOT NULL,
    current_l3_mean REAL    NOT NULL,
    UNIQUE (ts, serial)
);
-- Same shape for readings_1m and readings_1h.

-- Legacy raw 1 Hz table.  No longer written.  Kept so existing
-- databases on disk don't break; safe to DROP at any later point.
CREATE TABLE readings (
    ts          INTEGER NOT NULL,
    serial      TEXT    NOT NULL,
    delivered   REAL    NOT NULL,
    returned    REAL    NOT NULL,
    voltage_l1  REAL, voltage_l2 REAL, voltage_l3 REAL,
    current_l1  REAL, current_l2 REAL, current_l3 REAL
);

CREATE TABLE summaries (
    ts                  INTEGER NOT NULL UNIQUE,  -- Unix ms
    serial              TEXT    NOT NULL,
    sw_version          INTEGER,
    equipment_id        TEXT,
    model               TEXT,
    wifi_rssi           INTEGER,
    energy_delivered_t1 REAL,   -- kWh
    energy_delivered_t2 REAL,
    energy_returned_t1  REAL,
    energy_returned_t2  REAL,
    gas_delivered       REAL    -- m³
);

CREATE TABLE events (
    id     INTEGER PRIMARY KEY,
    ts     INTEGER NOT NULL,
    serial TEXT    NOT NULL,
    raw    TEXT    NOT NULL,    -- JSON blob
    UNIQUE (ts, serial)
);
```

---

## Prometheus metrics

| Metric | Type | Labels | Unit |
|---|---|---|---|
| `hegg_power_delivered_kw` | Gauge | — | kW |
| `hegg_power_returned_kw` | Gauge | — | kW |
| `hegg_voltage_volts` | Gauge | `phase={l1,l2,l3}` | V |
| `hegg_current_amperes` | Gauge | `phase={l1,l2,l3}` | A |
| `hegg_last_seen_timestamp` | Gauge | — | Unix s |

---

## Dependencies

| Package | Purpose | Required |
|---|---|---|
| `flask` | Dashboard HTTP server (`hegg_server.py` / `dashboard/app.py`) | Yes |
| `prometheus_client` | Metrics + exposition | Yes |
| `aiomqtt` | MQTT for HA integration | Optional |
| `pytest` | Test runner | Dev |

`hegg_mini.py` has no external dependencies beyond the Python standard library.

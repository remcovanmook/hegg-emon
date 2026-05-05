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
| `insert(reading)` | Write a 1-second reading |
| `insert_summary(data)` | Write a minute-summary packet |
| `insert_event(data)` | Write an unknown/raw packet |
| `latest_reading()` | Most recent reading as `HeggReading`, or `None` |
| `latest_summary()` | Most recent summary as dict, or `{}` |
| `query(since, bucket_seconds)` | Bucketed averages for the history API |
| `query_raw_since(since_ms, limit)` | Raw rows for the SSE stream |
| `summary_delta(hours)` | Cumulative energy/gas delta over a window |
| `query_events(limit)` | Recent raw/unknown packets |
| `prune()` | Delete rows older than the retention window |

Uses per-thread connections with WAL journal mode.  Schema is created on first
use of each connection, making `":memory:"` safe for concurrent test isolation.

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

Self-contained minimal server.  Zero external dependencies — Python 3.7+
standard library only.

Designed for situations where the full stack (Flask, SQLite, Prometheus) is
unwanted overhead.  Receives UDP broadcasts directly and fans them out to SSE
clients in the same process — no database involved.

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
CREATE TABLE readings (
    ts          INTEGER NOT NULL,   -- Unix ms
    serial      TEXT    NOT NULL,
    delivered   REAL    NOT NULL,   -- kW
    returned    REAL    NOT NULL,   -- kW
    voltage_l1  REAL, voltage_l2 REAL, voltage_l3 REAL,  -- V
    current_l1  REAL, current_l2 REAL, current_l3 REAL,  -- A
    UNIQUE (ts, serial)
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

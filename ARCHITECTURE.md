# Hegg Energy Monitor — Architecture

## Overview

Receives 1 Hz UDP broadcasts from a Hegg energy monitor device and distributes the data to three consumers:

| Consumer | Entry point | Port |
|---|---|---|
| Live dashboard (Flask + SSE) | `dashboard/app.py` | 8080 |
| Prometheus metrics | `hegg/prometheus_exporter.py` | 9101 |
| Home Assistant (MQTT) | `hegg/ha_publisher.py` | depends on broker |

All three consumers are wired together by the unified launcher `hegg_server.py`.

---

## Component diagram

```
  ┌─────────────────────────────────────────────────────────────────┐
  │  Hegg device                                                    │
  │  UDP broadcast → <subnet>.255:16121, 1 msg/s                   │
  └──────────────────────────┬──────────────────────────────────────┘
                             │
                    ┌────────▼─────────────────────────┐
                    │  _run_listener()                 │   dashboard/app.py
                    │  raw blocking UDP socket         │
                    │  daemon thread, port 16121       │
                    └──┬──────────────┬────────────────┘
                       │              │
           ┌───────────▼──┐   ┌───────▼────────┐   ┌──────────────┐
           │  HeggStore   │   │  HeggExporter  │   │ HAPublisher  │
           │  (SQLite)    │   │  (prometheus)  │   │  (MQTT / HA) │
           └──────┬───────┘   └───┬────────────┘   └──────┬───────┘
                  │               │                        │
           Flask /stream    GET /metrics             MQTT broker
           SSE poll loop    port 9101             → Home Assistant
           port 8080
                  │
           Browser EventSource
           Chart.js + annotation
```

---

## Module descriptions

### `hegg/listener.py`

Provides `HeggReading` (the core data model) and an asyncio-based `HeggListener` for
standalone use (Prometheus-only, tests, scripts).

- `HeggReading` — dataclass holding one parsed reading; `from_dict` / `to_dict` for
  (de)serialisation.
- `_HeggProtocol` — asyncio `DatagramProtocol`; parses JSON on receipt and schedules
  handler coroutines as tasks.
- `HeggListener` — manages the UDP socket lifecycle and the handler registry.

> Note: the dashboard uses its own `_run_listener()` (a raw blocking socket in a daemon
> thread) rather than `HeggListener`, because Flask runs in a synchronous WSGI context.

### `hegg/store.py`

SQLite persistence layer.

- `HeggStore` — wraps a single SQLite connection with thread-safe access.
- Stores two table types: `readings` (1 s telemetry) and `summaries` (minute packets).
- `query()` — bucketed aggregation for the history API.
- `summary_delta()` — cumulative energy / gas delta for a look-back window.
- `prune()` — removes rows older than the configured retention window.

### `hegg/prometheus_exporter.py`

- `HeggExporter` — updates `prometheus_client` Gauges from a reading.
  Per-phase metrics (voltage, current) use `phase` labels (l1/l2/l3).
- `start_http_server()` — thin wrapper around `prometheus_client.start_http_server`.

### `hegg/ha_publisher.py`

- `MQTTConfig` — dataclass for MQTT connection parameters.
- `HAPublisher` — sends HA MQTT discovery config on first contact, then publishes
  a flat JSON state blob to `hegg/<serial>/state` on every reading.
- Requires `aiomqtt` (not in `requirements.txt` — install separately).
- Integration is currently scaffolded; `_ha_main()` in `hegg_server.py` keeps the
  event loop alive but does not yet bridge readings into the MQTT publisher.

### `dashboard/app.py`

Flask application with SSE live stream, REST history API, and SQLite persistence.

**Routes:**

| Method | Path | Description |
|---|---|---|
| GET | `/` | Dashboard HTML page |
| GET | `/stream` | SSE stream; `data:` events are JSON reading dicts |
| GET | `/api/latest` | Most recent 1-second reading, or 204 |
| GET | `/api/summary/latest` | Most recent minute-summary packet, or 204 |
| GET | `/api/summary/delta` | Energy/gas delta for `?hours=` window |
| GET | `/api/history` | Bucketed readings for `?hours=` window |
| GET | `/api/device` | Device identity (IP, serial, model, SW, WiFi RSSI) |
| GET | `/api/events` | Recent unknown/raw event packets (debug) |

**SSE implementation:**  
`/stream` polls the SQLite store for rows newer than the last-seen timestamp, sleeping
1 s between polls. On connect the most recent stored row is sent immediately so the
browser has data without waiting for the next cycle.

**Threads started by `create_app()`:**

| Thread | Purpose |
|---|---|
| `hegg-udp` | `_run_listener()` — blocking UDP socket, routes packets to store + extra handlers |
| `hegg-prune` | `_prune_loop()` — hourly SQLite vacuum of old rows |

### `dashboard/static/js/dashboard.js`

Client-side logic. Chart.js with `chartjs-adapter-date-fns` and `chartjs-plugin-annotation`.

- Connects via `EventSource` to `/stream`.
- On load, fetches `/api/history` (bucketed), `/api/summary/latest`, `/api/summary/delta`,
  `/api/device`.
- Adds vertical flip annotations to **all charts** (power, voltage, current) when
  `power_delivered` / `power_returned` cross zero.
- Voltage charts additionally carry horizontal min/max annotations.

### `hegg_server.py`

Unified launcher:
1. Optionally starts the Prometheus exporter and passes its `handle` coroutine as an
   extra handler to the dashboard's UDP listener.
2. Runs the dashboard in a `daemon=True` thread.
3. Keeps the main thread alive via `asyncio.run(_ha_main())`.

---

## Data flow — single 1-second packet

```
UDP datagram arrives at _run_listener()
  → source port / IP filter (port 16120 from locked device IP)
  → json.loads() + HeggReading.from_dict()
  → _push_reading()
      → _latest_reading = reading          (in-memory for /api/latest)
      → _store.insert(reading)             (SQLite readings table)
  → extra_handlers (e.g. HeggExporter)
      → prometheus_client Gauge.set()

Flask /stream generator (runs in its own thread per SSE client)
  → polls _store.query_raw_since() every 1 s
  → yields "data: <json>\n\n" for each new row
  → browser EventSource fires "message"
  → applyReading() → DOM update + sparkline append
```

Minute-summary packets (containing cumulative energy totals) take a different branch:

```
UDP datagram → _run_listener()
  → "energy_delivered_tariff1" key present → _store.insert_summary()
  → /api/summary/latest and /api/summary/delta read from summaries table
```

---

## Prometheus metrics reference

| Metric | Type | Labels | Unit |
|---|---|---|---|
| `hegg_power_delivered_kw` | Gauge | — | kW |
| `hegg_power_returned_kw` | Gauge | — | kW |
| `hegg_voltage_volts` | Gauge | `phase={l1,l2,l3}` | V |
| `hegg_current_amperes` | Gauge | `phase={l1,l2,l3}` | A |
| `hegg_last_seen_timestamp` | Gauge | — | Unix s |

---

## Home Assistant MQTT discovery

Entities are registered under device `hegg_<serial>` using the standard
`homeassistant/sensor/<device_id>/<field>/config` topic pattern with `retain=True`.

State updates go to `hegg/<serial>/state` as a JSON blob; each sensor uses
a `value_template` like `{{ value_json.power_delivered }}` to extract its value.

---

## Dependencies

| Package | Purpose | Required |
|---|---|---|
| `flask` | Dashboard HTTP server | Yes |
| `prometheus_client` | Prometheus metrics + exposition | Yes |
| `aiomqtt` | MQTT client for HA integration | Optional |
| `pytest` + `pytest-asyncio` | Test runner | Dev |

---

## Grafana quick-start

1. Add a Prometheus data source pointing at `http://<host>:9101`.
2. Use:
   - `hegg_power_delivered_kw` / `hegg_power_returned_kw` — power graph.
   - `hegg_voltage_volts{phase=~"l."}` — per-phase voltage.
   - `hegg_current_amperes{phase=~"l."}` — per-phase current.

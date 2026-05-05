# Hegg Energy Monitor — Architecture

## Overview

This project receives 1 Hz UDP broadcasts from a Hegg energy monitor device
and distributes the data to three consumers:

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
  │  Hegg device (172.28.2.158)                                     │
  │  UDP broadcast → 172.28.2.255:16121, 1 msg/s                   │
  └──────────────────────────┬──────────────────────────────────────┘
                             │
                    ┌────────▼────────┐
                    │  HeggListener   │   hegg/listener.py
                    │  (asyncio UDP)  │
                    └──┬──────────┬───┘
                       │          │
           ┌───────────▼──┐   ┌───▼────────────┐   ┌──────────────┐
           │   Flask SSE  │   │ HeggExporter   │   │ HAPublisher  │
           │  (dashboard) │   │ (prometheus)   │   │  (MQTT / HA) │
           └──────┬───────┘   └───┬────────────┘   └──────┬───────┘
                  │               │                        │
           Browser (SSE)   GET /metrics             MQTT broker
           port 8080        port 9101            → Home Assistant
```

---

## Module descriptions

### `hegg/listener.py`

Core data pipeline.

- `HeggReading` — dataclass holding one parsed reading; includes `from_dict`
  and `to_dict` for (de)serialisation.
- `_HeggProtocol` — asyncio `DatagramProtocol`; parses JSON on receipt and
  schedules handler coroutines as asyncio tasks (non-blocking).
- `HeggListener` — manages the UDP socket lifecycle and the handler registry.
  Handlers are `async def fn(reading: HeggReading)` callables.

### `hegg/prometheus_exporter.py`

- `HeggExporter` — updates `prometheus_client` Gauges from a reading.
  Per-phase metrics (voltage, current) use `phase` labels (l1/l2/l3).
- `start_http_server()` — thin wrapper around `prometheus_client.start_http_server`.

### `hegg/ha_publisher.py`

- `MQTTConfig` — dataclass for MQTT connection parameters.
- `HAPublisher` — sends HA MQTT discovery config on first contact, then
  publishes a flat JSON state blob to `hegg/<serial>/state` on every reading.
- Requires `aiomqtt` (not in `requirements.txt` by default — see note below).

### `dashboard/app.py`

- Flask app with three routes: `GET /`, `GET /stream` (SSE), `GET /api/latest`.
- Runs a daemon thread with its own asyncio event loop + `HeggListener`.
- A `queue.Queue(maxsize=60)` decouples the UDP thread from SSE consumers;
  the queue drops the oldest entry when full to prevent stalls.

### `hegg_server.py`

Unified launcher. Runs:
1. Dashboard in a `daemon=True` threading.Thread (Flask).
2. Prometheus exporter + HA publisher via `asyncio.run()` in main thread.

---

## Data flow for a single packet

```
UDP datagram arrives
  → _HeggProtocol.datagram_received()
  → json.loads() + HeggReading.from_dict()
  → asyncio.create_task(handler(reading))  — one task per registered handler

Handler A: _async_handler (dashboard)
  → _push_reading() → queue.put_nowait()
  → Flask /stream generator yields SSE event
  → Browser EventSource fires "message"
  → DOM update + sparkline redraw

Handler B: HeggExporter.handle()
  → prometheus_client Gauge.set() for each metric

Handler C: HAPublisher.handle()  [optional]
  → aiomqtt publish to homeassistant/sensor/.../config (first time)
  → aiomqtt publish to hegg/<serial>/state
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

Install: `pip install -r requirements.txt`  
For HA integration: `pip install aiomqtt`

---

## Running

```bash
# Set up venv
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt

# Run everything
python hegg_server.py

# With MQTT / HA integration
python hegg_server.py --mqtt-host 192.168.1.10 --mqtt-user ha --mqtt-pass secret

# Run tests
pytest
```

### Dashboard-only (no Prometheus)
```bash
python -m dashboard.app
```

### Prometheus-only
```bash
python -c "
import asyncio
from hegg.listener import HeggListener
from hegg.prometheus_exporter import HeggExporter
e = HeggExporter(); e.start_http_server()
l = HeggListener(); l.add_handler(e.handle)
asyncio.run(l.run())
"
```

---

## Grafana quick-start

1. Add a Prometheus data source pointing at `http://<host>:9101`.
2. Create a dashboard panel using:
   - `hegg_power_delivered_kw` and `hegg_power_returned_kw` for a power graph.
   - `hegg_voltage_volts{phase=~"l."}` for a per-phase voltage panel.
   - `hegg_current_amperes{phase=~"l."}` for per-phase current.

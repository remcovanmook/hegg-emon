# Hegg Energy Monitor

A lightweight local server that receives 1 Hz UDP broadcasts from a
[Hegg](https://www.hegg.nl/) smart energy meter and provides:

- A live web dashboard with real-time charts (power, voltage, current)
- A Prometheus metrics endpoint
- Optional Home Assistant integration via MQTT

---

## Requirements

- Python 3.11+
- A Hegg device on the local network broadcasting on UDP port 16121

---

## Quick start

```bash
# Create and activate a virtual environment
python3 -m venv .venv
source .venv/bin/activate

# Install dependencies
pip install -r requirements.txt

# Run (auto-detects the Hegg device)
python hegg_server.py

# Or lock to a specific device IP (recommended on multi-homed hosts)
python hegg_server.py --device-ip 192.168.1.42

# Open the dashboard
open http://localhost:8080
```

---

## Configuration

All options can be set via flags or environment variables:

| Flag | Env var | Default | Description |
|---|---|---|---|
| `--udp-port` | `HEGG_UDP_PORT` | `16121` | UDP port to listen on |
| `--http-port` | `HEGG_HTTP_PORT` | `8080` | Dashboard HTTP port |
| `--prometheus-port` | `HEGG_PROMETHEUS_PORT` | `9101` | Prometheus metrics port |
| `--device-ip` | `HEGG_DEVICE_IP` | _(auto)_ | Lock listener to this source IP |
| `--mqtt-host` | `HEGG_MQTT_HOST` | _(none)_ | MQTT broker — enables HA integration |
| `--mqtt-port` | `HEGG_MQTT_PORT` | `1883` | MQTT broker port |
| `--mqtt-user` | `HEGG_MQTT_USER` | _(none)_ | MQTT username |
| `--mqtt-pass` | `HEGG_MQTT_PASS` | _(none)_ | MQTT password |
| `--debug` | — | off | Enable Flask debug mode |

---

## Dashboard features

- **Power over time** — net import/export with blue/green colouring at the zero line
- **Voltage + Current** — per-phase inline sparklines (L1/L2/L3) with min/max annotations
- **Import/export flip markers** — vertical dashed lines on all charts when the power
  direction changes
- **Summary strip** — cumulative energy in/out (T1/T2 breakdown), gas, device info
- **History range** — 1 h / 6 h / 24 h / 3 d / 7 d selectable window
- **Live clock** + SSE connection status in the header

---

## Prometheus

The exporter runs automatically on port 9101. Metrics:

| Metric | Unit |
|---|---|
| `hegg_power_delivered_kw` | kW |
| `hegg_power_returned_kw` | kW |
| `hegg_voltage_volts{phase=l1|l2|l3}` | V |
| `hegg_current_amperes{phase=l1|l2|l3}` | A |
| `hegg_last_seen_timestamp` | Unix s |

Quick Grafana setup: add `http://<host>:9101` as a Prometheus data source.

---

## Home Assistant (MQTT)

Requires `aiomqtt`:

```bash
pip install aiomqtt
```

Then start with `--mqtt-host`:

```bash
python hegg_server.py --device-ip 192.168.1.42 --mqtt-host 192.168.1.10
```

Entities are auto-discovered under device `hegg_<serial>`. State updates go to
`hegg/<serial>/state` as a JSON blob.

> **Note:** HA integration is currently scaffolded. The MQTT bridge from the UDP
> listener to the publisher is not yet wired up.

---

## Running tests

```bash
pytest
```

---

## Project layout

```
hegg_server.py          Unified launcher (dashboard + Prometheus + HA)
hegg/
  listener.py           HeggReading dataclass + asyncio UDP listener
  store.py              SQLite persistence (readings + summaries)
  prometheus_exporter.py Prometheus metrics
  ha_publisher.py       Home Assistant MQTT discovery + state
dashboard/
  app.py                Flask app, SSE stream, REST API
  templates/
    dashboard.html      Single-page dashboard
  static/
    css/dashboard.css
    js/dashboard.js
tests/
  test_listener.py
  test_store.py
  test_prometheus_exporter.py
ARCHITECTURE.md         Detailed component and data-flow documentation
```

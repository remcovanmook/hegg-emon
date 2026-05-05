# Hegg Energy Monitor

Receives 1 Hz UDP broadcasts from a [Hegg](https://www.hegg.nl/) smart energy
meter and stores them in a local SQLite database.  Consumers read from that
database independently.

---

## Requirements

- Python 3.11+
- A Hegg device broadcasting on the local network (UDP port 16121)

---

## Setup

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

---

## Running

### All-in-one (single host)

```bash
python hegg_server.py --device-ip 192.168.1.42
open http://localhost:8080
```

This starts the UDP collector, Prometheus exporter, and Flask dashboard in one
process.  The device IP is optional — it auto-detects the first Hegg broadcast
if omitted.

### As separate processes

Run each component independently, pointing at the same database file:

```bash
# Terminal 1 — collect UDP broadcasts into SQLite
python hegg_collector.py --device-ip 192.168.1.42 --db hegg.db

# Terminal 2 — serve the dashboard and Prometheus endpoint
python -m dashboard.app --db hegg.db

# Terminal 3 — (not yet implemented) HA/MQTT exporter
# python hegg_mqtt.py --db hegg.db --mqtt-host 192.168.1.10
```

---

## Configuration

### `hegg_server.py` / `hegg_collector.py`

| Flag | Env var | Default | Description |
|---|---|---|---|
| `--udp-port` | `HEGG_UDP_PORT` | `16121` | UDP port to bind |
| `--device-ip` | `HEGG_DEVICE_IP` | _(auto)_ | Lock to this source IP |
| `--db` | `HEGG_DB` | `hegg.db` | SQLite database path |

### `hegg_server.py` / `dashboard/app.py`

| Flag | Env var | Default | Description |
|---|---|---|---|
| `--http-port` | `HEGG_HTTP_PORT` | `8080` | Dashboard HTTP port |
| `--prometheus-port` | `HEGG_PROMETHEUS_PORT` | `9101` | Prometheus metrics port |
| `--debug` | — | off | Flask debug mode |

---

## Dashboard

- Live power import/export chart with per-phase voltage and current
- Vertical markers on all charts when import/export direction flips
- Summary strip: cumulative energy (T1/T2), gas, device info
- History selector: 1 h / 6 h / 24 h / 3 d / 7 d

---

## Prometheus

Metrics served on port 9101:

| Metric | Unit |
|---|---|
| `hegg_power_delivered_kw` | kW |
| `hegg_power_returned_kw` | kW |
| `hegg_voltage_volts{phase=l1\|l2\|l3}` | V |
| `hegg_current_amperes{phase=l1\|l2\|l3}` | A |
| `hegg_last_seen_timestamp` | Unix s |

Grafana: add `http://<host>:9101` as a Prometheus data source.

---

## Home Assistant / MQTT

Not yet implemented.  `hegg/ha_publisher.py` contains the discovery and state
payload logic; the polling loop that feeds it from SQLite is the missing piece.

---

## Tests

```bash
pytest
```

---

## Project layout

```
hegg_collector.py       UDP → SQLite ingestion (standalone)
hegg_server.py          Convenience launcher: collector + dashboard + Prometheus

hegg/
  reading.py            HeggReading dataclass (shared data model)
  store.py              SQLite wrapper — the only code that touches the DB
  prometheus_exporter.py  HeggExporter: sync update() from latest store reading
  ha_publisher.py       HA/MQTT publisher (discovery + state payload, not yet wired)

dashboard/
  app.py                Flask app + SSE stream + REST API
  templates/dashboard.html
  static/css/dashboard.css
  static/js/dashboard.js

tests/
  test_reading.py
  test_store.py
  test_prometheus_exporter.py

ARCHITECTURE.md         Component and data-flow reference
```

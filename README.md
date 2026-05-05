# Hegg Energy Monitor

Receives 1 Hz UDP broadcasts from a [Hegg](https://www.hegg.nl/) smart energy
meter, stores them in SQLite, and serves a live web dashboard with Prometheus
metrics.

---

## Setup

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

---

## Running

### Single command (recommended)

```bash
python hegg_server.py --device-ip 172.28.2.158
```

This starts everything in one process:
- UDP collector writing to `hegg.db`
- Dashboard at **http://localhost:8080**
- Prometheus metrics at **http://localhost:9101/metrics**

Drop `--device-ip` to auto-detect the first Hegg device seen on the network.

### Options

```
--device-ip 172.28.2.158   Lock to this source IP (recommended)
--db hegg.db               SQLite database path (default: hegg.db)
--udp-port 16121           UDP port to listen on (default: 16121)
--http-port 8080           Dashboard port (default: 8080)
--prometheus-port 9101     Prometheus port (default: 9101)
--debug                    Enable Flask debug mode
```

Every flag has an environment variable equivalent (`HEGG_DEVICE_IP`,
`HEGG_DB`, `HEGG_UDP_PORT`, `HEGG_HTTP_PORT`, `HEGG_PROMETHEUS_PORT`).

---

## Running as separate processes

If you want the collector and server to run independently (e.g. on different
hosts sharing a network filesystem, or under a process manager):

```bash
# Process 1: write UDP broadcasts to SQLite
python hegg_collector.py --device-ip 172.28.2.158 --db hegg.db

# Process 2: serve dashboard + Prometheus from the same database
python hegg_server.py --db hegg.db --udp-port 0
```

> Setting `--udp-port 0` on `hegg_server.py` is not yet supported — for now,
> run `python -m dashboard.app --db hegg.db` to start only the Flask server.

---

## Dashboard

- Real-time power import/export chart with phase breakdown
- Per-phase voltage and current with min/max annotations
- Vertical markers on all charts when import/export direction flips
- Summary strip: cumulative energy (T1/T2), gas usage, device info
- History selector: 1 h / 6 h / 24 h / 3 d / 7 d

---

## Prometheus

Metrics at `http://localhost:9101/metrics`:

| Metric | Unit |
|---|---|
| `hegg_power_delivered_kw` | kW |
| `hegg_power_returned_kw` | kW |
| `hegg_voltage_volts{phase=l1\|l2\|l3}` | V |
| `hegg_current_amperes{phase=l1\|l2\|l3}` | A |
| `hegg_last_seen_timestamp` | Unix s |

---

## Home Assistant / MQTT

Requires `aiomqtt`:

```bash
pip install aiomqtt
```

Run as a separate process pointing at the same database:

```bash
python hegg_mqtt.py --mqtt-host 192.168.1.10 --db hegg.db
# with auth:
python hegg_mqtt.py --mqtt-host 192.168.1.10 --mqtt-user ha --mqtt-pass secret
```

Or include it in the all-in-one launcher:

```bash
python hegg_server.py --device-ip 172.28.2.158 --mqtt-host 192.168.1.10
```

Entities are auto-discovered in Home Assistant under device `hegg_<serial>`.
State updates publish to `hegg/<serial>/state` as JSON; each sensor uses a
`value_template` to extract its field (e.g. `{{ value_json.power_delivered }}`).

---

## Tests

```bash
pytest
```

---

## Project layout

```
hegg_server.py          Entry point: collector + dashboard + Prometheus
hegg_collector.py       Standalone collector: UDP → SQLite only

hegg/
  reading.py            HeggReading dataclass
  store.py              SQLite wrapper (all DB access goes through here)
  prometheus_exporter.py  Prometheus gauge update logic
  ha_publisher.py       HA/MQTT (not yet wired)

dashboard/
  app.py                Flask app, SSE stream, REST API
  templates/dashboard.html
  static/css/dashboard.css
  static/js/dashboard.js

tests/
  test_reading.py
  test_store.py
  test_prometheus_exporter.py

ARCHITECTURE.md         Component and data-flow reference
```

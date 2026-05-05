# Hegg Energy Monitor

Receives 1 Hz UDP broadcasts from a [Hegg](https://www.hegg.nl/) smart energy
meter, stores them in SQLite, and serves a live web dashboard with Prometheus
metrics and optional Home Assistant integration.

---

## Requirements

- Python 3.11+
- A Hegg device broadcasting on the local network (UDP port 16121)

---

## Install

```bash
git clone https://github.com/yourorg/hegg /opt/hegg
cd /opt/hegg
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt

# Optional — for Home Assistant / MQTT integration:
pip install aiomqtt
```

Create the database directory and a system user:

```bash
sudo useradd -r -s /bin/false hegg
sudo mkdir -p /var/lib/hegg
sudo chown hegg:hegg /var/lib/hegg
sudo mkdir -p /etc/hegg
sudo cp /opt/hegg/etc/hegg.conf /etc/hegg/hegg.conf
```

Edit `/etc/hegg/hegg.conf` and set at minimum `HEGG_DEVICE_IP`.

---

## Running

### Development / single command

```bash
python hegg_server.py --device-ip 172.28.2.158
open http://localhost:8080
```

### systemd (recommended for production)

**All-in-one** (collector + dashboard + Prometheus in one unit):

```bash
sudo cp /opt/hegg/etc/systemd/hegg.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now hegg
sudo systemctl status hegg
```

**Separate units** (collector and server can restart independently):

```bash
sudo cp /opt/hegg/etc/systemd/hegg-collector.service /etc/systemd/system/
sudo cp /opt/hegg/etc/systemd/hegg-server.service    /etc/systemd/system/
sudo cp /opt/hegg/etc/systemd/hegg-mqtt.service      /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now hegg-collector hegg-server
# add hegg-mqtt if using Home Assistant
sudo systemctl enable --now hegg-mqtt
```

### SysV init (older Debian/Ubuntu)

```bash
sudo cp /opt/hegg/etc/sysv/hegg /etc/init.d/hegg
sudo chmod +x /etc/init.d/hegg
sudo update-rc.d hegg defaults
sudo service hegg start
```

---

## Configuration

Set in `/etc/hegg/hegg.conf` (for service deployments) or as CLI flags:

| Variable / Flag | Default | Description |
|---|---|---|
| `HEGG_DEVICE_IP` / `--device-ip` | _(auto)_ | Lock collector to this source IP |
| `HEGG_DB` / `--db` | `hegg.db` | SQLite database path |
| `HEGG_UDP_PORT` / `--udp-port` | `16121` | UDP port to bind |
| `HEGG_HTTP_PORT` / `--http-port` | `8080` | Dashboard HTTP port |
| `HEGG_PROMETHEUS_PORT` / `--prometheus-port` | `9101` | Prometheus metrics port |
| `HEGG_MQTT_HOST` / `--mqtt-host` | _(none)_ | MQTT broker — enables HA integration |
| `HEGG_MQTT_PORT` / `--mqtt-port` | `1883` | MQTT broker port |
| `HEGG_MQTT_USER` / `--mqtt-user` | _(none)_ | MQTT username |
| `HEGG_MQTT_PASS` / `--mqtt-pass` | _(none)_ | MQTT password |

---

## Dashboard

- Real-time power import/export chart with per-phase voltage and current
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

Grafana: add `http://<host>:9101` as a Prometheus data source.

---

## Home Assistant / MQTT

Requires `aiomqtt` (`pip install aiomqtt`). Enable via `HEGG_MQTT_HOST` in
`/etc/hegg/hegg.conf`, or pass `--mqtt-host` directly:

```bash
python hegg_mqtt.py --mqtt-host 192.168.1.10 --db /var/lib/hegg/hegg.db
```

Entities are auto-discovered in Home Assistant under device `hegg_<serial>`.

---

## Diagnostics

To verify the Hegg device is reachable before running the full stack:

```bash
python udp_test.py
```

Prints every UDP packet received on port 16121.

---

## Tests

```bash
pytest
```

---

## Project layout

```
hegg_server.py          Entry point: collector + dashboard + Prometheus
hegg_collector.py       Standalone: UDP → SQLite only
hegg_mqtt.py            Standalone: SQLite → MQTT / Home Assistant

hegg/
  reading.py            HeggReading dataclass
  store.py              SQLite wrapper — the only code that touches the DB
  prometheus_exporter.py
  ha_publisher.py       MQTT discovery + state publish logic

dashboard/
  app.py                Flask app, SSE stream, REST API
  templates/dashboard.html
  static/css/dashboard.css
  static/js/dashboard.js

etc/
  hegg.conf             Environment variable template
  systemd/              systemd service units
    hegg.service          all-in-one
    hegg-collector.service
    hegg-server.service
    hegg-mqtt.service
  sysv/
    hegg                SysV init script

tests/
  test_reading.py
  test_store.py
  test_prometheus_exporter.py

udp_test.py             UDP reception diagnostic
ARCHITECTURE.md         Component and data-flow reference
```

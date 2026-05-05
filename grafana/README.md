# Hegg Energy Monitor — Grafana dashboard

Pre-built Grafana dashboard for data written by **hegg_influx.py** (InfluxDB v2 Flux queries).

## Measurements written by hegg_influx.py

| Measurement | Tag | Fields |
|---|---|---|
| `hegg_reading` | `serial` | `power_delivered`, `power_returned`, `voltage_l1–l3`, `current_l1–l3` |
| `hegg_summary` | `serial` | `energy_delivered_t1/t2`, `energy_returned_t1/t2`, `gas_delivered`, `wifi_rssi` |

Power fields are in **kW** as reported by the DSMR protocol. The dashboard
converts to **W** for display.

## Dashboard panels

| Panel | Type | Source |
|---|---|---|
| Net Power | Stat | `hegg_reading` last (delivered−returned)×1000 |
| Energy In | Stat | `hegg_summary` last T1+T2 delivered |
| Energy Out | Stat | `hegg_summary` last T1+T2 returned |
| Gas | Stat | `hegg_summary` last gas_delivered |
| Power Delivered & Returned | Timeseries | `hegg_reading` power fields (W) |
| Voltage L1/L2/L3 | Timeseries | `hegg_reading` voltage fields (V) |
| Current L1/L2/L3 | Timeseries | `hegg_reading` current fields (A) |
| Energy Delivered T1/T2 | Timeseries | `hegg_summary` absolute meter values |
| Energy Returned T1/T2 | Timeseries | `hegg_summary` absolute meter values |

## Option 1 — Import via Grafana UI

1. Configure an **InfluxDB** datasource in Grafana (v2 / Flux mode).
2. **Dashboards → Import → Upload JSON file** → select `dashboards/hegg_energy.json`.
3. Map the `InfluxDB` input to your datasource and set the `bucket` default to
   match your bucket name.

## Option 2 — Auto-provisioning with Docker Compose

```bash
# Copy and edit the datasource config for your InfluxDB instance
cp provisioning/datasources/influxdb.yaml.example provisioning/datasources/influxdb.yaml
$EDITOR provisioning/datasources/influxdb.yaml

# Start Grafana
docker compose up -d
```

Grafana will be available at <http://localhost:3000> (admin / admin).
The dashboard is provisioned automatically at startup.

## InfluxDB v1 / InfluxQL alternative

The dashboard uses Flux (InfluxDB v2). If you run InfluxDB v1, create a v1
datasource in Grafana and rewrite the queries using InfluxQL, e.g.:

```sql
-- Power delivered (W), 1-minute mean
SELECT mean("power_delivered") * 1000 AS "Delivered (W)"
FROM "hegg_reading"
WHERE $timeFilter
GROUP BY time($__interval)
```

All fields are the same; only the query language changes.

## Template variables

| Variable | Default | Description |
|---|---|---|
| `DS_INFLUXDB` | *(select on import)* | InfluxDB datasource |
| `bucket` | `hegg` | InfluxDB v2 bucket |
| `serial` | All | Filter by device serial tag |

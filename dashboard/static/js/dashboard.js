/**
 * @file dashboard.js
 * @description Live Hegg energy dashboard.
 *
 * Responsibilities:
 *  1. Connect to /stream via EventSource; reconnect on error.
 *  2. Update the power import/export display and phase cards on every reading.
 *  3. Load history from /api/history on init and range change.
 *  4. Load minute-summary (absolute + delta) from /api/summary/* on init,
 *     range change, and every 60 s.
 *  5. Maintain charts:
 *     - powerChart: net (delivered − returned) in W; vertical flip markers
 *     - voltageCharts[]: one inline sparkline per phase; horizontal min/max
 *     - currentChart: all three phases
 */

"use strict";

/* ── Palette ───────────────────────────────────────────────────────────── */

const COLORS = {
  delivered: "#3b82f6",
  returned:  "#22c55e",
  net:       "#f59e0b",
  l1: "#818cf8",
  l2: "#38bdf8",
  l3: "#fb923c",
};

/* ── Shared Chart.js defaults ───────────────────────────────────────────── */

const BASE_OPTS = {
  responsive: true,
  maintainAspectRatio: false,
  animation: false,
  interaction: { mode: "index", intersect: false },
  elements: {
    point: { radius: 0, hitRadius: 6 },
    line:  { tension: 0.3, borderWidth: 1.5 },
  },
  scales: {
    x: {
      type: "time",
      time: {
        tooltipFormat: "HH:mm:ss",
        displayFormats: { second: "HH:mm:ss", minute: "HH:mm", hour: "HH:mm", day: "MMM d" },
      },
      ticks: { color: "#6b7490", maxTicksLimit: 8, font: { size: 11 } },
      grid:  { color: "rgba(255,255,255,0.04)" },
      border: { display: false },
    },
    y: {
      ticks: { color: "#6b7490", font: { size: 11 } },
      grid:  { color: "rgba(255,255,255,0.04)" },
      border: { display: false },
    },
  },
  plugins: {
    legend: { display: false },
    tooltip: {
      backgroundColor: "rgba(22,26,34,0.95)",
      borderColor: "rgba(255,255,255,0.1)",
      borderWidth: 1,
      titleColor: "#e8eaf0",
      bodyColor: "#9ca3af",
      padding: 10,
    },
    annotation: { annotations: {} },
  },
};

/** Minimal config for inline sparkline charts (no axes, no tooltip). */
const INLINE_OPTS = {
  responsive: true,
  maintainAspectRatio: false,
  animation: false,
  elements: {
    point: { radius: 0 },
    line:  { tension: 0.3, borderWidth: 1.5 },
  },
  scales: {
    x: { display: false, type: "time" },
    y: { display: false },
  },
  plugins: {
    legend:  { display: false },
    tooltip: { enabled: false },
    annotation: { annotations: {} },
  },
};

/* ── State ──────────────────────────────────────────────────────────────── */

/** @type {import('chart.js').Chart} */
let powerChart, currentChart;

/** @type {import('chart.js').Chart[]} Inline charts for L1, L2, L3 voltage. */
let voltageCharts = [];

/** Per-phase voltage extremes for horizontal annotations. */
const voltageExtremes = [
  { min: Infinity, max: -Infinity },
  { min: Infinity, max: -Infinity },
  { min: Infinity, max: -Infinity },
];

let lastWasExporting = null;
let flipCount = 0;
let selectedHours = 24;

/* ── DOM ────────────────────────────────────────────────────────────────── */

let el;

document.addEventListener("DOMContentLoaded", () => {
  el = {
    statusDot:      document.getElementById("status-dot"),
    statusLabel:    document.getElementById("status-label"),
    powerDisplay:   document.getElementById("power-display"),
    powerDirection: document.getElementById("power-direction"),
    powerNetVal:    document.getElementById("power-net-val"),
    voltageL1:      document.getElementById("voltage-l1"),
    voltageL2:      document.getElementById("voltage-l2"),
    voltageL3:      document.getElementById("voltage-l3"),
    currentL1:      document.getElementById("current-l1"),
    currentL2:      document.getElementById("current-l2"),
    currentL3:      document.getElementById("current-l3"),
    serial:         document.getElementById("device-serial"),
    lastUpdated:    document.getElementById("last-updated"),
    historyRange:   document.getElementById("history-range"),
    // Summary strip
    energyIn:       document.getElementById("energy-in"),
    energyOut:      document.getElementById("energy-out"),
    gasDelivered:   document.getElementById("gas-delivered"),
    deviceModel:    document.getElementById("device-model"),
    deviceRssi:     document.getElementById("device-rssi"),
    deviceSw:       document.getElementById("device-sw"),
  };

  initCharts();
  loadHistory(selectedHours);
  loadSummary();

  el.historyRange.addEventListener("change", () => {
    selectedHours = parseInt(el.historyRange.value, 10);
    loadHistory(selectedHours);
    loadSummaryDelta(selectedHours);  // refresh delta for new window
  });

  connectSSE();

  // Summary refreshes once per minute; delta follows the selected window.
  setInterval(loadSummary, 60_000);
});

/* ── Chart init ─────────────────────────────────────────────────────────── */

/**
 * Initialise all Chart.js instances.
 */
function initCharts() {
  Chart.defaults.color = "#6b7490";

  // Power: net only (positive = import, negative = export)
  powerChart = new Chart(document.getElementById("chart-power"), {
    type: "line",
    data: { datasets: [makeDataset("Net", COLORS.net, false)] },
    options: deepMerge(BASE_OPTS, {
      scales: { y: { title: { display: true, text: "W", color: "#6b7490", font: { size: 11 } } } },
    }),
  });

  // Inline voltage sparklines (one per phase)
  ["chart-v-l1", "chart-v-l2", "chart-v-l3"].forEach((id, i) => {
    const color = [COLORS.l1, COLORS.l2, COLORS.l3][i];
    voltageCharts.push(
      new Chart(document.getElementById(id), {
        type: "line",
        data: { datasets: [makeDataset("V", color)] },
        options: JSON.parse(JSON.stringify(INLINE_OPTS)),
      })
    );
  });

  // Current: L1, L2, L3
  currentChart = new Chart(document.getElementById("chart-current"), {
    type: "line",
    data: {
      datasets: [
        makeDataset("L1", COLORS.l1),
        makeDataset("L2", COLORS.l2),
        makeDataset("L3", COLORS.l3),
      ],
    },
    options: deepMerge(BASE_OPTS, {
      scales: { y: { beginAtZero: true, title: { display: true, text: "A", color: "#6b7490", font: { size: 11 } } } },
    }),
  });
}

/**
 * Build a Chart.js dataset descriptor.
 * @param {string}  label
 * @param {string}  color - Hex colour.
 * @param {boolean} [fill=true]
 * @returns {object}
 */
function makeDataset(label, color, fill = true) {
  return {
    label,
    data: [],
    borderColor: color,
    backgroundColor: color + "22",
    fill,
    parsing: false,
  };
}

/**
 * Shallow-merge overrides into a deep copy of base (one level deep).
 * @param {object} base
 * @param {object} overrides
 * @returns {object}
 */
function deepMerge(base, overrides) {
  const out = JSON.parse(JSON.stringify(base));
  if (overrides.scales) {
    out.scales = { ...out.scales };
    for (const [k, v] of Object.entries(overrides.scales)) {
      out.scales[k] = { ...(out.scales[k] || {}), ...v };
    }
  }
  if (overrides.plugins) {
    out.plugins = { ...out.plugins, ...overrides.plugins };
  }
  return out;
}

/* ── History load ───────────────────────────────────────────────────────── */

/**
 * Fetch bucketed history and rebuild all charts.
 * @param {number} hours
 */
async function loadHistory(hours) {
  let data;
  try {
    const res = await fetch(`/api/history?hours=${hours}`);
    if (!res.ok) return;
    data = await res.json();
  } catch { return; }

  if (!data || data.length === 0) return;

  voltageExtremes.forEach(e => { e.min = Infinity; e.max = -Infinity; });
  lastWasExporting = null;
  powerChart.options.plugins.annotation.annotations = {};
  flipCount = 0;

  // Net power.
  powerChart.data.datasets[0].data = toXY(data, r => Math.round((r.power_delivered - r.power_returned) * 1000));

  // Voltage inline charts.
  const vFields = ["voltage_l1", "voltage_l2", "voltage_l3"];
  vFields.forEach((f, i) => {
    voltageCharts[i].data.datasets[0].data = toXY(data, r => r[f]);
  });

  // Current.
  currentChart.data.datasets[0].data = toXY(data, r => r.current_l1);
  currentChart.data.datasets[1].data = toXY(data, r => r.current_l2);
  currentChart.data.datasets[2].data = toXY(data, r => r.current_l3);

  // Compute flip annotations and voltage extremes from history.
  data.forEach((r, i) => {
    const exporting = r.power_returned > r.power_delivered;
    if (i > 0 && exporting !== lastWasExporting) {
      addFlipAnnotation(new Date(r.timestamp).getTime(), exporting);
    }
    lastWasExporting = exporting;

    vFields.forEach((f, j) => {
      const v = r[f];
      if (v < voltageExtremes[j].min) voltageExtremes[j].min = v;
      if (v > voltageExtremes[j].max) voltageExtremes[j].max = v;
    });
  });

  voltageCharts.forEach((_, i) => updateVoltageAnnotation(i));

  powerChart.update();
  voltageCharts.forEach(c => c.update());
  currentChart.update();
}

/**
 * Convert a history array to Chart.js {x, y} points.
 * @param {object[]} data
 * @param {function} yFn
 * @returns {{x: number, y: number}[]}
 */
function toXY(data, yFn) {
  return data.map(r => ({ x: new Date(r.timestamp).getTime(), y: yFn(r) }));
}

/* ── Summary load (absolute + delta) ───────────────────────────────────── */

/**
 * Fetch the latest summary and the delta for the current window, then
 * update the summary strip.
 */
async function loadSummary() {
  await Promise.all([loadSummaryLatest(), loadSummaryDelta(selectedHours)]);
}

/** Fetch and apply the most recent minute-summary (absolute values). */
async function loadSummaryLatest() {
  let s;
  try {
    const res = await fetch("/api/summary/latest");
    if (res.status === 204) return;
    if (!res.ok) return;
    s = await res.json();
  } catch { return; }

  const energyIn  = ((s.energy_delivered_t1 ?? 0) + (s.energy_delivered_t2 ?? 0));
  const energyOut = ((s.energy_returned_t1  ?? 0) + (s.energy_returned_t2  ?? 0));

  setText("energy-in",     energyIn.toFixed(1));
  setText("energy-out",    energyOut.toFixed(1));
  setText("gas-delivered", (s.gas_delivered ?? 0).toFixed(1));
  setText("device-model",  s.model      ?? "—");
  setText("device-rssi",   s.wifi_rssi != null ? `${s.wifi_rssi} dBm` : "—");
  setText("device-sw",     s.sw_version ?? "—");
  if (el.serial) el.serial.textContent = s.serial ?? "—";
}

/**
 * Fetch the delta summary for the given window and update the delta rows.
 * @param {number} hours
 */
async function loadSummaryDelta(hours) {
  let d;
  try {
    const res = await fetch(`/api/summary/delta?hours=${hours}`);
    if (res.status === 204) { clearDeltas(); return; }
    if (!res.ok) return;
    d = await res.json();
  } catch { return; }

  const label = hours >= 24
    ? `${Math.round(hours / 24)}d`
    : `${hours}h`;

  setDelta("energy-in-delta",  d.energy_delivered, label, "kWh");
  setDelta("energy-out-delta", d.energy_returned,  label, "kWh");
  setDelta("gas-delta",        d.gas_delivered,    label, "m³");
}

/**
 * Set a delta element's text and colour class.
 * @param {string} id      - Element ID.
 * @param {number} value   - Numeric delta.
 * @param {string} period  - Period label (e.g. "24h").
 * @param {string} unit    - Unit string.
 */
function setDelta(id, value, period, unit) {
  const el = document.getElementById(id);
  if (!el) return;
  const sign = value >= 0 ? "+" : "";
  el.textContent = `${sign}${value.toFixed(2)} ${unit} / ${period}`;
  el.className = `summary-delta ${value >= 0 ? "summary-delta--pos" : "summary-delta--neg"}`;
}

/** Clear delta elements when no data is available. */
function clearDeltas() {
  ["energy-in-delta", "energy-out-delta", "gas-delta"].forEach(id => {
    const el = document.getElementById(id);
    if (el) { el.textContent = ""; el.className = "summary-delta"; }
  });
}

/* ── SSE stream ─────────────────────────────────────────────────────────── */

let eventSource = null;
let reconnectDelay = 2000;

/** Open the SSE connection and reconnect with back-off on failure. */
function connectSSE() {
  setStatus("connecting", "Connecting…");
  eventSource = new EventSource("/stream");

  eventSource.addEventListener("open", () => {
    setStatus("connected", "Live");
    reconnectDelay = 2000;
  });

  eventSource.addEventListener("message", event => {
    try {
      applyReading(JSON.parse(event.data));
    } catch (err) {
      console.warn("SSE parse error:", err);
    }
  });

  eventSource.addEventListener("error", () => {
    const secs = Math.round(reconnectDelay / 1000);
    setStatus("disconnected", `Reconnecting in ${secs} s…`);
    eventSource.close();
    setTimeout(() => {
      reconnectDelay = Math.min(reconnectDelay * 1.5, 30_000);
      connectSSE();
    }, reconnectDelay);
  });
}

/**
 * @param {"connecting"|"connected"|"disconnected"} state
 * @param {string} label
 */
function setStatus(state, label) {
  el.statusDot.className    = `status-dot ${state}`;
  el.statusLabel.textContent = label;
}

/* ── Reading application ────────────────────────────────────────────────── */

/**
 * Apply a fresh reading to the power display and phase cards.
 * @param {object} r - Parsed HeggReading dict.
 */
function applyReading(r) {
  const delivered = r.power_delivered ?? 0;
  const returned  = r.power_returned  ?? 0;

  // Power import/export display.
  if (delivered > returned) {
    el.powerDisplay.className    = "power-display power-display--import";
    el.powerDirection.textContent = "Import from grid";
    setValue(el.powerNetVal, Math.round(delivered * 1000));
  } else if (returned > delivered) {
    el.powerDisplay.className    = "power-display power-display--export";
    el.powerDirection.textContent = "Export to grid";
    setValue(el.powerNetVal, Math.round(returned * 1000));
  } else {
    el.powerDisplay.className    = "power-display";
    el.powerDirection.textContent = "Balanced";
    setValue(el.powerNetVal, 0);
  }

  setValue(el.voltageL1, (r.voltage_l1 ?? 0).toFixed(1));
  setValue(el.voltageL2, (r.voltage_l2 ?? 0).toFixed(1));
  setValue(el.voltageL3, (r.voltage_l3 ?? 0).toFixed(1));
  setValue(el.currentL1, (r.current_l1 ?? 0).toFixed(1));
  setValue(el.currentL2, (r.current_l2 ?? 0).toFixed(1));
  setValue(el.currentL3, (r.current_l3 ?? 0).toFixed(1));

  if (el.lastUpdated) el.lastUpdated.textContent = new Date(r.timestamp).toLocaleTimeString();

  appendToCharts(r);
}

/**
 * Set element text content and trigger the flash animation.
 * @param {HTMLElement} elem
 * @param {string|number} val
 */
function setValue(elem, val) {
  if (!elem) return;
  elem.textContent = String(val);
  elem.classList.remove("value-updated");
  void elem.offsetWidth;
  elem.classList.add("value-updated");
}

/** Set the textContent of an element by ID (no flash animation). */
function setText(id, val) {
  const el = document.getElementById(id);
  if (el) el.textContent = val;
}

/* ── Chart live append ──────────────────────────────────────────────────── */

/**
 * Append one live reading to all charts.
 * @param {object} r
 */
function appendToCharts(r) {
  const ts = new Date(r.timestamp).getTime();

  // Net power.
  powerChart.data.datasets[0].data.push({
    x: ts,
    y: Math.round((r.power_delivered - r.power_returned) * 1000),
  });

  const exporting = r.power_returned > r.power_delivered;
  if (lastWasExporting !== null && exporting !== lastWasExporting) {
    addFlipAnnotation(ts, exporting);
  }
  lastWasExporting = exporting;

  // Voltage inline charts + extremes.
  const voltages = [r.voltage_l1, r.voltage_l2, r.voltage_l3];
  voltages.forEach((v, i) => {
    voltageCharts[i].data.datasets[0].data.push({ x: ts, y: v });
    let changed = false;
    if (v < voltageExtremes[i].min) { voltageExtremes[i].min = v; changed = true; }
    if (v > voltageExtremes[i].max) { voltageExtremes[i].max = v; changed = true; }
    if (changed) updateVoltageAnnotation(i);
  });

  // Current.
  currentChart.data.datasets[0].data.push({ x: ts, y: r.current_l1 });
  currentChart.data.datasets[1].data.push({ x: ts, y: r.current_l2 });
  currentChart.data.datasets[2].data.push({ x: ts, y: r.current_l3 });

  // Trim old points.
  const cutoff = Date.now() - selectedHours * 3600 * 1000;
  trimOldPoints(powerChart, cutoff);
  voltageCharts.forEach(c => trimOldPoints(c, cutoff));
  trimOldPoints(currentChart, cutoff);

  powerChart.update("none");
  voltageCharts.forEach(c => c.update("none"));
  currentChart.update("none");
}

/**
 * Drop points older than cutoff from all datasets in a chart.
 * @param {import('chart.js').Chart} chart
 * @param {number} cutoff - Unix ms.
 */
function trimOldPoints(chart, cutoff) {
  for (const ds of chart.data.datasets) {
    while (ds.data.length > 0 && ds.data[0].x < cutoff) ds.data.shift();
  }
}

/* ── Annotations ────────────────────────────────────────────────────────── */

/**
 * Add a vertical dashed line at a power-direction flip point.
 * @param {number}  tsMs
 * @param {boolean} toExport
 */
function addFlipAnnotation(tsMs, toExport) {
  const id    = `flip_${flipCount++}`;
  const color = toExport ? "rgba(34,197,94,0.55)" : "rgba(59,130,246,0.55)";
  const label = toExport ? "→ Export" : "→ Import";
  powerChart.options.plugins.annotation.annotations[id] = {
    type: "line",
    scaleID: "x",
    value: tsMs,
    borderColor: color,
    borderWidth: 1,
    borderDash: [4, 4],
    label: {
      display: true,
      content: label,
      position: "start",
      backgroundColor: color,
      color: "#fff",
      font: { size: 9, weight: "600" },
      padding: { x: 4, y: 2 },
      rotation: -90,
    },
  };
}

/**
 * Rebuild the min/max horizontal annotations for one voltage phase chart,
 * and set the Y scale to include padding above and below.
 * @param {number} phaseIndex - 0=L1, 1=L2, 2=L3.
 */
function updateVoltageAnnotation(phaseIndex) {
  const { min, max } = voltageExtremes[phaseIndex];
  if (!isFinite(min) || !isFinite(max)) return;

  const range = Math.max(max - min, 1);
  const pad   = Math.max(2, range * 0.25);
  const chart = voltageCharts[phaseIndex];
  chart.options.scales.y.min = min - pad;
  chart.options.scales.y.max = max + pad;

  chart.options.plugins.annotation.annotations = {
    vMin: {
      type: "line", scaleID: "y", value: min,
      borderColor: "rgba(239,68,68,0.7)", borderWidth: 1, borderDash: [4, 3],
      label: {
        display: true, content: `${min.toFixed(1)} V`, position: "start",
        backgroundColor: "rgba(239,68,68,0.8)", color: "#fff",
        font: { size: 8, weight: "600" }, padding: { x: 3, y: 1 },
      },
    },
    vMax: {
      type: "line", scaleID: "y", value: max,
      borderColor: "rgba(59,130,246,0.7)", borderWidth: 1, borderDash: [4, 3],
      label: {
        display: true, content: `${max.toFixed(1)} V`, position: "start",
        backgroundColor: "rgba(59,130,246,0.8)", color: "#fff",
        font: { size: 8, weight: "600" }, padding: { x: 3, y: 1 },
      },
    },
  };
}

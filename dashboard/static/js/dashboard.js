/**
 * @file dashboard.js
 * @description Live Hegg energy dashboard.
 *
 * Responsibilities:
 *  1. Connect to /stream via EventSource; reconnect on error.
 *  2. Update live-value cards on every reading (power, voltage, current).
 *  3. Load history from /api/history on init and range change.
 *  4. Load minute-summary from /api/summary/latest on init and every 60 s.
 *  5. Maintain charts:
 *     - powerChart: delivered + returned + net (vertical flip annotations)
 *     - voltageCharts[]: one inline sparkline per phase (horizontal min/max)
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

/** Tracks whether the last point was exporting (returned > delivered). */
let lastWasExporting = null;
let flipCount = 0;

let selectedHours = 24;

/* ── DOM ────────────────────────────────────────────────────────────────── */

let el;

document.addEventListener("DOMContentLoaded", () => {
  el = {
    statusDot:      document.getElementById("status-dot"),
    statusLabel:    document.getElementById("status-label"),
    powerDelivered: document.getElementById("power-delivered"),
    powerReturned:  document.getElementById("power-returned"),
    voltageL1:      document.getElementById("voltage-l1"),
    voltageL2:      document.getElementById("voltage-l2"),
    voltageL3:      document.getElementById("voltage-l3"),
    currentL1:      document.getElementById("current-l1"),
    currentL2:      document.getElementById("current-l2"),
    currentL3:      document.getElementById("current-l3"),
    barDelivered:   document.getElementById("bar-delivered"),
    barReturned:    document.getElementById("bar-returned"),
    serial:         document.getElementById("device-serial"),
    lastUpdated:    document.getElementById("last-updated"),
    historyRange:   document.getElementById("history-range"),
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
  connectSSE();

  el.historyRange.addEventListener("change", () => {
    selectedHours = parseInt(el.historyRange.value, 10);
    loadHistory(selectedHours);
  });

  // Refresh summary every 60 s (it updates once per minute at the device).
  setInterval(loadSummary, 60_000);
});

/* ── Chart init ─────────────────────────────────────────────────────────── */

/**
 * Initialise all Chart.js instances.
 * powerChart and currentChart are full-width; voltageCharts are inline sparklines.
 */
function initCharts() {
  Chart.defaults.color = "#6b7490";

  // Power: delivered, returned, net
  powerChart = new Chart(document.getElementById("chart-power"), {
    type: "line",
    data: {
      datasets: [
        makeDataset("Delivered", COLORS.delivered),
        makeDataset("Returned",  COLORS.returned),
        makeDataset("Net",       COLORS.net, /*fill*/ false),
      ],
    },
    options: deepMerge(BASE_OPTS, {
      scales: { y: { beginAtZero: true, title: { display: true, text: "kW", color: "#6b7490", font: { size: 11 } } } },
    }),
  });

  // Inline voltage sparklines (one per phase)
  ["chart-v-l1", "chart-v-l2", "chart-v-l3"].forEach((id, i) => {
    const color = [COLORS.l1, COLORS.l2, COLORS.l3][i];
    voltageCharts.push(
      new Chart(document.getElementById(id), {
        type: "line",
        data: { datasets: [makeDataset("V", color)] },
        options: JSON.parse(JSON.stringify(INLINE_OPTS)), // deep-copy per instance
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
 * @param {string}  label - Tooltip label.
 * @param {string}  color - Hex colour.
 * @param {boolean} [fill=true] - Whether to fill the area under the line.
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
 * Shallow-merge overrides into a deep copy of base.
 * Handles one level of nesting for scales and plugins.
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

  // Reset state.
  voltageExtremes.forEach(e => { e.min = Infinity; e.max = -Infinity; });
  lastWasExporting = null;
  powerChart.options.plugins.annotation.annotations = {};
  flipCount = 0;

  // Power datasets.
  powerChart.data.datasets[0].data = toXY(data, r => r.power_delivered);
  powerChart.data.datasets[1].data = toXY(data, r => r.power_returned);
  powerChart.data.datasets[2].data = toXY(data, r => r.power_delivered - r.power_returned);

  // Voltage inline charts + per-phase extremes.
  const vFields = ["voltage_l1", "voltage_l2", "voltage_l3"];
  vFields.forEach((f, i) => {
    voltageCharts[i].data.datasets[0].data = toXY(data, r => r[f]);
  });

  // Current chart.
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
 * @param {function} yFn - Extracts the Y value from a row.
 * @returns {{x: number, y: number}[]}
 */
function toXY(data, yFn) {
  return data.map(r => ({ x: new Date(r.timestamp).getTime(), y: yFn(r) }));
}

/* ── Summary load ───────────────────────────────────────────────────────── */

/** Fetch the most recent minute-summary and update the cumulative cards. */
async function loadSummary() {
  let s;
  try {
    const res = await fetch("/api/summary/latest");
    if (res.status === 204) return;
    if (!res.ok) return;
    s = await res.json();
  } catch { return; }

  const energyIn  = (s.energy_delivered_t1 ?? 0) + (s.energy_delivered_t2 ?? 0);
  const energyOut = (s.energy_returned_t1  ?? 0) + (s.energy_returned_t2  ?? 0);

  el.energyIn.textContent    = energyIn.toFixed(1);
  el.energyOut.textContent   = energyOut.toFixed(1);
  el.gasDelivered.textContent = (s.gas_delivered ?? 0).toFixed(1);
  el.deviceModel.textContent = s.model      ?? "—";
  el.deviceRssi.textContent  = s.wifi_rssi != null ? `${s.wifi_rssi} dBm` : "—";
  el.deviceSw.textContent    = s.sw_version ?? "—";
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
 * Update the connection-status pill.
 * @param {"connecting"|"connected"|"disconnected"} state
 * @param {string} label
 */
function setStatus(state, label) {
  el.statusDot.className   = `status-dot ${state}`;
  el.statusLabel.textContent = label;
}

/* ── Reading application ────────────────────────────────────────────────── */

let maxPowerSeen = 1;

/**
 * Apply a fresh reading to the cards and append to charts.
 * @param {object} r - Parsed HeggReading dict.
 */
function applyReading(r) {
  const delivered = r.power_delivered ?? 0;
  const returned  = r.power_returned  ?? 0;

  setValue(el.powerDelivered, delivered.toFixed(3));
  setValue(el.powerReturned,  returned.toFixed(3));

  maxPowerSeen = Math.max(maxPowerSeen, delivered, returned, 0.001);
  el.barDelivered.style.width = `${(delivered / maxPowerSeen) * 100}%`;
  el.barReturned.style.width  = `${(returned  / maxPowerSeen) * 100}%`;

  setValue(el.voltageL1, (r.voltage_l1 ?? 0).toFixed(1));
  setValue(el.voltageL2, (r.voltage_l2 ?? 0).toFixed(1));
  setValue(el.voltageL3, (r.voltage_l3 ?? 0).toFixed(1));
  setValue(el.currentL1, (r.current_l1 ?? 0).toFixed(1));
  setValue(el.currentL2, (r.current_l2 ?? 0).toFixed(1));
  setValue(el.currentL3, (r.current_l3 ?? 0).toFixed(1));

  el.serial.textContent      = r.serial ?? "—";
  el.lastUpdated.textContent = new Date(r.timestamp).toLocaleTimeString();

  appendToCharts(r);
}

/**
 * Set element text and trigger the flash animation.
 * @param {HTMLElement} elem
 * @param {string} val
 */
function setValue(elem, val) {
  elem.textContent = val;
  elem.classList.remove("value-updated");
  void elem.offsetWidth;
  elem.classList.add("value-updated");
}

/* ── Chart live append ──────────────────────────────────────────────────── */

/**
 * Append one live reading to all charts, detect flips and voltage extremes.
 * @param {object} r
 */
function appendToCharts(r) {
  const ts = new Date(r.timestamp).getTime();

  // Power + net.
  powerChart.data.datasets[0].data.push({ x: ts, y: r.power_delivered });
  powerChart.data.datasets[1].data.push({ x: ts, y: r.power_returned });
  powerChart.data.datasets[2].data.push({ x: ts, y: r.power_delivered - r.power_returned });

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
 * Drop data points older than cutoff from every dataset in a chart.
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
 * Add a vertical dashed line to the power chart at a direction-flip point.
 * @param {number}  tsMs     - Unix ms timestamp.
 * @param {boolean} toExport - True when flipping to grid export.
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
 * Rebuild the min/max horizontal annotations for one voltage phase chart.
 * @param {number} phaseIndex - 0=L1, 1=L2, 2=L3.
 */
function updateVoltageAnnotation(phaseIndex) {
  const { min, max } = voltageExtremes[phaseIndex];
  if (!isFinite(min) || !isFinite(max)) return;

  const chart = voltageCharts[phaseIndex];
  chart.options.plugins.annotation.annotations = {
    vMin: {
      type: "line",
      scaleID: "y",
      value: min,
      borderColor: "rgba(239,68,68,0.7)",
      borderWidth: 1,
      borderDash: [4, 3],
      label: {
        display: true,
        content: `${min} V`,
        position: "start",
        backgroundColor: "rgba(239,68,68,0.8)",
        color: "#fff",
        font: { size: 8, weight: "600" },
        padding: { x: 3, y: 1 },
      },
    },
    vMax: {
      type: "line",
      scaleID: "y",
      value: max,
      borderColor: "rgba(59,130,246,0.7)",
      borderWidth: 1,
      borderDash: [4, 3],
      label: {
        display: true,
        content: `${max} V`,
        position: "start",
        backgroundColor: "rgba(59,130,246,0.8)",
        color: "#fff",
        font: { size: 8, weight: "600" },
        padding: { x: 3, y: 1 },
      },
    },
  };
}

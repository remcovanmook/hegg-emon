/**
 * @file dashboard.js
 * @description Live Hegg energy dashboard.
 *
 * Responsibilities:
 *  1. Connect to /stream via EventSource; keep-alive reconnect on error.
 *  2. Update live-value cards on every reading.
 *  3. Load historical data from /api/history on init and on range change.
 *  4. Maintain three Chart.js time-series charts (power, voltage, current).
 *  5. Add vertical flip annotations to the power chart whenever the dominant
 *     power direction switches between delivered and returned.
 *  6. Add horizontal min/max annotations to the voltage chart.
 *  7. Append live SSE readings to chart data; trim anything older than the
 *     selected window.
 */

"use strict";

/* ── Constants ─────────────────────────────────────────────────────────── */

const COLORS = {
  delivered: "#3b82f6",
  returned:  "#22c55e",
  l1: "#818cf8",
  l2: "#38bdf8",
  l3: "#fb923c",
};

const CHART_DEFAULTS = {
  responsive: true,
  maintainAspectRatio: false,
  animation: false,          // disable for live updates
  interaction: { mode: "index", intersect: false },
  elements: {
    point:  { radius: 0, hitRadius: 6 },
    line:   { tension: 0.3, borderWidth: 1.5 },
  },
  scales: {
    x: {
      type: "time",
      time: { tooltipFormat: "HH:mm:ss", displayFormats: { second: "HH:mm:ss", minute: "HH:mm", hour: "HH:mm", day: "MMM d" } },
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
  },
};

/* ── State ─────────────────────────────────────────────────────────────── */

/** @type {import('chart.js').Chart} */
let powerChart, voltageChart, currentChart;

/** Observed extremes for the voltage chart annotations. */
let voltageMin = Infinity;
let voltageMax = -Infinity;

/** Track whether the last data point was exporting to grid (returned > delivered). */
let lastWasExporting = null;

/** Currently selected history window in hours. */
let selectedHours = 24;

/* ── DOM refs ───────────────────────────────────────────────────────────── */

let el;

document.addEventListener("DOMContentLoaded", () => {
  el = {
    statusDot:      document.getElementById("status-dot"),
    statusLabel:    document.getElementById("status-label"),
    powerDelivered: document.getElementById("power-delivered"),
    powerReturned:  document.getElementById("power-returned"),
    powerNet:       document.getElementById("power-net"),
    netHint:        document.getElementById("net-hint"),
    barDelivered:   document.getElementById("bar-delivered"),
    barReturned:    document.getElementById("bar-returned"),
    voltageL1:      document.getElementById("voltage-l1"),
    voltageL2:      document.getElementById("voltage-l2"),
    voltageL3:      document.getElementById("voltage-l3"),
    currentL1:      document.getElementById("current-l1"),
    currentL2:      document.getElementById("current-l2"),
    currentL3:      document.getElementById("current-l3"),
    serial:         document.getElementById("device-serial"),
    lastUpdated:    document.getElementById("last-updated"),
    historyRange:   document.getElementById("history-range"),
  };

  initCharts();
  loadHistory(selectedHours);
  connectSSE();

  el.historyRange.addEventListener("change", () => {
    selectedHours = parseInt(el.historyRange.value, 10);
    loadHistory(selectedHours);
  });
});

/* ── Chart initialisation ───────────────────────────────────────────────── */

/**
 * Build all three Chart.js instances with empty datasets.
 * History and live data are pushed in separately.
 */
function initCharts() {
  Chart.defaults.color = "#6b7490";

  powerChart = new Chart(document.getElementById("chart-power"), {
    type: "line",
    data: {
      datasets: [
        makeDataset("Delivered", COLORS.delivered),
        makeDataset("Returned",  COLORS.returned),
      ],
    },
    options: mergeOptions({
      scales: {
        y: { beginAtZero: true, title: { display: true, text: "kW", color: "#6b7490", font: { size: 11 } } },
      },
      plugins: {
        annotation: { annotations: {} },
      },
    }),
  });

  voltageChart = new Chart(document.getElementById("chart-voltage"), {
    type: "line",
    data: {
      datasets: [
        makeDataset("L1", COLORS.l1),
        makeDataset("L2", COLORS.l2),
        makeDataset("L3", COLORS.l3),
      ],
    },
    options: mergeOptions({
      scales: {
        y: { title: { display: true, text: "V", color: "#6b7490", font: { size: 11 } } },
      },
      plugins: {
        annotation: { annotations: {} },
      },
    }),
  });

  currentChart = new Chart(document.getElementById("chart-current"), {
    type: "line",
    data: {
      datasets: [
        makeDataset("L1", COLORS.l1),
        makeDataset("L2", COLORS.l2),
        makeDataset("L3", COLORS.l3),
      ],
    },
    options: mergeOptions({
      scales: {
        y: { beginAtZero: true, title: { display: true, text: "A", color: "#6b7490", font: { size: 11 } } },
      },
      plugins: {
        annotation: { annotations: {} },
      },
    }),
  });
}

/**
 * Construct a Chart.js dataset descriptor with consistent styling.
 * @param {string} label - Series label shown in tooltips.
 * @param {string} color - CSS hex colour.
 * @returns {object} Chart.js dataset config.
 */
function makeDataset(label, color) {
  return {
    label,
    data: [],
    borderColor: color,
    backgroundColor: color + "22",
    fill: true,
    parsing: false,  // data already in {x, y} form
  };
}

/**
 * Deep-merge custom options on top of CHART_DEFAULTS.
 * Only handles one level of nesting (scales.*, plugins.*).
 * @param {object} overrides - Chart-specific option overrides.
 * @returns {object} Merged options object.
 */
function mergeOptions(overrides) {
  return {
    ...CHART_DEFAULTS,
    scales: {
      ...CHART_DEFAULTS.scales,
      ...(overrides.scales || {}),
      x: { ...CHART_DEFAULTS.scales.x, ...(overrides.scales?.x || {}) },
      y: { ...CHART_DEFAULTS.scales.y, ...(overrides.scales?.y || {}) },
    },
    plugins: {
      ...CHART_DEFAULTS.plugins,
      ...(overrides.plugins || {}),
    },
  };
}

/* ── History loading ────────────────────────────────────────────────────── */

/**
 * Fetch bucketed history from /api/history and repopulate the charts.
 * Resets all annotations and recalculates voltage extremes.
 * @param {number} hours - Window width in hours (1–168).
 */
async function loadHistory(hours) {
  let data;
  try {
    const res = await fetch(`/api/history?hours=${hours}`);
    if (!res.ok) { console.warn("History fetch failed:", res.status); return; }
    data = await res.json();
  } catch (err) {
    console.warn("History fetch error:", err);
    return;
  }

  if (!data || data.length === 0) return;

  // Reset extremes before rebuilding from history.
  voltageMin = Infinity;
  voltageMax = -Infinity;
  lastWasExporting = null;
  powerChart.options.plugins.annotation.annotations = {};

  // Populate chart datasets.
  powerChart.data.datasets[0].data   = toXY(data, "power_delivered");
  powerChart.data.datasets[1].data   = toXY(data, "power_returned");

  voltageChart.data.datasets[0].data = toXY(data, "voltage_l1");
  voltageChart.data.datasets[1].data = toXY(data, "voltage_l2");
  voltageChart.data.datasets[2].data = toXY(data, "voltage_l3");

  currentChart.data.datasets[0].data = toXY(data, "current_l1");
  currentChart.data.datasets[1].data = toXY(data, "current_l2");
  currentChart.data.datasets[2].data = toXY(data, "current_l3");

  // Compute flip annotations and voltage extremes from history.
  data.forEach((r, i) => {
    const exporting = r.power_returned > r.power_delivered;
    if (i > 0 && exporting !== lastWasExporting) {
      addFlipAnnotation(new Date(r.timestamp), exporting);
    }
    lastWasExporting = exporting;

    voltageMin = Math.min(voltageMin, r.voltage_l1, r.voltage_l2, r.voltage_l3);
    voltageMax = Math.max(voltageMax, r.voltage_l1, r.voltage_l2, r.voltage_l3);
  });

  updateVoltageAnnotations();

  powerChart.update();
  voltageChart.update();
  currentChart.update();
}

/**
 * Convert an array of reading objects to Chart.js {x, y} point pairs.
 * @param {object[]} data  - Array of reading dicts from /api/history.
 * @param {string}   field - Reading field name to use as Y value.
 * @returns {{x: number, y: number}[]}
 */
function toXY(data, field) {
  return data.map(r => ({ x: new Date(r.timestamp).getTime(), y: r[field] }));
}

/* ── SSE live stream ────────────────────────────────────────────────────── */

let eventSource = null;
let reconnectDelay = 2000;

/** Open the SSE connection; reconnect with back-off on failure. */
function connectSSE() {
  setStatus("connecting", "Connecting…");
  eventSource = new EventSource("/stream");

  eventSource.addEventListener("open", () => {
    setStatus("connected", "Live");
    reconnectDelay = 2000;
  });

  eventSource.addEventListener("message", (event) => {
    try {
      applyReading(JSON.parse(event.data));
    } catch (err) {
      console.warn("SSE parse error:", err);
    }
  });

  eventSource.addEventListener("error", () => {
    setStatus("disconnected", `Reconnecting in ${Math.round(reconnectDelay / 1000)} s…`);
    eventSource.close();
    setTimeout(() => {
      reconnectDelay = Math.min(reconnectDelay * 1.5, 30000);
      connectSSE();
    }, reconnectDelay);
  });
}

/**
 * Update the connection-status indicator pill.
 * @param {"connecting"|"connected"|"disconnected"} state
 * @param {string} label
 */
function setStatus(state, label) {
  el.statusDot.className = `status-dot ${state}`;
  el.statusLabel.textContent = label;
}

/* ── Reading application ────────────────────────────────────────────────── */

/** Max power seen — used to scale progress bars. */
let maxPowerSeen = 1;

/**
 * Apply a fresh reading to the live cards and append it to charts.
 * @param {object} r - Parsed HeggReading dict from SSE.
 */
function applyReading(r) {
  const delivered = r.power_delivered ?? 0;
  const returned  = r.power_returned  ?? 0;
  const net       = delivered - returned;

  setValue(el.powerDelivered, delivered.toFixed(3));
  setValue(el.powerReturned,  returned.toFixed(3));
  setValue(el.powerNet, Math.abs(net).toFixed(3));
  el.netHint.textContent = net > 0.001 ? "importing" : net < -0.001 ? "exporting" : "balanced";

  maxPowerSeen = Math.max(maxPowerSeen, delivered, returned, 0.001);
  el.barDelivered.style.width = `${(delivered / maxPowerSeen) * 100}%`;
  el.barReturned.style.width  = `${(returned  / maxPowerSeen) * 100}%`;

  setValue(el.voltageL1, r.voltage_l1);
  setValue(el.voltageL2, r.voltage_l2);
  setValue(el.voltageL3, r.voltage_l3);
  setValue(el.currentL1, r.current_l1);
  setValue(el.currentL2, r.current_l2);
  setValue(el.currentL3, r.current_l3);

  el.serial.textContent      = r.serial ?? "—";
  el.lastUpdated.textContent = new Date(r.timestamp).toLocaleTimeString();

  appendToCharts(r);
}

/**
 * Set element text and trigger flash animation.
 * @param {HTMLElement} elem
 * @param {string|number} val
 */
function setValue(elem, val) {
  elem.textContent = val;
  elem.classList.remove("value-updated");
  void elem.offsetWidth;
  elem.classList.add("value-updated");
}

/* ── Chart live append ──────────────────────────────────────────────────── */

/**
 * Push one live reading onto all three charts.
 * Detects power direction flips and voltage extremes and updates annotations.
 * Trims points outside the selected history window.
 * @param {object} r - Parsed HeggReading dict.
 */
function appendToCharts(r) {
  const ts = new Date(r.timestamp).getTime();

  // Power
  powerChart.data.datasets[0].data.push({ x: ts, y: r.power_delivered });
  powerChart.data.datasets[1].data.push({ x: ts, y: r.power_returned });

  // Flip detection
  const exporting = r.power_returned > r.power_delivered;
  if (lastWasExporting !== null && exporting !== lastWasExporting) {
    addFlipAnnotation(new Date(r.timestamp), exporting);
  }
  lastWasExporting = exporting;

  // Voltage
  voltageChart.data.datasets[0].data.push({ x: ts, y: r.voltage_l1 });
  voltageChart.data.datasets[1].data.push({ x: ts, y: r.voltage_l2 });
  voltageChart.data.datasets[2].data.push({ x: ts, y: r.voltage_l3 });

  // Voltage extremes
  const newMin = Math.min(r.voltage_l1, r.voltage_l2, r.voltage_l3);
  const newMax = Math.max(r.voltage_l1, r.voltage_l2, r.voltage_l3);
  let extremeChanged = false;
  if (newMin < voltageMin) { voltageMin = newMin; extremeChanged = true; }
  if (newMax > voltageMax) { voltageMax = newMax; extremeChanged = true; }
  if (extremeChanged) updateVoltageAnnotations();

  // Current
  currentChart.data.datasets[0].data.push({ x: ts, y: r.current_l1 });
  currentChart.data.datasets[1].data.push({ x: ts, y: r.current_l2 });
  currentChart.data.datasets[2].data.push({ x: ts, y: r.current_l3 });

  // Trim points older than selected window.
  const cutoff = Date.now() - selectedHours * 3600 * 1000;
  trimOldPoints(powerChart,   cutoff);
  trimOldPoints(voltageChart, cutoff);
  trimOldPoints(currentChart, cutoff);

  powerChart.update("none");
  voltageChart.update("none");
  currentChart.update("none");
}

/**
 * Remove data points with x < cutoff from all datasets in a chart.
 * @param {import('chart.js').Chart} chart
 * @param {number} cutoff - Unix timestamp ms.
 */
function trimOldPoints(chart, cutoff) {
  for (const ds of chart.data.datasets) {
    while (ds.data.length > 0 && ds.data[0].x < cutoff) {
      ds.data.shift();
    }
  }
}

/* ── Annotations ────────────────────────────────────────────────────────── */

let flipCount = 0;

/**
 * Add a vertical annotation to the power chart at a direction-flip point.
 * Green lines mark transitions to exporting; blue mark transitions to importing.
 * @param {Date}    ts       - Timestamp of the flip.
 * @param {boolean} toExport - True when direction flips to grid export.
 */
function addFlipAnnotation(ts, toExport) {
  const id = `flip_${flipCount++}`;
  const color = toExport ? "rgba(34, 197, 94, 0.55)" : "rgba(59, 130, 246, 0.55)";
  const label = toExport ? "→ Export" : "→ Import";

  powerChart.options.plugins.annotation.annotations[id] = {
    type: "line",
    scaleID: "x",
    value: ts.getTime(),
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
      yAdjust: 0,
    },
  };
}

/**
 * Rebuild the voltage chart's horizontal min/max annotation lines.
 * Called whenever new extremes are observed.
 */
function updateVoltageAnnotations() {
  if (!isFinite(voltageMin) || !isFinite(voltageMax)) return;

  voltageChart.options.plugins.annotation.annotations = {
    voltMin: {
      type: "line",
      scaleID: "y",
      value: voltageMin,
      borderColor: "rgba(239, 68, 68, 0.6)",
      borderWidth: 1,
      borderDash: [5, 4],
      label: {
        display: true,
        content: `Min ${voltageMin} V`,
        position: "start",
        backgroundColor: "rgba(239, 68, 68, 0.75)",
        color: "#fff",
        font: { size: 9, weight: "600" },
        padding: { x: 4, y: 2 },
      },
    },
    voltMax: {
      type: "line",
      scaleID: "y",
      value: voltageMax,
      borderColor: "rgba(59, 130, 246, 0.6)",
      borderWidth: 1,
      borderDash: [5, 4],
      label: {
        display: true,
        content: `Max ${voltageMax} V`,
        position: "start",
        backgroundColor: "rgba(59, 130, 246, 0.75)",
        color: "#fff",
        font: { size: 9, weight: "600" },
        padding: { x: 4, y: 2 },
      },
    },
  };
}

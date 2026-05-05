/**
 * @file dashboard.js
 * @description Live Hegg energy dashboard.
 *
 * Charts:
 *   powerChart      — net power (W), always includes zero on Y axis
 *   voltageCharts[] — 3 inline sparklines (L1/L2/L3), visible Y axis,
 *                     per-phase min/max annotations
 *   currentCharts[] — 3 inline sparklines (L1/L2/L3), visible Y axis,
 *                     Y scale padded to observed range
 *
 * Data sources:
 *   /stream              — SSE; 1 reading/s
 *   /api/history         — bucketed history on load and range change
 *   /api/summary/latest  — latest minute packet (absolute meter values)
 *   /api/summary/delta   — delta over selected window (per-tariff)
 *   /api/device          — locked device IP, model, serial
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

/* ── Shared Chart.js config ─────────────────────────────────────────────── */

/** Base options shared by the full-width power and current charts. */
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

/**
 * Build Chart.js options for an inline sparkline.
 * Y axis is displayed on the right with 3 ticks; X axis is hidden.
 * @param {function} [tickFmt] - Optional tick formatter.
 * @returns {object}
 */
function makeInlineOpts(tickFmt) {
  return {
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    elements: {
      point: { radius: 0 },
      line:  { tension: 0.3, borderWidth: 1.5 },
    },
    scales: {
      x: { display: false, type: "time" },
      y: {
        display: true,
        position: "left",
        ticks: {
          maxTicksLimit: 3,
          color: "#6b7490",
          font: { size: 9 },
          ...(tickFmt ? { callback: tickFmt } : {}),
        },
        grid:   { color: "rgba(255,255,255,0.04)" },
        border: { display: false },
      },
    },
    plugins: {
      legend:  { display: false },
      tooltip: { enabled: false },
      annotation: { annotations: {} },
    },
  };
}

/* ── State ──────────────────────────────────────────────────────────────── */

let powerChart;

/** @type {import('chart.js').Chart[]} Inline voltage charts L1/L2/L3. */
let voltageCharts = [];

/** @type {import('chart.js').Chart[]} Inline current charts L1/L2/L3. */
let currentCharts = [];

/** Observed per-phase voltage extremes (for Y scale padding + annotations). */
const voltageExtremes = [
  { min: Infinity, max: -Infinity },
  { min: Infinity, max: -Infinity },
  { min: Infinity, max: -Infinity },
];

/** Observed per-phase current extremes (for Y scale padding). */
const currentExtremes = [
  { min: Infinity, max: -Infinity },
  { min: Infinity, max: -Infinity },
  { min: Infinity, max: -Infinity },
];

let lastWasExporting = null;
let flipCount = 0;
let selectedHours = 24;

/* ── DOM ────────────────────────────────────────────────────────────────── */

let el;

document.addEventListener("DOMContentLoaded", async () => {
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
    lastUpdated:    document.getElementById("last-updated"),
    historyRange:   document.getElementById("history-range"),
  };

  initCharts();
  await loadHistory(selectedHours);
  await loadSummary();
  loadDevice();
  connectSSE();

  el.historyRange.addEventListener("change", () => {
    selectedHours = parseInt(el.historyRange.value, 10);
    loadHistory(selectedHours);
    loadSummaryDelta(selectedHours);
  });

  // Minute-level refresh for absolute values; device info is static.
  setInterval(loadSummary, 60_000);
  setInterval(loadDevice,  300_000);

  // Clock — updates every second.
  const tickClock = () => setText("header-time", new Date().toLocaleTimeString());
  tickClock();
  setInterval(tickClock, 1000);
});

/* ── Chart init ─────────────────────────────────────────────────────────── */

/** Initialise all Chart.js instances. */
function initCharts() {
  Chart.defaults.color = "#6b7490";

  // Power chart: net only; afterDataLimits always includes zero.
  const powerOpts = JSON.parse(JSON.stringify(BASE_OPTS));
  powerOpts.scales.y.afterDataLimits = scale => {
    scale.min = Math.min(scale.min, 0);
    scale.max = Math.max(scale.max, 0);
  };
  powerOpts.scales.y.title = { display: true, text: "W", color: "#6b7490", font: { size: 11 } };

  // Power chart: net (W); blue above zero = import, green below = export.
  // segment colours each line segment based on sign of the starting point.
  // fill: "origin" shades the area between the line and zero.
  powerChart = new Chart(document.getElementById("chart-power"), {
    type: "line",
    data: {
      datasets: [{
        label: "Net",
        data: [],
        borderColor: COLORS.net,           // fallback before first point
        backgroundColor: "transparent",   // overridden per-segment
        fill: "origin",
        parsing: false,
        tension: 0.3,
        pointRadius: 0,
        pointHitRadius: 6,
        borderWidth: 1.5,
        segment: {
          /** Colour each segment based on the sign of its left-hand point. */
          borderColor: ctx =>
            ctx.p0.parsed.y >= 0 ? COLORS.delivered : COLORS.returned,
          backgroundColor: ctx =>
            ctx.p0.parsed.y >= 0
              ? COLORS.delivered + "22"
              : COLORS.returned  + "22",
        },
      }],
    },
    options: powerOpts,
  });

  // Inline voltage sparklines.
  ["chart-v-l1", "chart-v-l2", "chart-v-l3"].forEach((id, i) => {
    voltageCharts.push(new Chart(document.getElementById(id), {
      type: "line",
      data: { datasets: [makeDataset("V", [COLORS.l1, COLORS.l2, COLORS.l3][i])] },
      options: makeInlineOpts(v => v.toFixed(0)),
    }));
  });

  // Inline current sparklines.
  ["chart-c-l1", "chart-c-l2", "chart-c-l3"].forEach((id, i) => {
    currentCharts.push(new Chart(document.getElementById(id), {
      type: "line",
      data: { datasets: [makeDataset("A", [COLORS.l1, COLORS.l2, COLORS.l3][i])] },
      options: makeInlineOpts(v => v.toFixed(1)),
    }));
  });
}

/**
 * Build a Chart.js dataset descriptor.
 * @param {string}  label
 * @param {string}  color
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

  // Reset tracked state.
  voltageExtremes.forEach(e => { e.min = Infinity; e.max = -Infinity; });
  currentExtremes.forEach(e => { e.min = Infinity; e.max = -Infinity; });
  lastWasExporting = null;
  powerChart.options.plugins.annotation.annotations = {};
  flipCount = 0;

  powerChart.data.datasets[0].data = toXY(data, r =>
    Math.round((r.power_delivered - r.power_returned) * 1000)
  );

  const vFields = ["voltage_l1", "voltage_l2", "voltage_l3"];
  const cFields = ["current_l1", "current_l2", "current_l3"];
  vFields.forEach((f, i) => { voltageCharts[i].data.datasets[0].data = toXY(data, r => r[f]); });
  cFields.forEach((f, i) => { currentCharts[i].data.datasets[0].data = toXY(data, r => r[f]); });

  // Compute annotations and extremes from history.
  data.forEach((r, idx) => {
    const exporting = r.power_returned > r.power_delivered;
    if (idx > 0 && exporting !== lastWasExporting) {
      addFlipAnnotation(new Date(r.timestamp).getTime(), exporting);
    }
    lastWasExporting = exporting;

    vFields.forEach((f, i) => {
      const v = r[f];
      if (v < voltageExtremes[i].min) voltageExtremes[i].min = v;
      if (v > voltageExtremes[i].max) voltageExtremes[i].max = v;
    });
    cFields.forEach((f, i) => {
      const v = r[f];
      if (v < currentExtremes[i].min) currentExtremes[i].min = v;
      if (v > currentExtremes[i].max) currentExtremes[i].max = v;
    });
  });

  voltageCharts.forEach((_, i) => updateInlineScale(voltageCharts[i], voltageExtremes[i], 2));
  currentCharts.forEach((_, i) => updateInlineScale(currentCharts[i], currentExtremes[i], 0.5));
  voltageCharts.forEach((_, i) => updateVoltageAnnotation(i));

  powerChart.update();
  voltageCharts.forEach(c => c.update());
  currentCharts.forEach(c => c.update());
}

/**
 * @param {object[]} data
 * @param {function} yFn
 * @returns {{x:number,y:number}[]}
 */
function toXY(data, yFn) {
  return data.map(r => ({ x: new Date(r.timestamp).getTime(), y: yFn(r) }));
}

/* ── Summary ────────────────────────────────────────────────────────────── */

async function loadSummary() {
  await Promise.all([loadSummaryLatest(), loadSummaryDelta(selectedHours)]);
}

async function loadSummaryLatest() {
  let s;
  try {
    const res = await fetch("/api/summary/latest");
    if (res.status === 204) return;
    if (!res.ok) return;
    s = await res.json();
  } catch { return; }

  const inT1  = s.energy_delivered_t1 ?? 0;
  const inT2  = s.energy_delivered_t2 ?? 0;
  const outT1 = s.energy_returned_t1  ?? 0;
  const outT2 = s.energy_returned_t2  ?? 0;

  setText("energy-in-total",  (inT1  + inT2).toFixed(1));
  setText("energy-out-total", (outT1 + outT2).toFixed(1));
  setText("energy-in-t1",     inT1.toFixed(1));
  setText("energy-in-t2",     inT2.toFixed(1));
  setText("energy-out-t1",    outT1.toFixed(1));
  setText("energy-out-t2",    outT2.toFixed(1));
  setText("gas-delivered",    fmt1(s.gas_delivered));
}

/**
 * Fetch and display delta values for the selected time window.
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

  const label = hours >= 24 ? `${Math.round(hours / 24)}d` : `${hours}h`;

  // Totals (sum of both tariffs)
  const inTotal  = (d.energy_delivered_t1 ?? 0) + (d.energy_delivered_t2 ?? 0);
  const outTotal = (d.energy_returned_t1  ?? 0) + (d.energy_returned_t2  ?? 0);
  setEnergyDelta("energy-in-total-delta",  inTotal,  label, "kWh");
  setEnergyDelta("energy-out-total-delta", outTotal, label, "kWh");

  // Per-tariff breakdown
  setEnergyDelta("energy-in-t1-delta",  d.energy_delivered_t1, label, "kWh");
  setEnergyDelta("energy-in-t2-delta",  d.energy_delivered_t2, label, "kWh");
  setEnergyDelta("energy-out-t1-delta", d.energy_returned_t1,  label, "kWh");
  setEnergyDelta("energy-out-t2-delta", d.energy_returned_t2,  label, "kWh");
  setEnergyDelta("gas-delta",           d.gas_delivered,        label, "m³");
}

/** Fetch static device info (IP, model, serial, WiFi RSSI, SW). */
async function loadDevice() {
  let d;
  try {
    const res = await fetch("/api/device");
    if (!res.ok) return;
    d = await res.json();
  } catch { return; }

  setText("device-model",  d.model   ?? "—");
  setText("device-ip",     d.ip      ?? "—");
  setText("device-serial", d.serial  ?? "—");
  setText("device-rssi",   d.wifi_rssi != null ? `${d.wifi_rssi} dBm` : "—");
  setText("device-sw",     d.sw      ?? "—");
}

function clearDeltas() {
  ["energy-in-total-delta","energy-out-total-delta",
   "energy-in-t1-delta","energy-in-t2-delta",
   "energy-out-t1-delta","energy-out-t2-delta","gas-delta"].forEach(id => {
    const e = document.getElementById(id);
    if (e) { e.textContent = ""; e.className = "energy-delta"; }
  });
}

/**
 * Set an energy-row delta element (all levels use the same energy-delta class).
 * @param {string} id
 * @param {number} value
 * @param {string} period
 * @param {string} unit
 */
function setEnergyDelta(id, value, period, unit) {
  const e = document.getElementById(id);
  if (!e || value == null) return;
  const sign = value >= 0 ? "+" : "";
  e.textContent = `${sign}${value.toFixed(2)} ${unit} / ${period}`;
  e.className   = `energy-delta ${value >= 0 ? "energy-delta--pos" : "energy-delta--neg"}`;
}

/**
 * @param {string} id
 * @param {number} value
 * @param {string} period
 * @param {string} unit
 */
function setDelta(id, value, period, unit) {
  const e = document.getElementById(id);
  if (!e) return;
  const sign = value >= 0 ? "+" : "";
  e.textContent = `${sign}${value.toFixed(3)} ${unit} / ${period}`;
  e.className   = `summary-delta ${value >= 0 ? "summary-delta--pos" : "summary-delta--neg"}`;
}

/* ── SSE ────────────────────────────────────────────────────────────────── */

let eventSource = null;
let reconnectDelay = 2000;

function connectSSE() {
  setStatus("connecting", "Connecting…");
  eventSource = new EventSource("/stream");

  eventSource.addEventListener("open", () => {
    setStatus("connected", "Live");
    reconnectDelay = 2000;
  });

  eventSource.addEventListener("message", event => {
    try { applyReading(JSON.parse(event.data)); }
    catch (err) { console.warn("SSE parse error:", err); }
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

function setStatus(state, label) {
  el.statusDot.className     = `status-dot ${state}`;
  el.statusLabel.textContent = label;
}

/* ── Reading application ────────────────────────────────────────────────── */

/**
 * Apply a live reading to all displayed elements and chart buffers.
 * @param {object} r
 */
function applyReading(r) {
  const delivered = r.power_delivered ?? 0;
  const returned  = r.power_returned  ?? 0;

  if (delivered > returned) {
    el.powerDisplay.className     = "power-display power-display--import";
    el.powerDirection.textContent = "Import from grid";
    setValue(el.powerNetVal, Math.round(delivered * 1000));
  } else if (returned > delivered) {
    el.powerDisplay.className     = "power-display power-display--export";
    el.powerDirection.textContent = "Export to grid";
    setValue(el.powerNetVal, Math.round(returned * 1000));
  } else {
    el.powerDisplay.className     = "power-display";
    el.powerDirection.textContent = "Balanced";
    setValue(el.powerNetVal, 0);
  }

  setValue(el.voltageL1, fmt1(r.voltage_l1));
  setValue(el.voltageL2, fmt1(r.voltage_l2));
  setValue(el.voltageL3, fmt1(r.voltage_l3));
  setValue(el.currentL1, fmt1(r.current_l1));
  setValue(el.currentL2, fmt1(r.current_l2));
  setValue(el.currentL3, fmt1(r.current_l3));

  if (el.lastUpdated) el.lastUpdated.textContent = new Date(r.timestamp).toLocaleTimeString();

  appendToCharts(r);
}

/** @param {HTMLElement} elem @param {string|number} val */
function setValue(elem, val) {
  if (!elem) return;
  elem.textContent = String(val);
  elem.classList.remove("value-updated");
  void elem.offsetWidth;
  elem.classList.add("value-updated");
}

function setText(id, val) {
  const e = document.getElementById(id);
  if (e) e.textContent = val ?? "—";
}

/** Format a number to 1 decimal place, or "—" if null/undefined. */
function fmt1(v) {
  return v != null ? Number(v).toFixed(1) : "—";
}

/* ── Chart append ───────────────────────────────────────────────────────── */

function appendToCharts(r) {
  const ts = new Date(r.timestamp).getTime();

  powerChart.data.datasets[0].data.push({
    x: ts,
    y: Math.round((r.power_delivered - r.power_returned) * 1000),
  });

  const exporting = r.power_returned > r.power_delivered;
  if (lastWasExporting !== null && exporting !== lastWasExporting) {
    addFlipAnnotation(ts, exporting);
  }
  lastWasExporting = exporting;

  // Voltage
  [r.voltage_l1, r.voltage_l2, r.voltage_l3].forEach((v, i) => {
    voltageCharts[i].data.datasets[0].data.push({ x: ts, y: v });
    if (v < voltageExtremes[i].min) { voltageExtremes[i].min = v; updateVoltageAnnotation(i); }
    if (v > voltageExtremes[i].max) { voltageExtremes[i].max = v; updateVoltageAnnotation(i); }
    updateInlineScale(voltageCharts[i], voltageExtremes[i], 2);
  });

  // Current
  [r.current_l1, r.current_l2, r.current_l3].forEach((v, i) => {
    currentCharts[i].data.datasets[0].data.push({ x: ts, y: v });
    if (v < currentExtremes[i].min) currentExtremes[i].min = v;
    if (v > currentExtremes[i].max) currentExtremes[i].max = v;
    updateInlineScale(currentCharts[i], currentExtremes[i], 0.5);
  });

  const cutoff = Date.now() - selectedHours * 3600 * 1000;
  trimOldPoints(powerChart, cutoff);
  voltageCharts.forEach(c => trimOldPoints(c, cutoff));
  currentCharts.forEach(c => trimOldPoints(c, cutoff));

  powerChart.update("none");
  voltageCharts.forEach(c => c.update("none"));
  currentCharts.forEach(c => c.update("none"));
}

function trimOldPoints(chart, cutoff) {
  for (const ds of chart.data.datasets) {
    while (ds.data.length > 0 && ds.data[0].x < cutoff) ds.data.shift();
  }
}

/* ── Scale helpers ──────────────────────────────────────────────────────── */

/**
 * Set the Y scale min/max with padding so data lines are never flush with
 * the chart edge.
 * @param {import('chart.js').Chart} chart
 * @param {{min:number, max:number}} extremes
 * @param {number} minPad - Minimum absolute padding on each side.
 */
function updateInlineScale(chart, extremes, minPad) {
  const { min, max } = extremes;
  if (!isFinite(min) || !isFinite(max)) return;
  const pad = Math.max(minPad, (max - min) * 0.25);
  chart.options.scales.y.min = min - pad;
  chart.options.scales.y.max = max + pad;
}

/* ── Annotations ────────────────────────────────────────────────────────── */

function addFlipAnnotation(tsMs, toExport) {
  const id    = `flip_${flipCount++}`;
  const color = toExport ? "rgba(34,197,94,0.55)" : "rgba(59,130,246,0.55)";
  powerChart.options.plugins.annotation.annotations[id] = {
    type: "line", scaleID: "x", value: tsMs,
    borderColor: color, borderWidth: 1, borderDash: [4, 4],
    label: {
      display: true,
      content: toExport ? "→ Export" : "→ Import",
      position: "start",
      backgroundColor: color, color: "#fff",
      font: { size: 9, weight: "600" },
      padding: { x: 4, y: 2 }, rotation: -90,
    },
  };
}

/**
 * Rebuild horizontal min/max annotation lines for a voltage phase chart.
 * @param {number} phaseIndex
 */
function updateVoltageAnnotation(phaseIndex) {
  const { min, max } = voltageExtremes[phaseIndex];
  if (!isFinite(min) || !isFinite(max)) return;
  const chart = voltageCharts[phaseIndex];
  chart.options.plugins.annotation.annotations = {
    vMin: {
      type: "line", scaleID: "y", value: min,
      borderColor: "rgba(239,68,68,0.7)", borderWidth: 1, borderDash: [4, 3],
      label: {
        display: true, content: `${min.toFixed(1)} V`, position: "end",
        backgroundColor: "rgba(239,68,68,0.8)", color: "#fff",
        font: { size: 8, weight: "600" }, padding: { x: 3, y: 1 },
      },
    },
    vMax: {
      type: "line", scaleID: "y", value: max,
      borderColor: "rgba(59,130,246,0.7)", borderWidth: 1, borderDash: [4, 3],
      label: {
        display: true, content: `${max.toFixed(1)} V`, position: "end",
        backgroundColor: "rgba(59,130,246,0.8)", color: "#fff",
        font: { size: 8, weight: "600" }, padding: { x: 3, y: 1 },
      },
    },
  };
}

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

/**
 * Return the current chart palette by reading computed CSS custom properties.
 * Called at init and after every theme change so chart line colours track
 * the active theme's accent values.
 * @returns {{delivered:string, returned:string, net:string, l1:string, l2:string, l3:string}}
 */
function chartPalette() {
  const s = getComputedStyle(document.documentElement);
  const v = name => s.getPropertyValue(name).trim();
  return {
    delivered: v("--delivered-color"),
    returned:  v("--returned-color"),
    net:       v("--net-color"),
    l1:        v("--phase-l1"),
    l2:        v("--phase-l2"),
    l3:        v("--phase-l3"),
  };
}

/** Mutable palette reference used by chart init and recolor. */
let COLORS = chartPalette();

/**
 * X-axis tick configuration per history window.
 * unit + stepSize are passed directly to Chart.js time scale.
 * Chart.js aligns generated ticks to clean multiples of stepSize.
 * @type {Object.<number, {unit: string, stepSize: number}>}
 */
const AXIS_CONFIG = {
    1:   { unit: "minute", stepSize: 5  },
    6:   { unit: "minute", stepSize: 30 },
    24:  { unit: "hour",   stepSize: 2  },
    72:  { unit: "hour",   stepSize: 12 },
    168: { unit: "day",    stepSize: 1  },
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
 * Y axis is displayed on the left with 3 ticks; X axis gridlines are shown
 * but labels are hidden.  Tooltip matches the power chart style.
 * @param {function} [tickFmt] - Optional Y-tick formatter.
 * @param {string}   [unit=''] - Unit string appended to tooltip values (e.g. 'V', 'A').
 * @returns {object}
 */
function makeInlineOpts(tickFmt, unit = "") {
  // Read current CSS custom properties so the initial paint is correct in
  // both light and dark themes without waiting for recolorCharts() to run.
  const s         = getComputedStyle(document.documentElement);
  const cprop     = name => s.getPropertyValue(name).trim();
  const gridColor = cprop("--chart-grid")     || "rgba(0,0,0,0.06)";
  const tipBg     = cprop("--chart-tooltip-bg")     || "rgba(255,255,255,0.97)";
  const tipBdr    = cprop("--chart-tooltip-border") || "rgba(0,0,0,0.10)";
  const tipTtl    = cprop("--chart-tooltip-title")  || "#1a1d2e";
  const tipBdy    = cprop("--chart-tooltip-body")   || "#6b7490";

  return {
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    // index mode so the crosshair snaps to the nearest X position.
    interaction: { mode: "index", intersect: false },
    elements: {
      point: { radius: 0, hitRadius: 6 },
      line:  { tension: 0.3, borderWidth: 1.5 },
    },
    scales: {
      x: {
        // display: true so Chart.js renders gridlines at tick positions.
        // Labels and the border line are hidden — only the grid is visible.
        display: true,
        type: "time",
        time: {
          tooltipFormat: "HH:mm:ss",
          displayFormats: { second: "HH:mm:ss", minute: "HH:mm", hour: "HH:mm", day: "MMM d" },
        },
        ticks:  { display: false, maxTicksLimit: 100 },
        grid:   { color: gridColor },
        border: { display: false },
      },
      y: {
        display: true,
        position: "left",
        ticks: {
          maxTicksLimit: 3,
          color: "#6b7490",
          font: { size: 9 },
          ...(tickFmt ? { callback: tickFmt } : {}),
        },
        grid:   { color: gridColor },
        border: { display: false },
      },
    },
    plugins: {
      legend:  { display: false },
      tooltip: {
        backgroundColor: tipBg,
        borderColor:     tipBdr,
        borderWidth:     1,
        titleColor:      tipTtl,
        bodyColor:       tipBdy,
        padding:         10,
        callbacks: {
          /**
           * Format the tooltip body line.
           * Appends the unit string to the numeric value.
           * @param {import('chart.js').TooltipItem} item
           * @returns {string}
           */
          label(item) {
            const v = item.parsed.y;
            if (v == null) return "";
            const fmt = tickFmt ? tickFmt(v) : v.toString();
            return unit ? `${fmt} ${unit}` : fmt;
          },
        },
      },
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

/**
 * EMA state for live chart smoothing. Null until the first live reading
 * arrives. Reset when history reloads so the EMA starts fresh from the
 * last history point rather than carrying stale state.
 * @type {object|null}
 */
let ema = null;

/**
 * Flip annotation configs keyed by ID, mirrored across all charts.
 * Kept here so updateVoltageAnnotation can merge them with vMin/vMax.
 * @type {Object.<string, object>}
 */
const flipAnnotations = {};

/* ── Theme management ───────────────────────────────────────────────────────── */

const THEME_CYCLE  = ["light", "dark", "auto"];
const THEME_LABELS = { light: "☀️ Light", dark: "🌙 Dark", auto: "◐ Auto" };

/**
 * Return true when the currently active computed theme is dark.
 * Handles explicit dark and auto-dark (OS preference).
 * @returns {boolean}
 */
function isDarkTheme() {
  const t = document.documentElement.dataset.theme;
  if (t === "dark") return true;
  if (t === "auto") return window.matchMedia("(prefers-color-scheme: dark)").matches;
  return false;
}

/**
 * Apply *theme* ('light' | 'dark' | 'auto'), persist to localStorage,
 * and update the toggle button label.
 * @param {string} theme
 */
function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem("hegg-theme", theme);
  const btn = document.getElementById("theme-toggle");
  if (btn) btn.textContent = THEME_LABELS[theme] ?? theme;
  recolorCharts();
}

/** Advance to the next theme in the cycle. */
function cycleTheme() {
  const current = document.documentElement.dataset.theme || "light";
  const next    = THEME_CYCLE[(THEME_CYCLE.indexOf(current) + 1) % THEME_CYCLE.length];
  applyTheme(next);
}

/**
 * Update Chart.js colour options to match the active theme.
 * Reads CSS custom properties so the values are always in sync with CSS.
 * Does nothing if charts are not yet initialised.
 */
function recolorCharts() {
  if (!powerChart) return;
  const s   = getComputedStyle(document.documentElement);
  const v   = name => s.getPropertyValue(name).trim();
  const grid    = v("--chart-grid");
  const tick    = v("--text-muted");
  const tipBg   = v("--chart-tooltip-bg");
  const tipBdr  = v("--chart-tooltip-border");
  const tipTtl  = v("--chart-tooltip-title");
  const tipBdy  = v("--chart-tooltip-body");

  // Refresh the mutable palette so newly-pushed data points use updated colours.
  Object.assign(COLORS, chartPalette());

  Chart.defaults.color = tick;

  [powerChart, ...voltageCharts, ...currentCharts].forEach(chart => {
    for (const axis of Object.values(chart.options.scales)) {
      if (axis.ticks) axis.ticks.color = tick;
      if (axis.grid)  axis.grid.color  = grid;
    }
    const tp = chart.options.plugins?.tooltip;
    if (tp) {
      tp.backgroundColor = tipBg;
      tp.borderColor     = tipBdr;
      tp.titleColor      = tipTtl;
      tp.bodyColor       = tipBdy;
    }
    // Update dataset colours for the power chart segment colouring.
    chart.data.datasets.forEach(ds => {
      if (ds.label === "Net") {
        ds.segment.borderColor     = ctx => ctx.p0.parsed.y >= 0 ? COLORS.delivered : COLORS.returned;
        ds.segment.backgroundColor = ctx => ctx.p0.parsed.y >= 0
          ? COLORS.delivered + "22" : COLORS.returned + "22";
      } else if (ds.label === "V" || ds.label === "A") {
        // Sparkline datasets keep their original colour — update via index.
        const idx = voltageCharts.indexOf(chart) !== -1
          ? voltageCharts.indexOf(chart)
          : currentCharts.indexOf(chart);
        if (idx >= 0) {
          const c = [COLORS.l1, COLORS.l2, COLORS.l3][idx];
          ds.borderColor     = c;
          ds.backgroundColor = c + "22";
        }
      }
    });
    chart.update("none");
  });
}

/* ── DOM ───────────────────────────────────────────────────────────── */

let el;

document.addEventListener("DOMContentLoaded", async () => {
  el = {
    statusDot:      document.getElementById("status-dot"),
    statusLabel:    document.getElementById("status-label"),
    powerDisplay:   document.getElementById("power-display"),
    powerDirection: document.getElementById("power-direction"),
    powerNetVal:    document.getElementById("power-net-val"),
    powerDeltaIn:   document.getElementById("power-delta-in"),
    powerDeltaOut:  document.getElementById("power-delta-out"),
    voltageL1:      document.getElementById("voltage-l1"),
    voltageL2:      document.getElementById("voltage-l2"),
    voltageL3:      document.getElementById("voltage-l3"),
    currentL1:      document.getElementById("current-l1"),
    currentL2:      document.getElementById("current-l2"),
    currentL3:      document.getElementById("current-l3"),
    historyRange:   document.getElementById("history-range"),
  };

  initCharts();
  recolorCharts();           // seed chart colours from the active theme
  await loadHistory(selectedHours);
  await loadSummary();
  loadDevice();
  connectSSE();

  el.historyRange.addEventListener("change", () => {
    selectedHours = parseInt(el.historyRange.value, 10);
    loadHistory(selectedHours);
    loadSummaryDelta(selectedHours);
  });

  // Theme toggle: click cycles light → dark → auto.
  const toggleBtn = document.getElementById("theme-toggle");
  if (toggleBtn) {
    toggleBtn.addEventListener("click", cycleTheme);
    // Set initial label from the theme already applied by the inline script.
    const savedTheme = document.documentElement.dataset.theme || "light";
    toggleBtn.textContent = THEME_LABELS[savedTheme] ?? savedTheme;
  }

  // Re-colour charts when OS preference changes while in auto mode.
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    if (document.documentElement.dataset.theme === "auto") recolorCharts();
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
      options: makeInlineOpts(v => v.toFixed(0), "V"),
    }));
  });

  // Wye phasor diagram — pure Canvas 2D, independent of Chart.js.
  initWyeDiagram();

  // Inline current sparklines.
  ["chart-c-l1", "chart-c-l2", "chart-c-l3"].forEach((id, i) => {
    currentCharts.push(new Chart(document.getElementById(id), {
      type: "line",
      data: { datasets: [makeDataset("A", [COLORS.l1, COLORS.l2, COLORS.l3][i])] },
      options: makeInlineOpts(v => v.toFixed(1), "A"),
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
  flipCount = 0;
  ema = null;  // force EMA to re-seed from first live reading
  Object.keys(flipAnnotations).forEach(k => delete flipAnnotations[k]);
  powerChart.options.plugins.annotation.annotations = {};
  voltageCharts.forEach(c => { c.options.plugins.annotation.annotations = {}; });
  currentCharts.forEach(c => { c.options.plugins.annotation.annotations = {}; });

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

  voltageCharts.forEach((_, i) => updateVoltageAnnotation(i));
  syncChartScales(voltageCharts, voltageExtremes, 2);
  // minFloor=0 prevents the current Y axis from going negative.
  syncChartScales(currentCharts, currentExtremes, 0.5, 0);

  applyXAxisConfig(hours);

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

  // Power card inline deltas
  if (el.powerDeltaIn)  el.powerDeltaIn.textContent  = `↓ ${inTotal.toFixed(2)} kWh / ${label}`;
  if (el.powerDeltaOut) el.powerDeltaOut.textContent = `↑ ${outTotal.toFixed(2)} kWh / ${label}`;

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

  // Update the wye phasor diagram with the raw (un-smoothed) voltages.
  updateWyeDiagram(
    r.voltage_l1 ?? 0,
    r.voltage_l2 ?? 0,
    r.voltage_l3 ?? 0,
  );

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
  const ts  = new Date(r.timestamp).getTime();
  const s   = smoothReading(r);  // EMA-smoothed copy for chart points

  powerChart.data.datasets[0].data.push({
    x: ts,
    y: Math.round((s.power_delivered - s.power_returned) * 1000),
  });

  // Use raw r for flip detection — direction changes must be immediate.
  const exporting = r.power_returned > r.power_delivered;
  if (lastWasExporting !== null && exporting !== lastWasExporting) {
    addFlipAnnotation(ts, exporting);
  }
  lastWasExporting = exporting;

  // Voltage — smoothed for chart, raw for extremes tracking.
  ["voltage_l1", "voltage_l2", "voltage_l3"].forEach((f, i) => {
    voltageCharts[i].data.datasets[0].data.push({ x: ts, y: s[f] });
    const v = r[f];
    if (v < voltageExtremes[i].min) { voltageExtremes[i].min = v; updateVoltageAnnotation(i); }
    if (v > voltageExtremes[i].max) { voltageExtremes[i].max = v; updateVoltageAnnotation(i); }
  });
  syncChartScales(voltageCharts, voltageExtremes, 2);

  // Current — smoothed for chart, raw for extremes.
  ["current_l1", "current_l2", "current_l3"].forEach((f, i) => {
    currentCharts[i].data.datasets[0].data.push({ x: ts, y: s[f] });
    const v = r[f];
    if (v < currentExtremes[i].min) currentExtremes[i].min = v;
    if (v > currentExtremes[i].max) currentExtremes[i].max = v;
  });
  // minFloor=0 prevents the current Y axis from going negative.
  syncChartScales(currentCharts, currentExtremes, 0.5, 0);

  const cutoff = Date.now() - selectedHours * 3600 * 1000;
  trimOldPoints(powerChart, cutoff);
  voltageCharts.forEach(c => trimOldPoints(c, cutoff));
  currentCharts.forEach(c => trimOldPoints(c, cutoff));

  // Slide the X window forward so ticks stay aligned to clock boundaries.
  applyXAxisConfig(selectedHours);

  powerChart.update("none");
  voltageCharts.forEach(c => c.update("none"));
  currentCharts.forEach(c => c.update("none"));
}

/**
 * Apply an exponential moving average to a reading for chart smoothing.
 *
 * Alpha is derived from the current bucket size so live chart data matches
 * the resolution of the history API.  Raw values are preserved for DOM
 * display; only the chart-push path uses the smoothed copy.
 *
 * @param {object} r - Raw 1-second reading from SSE.
 * @returns {object} Smoothed reading (same shape, timestamp unchanged).
 */
function smoothReading(r) {
  const bucketSeconds = Math.max(5, Math.floor((selectedHours * 3600) / 500));
  const alpha = 2 / (bucketSeconds + 1);
  if (ema === null) {
    ema = { ...r };
    return { ...r };
  }
  const s = { ...r };
  for (const key of ["power_delivered", "power_returned",
                     "voltage_l1", "voltage_l2", "voltage_l3",
                     "current_l1", "current_l2", "current_l3"]) {
    s[key] = alpha * (r[key] ?? 0) + (1 - alpha) * (ema[key] ?? 0);
  }
  ema = s;
  return s;
}

function trimOldPoints(chart, cutoff) {
  for (const ds of chart.data.datasets) {
    while (ds.data.length > 0 && ds.data[0].x < cutoff) ds.data.shift();
  }
}

/* ── Scale helpers ──────────────────────────────────────────────────────── */

/**
 * Return the number of milliseconds in one tick unit.
 * @param {string} unit - 'minute' | 'hour' | 'day'
 * @returns {number}
 */
function stepUnitMs(unit) {
  if (unit === "day")  return 86_400_000;
  if (unit === "hour") return  3_600_000;
  return 60_000; // minute
}

/**
 * Apply the appropriate X-axis tick unit and step for the given history
 * window so ticks — and therefore grid lines — fall on clean clock boundaries.
 *
 * Chart.js time scale generates intermediate minor ticks in addition to the
 * labelled major ticks; both produce grid lines.  afterBuildTicks strips the
 * tick array down to only those whose value is an exact multiple of stepMs,
 * guaranteeing grid lines land on :00, :05, :10 etc. for the 1 h range.
 *
 * @param {number} hours - The currently selected history window.
 */
function applyXAxisConfig(hours) {
  const cfg    = AXIS_CONFIG[hours] ?? AXIS_CONFIG[24];
  const stepMs = cfg.stepSize * stepUnitMs(cfg.unit);
  const flooredMin = Math.floor((Date.now() - hours * 3_600_000) / stepMs) * stepMs;

  [powerChart, ...voltageCharts, ...currentCharts].forEach(chart => {
    const x = chart.options.scales.x;
    x.time.unit     = cfg.unit;
    x.time.stepSize = cfg.stepSize;
    x.min           = flooredMin;
    if (x.ticks) x.ticks.maxTicksLimit = 100;
    // Strip any tick not at an exact step boundary — this controls grid lines,
    // not just labels.
    x.afterBuildTicks = scale => {
      scale.ticks = scale.ticks.filter(t => t.value % stepMs === 0);
    };
  });
}

/**
 * Compute the union Y-axis range across all per-phase extremes and apply the
 * same min/max to every chart in the group, keeping L1/L2/L3 visually
 * comparable on the same scale.
 * @param {import('chart.js').Chart[]} charts
 * @param {{min:number, max:number}[]} perPhaseExtremes
 * @param {number} minPad    - Minimum absolute padding on each side.
 * @param {number} [minFloor=-Infinity] - Hard lower bound for the Y minimum
 *   (e.g. pass 0 for current charts to prevent the axis dipping below zero).
 */
function syncChartScales(charts, perPhaseExtremes, minPad, minFloor = -Infinity) {
  let globalMin = Infinity, globalMax = -Infinity;
  perPhaseExtremes.forEach(e => {
    if (e.min < globalMin) globalMin = e.min;
    if (e.max > globalMax) globalMax = e.max;
  });
  if (!isFinite(globalMin) || !isFinite(globalMax)) return;
  const pad = Math.max(minPad, (globalMax - globalMin) * 0.25);
  charts.forEach(c => {
    c.options.scales.y.min = Math.max(minFloor, globalMin - pad);
    c.options.scales.y.max = globalMax + pad;
  });
}

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

/**
 * Add a vertical flip marker at the given timestamp on ALL charts.
 * enter/leave callbacks show a fixed tooltip with the exact timestamp.
 * @param {number}  tsMs     - Timestamp in milliseconds.
 * @param {boolean} toExport - Direction after the flip.
 */
function addFlipAnnotation(tsMs, toExport) {
  const id    = `flip_${flipCount++}`;
  const color = toExport ? "rgba(34,197,94,0.55)" : "rgba(59,130,246,0.55)";
  const label = toExport ? "→ Export" : "→ Import";
  const annotation = {
    type: "line", scaleID: "x", value: tsMs,
    borderColor: color, borderWidth: 1, borderDash: [4, 4],
    label: {
      display: true, content: label, position: "start",
      backgroundColor: color, color: "#fff",
      font: { size: 9, weight: "600" }, padding: { x: 4, y: 2 }, rotation: -90,
    },
    enter(ctx) {
      const tip   = document.getElementById("flip-tooltip");
      const dir   = toExport ? "↑ Export to grid" : "↓ Import from grid";
      const dt    = new Date(tsMs);
      const stamp = dt.toLocaleDateString() + " " + dt.toLocaleTimeString();
      tip.innerHTML =
        `<div class="ft-dir">${dir}</div><div class="ft-ts">${stamp}</div>`;
      const rect = ctx.chart.canvas.getBoundingClientRect();
      tip.style.left    = (rect.left + window.scrollX + ctx.element.x + 10) + "px";
      tip.style.top     = (rect.top  + window.scrollY + 12) + "px";
      tip.style.display = "block";
    },
    leave() {
      document.getElementById("flip-tooltip").style.display = "none";
    },
  };
  flipAnnotations[id] = annotation;
  powerChart.options.plugins.annotation.annotations[id] = annotation;
  voltageCharts.forEach(c => { c.options.plugins.annotation.annotations[id] = annotation; });
  currentCharts.forEach(c => { c.options.plugins.annotation.annotations[id] = annotation; });
}

/**
 * Rebuild horizontal min/max annotation lines for a voltage phase chart.
 * Merges with any existing flip annotations so they are not lost.
 * @param {number} phaseIndex
 */
function updateVoltageAnnotation(phaseIndex) {
  const { min, max } = voltageExtremes[phaseIndex];
  if (!isFinite(min) || !isFinite(max)) return;
  const chart = voltageCharts[phaseIndex];
  // Merge flip markers with the min/max lines rather than replacing everything.
  chart.options.plugins.annotation.annotations = {
    ...flipAnnotations,
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

/* ── 3-phase wye phasor diagram ─────────────────────────────────────────── */

/**
 * Compute the magnitude of the line-to-line voltage between two phases,
 * assuming the two phasors are separated by 120° in the ideal wye arrangement.
 *
 * Uses the cosine rule:
 *   |Va - Vb|² = Va² + Vb² - 2·Va·Vb·cos(120°)
 *              = Va² + Vb² + Va·Vb          (since cos 120° = -0.5)
 *
 * @param {number} va - Phase-to-neutral magnitude of the first phase (V).
 * @param {number} vb - Phase-to-neutral magnitude of the second phase (V).
 * @returns {number} Line voltage magnitude in volts.
 */
function lineVoltage(va, vb) {
  return Math.sqrt(va * va + vb * vb + va * vb);
}

/**
 * Compute the complex neutral shift relative to the system ground.
 *
 * With a wye system where the three phase voltages have magnitudes V1, V2, V3
 * and nominal 120° spacing, the neutral point is the centroid of the three
 * phasor tips in the complex plane.  In a balanced system this is zero.
 *
 * Angles: L1 = 0°, L2 = -120°, L3 = +120°  (standard rotation convention).
 *
 * @param {number} v1 - L1 magnitude.
 * @param {number} v2 - L2 magnitude.
 * @param {number} v3 - L3 magnitude.
 * @returns {{ re: number, im: number }} Real and imaginary parts of neutral shift.
 */
function neutralShift(v1, v2, v3) {
  const deg120 = (2 * Math.PI) / 3;
  const re = (v1 + v2 * Math.cos(-deg120) + v3 * Math.cos(deg120)) / 3;
  const im = (v2 * Math.sin(-deg120) + v3 * Math.sin(deg120)) / 3;
  return { re, im };
}

/**
 * Compute per-phase imbalance as a percentage of the mean phase voltage.
 * Uses the standard NEMA definition: 100 × maxDeviation / mean.
 *
 * @param {number} v1
 * @param {number} v2
 * @param {number} v3
 * @returns {number} Voltage imbalance factor (%).
 */
function voltageImbalance(v1, v2, v3) {
  const mean = (v1 + v2 + v3) / 3;
  if (mean === 0) return 0;
  const maxDev = Math.max(Math.abs(v1 - mean), Math.abs(v2 - mean), Math.abs(v3 - mean));
  return (maxDev / mean) * 100;
}

/** @type {HTMLCanvasElement|null} */
let wyeCanvas = null;

/** @type {CanvasRenderingContext2D|null} */
let wyeCtx = null;

/**
 * Initialise the wye canvas element.
 * Sets the pixel buffer to twice the CSS size for crisp HiDPI rendering.
 * Called once after DOMContentLoaded (inside initCharts).
 */
function initWyeDiagram() {
  wyeCanvas = document.getElementById("wye-canvas");
  if (!wyeCanvas) return;
  wyeCtx = wyeCanvas.getContext("2d");
  resizeWyeCanvas();
  window.addEventListener("resize", resizeWyeCanvas);
}

/**
 * Resize the canvas pixel buffer to match the CSS layout dimensions.
 * The device pixel ratio is applied so lines stay sharp on Retina screens.
 */
function resizeWyeCanvas() {
  if (!wyeCanvas) return;
  const dpr  = window.devicePixelRatio || 1;
  const rect = wyeCanvas.getBoundingClientRect();
  wyeCanvas.width  = rect.width  * dpr;
  wyeCanvas.height = rect.height * dpr;
  wyeCtx.scale(dpr, dpr);
}

/**
 * Draw the complete 3-phase wye phasor diagram onto the canvas.
 *
 * Layout:
 *   - Origin at canvas centre; Y axis flipped (positive = up, electrical convention).
 *   - Phase vectors radiate from origin at 0°, +120°, -120° (L1, L2, L3).
 *   - Ideal balanced reference ring drawn as dashed circle at mean voltage radius.
 *   - Line-to-line (LL) differential arcs drawn between phase tips.
 *   - Neutral offset vector drawn from origin to centroid of phasor tips.
 *   - Labels on each vector tip and the neutral point.
 *
 * @param {number} v1 - L1 RMS voltage.
 * @param {number} v2 - L2 RMS voltage.
 * @param {number} v3 - L3 RMS voltage.
 */
function drawWyeDiagram(v1, v2, v3) {
  if (!wyeCtx || !wyeCanvas) return;

  const dpr  = window.devicePixelRatio || 1;
  const W    = wyeCanvas.width  / dpr;
  const H    = wyeCanvas.height / dpr;
  const cx   = W / 2;
  const cy   = H / 2;

  // Scale so the largest phase vector occupies 80 % of the half-dimension.
  const maxV  = Math.max(v1, v2, v3, 1);
  const scale = (Math.min(W, H) * 0.40) / maxV;

  // Pull CSS custom-property colours for theme consistency.
  const css   = getComputedStyle(document.documentElement);
  const cprop = name => css.getPropertyValue(name).trim();

  const cl1      = cprop("--phase-l1");
  const cl2      = cprop("--phase-l2");
  const cl3      = cprop("--phase-l3");
  const cl12     = cprop("--wye-l12");
  const cl13     = cprop("--wye-l13");
  const cl23     = cprop("--wye-l23");
  const cNeutral = cprop("--wye-neutral");
  const cGrid    = cprop("--chart-grid");
  const cText    = cprop("--text-muted");
  const cTextDim = cprop("--text-dim");

  const ctx = wyeCtx;
  ctx.clearRect(0, 0, W, H);

  // Helper: electrical angle → canvas (x,y).
  // 0° is to the right; positive angle is counter-clockwise (standard maths).
  const toXY = (mag, angleDeg) => {
    const rad = angleDeg * Math.PI / 180;
    return {
      x: cx + mag * scale * Math.cos(rad),
      y: cy - mag * scale * Math.sin(rad),   // flip Y
    };
  };

  // Phasor tip coordinates.
  // L1 points straight up (90°), with L2 and L3 at −120° increments:
  //   L1 = 90°, L2 = −30° (lower-right), L3 = 210° (lower-left).
  const p1 = toXY(v1,  90);
  const p2 = toXY(v2, -30);
  const p3 = toXY(v3, 210);

  const meanV   = (v1 + v2 + v3) / 3;
  const idealR  = meanV * scale;

  // ── Background grid rings (25 %, 50 %, 75 %, 100 % of ideal) ──
  for (let frac = 0.25; frac <= 1.01; frac += 0.25) {
    ctx.beginPath();
    ctx.arc(cx, cy, idealR * frac, 0, 2 * Math.PI);
    ctx.strokeStyle = cGrid;
    ctx.lineWidth   = 1;
    ctx.setLineDash([]);
    ctx.stroke();
  }

  // Spokes at 0°, 60°, 120°… (every 60°) as orientation guides.
  for (let a = 0; a < 360; a += 60) {
    const sp = toXY(maxV * 1.05, a);
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(sp.x, sp.y);
    ctx.strokeStyle = cGrid;
    ctx.lineWidth   = 0.5;
    ctx.stroke();
  }

  // ── IEC 61000-3-3 / EN 50160 reference rings ──
  // Nominal LV supply voltage in Europe: 230 V ±10 % (207 V – 253 V).
  // These rings are drawn at fixed voltages regardless of the measured mean,
  // so they provide a stable absolute reference on the diagram.
  const IEC_NOM   = 230;
  const IEC_LOW   = 207;   // 230 V − 10 %
  const IEC_HIGH  = 253;   // 230 V + 10 %

  const drawIecRing = (voltage, color, dash, label, labelAngle) => {
    const r = voltage * scale;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, 2 * Math.PI);
    ctx.strokeStyle = color;
    ctx.lineWidth   = 1;
    ctx.setLineDash(dash);
    ctx.stroke();
    ctx.setLineDash([]);

    // Small label just outside the ring at the specified angle.
    const lx = cx + (r + 5) * Math.cos(labelAngle);
    const ly = cy - (r + 5) * Math.sin(labelAngle);
    ctx.font      = "9px 'JetBrains Mono', monospace";
    ctx.fillStyle = color;
    ctx.textAlign = "center";
    ctx.fillText(label, lx, ly);
  };

  // Tolerance bands first (underneath nominal ring).
  drawIecRing(IEC_LOW,  "rgba(251,146,60,0.55)",  [3, 3], "−10 %",  Math.PI * 0.25);
  drawIecRing(IEC_HIGH, "rgba(251,146,60,0.55)",  [3, 3], "+10 %",  Math.PI * 0.25);
  // Nominal ring.
  drawIecRing(IEC_NOM,  "rgba(255,255,255,0.30)", [5, 3], "230 V",  Math.PI * 0.20);

  // ── Mean-voltage reference ring (dashed, dim) ──
  ctx.beginPath();
  ctx.arc(cx, cy, idealR, 0, 2 * Math.PI);
  ctx.strokeStyle = cTextDim;
  ctx.lineWidth   = 1;
  ctx.setLineDash([4, 4]);
  ctx.stroke();
  ctx.setLineDash([]);

  // ── Line-to-line differential chords (LL arcs drawn as straight chords) ──
  // Drawn before the phase vectors so they appear underneath.
  const drawChord = (pa, pb, color, label, labelOffset) => {
    ctx.beginPath();
    ctx.moveTo(pa.x, pa.y);
    ctx.lineTo(pb.x, pb.y);
    ctx.strokeStyle = color;
    ctx.lineWidth   = 1.5;
    ctx.setLineDash([6, 3]);
    ctx.stroke();
    ctx.setLineDash([]);

    // Midpoint label.
    const mx = (pa.x + pb.x) / 2 + labelOffset.x;
    const my = (pa.y + pb.y) / 2 + labelOffset.y;
    ctx.font      = "bold 9px 'JetBrains Mono', monospace";
    ctx.fillStyle = color;
    ctx.textAlign = "center";
    ctx.fillText(label, mx, my);
  };

  const llMag12 = lineVoltage(v1, v2);
  const llMag13 = lineVoltage(v1, v3);
  const llMag23 = lineVoltage(v2, v3);

  drawChord(p1, p2, cl12, `L1–L2 ${llMag12.toFixed(1)} V`, { x: 14, y: -6 });
  drawChord(p1, p3, cl13, `L1–L3 ${llMag13.toFixed(1)} V`, { x: -14, y: -6 });
  drawChord(p2, p3, cl23, `L2–L3 ${llMag23.toFixed(1)} V`, { x: 0, y: 14 });

  // ── Phase voltage vectors ──
  const drawVector = (p, color, label, mag) => {
    // Arrow shaft.
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(p.x, p.y);
    ctx.strokeStyle = color;
    ctx.lineWidth   = 2.5;
    ctx.stroke();

    // Arrowhead.
    const angle = Math.atan2(cy - p.y, p.x - cx);
    const hs    = 8;
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
    ctx.lineTo(p.x - hs * Math.cos(angle - 0.35), p.y + hs * Math.sin(angle - 0.35));
    ctx.lineTo(p.x - hs * Math.cos(angle + 0.35), p.y + hs * Math.sin(angle + 0.35));
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();

    // Tip dot.
    ctx.beginPath();
    ctx.arc(p.x, p.y, 4, 0, 2 * Math.PI);
    ctx.fillStyle = color;
    ctx.fill();

    // Label at tip: push outward a bit.
    const offX = (p.x - cx) * 0.18;
    const offY = (p.y - cy) * 0.18;
    ctx.font      = "bold 11px 'Inter', sans-serif";
    ctx.fillStyle = color;
    ctx.textAlign = "center";
    ctx.fillText(`${label} ${mag.toFixed(1)} V`, p.x + offX, p.y + offY);
  };

  drawVector(p1, cl1, "L1", v1);
  drawVector(p2, cl2, "L2", v2);
  drawVector(p3, cl3, "L3", v3);

  // ── Neutral offset vector ──
  const ns  = neutralShift(v1, v2, v3);
  const npx = cx + ns.re * scale;
  const npy = cy - ns.im * scale;

  // Only draw if the offset is visible (> 0.5 px).
  const nLen = Math.sqrt((npx - cx) ** 2 + (npy - cy) ** 2);
  if (nLen > 0.5) {
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(npx, npy);
    ctx.strokeStyle  = cNeutral;
    ctx.lineWidth    = 2;
    ctx.setLineDash([3, 2]);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.beginPath();
    ctx.arc(npx, npy, 5, 0, 2 * Math.PI);
    ctx.fillStyle = cNeutral;
    ctx.fill();
  }

  // ── Origin dot ──
  ctx.beginPath();
  ctx.arc(cx, cy, 5, 0, 2 * Math.PI);
  ctx.fillStyle = cText;
  ctx.fill();

  // ── Centre label (mean voltage) ──
  ctx.font      = "10px 'JetBrains Mono', monospace";
  ctx.fillStyle = cText;
  ctx.textAlign = "center";
  ctx.fillText(`mean ${meanV.toFixed(1)} V`, cx, cy - 10);
}

/**
 * Update the wye diagram DOM stat elements and redraw the canvas.
 *
 * Called from applyReading() on every live SSE tick.
 *
 * @param {number} v1 - L1 RMS voltage.
 * @param {number} v2 - L2 RMS voltage.
 * @param {number} v3 - L3 RMS voltage.
 */
function updateWyeDiagram(v1, v2, v3) {
  if (!v1 || !v2 || !v3) return;

  // Phase voltage DOM.
  setText("wye-v-l1", v1.toFixed(1));
  setText("wye-v-l2", v2.toFixed(1));
  setText("wye-v-l3", v3.toFixed(1));

  // Line differentials.
  const mean   = (v1 + v2 + v3) / 3;
  const ideal  = mean * Math.sqrt(3);          // ideal LL for a balanced system
  const ll12   = lineVoltage(v1, v2);
  const ll13   = lineVoltage(v1, v3);
  const ll23   = lineVoltage(v2, v3);

  setText("wye-diff-l12", ll12.toFixed(1));
  setText("wye-diff-l13", ll13.toFixed(1));
  setText("wye-diff-l23", ll23.toFixed(1));

  // Delta from ideal for each LL pair.
  const setIdeal = (id, actual) => {
    const e = document.getElementById(id);
    if (!e) return;
    const delta = actual - ideal;
    const sign  = delta >= 0 ? "+" : "";
    e.textContent = `${sign}${delta.toFixed(1)} V vs ideal`;
    e.className   = `wt-ideal ${delta >= 0 ? "wt-ideal--pos" : "wt-ideal--neg"}`;
  };
  setIdeal("wye-ideal-l12", ll12);
  setIdeal("wye-ideal-l13", ll13);
  setIdeal("wye-ideal-l23", ll23);

  // Neutral offset.
  const ns    = neutralShift(v1, v2, v3);
  const nMag  = Math.sqrt(ns.re ** 2 + ns.im ** 2);
  const nAng  = (Math.atan2(ns.im, ns.re) * 180 / Math.PI).toFixed(1);
  const imbal = voltageImbalance(v1, v2, v3);
  setText("wye-neutral-mag", nMag.toFixed(2));
  setText("wye-neutral-ang", nAng);
  setText("wye-imbalance",   imbal.toFixed(2));

  // Canvas render.
  drawWyeDiagram(v1, v2, v3);
}

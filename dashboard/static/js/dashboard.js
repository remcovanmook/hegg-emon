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
 * Cached CSS custom-property values used by the wye canvas draw functions.
 * Updated by recolorCharts() whenever the theme changes so the per-second
 * draw path never needs to call getComputedStyle itself.
 * @type {object}
 */
let WYE_CSS = {};

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
          maxTicksLimit: 10,   // let stepSize from syncChartScales control density
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
 * Cached X-axis configuration for the electricity tab charts.
 * Built by buildXAxisCache() on range change and every 5 minutes.
 * Null until the first call; applyXAxisConfig() is a no-op while null.
 * @type {{unit:string, stepSize:number, stepMs:number, flooredMin:number, afterBuildTicks:function}|null}
 */
let xAxisCache = null;

/**
 * Pending computed history frame produced by loadHistory().
 * Consumed and cleared by applyPendingFrame(), which is called at the
 * top of appendToCharts() (SSE tick) and via requestAnimationFrame
 * as a fallback when SSE is not yet connected.
 * @type {object|null}
 */
let pendingHistoryFrame = null;

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

/**
 * Yield control back to the browser's task queue.
 *
 * Inserting this await inside a long async function lets the browser
 * process pending events (paint, input, SSE messages) before the
 * synchronous work after the await runs.  A zero-delay setTimeout
 * is used rather than queueMicrotask because microtasks do not yield
 * to the render pipeline.
 *
 * @returns {Promise<void>}
 */
function yieldToMain() {
  return new Promise(resolve => setTimeout(resolve, 0));
}

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
  if (t === "auto") return globalThis.matchMedia("(prefers-color-scheme: dark)").matches;
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

  // Refresh the wye CSS cache so canvas draws don't need getComputedStyle.
  WYE_CSS = {
    cl1:     v("--phase-l1"),
    cl2:     v("--phase-l2"),
    cl3:     v("--phase-l3"),
    cl12:    v("--wye-l12"),
    cl13:    v("--wye-l13"),
    cl23:    v("--wye-l23"),
    neutral: v("--wye-neutral"),
    grid:    grid,
    text:    tick,
    dim:     v("--text-dim"),
  };

  // Refresh the mutable palette so newly-pushed data points use updated colours.
  Object.assign(COLORS, chartPalette());

  Chart.defaults.color = tick;

  [powerChart, ...voltageCharts, ...currentCharts, usageChart, costChart, gasChart].filter(Boolean).forEach(chart => {
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
        const idx = voltageCharts.includes(chart)
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

document.addEventListener("DOMContentLoaded", () => {
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

  // Start the SSE stream and background fetches concurrently.
  // loadHistory is async and will populate charts when the fetch resolves;
  // there is no reason to delay connectSSE or loadSummary while waiting
  // for that to complete.
  connectSSE();
  loadHistory(selectedHours);
  loadSummary();
  loadDevice();

  el.historyRange.addEventListener("change", () => {
    selectedHours = Number.parseInt(el.historyRange.value, 10);
    loadHistory(selectedHours);
    loadSummaryDelta(selectedHours);
    loadUsageCharts();
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
  globalThis.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    if (document.documentElement.dataset.theme === "auto") recolorCharts();
  });

  // Tab buttons.
  document.getElementById("tab-btn-electricity").addEventListener("click", () => switchTab("electricity"));
  document.getElementById("tab-btn-usage").addEventListener("click",       () => switchTab("usage"));

  // Minute-level refresh for absolute values; device info is static.
  setInterval(loadSummary, 60_000);
  setInterval(loadDevice,  300_000);

  // Usage & cost charts: load on startup, refresh once per hour.
  loadUsageCharts();
  setInterval(loadUsageCharts, 60 * 60_000);

  // Slide the X-axis min forward once per minute so the live edge stays
  // current without rebuilding axis config on every SSE tick.
  // Rebuild the X-axis cache every 5 minutes. The smallest step across all
  // history windows is 5 minutes (1 h window), so flooredMin never drifts
  // by more than one step between rebuilds.
  setInterval(() => { buildXAxisCache(selectedHours); applyXAxisConfig(); }, 5 * 60_000);

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
  const powerOpts = structuredClone(BASE_OPTS);
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

  // Hourly cost bar chart: import cost (positive), export revenue (negative).
  costChart = new Chart(document.getElementById("chart-cost"), {
    type: "bar",
    data: {
      labels: [],
      datasets: [
        {
          label: "Import cost (€)",
          data: [],
          backgroundColor: COLORS.delivered + "cc",
          borderRadius: 3,
          borderSkipped: false,
        },
        {
          label: "Export revenue (€)",
          data: [],
          backgroundColor: COLORS.returned + "cc",
          borderRadius: 3,
          borderSkipped: false,
        },
      ],
    },
    options: _barOpts("€", v => `€${v.toFixed(3)}`, ctx => `${ctx.dataset.label}: €${Math.abs(ctx.parsed.y).toFixed(4)}`, true),
  });

  // Hourly electricity usage: T1/T2 import (positive), T1/T2 export (negative).
  usageChart = new Chart(document.getElementById("chart-usage"), {
    type: "bar",
    data: {
      labels: [],
      datasets: [
        { label: "Import T1 (kWh)", data: [], backgroundColor: COLORS.delivered + "cc", borderRadius: 3, borderSkipped: false },
        { label: "Import T2 (kWh)", data: [], backgroundColor: COLORS.delivered + "55", borderRadius: 3, borderSkipped: false },
        { label: "Export T1 (kWh)", data: [], backgroundColor: COLORS.returned  + "cc", borderRadius: 3, borderSkipped: false },
        { label: "Export T2 (kWh)", data: [], backgroundColor: COLORS.returned  + "55", borderRadius: 3, borderSkipped: false },
      ],
    },
    options: _barOpts("kWh", v => `${v.toFixed(3)} kWh`, ctx => `${ctx.dataset.label}: ${Math.abs(ctx.parsed.y).toFixed(4)} kWh`, true),
  });

  // Hourly gas usage.
  gasChart = new Chart(document.getElementById("chart-gas"), {
    type: "bar",
    data: {
      labels: [],
      datasets: [{
        label: "Gas (m³)",
        data: [],
        backgroundColor: "#f59e0bcc",
        borderRadius: 3,
        borderSkipped: false,
      }],
    },
    options: _barOpts("m³", v => `${v.toFixed(3)} m³`, ctx => `${ctx.dataset.label}: ${ctx.parsed.y.toFixed(4)} m³`),
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
 * Fetch bucketed history, compute all chart data in a single pass, and
 * store the result in pendingHistoryFrame for the render path to pick up.
 *
 * All data transformation happens in computeHistoryFrame() — no chart
 * mutations occur here. The rAF call at the end is a fallback for the
 * case where SSE is not yet connected and appendToCharts() never fires.
 *
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

  // Yield to the browser before the synchronous processing block so that
  // any queued renders, input events, or SSE messages get a chance to run.
  await yieldToMain();

  pendingHistoryFrame = computeHistoryFrame(data, hours);

  // Apply on the next animation frame in case SSE hasn't connected yet.
  requestAnimationFrame(applyPendingFrame);
}

/**
 * Compute all chart data from a history payload in a single pass over
 * the data array.
 *
 * This is a pure function: it does not read or write any module-level
 * state, and it does not touch the DOM or any Chart.js instance.
 * The returned frame is applied to charts by applyPendingFrame().
 *
 * @param {object[]} data   - Array of bucketed readings from /api/history.
 * @param {number}   hours  - The requested history window (passed through
 *                            so the axis cache can be built on apply).
 * @returns {object} Computed frame ready for applyPendingFrame().
 */
function computeHistoryFrame(data, hours) {
  const vFields = ["voltage_l1", "voltage_l2", "voltage_l3"];
  const cFields = ["current_l1", "current_l2", "current_l3"];

  // Pre-allocate output arrays for all 7 datasets.
  const powerData    = new Array(data.length);
  const voltageData  = [new Array(data.length), new Array(data.length), new Array(data.length)];
  const currentData  = [new Array(data.length), new Array(data.length), new Array(data.length)];

  const vExtremes = [
    { min: Infinity, max: -Infinity },
    { min: Infinity, max: -Infinity },
    { min: Infinity, max: -Infinity },
  ];
  const cExtremes = [
    { min: Infinity, max: -Infinity },
    { min: Infinity, max: -Infinity },
    { min: Infinity, max: -Infinity },
  ];

  const newFlipAnnotations = {};
  let localFlipCount = 0;
  let prevExporting  = null;
  let lastExporting  = null;

  for (let idx = 0; idx < data.length; idx++) {
    const r  = data[idx];
    const ts = new Date(r.timestamp).getTime();

    powerData[idx] = {
      x: ts,
      y: Math.round((r.power_delivered - r.power_returned) * 1000),
    };

    for (let i = 0; i < 3; i++) {
      const v = r[vFields[i]];
      voltageData[i][idx] = { x: ts, y: v };
      if (v < vExtremes[i].min) vExtremes[i].min = v;
      if (v > vExtremes[i].max) vExtremes[i].max = v;

      const c = r[cFields[i]];
      currentData[i][idx] = { x: ts, y: c };
      if (c < cExtremes[i].min) cExtremes[i].min = c;
      if (c > cExtremes[i].max) cExtremes[i].max = c;
    }

    const exporting = r.power_returned > r.power_delivered;
    if (idx > 0 && exporting !== prevExporting) {
      const id = `flip_${localFlipCount++}`;
      newFlipAnnotations[id] = buildFlipAnnotationDescriptor(ts, exporting);
    }
    prevExporting = exporting;
    lastExporting = exporting;
  }

  return {
    powerData,
    voltageData,
    currentData,
    voltageExtremes: vExtremes,
    currentExtremes: cExtremes,
    flipAnnotations:  newFlipAnnotations,
    flipCount:        localFlipCount,
    lastWasExporting: lastExporting,
    hours,
  };
}

/**
 * Apply a pending history frame to all charts.
 *
 * This is the only place that mutates chart instances with history data.
 * If pendingHistoryFrame is null (already consumed or not yet set) it
 * returns immediately so it is safe to call unconditionally.
 */
function applyPendingFrame() {
  if (!pendingHistoryFrame) return;
  const frame = pendingHistoryFrame;
  pendingHistoryFrame = null;

  // Update module-level tracking state.
  ema              = null;  // re-seed EMA from first live reading
  lastWasExporting = frame.lastWasExporting;
  flipCount        = frame.flipCount;

  // Replace the global flip-annotation map.
  Object.keys(flipAnnotations).forEach(k => delete flipAnnotations[k]);
  Object.assign(flipAnnotations, frame.flipAnnotations);

  // Reset all chart annotation stores and load the computed set.
  powerChart.options.plugins.annotation.annotations    = { ...frame.flipAnnotations };
  voltageCharts.forEach(c => { c.options.plugins.annotation.annotations = { ...frame.flipAnnotations }; });
  currentCharts.forEach(c => { c.options.plugins.annotation.annotations = { ...frame.flipAnnotations }; });

  // Swap dataset arrays (no per-point loop needed — arrays are prebuilt).
  powerChart.data.datasets[0].data = frame.powerData;
  frame.voltageData.forEach((d, i) => { voltageCharts[i].data.datasets[0].data = d; });
  frame.currentData.forEach((d, i) => { currentCharts[i].data.datasets[0].data = d; });

  // Copy precomputed extremes into the mutable per-phase objects.
  frame.voltageExtremes.forEach((e, i) => { voltageExtremes[i].min = e.min; voltageExtremes[i].max = e.max; });
  frame.currentExtremes.forEach((e, i) => { currentExtremes[i].min = e.min; currentExtremes[i].max = e.max; });

  voltageCharts.forEach((_, i) => updateVoltageAnnotation(i));
  syncChartScales(voltageCharts, voltageExtremes);
  syncChartScales(currentCharts, currentExtremes, 0);

  buildXAxisCache(frame.hours);
  applyXAxisConfig();

  // Only repaint if the electricity tab is currently visible.
  // The canvas.closest('[hidden]') traversal checks whether any ancestor
  // panel has the hidden attribute — no separate state variable needed.
  if (!powerChart.canvas.closest("[hidden]")) {
    powerChart.update();
    voltageCharts.forEach(c => c.update());
    currentCharts.forEach(c => c.update());
  }
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

  const inT1  = s.energy_delivered_tariff1 ?? 0;
  const inT2  = s.energy_delivered_tariff2 ?? 0;
  const outT1 = s.energy_returned_tariff1  ?? 0;
  const outT2 = s.energy_returned_tariff2  ?? 0;

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
  const inTotal  = (d.energy_delivered_tariff1 ?? 0) + (d.energy_delivered_tariff2 ?? 0);
  const outTotal = (d.energy_returned_tariff1  ?? 0) + (d.energy_returned_tariff2  ?? 0);
  setEnergyDelta("energy-in-total-delta",  inTotal,  label, "kWh");
  setEnergyDelta("energy-out-total-delta", outTotal, label, "kWh");

  // Power card inline deltas
  if (el.powerDeltaIn)  el.powerDeltaIn.textContent  = `↓ ${inTotal.toFixed(2)} kWh / ${label}`;
  if (el.powerDeltaOut) el.powerDeltaOut.textContent = `↑ ${outTotal.toFixed(2)} kWh / ${label}`;

  // Per-tariff breakdown
  setEnergyDelta("energy-in-t1-delta",  d.energy_delivered_tariff1, label, "kWh");
  setEnergyDelta("energy-in-t2-delta",  d.energy_delivered_tariff2, label, "kWh");
  setEnergyDelta("energy-out-t1-delta", d.energy_returned_tariff1,  label, "kWh");
  setEnergyDelta("energy-out-t2-delta", d.energy_returned_tariff2,  label, "kWh");
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

  setText("device-model",  d.model      ?? "—");
  setText("device-ip",     d.ip         ?? "—");
  setText("device-serial", d.serial     ?? "—");
  setText("device-rssi",   d.wifiRSSI == null ? "—" : `${d.wifiRSSI} dBm`);
  setText("device-sw",     d.swVersion  ?? "—");
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

/* ── Tab switching ──────────────────────────────────────────────────────── */

/** IDs of all tab panels and their corresponding button IDs. */
const TAB_IDS = ["electricity", "usage"];

/**
 * Activate the named tab panel and deactivate all others.
 *
 * After showing the Usage & Cost panel, resizes the Chart.js instances
 * inside it so they fill their containers correctly.
 *
 * @param {string} tabId - One of the IDs in TAB_IDS.
 */
function switchTab(tabId) {
  for (const id of TAB_IDS) {
    const panel = document.getElementById(`tab-${id}`);
    const btn   = document.getElementById(`tab-btn-${id}`);
    const active = id === tabId;
    if (panel) panel.hidden = !active;
    if (btn) {
      btn.classList.toggle("tab-btn--active", active);
      btn.setAttribute("aria-selected", active);
    }
  }
  // Chart.js cannot measure a hidden element; resize after reveal.
  // Also force a data repaint so any updates that arrived while the
  // electricity tab was hidden are rendered immediately on switch.
  if (tabId === "usage") {
    [usageChart, costChart, gasChart].forEach(c => {
      if (c) { c.resize(); c.update("none"); }
    });
  } else {
    [powerChart, ...voltageCharts, ...currentCharts].forEach(c => {
      if (c) { c.resize(); c.update("none"); }
    });
  }
}

/* ── Shared bar-chart options factory ─────────────────────────────────── */

/**
 * Return a Chart.js options object for the hourly bar charts.
 *
 * All three charts (usage, cost, gas) share the same axes style.
 *
 * @param {string} yLabel - Y-axis unit label text.
 * @param {function} tickFmt - Callback that formats a raw value for tick labels.
 * @param {function} tooltipFmt - Callback that formats a dataset value for tooltips.
 * @returns {object}
 */
function _barOpts(yLabel, tickFmt, tooltipFmt, stacked = false) {
  // 2-hour step for 24 h data — matches AXIS_CONFIG[24] on the electricity tab.
  const stepMs = 2 * 3_600_000;
  return {
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    interaction: { mode: "index", intersect: false },
    scales: {
      x: {
        type: "time",
        stacked,
        time: {
          unit: "hour",
          stepSize: 2,
          tooltipFormat: "HH:mm d MMM",
          displayFormats: { hour: "HH:mm", day: "MMM d" },
        },
        ticks: { color: "#6b7490", maxTicksLimit: 100, font: { size: 11 } },
        grid:  { color: "rgba(255,255,255,0.04)" },
        /** Keep only ticks at exact 2-hour boundaries. */
        afterBuildTicks: scale => {
          scale.ticks = scale.ticks.filter(t => t.value % stepMs === 0);
        },
      },
      y: {
        stacked,
        ticks: { color: "#6b7490", font: { size: 11 }, callback: tickFmt },
        grid:  { color: "rgba(255,255,255,0.04)" },
      },
    },
    plugins: {
      legend:  { display: true, position: "bottom", align: "end", labels: { color: "#6b7490", font: { size: 11 } } },
      tooltip: { callbacks: { label: tooltipFmt } },
    },
  };
}

/* ── Usage & cost charts ───────────────────────────────────────────────── */

/** @type {Chart|null} */ let costChart  = null;
/** @type {Chart|null} */ let usageChart = null;
/** @type {Chart|null} */ let gasChart   = null;

/**
 * Fetch hourly consumption and price data and populate all three Usage &
 * Cost charts in one pass.
 *
 * Prices are optional — consumption charts always render, cost chart only
 * renders for hours where a price is available.
 */
async function loadUsageCharts() {
  let consumption, prices;
  try {
    const [rC, rP] = await Promise.all([
      fetch(`/api/summary/hourly?hours=${selectedHours}`),
      fetch(`/api/prices?hours=${selectedHours}`),
    ]);
    if (!rC.ok || rC.status === 204) return;
    consumption = await rC.json();
    prices = rP.ok && rP.status !== 204 ? await rP.json() : [];
  } catch {
    return;
  }

  // Build lookups by hour timestamp.
  const consumMap = {};
  for (const c of consumption) consumMap[c.ts] = c;
  const priceMap = {};
  for (const p of prices) priceMap[p.ts_start] = p.price_eur_kwh;

  // Generate every UTC hour slot for the full selected window.
  // Hours with no data get 0 so the x-axis spans the complete range.
  const HOUR_MS  = 3_600_000;
  const nowMs    = Date.now();
  const startMs  = Math.floor((nowMs - selectedHours * HOUR_MS) / HOUR_MS) * HOUR_MS;

  const labels = [], d1 = [], d2 = [], r1 = [], r2 = [], gas = [];
  const importCost = [], exportRevenue = [];

  for (let h = startMs; h <= nowMs; h += HOUR_MS) {
    const c     = consumMap[h];
    const price = priceMap[h] ?? null;
    const del1  = c ? (c.energy_delivered_tariff1 ?? 0) : 0;
    const del2  = c ? (c.energy_delivered_tariff2 ?? 0) : 0;
    const ret1  = c ? (c.energy_returned_tariff1  ?? 0) : 0;
    const ret2  = c ? (c.energy_returned_tariff2  ?? 0) : 0;
    const gasV  = c ? (c.gas_delivered            ?? 0) : 0;

    labels.push(new Date(h));
    d1.push(+(del1.toFixed(4)));
    d2.push(+(del2.toFixed(4)));
    r1.push(-(+(ret1.toFixed(4))));
    r2.push(-(+(ret2.toFixed(4))));
    gas.push(+(gasV.toFixed(4)));
    importCost.push(   price !== null ? +((del1 + del2) * price).toFixed(4) : 0);
    exportRevenue.push(price !== null ? -(+(ret1 + ret2) * price).toFixed(4) : 0);
  }

  // Cache is already current from loadHistory; just apply it.
  applyXAxisConfig();

  // Data is always written to chart instances regardless of visibility so
  // it is ready when the tab is revealed. Only the repaint is gated.
  if (usageChart) {
    usageChart.data.labels            = labels;
    usageChart.data.datasets[0].data  = d1;
    usageChart.data.datasets[1].data  = d2;
    usageChart.data.datasets[2].data  = r1;
    usageChart.data.datasets[3].data  = r2;
  }
  if (gasChart) {
    gasChart.data.labels           = labels;
    gasChart.data.datasets[0].data = gas;
  }
  if (costChart) {
    costChart.data.labels           = labels;
    costChart.data.datasets[0].data = importCost;
    costChart.data.datasets[1].data = exportRevenue;
  }

  // Only repaint if the usage tab is currently visible.
  if (usageChart && !usageChart.canvas.closest("[hidden]")) {
    usageChart.update("none");
    if (gasChart)  gasChart.update("none");
    if (costChart) costChart.update("none");
  }

  // Period label, matching the format used by loadSummaryDelta.
  const _label = selectedHours >= 24 ? `${Math.round(selectedHours / 24)}d` : `${selectedHours}h`;

  // Usage totals.
  const totalDel  = d1.reduce((a, b) => a + b, 0) + d2.reduce((a, b) => a + b, 0);
  const totalRet  = (-r1.reduce((a, b) => a + b, 0)) + (-r2.reduce((a, b) => a + b, 0));
  const netUsage  = totalDel - totalRet;
  setText("usage-net-val", netUsage.toFixed(2));
  const usageDeltaIn  = document.getElementById("usage-delta-in");
  const usageDeltaOut = document.getElementById("usage-delta-out");
  if (usageDeltaIn)  usageDeltaIn.textContent  = `↓ ${totalDel.toFixed(2)} kWh / ${_label}`;
  if (usageDeltaOut) usageDeltaOut.textContent = `↑ ${totalRet.toFixed(2)} kWh / ${_label}`;

  // Cost totals.
  const totalImport = importCost.reduce((a, b) => a + b, 0);
  const totalExport = -exportRevenue.reduce((a, b) => a + b, 0);
  const netCost     = totalImport - totalExport;
  const netEl       = document.getElementById("cost-net-total");
  if (netEl) {
    netEl.textContent = netCost.toFixed(2);
    netEl.className   = "power-value mono " + (netCost >= 0 ? "cost-import" : "cost-export");
  }
  const costDeltaIn  = document.getElementById("cost-delta-in");
  const costDeltaOut = document.getElementById("cost-delta-out");
  if (costDeltaIn)  costDeltaIn.textContent  = `↓ €${totalImport.toFixed(2)} / ${_label}`;
  if (costDeltaOut) costDeltaOut.textContent = `↑ €${totalExport.toFixed(2)} / ${_label}`;

  // Gas totals.
  const totalGas = gas.reduce((a, b) => a + b, 0);
  setText("gas-total-val", totalGas.toFixed(3));

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

/**
 * Update an element's text and re-trigger the value-updated CSS animation.
 *
 * The animation is reset by removing the class, letting the browser paint
 * the removal in one rAF, then re-adding it in the next.  This avoids the
 * forced synchronous layout (getBoundingClientRect) that was previously
 * needed to flush the style change.
 *
 * @param {HTMLElement} elem
 * @param {string|number} val
 */
function setValue(elem, val) {
  if (!elem) return;
  elem.textContent = String(val);
  elem.classList.remove("value-updated");
  requestAnimationFrame(() => elem.classList.add("value-updated"));
}

function setText(id, val) {
  const e = document.getElementById(id);
  if (e) e.textContent = val ?? "—";
}

/** Format a number to 1 decimal place, or "—" if null/undefined. */
function fmt1(v) {
  return v == null ? "—" : Number(v).toFixed(1);
}

/* ── Chart append ───────────────────────────────────────────────────────── */

function appendToCharts(r) {
  // Apply any pending history frame before adding the live point.
  // This ensures history data is installed atomically before live points
  // are appended on top of it.
  applyPendingFrame();

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
  syncChartScales(voltageCharts, voltageExtremes);

  // Current — smoothed for chart, raw for extremes.
  ["current_l1", "current_l2", "current_l3"].forEach((f, i) => {
    currentCharts[i].data.datasets[0].data.push({ x: ts, y: s[f] });
    const v = r[f];
    if (v < currentExtremes[i].min) currentExtremes[i].min = v;
    if (v > currentExtremes[i].max) currentExtremes[i].max = v;
  });
  // minFloor=0 prevents the current Y axis from going negative.
  syncChartScales(currentCharts, currentExtremes, 0);

  const cutoff = Date.now() - selectedHours * 3600 * 1000;
  trimOldPoints(powerChart, cutoff);
  voltageCharts.forEach(c => trimOldPoints(c, cutoff));
  currentCharts.forEach(c => trimOldPoints(c, cutoff));
  trimOldAnnotations(cutoff);

  // applyXAxisConfig is intentionally NOT called here.
  // The axis min is slid forward by a setInterval in DOMContentLoaded
  // (once per minute), and by loadHistory/range-change events.
  // Calling it every second creates a new afterBuildTicks closure per chart
  // per tick and was the primary source of CPU load.

  // Only repaint charts that are currently visible.
  if (!powerChart.canvas.closest("[hidden]")) {
    powerChart.update("none");
    voltageCharts.forEach(c => c.update("none"));
    currentCharts.forEach(c => c.update("none"));
  }
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

/**
 * Remove data points older than cutoff from a chart's datasets.
 * @param {import('chart.js').Chart} chart
 * @param {number} cutoff - Timestamp in milliseconds; points before this are dropped.
 */
function trimOldPoints(chart, cutoff) {
  for (const ds of chart.data.datasets) {
    while (ds.data.length > 0 && ds.data[0].x < cutoff) ds.data.shift();
  }
}

/**
 * Remove flip annotations whose timestamp has scrolled out of the history
 * window.  Without pruning, the annotation object grows for the lifetime of
 * the page and gets spread into every chart's config on each direction change.
 *
 * @param {number} cutoff - Timestamp in milliseconds; annotations before this are dropped.
 */
function trimOldAnnotations(cutoff) {
  let changed = false;
  for (const id of Object.keys(flipAnnotations)) {
    // Annotation IDs are "flip_N"; the timestamp is stored on the value field.
    if (flipAnnotations[id].value < cutoff) {
      delete flipAnnotations[id];
      changed = true;
    }
  }
  if (!changed) return;
  // Sync the pruned set back to every chart that holds these annotations.
  const removeFromChart = chart => {
    const anns = chart.options.plugins.annotation.annotations;
    for (const id of Object.keys(anns)) {
      if (id.startsWith("flip_") && !flipAnnotations[id]) delete anns[id];
    }
  };
  removeFromChart(powerChart);
  voltageCharts.forEach(removeFromChart);
  currentCharts.forEach(removeFromChart);
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
 * Compute and cache the X-axis configuration for the given history window.
 *
 * The derived values break down as follows:
 *   - unit / stepSize: determined solely by the selected window; constant
 *     until the user changes the range selector.
 *   - stepMs: derived from the above; same lifetime.
 *   - afterBuildTicks: a closure over stepMs; created once here and reused
 *     across all charts and all subsequent applyXAxisConfig() calls.
 *   - flooredMin: depends on Date.now(); needs refreshing periodically so
 *     the live edge of the axis stays current.  The smallest step in
 *     AXIS_CONFIG is 5 minutes (1 h window), so rebuilding every 5 minutes
 *     means flooredMin drifts by at most one step between rebuilds.
 *
 * Call this whenever selectedHours changes, or every 5 minutes.
 * Follow with applyXAxisConfig() to push the values to the charts.
 *
 * @param {number} hours - The currently selected history window.
 */
function buildXAxisCache(hours) {
  const cfg    = AXIS_CONFIG[hours] ?? AXIS_CONFIG[24];
  const stepMs = cfg.stepSize * stepUnitMs(cfg.unit);
  xAxisCache = {
    unit:     cfg.unit,
    stepSize: cfg.stepSize,
    stepMs,
    flooredMin: Math.floor((Date.now() - hours * 3_600_000) / stepMs) * stepMs,
    /**
     * Filter Chart.js ticks to only those at exact step boundaries.
     * This controls grid-line positions as well as tick labels.
     * @param {import('chart.js').Scale} scale
     */
    afterBuildTicks(scale) {
      scale.ticks = scale.ticks.filter(t => t.value % stepMs === 0);
    },
  };
}

/**
 * Push the cached X-axis configuration to all electricity-tab charts.
 *
 * Reads from xAxisCache; does nothing if the cache has not been built yet.
 * The same afterBuildTicks function reference is written to every chart so
 * Chart.js holds one shared instance rather than one closure per chart.
 */
function applyXAxisConfig() {
  if (!xAxisCache) return;
  [powerChart, ...voltageCharts, ...currentCharts].forEach(chart => {
    const x = chart.options.scales.x;
    x.time.unit       = xAxisCache.unit;
    x.time.stepSize   = xAxisCache.stepSize;
    x.min             = xAxisCache.flooredMin;
    x.afterBuildTicks = xAxisCache.afterBuildTicks;
    if (x.ticks) x.ticks.maxTicksLimit = 100;
  });
}

/**
 * Compute a "nice" Y-axis scale whose boundaries and step are multiples of
 * 1, 2, 5, or 10 at the appropriate power of ten, with at most maxIntervals
 * tick intervals (grid cells).
 *
 * Algorithm:
 *   1. roughStep = range / maxIntervals
 *   2. magnitude = largest power of 10 ≤ roughStep
 *   3. normalised  = roughStep / magnitude
 *   4. step = smallest nice multiplier (1, 2, 5, 10) ≥ normalised
 *   5. min/max rounded down/up to the nearest multiple of step
 *
 * @param {number} rawMin
 * @param {number} rawMax
 * @param {number} [maxIntervals=5]
 * @returns {{ min: number, max: number, step: number }}
 */
function niceScale(rawMin, rawMax, maxIntervals = 5) {
  if (!Number.isFinite(rawMin) || !Number.isFinite(rawMax) || rawMin === rawMax) {
    // Degenerate range: expand by one unit so at least one grid line exists.
    return { min: Math.floor(rawMin) - 1, max: Math.ceil(rawMax) + 1, step: 1 };
  }
  const range     = rawMax - rawMin;
  const roughStep = range / maxIntervals;
  const magnitude = Math.pow(10, Math.floor(Math.log10(roughStep)));
  const norm      = roughStep / magnitude;
  let step;
  if (norm <= 1)      { step = magnitude; }
  else if (norm <= 2) { step = 2 * magnitude; }
  else if (norm <= 5) { step = 5 * magnitude; }
  else                { step = 10 * magnitude; }
  return {
    min:  Math.floor(rawMin / step) * step,
    max:  Math.ceil(rawMax  / step) * step,
    step,
  };
}

/**
 * Compute the union Y-axis range across all per-phase extremes, apply a nice
 * scale to it, and push the same min/max/stepSize to every chart in the group
 * so L1/L2/L3 remain visually comparable.
 *
 * The nice scale algorithm picks a step from {1, 2, 5, 10} × 10ⁿ that keeps
 * the number of tick intervals ≤ 5, then rounds min/max outward to clean
 * multiples of that step.  ticks.stepSize is written directly so Chart.js
 * places grid lines at those positions regardless of maxTicksLimit.
 *
 * @param {import('chart.js').Chart[]} charts
 * @param {{min:number, max:number}[]} perPhaseExtremes
 * @param {number} [minFloor=-Infinity] - Hard lower bound for the Y minimum
 *   (pass 0 for current charts to prevent the axis going below zero).
 */
function syncChartScales(charts, perPhaseExtremes, minFloor = -Infinity) {
  let globalMin = Infinity, globalMax = -Infinity;
  perPhaseExtremes.forEach(e => {
    if (e.min < globalMin) globalMin = e.min;
    if (e.max > globalMax) globalMax = e.max;
  });
  if (!Number.isFinite(globalMin) || !Number.isFinite(globalMax)) return;

  // Clamp the raw lower bound before computing the nice scale so that the
  // floor is reflected in the rounding, not just clamped after the fact.
  const clampedMin = Math.max(minFloor, globalMin);
  const { min, max, step } = niceScale(clampedMin, globalMax);
  const niceMin = Math.max(minFloor, min);

  charts.forEach(c => {
    c.options.scales.y.min  = niceMin;
    c.options.scales.y.max  = max;
    // Drive grid line positions via stepSize; maxTicksLimit is set high
    // enough in makeInlineOpts not to prune these ticks.
    c.options.scales.y.ticks.stepSize = step;
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
  if (!Number.isFinite(min) || !Number.isFinite(max)) return;
  const pad = Math.max(minPad, (max - min) * 0.25);
  chart.options.scales.y.min = min - pad;
  chart.options.scales.y.max = max + pad;
}

/* ── Annotations ────────────────────────────────────────────────────────── */

/**
 * Build a flip annotation descriptor without applying it to any chart.
 *
 * Pure function used by computeHistoryFrame() to build the full annotation
 * set in one pass. The returned object can later be installed into chart
 * annotation configs by applyPendingFrame().
 *
 * @param {number}  tsMs     - Timestamp in milliseconds.
 * @param {boolean} toExport - Direction after the flip.
 * @returns {object} Chart.js annotation descriptor.
 */
function buildFlipAnnotationDescriptor(tsMs, toExport) {
  const color = toExport ? "rgba(34,197,94,0.55)" : "rgba(59,130,246,0.55)";
  const label = toExport ? "→ Export" : "→ Import";
  return {
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
}

/**
 * Build a flip annotation and immediately install it on all charts.
 *
 * Used by the live SSE path (appendToCharts) where annotations must be
 * applied inline as readings arrive. For the history path, use
 * buildFlipAnnotationDescriptor() and apply via applyPendingFrame().
 *
 * @param {number}  tsMs     - Timestamp in milliseconds.
 * @param {boolean} toExport - Direction after the flip.
 */
function addFlipAnnotation(tsMs, toExport) {
  const id         = `flip_${flipCount++}`;
  const annotation = buildFlipAnnotationDescriptor(tsMs, toExport);
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
  if (!Number.isFinite(min) || !Number.isFinite(max)) return;
  const chart = voltageCharts[phaseIndex];
  // Merge flip markers with the min/max lines rather than replacing everything.
  chart.options.plugins.annotation.annotations = {
    ...flipAnnotations,
    vMin: {
      type: "line", scaleID: "y", value: min,
      borderColor: "rgba(239,68,68,0.7)", borderWidth: 1, borderDash: [4, 3],
      label: {
        display: true, content: `${min.toFixed(1)} V`, position: "center",
        backgroundColor: "rgba(239,68,68,0.8)", color: "#fff",
        font: { size: 8, weight: "600" }, padding: { x: 3, y: 1 },
      },
    },
    vMax: {
      type: "line", scaleID: "y", value: max,
      borderColor: "rgba(59,130,246,0.7)", borderWidth: 1, borderDash: [4, 3],
      label: {
        display: true, content: `${max.toFixed(1)} V`, position: "center",
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

/** @type {HTMLCanvasElement|null} Mini neutral-offset polar canvas. */
let neutralCanvas = null;

/** @type {CanvasRenderingContext2D|null} */
let neutralCtx = null;

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

  // Mini neutral-offset canvas.
  neutralCanvas = document.getElementById("wye-neutral-canvas");
  if (neutralCanvas) {
    neutralCtx = neutralCanvas.getContext("2d");
    resizeNeutralCanvas();
    window.addEventListener("resize", resizeNeutralCanvas);
  }
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

/** Resize the mini neutral-offset canvas pixel buffer (same logic as the main wye canvas). */
function resizeNeutralCanvas() {
  if (!neutralCanvas) return;
  const dpr  = window.devicePixelRatio || 1;
  const rect = neutralCanvas.getBoundingClientRect();
  neutralCanvas.width  = rect.width  * dpr;
  neutralCanvas.height = rect.height * dpr;
  neutralCtx.scale(dpr, dpr);
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

  // Subtract a base voltage so inter-phase differences are amplified visually.
  // At ~230 V the raw vectors are nearly identical in length; with a 200 V base
  // the displayed deviations are ~30 V, making a 1 V imbalance ~3 % of the
  // vector length instead of ~0.4 %.
  // IEC reference rings and the mean ring use the same offset so they remain
  // correctly positioned relative to the phasor tips.
  // Neutral shift is mathematically unaffected (the base cancels in the centroid
  // calculation) but appears proportionally larger at the expanded scale.
  const WYE_DISPLAY_OFFSET = 200;

  // Display magnitudes — deviations from the base, floor at 1 to avoid
  // zero-length vectors if voltage ever dips below the base.
  const dv1 = Math.max(v1 - WYE_DISPLAY_OFFSET, 1);
  const dv2 = Math.max(v2 - WYE_DISPLAY_OFFSET, 1);
  const dv3 = Math.max(v3 - WYE_DISPLAY_OFFSET, 1);

  // Scale so the largest display vector occupies 80 % of the half-dimension.
  const maxDV = Math.max(dv1, dv2, dv3);
  const scale = (Math.min(W, H) * 0.4) / maxDV;

  // Use the cached palette populated by recolorCharts() rather than calling
  // getComputedStyle on every tick (called once per second from SSE).
  const cl1      = WYE_CSS.cl1     || "#60a5fa";
  const cl2      = WYE_CSS.cl2     || "#34d399";
  const cl3      = WYE_CSS.cl3     || "#f59e0b";
  const cl12     = WYE_CSS.cl12    || "#818cf8";
  const cl13     = WYE_CSS.cl13    || "#fb7185";
  const cl23     = WYE_CSS.cl23    || "#a78bfa";
  const cNeutral = WYE_CSS.neutral || "#f472b6";
  const cGrid    = WYE_CSS.grid    || "rgba(255,255,255,0.06)";
  const cText    = WYE_CSS.text    || "#9ca3af";
  const cTextDim = WYE_CSS.dim     || "#4b5563";

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

  // Phasor tip coordinates use display magnitudes; labels show actual voltages.
  // L1 points straight up (90°), with L2 and L3 at −120° increments:
  //   L1 = 90°, L2 = −30° (lower-right), L3 = 210° (lower-left).
  const p1 = toXY(dv1,  90);
  const p2 = toXY(dv2, -30);
  const p3 = toXY(dv3, 210);

  const meanDV = (dv1 + dv2 + dv3) / 3;
  const idealR = meanDV * scale;

  // ── Background grid rings (25 %, 50 %, 75 %, 100 % of display mean) ──
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
    const sp = toXY(maxDV * 1.05, a);
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(sp.x, sp.y);
    ctx.strokeStyle = cGrid;
    ctx.lineWidth   = 0.5;
    ctx.stroke();
  }

  // ── IEC 61000-3-3 / EN 50160 reference rings ──
  // Nominal LV supply voltage in Europe: 230 V ±10 % (207 V – 253 V).
  // Subtract the display offset so the rings align with the phasor tips.
  const IEC_LOW_DISP  = 207 - WYE_DISPLAY_OFFSET;   //  7 V display
  const IEC_NOM_DISP  = 230 - WYE_DISPLAY_OFFSET;   // 30 V display
  const IEC_HIGH_DISP = 253 - WYE_DISPLAY_OFFSET;   // 53 V display

  const drawIecRing = (dispV, color, dash, label, labelAngle) => {
    const r = dispV * scale;
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
  drawIecRing(IEC_LOW_DISP,  "rgba(251,146,60,0.55)",  [3, 3], "207 V",  Math.PI * 0.25);
  drawIecRing(IEC_HIGH_DISP, "rgba(251,146,60,0.55)",  [3, 3], "253 V",  Math.PI * 0.25);
  // Nominal ring.
  drawIecRing(IEC_NOM_DISP,  "rgba(255,255,255,0.30)", [5, 3], "230 V",  Math.PI * 0.2);

  // ── Mean-voltage reference ring (dashed, dim) ──
  ctx.beginPath();
  ctx.arc(cx, cy, idealR, 0, 2 * Math.PI);
  ctx.strokeStyle = cTextDim;
  ctx.lineWidth   = 1;
  ctx.setLineDash([4, 4]);
  ctx.stroke();
  ctx.setLineDash([]);

  // ── Line-to-line differential chords ──
  // Chord geometry reflects display magnitudes; labels show calculated LL voltage.
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

  drawChord(p1, p2, cl12, `L1\u2013L2 ${llMag12.toFixed(1)} V`, { x: 14, y: -6 });
  drawChord(p1, p3, cl13, `L1\u2013L3 ${llMag13.toFixed(1)} V`, { x: -14, y: -6 });
  drawChord(p2, p3, cl23, `L2\u2013L3 ${llMag23.toFixed(1)} V`, { x: 0, y: 14 });

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

  // Pass actual voltages for labels; phasor tips already computed from display magnitudes.
  drawVector(p1, cl1, "L1", v1);
  drawVector(p2, cl2, "L2", v2);
  drawVector(p3, cl3, "L3", v3);

  // ── Neutral offset vector ──
  // Computed from actual voltages — the display base cancels in the centroid
  // calculation so the result is identical either way.
  const ns  = neutralShift(v1, v2, v3);
  const npx = cx + ns.re * scale;
  const npy = cy - ns.im * scale;

  // Only draw if the offset is visible (> 0.5 px).
  const nLen = Math.hypot(npx - cx, npy - cy);
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

  // ── Centre label: actual mean voltage ──
  const meanV = (v1 + v2 + v3) / 3;
  ctx.font      = "10px 'JetBrains Mono', monospace";
  ctx.fillStyle = cText;
  ctx.textAlign = "center";
  ctx.fillText(`mean ${meanV.toFixed(1)} V`, cx, cy - 10);

  // ── Corner note: display base so diagram is not misread as absolute scale ──
  ctx.font         = "8px 'JetBrains Mono', monospace";
  ctx.fillStyle    = cTextDim;
  ctx.textAlign    = "left";
  ctx.textBaseline = "bottom";
  ctx.fillText(`\u2212${WYE_DISPLAY_OFFSET} V base`, 6, H - 4);
  ctx.textBaseline = "alphabetic";
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

  // IEC 61000-3-3 / EN 50160 nominal voltage.
  const IEC_NOM = 230;

  // Phase voltage DOM + delta vs IEC nominal.
  setText("wye-v-l1", v1.toFixed(1));
  setText("wye-v-l2", v2.toFixed(1));
  setText("wye-v-l3", v3.toFixed(1));

  /**
   * Set a phase-voltage IEC delta cell.
   * Shows the absolute deviation from 230 V and the percentage in parentheses.
   * Positive = above nominal (green), negative = below (red).
   * @param {string} id
   * @param {number} v
   */
  const setPhaseIdeal = (id, v) => {
    const e = document.getElementById(id);
    if (!e) return;
    const delta   = v - IEC_NOM;
    const pct     = (delta / IEC_NOM) * 100;
    const sign    = delta >= 0 ? "+" : "";
    const pctSign = pct   >= 0 ? "+" : "";
    e.textContent = `${sign}${delta.toFixed(1)} V vs IEC (${pctSign}${pct.toFixed(1)}%)`;
    e.className   = `wt-ideal ${delta >= 0 ? "wt-ideal--pos" : "wt-ideal--neg"}`;
  };
  setPhaseIdeal("wye-ideal-l1", v1);
  setPhaseIdeal("wye-ideal-l2", v2);
  setPhaseIdeal("wye-ideal-l3", v3);

  // Line differentials.
  // IEC 60038 nominal line-to-line voltage for a 230/400 V system.
  const IEC_LL = 400;
  const ll12   = lineVoltage(v1, v2);
  const ll13   = lineVoltage(v1, v3);
  const ll23   = lineVoltage(v2, v3);

  setText("wye-diff-l12", ll12.toFixed(1));
  setText("wye-diff-l13", ll13.toFixed(1));
  setText("wye-diff-l23", ll23.toFixed(1));

  /**
   * Set a line-differential IEC delta cell.
   * Shows the absolute deviation from the IEC 60038 nominal VLL (400 V)
   * and the percentage in parentheses, matching the phase voltage format.
   * @param {string} id
   * @param {number} actual - Measured line-to-line voltage.
   */
  const setLlIdeal = (id, actual) => {
    const e = document.getElementById(id);
    if (!e) return;
    const delta   = actual - IEC_LL;
    const pct     = (delta / IEC_LL) * 100;
    const sign    = delta >= 0 ? "+" : "";
    const pctSign = pct   >= 0 ? "+" : "";
    e.textContent = `${sign}${delta.toFixed(1)} V vs IEC (${pctSign}${pct.toFixed(1)}%)`;
    e.className   = `wt-ideal ${delta >= 0 ? "wt-ideal--pos" : "wt-ideal--neg"}`;
  };
  setLlIdeal("wye-ideal-l12", ll12);
  setLlIdeal("wye-ideal-l13", ll13);
  setLlIdeal("wye-ideal-l23", ll23);

  // Neutral offset.
  const ns    = neutralShift(v1, v2, v3);
  const nMag  = Math.hypot(ns.re, ns.im);
  const nAng  = (Math.atan2(ns.im, ns.re) * 180 / Math.PI).toFixed(1);
  const imbal = voltageImbalance(v1, v2, v3);
  setText("wye-neutral-mag", nMag.toFixed(2));
  setText("wye-neutral-ang", nAng);
  setText("wye-imbalance",   imbal.toFixed(2));

  // Canvas renders.
  drawWyeDiagram(v1, v2, v3);
  drawNeutralMini(ns.re, ns.im, nMag);
}

/**
 * Draw the mini neutral-offset polar diagram.
 *
 * Shows the neutral shift vector (magnitude and direction) on a small canvas
 * with concentric reference rings so severity can be assessed at a glance.
 *
 * Scale: the outer ring equals maxRef volts, where maxRef is the smallest
 * multiple of 5 V that is ≥ 2 × the current magnitude, with a floor of 5 V.
 * This keeps the vector large enough to read while the axis auto-expands
 * when the offset grows.
 *
 * Phase direction labels (L1 up, L2 lower-right, L3 lower-left) are drawn
 * just outside the outer ring so the viewer can relate the offset angle to
 * which phase is pulling the neutral.
 *
 * @param {number} re  - Real part of neutral shift (V).
 * @param {number} im  - Imaginary part of neutral shift (V).
 * @param {number} mag - Magnitude of neutral shift (V).
 */
function drawNeutralMini(re, im, mag) {
  if (!neutralCtx || !neutralCanvas) return;

  const dpr = window.devicePixelRatio || 1;
  const W   = neutralCanvas.width  / dpr;
  const H   = neutralCanvas.height / dpr;
  const cx  = W / 2;
  const cy  = H / 2;

  // Use the cached palette populated by recolorCharts() — same as drawWyeDiagram.
  const cN    = WYE_CSS.neutral || "#f472b6";
  const cGrid = WYE_CSS.grid    || "rgba(255,255,255,0.06)";
  const cText = WYE_CSS.text    || "#9ca3af";
  const cDim  = WYE_CSS.dim     || "#4b5563";
  const cl1   = WYE_CSS.cl1     || "#60a5fa";
  const cl2   = WYE_CSS.cl2     || "#34d399";
  const cl3   = WYE_CSS.cl3     || "#f59e0b";

  const ctx = neutralCtx;
  ctx.clearRect(0, 0, W, H);

  // Adaptive outer ring: smallest 5 V multiple ≥ max(5, 2 × magnitude).
  const maxRef = Math.max(5, Math.ceil(Math.max(mag * 2, 1) / 5) * 5);
  const R      = Math.min(W, H) * 0.36;   // outer ring radius in px
  const scale  = R / maxRef;

  // Background rings at 25 %, 50 %, 75 %, 100 % of maxRef.
  [0.25, 0.5, 0.75, 1].forEach(frac => {
    ctx.beginPath();
    ctx.arc(cx, cy, R * frac, 0, 2 * Math.PI);
    ctx.strokeStyle = cGrid;
    ctx.lineWidth   = frac === 1 ? 1 : 0.75;
    ctx.setLineDash([]);
    ctx.stroke();
  });

  // Spokes every 30°.
  for (let a = 0; a < 360; a += 30) {
    const rad = a * Math.PI / 180;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + R * Math.cos(rad), cy - R * Math.sin(rad));
    ctx.strokeStyle = cGrid;
    ctx.lineWidth   = 0.5;
    ctx.stroke();
  }

  // Outer ring scale label at top-right.
  ctx.font         = "8px 'JetBrains Mono', monospace";
  ctx.fillStyle    = cDim;
  ctx.textAlign    = "left";
  ctx.textBaseline = "middle";
  ctx.fillText(`${maxRef} V`, cx + R * Math.cos(Math.PI / 4) + 3,
                               cy - R * Math.sin(Math.PI / 4));
  ctx.textBaseline = "alphabetic";

  // Phase direction labels just outside the outer ring.
  // L1 = 90° (up), L2 = −30° (lower-right), L3 = 210° (lower-left).
  [
    { label: "L1", angle: 90,  color: cl1 },
    { label: "L2", angle: -30, color: cl2 },
    { label: "L3", angle: 210, color: cl3 },
  ].forEach(({ label, angle, color }) => {
    const rad = angle * Math.PI / 180;
    const lx  = cx + (R + 11) * Math.cos(rad);
    const ly  = cy - (R + 11) * Math.sin(rad);
    ctx.font         = "bold 8px 'Inter', sans-serif";
    ctx.fillStyle    = color;
    ctx.textAlign    = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(label, lx, ly);
  });
  ctx.textBaseline = "alphabetic";

  // Origin dot.
  ctx.beginPath();
  ctx.arc(cx, cy, 3, 0, 2 * Math.PI);
  ctx.fillStyle = cText;
  ctx.fill();

  // Neutral offset vector — only draw if magnitude produces a visible length.
  const vx    = cx + re * scale;
  const vy    = cy - im * scale;
  const pxLen = Math.hypot(vx - cx, vy - cy);

  if (pxLen > 1.5) {
    // Shaft.
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(vx, vy);
    ctx.strokeStyle = cN;
    ctx.lineWidth   = 2;
    ctx.setLineDash([]);
    ctx.stroke();

    // Arrowhead.
    const ang = Math.atan2(cy - vy, vx - cx);
    const hs  = 6;
    ctx.beginPath();
    ctx.moveTo(vx, vy);
    ctx.lineTo(vx - hs * Math.cos(ang - 0.4), vy + hs * Math.sin(ang - 0.4));
    ctx.lineTo(vx - hs * Math.cos(ang + 0.4), vy + hs * Math.sin(ang + 0.4));
    ctx.closePath();
    ctx.fillStyle = cN;
    ctx.fill();

    // Magnitude label nudged outward from the tip.
    const nudge = 0.25;
    const lx = vx + (vx - cx) * nudge;
    const ly = vy + (vy - cy) * nudge - 4;
    ctx.font         = "bold 9px 'JetBrains Mono', monospace";
    ctx.fillStyle    = cN;
    ctx.textAlign    = "center";
    ctx.textBaseline = "bottom";
    ctx.fillText(`${mag.toFixed(2)} V`, lx, ly);
    ctx.textBaseline = "alphabetic";
  } else {
    // Zero (or negligible) offset — draw a centred label.
    ctx.font      = "9px 'JetBrains Mono', monospace";
    ctx.fillStyle = cText;
    ctx.textAlign = "center";
    ctx.fillText("balanced", cx, cy + 18);
  }
}

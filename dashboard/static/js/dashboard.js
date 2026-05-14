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

/**
 * Mutable palette reference; chartPalette() is provided by shared/chart-utils.js.
 * Initialised here so it is ready before DOMContentLoaded.
 */
let COLORS = chartPalette();


/* ── Taxes & Tariffs (NL defaults) ─────────────────────────────────────── */

const TARIFFS = {
  vatMultiplier: 1.21,
  electricity: {
    energyTax: 0.10880, // €/kWh (ex VAT)
    providerFee: 0.02,  // €/kWh (ex VAT)
  },
  gas: {
    energyTax: 0.58300, // €/m³ (ex VAT)
    providerFee: 0.08,  // €/m³ (ex VAT)
  }
};

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
  // In Chart.js 4, animation:false only disables the 'default' transition.
  // Hover events trigger update('active') which has its own 400 ms transition
  // by default. With slow render intervals, this animates from a stale state
  // and makes the data line appear to vanish until the transition completes.
  transitions: { active: { animation: { duration: 0 } } },
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
    transitions: { active: { animation: { duration: 0 } } },
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

let lastWasExporting  = null;
let liveFlipState     = null;
let liveFlipTs        = 0;
let flipCount         = 0;
let selectedRange     = "24";

/** Derive effective hours from the current range for bucket/cutoff calculations. */
function selectedHoursFromRange() {
    return Math.max(1, (Date.now() - resolveRangeSince(selectedRange)) / 3_600_000);
}

/**
 * Latest raw phase voltages from the most recent SSE reading.
 * Written every 1 Hz in applyReading; read by the 5-second render interval
 * to redraw the wye diagram without coupling the canvas repaint to the data tick.
 * @type {{v1:number, v2:number, v3:number}|null}
 */
let latestVoltages = null;

/**
 * Staging buffers for live data between render intervals.
 *
 * appendToCharts() pushes incoming SSE points here rather than directly into
 * chart.data. Chart.js caches pixel-position meta during update() calls; if
 * data is pushed to chart.data without a corresponding update(), the meta
 * becomes stale. When Chart.js renders on hover it uses the stale meta, so
 * un-rendered points appear missing (data blinks out until the next update).
 *
 * Draining into chart.data immediately before each update() keeps meta and
 * data always in sync regardless of how long the render interval is.
 */
const pendingLive = {
  power:   [],
  voltage: [[], [], []],
  current: [[], [], []],
};

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

/* Theme management is provided by shared/theme.js.
 * (THEME_CYCLE, THEME_LABELS, isDarkTheme, applyTheme, cycleTheme) */


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

  // Refresh the wye CSS cache so canvas draws use updated palette.
  refreshWyeCSS();

  // Refresh the mutable palette so newly-pushed data points use updated colours.
  Object.assign(COLORS, chartPalette());

  Chart.defaults.color = tick;

  [powerChart, ...voltageCharts, ...currentCharts, usageChart, costChart, gasChart, gasCostChart, forecastElecChart, forecastGasChart, forecastTempChart, forecastSolarChart].filter(Boolean).forEach(chart => {
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
  initSparklineModal();

  // Start the SSE stream and background fetches concurrently.
  // loadHistory is async and will populate charts when the fetch resolves;
  // there is no reason to delay connectSSE or loadSummary while waiting
  // for that to complete.
  connectSSE();
  loadHistory(resolveRangeSince(selectedRange));
  loadSummary();
  loadDevice();

  el.historyRange.addEventListener("change", () => {
    selectedRange = el.historyRange.value;
    const since = resolveRangeSince(selectedRange);
    const hours = selectedHoursFromRange();
    loadHistory(since);
    loadSummaryDelta(Math.ceil(hours));
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
  document.getElementById("tab-btn-forecast").addEventListener("click",    () => switchTab("forecast"));

  // Restore last active tab (or default to electricity).
  switchTab(localStorage.getItem("hegg-tab") || "electricity");

  // Minute-level refresh for absolute values; device info is static.
  setInterval(loadSummary, 60_000);
  setInterval(loadDevice,  300_000);

  // Usage-tab charts are on a hidden panel and only receive data after an
  // async fetch resolves. Deferring construction yields the main thread so
  // the browser can paint the initial layout before the second round of
  // Chart.js init work runs.
  setTimeout(() => {
    initUsageCharts();
    loadUsageCharts();
    initForecastChart();
    loadForecastChart();
    setInterval(loadUsageCharts, 60 * 60_000);
    setInterval(loadForecastChart, 15 * 60_000); // refresh forecast every 15 min
  }, 0);

  // Slide the X-axis min forward once per minute so the live edge stays
  // current without rebuilding axis config on every SSE tick.
  // Rebuild the X-axis cache every 5 minutes. The smallest step across all
  // history windows is 5 minutes (1 h window), so flooredMin never drifts
  // by more than one step between rebuilds.
  setInterval(() => { buildXAxisCache(selectedHoursFromRange()); applyXAxisConfig(); }, 5 * 60_000);

  // Trim data points and annotations that have scrolled out of the history
  // window. Running every 60 s means at most 60 extra live points accumulate
  // before the next prune — invisible on any history window — but avoids
  // the per-second O(n) splice cost of trimming inline with the SSE tick.
  setInterval(() => {
    const cutoff = resolveRangeSince(selectedRange);
    [powerChart, ...voltageCharts, ...currentCharts].forEach(c => trimOldPoints(c, cutoff));
    trimOldAnnotations(cutoff);
  }, 60_000);

  // Render electricity charts and the wye diagram every 5 seconds.
  // Live DOM numbers (power, voltages, currents) remain at 1 Hz.
  // Canvas redraws are the primary paint cost; reducing from 1 Hz to 0.2 Hz
  // cuts that cost by 5x with no perceptible change on any history window.
  setInterval(() => {
    // Install any resolved history frame before draining live data.
    // Moved here from appendToCharts so history installation is a render
    // concern rather than a data-pipeline concern.
    applyPendingFrame();

    // Drain staged live data into chart instances before updating meta.
    // This ensures chart.data and the pixel-position meta computed by
    // update() are always in sync, so hover renders never see stale data.
    if (pendingLive.power.length) {
      powerChart.data.datasets[0].data.push(...pendingLive.power);
      pendingLive.power.length = 0;
    }
    pendingLive.voltage.forEach((buf, i) => {
      if (buf.length) { voltageCharts[i].data.datasets[0].data.push(...buf); buf.length = 0; }
    });
    pendingLive.current.forEach((buf, i) => {
      if (buf.length) { currentCharts[i].data.datasets[0].data.push(...buf); buf.length = 0; }
    });

    if (latestVoltages) {
      updateWyeDiagram(latestVoltages.v1, latestVoltages.v2, latestVoltages.v3);
    }
    if (!powerChart.canvas.closest("[hidden]")) {
      powerChart.update("none");
      voltageCharts.forEach(c => c.update("none"));
      currentCharts.forEach(c => c.update("none"));
    }
  }, 5000);

  // Clock — updates every second.
  const tickClock = () => setText("header-time", new Date().toLocaleTimeString());
  tickClock();
  setInterval(tickClock, 1000);
});

/* ── Chart init ─────────────────────────────────────────────────────────── */

/** Initialise electricity-tab Chart.js instances (power, voltage, current). */
function initCharts() {
  Chart.defaults.color = "#6b7490";

  // Power chart: net only; afterDataLimits always includes zero.
  const powerOpts = structuredClone(BASE_OPTS);
  powerOpts.scales.y.afterDataLimits = scale => {
    scale.min = Math.min(scale.min, 0);
    scale.max = Math.max(scale.max, 0);
  };
  powerOpts.scales.y.title = { display: true, text: "W", color: "#6b7490", font: { size: 11 } };

  powerChart = new Chart(document.getElementById("chart-power"), {
    type: "line",
    data: {
      datasets: [{
        label: "Net",
        data: [],
        borderColor: COLORS.net,
        backgroundColor: "transparent",
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
 * Initialise the three usage-tab Chart.js instances (cost, usage, gas).
 *
 * Called via setTimeout(fn, 0) in DOMContentLoaded so these hidden-tab
 * charts do not block the initial paint. They are not needed until
 * loadUsageCharts() resolves its async fetch, which always takes longer
 * than a single yielded task.
 */
function initUsageCharts() {
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
        { label: "Import T1 (kWh)", data: [], backgroundColor: COLORS.delivered + "55", borderRadius: 3, borderSkipped: false },
        { label: "Import T2 (kWh)", data: [], backgroundColor: COLORS.delivered + "cc", borderRadius: 3, borderSkipped: false },
        { label: "Export T1 (kWh)", data: [], backgroundColor: COLORS.returned  + "55", borderRadius: 3, borderSkipped: false },
        { label: "Export T2 (kWh)", data: [], backgroundColor: COLORS.returned  + "cc", borderRadius: 3, borderSkipped: false },
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

  // Hourly gas cost.
  gasCostChart = new Chart(document.getElementById("chart-gas-cost"), {
    type: "bar",
    data: {
      labels: [],
      datasets: [{
        label: "Gas Cost (€)",
        data: [],
        backgroundColor: "#f59e0bcc",
        borderRadius: 3,
        borderSkipped: false,
      }],
    },
    options: _barOpts("€", v => `€${v.toFixed(3)}`, ctx => `${ctx.dataset.label}: €${Math.abs(ctx.parsed.y).toFixed(4)}`),
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
let currentHistoryFetchId = 0;
async function loadHistory(since) {
  const fetchId = ++currentHistoryFetchId;
  let data;
  try {
    const res = await fetch(`/api/history?since=${since}`);
    if (fetchId !== currentHistoryFetchId) return;
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
  let histFlipState  = null;
  let histFlipTs     = 0;

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
    if (idx === 0) {
      prevExporting = exporting;
      lastExporting = exporting;
    } else if (exporting !== prevExporting) {
      if (histFlipState === exporting) {
        if (ts - histFlipTs >= 10000) {
          const id = `flip_${localFlipCount++}`;
          newFlipAnnotations[id] = buildFlipAnnotationDescriptor(histFlipTs, exporting);
          prevExporting = exporting;
          lastExporting = exporting;
          histFlipState = null;
        }
      } else {
        histFlipState = exporting;
        histFlipTs = ts;
      }
    } else {
      histFlipState = null;
      lastExporting = exporting;
    }
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
  await Promise.all([loadSummaryLatest(), loadSummaryDelta(Math.ceil(selectedHoursFromRange()))]);
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
let currentSummaryDeltaFetchId = 0;
async function loadSummaryDelta(hours) {
  const fetchId = ++currentSummaryDeltaFetchId;
  let d;
  try {
    const res = await fetch(`/api/summary/delta?hours=${hours}`);
    if (fetchId !== currentSummaryDeltaFetchId) return;
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

/* ── Tab management ─────────────────────────────────────────────── */
// switchTab() is provided by shared/chart-utils.js and dispatches
// 'dashboard:tabswitch'.  App-specific chart resize and localStorage
// persistence are handled in the listener below.

document.addEventListener("dashboard:tabswitch", ({ detail }) => {
  localStorage.setItem("hegg-tab", detail.id);
  // Chart.js cannot measure a hidden canvas; resize after the panel is revealed.
  if (detail.id === "usage") {
    [usageChart, costChart, gasChart, gasCostChart].forEach(c => {
      if (c) { c.resize(); c.update("none"); }
    });
  } else if (detail.id === "forecast") {
    [forecastElecChart, forecastGasChart, forecastTempChart, forecastSolarChart].forEach(c => {
      if (c) { c.resize(); c.update("none"); }
    });
  } else {
    [powerChart, ...voltageCharts, ...currentCharts].forEach(c => {
      if (c) { c.resize(); c.update("none"); }
    });
  }
});


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
    transitions: { active: { animation: { duration: 0 } } },
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
/** @type {Chart|null} */ let gasCostChart = null;
/** @type {Chart|null} */ let forecastElecChart = null;
/** @type {Chart|null} */ let forecastGasChart = null;
/** @type {Chart|null} */ let forecastTempChart = null;
/** @type {Chart|null} */ let forecastSolarChart = null;

/**
 * Fetch hourly consumption and price data and populate all three Usage &
 * Cost charts in one pass.
 *
 * Prices are optional — consumption charts always render, cost chart only
 * renders for hours where a price is available.
 */
let currentUsageFetchId = 0;
async function loadUsageCharts() {
  const fetchId = ++currentUsageFetchId;
  let consumption, prices;
  let gasPrices;
  try {
    const [rC, rP, rGP] = await Promise.all([
      fetch(`/api/summary/hourly?hours=${Math.ceil(selectedHoursFromRange())}`),
      fetch(`/api/prices?hours=${Math.ceil(selectedHoursFromRange())}`),
      fetch(`/api/prices/gas?hours=${Math.ceil(selectedHoursFromRange())}`),
    ]);
    if (fetchId !== currentUsageFetchId) return;
    if (!rC.ok || rC.status === 204) return;
    consumption = await rC.json();
    prices = rP.ok && rP.status !== 204 ? await rP.json() : [];
    gasPrices = rGP.ok && rGP.status !== 204 ? await rGP.json() : [];
  } catch {
    return;
  }

  // Build lookups by hour timestamp.
  const consumMap = {};
  for (const c of consumption) consumMap[c.ts] = c;
  const priceMap = {};
  for (const p of prices) priceMap[p.ts_start] = p.price_eur_kwh;

  const getGasPrice = (ts) => {
    const p = gasPrices.find(g => g.ts_start <= ts && g.ts_end > ts);
    return p ? p.price_eur_m3 : null;
  };

  // Generate every UTC hour slot for the full selected window.
  // Hours with no data get 0 so the x-axis spans the complete range.
  const HOUR_MS  = 3_600_000;
  const nowMs    = Date.now();
  const startMs  = Math.floor(resolveRangeSince(selectedRange) / HOUR_MS) * HOUR_MS;

  const labels = [], d1 = [], d2 = [], r1 = [], r2 = [], gas = [];
  const importCost = [], exportRevenue = [], gasCost = [];

  let totalElecSpot = 0, totalElecTaxFee = 0;
  let totalGasSpot = 0, totalGasTaxFee = 0;

  for (let h = startMs; h <= nowMs; h += HOUR_MS) {
    const c     = consumMap[h];
    const price = priceMap[h] ?? null;
    const gasP  = getGasPrice(h);
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

    let loadedPE = null;
    if (price !== null) {
      const imp = del1 + del2;
      const exp = ret1 + ret2;
      const netKwh = imp - exp;
      
      totalElecSpot += (imp * price) - (exp * price);
      totalElecTaxFee += netKwh * (TARIFFS.electricity.energyTax + TARIFFS.electricity.providerFee);
      loadedPE = (price + TARIFFS.electricity.energyTax + TARIFFS.electricity.providerFee) * TARIFFS.vatMultiplier;
    }
    
    let loadedPG = null;
    if (gasP !== null) {
      totalGasSpot += gasV * gasP;
      totalGasTaxFee += gasV * (TARIFFS.gas.energyTax + TARIFFS.gas.providerFee);
      loadedPG = (gasP + TARIFFS.gas.energyTax + TARIFFS.gas.providerFee) * TARIFFS.vatMultiplier;
    }

    importCost.push(   loadedPE !== null ? +((del1 + del2) * loadedPE).toFixed(4) : 0);
    exportRevenue.push(loadedPE !== null ? -(+(ret1 + ret2) * loadedPE).toFixed(4) : 0);
    gasCost.push(      loadedPG !== null ? +(gasV * loadedPG).toFixed(4) : 0);
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
  if (gasCostChart) {
    gasCostChart.data.labels           = labels;
    gasCostChart.data.datasets[0].data = gasCost;
  }

  // Only repaint if the usage tab is currently visible.
  if (usageChart && !usageChart.canvas.closest("[hidden]")) {
    usageChart.update("none");
    if (gasChart)  gasChart.update("none");
    if (costChart) costChart.update("none");
    if (gasCostChart) gasCostChart.update("none");
  }

  // Period label, matching the format used by loadSummaryDelta.
  const _hours = selectedHoursFromRange();
  const _label = _hours >= 24 ? `${Math.round(_hours / 24)}d` : `${Math.round(_hours)}h`;

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

  const elecBrk = document.getElementById("cost-elec-breakdown");
  if (elecBrk) {
    const totalElecVat = (totalElecSpot + totalElecTaxFee) * (TARIFFS.vatMultiplier - 1);
    elecBrk.textContent = `Energy: €${totalElecSpot.toFixed(2)} | Tax+Fee: €${totalElecTaxFee.toFixed(2)} | VAT: €${totalElecVat.toFixed(2)}`;
  }

  // Gas totals.
  const totalGas = gas.reduce((a, b) => a + b, 0);
  setText("gas-total-val", totalGas.toFixed(3));
  
  const totalGasCost = gasCost.reduce((a, b) => a + b, 0);
  setText("cost-gas-total", totalGasCost.toFixed(2));

  const gasBrk = document.getElementById("cost-gas-breakdown");
  if (gasBrk) {
    const totalGasVat = (totalGasSpot + totalGasTaxFee) * (TARIFFS.vatMultiplier - 1);
    gasBrk.textContent = `Energy: €${totalGasSpot.toFixed(2)} | Tax+Fee: €${totalGasTaxFee.toFixed(2)} | VAT: €${totalGasVat.toFixed(2)}`;
  }

}

/* ── Forecast & Pricing tab ────────────────────────────────────────────── */

function initForecastChart() {
  const getOpts = (yTitle, tooltipCb, beginAtZero) => ({
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    interaction: { mode: "index", intersect: false },
    elements: {
      point: { radius: 0, hitRadius: 10, hoverRadius: 4 }
    },
    plugins: {
      legend: { display: false },
      tooltip: { callbacks: { label: tooltipCb } }
    },
    scales: {
      x: {
        type: "time",
        grid: { color: () => WYE_CSS.grid, drawBorder: false },
        ticks: { color: () => WYE_CSS.text, maxRotation: 0, autoSkip: true, autoSkipPadding: 20 },
      },
      y: {
        type: "linear",
        position: "left",
        title: { display: true, text: yTitle, color: () => WYE_CSS.text },
        grid: { color: () => WYE_CSS.grid, drawBorder: false },
        ticks: { color: () => WYE_CSS.text },
        beginAtZero: beginAtZero
      }
    }
  });

  const optsE = getOpts("€ / kWh", ctx => `€${ctx.raw.y.toFixed(3)}`, true);
  optsE.scales.x.offset = true;
  const ctxE = document.getElementById("chart-forecast-elec");
  if (ctxE) forecastElecChart = new Chart(ctxE, { type: "bar", data: { datasets: [] }, options: optsE });

  const ctxG = document.getElementById("chart-forecast-gas");
  if (ctxG) forecastGasChart = new Chart(ctxG, { type: "line", data: { datasets: [] }, options: getOpts("€ / m³", ctx => `€${ctx.raw.y.toFixed(3)}`, true) });

  const ctxT = document.getElementById("chart-forecast-temp");
  if (ctxT) forecastTempChart = new Chart(ctxT, { type: "line", data: { datasets: [] }, options: getOpts("°C", ctx => `${ctx.raw.y.toFixed(1)} °C`, false) });

  const ctxS = document.getElementById("chart-forecast-solar");
  if (ctxS) forecastSolarChart = new Chart(ctxS, { type: "line", data: { datasets: [] }, options: getOpts("W/m²", ctx => `${ctx.raw.y} W/m²`, true) });
}

let currentForecastFetchId = 0;
async function loadForecastChart() {
  const fetchId = ++currentForecastFetchId;
  let pricesElec, pricesGas, weather;
  try {
    const [rPE, rPG, rW] = await Promise.all([
      fetch(`/api/prices?hours=48`),
      fetch(`/api/prices/gas?hours=48`),
      fetch(`/api/weather?hours=48`),
    ]);
    if (fetchId !== currentForecastFetchId) return;
    pricesElec = (rPE.ok && rPE.status !== 204) ? await rPE.json() : [];
    pricesGas = (rPG.ok && rPG.status !== 204) ? await rPG.json() : [];
    weather = (rW.ok && rW.status !== 204) ? await rW.json() : [];
  } catch {
    return;
  }

  const now = Date.now();
  const nowMs = Math.floor(now / 3600000) * 3600000;
  const maxMs = nowMs + (48 * 3600000);

  // Filter all data strictly to [nowMs, maxMs]
  const filterByTime = (p) => {
    const ts = p.ts || p.ts_start;
    return ts >= nowMs && ts <= maxMs;
  };
  
  pricesElec = pricesElec.filter(filterByTime);
  weather = weather.filter(filterByTime);

  // Gas: deduplicate overlapping chunks by sorting and cleaning up the map
  const validGasMap = new Map();
  pricesGas.forEach(p => {
    if (p.ts_start <= maxMs && p.ts_end >= nowMs) {
      validGasMap.set(p.ts_start, p);
    }
  });
  const validGas = Array.from(validGasMap.values()).sort((a,b) => a.ts_start - b.ts_start);

  const currentElec = pricesElec.length > 0 ? pricesElec[0] : null;
  const currentGas = validGas.find(p => p.ts_start <= now && p.ts_end > now) || validGas[0];
  
  if (currentElec) {
    const loadedE = (currentElec.price_eur_kwh + TARIFFS.electricity.energyTax + TARIFFS.electricity.providerFee) * TARIFFS.vatMultiplier;
    document.getElementById("current-elec-price").textContent = `€${loadedE.toFixed(3)}`;
  }
  if (currentGas) {
    const loadedG = (currentGas.price_eur_m3 + TARIFFS.gas.energyTax + TARIFFS.gas.providerFee) * TARIFFS.vatMultiplier;
    document.getElementById("current-gas-price").textContent = `€${loadedG.toFixed(3)}`;
  }

  let currentTempStr = "—";
  if (weather.length > 0) {
    currentTempStr = `${weather[0].temperature_c.toFixed(1)} °C`;
  }
  document.getElementById("current-temp").textContent = currentTempStr;

  const setScale = (c) => {
    if (c) {
      c.options.scales.x.min = nowMs;
      c.options.scales.x.max = maxMs;
    }
  };
  [forecastElecChart, forecastGasChart, forecastTempChart, forecastSolarChart].forEach(setScale);

  if (forecastElecChart) {
    const elecData = pricesElec.map(p => {
      const loadedPE = (p.price_eur_kwh + TARIFFS.electricity.energyTax + TARIFFS.electricity.providerFee) * TARIFFS.vatMultiplier;
      return { x: p.ts_start, y: loadedPE };
    });
    // Project the last known electricity price hourly to the edge of the chart (+48h)
    if (pricesElec.length > 0) {
      const last = pricesElec[pricesElec.length - 1];
      const loadedPE = (last.price_eur_kwh + TARIFFS.electricity.energyTax + TARIFFS.electricity.providerFee) * TARIFFS.vatMultiplier;
      let nextTs = last.ts_end;
      while (nextTs < maxMs) {
        elecData.push({ x: nextTs, y: loadedPE });
        nextTs += 3600000;
      }
    }

    const sortedPrices = elecData.map(d => d.y).sort((a,b) => a - b);
    const p15 = sortedPrices[Math.max(0, Math.floor(sortedPrices.length * 0.15) - 1)] || 0;
    const p85 = sortedPrices[Math.min(sortedPrices.length - 1, Math.floor(sortedPrices.length * 0.85))] || 0;

    const bgColors = elecData.map(d => {
      if (d.y >= p85) return "#3b82f6cc"; // Blue
      if (d.y <= p15) return "#10b981cc"; // Green
      return "#6b749088";                 // Neutral grey
    });

    forecastElecChart.data.datasets = [{
      label: "Electricity Cost",
      data: elecData,
      backgroundColor: bgColors,
      borderRadius: 3,
      borderSkipped: false
    }];
    forecastElecChart.update();
  }

  if (forecastGasChart) {
    const gasData = [];
    validGas.forEach(p => {
      const loadedPG = (p.price_eur_m3 + TARIFFS.gas.energyTax + TARIFFS.gas.providerFee) * TARIFFS.vatMultiplier;
      gasData.push({ x: p.ts_start, y: loadedPG });
    });
    // Project the last known gas price to the edge of the chart (+48h)
    if (validGas.length > 0) {
      const last = validGas[validGas.length - 1];
      const loadedPG = (last.price_eur_m3 + TARIFFS.gas.energyTax + TARIFFS.gas.providerFee) * TARIFFS.vatMultiplier;
      gasData.push({ x: Math.max(last.ts_end, maxMs), y: loadedPG });
    }
    forecastGasChart.data.datasets = [{
      label: "Gas Cost",
      data: gasData,
      borderColor: COLORS.returned,
      backgroundColor: COLORS.returned + "33",
      stepped: "after",
      fill: "origin"
    }];
    forecastGasChart.update();
  }

  if (forecastTempChart) {
    forecastTempChart.data.datasets = [{
      label: "Temperature",
      data: weather.map(w => ({ x: w.ts, y: w.temperature_c })),
      borderColor: COLORS.voltage,
      tension: 0.4
    }];
    forecastTempChart.update();
  }

  if (forecastSolarChart) {
    forecastSolarChart.data.datasets = [{
      label: "Solar Radiation",
      data: weather.map(w => ({ x: w.ts, y: w.solar_wm2 })),
      borderColor: "#fadb14",
      backgroundColor: "#fadb1433",
      fill: true,
      tension: 0.4
    }];
    forecastSolarChart.update();
  }
}

/* ── SSE ────────────────────────────────────────────────────────────────── */

let eventSource    = null;
let reconnectDelay = 2000;

/**
 * Raw SSE readings waiting to be processed by the rAF consumer.
 * The SSE message handler pushes here and exits immediately; all
 * processing (DOM updates, EMA, pendingLive staging) happens in
 * drainSSEBuffer() which runs inside a requestAnimationFrame.
 * @type {object[]}
 */
const sseBuffer = [];
let   sseRafPending = false;

function connectSSE() {
  setStatus("connecting", "Connecting…");
  eventSource = new EventSource("/stream");

  eventSource.addEventListener("open", () => {
    setStatus("connected", "Live");
    reconnectDelay = 2000;
  });

  eventSource.addEventListener("message", event => {
    try {
      sseBuffer.push(JSON.parse(event.data));
      // Hard cap to prevent memory leak in long-running background tabs (24h of 1Hz data)
      if (sseBuffer.length > 86400) {
        sseBuffer.splice(0, sseBuffer.length - 86400);
      }
      if (!sseRafPending) {
        sseRafPending = true;
        requestAnimationFrame(drainSSEBuffer);
      }
    } catch (err) { console.warn("SSE parse error:", err); }
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

/**
 * rAF consumer for the SSE data pipeline.
 *
 * Scheduled by the SSE message handler (one rAF per batch, not a permanent
 * loop). Drains sseBuffer, applying each reading to the DOM and staging
 * chart data into pendingLive. Running inside rAF naturally synchronises
 * DOM text updates with the browser's paint cycle.
 */
function drainSSEBuffer() {
  sseRafPending = false;
  // O(1) array drain prevents CPU lockup in background tabs
  const batch = sseBuffer.splice(0, sseBuffer.length);
  for (let i = 0; i < batch.length; i++) {
    applyReading(batch[i]);
  }
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

  // Cache raw voltages for the wye diagram; the canvas is redrawn by the
  // 5-second render interval rather than on every SSE tick.
  latestVoltages = {
    v1: r.voltage_l1 ?? 0,
    v2: r.voltage_l2 ?? 0,
    v3: r.voltage_l3 ?? 0,
  };

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
  const ts = new Date(r.timestamp).getTime();
  const s  = smoothReading(r);  // EMA-smoothed copy for chart points

  // Stage into pendingLive; data is drained into chart instances at render
  // time so chart meta stays in sync with rendered data.
  pendingLive.power.push({
    x: ts,
    y: Math.round((s.power_delivered - s.power_returned) * 1000),
  });

  // Use raw r for flip detection — debounced by 10 seconds.
  const exporting = r.power_returned > r.power_delivered;
  if (lastWasExporting === null) {
    lastWasExporting = exporting;
  } else if (exporting !== lastWasExporting) {
    if (liveFlipState === exporting) {
      if (ts - liveFlipTs >= 10000) {
        addFlipAnnotation(liveFlipTs, exporting);
        lastWasExporting = exporting;
        liveFlipState = null;
      }
    } else {
      liveFlipState = exporting;
      liveFlipTs = ts;
    }
  } else {
    liveFlipState = null;
    lastWasExporting = exporting;
  }

  // Voltage — smoothed for chart, raw for extremes tracking.
  // syncChartScales only runs when an extreme is breached.
  let vChanged = false;
  ["voltage_l1", "voltage_l2", "voltage_l3"].forEach((f, i) => {
    pendingLive.voltage[i].push({ x: ts, y: s[f] });
    const v = r[f];
    if (v < voltageExtremes[i].min) { voltageExtremes[i].min = v; updateVoltageAnnotation(i); vChanged = true; }
    if (v > voltageExtremes[i].max) { voltageExtremes[i].max = v; updateVoltageAnnotation(i); vChanged = true; }
  });
  if (vChanged) syncChartScales(voltageCharts, voltageExtremes);

  // Current — same gating.
  let cChanged = false;
  ["current_l1", "current_l2", "current_l3"].forEach((f, i) => {
    pendingLive.current[i].push({ x: ts, y: s[f] });
    const v = r[f];
    if (v < currentExtremes[i].min) { currentExtremes[i].min = v; cChanged = true; }
    if (v > currentExtremes[i].max) { currentExtremes[i].max = v; cChanged = true; }
  });
  if (cChanged) syncChartScales(currentCharts, currentExtremes, 0);

  // Trimming is handled by a separate interval (see DOMContentLoaded).
  // Doing it here every second with Array.shift() on large arrays is O(n)
  // per tick and was a primary source of CPU load in long-running sessions.

  // Chart repaints are handled by the render interval (see DOMContentLoaded).
  // Calling chart.update() here every second was 90 %+ of main-thread paint
  // cost. Data accumulates in the arrays at 1 Hz; the canvas redraws at 2 Hz.
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
  const bucketSeconds = Math.max(5, Math.floor((selectedHoursFromRange() * 3600) / 500));
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
/**
 * Remove data points older than cutoff from all datasets on a chart.
 *
 * Uses a single splice(0, n) rather than repeated shift() calls.
 * shift() on a large array is O(n) per call; splice(0, n) is O(n) once
 * for the same number of removals, so batching eliminates the quadratic
 * behaviour that accumulates in long-running sessions.
 *
 * @param {import('chart.js').Chart} chart
 * @param {number} cutoff - Epoch ms; points with x < cutoff are removed.
 */
function trimOldPoints(chart, cutoff) {
  for (const ds of chart.data.datasets) {
    let n = 0;
    while (n < ds.data.length && ds.data[n].x < cutoff) n++;
    if (n > 0) ds.data.splice(0, n);
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
/* Y-axis scaling: niceScale() and syncChartScales() are provided by
 * shared/chart-utils.js.  updateInlineScale is hegg-emon-specific. */

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


/* ── Wye phasor diagram ─────────────────────────────────────────────────── */
// lineVoltage, neutralShift, voltageImbalance, initWyeDiagram,
// resizeWyeCanvas, resizeNeutralCanvas, drawWyeDiagram, drawNeutralMini,
// and updateWyeDiagram are all provided by shared/wye.js.
//
// hegg-emon passes (v1, v2, v3) to updateWyeDiagram; the shared function
// calculates L-L values via lineVoltage() when no measured value is supplied.


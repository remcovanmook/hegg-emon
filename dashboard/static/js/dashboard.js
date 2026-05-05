/**
 * @file dashboard.js
 * @description Live dashboard logic for the Hegg energy monitor.
 *
 * Connects to the Flask SSE endpoint at /stream, parses incoming
 * HeggReading JSON objects, updates the DOM cards, and maintains
 * three rolling sparkline charts (power, voltage, current) drawn
 * on <canvas> elements using pure 2D canvas API — no charting lib.
 *
 * Data flow:
 *   Server (Flask /stream SSE)
 *     → EventSource
 *     → applyReading(reading)
 *     → updateCards() + pushHistory() + renderCharts()
 */

"use strict";

/** Maximum number of samples retained in history rings. */
const HISTORY_SAMPLES = 60;

/** Ring-buffer history for sparkline charts. */
const history = {
  powerDelivered: [],
  powerReturned:  [],
  voltageL1: [], voltageL2: [], voltageL3: [],
  currentL1: [], currentL2: [], currentL3: [],
};

/** DOM element references, resolved once on DOMContentLoaded. */
let el = {};

/** Maximum kW seen — used to scale the progress bar fill. */
let maxPowerSeen = 1;

/* ─────────────────────────────────────────
   Initialisation
───────────────────────────────────────── */

document.addEventListener("DOMContentLoaded", () => {
  el = {
    statusDot:     document.getElementById("status-dot"),
    statusLabel:   document.getElementById("status-label"),

    powerDelivered: document.getElementById("power-delivered"),
    powerReturned:  document.getElementById("power-returned"),
    powerNet:       document.getElementById("power-net"),
    netHint:        document.getElementById("net-hint"),

    barDelivered:   document.getElementById("bar-delivered"),
    barReturned:    document.getElementById("bar-returned"),

    voltageL1: document.getElementById("voltage-l1"),
    voltageL2: document.getElementById("voltage-l2"),
    voltageL3: document.getElementById("voltage-l3"),

    currentL1: document.getElementById("current-l1"),
    currentL2: document.getElementById("current-l2"),
    currentL3: document.getElementById("current-l3"),

    deviceSerial: document.getElementById("device-serial"),
    lastUpdated:  document.getElementById("last-updated"),

    chartPower:   document.getElementById("chart-power"),
    chartVoltage: document.getElementById("chart-voltage"),
    chartCurrent: document.getElementById("chart-current"),
  };

  connectSSE();
});

/* ─────────────────────────────────────────
   SSE connection management
───────────────────────────────────────── */

let eventSource = null;
let reconnectTimer = null;
let reconnectDelay = 2000;

/**
 * Open an EventSource connection to /stream and register handlers.
 * On error the connection is torn down and retried with exponential
 * back-off up to 30 s.
 */
function connectSSE() {
  setStatus("connecting", "Connecting…");
  eventSource = new EventSource("/stream");

  eventSource.addEventListener("open", () => {
    setStatus("connected", "Live");
    reconnectDelay = 2000;
  });

  eventSource.addEventListener("message", (event) => {
    try {
      const reading = JSON.parse(event.data);
      applyReading(reading);
    } catch (err) {
      console.warn("Failed to parse SSE message:", err);
    }
  });

  eventSource.addEventListener("error", () => {
    setStatus("disconnected", "Reconnecting…");
    eventSource.close();
    reconnectTimer = setTimeout(() => {
      reconnectDelay = Math.min(reconnectDelay * 1.5, 30000);
      connectSSE();
    }, reconnectDelay);
  });
}

/**
 * Update the connection-status indicator.
 * @param {"connecting"|"connected"|"disconnected"} state  CSS class applied to the dot.
 * @param {string} label  Human-readable status text.
 */
function setStatus(state, label) {
  el.statusDot.className = `status-dot ${state}`;
  el.statusLabel.textContent = label;
}

/* ─────────────────────────────────────────
   Reading application
───────────────────────────────────────── */

/**
 * Apply a parsed HeggReading to the dashboard UI.
 * Updates cards, progress bars, footer metadata, and charts.
 * @param {Object} r  Raw parsed JSON object from the SSE stream.
 */
function applyReading(r) {
  const delivered = r.power_delivered ?? 0;
  const returned  = r.power_returned  ?? 0;
  const net       = delivered - returned;

  /* ── Power cards ── */
  setValue(el.powerDelivered, delivered.toFixed(3));
  setValue(el.powerReturned,  returned.toFixed(3));
  setValue(el.powerNet, Math.abs(net).toFixed(3));
  el.netHint.textContent = net > 0.001
    ? "importing from grid"
    : net < -0.001
      ? "exporting to grid"
      : "balanced";

  /* ── Progress bars (scale to max seen) ── */
  maxPowerSeen = Math.max(maxPowerSeen, delivered, returned, 0.001);
  el.barDelivered.style.width = `${(delivered / maxPowerSeen) * 100}%`;
  el.barReturned.style.width  = `${(returned  / maxPowerSeen) * 100}%`;

  /* ── Voltage cards ── */
  setValue(el.voltageL1, r.voltage_l1);
  setValue(el.voltageL2, r.voltage_l2);
  setValue(el.voltageL3, r.voltage_l3);

  /* ── Current cards ── */
  setValue(el.currentL1, r.current_l1);
  setValue(el.currentL2, r.current_l2);
  setValue(el.currentL3, r.current_l3);

  /* ── Footer ── */
  el.deviceSerial.textContent = r.serial ?? "—";
  el.lastUpdated.textContent  = new Date(r.timestamp).toLocaleTimeString();

  /* ── Charts ── */
  pushHistory(r);
  renderCharts();
}

/**
 * Set a DOM element's text content and trigger a brief flash animation.
 * @param {HTMLElement} elem   Target element.
 * @param {string|number} val  New value to display.
 */
function setValue(elem, val) {
  elem.textContent = val;
  elem.classList.remove("value-updated");
  void elem.offsetWidth; // force reflow to restart animation
  elem.classList.add("value-updated");
}

/* ─────────────────────────────────────────
   History ring-buffer
───────────────────────────────────────── */

/**
 * Append the current reading to each history ring.
 * Trims to HISTORY_SAMPLES when full.
 * @param {Object} r  Raw parsed JSON reading.
 */
function pushHistory(r) {
  const push = (arr, val) => {
    arr.push(val);
    if (arr.length > HISTORY_SAMPLES) arr.shift();
  };

  push(history.powerDelivered, r.power_delivered ?? 0);
  push(history.powerReturned,  r.power_returned  ?? 0);
  push(history.voltageL1, r.voltage_l1);
  push(history.voltageL2, r.voltage_l2);
  push(history.voltageL3, r.voltage_l3);
  push(history.currentL1, r.current_l1);
  push(history.currentL2, r.current_l2);
  push(history.currentL3, r.current_l3);
}

/* ─────────────────────────────────────────
   Canvas sparkline renderer
───────────────────────────────────────── */

/** Colour tokens for chart lines, matching CSS variables. */
const COLORS = {
  delivered: "#3b82f6",
  returned:  "#22c55e",
  l1: "#818cf8",
  l2: "#38bdf8",
  l3: "#fb923c",
};

/**
 * Render all three sparkline canvases from the current history buffers.
 * Each canvas is cleared and redrawn on every call.
 */
function renderCharts() {
  drawSparklines(el.chartPower, [
    { data: history.powerDelivered, color: COLORS.delivered, label: "Delivered" },
    { data: history.powerReturned,  color: COLORS.returned,  label: "Returned" },
  ]);

  drawSparklines(el.chartVoltage, [
    { data: history.voltageL1, color: COLORS.l1 },
    { data: history.voltageL2, color: COLORS.l2 },
    { data: history.voltageL3, color: COLORS.l3 },
  ]);

  drawSparklines(el.chartCurrent, [
    { data: history.currentL1, color: COLORS.l1 },
    { data: history.currentL2, color: COLORS.l2 },
    { data: history.currentL3, color: COLORS.l3 },
  ]);
}

/**
 * Draw one or more line series on a canvas element.
 *
 * Scales all series together against a shared min/max so the relative
 * magnitudes between series are preserved.  When fewer than two data
 * points are available the canvas is left blank.
 *
 * @param {HTMLCanvasElement} canvas  Target canvas.
 * @param {Array<{data: number[], color: string}>} series  Data series.
 */
function drawSparklines(canvas, series) {
  const dpr = window.devicePixelRatio || 1;
  const W   = canvas.clientWidth  || canvas.width;
  const H   = canvas.clientHeight || canvas.height;

  // Sync logical size with physical pixels once.
  if (canvas.width !== W * dpr || canvas.height !== H * dpr) {
    canvas.width  = W * dpr;
    canvas.height = H * dpr;
  }

  const ctx = canvas.getContext("2d");
  ctx.resetTransform();
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, W, H);

  const allPoints = series.flatMap(s => s.data);
  if (allPoints.length < 2) return;

  const minV = Math.min(...allPoints);
  const maxV = Math.max(...allPoints);
  const range = maxV - minV || 1;

  const pad = { top: 8, bottom: 8, left: 0, right: 0 };
  const innerW = W - pad.left - pad.right;
  const innerH = H - pad.top  - pad.bottom;

  /**
   * Map a value to its canvas Y coordinate.
   * @param {number} v  Data value.
   * @returns {number}  Canvas Y.
   */
  const toY = (v) => pad.top + innerH - ((v - minV) / range) * innerH;

  /**
   * Map a data-point index to its canvas X coordinate.
   * @param {number} i    Index within the series.
   * @param {number} len  Total series length.
   * @returns {number}    Canvas X.
   */
  const toX = (i, len) => pad.left + (i / (len - 1)) * innerW;

  /* Draw grid lines */
  ctx.strokeStyle = "rgba(255,255,255,0.05)";
  ctx.lineWidth = 1;
  for (let g = 0; g <= 3; g++) {
    const y = pad.top + (g / 3) * innerH;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(W, y);
    ctx.stroke();
  }

  /* Draw each series */
  for (const { data, color } of series) {
    if (data.length < 2) continue;

    // Filled area under the line.
    const grad = ctx.createLinearGradient(0, pad.top, 0, H);
    grad.addColorStop(0, color + "33");
    grad.addColorStop(1, color + "00");

    ctx.beginPath();
    ctx.moveTo(toX(0, data.length), toY(data[0]));
    for (let i = 1; i < data.length; i++) {
      ctx.lineTo(toX(i, data.length), toY(data[i]));
    }
    ctx.lineTo(toX(data.length - 1, data.length), H);
    ctx.lineTo(toX(0, data.length), H);
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();

    // Line itself.
    ctx.beginPath();
    ctx.moveTo(toX(0, data.length), toY(data[0]));
    for (let i = 1; i < data.length; i++) {
      ctx.lineTo(toX(i, data.length), toY(data[i]));
    }
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.lineJoin = "round";
    ctx.stroke();
  }
}

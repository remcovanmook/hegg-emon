/**
 * @file shared/chart-utils.js
 * Chart.js utility helpers and UI infrastructure shared between dashboard
 * projects.
 *
 * Exposes:
 *   niceScale(rawMin, rawMax, maxIntervals)          – human-friendly axis step
 *   syncChartScales(charts, extremes, floor)          – unified Y axis across a group
 *   statusAnnotationColor(statusStr)                  – CSS-var-driven status colour
 *   buildStatusAnnotation(tsMs, statusStr)            – vertical Chart.js annotation
 *   updateSparklineAnnotations(chart, min, max, color) – min/max band overlays
 *   chartPalette()                                    – read colour tokens from CSS
 *   getBaseOpts()                                     – shared Chart.js base config
 *   createChart(id, series, showLegend)               – Chart.js instance factory
 *   updateDOM(id, val)                                – idempotent DOM text update
 *   pushChart(chart, ts, values)                      – append a live reading
 *   initFlowScale()                                   – SVG flow diagram scaler
 *   switchTab(id)                                     – tab panel switcher
 *                                                       (fires dashboard:tabswitch)
 *   resolveRangeSince(value)                            – convert range select value
 *                                                       to a since-ms timestamp
 *
 * Load order: load after theme.js, before app-specific JS.
 * Requires: Chart.js (global Chart), chartjs-plugin-annotation.
 */

"use strict";

// ── History range resolution ──────────────────────────────────────────────────

/**
 * Resolve a history-range <select> value to a "since" timestamp in
 * milliseconds.
 *
 * Numeric values ("1", "6", "24", etc.) are treated as hours relative to
 * now.  Calendar keywords use the browser's local timezone:
 *
 *   "today"  – midnight of the current day
 *   "week"   – midnight of Monday (ISO week start)
 *   "month"  – midnight of the 1st of the current month
 *
 * @param {string} value - The <select> option value.
 * @returns {number} Unix timestamp in milliseconds.
 */
function resolveRangeSince(value) {
    const now = new Date();
    switch (value) {
        case "today":
            return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
        case "week": {
            // ISO week: Monday = start.  JS getDay(): 0=Sun, 1=Mon … 6=Sat.
            const daysSinceMonday = (now.getDay() + 6) % 7;
            return new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysSinceMonday).getTime();
        }
        case "month":
            return new Date(now.getFullYear(), now.getMonth(), 1).getTime();
        default: {
            const hours = Number.parseInt(value, 10) || 24;
            return Date.now() - hours * 3_600_000;
        }
    }
}

// ── Y-axis scaling ────────────────────────────────────────────────────────────

/**
 * Compute a human-readable axis scale from raw data extremes.
 *
 * Snaps min/max to a rounded step size chosen from the sequence
 * 1, 2, 5, 10 × 10^n so that tick labels are always tidy integers or
 * round decimals.
 *
 * @param {number} rawMin       - Minimum data value observed.
 * @param {number} rawMax       - Maximum data value observed.
 * @param {number} [maxIntervals=5] - Target number of tick intervals.
 * @returns {{ min: number, max: number, step: number }}
 */
function niceScale(rawMin, rawMax, maxIntervals = 5) {
    if (!Number.isFinite(rawMin) || !Number.isFinite(rawMax) || rawMin === rawMax) {
        return { min: Math.floor(rawMin) - 1, max: Math.ceil(rawMax) + 1, step: 1 };
    }
    const range     = rawMax - rawMin;
    const roughStep = range / maxIntervals;
    const magnitude = Math.pow(10, Math.floor(Math.log10(roughStep)));
    const norm      = roughStep / magnitude;
    let step;
    if      (norm <= 1) step = magnitude;
    else if (norm <= 2) step = 2 * magnitude;
    else if (norm <= 5) step = 5 * magnitude;
    else                step = 10 * magnitude;
    return { min: Math.floor(rawMin / step) * step, max: Math.ceil(rawMax / step) * step, step };
}

/**
 * Apply a shared Y-axis range (derived from a group's combined extremes) to
 * every chart in the group.  Optionally clamps the minimum to a floor value.
 *
 * @param {Chart[]} chartArray    - Chart.js instances to update.
 * @param {{ min: number, max: number }[]} extremesArray - Per-series extremes.
 * @param {number} [minFloor=-Infinity] - Hard lower bound for the axis min.
 */
function syncChartScales(chartArray, extremesArray, minFloor = -Infinity) {
    let globalMin = Infinity, globalMax = -Infinity;
    extremesArray.forEach(e => {
        if (e.min < globalMin) globalMin = e.min;
        if (e.max > globalMax) globalMax = e.max;
    });
    if (!Number.isFinite(globalMin) || !Number.isFinite(globalMax)) return;
    const clampedMin = Math.max(minFloor, globalMin);
    const { min, max, step } = niceScale(clampedMin, globalMax);
    const niceMin = Math.max(minFloor, min);
    chartArray.forEach(c => {
        if (!c) return;
        c.options.scales.y.min = niceMin;
        c.options.scales.y.max = max;
        if (!c.options.scales.y.ticks) c.options.scales.y.ticks = {};
        c.options.scales.y.ticks.stepSize = step;
    });
}

// ── Annotations ───────────────────────────────────────────────────────────────

/**
 * Return a hex colour for a status annotation line/badge.
 *
 * Reads CSS accent variables so it adapts to the active theme.
 *
 * @param {string} statusStr - Status label such as 'NORMAL', 'FAULT', 'BYPASS'.
 * @returns {string} Hex colour string.
 */
function statusAnnotationColor(statusStr) {
    const v = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
    if (statusStr === "NORMAL") return v("--accent-green") || "#22c55e";
    if (statusStr === "BYPASS") return "#166534";
    if (statusStr === "FAULT")  return v("--accent-red")   || "#ef4444";
    return v("--accent-amber") || "#f59e0b";
}

/**
 * Build a vertical-line Chart.js annotation for a status-change event.
 *
 * @param {number} tsMs      - Timestamp in milliseconds (x-axis value).
 * @param {string} statusStr - Human-readable status label.
 * @returns {object} Chart.js annotation descriptor.
 */
function buildStatusAnnotation(tsMs, statusStr) {
    const hex = statusAnnotationColor(statusStr);
    return {
        type: "line", scaleID: "x", value: tsMs,
        borderColor: hex + "80", borderWidth: 1, borderDash: [4, 4],
        label: {
            display: true, content: statusStr, position: "start",
            backgroundColor: hex + "cc", color: "#fff",
            font: { size: 9, weight: "600" }, padding: { x: 4, y: 2 },
            borderRadius: 4, rotation: -90
        }
    };
}

/**
 * Draw min/max horizontal band annotations on a sparkline chart.
 *
 * Labels are centred on the line; colour is derived from the series colour.
 *
 * @param {Chart}  chart - Chart.js instance.
 * @param {number} min   - Minimum value to annotate.
 * @param {number} max   - Maximum value to annotate.
 * @param {string} color - Base hex colour for the annotation lines.
 */
function updateSparklineAnnotations(chart, min, max, color) {
    if (!chart) return;
    const cStr = typeof color === "string" && color.startsWith("#") ? color + "80" : color;
    const bg   = typeof color === "string" && color.startsWith("#") ? color + "d0" : "rgba(100,100,100,0.8)";
    if (!chart.options.plugins.annotation) chart.options.plugins.annotation = { annotations: {} };
    const anns = chart.options.plugins.annotation.annotations;
    anns.minLine = {
        type: "line", yMin: min, yMax: min, borderColor: cStr, borderWidth: 1, borderDash: [2, 2],
        label: { display: true, content: min.toFixed(1), position: "center", backgroundColor: bg,
                 color: "#fff", font: { size: 9, weight: "600" }, padding: { x: 4, y: 2 }, borderRadius: 4 }
    };
    anns.maxLine = {
        type: "line", yMin: max, yMax: max, borderColor: cStr, borderWidth: 1, borderDash: [2, 2],
        label: { display: true, content: max.toFixed(1), position: "center", backgroundColor: bg,
                 color: "#fff", font: { size: 9, weight: "600" }, padding: { x: 4, y: 2 }, borderRadius: 4 }
    };
}

// ── Chart factory ─────────────────────────────────────────────────────────────

/**
 * Read colour tokens from computed CSS custom properties.
 *
 * Returns a palette object keyed by semantic name.  The fallback values are
 * chosen to be visible on both light and dark backgrounds.  Wye L-L keys
 * (ll12, ll13, ll23) are included; projects that do not measure L-L voltages
 * directly use the lineVoltage() fallback in updateWyeDiagram().
 *
 * @returns {object} Colour palette.
 */
function chartPalette() {
    const s = getComputedStyle(document.documentElement);
    const v = name => s.getPropertyValue(name).trim();
    return {
        delivered: v("--delivered-color") || "#22c55e",
        returned:  v("--returned-color")  || "#f59e0b",
        net:       v("--net-color")       || "#3b82f6",
        l1:        v("--phase-l1")        || "#ef4444",
        l2:        v("--phase-l2")        || "#eab308",
        l3:        v("--phase-l3")        || "#3b82f6",
        pv1: "#3b82f6", pv2: "#8b5cf6", pv3: "#ec4899", load: "#a855f7",
        ll12: v("--wye-l12") || "#a78bfa",
        ll13: v("--wye-l13") || "#34d399",
        ll23: v("--wye-l23") || "#fbbf24",
    };
}

/**
 * Build the shared Chart.js base options object.
 *
 * Returns a fresh object each call so callers can safely mutate their copy
 * without affecting other charts.
 *
 * @returns {object} Chart.js options object.
 */
function getBaseOpts() {
    return {
        responsive: true, maintainAspectRatio: false, animation: false,
        transitions: { active: { animation: { duration: 0 } } },
        interaction: { mode: "index", intersect: false },
        elements: { point: { radius: 0, hitRadius: 6 }, line: { tension: 0.3, borderWidth: 1.5 } },
        scales: {
            x: { type: "time", time: { tooltipFormat: "HH:mm:ss" }, ticks: { maxTicksLimit: 8 } },
            y: {}
        },
        plugins: {
            annotation: { annotations: {} },
            legend: { display: true },
            tooltip: { padding: 10 }
        }
    };
}

/**
 * Create a Chart.js line chart on the canvas with the given id.
 *
 * Each entry in series defines one dataset: { label, color, borderWidth? }.
 * The resulting chart is suitable for both overview panels (showLegend=true)
 * and inline sparklines (showLegend=false, x-axis hidden).
 *
 * @param {string}   id          - Canvas element id.
 * @param {{ label: string, color: string, borderWidth?: number }[]} series
 * @param {boolean}  [showLegend=true]
 * @returns {Chart|null} Chart instance, or null if the element is not found.
 */
function createChart(id, series, showLegend = true) {
    const el = document.getElementById(id);
    if (!el) return null;
    const ctx = el.getContext("2d");

    const datasets = series.map(s => ({
        label: s.label,
        borderColor:     s.color,
        backgroundColor: s.color,
        data:            [],
        fill:            false,
        tension:         0.1,
        pointRadius:     0,
        borderWidth:     s.borderWidth ?? 1.5,
        borderCapStyle:  "round"
    }));

    const opts = {
        responsive: true, maintainAspectRatio: false, animation: false,
        interaction: { mode: "index", intersect: false },
        plugins: {
            annotation: { annotations: {} },
            legend: {
                display:  showLegend,
                position: "bottom",
                labels:   { usePointStyle: true, boxWidth: 8, padding: 20 }
            },
            tooltip: {
                backgroundColor: "rgba(15, 23, 42, 0.9)",
                titleFont: { size: 13, family: "JetBrains Mono" },
                bodyFont:  { size: 13, family: "JetBrains Mono" },
                padding: 12, cornerRadius: 8, displayColors: true
            }
        },
        scales: {
            x: {
                type: "time",
                time: { tooltipFormat: "HH:mm" },
                grid:   { display: true, color: "rgba(100, 100, 100, 0.1)" },
                ticks:  { maxTicksLimit: 6, display: showLegend },
                border: { display: showLegend }
            },
            y: { grid: { color: "rgba(100, 100, 100, 0.1)", borderDash: [5, 5] } }
        }
    };

    return new Chart(ctx, { type: "line", data: { labels: [], datasets }, options: opts });
}

// ── DOM helpers ───────────────────────────────────────────────────────────────

/**
 * Update a DOM element's innerText only when the value has changed.
 * No-ops silently if the element is not found.
 *
 * @param {string} id  - Element id.
 * @param {*}      val - New text value (coerced to string).
 */
function updateDOM(id, val) {
    const el = document.getElementById(id);
    if (el && el.innerText !== String(val)) el.innerText = val;
}

/**
 * Append a live data point to a Chart.js time-series chart.
 *
 * Pushes one label and one value per dataset.  Caller is responsible for
 * trimming stale points if a rolling window is needed.
 *
 * @param {Chart}    chart  - Chart.js instance.
 * @param {number}   ts     - Timestamp (ms) for the x-axis label.
 * @param {number[]} values - One value per dataset, in dataset order.
 */
function pushChart(chart, ts, values) {
    if (!chart) return;
    chart.data.labels.push(ts);
    for (let i = 0; i < values.length; i++) chart.data.datasets[i].data.push(values[i]);
    chart.update("none");
}

// ── Flow diagram ──────────────────────────────────────────────────────────────

/**
 * Scale the live energy flow diagram to fit its container.
 *
 * The SVG paths and node positions use a fixed 800×300 px coordinate space.
 * A ResizeObserver watches .flow-scale-wrap and applies a CSS transform:scale()
 * to .flow-container whenever the available width is smaller than 800 px.
 * The --flow-scale custom property is also set on the wrapper so that the CSS
 * calc() height tracks the scaled diagram correctly.
 */
function initFlowScale() {
    const wrap      = document.querySelector(".flow-scale-wrap");
    const container = document.querySelector(".flow-container");
    if (!wrap || !container) return;

    const DESIGN_W = 800;

    function applyScale() {
        const available = wrap.getBoundingClientRect().width || wrap.offsetWidth;
        const scale     = Math.min(1, available / DESIGN_W);
        container.style.transform = scale < 1 ? `scale(${scale})` : "";
        wrap.style.setProperty("--flow-scale", scale);
    }

    const ro = new ResizeObserver(applyScale);
    ro.observe(wrap);
    applyScale();
}

// ── Tab switching ─────────────────────────────────────────────────────────────

/**
 * Switch the active dashboard tab panel.
 *
 * Toggles .tab-btn--active on the button matching tab-btn-{id} and hides all
 * .tab-content panels except tab-{id}.
 *
 * Fires a 'dashboard:tabswitch' CustomEvent on document so that app-specific
 * code (e.g. canvas resize, lazy chart init) can react without this function
 * needing to know about them:
 *
 *   document.addEventListener('dashboard:tabswitch', ({ detail }) => {
 *       if (detail.id === 'grid') resizeWyeCanvas();
 *   });
 *
 * localStorage persistence is intentionally delegated to the app layer via
 * the same event, keeping the key name app-specific.
 *
 * @param {string} id - Tab identifier matching the tab-btn-{id}/tab-{id} convention.
 */
function switchTab(id) {
    document.querySelectorAll(".tab-btn").forEach(b => {
        b.classList.remove("tab-btn--active");
        b.setAttribute("aria-selected", "false");
    });
    document.querySelectorAll("[role='tabpanel']").forEach(c => { c.hidden = true; });
    const btn   = document.getElementById(`tab-btn-${id}`);
    const panel = document.getElementById(`tab-${id}`);
    if (btn)   { btn.classList.add("tab-btn--active"); btn.setAttribute("aria-selected", "true"); }
    if (panel) panel.hidden = false;
    document.dispatchEvent(new CustomEvent("dashboard:tabswitch", { detail: { id } }));
}

// ── Sparkline modal ───────────────────────────────────────────────────────────

/**
 * Initialise click-to-expand behaviour for inline sparkline charts.
 *
 * Clicking any canvas inside a .chart-wrapper--inline container opens a
 * full-viewport modal that renders the same data at a larger size with
 * legend and X-axis labels visible.
 *
 * The modal overlay, canvas, and close button are created once on first
 * invocation (lazy singleton) and reused across subsequent clicks.
 * The expanded Chart.js instance is destroyed and recreated each time
 * so it always reflects the source chart's current state.
 *
 * Close triggers: overlay click, ✕ button, Escape key.
 *
 * Call this once after DOMContentLoaded — it uses event delegation on
 * document.body so dynamically-added sparklines are covered automatically.
 */
function initSparklineModal() {
    let overlay    = null;
    let modalChart = null;

    /** Build the modal DOM on first use and return the overlay element. */
    function ensureDOM() {
        if (overlay) return overlay;

        overlay = document.createElement("div");
        overlay.className = "spark-modal-overlay";
        overlay.setAttribute("role", "dialog");
        overlay.setAttribute("aria-modal", "true");
        overlay.setAttribute("aria-label", "Expanded chart");
        // Starts closed; .open class controls visibility (avoids browser
        // [hidden]{display:none} specificity issues).

        const card = document.createElement("div");
        card.className = "spark-modal-card";

        const header = document.createElement("div");
        header.className = "spark-modal-header";

        const title = document.createElement("span");
        title.className = "spark-modal-title";
        title.id = "spark-modal-title";

        const closeBtn = document.createElement("button");
        closeBtn.className = "spark-modal-close";
        closeBtn.setAttribute("aria-label", "Close");
        closeBtn.textContent = "\u2715";
        closeBtn.addEventListener("click", close);

        header.appendChild(title);
        header.appendChild(closeBtn);

        const wrap = document.createElement("div");
        wrap.className = "spark-modal-chart-wrap";

        const canvas = document.createElement("canvas");
        canvas.id = "spark-modal-canvas";
        wrap.appendChild(canvas);

        card.appendChild(header);
        card.appendChild(wrap);
        overlay.appendChild(card);
        document.body.appendChild(overlay);

        overlay.addEventListener("click", (e) => {
            if (e.target === overlay) close();
        });

        document.addEventListener("keydown", (e) => {
            if (e.key === "Escape" && overlay.classList.contains("open")) close();
        });

        return overlay;
    }

    /** Close the modal and destroy the temporary chart instance. */
    function close() {
        if (!overlay) return;
        overlay.classList.remove("open");
        if (modalChart) { modalChart.destroy(); modalChart = null; }
    }

    /**
     * Open the modal with a full-size clone of the given Chart.js instance.
     *
     * Copies datasets (data + visual config) and scale/annotation settings
     * from the source chart.  Enables legend and X-axis labels so the
     * expanded view is more informative than the inline sparkline.
     *
     * @param {Chart} srcChart - The source Chart.js instance to expand.
     */
    function open(srcChart) {
        ensureDOM();
        if (modalChart) { modalChart.destroy(); modalChart = null; }

        // Derive a human-readable title from the canvas aria-label or
        // the first dataset label, falling back to "Chart".
        const ariaLabel = srcChart.canvas.getAttribute("aria-label");
        const dsLabel   = srcChart.data.datasets[0]?.label;
        const titleEl   = document.getElementById("spark-modal-title");
        if (titleEl) titleEl.textContent = ariaLabel || dsLabel || "Chart";

        // Show the overlay BEFORE creating the chart so the canvas
        // has non-zero dimensions for Chart.js to measure.
        overlay.classList.add("open");

        try {
            // Deep-clone datasets: copy data arrays and visual properties.
            const datasets = srcChart.data.datasets.map(ds => ({
                label:           ds.label,
                data:            [...ds.data],
                borderColor:     ds.borderColor,
                backgroundColor: ds.backgroundColor,
                fill:            ds.fill ?? false,
                tension:         ds.tension ?? 0.3,
                pointRadius:     0,
                pointHitRadius:  6,
                borderWidth:     ds.borderWidth ?? 1.5,
                borderCapStyle:  ds.borderCapStyle || "round",
                parsing:         ds.parsing ?? undefined,
            }));

            // Clone labels array (used by createChart-style charts).
            const labels = srcChart.data.labels ? [...srcChart.data.labels] : [];

            // Build modal chart options: responsive, visible X ticks, no legend
            // (single-dataset sparklines; the modal title identifies the metric).
            const srcScales = srcChart.options.scales || {};
            const srcY      = srcScales.y || {};

            const opts = getBaseOpts();
            opts.plugins.legend = { display: false };
            opts.scales.x.ticks = { maxTicksLimit: 12 };
            opts.scales.x.border = { display: true };

            // Carry over Y-axis range if the source has explicit min/max.
            if (srcY.min !== undefined) opts.scales.y.min = srcY.min;
            if (srcY.max !== undefined) opts.scales.y.max = srcY.max;
            if (srcY.ticks) {
                opts.scales.y.ticks = { ...srcY.ticks };
            }

            // Copy annotation overlays (min/max bands, status markers).
            // JSON round-trip drops any function-valued keys that
            // structuredClone would choke on.
            const srcAnns = srcChart.options.plugins?.annotation?.annotations;
            if (srcAnns) {
                try { opts.plugins.annotation = { annotations: JSON.parse(JSON.stringify(srcAnns)) }; }
                catch { /* skip annotations if they contain non-serialisable values */ }
            }

            const canvas = document.getElementById("spark-modal-canvas");
            modalChart = new Chart(canvas.getContext("2d"), {
                type: "line",
                data: { labels, datasets },
                options: opts,
            });
        } catch (err) {
            console.error("Sparkline modal chart error:", err);
        }
    }

    // Event delegation: clicking anywhere on a card that contains an inline
    // sparkline opens the modal.  Targets both card types:
    //   .card--with-chart  — phase voltage/current cards (both repos)
    //   .mini-chart        — freq/temp cards (Growatt)
    const CARD_SELECTOR = ".card--with-chart, .mini-chart";

    document.addEventListener("click", (e) => {
        const card = e.target.closest(CARD_SELECTOR);
        if (!card) return;

        const canvas = card.querySelector("canvas");
        if (!canvas) return;

        const chartInstance = Chart.getChart(canvas);
        if (!chartInstance) return;

        open(chartInstance);
    });
}

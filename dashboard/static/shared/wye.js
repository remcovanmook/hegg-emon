/**
 * @file shared/wye.js
 * 3-phase wye phasor diagram — canvas drawing, DOM stats, and resize logic.
 *
 * Self-contained: no dependency on app-specific state.  Voltages are passed
 * as arguments to updateWyeDiagram(); L-L values fall back to lineVoltage()
 * if the caller passes 0 (e.g. hegg-emon where V_LL is not directly measured).
 *
 * Exposes (used by app JS):
 *   initWyeDiagram()                    – canvas init + resize listeners
 *   resizeWyeCanvas()                   – recompute asymmetric canvas height
 *   resizeNeutralCanvas()               – resize mini neutral canvas
 *   refreshWyeCSS()                     – reload CSS colour tokens (call from recolorCharts)
 *   updateWyeDiagram(v1,v2,v3,rs,st,tr) – update stats DOM + redraw canvases
 *
 * Internal (not exported by name but available in module scope):
 *   lineVoltage, neutralShift, voltageImbalance
 *   drawWyeDiagram, drawNeutralMini
 *   wyeScaleForWidth
 *   WYE_CEIL, WYE_IEC_MAX, WYE_TOP_PAD, WYE_BOT_PAD
 *   WYE_CSS (window-global colour token cache; populated by refreshWyeCSS)
 *
 * Load order: after theme.js and chart-utils.js, before app JS.
 */

"use strict";

// ── Layout constants ──────────────────────────────────────────────────────────

/** Scale domain ceiling in volts above the 200 V display base. */
const WYE_CEIL    = 65;

/** 253 V IEC ring radius above base (200 + 53 = 253 V). */
const WYE_IEC_MAX = 53;

/** Pixels above the full CEIL vector tip — room for the L1 label. */
const WYE_TOP_PAD = 26;

/** Pixels below the 253 V ring bottom — minimal clearance. */
const WYE_BOT_PAD = 14;

// ── Module-private colour token cache ────────────────────────────────────────

/**
 * CSS colour token cache populated by refreshWyeCSS().
 * All draw functions read from this object so they pick up theme changes.
 * Declared as var (not let/const) so it is accessible from other scripts
 * loaded on the same page that reference WYE_CSS for lazy chart callbacks.
 * @type {object}
 */
var WYE_CSS = {};

/**
 * Re-read CSS custom properties into WYE_CSS.
 *
 * Call this from the application's recolorCharts() after a theme change so
 * that subsequent canvas draws use the updated palette.
 */
function refreshWyeCSS() {
    const s = getComputedStyle(document.documentElement);
    WYE_CSS = {
        cl1:     s.getPropertyValue("--phase-l1").trim(),
        cl2:     s.getPropertyValue("--phase-l2").trim(),
        cl3:     s.getPropertyValue("--phase-l3").trim(),
        cl12:    s.getPropertyValue("--wye-l12").trim(),
        cl13:    s.getPropertyValue("--wye-l13").trim(),
        cl23:    s.getPropertyValue("--wye-l23").trim(),
        neutral: s.getPropertyValue("--wye-neutral").trim(),
        grid:    s.getPropertyValue("--chart-grid").trim() || "rgba(0,0,0,0.06)",
        text:    s.getPropertyValue("--text-muted").trim() || "#6b7490",
        dim:     s.getPropertyValue("--text-dim").trim(),
    };
}

// ── Canvas element references ─────────────────────────────────────────────────

/** @type {HTMLCanvasElement|null} */
let wyeCanvas = null;
/** @type {CanvasRenderingContext2D|null} */
let wyeCtx = null;
/** @type {HTMLCanvasElement|null} */
let neutralCanvas = null;
/** @type {CanvasRenderingContext2D|null} */
let neutralCtx = null;

// ── Pure maths ────────────────────────────────────────────────────────────────

/**
 * Compute the line-to-line voltage between two phases assuming 120° separation.
 *
 * Cosine rule: |Va − Vb|² = Va² + Vb² − 2·Va·Vb·cos(120°)
 *                         = Va² + Vb² + Va·Vb   (cos 120° = −0.5)
 *
 * Used as a fallback when a measured V_LL is not available (value passed as 0).
 *
 * @param {number} va - Phase-to-neutral RMS of the first phase (V).
 * @param {number} vb - Phase-to-neutral RMS of the second phase (V).
 * @returns {number} Line voltage magnitude in volts.
 */
function lineVoltage(va, vb) {
    return Math.sqrt(va * va + vb * vb + va * vb);
}

/**
 * Compute the neutral-point shift vector for an unbalanced 3-phase system.
 *
 * Returns the complex displacement of the neutral from the balanced origin,
 * expressed as { re, im } in the same voltage unit as the inputs.
 *
 * @param {number} v1 - L1 phase-to-neutral RMS (V).
 * @param {number} v2 - L2 phase-to-neutral RMS (V).
 * @param {number} v3 - L3 phase-to-neutral RMS (V).
 * @returns {{ re: number, im: number }}
 */
function neutralShift(v1, v2, v3) {
    const d120 = (2 * Math.PI) / 3;
    return {
        re: (v1 + v2 * Math.cos(-d120) + v3 * Math.cos(d120)) / 3,
        im: (v2 * Math.sin(-d120) + v3 * Math.sin(d120)) / 3,
    };
}

/**
 * Compute per-phase voltage imbalance using the NEMA definition.
 *
 * Returns 100 × maxDeviation / mean.
 *
 * @param {number} v1
 * @param {number} v2
 * @param {number} v3
 * @returns {number} Imbalance factor (%).
 */
function voltageImbalance(v1, v2, v3) {
    const mean = (v1 + v2 + v3) / 3;
    if (mean === 0) return 0;
    return (Math.max(Math.abs(v1 - mean), Math.abs(v2 - mean), Math.abs(v3 - mean)) / mean) * 100;
}

// ── Scale helper ──────────────────────────────────────────────────────────────

/**
 * Return the draw scale factor for a given canvas CSS width.
 *
 * Scale is derived from width alone (not height) because the canvas height
 * is computed asymmetrically by resizeWyeCanvas().
 *
 * @param {number} W - Canvas CSS width in pixels.
 * @returns {number} Pixels per volt above the display base.
 */
function wyeScaleForWidth(W) {
    return (W * 0.43) / WYE_CEIL;
}

// ── Canvas init and resize ────────────────────────────────────────────────────

/**
 * Initialise the wye canvas elements and attach resize listeners.
 *
 * Must be called once from DOMContentLoaded after refreshWyeCSS() has
 * populated WYE_CSS.
 */
function initWyeDiagram() {
    wyeCanvas = document.getElementById("wye-canvas");
    if (!wyeCanvas) return;
    wyeCtx = wyeCanvas.getContext("2d");
    resizeWyeCanvas();
    window.addEventListener("resize", resizeWyeCanvas);

    neutralCanvas = document.getElementById("wye-neutral-canvas");
    if (neutralCanvas) {
        neutralCtx = neutralCanvas.getContext("2d");
        resizeNeutralCanvas();
        window.addEventListener("resize", resizeNeutralCanvas);
    }
}

/**
 * Resize the main wye canvas pixel buffer.
 *
 * Canvas height is computed asymmetrically so that:
 *   - WYE_TOP_PAD pixels sit above the full CEIL vector tip (L1 label room).
 *   - The bottom clips just below the 253 V IEC ring + WYE_BOT_PAD.
 *
 * The .wye-diagram-wrap height is driven via inline style so the surrounding
 * card layout adjusts without a fixed CSS height.
 *
 * Guards against hidden-tab zero-width rectangles (returns early if width < 10).
 */
function resizeWyeCanvas() {
    if (!wyeCanvas) return;
    const dpr  = window.devicePixelRatio || 1;
    const rect = wyeCanvas.getBoundingClientRect();
    if (rect.width < 10) return;
    const W     = rect.width;
    const scale = wyeScaleForWidth(W);
    const cy    = WYE_TOP_PAD + WYE_CEIL * scale;
    const H     = Math.ceil(cy + WYE_IEC_MAX * scale + WYE_BOT_PAD);
    wyeCanvas.width  = Math.round(W * dpr);
    wyeCanvas.height = Math.round(H * dpr);
    wyeCtx.scale(dpr, dpr);
    const wrap = wyeCanvas.closest(".wye-diagram-wrap");
    if (wrap) wrap.style.height = H + "px";
}

/**
 * Resize the mini neutral-offset canvas pixel buffer to match its CSS layout.
 */
function resizeNeutralCanvas() {
    if (!neutralCanvas) return;
    const dpr  = window.devicePixelRatio || 1;
    const rect = neutralCanvas.getBoundingClientRect();
    neutralCanvas.width  = rect.width  * dpr;
    neutralCanvas.height = rect.height * dpr;
    neutralCtx.scale(dpr, dpr);
}

// ── Canvas draw functions ─────────────────────────────────────────────────────

/**
 * Draw the complete 3-phase wye phasor diagram.
 *
 * A 200 V display base is subtracted from each vector magnitude so inter-phase
 * deviations are visible at normal EU voltages (~230 V). IEC EN 50160
 * tolerance bands are drawn at 207 / 230 / 253 V relative to the same base.
 *
 * Chord labels use the directly measured line-to-line voltages (ll12, ll13,
 * ll23) rather than values computed from V_LN so they match the L-L cards.
 *
 * @param {number} v1   - L1 phase-to-neutral RMS voltage (V).
 * @param {number} v2   - L2 phase-to-neutral RMS voltage (V).
 * @param {number} v3   - L3 phase-to-neutral RMS voltage (V).
 * @param {number} ll12 - Measured V_RS (L1–L2) line voltage (V).
 * @param {number} ll13 - Measured V_TR (L1–L3) line voltage (V).
 * @param {number} ll23 - Measured V_ST (L2–L3) line voltage (V).
 */
function drawWyeDiagram(v1, v2, v3, ll12, ll13, ll23) {
    if (!wyeCtx || !wyeCanvas) return;
    const dpr  = window.devicePixelRatio || 1;
    const W    = wyeCanvas.width / dpr;
    const BASE = 200, CEIL = WYE_CEIL;
    const scale = wyeScaleForWidth(W);
    const cx    = W / 2;
    // Asymmetric cy: enough space at top for L1 label; canvas clips below 253 V ring.
    const cy    = WYE_TOP_PAD + CEIL * scale;
    const H     = wyeCanvas.height / dpr;
    const dv1 = Math.max(v1 - BASE, 1), dv2 = Math.max(v2 - BASE, 1), dv3 = Math.max(v3 - BASE, 1);
    const cl1  = WYE_CSS.cl1  || "#60a5fa", cl2  = WYE_CSS.cl2  || "#34d399", cl3  = WYE_CSS.cl3  || "#f59e0b";
    const cl12 = WYE_CSS.cl12 || "#818cf8", cl13 = WYE_CSS.cl13 || "#fb7185", cl23 = WYE_CSS.cl23 || "#a78bfa";
    const cN   = WYE_CSS.neutral || "#f472b6", cG = WYE_CSS.grid || "rgba(255,255,255,0.06)";
    const cT   = WYE_CSS.text || "#9ca3af",    cD = WYE_CSS.dim  || "#4b5563";
    const ctx  = wyeCtx;
    ctx.clearRect(0, 0, W, H);
    const toXY = (m, deg) => { const r = deg * Math.PI / 180; return { x: cx + m * scale * Math.cos(r), y: cy - m * scale * Math.sin(r) }; };
    const p1 = toXY(dv1, 90), p2 = toXY(dv2, -30), p3 = toXY(dv3, 210);
    const meanR = (dv1 + dv2 + dv3) / 3 * scale;
    for (let f = 0.25; f <= 1.01; f += 0.25) { ctx.beginPath(); ctx.arc(cx, cy, meanR * f, 0, 2 * Math.PI); ctx.strokeStyle = cG; ctx.lineWidth = 1; ctx.setLineDash([]); ctx.stroke(); }
    for (let a = 0; a < 360; a += 60) { const sp = toXY(CEIL, a); ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(sp.x, sp.y); ctx.strokeStyle = cG; ctx.lineWidth = 0.5; ctx.stroke(); }
    const iecRing = (dV, col, dash, lbl, ang) => { const r = dV * scale; ctx.beginPath(); ctx.arc(cx, cy, r, 0, 2 * Math.PI); ctx.strokeStyle = col; ctx.lineWidth = 1; ctx.setLineDash(dash); ctx.stroke(); ctx.setLineDash([]); ctx.font = "9px 'JetBrains Mono', monospace"; ctx.fillStyle = col; ctx.textAlign = "center"; ctx.fillText(lbl, cx + (r + 5) * Math.cos(ang), cy - (r + 5) * Math.sin(ang)); };
    iecRing(7,  "rgba(251,146,60,0.55)",  [3, 3], "207 V", Math.PI * 0.25);
    iecRing(53, "rgba(251,146,60,0.55)",  [3, 3], "253 V", Math.PI * 0.25);
    iecRing(30, "rgba(255,255,255,0.30)", [5, 3], "230 V", Math.PI * 0.2);
    ctx.beginPath(); ctx.arc(cx, cy, meanR, 0, 2 * Math.PI); ctx.strokeStyle = cD; ctx.lineWidth = 1; ctx.setLineDash([4, 4]); ctx.stroke(); ctx.setLineDash([]);
    const chord = (pa, pb, col, lbl, ox, oy) => { ctx.beginPath(); ctx.moveTo(pa.x, pa.y); ctx.lineTo(pb.x, pb.y); ctx.strokeStyle = col; ctx.lineWidth = 1.5; ctx.setLineDash([6, 3]); ctx.stroke(); ctx.setLineDash([]); ctx.font = "bold 9px 'JetBrains Mono', monospace"; ctx.fillStyle = col; ctx.textAlign = "center"; ctx.fillText(lbl, (pa.x + pb.x) / 2 + ox, (pa.y + pb.y) / 2 + oy); };
    // Chord labels use measured V_LL values; geometric position is from V_LN phasor tips.
    chord(p1, p2, cl12, "L1\u2013L2 " + (ll12 || lineVoltage(v1, v2)).toFixed(1) + " V",  14, -6);
    chord(p1, p3, cl13, "L1\u2013L3 " + (ll13 || lineVoltage(v1, v3)).toFixed(1) + " V", -14, -6);
    chord(p2, p3, cl23, "L2\u2013L3 " + (ll23 || lineVoltage(v2, v3)).toFixed(1) + " V",   0, 14);
    const vec = (p, col, lbl, mag) => { ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(p.x, p.y); ctx.strokeStyle = col; ctx.lineWidth = 2.5; ctx.stroke(); const a = Math.atan2(cy - p.y, p.x - cx), hs = 8; ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(p.x - hs * Math.cos(a - 0.35), p.y + hs * Math.sin(a - 0.35)); ctx.lineTo(p.x - hs * Math.cos(a + 0.35), p.y + hs * Math.sin(a + 0.35)); ctx.closePath(); ctx.fillStyle = col; ctx.fill(); ctx.beginPath(); ctx.arc(p.x, p.y, 4, 0, 2 * Math.PI); ctx.fillStyle = col; ctx.fill(); ctx.font = "bold 11px 'Inter', sans-serif"; ctx.fillStyle = col; ctx.textAlign = "center"; ctx.fillText(lbl + " " + mag.toFixed(1) + " V", p.x + (p.x - cx) * 0.18, p.y + (p.y - cy) * 0.18); };
    vec(p1, cl1, "L1", v1); vec(p2, cl2, "L2", v2); vec(p3, cl3, "L3", v3);
    const ns = neutralShift(v1, v2, v3), npx = cx + ns.re * scale, npy = cy - ns.im * scale;
    if (Math.hypot(npx - cx, npy - cy) > 0.5) { ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(npx, npy); ctx.strokeStyle = cN; ctx.lineWidth = 2; ctx.setLineDash([3, 2]); ctx.stroke(); ctx.setLineDash([]); ctx.beginPath(); ctx.arc(npx, npy, 5, 0, 2 * Math.PI); ctx.fillStyle = cN; ctx.fill(); }
    ctx.beginPath(); ctx.arc(cx, cy, 5, 0, 2 * Math.PI); ctx.fillStyle = cT; ctx.fill();
    ctx.font = "10px 'JetBrains Mono', monospace"; ctx.fillStyle = cT; ctx.textAlign = "center";
    ctx.fillText("mean " + ((v1 + v2 + v3) / 3).toFixed(1) + " V", cx, cy - 10);
    // −200 V display base label is rendered in the section heading (HTML), not on the canvas.
}

// ── DOM stats update ──────────────────────────────────────────────────────────

/**
 * Update all wye DOM stat elements and redraw both canvases.
 *
 * L-L voltages fall back to lineVoltage() when the measured value is 0,
 * making this function suitable for both growatt (measured V_LL) and
 * hegg-emon (calculated V_LL from V_LN).
 *
 * @param {number} v1   - L1 phase-to-neutral RMS (V).
 * @param {number} v2   - L2 phase-to-neutral RMS (V).
 * @param {number} v3   - L3 phase-to-neutral RMS (V).
 * @param {number} llRS - Measured V_RS = L1–L2 line voltage (V), or 0.
 * @param {number} llST - Measured V_ST = L2–L3 line voltage (V), or 0.
 * @param {number} llTR - Measured V_TR = L1–L3 line voltage (V), or 0.
 */
function updateWyeDiagram(v1, v2, v3, llRS, llST, llTR) {
    if (!v1 || !v2 || !v3) return;
    const IEC_NOM = 230, IEC_LL = 400;
    const set = (id, val) => { const e = document.getElementById(id); if (e) e.textContent = val; };
    set("wye-v-l1", v1.toFixed(1)); set("wye-v-l2", v2.toFixed(1)); set("wye-v-l3", v3.toFixed(1));
    const setIdeal = (id, v, nom) => {
        const e = document.getElementById(id); if (!e) return;
        const d = v - nom, p = (d / nom) * 100;
        e.textContent = (d >= 0 ? "+" : "") + d.toFixed(1) + " V vs IEC (" + (p >= 0 ? "+" : "") + p.toFixed(1) + "%)";
        e.className = "wt-ideal " + (d >= 0 ? "wt-ideal--pos" : "wt-ideal--neg");
    };
    setIdeal("wye-ideal-l1", v1, IEC_NOM); setIdeal("wye-ideal-l2", v2, IEC_NOM); setIdeal("wye-ideal-l3", v3, IEC_NOM);
    // Use measured V_LL when available; fall back to cosine-rule approximation.
    const ll12 = llRS || lineVoltage(v1, v2);
    const ll23 = llST || lineVoltage(v2, v3);
    const ll13 = llTR || lineVoltage(v1, v3);
    set("wye-diff-l12", ll12.toFixed(1)); set("wye-diff-l13", ll13.toFixed(1)); set("wye-diff-l23", ll23.toFixed(1));
    setIdeal("wye-ideal-l12", ll12, IEC_LL); setIdeal("wye-ideal-l13", ll13, IEC_LL); setIdeal("wye-ideal-l23", ll23, IEC_LL);
    const ns = neutralShift(v1, v2, v3), nMag = Math.hypot(ns.re, ns.im);
    set("wye-neutral-mag", nMag.toFixed(2));
    // Compass bearing: clockwise from north (top), always 0–360°.
    const mathDeg = Math.atan2(ns.im, ns.re) * 180 / Math.PI;
    const bearing  = ((90 - mathDeg) % 360 + 360) % 360;
    set("wye-neutral-ang", bearing.toFixed(1));
    set("wye-imbalance",   voltageImbalance(v1, v2, v3).toFixed(2));
    drawWyeDiagram(v1, v2, v3, ll12, ll13, ll23);
    drawNeutralMini(ns.re, ns.im, nMag);
}

/**
 * Draw the mini neutral-offset polar diagram.
 *
 * The outer ring auto-scales to the smallest 5 V multiple >= 2 × magnitude
 * (floor 5 V). Phase direction labels are placed just outside the ring.
 *
 * @param {number} re  - Real part of neutral shift (V).
 * @param {number} im  - Imaginary part of neutral shift (V).
 * @param {number} mag - Magnitude of neutral shift (V).
 */
function drawNeutralMini(re, im, mag) {
    if (!neutralCtx || !neutralCanvas) return;
    const dpr = window.devicePixelRatio || 1;
    const W = neutralCanvas.width / dpr, H = neutralCanvas.height / dpr;
    const cx = W / 2, cy = H / 2;
    const cN  = WYE_CSS.neutral || "#f472b6", cG = WYE_CSS.grid || "rgba(255,255,255,0.06)";
    const cT  = WYE_CSS.text    || "#9ca3af", cD = WYE_CSS.dim  || "#4b5563";
    const cl1 = WYE_CSS.cl1     || "#60a5fa", cl2 = WYE_CSS.cl2 || "#34d399", cl3 = WYE_CSS.cl3 || "#f59e0b";
    const ctx = neutralCtx;
    ctx.clearRect(0, 0, W, H);
    const maxRef = Math.max(5, Math.ceil(Math.max(mag * 2, 1) / 5) * 5);
    const R = Math.min(W, H) * 0.36, scale = R / maxRef;
    [0.25, 0.5, 0.75, 1].forEach(f => { ctx.beginPath(); ctx.arc(cx, cy, R * f, 0, 2 * Math.PI); ctx.strokeStyle = cG; ctx.lineWidth = f === 1 ? 1 : 0.75; ctx.setLineDash([]); ctx.stroke(); });
    for (let a = 0; a < 360; a += 30) { const r = a * Math.PI / 180; ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + R * Math.cos(r), cy - R * Math.sin(r)); ctx.strokeStyle = cG; ctx.lineWidth = 0.5; ctx.stroke(); }
    ctx.font = "8px 'JetBrains Mono', monospace"; ctx.fillStyle = cD; ctx.textAlign = "left"; ctx.textBaseline = "middle";
    ctx.fillText(maxRef + " V", cx + R * Math.cos(Math.PI / 4) + 3, cy - R * Math.sin(Math.PI / 4)); ctx.textBaseline = "alphabetic";
    [{ l: "L1", a: 90, c: cl1 }, { l: "L2", a: -30, c: cl2 }, { l: "L3", a: 210, c: cl3 }].forEach(({ l, a, c }) => {
        const r = a * Math.PI / 180; ctx.font = "bold 8px 'Inter', sans-serif"; ctx.fillStyle = c; ctx.textAlign = "center"; ctx.textBaseline = "middle";
        ctx.fillText(l, cx + (R + 11) * Math.cos(r), cy - (R + 11) * Math.sin(r));
    }); ctx.textBaseline = "alphabetic";
    ctx.beginPath(); ctx.arc(cx, cy, 3, 0, 2 * Math.PI); ctx.fillStyle = cT; ctx.fill();
    const vx = cx + re * scale, vy = cy - im * scale;
    if (Math.hypot(vx - cx, vy - cy) > 1.5) {
        ctx.beginPath(); ctx.moveTo(vx, vy); ctx.lineTo(cx, cy);
        ctx.strokeStyle = cN; ctx.lineWidth = 2; ctx.setLineDash([]); ctx.stroke();
        const a2 = Math.atan2(cy - vy, cx - vx), hs = 6;
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.lineTo(cx - hs * Math.cos(a2 - 0.4), cy - hs * Math.sin(a2 - 0.4));
        ctx.lineTo(cx - hs * Math.cos(a2 + 0.4), cy - hs * Math.sin(a2 + 0.4));
        ctx.closePath(); ctx.fillStyle = cN; ctx.fill();
        ctx.beginPath(); ctx.arc(vx, vy, 5, 0, 2 * Math.PI);
        ctx.fillStyle = "#ef4444"; ctx.fill();
        const lx = vx + (vx - cx) * 0.35, ly = vy + (vy - cy) * 0.35;
        ctx.font = "bold 9px 'JetBrains Mono', monospace"; ctx.fillStyle = cN;
        ctx.textAlign = "center"; ctx.textBaseline = "bottom";
        ctx.fillText(mag.toFixed(2) + " V", lx, ly - 4); ctx.textBaseline = "alphabetic";
    } else {
        ctx.font = "9px 'JetBrains Mono', monospace"; ctx.fillStyle = cT; ctx.textAlign = "center"; ctx.fillText("balanced", cx, cy + 18);
    }
}

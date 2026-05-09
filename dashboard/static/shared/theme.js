/**
 * @file shared/theme.js
 * Theme cycle and application helpers shared between dashboard projects.
 *
 * Exposes:
 *   THEME_CYCLE     – ordered list of available theme identifiers.
 *   THEME_LABELS    – display labels for the theme-toggle button.
 *   isDarkTheme()   – resolves the effective theme to a boolean.
 *   applyTheme(t)   – applies a theme, persists it, delegates recolouring.
 *   cycleTheme()    – advance to the next theme in the cycle.
 *
 * Load order: this file must be loaded before app-specific JS so that
 * applyTheme() can call recolorCharts() via a typeof guard without errors.
 */

"use strict";

/** Ordered theme identifiers. */
var THEME_CYCLE = ["light", "dark", "auto"];

/** Button label strings keyed by theme identifier. */
var THEME_LABELS = { light: "☀️ Light", dark: "🌙 Dark", auto: "◐ Auto" };

/**
 * Returns true when the effective resolved theme is dark.
 *
 * Checks the explicit data-theme attribute first; falls back to the OS
 * prefers-color-scheme media query when the value is 'auto'.
 *
 * @returns {boolean}
 */
function isDarkTheme() {
    const t = document.documentElement.dataset.theme;
    if (t === "dark")  return true;
    if (t === "light") return false;
    return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

/**
 * Apply a theme by setting data-theme on <html>, persisting it to
 * localStorage under the 'hegg-theme' key, updating the toggle button label,
 * and delegating chart recolouring to the application layer.
 *
 * The recolorCharts() call is guarded with typeof so that this file is safe
 * to load before app JS defines that function.
 *
 * @param {string} theme - One of the values in THEME_CYCLE.
 */
function applyTheme(theme) {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("hegg-theme", theme);
    const btn = document.getElementById("theme-toggle");
    if (btn) btn.textContent = THEME_LABELS[theme] ?? theme;
    if (typeof recolorCharts === "function") recolorCharts();
}

/**
 * Advance to the next theme in THEME_CYCLE (wrapping around) and apply it.
 */
function cycleTheme() {
    const current = document.documentElement.dataset.theme || "light";
    const next    = THEME_CYCLE[(THEME_CYCLE.indexOf(current) + 1) % THEME_CYCLE.length];
    applyTheme(next);
}

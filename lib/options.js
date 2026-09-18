/*
 * lib/options.js
 *
 * Pure options model for yt-snip. Resolution from raw (possibly partial /
 * invalid) stored storage values is isolated here so it can be unit-tested in
 * Node and shared by the options page and the content script.
 *
 * Output defaults (see PLAN.md):
 *   - fps: real-time frames per second in the saved clip (default 12)
 *   - maxDimension: the long edge of the output in px (default 512); the short
 *     edge scales with the crop aspect ratio so the Anki constraint holds
 *   - saveAs: prompt for a save location instead of auto-downloading
 *   - format: output container (M16): 'webm' (truecolor VP9 via WebCodecs —
 *     default) or 'gif' (universal fallback; browsers without WebCodecs
 *     automatically fall back to GIF at save time)
 *   - dither: Floyd–Steinberg error diffusion for GIF output (default true)
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else if (typeof define === 'function' && define.amd) {
    define([], factory);
  } else {
    root.ytSnipOptions = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var DEFAULTS = Object.freeze({
    fps: 12,
    maxDimension: 512,
    saveAs: false,
    loopOnPlay: true,
    clipPadStart: 3,
    clipPadEnd: 3,
    format: 'webm',
    dither: true,
  });

  var LIMITS = Object.freeze({
    fps: { min: 1, max: 60 },
    maxDimension: { min: 64, max: 8000 },
    clipPadStart: { min: 0, max: 600 },
    clipPadEnd: { min: 0, max: 600 },
  });

  function clampInt(value, min, max) {
    var n = Math.floor(Number(value));
    if (!Number.isFinite(n)) {
      return min;
    }
    return Math.min(max, Math.max(min, n));
  }

  function normalizeFormat(value) {
    return value === 'gif' || value === 'webm' ? value : DEFAULTS.format;
  }

  function truthy(value) {
    return value === true || value === 'true' || value === 1;
  }

  function falsy(value) {
    return value === false || value === 'false' || value === 0 || value === null;
  }

  /**
   * Resolve a full, validated options object from a raw stored value.
   * `raw` may be null/undefined (returns defaults) or a partial object.
   * Undefined fields fall back to the default before validation/clamping.
   */
  function resolve(raw) {
    raw = raw === null || raw === undefined ? {} : raw;
    var fpsValue = raw.fps === undefined ? DEFAULTS.fps : raw.fps;
    var dimValue = raw.maxDimension === undefined ? DEFAULTS.maxDimension : raw.maxDimension;
    var padStartValue = raw.clipPadStart === undefined ? DEFAULTS.clipPadStart : raw.clipPadStart;
    var padEndValue = raw.clipPadEnd === undefined ? DEFAULTS.clipPadEnd : raw.clipPadEnd;
    return {
      fps: clampInt(fpsValue, LIMITS.fps.min, LIMITS.fps.max),
      maxDimension: clampInt(dimValue, LIMITS.maxDimension.min, LIMITS.maxDimension.max),
      saveAs: truthy(raw.saveAs),
      // Default ON: only an explicit falsy value turns loop-on-play off.
      loopOnPlay: raw.loopOnPlay === undefined ? DEFAULTS.loopOnPlay : !falsy(raw.loopOnPlay),
      // Default-selection padding (seconds each side of the activation
      // timestamp). 0 is legitimate; both-zero falls back to the full range
      // via the content script's degenerate guard.
      clipPadStart: clampInt(padStartValue, LIMITS.clipPadStart.min, LIMITS.clipPadStart.max),
      clipPadEnd: clampInt(padEndValue, LIMITS.clipPadEnd.min, LIMITS.clipPadEnd.max),
      format: normalizeFormat(raw.format),
      // Dithering defaults ON; only an explicit falsy value turns it off
      // (mirrors the loopOnPlay encoding).
      dither: raw.dither === undefined ? DEFAULTS.dither : truthy(raw.dither),
    };
  }

  return {
    DEFAULTS: DEFAULTS,
    LIMITS: LIMITS,
    resolve: resolve,
  };
});
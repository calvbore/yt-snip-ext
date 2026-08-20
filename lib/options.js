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
 *   - format: output container (gif is the only supported v1 format)
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
    format: 'gif',
  });

  var LIMITS = Object.freeze({
    fps: { min: 1, max: 60 },
    maxDimension: { min: 64, max: 8000 },
  });

  function clampInt(value, min, max) {
    var n = Math.floor(Number(value));
    if (!Number.isFinite(n)) {
      return min;
    }
    return Math.min(max, Math.max(min, n));
  }

  function normalizeFormat(value) {
    return value === 'gif' ? 'gif' : DEFAULTS.format;
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
    return {
      fps: clampInt(fpsValue, LIMITS.fps.min, LIMITS.fps.max),
      maxDimension: clampInt(dimValue, LIMITS.maxDimension.min, LIMITS.maxDimension.max),
      saveAs: raw.saveAs === true || raw.saveAs === 'true' || raw.saveAs === 1,
      format: normalizeFormat(raw.format),
    };
  }

  return {
    DEFAULTS: DEFAULTS,
    LIMITS: LIMITS,
    resolve: resolve,
  };
});
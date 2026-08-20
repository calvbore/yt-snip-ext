/*
 * lib/timeline.js
 *
 * Pure timeline math for the three yt-snip handles (start / end / preview)
 * that overlay YouTube's `.ytp-progress-bar`. Maps between the bar's pixel
 * geometry, normalized fractions (0..1), and video time. No DOM here so it
 * unit-tests cleanly in Node.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else if (typeof define === 'function' && define.amd) {
    define([], factory);
  } else {
    root.ytSnipTimeline = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function clamp(v, min, max) {
    return Math.min(max, Math.max(min, v));
  }

  /** Time → fraction of the clip duration. */
  function timeToFraction(time, duration) {
    if (!duration || duration <= 0) return 0;
    return clamp(time / duration, 0, 1);
  }

  /** Fraction of the clip duration → time. */
  function fractionToTime(frac, duration) {
    if (!duration || duration <= 0) return 0;
    return clamp(frac, 0, 1) * duration;
  }

  /**
   * Time → pixel x within the bar rect. The result is clamped to the bar's
   * rendered span minus `handleSize/2` on each side so a handle centered on
   * the returned x always stays in view (at frac 0 and 1 the handle would
   * otherwise sit half off the bar edge).
   */
  function timeToX(time, duration, bar, handleSize) {
    var frac = timeToFraction(time, duration);
    var raw = bar.x + frac * bar.w;
    var hs = handleSize || 0;
    return clamp(raw, bar.x + hs / 2, bar.x + bar.w - hs / 2);
  }

  /** Client x → time, given the bar rect. */
  function xToTime(clientX, duration, bar) {
    var frac = (clientX - bar.x) / bar.w;
    return fractionToTime(frac, duration);
  }

  /** Sanity ordering: keep start <= preview <= end. */
  function orderHandles(start, preview, end) {
    var s = Math.min(start, end);
    var e = Math.max(start, end);
    return {
      start: s,
      preview: clamp(preview, s, e),
      end: e,
    };
  }

  /**
   * The range band (highlighted [start,end] region) in bar coords.
   * Returns { x, w } relative to the bar.
   */
  function rangeBand(startTime, endTime, duration, bar) {
    var s = timeToFraction(startTime, duration);
    var e = timeToFraction(endTime, duration);
    return {
      x: bar.x + s * bar.w,
      w: Math.max(0, (e - s) * bar.w),
    };
  }

  return {
    clamp: clamp,
    timeToFraction: timeToFraction,
    fractionToTime: fractionToTime,
    timeToX: timeToX,
    xToTime: xToTime,
    orderHandles: orderHandles,
    rangeBand: rangeBand,
  };
});
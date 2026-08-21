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

  /* ------------------------------------------------------------------ *
   * Zoom window math (detail strip)
   *
   * A zoom window `zw` is { start, end } in seconds, spanning a sub-range
   * of [0, duration] that the detail strip magnifies across its full
   * width. All functions are pure and clamp defensively.
   * ------------------------------------------------------------------ */

  /** Coerce any window-ish value into an ordered zw within [0, duration]. */
  function normalizeWindow(zw, duration) {
    var d = duration || 0;
    if (!(d > 0)) return { start: 0, end: 0 };
    var s = clamp(zw && isFinite(zw.start) ? +zw.start : 0, 0, d);
    var e = clamp(zw && isFinite(zw.end) ? +zw.end : 0, 0, d);
    if (e < s) {
      var t = s;
      s = e;
      e = t;
    }
    return { start: s, end: e };
  }

  /**
   * Time → pixel x within the bar rect for a zoomed window. Clamped into
   * view exactly like `timeToX`.
   */
  function timeToXInWindow(time, zw, bar, handleSize) {
    var w = normalizeWindow(zw, Infinity);
    var span = w.end - w.start;
    var frac = span > 0 ? (clamp(time, w.start, w.end) - w.start) / span : 0;
    var raw = bar.x + frac * bar.w;
    var hs = handleSize || 0;
    return clamp(raw, bar.x + hs / 2, bar.x + bar.w - hs / 2);
  }

  /** Client x → time inside the zoomed window. */
  function xToTimeInWindow(clientX, zw, bar) {
    var w = normalizeWindow(zw, Infinity);
    var span = w.end - w.start;
    var frac = bar.w > 0 ? clamp((clientX - bar.x) / bar.w, 0, 1) : 0;
    return w.start + frac * span;
  }

  /**
   * Pan a window by `dxFrac` strip-widths (positive = later in time),
   * preserving its span and clamping to [0, duration]. A window already as
   * wide as the video cannot move.
   */
  function panWindow(zw, dxFrac, duration) {
    var d = duration || 0;
    var w = normalizeWindow(zw, d);
    var span = w.end - w.start;
    if (!(d > 0) || !(span > 0) || span >= d) return w;
    var shift = clamp(dxFrac || 0, -1, 1) * span;
    var s = clamp(w.start + shift, 0, d - span);
    return { start: s, end: s + span };
  }

  /**
   * Zoom a window by `factor` (<1 in, >1 out) around `anchorTime`, keeping
   * the anchor's fractional position stable. Result spans at least
   * `minSpan` and at most the full duration, clamped into [0, duration].
   */
  function zoomWindow(zw, factor, anchorTime, duration, minSpan) {
    var d = duration || 0;
    var w = normalizeWindow(zw, d);
    var span = w.end - w.start;
    if (!(d > 0) || !(span > 0) || !factor || factor <= 0) return w;
    var floor = minSpan && minSpan > 0 ? Math.min(minSpan, d) : 0;
    var next = clamp(span * factor, floor, d);
    var anchor = clamp(
      anchorTime != null && isFinite(anchorTime) ? anchorTime : w.start + span / 2,
      w.start,
      w.end
    );
    var fracA = (anchor - w.start) / span;
    var s = clamp(anchor - fracA * next, 0, d - next);
    return { start: s, end: s + next };
  }

  /**
   * Rigidly translate a clip by `delta` seconds, clamping so both edges
   * stay inside [0, duration]. The span is invariant (and with it any
   * minimum-gap rule); `preview` keeps its relative offset inside the clip
   * so rendering during a translate drag stays coherent.
   */
  function translateClip(clip, delta, duration) {
    var d = duration || 0;
    var c = clip || {};
    var s = +c.start || 0;
    var e = +c.end || 0;
    if (!(e >= s)) {
      var tmp = s;
      s = e;
      e = tmp;
    }
    var span = e - s;
    var dt = typeof delta === 'number' && isFinite(delta) ? delta : 0;
    // A clip as wide as the video cannot move at all.
    var dd = span >= d ? 0 : clamp(dt, -s, d - e);
    var p = +c.preview;
    if (!isFinite(p)) p = s;
    p = clamp(p + dd, s + dd, e + dd);
    return { start: s + dd, end: e + dd, preview: p };
  }

  /**
   * Resize a zoom window by dragging one edge to `edgeTime`, keeping the
   * opposite edge anchored. Enforces `minSpan` and clamps into
   * [0, duration]. `edge` is 'start' or 'end'.
   */
  function setWindowEdge(zw, edge, edgeTime, duration, minSpan) {
    var d = duration || 0;
    var w = normalizeWindow(zw, d);
    if (!(d > 0)) return w;
    var floor = minSpan && minSpan > 0 ? Math.min(minSpan, d) : 0;
    var t = typeof edgeTime === 'number' && isFinite(edgeTime)
      ? clamp(edgeTime, 0, d)
      : (edge === 'start' ? w.start : w.end);
    if (edge === 'start') {
      var sMax = Math.max(0, w.end - floor);
      return { start: clamp(t, 0, sMax), end: w.end };
    }
    var eMin = Math.min(d, w.start + floor);
    return { start: w.start, end: clamp(t, eMin, d) };
  }

  return {
    clamp: clamp,
    timeToFraction: timeToFraction,
    fractionToTime: fractionToTime,
    timeToX: timeToX,
    xToTime: xToTime,
    orderHandles: orderHandles,
    rangeBand: rangeBand,
    normalizeWindow: normalizeWindow,
    timeToXInWindow: timeToXInWindow,
    xToTimeInWindow: xToTimeInWindow,
    panWindow: panWindow,
    zoomWindow: zoomWindow,
    translateClip: translateClip,
    setWindowEdge: setWindowEdge,
    ZOOM_FACTOR: 2,
    MIN_WINDOW_SPAN: 0.5,
  };
});
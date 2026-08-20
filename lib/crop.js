/*
 * lib/crop.js
 *
 * Pure crop geometry. A user drags a rectangle over the video *element*
 * (viewport pixels). Capture needs a rectangle in the video's intrinsic
 * `videoWidth × videoHeight` space, clamped to the letterboxed content box.
 *
 * Everything here is coordinate math with no DOM dependency so it can be unit
 * tested in Node.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else if (typeof define === 'function' && define.amd) {
    define([], factory);
  } else {
    root.ytSnipCrop = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  /**
   * The letterboxed rect within `(elementW × elementH)` where the video
   * content of aspect `(videoW × videoH)` actually renders (contain fit).
   */
  function contentBox(videoW, videoH, elementW, elementH) {
    var scale = Math.min(elementW / videoW, elementH / videoH);
    var w = videoW * scale;
    var h = videoH * scale;
    return { x: (elementW - w) / 2, y: (elementH - h) / 2, w: w, h: h };
  }

  /**
   * Clamp a viewport-space rect into `box` and express it as fractions of the
   * box (0..1 in each axis). `minFrac` enforces a minimum crop size.
   */
  function normalizeRect(rect, box, minFrac) {
    var min = minFrac || 0.02;
    var left = clamp(rect.x, box.x, box.x + box.w);
    var top = clamp(rect.y, box.y, box.y + box.h);
    var right = clamp(rect.x + rect.w, box.x, box.x + box.w);
    var bottom = clamp(rect.y + rect.h, box.y, box.y + box.h);

    var w = Math.max(right - left, min * box.w);
    var h = Math.max(bottom - top, min * box.h);
    left = Math.min(left, box.x + box.w - w);
    top = Math.min(top, box.y + box.h - h);

    return {
      x: (left - box.x) / box.w,
      y: (top - box.y) / box.h,
      w: w / box.w,
      h: h / box.h,
    };
  }

  /** Fractions (0..1) → pixel rect in video space. Floats are kept for drawImage. */
  function toPixelRect(nr, videoW, videoH) {
    return {
      x: nr.x * videoW,
      y: nr.y * videoH,
      w: nr.w * videoW,
      h: nr.h * videoH,
    };
  }

  /**
   * Output pixel dimensions for a normalized crop honoring `maxDimension`
   * (the long edge). The short edge scales with the crop aspect so the result
   * never exceeds `maxDimension` on either axis.
   */
  function outputSize(nr, videoW, videoH, maxDimension) {
    var pw = nr.w * videoW;
    var ph = nr.h * videoH;
    if (pw <= 0 || ph <= 0) {
      return { w: 1, h: 1 };
    }
    var scale = Math.min(1, maxDimension / Math.max(pw, ph));
    return {
      w: Math.max(1, Math.round(pw * scale)),
      h: Math.max(1, Math.round(ph * scale)),
    };
  }

  return {
    clamp: clamp,
    contentBox: contentBox,
    normalizeRect: normalizeRect,
    toPixelRect: toPixelRect,
    outputSize: outputSize,
  };
});
/*
 * lib/saveflow.js
 *
 * Pure save-flow logic for the clip → background boundary:
 *
 *   - clipParams(): assembles the capture-engine params, clamping the time
 *     window and the fps floor. The crop→output sizing itself lives in
 *     lib/crop (toPixelRect/outputSize) — no DOM here.
 *   - mapSaveResult()/mapSaveError(): normalize the background's response.
 *     The background replies `{ ok: true, id }` or `{ ok: false, error }` and
 *     never rejects, but messaging.request() turns `{ error }` responses into
 *     a rejection — which the pre-M9 code let fall through to the generic
 *     catch, making the "Save failed" toast unreachable (dead code). Both
 *     outcomes converge on a `{ ok, error, filename }` record here.
 *   - toastTextForError(): maps a normalized failure to the user-facing toast.
 *
 * UMD: `require`d in Node unit tests; loaded as a classic content script
 * (attaches `window.ytSnipSaveflow`). Performs no DOM access at load time.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else if (typeof define === 'function' && define.amd) {
    define([], factory);
  } else {
    root.ytSnipSaveflow = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /**
   * Capture params for the engine. `clip` is the { start, end } time window,
   * `videoDuration` the element's duration, `opts` the resolved options,
   * `cropPx` the pixel-space crop rect from lib/crop, `out` the output
   * dimensions from lib/crop's outputSize().
   */
  function clipParams(clip, videoDuration, opts, cropPx, out) {
    opts = opts || {};
    return {
      start: Math.max(0, clip.start),
      end: Math.min(videoDuration || clip.end, clip.end),
      fps: Math.max(1, opts.fps || 1),
      crop: cropPx,
      outW: out.w,
      outH: out.h,
    };
  }

  /** Normalize a resolved save response into { ok, error, filename }. */
  function mapSaveResult(response, filename) {
    if (!response || typeof response !== 'object') {
      return { ok: false, error: 'no response', filename: filename };
    }
    return {
      ok: !!(response.ok),
      error: response.error || null,
      filename: filename,
    };
  }

  /** Normalize a rejected save (messaging.request rejects on `{ error }`). */
  function mapSaveError(err, filename) {
    var msg = err && err.message ? err.message : typeof err === 'string' ? err : '';
    return {
      ok: false,
      error: String(msg).replace(/^yt-snip:\s*/, '').trim() || 'unknown error',
      filename: filename,
    };
  }

  var KNOWN_ERRORS = {
    'background: no payload received': 'Save failed: nothing to save',
    'background: no clip data received': 'Save failed: nothing to save',
    'background: no filename received': 'Save failed: missing filename',
    'background: downloads API unavailable': 'Save failed: downloads unavailable in this browser',
  };

  /** Map a normalized save error to a user toast. */
  function toastTextForError(error, fallback) {
    var msg = error && error.message ? error.message : error;
    if (!msg) return fallback || 'Save failed';
    var stripped = String(msg).replace(/^yt-snip:\s*/, '').trim();
    if (Object.prototype.hasOwnProperty.call(KNOWN_ERRORS, stripped)) {
      return KNOWN_ERRORS[stripped];
    }
    return 'Save failed: ' + stripped;
  }

  return {
    clipParams: clipParams,
    mapSaveResult: mapSaveResult,
    mapSaveError: mapSaveError,
    toastTextForError: toastTextForError,
    KNOWN_ERRORS: KNOWN_ERRORS,
  };
});

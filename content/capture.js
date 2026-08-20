/*
 * content/capture.js
 *
 * Seek-lenient capture engine for yt-snip.
 *
 * Strategy (PLAN.md "Capture (seek-lenient)"): the live player is paused,
 * then for each target time in `[start..end]` at `1/fps` we `currentTime = t`
 * and NEVER trust the seek to land exactly (YouTube's MSE only emits keyframes
 * every ~1–2 s). Instead we read the *actually rendered* frame's `mediaTime`
 * (via requestVideoFrameCallback when available, else `seeked` + rAF) and
 * capture that. The lib/scheduler.js generator dedups repeats and filters to
 * the clip window.
 *
 * Canvas taint: the first drawImage is followed by a 1×1 getImageData probe.
 * A `SecurityError` rejects the whole capture with `{ code: 'taint' }` so the
 * caller can retry via content/fallback-capture.js.
 *
 * UMD: require-able in Node tests; loaded as a classic content script otherwise
 * (attaches `window.ytSnipCapture`).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else if (typeof define === 'function' && define.amd) {
    define([], factory);
  } else {
    root.ytSnipCapture = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var scheduledFrames = null;
  function getScheduler() {
    if (!scheduledFrames) {
      if (typeof ytSnipScheduler !== 'undefined') {
        scheduledFrames = ytSnipScheduler.scheduledFrames;
      } else if (typeof module === 'object' && module.exports) {
        scheduledFrames = require('../lib/scheduler.js').scheduledFrames;
      } else {
        throw new Error('yt-snip: scheduler module not loaded');
      }
    }
    return scheduledFrames;
  }

  /**
   * Wrap an HTMLVideoElement as a scheduler source.
   * `signal` is optional; when `signal.aborted` is true, waitRendered resolves
   * with null so the capture loop stops. If the element fires `emptied` (the
   * player replaced/removed the media mid-capture) the source closes and marks
   * itself `emptied`, so the caller can fail fast with `{ code: 'no-video' }`
   * instead of hanging forever (A2 watchdog, PLAN.md).
   */
  function createVideoSource(video, signal) {
    var pendingWaiters = [];
    var lastMediaTime = video.currentTime || 0;
    var seeking = false;
    var closed = false;
    var emptied = false;
    var useRvfc = typeof video.requestVideoFrameCallback === 'function';

    function notify(mediaTime) {
      lastMediaTime = mediaTime;
      seeking = false;
      var waiters = pendingWaiters;
      pendingWaiters = [];
      for (var i = 0; i < waiters.length; i++) waiters[i](mediaTime);
    }

    function onRvfc(now, metadata) {
      if (closed) return;
      if (seeking) notify(metadata.mediaTime);
      video.requestVideoFrameCallback(onRvfc);
    }

    var fallbackFrames = 0;
    function onSeeked() {
      if (closed || !seeking) return;
      fallbackFrames = 2;
      tickFallback();
    }

    function tickFallback() {
      if (closed || fallbackFrames <= 0) return;
      fallbackFrames--;
      if (fallbackFrames === 0) {
        notify(video.currentTime);
      } else {
        requestAnimationFrame(tickFallback);
      }
    }

    function onAbort() {
      closed = true;
      var waiters = pendingWaiters;
      pendingWaiters = [];
      for (var i = 0; i < waiters.length; i++) waiters[i](null);
    }

    function onEmptied() {
      if (closed) return;
      closed = true;
      emptied = true;
      var waiters = pendingWaiters;
      pendingWaiters = [];
      for (var i = 0; i < waiters.length; i++) waiters[i](null);
      video.removeEventListener('seeked', onSeeked);
      video.removeEventListener('timeupdate', onSeeked);
      video.removeEventListener('emptied', onEmptied);
    }

    function detachListeners() {
      video.removeEventListener('seeked', onSeeked);
      video.removeEventListener('timeupdate', onSeeked);
      video.removeEventListener('emptied', onEmptied);
    }

    video.addEventListener('emptied', onEmptied);
    if (useRvfc) {
      video.requestVideoFrameCallback(onRvfc);
    } else {
      video.addEventListener('seeked', onSeeked);
      video.addEventListener('timeupdate', onSeeked);
    }
    if (signal && signal.subscribe) signal.subscribe(onAbort);

    return {
      seek: function (t) {
        if (closed) return Promise.resolve();
        seeking = true;
        video.currentTime = t;
        return Promise.resolve();
      },
      waitRendered: function () {
        if (closed) return Promise.resolve(null);
        return new Promise(function (resolve) {
          pendingWaiters.push(resolve);
        });
      },
      currentTime: function () {
        return lastMediaTime;
      },
      emptied: function () {
        return emptied;
      },
      close: function () {
        closed = true;
        var waiters = pendingWaiters;
        pendingWaiters = [];
        for (var i = 0; i < waiters.length; i++) waiters[i](null);
        detachListeners();
      },
    };
  }

  /**
   * Draw the crop from `video` into `canvas`.
   * `crop` is a pixel rect { x, y, w, h } in videoWidth×videoHeight space.
   */
  function drawCrop(video, crop, outW, outH, canvas, ctx) {
    var vw = video.videoWidth;
    var vh = video.videoHeight;
    var sx = Math.max(0, Math.min(crop.x, vw));
    var sy = Math.max(0, Math.min(crop.y, vh));
    var sw = Math.max(1, Math.min(crop.w, vw - sx));
    var sh = Math.max(1, Math.min(crop.h, vh - sy));
    ctx.clearRect(0, 0, outW, outH);
    ctx.drawImage(video, sx, sy, sw, sh, 0, 0, outW, outH);
  }

  /** 1×1 readback to detect canvas taint. Throws SecurityError when tainted. */
  function probeCanvas(ctx) {
    ctx.getImageData(0, 0, 1, 1);
  }

  /**
   * Capture frames from a video element.
   *
   * params:
   *   { start, end, fps, crop: {x,y,w,h}, outW, outH,
   *     watchdogMs }  // optional; default 8000 — wall-clock window for a
   *                   // rendered frame, reset on every yielded sample (A2)
   * hooks:
   *   { onProgress(fraction), render(index, mediaTime, canvas, ctx) }
   * signal:
   *   optional { aborted, subscribe(cb) }
   *
   * Resolves { frameCount, start, end }.
   * Rejects with { code: 'taint' } when the canvas is tainted,
   * { code: 'no-video' } when the element rendered no frame within watchdogMs
   * or emitted `emptied`, or { code: 'aborted' } when cancelled.
   */
  function captureFromVideo(video, params, hooks, signal) {
    var scheduled = getScheduler();
    return new Promise(function (resolve, reject) {
      var outW = Math.max(1, Math.round(params.outW));
      var outH = Math.max(1, Math.round(params.outH));
      var canvas = document.createElement('canvas');
      canvas.width = outW;
      canvas.height = outH;
      var ctx = canvas.getContext('2d');

      var watchdogMs = typeof params.watchdogMs === 'number' && params.watchdogMs > 0
        ? params.watchdogMs
        : 8000;
      var watchdogTimer = null;

      function clearWatchdog() {
        if (watchdogTimer) { clearTimeout(watchdogTimer); watchdogTimer = null; }
      }

      function resetWatchdog() {
        clearWatchdog();
        watchdogTimer = setTimeout(function () {
          watchdogTimer = null;
          source.close();
          reject({ code: 'no-video', message: 'No video frame rendered within ' + watchdogMs + 'ms' });
        }, watchdogMs);
      }

      var source = createVideoSource(video, signal);
      var index = 0;
      var first = true;
      var probeDone = false;

      (async function () {
        try {
          resetWatchdog();
          for await (var sample of scheduled(source, {
            start: params.start,
            end: params.end,
            fps: params.fps,
          })) {
            if (signal && signal.aborted) break;
            if (first) {
              // prime the canvas; first drawImage may taint
              drawCrop(video, params.crop, outW, outH, canvas, ctx);
              try {
                probeCanvas(ctx);
              } catch (e) {
                clearWatchdog();
                source.close();
                reject({ code: 'taint' });
                return;
              }
              probeDone = true;
              first = false;
            }
            drawCrop(video, params.crop, outW, outH, canvas, ctx);
            if (hooks.onProgress) {
              var total = params.end - params.start;
              hooks.onProgress(total > 0 ? Math.min(1, (sample.media - params.start) / total) : 1);
            }
            hooks.render(index++, sample.media, canvas, ctx);
            resetWatchdog();
          }
          clearWatchdog();
          source.close();
          if (signal && signal.aborted) {
            reject({ code: 'aborted' });
          } else if (source.emptied()) {
            reject({ code: 'no-video', message: 'Video was emptied (player replaced/removed the media)' });
          } else {
            resolve({ frameCount: index, start: params.start, end: params.end });
          }
        } catch (err) {
          clearWatchdog();
          source.close();
          reject(err && err.code ? err : { code: 'error', error: err });
        }
      })();
    });
  }

  return {
    createVideoSource: createVideoSource,
    captureFromVideo: captureFromVideo,
    drawCrop: drawCrop,
    probeCanvas: probeCanvas,
  };
});
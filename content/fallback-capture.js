/*
 * content/fallback-capture.js
 *
 * Detached-video fallback capture for yt-snip.
 *
 * Used when the live player canvas is tainted (SecurityError from the
 * getImageData probe in content/capture.js). Fallback builds a detached,
 * cross-origin-anonymous <video> from `video.currentSrc`, waits for it to be
 * loadable, then runs the exact same captureFromVideo engine against it.
 *
 * This only helps when YouTube serves media with CORS headers (it does for
 * playback). If the detached video is still tainted, the same { code: 'taint' }
 * rejection propagates so the UI can show a precise explanation instead of a
 * generic failure.
 *
 * UMD: loaded as a classic content script (attaches `window.ytSnipFallback`).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else if (typeof define === 'function' && define.amd) {
    define([], factory);
  } else {
    root.ytSnipFallback = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var captureFromVideo = null;
  function getEngine() {
    if (!captureFromVideo) {
      if (typeof ytSnipCapture !== 'undefined') {
        captureFromVideo = ytSnipCapture.captureFromVideo;
      } else if (typeof module === 'object' && module.exports) {
        captureFromVideo = require('./capture.js').captureFromVideo;
      } else {
        throw new Error('yt-snip: capture module not loaded');
      }
    }
    return captureFromVideo;
  }

  /**
   * Build a detached cross-origin video. Resolves with the <video> element once
   * data is loaded. Rejects { code: 'fallback-load-failed' } on error/timeout.
   */
  function loadDetachedVideo(src, timeoutMs) {
    var timeout = timeoutMs || 20000;
    return new Promise(function (resolve, reject) {
      var video = document.createElement('video');
      video.crossOrigin = 'anonymous';
      video.preload = 'auto';
      video.muted = true;
      video.playsInline = true;

      var done = false;
      var timer = setTimeout(function () {
        if (done) return;
        done = true;
        cleanup();
        reject({ code: 'fallback-load-failed', message: 'Timed out loading media for fallback capture' });
      }, timeout);

      function cleanup() {
        clearTimeout(timer);
        video.removeEventListener('loadeddata', onData);
        video.removeEventListener('canplay', onData);
        video.removeEventListener('error', onErr);
      }

      function onData() {
        if (done) return;
        done = true;
        cleanup();
        resolve(video);
      }

      function onErr() {
        if (done) return;
        done = true;
        cleanup();
        reject({ code: 'fallback-load-failed', message: 'Could not load media for fallback capture' });
      }

      video.addEventListener('loadeddata', onData);
      video.addEventListener('canplay', onData);
      video.addEventListener('error', onErr);
      video.src = src;
    });
  }

  /**
   * Run the fallback capture. Same signature as captureFromVideo's params/hooks
   * but `source` describes the live video to mirror.
   * Rejects with { code: 'taint' } if the detached source is tainted too.
   */
  function captureFromLiveVideo(sourceVideo, params, hooks, signal) {
    var engine = getEngine();
    var src = sourceVideo.currentSrc || sourceVideo.src;
    if (!src) return Promise.reject({ code: 'fallback-load-failed', message: 'No media source available' });
    return loadDetachedVideo(src).then(function (detached) {
      return engine(detached, params, hooks, signal);
    });
  }

  return {
    loadDetachedVideo: loadDetachedVideo,
    captureFromLiveVideo: captureFromLiveVideo,
  };
});
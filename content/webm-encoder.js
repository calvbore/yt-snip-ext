/*
 * content/webm-encoder.js
 *
 * Truecolor WebM clip encoder for yt-snip (M16): feeds captured RGBA frames
 * through the browser's WebCodecs VideoEncoder (VP9, VP8/AV1 fallbacks) and
 * muxes the packets into a WebM container with the vendored Mediabunny
 * (lib/vendor/mediabunny.js, MPL-2.0 — see that directory's license file).
 *
 * Truecolor is the point: GIF quantizes every frame to 256 colors, which
 * flattens video gradients and blends small objects (M16 finding). WebM/VP9
 * keeps full 8-bit color. Decoding is universal in AnkiDroid (Android
 * WebView) and AnkiMobile on iOS 17.4+.
 *
 * Frames arrive as ImageData-like records ({ data, width, height }) collected
 * during capture (the capture loop is synchronous); encoding runs after the
 * capture completes. Timestamps are derived from the output slot index
 * (idx · 1e6/outputFps μs) — monotonic by construction, and exact for
 * duplicated slow-motion frames (M17).
 *
 * UMD: `require`d in Node unit tests, loaded as a classic content script
 * otherwise (attaches `window.ytSnipWebm`).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else if (typeof define === 'function' && define.amd) {
    define([], factory);
  } else {
    root.ytSnipWebm = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var CODECS = [
    { name: 'vp9', config: 'vp09.00.10.08' },
    { name: 'vp8', config: 'vp8' },
    { name: 'av1', config: 'av01.0.04M.08' },
  ];

  /**
   * Feature-detect the encode path. Resolves
   * { supported: true, codec } or { supported: false, reason }.
   * `deps` is a test seam: { VideoEncoder, webm } (defaults to globals).
   */
  function isSupported(deps) {
    deps = deps || {};
    var VE = deps.VideoEncoder;
    var webm = deps.webm;
    if (webm === undefined) {
      webm = typeof Mediabunny !== 'undefined' ? Mediabunny : null;
    }
    if (typeof VE !== 'function') {
      try { VE = typeof VideoEncoder === 'function' ? VideoEncoder : null; } catch (e) { VE = null; }
    }
    if (!VE || typeof VE.isConfigSupported !== 'function') {
      return Promise.resolve({ supported: false, reason: 'WebCodecs VideoEncoder unavailable' });
    }
    if (!webm || !webm.Output || !webm.WebMOutputFormat || !webm.BufferTarget || !webm.VideoSampleSource) {
      return Promise.resolve({ supported: false, reason: 'WebM muxer unavailable' });
    }
    var probe = { codec: 'vp09.00.10.08', width: 256, height: 144, framerate: 12, bitrate: 2500000 };
    return VE.isConfigSupported(probe).then(function (res) {
      if (res && res.supported) {
        return { supported: true, codec: 'vp9' };
      }
      return VE.isConfigSupported({ codec: 'vp8', width: 256, height: 144, framerate: 12, bitrate: 2500000 })
        .then(function (res8) {
          if (res8 && res8.supported) return { supported: true, codec: 'vp8' };
          return { supported: false, reason: 'no encodable WebM video codec in this browser' };
        }, function () {
          return { supported: false, reason: 'WebCodecs codec probe failed' };
        });
    }, function () {
      return { supported: false, reason: 'WebCodecs codec probe failed' };
    });
  }

  function autoBitrate(width, height, fps) {
    return Math.min(8000000, Math.max(2500000, Math.round(width * height * fps * 0.2)));
  }

  /**
   * Encode RGBA frames into a WebM container.
   *
   * params:
   *   { width, height, outputFps, frames: [{ data, width, height }],
   *     bitrate?, keyFrameInterval? (seconds, default 1) }
   * deps (test seam):
   *   { webm, VideoEncoder, VideoFrame, createCanvas } — defaults to globals.
   *
   * Resolves Uint8Array (the WebM bytes); rejects { code: 'encode', error }.
   */
  function encodeFrames(params, deps) {
    deps = deps || {};
    var webm = deps.webm;
    if (webm === undefined) {
      webm = typeof Mediabunny !== 'undefined' ? Mediabunny : null;
    }
    var VideoFrameCtor = deps.VideoFrame;
    if (VideoFrameCtor === undefined) {
      VideoFrameCtor = typeof VideoFrame === 'function' ? VideoFrame : null;
    }
    var createCanvas = deps.createCanvas || function (w, h) {
      var c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      return c;
    };
    return new Promise(function (resolve, reject) {
      try {
        if (!webm || !VideoFrameCtor) {
          throw { code: 'encode', error: new Error('WebCodecs/mediabunny unavailable') };
        }
        if (!params.frames || params.frames.length === 0) {
          throw { code: 'encode', error: 'no frames to encode' };
        }
        var W = Math.round(params.width);
        var H = Math.round(params.height);
        var fps = params.outputFps > 0 ? params.outputFps : 12;
        var canvas = createCanvas(W, H);
        var ctx = canvas.getContext('2d');

        var output = new webm.Output({
          format: new webm.WebMOutputFormat(),
          target: new webm.BufferTarget(),
        });
        var source = new webm.VideoSampleSource({
          codec: params.codec || 'vp9',
          bitrate: params.bitrate || autoBitrate(W, H, fps),
          keyFrameInterval: params.keyFrameInterval === undefined ? 1 : params.keyFrameInterval,
        });
        output.addVideoTrack(source, { frameRate: fps });

        (async function () {
          await output.start();
          var frameDur = 1e6 / fps; // μs
          for (var idx = 0; idx < params.frames.length; idx++) {
            var img = params.frames[idx];
            ctx.putImageData(img, 0, 0);
            var frame = new VideoFrameCtor(canvas, {
              timestamp: Math.round(idx * frameDur),
              duration: Math.round(frameDur),
            });
            var sample = new webm.VideoSample(frame, {
              timestamp: idx / fps,
              duration: 1 / fps,
            });
            // The sample owns the frame now; sample.close() releases it after
            // the encoder has consumed it (closing the frame here, before the
            // async encode, would hand the encoder a dead frame).
            await source.add(sample);
            sample.close();
          }
          await output.finalize();
          var buffer = output.target.buffer;
          if (!buffer) throw { code: 'encode', error: 'muxer produced no buffer' };
          resolve(new Uint8Array(buffer));
        })().catch(function (err) {
          reject(err && err.code ? err : { code: 'encode', error: err });
        });
      } catch (err) {
        reject(err && err.code ? err : { code: 'encode', error: err });
      }
    });
  }

  return {
    isSupported: isSupported,
    encodeFrames: encodeFrames,
    autoBitrate: autoBitrate,
  };
});

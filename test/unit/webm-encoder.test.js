'use strict';

/*
 * test/unit/webm-encoder.test.js
 *
 * M16 Tier 0 tests for content/webm-encoder.js. The real encode runs in the
 * Firefox Tier 1 e2e (WebCodecs + mediabunny); here the wrapper's decision
 * logic is pinned with injected fakes:
 *   - isSupported(): feature detection + codec fallback order
 *   - encodeFrames(): VideoFrame timestamps (slot-index derived, monotonic),
 *     per-frame forwarding order, muxed byte return, rejection paths
 */

const test = require('node:test');
const assert = require('node:assert');
const webmEncoder = require('../../content/webm-encoder.js');

function fakeMediabunny() {
  const calls = { output: [], samples: [], config: null };
  class FakeVideoSampleSource {
    constructor(cfg) {
      calls.config = cfg;
    }
    async add(sample) {
      calls.samples.push(sample);
    }
  }
  class FakeOutput {
    constructor(opts) {
      calls.output.push(opts);
      this.target = { buffer: null };
      this.format = opts.format;
    }
    addVideoTrack(source, metadata) {
      calls.track = { source, metadata };
    }
    async start() { calls.started = true; }
    async finalize() { calls.ended = true; this.target.buffer = new Uint8Array([1, 2, 3]).buffer; }
  }
  return {
    M: {
      Output: FakeOutput,
      BufferTarget: class { constructor() { this.buffer = null; } },
      WebMOutputFormat: class { },
      VideoSampleSource: FakeVideoSampleSource,
      VideoSample: class {
        constructor(frame, init) {
          this.timestamp = init.timestamp;
          this.duration = init.duration;
          this._closed = false;
          this.frame = frame;
        }
        close() { this._closed = true; }
      },
    },
    calls: calls,
  };
}

function fakeVideoFrame(frames) {
  return class FakeVideoFrame {
    constructor(source, init) {
      frames.push({ init: init, isVideoFrameLike: true });
    }
    close() { /* released */ }
  };
}

function fakeCanvas() {
  return function createCanvas(w, h) {
    return {
      width: w,
      height: h,
      getContext: () => ({ putImageData() {} }),
    };
  };
}

test('isSupported: false without VideoEncoder', async () => {
  const res = await webmEncoder.isSupported({ VideoEncoder: undefined, webm: {} });
  assert.equal(res.supported, false);
  assert.match(res.reason, /VideoEncoder/);
});

test('isSupported: false without the muxer', async () => {
  const res = await webmEncoder.isSupported({
    VideoEncoder: class { static isConfigSupported() { return Promise.resolve({ supported: true }); } },
    webm: null,
  });
  assert.equal(res.supported, false);
  assert.match(res.reason, /muxer/);
});

test('isSupported: vp9 primary, vp8 fallback, else unsupported', async () => {
  const muxer = { Output: class { }, WebMOutputFormat: class { }, BufferTarget: class { }, VideoSampleSource: class { } };
  const always = (supported) => class {
    static isConfigSupported() { return Promise.resolve({ supported }); }
  };
  assert.equal((await webmEncoder.isSupported({ VideoEncoder: always(true), webm: muxer })).codec, 'vp9');
  const mixed = class {
    static isConfigSupported(cfg) {
      return Promise.resolve({ supported: cfg.codec === 'vp8' });
    }
  };
  assert.equal((await webmEncoder.isSupported({ VideoEncoder: mixed, webm: muxer })).codec, 'vp8');
  assert.equal((await webmEncoder.isSupported({ VideoEncoder: always(false), webm: muxer })).supported, false);
});

test('encodeFrames forwards frames with slot-index timestamps and returns muxed bytes', async () => {
  const fake = fakeMediabunny();
  const frames = [];
  const bytes = await webmEncoder.encodeFrames({
    width: 64,
    height: 32,
    outputFps: 8,
    frames: [makeImg(64, 32), makeImg(64, 32), makeImg(64, 32)],
  }, { webm: fake.M, VideoFrame: fakeVideoFrame(frames), createCanvas: fakeCanvas() });
  assert.deepEqual(Array.from(bytes), [1, 2, 3]);
  assert.equal(fake.calls.started, true);
  assert.equal(fake.calls.ended, true);
  assert.equal(fake.calls.track.metadata.frameRate, 8);
  assert.equal(fake.calls.config.codec, 'vp9');
  assert.equal(fake.calls.config.keyFrameInterval, 1);
  // 3 frames @ 8 fps → timestamps 0, 1/8, 2/8 (seconds, exact)
  assert.deepEqual(
    fake.calls.samples.map((s) => Math.round(s.timestamp * 1e6)),
    [0, 125000, 250000]
  );
  // VideoFrame got the μs timestamps
  assert.deepEqual(frames.map((f) => f.init.timestamp), [0, 125000, 250000]);
  assert.ok(frames.every((f) => f.init.duration === 125000));
  // Samples were closed after the (awaited) add
  assert.ok(fake.calls.samples.every((s) => s._closed));
});

test('encodeFrames honors bitrate + custom keyFrameInterval and codec', async () => {
  const fake = fakeMediabunny();
  await webmEncoder.encodeFrames({
    width: 512,
    height: 288,
    outputFps: 24,
    codec: 'vp8',
    bitrate: 4000000,
    keyFrameInterval: 2,
    frames: [makeImg(512, 288)],
  }, { webm: fake.M, VideoFrame: fakeVideoFrame([]), createCanvas: fakeCanvas() });
  assert.equal(fake.calls.config.codec, 'vp8');
  assert.equal(fake.calls.config.bitrate, 4000000);
  assert.equal(fake.calls.config.keyFrameInterval, 2);
});

test('encodeFrames rejects without frames or without deps', async () => {
  const fake = fakeMediabunny();
  await assert.rejects(
    () => webmEncoder.encodeFrames({ width: 64, height: 32, outputFps: 8, frames: [] },
      { webm: fake.M, VideoFrame: fakeVideoFrame([]), createCanvas: fakeCanvas() }),
    (err) => err.code === 'encode'
  );
  await assert.rejects(
    () => webmEncoder.encodeFrames({ width: 64, height: 32, frames: [makeImg(64, 32)] },
      { webm: null, VideoFrame: null }),
    (err) => err.code === 'encode'
  );
});

test('autoBitrate clamps to the 2.5–8 Mbps band', () => {
  assert.equal(webmEncoder.autoBitrate(64, 32, 12), 2500000);
  assert.equal(webmEncoder.autoBitrate(512, 288, 30), 2500000); // below the floor
  assert.equal(webmEncoder.autoBitrate(1280, 720, 30), Math.round(1280 * 720 * 30 * 0.2));
  assert.equal(webmEncoder.autoBitrate(1920, 1080, 60), 8000000);
});

function makeImg(w, h) {
  return { data: new Uint8ClampedArray(w * h * 4).fill(128), width: w, height: h };
}

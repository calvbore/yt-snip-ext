'use strict';

/*
 * test/unit/capture.test.js  — Tier 0 coverage for the seek-lenient capture
 * engine's fail-fast paths (A2 watchdog, PLAN.md):
 *
 *   - `emptied` on the video element releases pending waiters and marks the
 *     source emptied, so capture rejects { code: 'no-video' } instead of
 *     hanging forever when the player replaces/removes the media mid-capture
 *   - the wall-clock watchdog rejects { code: 'no-video' } when no frame
 *     renders within `params.watchdogMs` (default 8000, injectable)
 *   - normal capture completes and clears the watchdog
 *
 * The real rVFC path is used: the fake video element stores the
 * requestVideoFrameCallback handlers and refires them manually, giving full
 * control over when frames "render".
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const capture = require('../../content/capture.js');

const flush = () => new Promise((r) => setImmediate(r));

function makeVideo() {
  const listeners = {};
  const rvfcCbs = [];
  return {
    currentTime: 0,
    paused: true,
    videoWidth: 640,
    videoHeight: 360,
    listeners,
    rvfcCbs,
    addEventListener(ev, cb) {
      (listeners[ev] = listeners[ev] || []).push(cb);
    },
    removeEventListener(ev, cb) {
      const arr = listeners[ev];
      if (!arr) return;
      const i = arr.indexOf(cb);
      if (i >= 0) arr.splice(i, 1);
    },
    dispatch(ev) {
      const arr = (listeners[ev] || []).slice();
      for (const cb of arr) cb();
    },
    requestVideoFrameCallback(cb) {
      rvfcCbs.push(cb);
    },
    fireFrame(mediaTime) {
      const cbs = rvfcCbs.splice(0);
      for (const cb of cbs) cb(0, { mediaTime });
    },
  };
}

function installFakeDom() {
  const fctx = {
    clearRect() {},
    drawImage() {},
    getImageData(x, y, w, h) {
      return { data: new Uint8ClampedArray(w * h * 4) };
    },
  };
  global.document = { createElement() { return { width: 0, height: 0, getContext: () => fctx }; } };
  global.requestAnimationFrame = () => 0;
}

function params(overrides) {
  return Object.assign({
    start: 0,
    end: 1,
    fps: 2,
    outW: 16,
    outH: 9,
    crop: { x: 0, y: 0, w: 640, h: 360 },
  }, overrides || {});
}

test('capture: emptied releases pending waiters and marks the source emptied', async () => {
  const video = makeVideo();
  const source = capture.createVideoSource(video, null);
  assert.equal(source.emptied(), false);
  assert.equal(video.listeners.emptied.length, 1);

  const p = source.waitRendered();
  video.dispatch('emptied');

  assert.equal(await p, null);
  assert.equal(source.emptied(), true);
  // closed: further waitRendered resolves immediately with null
  assert.equal(await source.waitRendered(), null);
});

test('capture: signal abort closes without the emptied flag', async () => {
  const video = makeVideo();
  const subs = [];
  const signal = { subscribe: (cb) => subs.push(cb) };
  const source = capture.createVideoSource(video, signal);

  const p = source.waitRendered();
  subs[0](); // abort

  assert.equal(await p, null);
  assert.equal(source.emptied(), false);
});

test('capture: watchdog rejects {code:no-video} when no frame renders within watchdogMs', async () => {
  installFakeDom();
  const video = makeVideo();
  const hooks = { render() { throw new Error('no frames should render'); } };
  await assert.rejects(
    capture.captureFromVideo(video, params({ watchdogMs: 30 }), hooks, null),
    (err) => err && err.code === 'no-video'
  );
});

test('capture: emptied during capture rejects {code:no-video} (fail-fast)', async () => {
  installFakeDom();
  const video = makeVideo();
  let frames = 0;
  const hooks = { render() { frames++; } };

  const promise = capture.captureFromVideo(video, params({ watchdogMs: 2000 }), hooks, null);
  await flush();            // generator awaiting waitRendered for t=0
  video.fireFrame(0);       // renders the first frame (t=0)
  await flush();            // generator awaiting waitRendered for t=0.5
  video.dispatch('emptied'); // player swapped the media mid-capture

  await assert.rejects(promise, (err) => err && err.code === 'no-video');
  assert.ok(frames >= 1, 'first frame must have rendered before the emptied abort');
});

test('capture: completes normally and clears the watchdog', async () => {
  installFakeDom();
  const video = makeVideo();
  let frames = 0;
  const hooks = { render() { frames++; } };

  const promise = capture.captureFromVideo(video, params({ watchdogMs: 2000 }), hooks, null);
  await flush();
  video.fireFrame(0);   // t=0
  await flush();
  video.fireFrame(0.5); // t=0.5
  await flush();
  video.fireFrame(1);   // t=1
  await flush();
  video.fireFrame(1);   // deduped → advances target past end, loop breaks

  const res = await promise;
  assert.equal(res.frameCount, 3);
  assert.equal(frames, 3);
});
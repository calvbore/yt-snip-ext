'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const options = require('../../lib/options.js');

test('options: defaults when nothing stored', () => {
  assert.deepEqual(options.resolve(undefined), {
    fps: 12,
    maxDimension: 512,
    saveAs: false,
    loopOnPlay: true,
    clipPadStart: 3,
    clipPadEnd: 3,
    format: 'webm',
    dither: true,
  });
  assert.deepEqual(options.resolve(null), options.DEFAULTS);
});

test('options: passes through valid values', () => {
  assert.deepEqual(options.resolve({ fps: 20, maxDimension: 640, saveAs: true, loopOnPlay: false, clipPadStart: 1, clipPadEnd: 5 }), {
    fps: 20,
    maxDimension: 640,
    saveAs: true,
    loopOnPlay: false,
    clipPadStart: 1,
    clipPadEnd: 5,
    format: 'webm',
    dither: true,
  });
});

test('options: clamps fps into [1, 60]', () => {
  assert.equal(options.resolve({ fps: 0 }).fps, 1);
  assert.equal(options.resolve({ fps: -5 }).fps, 1);
  assert.equal(options.resolve({ fps: 999 }).fps, 60);
  assert.equal(options.resolve({ fps: '18' }).fps, 18);
  assert.equal(options.resolve({ fps: 'abc' }).fps, 1);
});

test('options: clamps maxDimension into [64, 8000]', () => {
  assert.equal(options.resolve({ maxDimension: 8 }).maxDimension, 64);
  assert.equal(options.resolve({ maxDimension: 99999 }).maxDimension, 8000);
  assert.equal(options.resolve({ maxDimension: 300 }).maxDimension, 300);
});

test('options: clip pads clamp into [0, 600] independently', () => {
  // Defaults are the M14 behavior (3 s each side).
  assert.equal(options.resolve({}).clipPadStart, 3);
  assert.equal(options.resolve({}).clipPadEnd, 3);
  // Independent values pass through.
  assert.equal(options.resolve({ clipPadStart: 1 }).clipPadStart, 1);
  assert.equal(options.resolve({ clipPadEnd: 10 }).clipPadEnd, 10);
  // Zero is legitimate (handle parked at the activation timestamp).
  assert.equal(options.resolve({ clipPadStart: 0 }).clipPadStart, 0);
  assert.equal(options.resolve({ clipPadEnd: 0 }).clipPadEnd, 0);
  // Out-of-range and garbage clamp per side.
  assert.equal(options.resolve({ clipPadStart: -5 }).clipPadStart, 0);
  assert.equal(options.resolve({ clipPadEnd: -1 }).clipPadEnd, 0);
  assert.equal(options.resolve({ clipPadStart: 9999 }).clipPadStart, 600);
  assert.equal(options.resolve({ clipPadEnd: 'abc' }).clipPadEnd, 0);
});

test('options: saveAs accepts several truthy encodings', () => {
  assert.equal(options.resolve({ saveAs: true }).saveAs, true);
  assert.equal(options.resolve({ saveAs: 'true' }).saveAs, true);
  assert.equal(options.resolve({ saveAs: 1 }).saveAs, true);
  assert.equal(options.resolve({ saveAs: false }).saveAs, false);
  assert.equal(options.resolve({ saveAs: 'yes' }).saveAs, false);
});

test('options: loopOnPlay defaults on and only explicit falsy turns it off', () => {
  assert.equal(options.resolve({}).loopOnPlay, true);
  assert.equal(options.resolve({ loopOnPlay: true }).loopOnPlay, true);
  assert.equal(options.resolve({ loopOnPlay: 'true' }).loopOnPlay, true);
  assert.equal(options.resolve({ loopOnPlay: 1 }).loopOnPlay, true);
  assert.equal(options.resolve({ loopOnPlay: 'yes' }).loopOnPlay, true); // not an explicit falsy
  assert.equal(options.resolve({ loopOnPlay: false }).loopOnPlay, false);
  assert.equal(options.resolve({ loopOnPlay: 'false' }).loopOnPlay, false);
  assert.equal(options.resolve({ loopOnPlay: 0 }).loopOnPlay, false);
  assert.equal(options.resolve({ loopOnPlay: null }).loopOnPlay, false);
});

test('options: format accepts gif and webm; unknown falls back to the webm default', () => {
  assert.equal(options.resolve({ format: 'webm' }).format, 'webm');
  assert.equal(options.resolve({ format: 'gif' }).format, 'gif');
  assert.equal(options.resolve({ format: 'mp4' }).format, 'webm');
  assert.equal(options.resolve({ format: 'avi' }).format, 'webm');
  assert.equal(options.resolve({}).format, 'webm');
});

test('options: dither defaults on and only explicit falsy turns it off', () => {
  assert.equal(options.resolve({}).dither, true);
  assert.equal(options.resolve({ dither: true }).dither, true);
  assert.equal(options.resolve({ dither: 'true' }).dither, true);
  assert.equal(options.resolve({ dither: 1 }).dither, true);
  assert.equal(options.resolve({ dither: false }).dither, false);
  assert.equal(options.resolve({ dither: 'false' }).dither, false);
  assert.equal(options.resolve({ dither: 0 }).dither, false);
  assert.equal(options.resolve({ dither: null }).dither, false);
});

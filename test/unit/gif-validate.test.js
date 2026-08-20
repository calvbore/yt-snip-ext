'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { decodeGif, pixelAt, approxEqual, GifDecodeError } = require('../helpers/gif-validate.js');

// Canonical 1×1 GIF: transparent-ish, validates the basic parse.
const GIF_1x1 = Buffer.from(
  'R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==',
  'base64'
);

test('gif-validate: decodes the canonical 1x1 GIF', () => {
  const d = decodeGif(GIF_1x1);
  assert.equal(d.width, 1);
  assert.equal(d.height, 1);
  assert.equal(d.frames.length, 1);
});

test('gif-validate: rejects non-GIF input', () => {
  assert.throws(() => decodeGif(Buffer.from('not a gif at all, definitely not', 'utf8')), GifDecodeError);
});

test('gif-validate: rejects too-short input', () => {
  assert.throws(() => decodeGif(Buffer.from('GIF89a', 'utf8')), GifDecodeError);
});

test('gif-validate: pixelAt reads the RGBA of a pixel', () => {
  const rgba = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
  assert.deepEqual(pixelAt(rgba, 2, 0, 1), [9, 10, 11, 12]);
  assert.deepEqual(pixelAt(rgba, 2, 1, 1), [13, 14, 15, 16]);
});

test('gif-validate: approxEqual compares within tolerance', () => {
  assert.equal(approxEqual([0, 200, 0], [4, 196, 2], 6), true);
  assert.equal(approxEqual([0, 200, 0], [10, 196, 2], 6), false);
});

test('gif-validate: cross-checks against a reference decoder (omggif)', async () => {
  const omggif = require('omggif');
  const W = 48;
  const H = 24;
  const palette = [0x0a0a0a, 0x050505, 0x00c800, 0xfafafa];

  function makeFrame(level) {
    const px = new Uint8Array(W * H);
    for (let i = 0; i < px.length; i++) {
      const x = i % W;
      const y = Math.floor(i / W);
      let idx = 0;
      if (y < 3) idx = level ? 2 : 1;
      if (y >= 4 && y < 8 && x < 14) idx = 3;
      px[i] = idx;
    }
    return px;
  }

  const buf = new Uint8Array(200000);
  const writer = new omggif.GifWriter(buf, W, H, { palette, loop: 0 });
  writer.addFrame(0, 0, W, H, makeFrame(0), { delay: 10 });
  writer.addFrame(0, 0, W, H, makeFrame(1), { delay: 35 });
  writer.addFrame(0, 0, W, H, makeFrame(1), { delay: 10 });
  const gifBytes = buf.slice(0, writer.end());

  const decoded = decodeGif(gifBytes);
  assert.equal(decoded.width, W);
  assert.equal(decoded.height, H);
  assert.equal(decoded.frames.length, 3);
  assert.deepEqual(decoded.frames.map((f) => f.delayMs), [100, 350, 100]);

  // Compare every composed frame, pixel for pixel, with omggif's RGBA blit.
  const reader = new omggif.GifReader(gifBytes);
  const ref = new Uint8Array(W * H * 4);
  for (let i = 0; i < decoded.frames.length; i++) {
    reader.decodeAndBlitFrameRGBA(i, ref);
    assert.deepEqual(Array.from(decoded.frames[i].rgba), Array.from(ref),
      'frame ' + i + ' must match the reference decoder');
  }
});
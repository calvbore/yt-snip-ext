'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const crop = require('../../lib/crop.js');

test('crop: contentBox is contain-fit (no bars for same aspect)', () => {
  assert.deepEqual(crop.contentBox(640, 360, 640, 360), { x: 0, y: 0, w: 640, h: 360 });
});

test('crop: contentBox letterboxes wide element', () => {
  const box = crop.contentBox(640, 360, 1280, 720);
  assert.deepEqual(box, { x: 0, y: 0, w: 1280, h: 720 });
});

test('crop: contentBox letterboxes a taller-than-video element (bars top/bottom)', () => {
  const box = crop.contentBox(640, 360, 400, 400);
  assert.equal(box.x, 0);
  assert.equal(box.w, 400);
  assert.equal(box.y, 87.5);
  assert.equal(box.h, 225);
});

test('crop: contentBox pillarboxes a narrower-than-video element (bars sides)', () => {
  const box = crop.contentBox(640, 360, 320, 160);
  assert.ok(Math.abs(box.x - 160 / 9) < 1e-6, 'x=' + box.x);
  assert.ok(Math.abs(box.w - 2560 / 9) < 1e-6, 'w=' + box.w);
  assert.equal(box.y, 0);
  assert.equal(box.h, 160);
});

test('crop: normalizeRect converts viewport rect into clamped fractions', () => {
  const box = { x: 0, y: 0, w: 640, h: 360 };
  const nr = crop.normalizeRect({ x: 100, y: 50, w: 320, h: 180 }, box);
  assert.deepEqual(nr, { x: 100 / 640, y: 50 / 360, w: 0.5, h: 0.5 });
});

test('crop: normalizeRect clamps rects that hang outside the content box', () => {
  const box = { x: 0, y: 0, w: 640, h: 360 };
  const nr = crop.normalizeRect({ x: -50, y: 0, w: 800, h: 400 }, box);
  assert.equal(nr.x, 0);
  assert.equal(nr.y, 0);
  assert.equal(nr.w, 1);
  assert.equal(nr.h, 1);
});

test('crop: normalizeRect enforces a minimum crop size', () => {
  const box = { x: 0, y: 0, w: 640, h: 360 };
  const nr = crop.normalizeRect({ x: 10, y: 10, w: 1, h: 1 }, box, 0.1);
  assert.ok(nr.w >= 0.1 - 1e-9);
  assert.ok(nr.h >= 0.1 - 1e-9);
  // the kept corner stays inside the box
  assert.ok(nr.x + nr.w <= 1 + 1e-9);
  assert.ok(nr.y + nr.h <= 1 + 1e-9);
});

test('crop: toPixelRect maps fractions to video pixels', () => {
  assert.deepEqual(crop.toPixelRect({ x: 0.25, y: 0.5, w: 0.5, h: 0.25 }, 640, 360), {
    x: 160,
    y: 180,
    w: 320,
    h: 90,
  });
});

test('crop: outputSize honors the Anki maxDimension long edge', () => {
  // 16:9 crop, max 512 → 512x288
  assert.deepEqual(crop.outputSize({ w: 1, h: 1 }, 640, 360, 512), { w: 512, h: 288 });
  // smaller than max stays unchanged
  assert.deepEqual(crop.outputSize({ w: 0.25, h: 0.25 }, 640, 360, 512), { w: 160, h: 90 });
  // extreme aspect: long edge still bounded
  const tall = crop.outputSize({ w: 0.2, h: 1 }, 640, 360, 512);
  assert.ok(Math.max(tall.w, tall.h) <= 512);
});

test('crop: outputSize guards zero sizes', () => {
  assert.deepEqual(crop.outputSize({ w: 0, h: 0 }, 640, 360, 512), { w: 1, h: 1 });
});
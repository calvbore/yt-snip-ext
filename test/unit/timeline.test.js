'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const timeline = require('../../lib/timeline.js');

const BAR = { x: 0, y: 0, w: 100, h: 8 };

test('timeline: timeToFraction clamps and scales', () => {
  assert.equal(timeline.timeToFraction(2.5, 5), 0.5);
  assert.equal(timeline.timeToFraction(-1, 5), 0);
  assert.equal(timeline.timeToFraction(9, 5), 1);
  assert.equal(timeline.timeToFraction(1, 0), 0);
});

test('timeline: fractionToTime clamps and scales', () => {
  assert.equal(timeline.fractionToTime(0.5, 5), 2.5);
  assert.equal(timeline.fractionToTime(2, 5), 5);
  assert.equal(timeline.fractionToTime(-0.5, 5), 0);
});

test('timeline: timeToX and xToTime round-trip', () => {
  const x = timeline.timeToX(2.5, 5, BAR, 12);
  assert.equal(x, 50);
  assert.equal(timeline.xToTime(50, 5, BAR), 2.5);
});

test('timeline: timeToX keeps the handle in view at the bar edges', () => {
  // handleSize 12 → center is clamped into [6, 94] within a 100px bar.
  assert.equal(timeline.timeToX(0, 5, BAR, 12), 6);
  assert.equal(timeline.timeToX(5, 5, BAR, 12), 94);
});

test('timeline: timeToX clamps relative to a non-zero bar origin', () => {
  const bar = { x: 10, y: 0, w: 100, h: 8 };
  assert.equal(timeline.timeToX(0, 5, bar, 12), 16);
  assert.equal(timeline.timeToX(5, 5, bar, 12), 104);
  assert.equal(timeline.timeToX(2.5, 5, bar, 12), 60);
});

test('timeline: timeToX without a handleSize preserves the raw mapping', () => {
  assert.equal(timeline.timeToX(0, 5, BAR), 0);
  assert.equal(timeline.timeToX(5, 5, BAR), 100);
});

test('timeline: orderHandles enforces start <= preview <= end', () => {
  assert.deepEqual(timeline.orderHandles(4, 1, 2), { start: 2, preview: 2, end: 4 });
  assert.deepEqual(timeline.orderHandles(1, 3, 2), { start: 1, preview: 2, end: 2 });
  assert.deepEqual(timeline.orderHandles(1, 1.5, 2), { start: 1, preview: 1.5, end: 2 });
});

test('timeline: rangeBand positions the highlighted clip region', () => {
  assert.deepEqual(timeline.rangeBand(1, 3, 5, BAR), { x: 20, w: 40 });
  assert.deepEqual(timeline.rangeBand(0, 5, 5, BAR), { x: 0, w: 100 });
});

test('timeline: rangeBand of a degenerate range is empty but in-bounds', () => {
  const band = timeline.rangeBand(3, 3, 5, BAR);
  assert.equal(band.x, 60);
  assert.equal(band.w, 0);
});
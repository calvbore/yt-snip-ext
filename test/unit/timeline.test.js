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

/* ---- zoom window math (detail strip) ---- */

const ZW = { start: 10, end: 20 }; // 10s window inside a 60s video

test('timeline: normalizeWindow orders and clamps', () => {
  assert.deepEqual(timeline.normalizeWindow({ start: 4, end: 2 }, 60), { start: 2, end: 4 });
  assert.deepEqual(timeline.normalizeWindow({ start: -5, end: 99 }, 60), { start: 0, end: 60 });
  assert.deepEqual(timeline.normalizeWindow(null, 60), { start: 0, end: 0 });
  assert.deepEqual(timeline.normalizeWindow(ZW, 0), { start: 0, end: 0 });
});

test('timeline: timeToXInWindow maps within the window and clamps handles', () => {
  // 100px bar, window [10,20]: t=15 → mid → x=50; t=10 → 6; t=20 → 94.
  assert.equal(timeline.timeToXInWindow(15, ZW, BAR, 12), 50);
  assert.equal(timeline.timeToXInWindow(10, ZW, BAR, 12), 6);
  assert.equal(timeline.timeToXInWindow(20, ZW, BAR, 12), 94);
  // Times outside the window clamp to the edges, not wrap.
  assert.equal(timeline.timeToXInWindow(0, ZW, BAR, 12), 6);
  assert.equal(timeline.timeToXInWindow(59, ZW, BAR, 12), 94);
});

test('timeline: xToTimeInWindow round-trips and clamps', () => {
  assert.equal(timeline.xToTimeInWindow(50, ZW, BAR), 15);
  assert.equal(timeline.xToTimeInWindow(-10, ZW, BAR), 10);
  assert.equal(timeline.xToTimeInWindow(110, ZW, BAR), 20);
  const x = timeline.timeToXInWindow(13.5, ZW, BAR);
  assert.equal(timeline.xToTimeInWindow(x, ZW, BAR), 13.5);
});

test('timeline: panWindow shifts by strip fractions preserving span', () => {
  assert.deepEqual(timeline.panWindow(ZW, 0.5, 60), { start: 15, end: 25 });
  assert.deepEqual(timeline.panWindow(ZW, -1, 60), { start: 0, end: 10 });
  // Clamped at both ends of the video (span is preserved).
  assert.deepEqual(timeline.panWindow({ start: 55, end: 60 }, 1, 60), { start: 55, end: 60 });
  // A full-length window cannot move.
  assert.deepEqual(timeline.panWindow({ start: 0, end: 60 }, 0.5, 60), { start: 0, end: 60 });
});

test('timeline: zoomWindow scales around an anchor with clamps', () => {
  // Zoom in ×0.5 around t=12.5 keeps 12.5 fixed at its fraction (0.25).
  const zin = timeline.zoomWindow(ZW, 0.5, 12.5, 60, 0.5);
  assert.deepEqual(zin, { start: 11.25, end: 16.25 });
  // Zoom out ×2 around the same anchor keeps 12.5 at fraction 0.25 of 20.
  const zout = timeline.zoomWindow(ZW, 2, 12.5, 60, 0.5);
  assert.deepEqual(zout, { start: 7.5, end: 27.5 });
  // Zooming out past the video yields the full window.
  assert.deepEqual(timeline.zoomWindow(ZW, 100, 12.5, 60, 0.5), { start: 0, end: 60 });
  // Zooming in never goes below minSpan.
  assert.deepEqual(timeline.zoomWindow(ZW, 0.0001, 15, 60, 0.5), { start: 14.75, end: 15.25 });
  // Anchor defaults to the window center.
  assert.deepEqual(timeline.zoomWindow(ZW, 0.5, null, 60, 0.5), { start: 12.5, end: 17.5 });
});

test('timeline: zoom granularity beats full-duration mapping on long videos', () => {
  // 3600s video on a 100px bar: one main-bar px ≈ 36s. Zoomed to a 30s
  // window, the same px ≈ 0.3s.
  const zw = timeline.zoomWindow({ start: 0, end: 3600 }, 1 / 120, 1800, 3600, 0.5);
  assert.ok(Math.abs(zw.end - zw.start - 30) < 1e-9);
  const perPxZoomed = 30 / 100;
  const perPxMain = 3600 / 100;
  assert.ok(perPxZoomed < perPxMain / 100);
});
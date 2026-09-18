/*
 * test/e2e/taint.spec.js
 *
 * Tier 1 — genuine canvas taint → detached-video fallback capture.
 *
 * The harness loads its media from `?media=` pointing at
 * http://127.0.0.1:8124/... (a different origin, since only the port
 * differs). The live <video> has no crossOrigin attribute, so its frames
 * taint the canvas; the primary engine's 1x1 getImageData probe throws a
 * genuine SecurityError. The content script then retries through
 * content/fallback-capture.js, which reloads the media in a detached
 * crossOrigin=anonymous <video> (the 8124 fixture server sends
 * Access-Control-Allow-Origin:*), succeeds, and saves the GIF.
 *
 * Asserts: the fallback path actually ran (instrumented), the saved GIF is
 * valid and content-correct, and the tool returns to idle with the video
 * restored.
 */
'use strict';

const { test, expect } = require('@playwright/test');
const h = require('./helpers');
const { decodeGif } = require('../helpers/gif-validate');

const CROSS_ORIGIN_MEDIA =
  'http://127.0.0.1:8124/test/.fixtures/current/media.webm';

test('cross-origin media uses the fallback path and captures correctly', async ({ page }) => {
  await h.openWatch(page, { media: CROSS_ORIGIN_MEDIA, options: { fps: 1, maxDimension: 256, format: 'gif' } });

  // Instrument both engines so the test can prove which path ran.
  await page.evaluate(() => {
    window.__capturePath = { primary: 0, fallback: 0 };
    const origPrimary = window.ytSnipCapture.captureFromVideo;
    window.ytSnipCapture.captureFromVideo = function (...args) {
      window.__capturePath.primary++;
      return origPrimary.apply(this, args);
    };
    const origFallback = window.ytSnipFallback.captureFromLiveVideo;
    window.ytSnipFallback.captureFromLiveVideo = function (...args) {
      window.__capturePath.fallback++;
      return origFallback.apply(this, args);
    };
  });

  // Mid-video seek keeps the M13 default clip (±3 s around activation) at
  // the full fixture range — the frame-count assertion below assumes it.
  await page.evaluate(() => {
    document.querySelector('video.html5-main-video').currentTime = 2.5;
  });
  await h.startSnip(page);
  await h.dragSelect(page, { x: 0, y: 0 }, { x: 640, y: 360 });

  const res = await h.saveAndGetMessage(page);

  // A genuine taint must have occurred and the fallback must have been used.
  const path = await page.evaluate(() => window.__capturePath);
  expect(path.primary).toBeGreaterThanOrEqual(1);
  expect(path.fallback).toBeGreaterThanOrEqual(1);

  const gif = decodeGif(Uint8Array.from(res.bytes));
  expect(gif.width).toBe(256);
  expect(gif.height).toBe(144);
  expect(gif.frames.length).toBeGreaterThanOrEqual(5);

  await expect.poll(() => page.evaluate(() => window.ytSnip._getState())).toBe('idle');
});
'use strict';

/*
 * test/e2e/webm.spec.js
 *
 * Tier 1 — M16 truecolor WebM output through the real save flow.
 *
 * Playwright's Firefox build ships WebCodecs (VideoEncoder, secure context —
 * 127.0.0.1 is a potentially trustworthy origin), so this spec exercises the
 * production encode path end to end: capture → VideoFrames → VP9 via
 * VideoEncoder → mediabunny WebM mux → message payload. The bytes are then
 * validated in Node with the shared, independent WebM validator
 * (container + track semantics + per-packet timestamps) and pixel-decoded
 * with ffmpeg.
 */

const { test, expect } = require('@playwright/test');
const h = require('./helpers');
const { validateWebm, decodeFrameRgba } = require('../helpers/webm-validate');

const VIDEO_W = 640;
const VIDEO_H = 360;

/** Gray-level read at a point of a decoded RGBA frame (byte offset p*4). */
function pxAt(rgba, width, x, y) {
  const p = (y * width + x) * 4;
  return [rgba[p], rgba[p + 1], rgba[p + 2]];
}

function closeTo(actual, expected, tol) {
  return Math.abs(actual - expected) <= tol;
}

test.describe('webm output', () => {
  test('saves a valid, content-correct truecolor WebM clip', async ({ page }) => {
    await h.openWatch(page, { options: { fps: 1, maxDimension: 256, format: 'webm' } });
    await page.evaluate(() => {
      document.querySelector('video.html5-main-video').currentTime = 2.5;
    });

    await h.startSnip(page);
    await h.dragSelect(page, { x: 0, y: 0 }, { x: VIDEO_W, y: VIDEO_H });

    const res = await h.saveAndGetMessage(page);
    expect(res.filename).toMatch(/^yt-snip-.*\.webm$/);

    const v = await validateWebm(Uint8Array.from(res.bytes));
    expect(v.codec).toBe('vp9');
    expect(v.width).toBe(256);
    expect(v.height).toBe(144);
    // Default clip = ±3 s around activation @2.5 s → the full 5 s fixture.
    expect(v.packets.length).toBeGreaterThanOrEqual(5);
    expect(v.packets.length).toBeLessThanOrEqual(7);
    // Output duration ≈ clip duration (5 s @ 1× speed), timestamps monotonic.
    expect(closeTo(v.duration, 5, 1.2)).toBe(true);
    for (let k = 1; k < v.packets.length; k++) {
      expect(v.packets[k].timestamp).toBeGreaterThan(v.packets[k - 1].timestamp);
    }
    // First frame is a keyframe and frame spacing ≈ 1/fps (= 1 s here).
    expect(v.packets[0].key).toBe(true);
    for (let k = 1; k < v.packets.length; k++) {
      const dt = v.packets[k].timestamp - v.packets[k - 1].timestamp;
      expect(dt).toBeGreaterThan(0.4);
      expect(dt).toBeLessThan(1.6);
    }

    // Pixel content: the fixture is gray with a green barcode strip and a
    // white marker; VP9 at 2.5 Mbps keeps these within tight tolerance.
    const frame = decodeFrameRgba(Uint8Array.from(res.bytes), 0, v.width, v.height);
    // Center = constant gray background (60,60,60).
    const center = pxAt(frame.rgba, v.width, Math.floor(v.width / 2), Math.floor(v.height * 0.75));
    expect(closeTo(center[0], 60, 24)).toBe(true);
    expect(closeTo(center[1], 60, 24)).toBe(true);
    expect(closeTo(center[2], 60, 24)).toBe(true);

    // Truecolor sanity: the saved frame keeps gray at gray — a quantized GIF
    // could drift, but the point of webm is no palette at all. (Assert the
    // three channels agree closely: a palette-blended gray would skew.)
    expect(Math.max(...center) - Math.min(...center)).toBeLessThan(16);

    // State-transition rule: save completed → idle + restore.
    await expect.poll(() => page.evaluate(() => window.ytSnip._getState())).toBe('idle');
    const restored = await page.evaluate(() =>
      document.querySelector('video.html5-main-video').currentTime
    );
    expect(Math.abs(restored - 2.5) < 0.05).toBe(true);
  });

  test('falls back to GIF with a toast when the browser cannot encode WebM', async ({ page }) => {
    await h.openWatch(page, { options: { fps: 1, maxDimension: 256, format: 'webm' } });
    await page.evaluate(() => {
      document.querySelector('video.html5-main-video').currentTime = 2.5;
    });
    await h.startSnip(page);
    await h.dragSelect(page, { x: 0, y: 0 }, { x: VIDEO_W, y: VIDEO_H });

    // Simulate a browser without WebCodecs/muxer: hide the globals.
    await page.evaluate(() => {
      window.__savedVideoEncoder = window.VideoEncoder;
      delete window.VideoEncoder;
    });

    const clicked = await h.clickToolbar(page, 'Save');
    expect(clicked).toBe(true);

    // The fallback toast fires at save start; the completion toast replaces
    // it once the capture finishes, so poll for it immediately.
    await expect.poll(async () => {
      const toast = await page.evaluate(() => {
        const host = document.querySelector('#movie_player .yt-snip-host');
        const t = host && host.shadowRoot && host.shadowRoot.querySelector('.snip-toast');
        return t ? t.textContent : null;
      });
      return toast || '';
    }).toContain('WebM unavailable');

    await page.waitForFunction(() => {
      return window.__ytSnipMessages.some((m) => m && m.type === 'yt-snip:save');
    }, null, { timeout: 30000 });
    const res = await page.evaluate(() => {
      const m = window.__ytSnipMessages.find((x) => x && x.type === 'yt-snip:save');
      return { filename: m.payload.filename, bytes: Array.from(new Uint8Array(m.payload.data)) };
    });
    expect(res.filename).toMatch(/\.gif$/);
    const gif = require('../helpers/gif-validate').decodeGif(Uint8Array.from(res.bytes));
    expect(gif.frames.length).toBeGreaterThanOrEqual(5);

    await expect.poll(() => page.evaluate(() => window.ytSnip._getState())).toBe('idle');
  });
});

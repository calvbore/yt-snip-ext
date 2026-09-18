/*
 * test/e2e/capture.spec.js
 *
 * Tier 1 — end-to-end capture correctness on headless Firefox.
 *
 * Drives the real content scripts against the synthesized, time-coded fixture
 * (640x360, 5s, all-keyframe), saves through the real save flow, then decodes
 * the transmitted GIF with the independent test-tier decoder
 * (test/helpers/gif-validate.js) and asserts:
 *
 *   - output dimensions honor the Anki constraint (crop aspect + maxDimension)
 *   - frame count + per-frame delay match the requested fps
 *   - frame content/order match the clip window: the barcode-derived media
 *     time and the marker-sweep position agree per frame and increase with time
 *   - the crop region matches the snipped rectangle (content enters/leaves as
 *     the marker sweeps across the crop boundary)
 *   - the clip carries the NETSCAPE loop extension (infinite playback in Anki)
 *   - after save the tool returns to idle with the video restored
 *     (state-transition rule)
 */
'use strict';

const { test, expect } = require('@playwright/test');
const h = require('./helpers');
const { decodeGif } = require('../helpers/gif-validate');

const VIDEO_W = 640;
const VIDEO_H = 360;
const DURATION = 5; // synthesized fixture duration, seconds

/**
 * Decode the time-barcode from a decoded frame. The output bitmap is a scaled
 * rendering of the CROP rect (in video pixels), so each full-video slot center
 * maps to an output column only when it falls inside the crop:
 *   outX = (slotCenterX - crop.x) * (outW / crop.w)
 */
function barcodeLevel(frame, outW, crop, barcodeY) {
  const { rgba } = frame;
  let level = 0;
  for (let i = 0; i < 8; i++) {
    const srcX = 80 * i + 40; // full-video barcode slot center
    const outX = (srcX - crop.x) * (outW / crop.w);
    if (outX < 0 || outX >= outW) continue; // slot not inside the crop
    const p = (barcodeY * outW + Math.round(outX)) * 4;
    const r = rgba[p], g = rgba[p + 1], b = rgba[p + 2];
    if (g >= 100 && r < 120 && b < 120) level |= (1 << i);
  }
  return level;
}

/**
 * Leftmost bright column of the marker in the decoded frame, or -1 when the
 * marker is outside the crop region entirely.
 */
function markerOutX(frame, outW, markerY) {
  const { rgba } = frame;
  for (let x = 0; x < outW; x++) {
    const p = (markerY * outW + x) * 4;
    if (rgba[p] > 150 && rgba[p + 1] > 150 && rgba[p + 2] > 150) return x;
  }
  return -1;
}

/** Media time implied by a marker's source-x position (full-video sweep). */
function mediaOfMarker(srcX) {
  return (srcX / (VIDEO_W - 48)) * DURATION;
}

/** Expected media-implied level for a time. */
function levelAt(media) {
  return Math.round(Math.min(1, Math.max(0, media / DURATION)) * 255);
}

/** Expected marker left edge (source px) for a media time. */
function expectedMarkerSourceX(media) {
  const frac = Math.min(1, Math.max(0, media / DURATION));
  return Math.round(frac * (VIDEO_W - 48));
}

test.describe('full-frame capture', () => {
  test('saves a valid, correctly-timed GIF with restored state', async ({ page }) => {
    await h.openWatch(page, { options: { fps: 1, maxDimension: 256, format: 'gif' } });
    // Seek mid-video so the M13 default clip (±3 s around activation,
    // clamped) still covers the full fixture — the frame-count and barcode
    // math below assume the whole 5 s range.
    await page.evaluate(async () => {
      document.querySelector('video.html5-main-video').currentTime = 2.5;
    });

    await h.startSnip(page);
    await h.dragSelect(page, { x: 0, y: 0 }, { x: VIDEO_W, y: VIDEO_H });

    const res = await h.saveAndGetMessage(page);
    expect(res.filename).toMatch(/^yt-snip-.*\.gif$/);
    expect(res.saveAs).toBe(false);

    const gif = decodeGif(Uint8Array.from(res.bytes));
    expect(gif.width).toBe(256);
    expect(gif.height).toBe(144);
    expect(gif.frames.length).toBeGreaterThanOrEqual(5);
    expect(gif.frames.length).toBeLessThanOrEqual(7);
    for (const f of gif.frames) {
      expect(f.delayMs).toBe(1000); // 1000ms/frame @ fps=1
    }

    // NETSCAPE looping extension present (Anki infinite loop).
    const buf = Buffer.from(res.bytes);
    expect(buf.includes(Buffer.from('NETSCAPE2.0'))).toBe(true);

    // Content + order: barcode-derived media time and marker position agree,
    // and both strictly increase across the clip.
    const crop = { x: 0, y: 0, w: VIDEO_W, h: VIDEO_H };
    const levels = gif.frames.map((f) => barcodeLevel(f, 256, crop, 1));
    const frames = gif.frames.map((f) => ({
      media: (levels[gif.frames.indexOf(f)] / 255) * DURATION,
      markerLeft: markerOutX(f, 256, 12),
    }));
    for (let k = 1; k < frames.length; k++) {
      expect(frames[k].media).toBeGreaterThan(frames[k - 1].media);
    }
    for (let k = 0; k < frames.length; k++) {
      const expectedX = expectedMarkerSourceX(frames[k].media) * (256 / VIDEO_W);
      expect(frames[k].markerLeft).toBeGreaterThanOrEqual(0);
      expect(Math.abs(frames[k].markerLeft - expectedX)).toBeLessThanOrEqual(8);
    }

    // State-transition rule: save completed, tool returned to idle, video
    // restored to its pre-activation time.
    await expect.poll(() => page.evaluate(() => window.ytSnip._getState())).toBe('idle');
    const restored = await page.evaluate(() => document.querySelector('video.html5-main-video').currentTime);
    expect(Math.abs(restored - 2.5) < 0.05).toBe(true);
  });
});

test.describe('crop region capture', () => {
  test('GIF content matches only the snipped rectangle', async ({ page }) => {
    // Snip the top-left quadrant: x 0..320, y 0..90 (source px).
    await h.openWatch(page, { options: { fps: 1, maxDimension: 512, format: 'gif' } });
    // Mid-video seek keeps the M13 default clip at the full fixture range
    // (the marker-sweep assertions below assume it).
    await page.evaluate(() => {
      document.querySelector('video.html5-main-video').currentTime = 2.5;
    });
    await h.startSnip(page);
    await h.dragSelect(page, { x: 0, y: 0 }, { x: 320, y: 90 });

    const sel = await h.getSelection(page);
    expect(Math.abs(sel.x) < 0.01).toBe(true);
    expect(Math.abs(sel.y) < 0.01).toBe(true);
    expect(Math.abs(sel.w - 0.5) < 0.01).toBe(true);
    expect(Math.abs(sel.h - 0.25) < 0.01).toBe(true);

    const res = await h.saveAndGetMessage(page);
    const gif = decodeGif(Uint8Array.from(res.bytes));

    // Output: 320x90 scaled by maxDimension on the long edge (320 < 512 → 1:1).
    expect(gif.width).toBe(320);
    expect(gif.height).toBe(90);
    expect(gif.frames.length).toBeGreaterThanOrEqual(5);
    for (const f of gif.frames) expect(f.delayMs).toBe(1000);

    // The crop covers the top-left quadrant: crop rect = {0,0,320,90}, out
    // maps 1:1. Only barcode slots 0..3 exist inside it.
    const crop = { x: 0, y: 0, w: 320, h: 90 };
    for (const frame of gif.frames) {
      const level = barcodeLevel(frame, 320, crop, 2);
      expect(level & 0xf0).toBe(0); // slots 4..7 are outside the crop → never green
      // Marker gives an independent time read; verify media order via marker
      // position and cross-check the barcode low bits against it.
      const mx = markerOutX(frame, 320, 30);
      if (mx >= 0) {
        const srcLeft = crop.x + mx; // 1:1 crop mapping
        const media = mediaOfMarker(srcLeft);
        expect((level & 0x0f) === (levelAt(media) & 0x0f)).toBe(true);
      }
    }
    // Marker sweep crosses the crop's right edge (x=320). While the marker is
    // inside the crop, white pixels must be present; frames at later times
    // (marker swept past the right edge) must be entirely marker-free.
    const mxList = gif.frames.map((f) => markerOutX(f, 320, 30));
    const present = mxList.filter((x) => x >= 0);
    expect(present.length).toBeGreaterThanOrEqual(2);
    for (let k = 1; k < present.length; k++) {
      expect(present[k]).toBeGreaterThan(present[k - 1]); // swept rightward
    }
    // Monotone transition out of the crop: once absent, stay absent.
    let seenAbsent = false;
    for (const mx of mxList) {
      if (mx < 0) seenAbsent = true;
      else expect(seenAbsent).toBe(false);
    }
  });
});

test.describe('fail-fast hardening', () => {
  /** Read the current toast text from the shadow root (null when cleared). */
  async function toastText(page) {
    return page.evaluate(() => {
      const host = document.querySelector('#movie_player .yt-snip-host');
      if (!host || !host.shadowRoot) return null;
      const t = host.shadowRoot.querySelector('.snip-toast');
      return t ? t.textContent : null;
    });
  }

  async function hasSaveMessage(page) {
    return page.evaluate(() =>
      window.__ytSnipMessages.some((m) => m && m.type === 'yt-snip:save')
    );
  }

  test('A1 refuses to save while an ad is showing (upfront guard)', async ({ page }) => {
    await h.openWatch(page, { options: { fps: 1, format: 'gif' } });
    await h.startSnip(page);
    await h.dragSelect(page, { x: 40, y: 40 }, { x: 400, y: 200 });

    // YouTube marks an active ad via the `.ad-showing` class on #movie_player.
    await page.evaluate(() => {
      document.querySelector('#movie_player').classList.add('ad-showing');
    });

    const clicked = await h.clickToolbar(page, 'Save');
    expect(clicked).toBe(true);

    // Stays engaged — the save never entered the state machine — and no save
    // message was sent to the background.
    expect(await page.evaluate(() => window.ytSnip._getState())).toBe('engaged');
    expect(await hasSaveMessage(page)).toBe(false);
    expect(await toastText(page)).toContain('Ads');

    await page.evaluate(() => {
      document.querySelector('#movie_player').classList.remove('ad-showing');
    });
  });

  test('A1 aborts a running capture when an ad starts (frame loop)', async ({ page }) => {
    await h.openWatch(page, { options: { fps: 12, format: 'gif' } });
    await h.startSnip(page);
    await h.dragSelect(page, { x: 40, y: 40 }, { x: 400, y: 200 });

    // Click Save, then drop the ad class immediately afterwards (same tick),
    // so the save launches but the rAF frame loop catches the ad next frame.
    const clicked = await page.evaluate(() => {
      const host = document.querySelector('#movie_player .yt-snip-host');
      const saveBtn = Array.from(host.shadowRoot.querySelectorAll('.snip-toolbar button'))
        .find((b) => (b.textContent || '').includes('Save'));
      if (!saveBtn) return false;
      saveBtn.click();
      document.querySelector('#movie_player').classList.add('ad-showing');
      return true;
    });
    expect(clicked).toBe(true);

    await expect.poll(() => page.evaluate(() => window.ytSnip._getState())).toBe('idle');
    expect(await hasSaveMessage(page)).toBe(false);
    expect(await toastText(page)).toContain('Ads');

    await page.evaluate(() => {
      document.querySelector('#movie_player').classList.remove('ad-showing');
    });
  });

  test('A2 fails fast with a toast when the video is emptied mid-capture', async ({ page }) => {
    await h.openWatch(page, { options: { fps: 12, format: 'gif' } });
    await h.startSnip(page);
    await h.dragSelect(page, { x: 40, y: 40 }, { x: 400, y: 200 });

    await h.clickToolbar(page, 'Save');

    // Wait until a frame has actually rendered (capture source is alive and a
    // waiter is pending), then replace the media — the engine must fail fast
    // with { code: 'no-video' } instead of hanging at 0%.
    await page.waitForFunction(() => {
      const host = document.querySelector('#movie_player .yt-snip-host');
      if (!host || !host.shadowRoot) return false;
      const fill = host.shadowRoot.querySelector('.snip-capture .fill');
      return fill && parseFloat(fill.style.width) > 0;
    }, null, { timeout: 15000 });

    await page.evaluate(() => {
      const v = document.querySelector('video.html5-main-video');
      v.dispatchEvent(new Event('emptied'));
    });

    await expect.poll(() => page.evaluate(() => window.ytSnip._getState())).toBe('idle');
    expect(await hasSaveMessage(page)).toBe(false);
    expect(await toastText(page)).toContain('interrupted');
  });
});

test.describe('save-flow failure handling', () => {
  /** Read the current toast text from the shadow root (null when cleared). */
  async function toastText(page) {
    return page.evaluate(() => {
      const host = document.querySelector('#movie_player .yt-snip-host');
      if (!host || !host.shadowRoot) return null;
      const t = host.shadowRoot.querySelector('.snip-toast');
      return t ? t.textContent : null;
    });
  }

  async function hasSaveMessage(page) {
    return page.evaluate(() =>
      window.__ytSnipMessages.some((m) => m && m.type === 'yt-snip:save')
    );
  }

  // M9: the background answers failures as resolved `{ ok: false, error }`, and
  // messaging.request() turns those into a rejection — the pre-M9 code let the
  // rejection fall into the generic capture-error catch, so the "Save failed"
  // toast was dead code. These tests pin the normalized outcome to its path:
  // failure toast (not "Capture failed:"), clean disengage, video restored.
  test('M9 surfaces a background save error and restores the video', async ({ page }) => {
    await h.openWatch(page, { options: { fps: 1, maxDimension: 256, format: 'gif' } });
    await page.evaluate(async () => {
      document.querySelector('video.html5-main-video').currentTime = 1.5;
    });
    await h.startSnip(page);
    await h.dragSelect(page, { x: 40, y: 40 }, { x: 400, y: 200 });

    await page.evaluate(() => {
      window.__ytSnipSaveResponse = { ok: false, error: 'background: boom' };
    });
    const clicked = await h.clickToolbar(page, 'Save');
    expect(clicked).toBe(true);

    await expect.poll(() => page.evaluate(() => window.ytSnip._getState())).toBe('idle');
    expect(await hasSaveMessage(page)).toBe(true);
    expect(await toastText(page)).toContain('Save failed: background: boom');
    const restored = await page.evaluate(() => document.querySelector('video.html5-main-video').currentTime);
    expect(Math.abs(restored - 1.5) < 0.05).toBe(true);
  });

  test('M9 restores cleanly when the save request itself rejects', async ({ page }) => {
    await h.openWatch(page, { options: { fps: 1, maxDimension: 256, format: 'gif' } });
    await page.evaluate(async () => {
      document.querySelector('video.html5-main-video').currentTime = 1.5;
    });
    await h.startSnip(page);
    await h.dragSelect(page, { x: 40, y: 40 }, { x: 400, y: 200 });

    // Simulate the background hard-failing (listener gone / runtime error);
    // messaging.request wraps the value, and the save flow must still map it
    // into the save-failed path instead of the generic capture-error catch.
    await page.evaluate(() => {
      window.__ytSnipSaveResponse = new Error('yt-snip: background: went away');
    });
    const clicked = await h.clickToolbar(page, 'Save');
    expect(clicked).toBe(true);

    await expect.poll(() => page.evaluate(() => window.ytSnip._getState())).toBe('idle');
    expect(await hasSaveMessage(page)).toBe(true);
    expect(await toastText(page)).toContain('Save failed: background: went away');
    const restored = await page.evaluate(() => document.querySelector('video.html5-main-video').currentTime);
    expect(Math.abs(restored - 1.5) < 0.05).toBe(true);
  });
});
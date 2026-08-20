/*
 * test/e2e/ui.spec.js  — Tier 1: injection, overlay, snip/resize, timeline,
 * loop playback, and a single disengage-restore wiring smoke.
 *
 * Deep behavioral coverage of the state-restore matrix lives in Tier 0
 * (test/unit/state.test.js); here we smoke the wiring once.
 */
'use strict';

const { test, expect } = require('@playwright/test');
const h = require('./helpers');

test.describe('watch-page injection', () => {
  test.beforeEach(async ({ page }) => {
    await h.openWatch(page);
  });

  test('injects the snip trigger into the right chrome controls', async ({ page }) => {
    const btn = page.locator('#movie_player .ytp-right-controls button.yt-snip-trigger');
    await expect(btn).toBeVisible();
  });

  test('creates the shadow-DOM host', async ({ page }) => {
    const hostCount = await page.evaluate(() =>
      document.querySelectorAll('#movie_player .yt-snip-host').length
    );
    expect(hostCount).toBe(1);
    const shadowOk = await page.evaluate(() => {
      const host = document.querySelector('#movie_player .yt-snip-host');
      return !!(host && host.shadowRoot && host.shadowRoot.querySelector('.snip-overlay'));
    });
    expect(shadowOk).toBe(true);
  });

  test('re-injects the trigger after the chrome controls are rebuilt (SPA nav)', async ({ page }) => {
    await page.evaluate(() => {
      const controls = document.querySelector('#movie_player .ytp-right-controls');
      controls.innerHTML = '';
    });
    await expect(page.locator('#movie_player .ytp-right-controls button.yt-snip-trigger'))
      .toBeVisible({ timeout: 5000 });
  });
});

test.describe('snip overlay and rectangle', () => {
  test.beforeEach(async ({ page }) => {
    await h.openWatch(page);
  });

  test('activating shows the overlay + hint; Esc cancels and restores', async ({ page }) => {
    const video = page.locator('video.html5-main-video');
    await video.evaluate((v) => { v.currentTime = 2; });

    await h.startSnip(page);

    const state = await page.evaluate(() => window.ytSnip._getState());
    expect(state).toBe('activating');
    const hintDisplay = await h.shadowRect(page, '.snip-hint');
    expect(hintDisplay.display).toBe('block');

    await page.keyboard.press('Escape');
    await expect.poll(() => page.evaluate(() => window.ytSnip._getState())).toBe('idle');
    const restored = await video.evaluate((v) => v.currentTime);
    expect(Math.abs(restored - 2) < 0.01).toBe(true);
  });

  test('drag selects a normalized region and engages', async ({ page }) => {
    await h.startSnip(page);
    const vr = await h.dragSelect(page, { x: 50, y: 40 }, { x: 420, y: 200 });
    expect(vr.width).toBeGreaterThan(0);

    const sel = await h.getSelection(page);
    expect(sel).toBeTruthy();
    expect(sel.w).toBeGreaterThan(0.4);
    expect(sel.h).toBeGreaterThan(0.3);
    expect(sel.x).toBeCloseTo(50 / vr.width, 1);
    expect(sel.y).toBeCloseTo(40 / vr.height, 1);
  });

  test('resize handles grow the rectangle in engaged state', async ({ page }) => {
    await h.startSnip(page);
    await h.dragSelect(page, { x: 40, y: 40 }, { x: 200, y: 120 });
    const before = await h.getSelection(page);

    // Grab the south-east handle and pull it further out.
    const box = await h.shadowRect(page, '.snip-rect');
    const se = await page.evaluate((b) => {
      const host = document.querySelector('#movie_player .yt-snip-host');
      const rectEl = host.shadowRoot.querySelector('.snip-rect');
      const handle = rectEl.querySelector('.snip-handle[data-dir="se"]');
      const r = handle.getBoundingClientRect();
      return { x: r.left + b.left, y: r.top + b.top };
    }, { left: 0, top: 0 });
    const vr = await page.evaluate(() => {
      const r = document.querySelector('video.html5-main-video').getBoundingClientRect();
      return { left: r.left, top: r.top, width: r.width, height: r.height };
    });
    await h.mouseDrag(page, se.x, se.y, vr.left + 500, vr.top + 280);

    const after = await h.getSelection(page);
    expect(after.w).toBeGreaterThan(before.w);
    expect(after.h).toBeGreaterThan(before.h);
  });
});

test.describe('timeline handles and loop', () => {
  test.beforeEach(async ({ page }) => {
    await h.openWatch(page);
    // Position the preview away from the start/end handles (which overlap it
    // at t=0 and t=duration) so the drag targets a unique handle.
    await page.evaluate(() => {
      document.querySelector('video.html5-main-video').currentTime = 2;
    });
    await h.startSnip(page);
    await h.dragSelect(page, { x: 30, y: 30 }, { x: 400, y: 180 });
  });

  test('engaged shows the three timeline handles + range band', async ({ page }) => {
    const tl = await h.shadowRect(page, '.snip-timeline');
    expect(tl.display).toBe('block');
    for (const role of ['start', 'preview', 'end']) {
      const handle = await page.evaluate((r) => {
        const host = document.querySelector('#movie_player .yt-snip-host');
        const el = host.shadowRoot.querySelector('.snip-tl-handle[data-role="' + r + '"]');
        if (!el) return null;
        const cs = getComputedStyle(el);
        return { display: cs.display };
      }, role);
      expect(handle.display).toBe('block');
    }
    const bandVisible = await page.evaluate(() => {
      const host = document.querySelector('#movie_player .yt-snip-host');
      const band = host.shadowRoot.querySelector('.snip-tl-band');
      return getComputedStyle(band).display === 'block' && parseFloat(band.style.width) > 0;
    });
    expect(bandVisible).toBe(true);
  });

  test('dragging the preview timeline handle seeks the video', async ({ page }) => {
    // Drag the preview handle to ~80% of the bar.
    await h.dragTimelineHandle(page, 'preview', 0.8);

    const clip = await h.getClip(page);
    const duration = await page.evaluate(() => document.querySelector('video.html5-main-video').duration);
    expect(clip.preview).toBeGreaterThan(0);
    expect(Math.abs(clip.preview - 0.8 * duration)).toBeLessThan(duration * 0.08);
    // Preview drags drive the video: currentTime follows the handle.
    const t = await page.evaluate(() => document.querySelector('video.html5-main-video').currentTime);
    expect(Math.abs(t - clip.preview)).toBeLessThan(duration * 0.08);
  });

  test('loop button toggles looping playback of the clip', async ({ page }) => {
    const clicked = await h.clickToolbar(page, 'Loop');
    expect(clicked).toBe(true);
    expect(await page.evaluate(() => window.ytSnip._isLooping())).toBe(true);

    // Ensure the video is actually playing (muted so autoplay is allowed) so
    // the rAF loop guard has a chance to rewind it to the clip start.
    await page.evaluate(async () => {
      const v = document.querySelector('video.html5-main-video');
      v.muted = true;
      await v.play().catch(() => {});
    });
    await expect.poll(() => page.evaluate(() =>
      !document.querySelector('video.html5-main-video').paused)).toBe(true);

    const clip = await h.getClip(page);
    await page.evaluate(() => {
      document.querySelector('video.html5-main-video').currentTime = 5 - 0.01;
    });

    // The loop guard must snap playback back to the clip start.
    const start = clip.start;
    await expect.poll(() => page.evaluate((s) => {
      const v = document.querySelector('video.html5-main-video');
      return Math.abs(v.currentTime - s) < 0.3;
    }, start), { timeout: 3000, intervals: [50, 50, 50] }).toBe(true);
  });
});
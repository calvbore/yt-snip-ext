/*
 * test/e2e/rect.spec.js — Tier 1 coverage for the M12 fixes:
 *
 *   - all 8 resize handles sit centered on the selection's visual border
 *     (the old border-box/padding-box mismatch put e/s/se… handles outside)
 *   - grabbing the rect body moves the whole selection as a unit
 *   - start/end handle drags scrub frames (playhead parks at the edge)
 *   - a paused video stays paused through every interaction (nothing may
 *     start playback on its own)
 *   - loopOnPlay=false gates auto-loop; the Loop button still works
 */
'use strict';

const { test, expect } = require('@playwright/test');

const h = require('./helpers');

async function engage(page, opts) {
  await h.openWatch(page, { options: opts });
  await h.startSnip(page);
  await h.dragSelect(page, { x: 60, y: 40 }, { x: 380, y: 200 });
}

test.describe('M12 rect interaction', () => {
  test('all 8 handles are centered on the selection border', async ({ page }) => {
    await engage(page);
    const data = await page.evaluate(() => {
      const host = document.querySelector('#movie_player .yt-snip-host');
      const rectEl = host.shadowRoot.querySelector('.snip-rect');
      const r = rectEl.getBoundingClientRect();
      const dirs = ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw'];
      const centers = {};
      for (const dir of dirs) {
        const b = rectEl.querySelector('.snip-handle[data-dir="' + dir + '"]').getBoundingClientRect();
        centers[dir] = { x: b.left + b.width / 2, y: b.top + b.height / 2 };
      }
      return { r, centers };
    });
    const expected = {
      n: [data.r.left + data.r.width / 2, data.r.top],
      ne: [data.r.left + data.r.width, data.r.top],
      e: [data.r.left + data.r.width, data.r.top + data.r.height / 2],
      se: [data.r.left + data.r.width, data.r.top + data.r.height],
      s: [data.r.left + data.r.width / 2, data.r.top + data.r.height],
      sw: [data.r.left, data.r.top + data.r.height],
      w: [data.r.left, data.r.top + data.r.height / 2],
      nw: [data.r.left, data.r.top],
    };
    for (const dir of Object.keys(expected)) {
      expect(Math.abs(data.centers[dir].x - expected[dir][0])).toBeLessThan(1.5);
      expect(Math.abs(data.centers[dir].y - expected[dir][1])).toBeLessThan(1.5);
    }
  });

  test('dragging the rect body moves the selection as a unit', async ({ page }) => {
    await engage(page);
    const before = await h.getSelection(page);

    // Grab the rect center (no handles there) and move it right+down.
    const c = await page.evaluate(() => {
      const host = document.querySelector('#movie_player .yt-snip-host');
      const r = host.shadowRoot.querySelector('.snip-rect').getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    });
    await h.mouseDrag(page, c.x, c.y, c.x + 120, c.y + 60);

    const moved = await h.getSelection(page);
    expect(moved.w).toBeCloseTo(before.w, 6);
    expect(moved.h).toBeCloseTo(before.h, 6);
    expect(moved.x).toBeGreaterThan(before.x);
    expect(moved.y).toBeGreaterThan(before.y);
    expect(await page.evaluate(() => window.ytSnip._getState())).toBe('engaged');

    // Drag far past the bottom-right corner: the selection pins inside the
    // letterbox instead of escaping it.
    const c2 = await page.evaluate(() => {
      const host = document.querySelector('#movie_player .yt-snip-host');
      const r = host.shadowRoot.querySelector('.snip-rect').getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    });
    await h.mouseDrag(page, c2.x, c2.y, c2.x + 4000, c2.y + 4000);
    const pinned = await h.getSelection(page);
    expect(pinned.w).toBeCloseTo(before.w, 6);
    expect(pinned.h).toBeCloseTo(before.h, 6);
    expect(pinned.x + pinned.w).toBeLessThanOrEqual(1 + 1e-6);
    expect(pinned.y + pinned.h).toBeLessThanOrEqual(1 + 1e-6);
  });

  test('start/end handle drags scrub frames and park the playhead at the edge', async ({ page }) => {
    await engage(page);
    const duration = await page.evaluate(() =>
      document.querySelector('video.html5-main-video').duration);

    // END handle to mid-video: playhead must follow the dragged edge…
    await h.dragTimelineHandle(page, 'end', 0.5);
    let clip = await h.getClip(page);
    expect(Math.abs(clip.preview - clip.end)).toBeLessThan(duration * 0.05);
    let t = await page.evaluate(() =>
      document.querySelector('video.html5-main-video').currentTime);
    expect(Math.abs(t - clip.end)).toBeLessThan(duration * 0.08);

    // …and the START handle likewise.
    await h.dragTimelineHandle(page, 'start', 0.25);
    clip = await h.getClip(page);
    expect(Math.abs(clip.preview - clip.start)).toBeLessThan(duration * 0.05);
    t = await page.evaluate(() =>
      document.querySelector('video.html5-main-video').currentTime);
    expect(Math.abs(t - clip.start)).toBeLessThan(duration * 0.08);

    // Same rule on the detail strip.
    await h.dragZoomHandle(page, 'end', 0.8);
    clip = await h.getClip(page);
    expect(Math.abs(clip.preview - clip.end)).toBeLessThan(duration * 0.05);
  });

  test('a paused video stays paused through every interaction', async ({ page }) => {
    await engage(page);
    const pausedAt = () => page.evaluate(() =>
      document.querySelector('video.html5-main-video').paused);
    expect(await pausedAt()).toBe(true);

    await h.dragTimelineHandle(page, 'start', 0.2);
    await page.waitForTimeout(150);
    expect(await pausedAt()).toBe(true);

    await h.dragTimelineHandle(page, 'end', 0.7);
    await page.waitForTimeout(150);
    expect(await pausedAt()).toBe(true);

    await h.dragTimelineHandle(page, 'preview', 0.4);
    await page.waitForTimeout(150);
    expect(await pausedAt()).toBe(true);

    const c = await page.evaluate(() => {
      const host = document.querySelector('#movie_player .yt-snip-host');
      const r = host.shadowRoot.querySelector('.snip-rect').getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    });
    await h.mouseDrag(page, c.x, c.y, c.x + 80, c.y + 40);
    await page.waitForTimeout(300);
    expect(await pausedAt()).toBe(true);
    expect(await page.evaluate(() => window.ytSnip._getState())).toBe('engaged');
  });

  test('adjustments track the pointer exactly on a letterboxed (non-16:9) stage', async ({ page }) => {
    // Fake a 20:9 source so the 640x360 player letterboxes top/bottom
    // (contentBox.y = 36). Regression: resize/move rebuilt pixel coords as
    // sel.y * box.h, dropping box.y, so the FIRST adjustment snapped the rect
    // up by exactly the letterbox offset (user-visible "jerk up" on any
    // non-16:9 layout, and by fractional amounts on rounded 16:9 stages).
    await h.openWatch(page);
    await page.evaluate(() => {
      const v = document.querySelector('video.html5-main-video');
      Object.defineProperty(v, 'videoWidth', { get: () => 2400, configurable: true });
      Object.defineProperty(v, 'videoHeight', { get: () => 1080, configurable: true });
    });
    await h.startSnip(page);
    await h.dragSelect(page, { x: 60, y: 80 }, { x: 380, y: 260 });
    const base = await page.evaluate(() => {
      const host = document.querySelector('#movie_player .yt-snip-host');
      const r = host.shadowRoot.querySelector('.snip-rect').getBoundingClientRect();
      return { top: r.top, left: r.left, w: r.width, h: r.height };
    });

    const readRect = () => page.evaluate(() => {
      const host = document.querySelector('#movie_player .yt-snip-host');
      const r = host.shadowRoot.querySelector('.snip-rect').getBoundingClientRect();
      return { top: r.top, left: r.left, w: r.width, h: r.height };
    });

    // MOVE kind: the very first 1px of movement must not shift the rect in Y.
    const cx = base.left + base.w / 2;
    const cy = base.top + base.h / 2;
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx + 1, cy);
    let cur = await readRect();
    expect(Math.abs(cur.top - base.top)).toBeLessThan(1.5);
    expect(Math.abs(cur.left - base.left - 1)).toBeLessThan(1.5);
    await page.mouse.move(cx + 31, cy - 12);
    cur = await readRect();
    expect(Math.abs(cur.top - (base.top - 12))).toBeLessThan(1.5);
    expect(Math.abs(cur.w - base.w)).toBeLessThan(0.5);
    expect(Math.abs(cur.h - base.h)).toBeLessThan(0.5);
    await page.mouse.up();

    // RESIZE S: the top edge stays pinned while the bottom follows.
    const s = await page.evaluate(() => {
      const host = document.querySelector('#movie_player .yt-snip-host');
      const b = host.shadowRoot.querySelector('.snip-handle[data-dir="s"]').getBoundingClientRect();
      return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
    });
    await page.mouse.move(s.x, s.y);
    await page.mouse.down();
    await page.mouse.move(s.x, s.y + 1);
    cur = await readRect();
    expect(Math.abs(cur.top - (base.top - 12))).toBeLessThan(1.5);
    expect(Math.abs(cur.h - (base.h + 1))).toBeLessThan(1.5);
    await page.mouse.up();
  });
});

test.describe('M12 loopOnPlay option', () => {
  test('loopOnPlay=false gates auto-loop; the Loop button still works', async ({ page }) => {
    await h.openWatch(page, { options: { loopOnPlay: false } });
    await h.startSnip(page);
    await h.dragSelect(page, { x: 60, y: 40 }, { x: 380, y: 200 });

    await page.evaluate(async () => {
      const v = document.querySelector('video.html5-main-video');
      v.muted = true;
      await v.play().catch(() => {});
    });
    await expect.poll(() => page.evaluate(() =>
      !document.querySelector('video.html5-main-video').paused)).toBe(true);
    await page.waitForTimeout(500);
    expect(await page.evaluate(() => window.ytSnip._isLooping())).toBe(false);

    // Explicit Loop still arms.
    expect(await h.clickToolbar(page, 'Loop')).toBe(true);
    expect(await page.evaluate(() => window.ytSnip._isLooping())).toBe(true);
  });
});

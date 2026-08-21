/*
 * test/e2e/zoom.spec.js
 *
 * Tier 1 coverage for the detail strip (zoomed timeline window). Uses the
 * harness ?duration= seam to fake a 1h video so the granularity win over the
 * full-duration main bar is measurable. Asserts clip math via the
 * window.ytSnip introspection seam — playback length is irrelevant here.
 */
'use strict';

const { test, expect } = require('@playwright/test');

const helpers = require('./helpers');

async function engage(page, query) {
  await helpers.openWatch(page, query);
  await helpers.startSnip(page);
  await helpers.dragSelect(page, { x: 40, y: 40 }, { x: 400, y: 220 });
}

test.describe('zoom detail strip', () => {
  test('appears above the progress bar, oriented on the default selection; idle hides it', async ({ page }) => {
    await engage(page);
    const bar = await page.evaluate(() => {
      const b = document.querySelector('#movie_player .ytp-progress-bar').getBoundingClientRect();
      return { left: b.left, top: b.top, width: b.width };
    });
    const strip = await helpers.shadowRect(page, '.snip-zoom');
    expect(strip.display).toBe('block');
    expect(strip.left).toBeCloseTo(bar.left, 0);
    expect(strip.width).toBeCloseTo(bar.width, 0);
    // Slightly ABOVE the progress bar.
    expect(strip.top).toBeLessThan(bar.top);
    expect(strip.top + strip.height).toBeLessThanOrEqual(bar.top);

    // M13: the strip starts oriented around the default selection (±3 s
    // around activation), not stretched across the whole duration. The
    // window CONTAINS the clip; its center may sit off the clip's center
    // when the refit clamps at a video edge (clip hugging t=0 here).
    const dur = await page.evaluate(() => document.querySelector('video.html5-main-video').duration);
    const zw = await helpers.getZoom(page);
    const clip = await helpers.getClip(page);
    expect(zw.start).toBeLessThanOrEqual(clip.start + 1e-6);
    expect(zw.end).toBeGreaterThanOrEqual(clip.end - 1e-6);
    expect(zw.end - zw.start).toBeLessThanOrEqual(dur + 1e-6);

    await page.keyboard.press('Escape');
    await expect.poll(() => page.evaluate(() => window.ytSnip._getState())).toBe('idle');
    expect((await helpers.shadowRect(page, '.snip-zoom')).display).toBe('none');
    expect(await helpers.getZoom(page)).toBeNull();
  });

  test('long video: deep zoom makes handle drags far finer than full-duration mapping', async ({ page }) => {
    await engage(page, { query: { duration: '3600' } });

    const dur = await page.evaluate(() => document.querySelector('video.html5-main-video').duration);
    expect(dur).toBeCloseTo(3600, 5);

    // Establish a fitted baseline, then build a distinct mid-video clip so
    // no two handles stack at a clamped edge (M15: trims never move the
    // window, so this geometry stays put for the whole test). End widens
    // FIRST — while all handles share the far-left clamp, the end handle
    // paints topmost and would steal a start-grab.
    expect(await helpers.clickZoomCtl(page, 'Fit')).toBe(true);
    await helpers.dragTimelineHandle(page, 'end', 0.25);
    await helpers.dragTimelineHandle(page, 'start', 0.1);
    const clip = await helpers.getClip(page);
    expect(clip.start).toBeGreaterThan(300);
    expect(clip.end).toBeLessThan(1000);

    // Zoom in ×16 with the cursor parked ON the start handle: the anchor
    // stays under the cursor, so the start edge never clamps.
    const spot = await page.evaluate(() => {
      const host = document.querySelector('#movie_player .yt-snip-host');
      const strip = host.shadowRoot.querySelector('.snip-zoom');
      const h = strip.querySelector('.snip-tl-handle[data-role="start"]').getBoundingClientRect();
      return { x: h.left + h.width / 2, y: h.top + h.height / 2 };
    });
    await page.mouse.move(spot.x, spot.y);
    for (let i = 0; i < 4; i++) await page.mouse.wheel(0, -120);
    await page.waitForTimeout(120);

    // Drag the zoomed start handle right by ~30px: clip.start must move by
    // roughly Δpx * span/stripWidth — at least 10× finer than one main-bar
    // pixel-equivalent (3600s / stripWidth).
    const zwPreDrag = await helpers.getZoom(page);
    expect(zwPreDrag.end - zwPreDrag.start).toBeCloseTo(225, 0);
    const handleX = () =>
      page.evaluate(() => {
        const host = document.querySelector('#movie_player .yt-snip-host');
        const strip = host.shadowRoot.querySelector('.snip-zoom');
        const h = strip.querySelector('.snip-tl-handle[data-role="start"]').getBoundingClientRect();
        return { x: h.left + h.width / 2, y: h.top + h.height / 2, w: strip.getBoundingClientRect().width };
      });
    // Coarse pass: pull the start edge well inside the window so the measured
    // drag below happens in the linear zone (away from the edge clamp).
    const c0 = await handleX();
    await helpers.mouseDrag(page, c0.x, c0.y, c0.x + 150, c0.y);

    // Fine pass: ~30px right; clip.start must follow the window mapping and
    // be ≥10× finer than one main-bar pixel-equivalent (3600s / stripWidth).
    // Interactive drags can occasionally no-op under the runner, so measure
    // with a bounded retry and assert on the first successful sample.
    let m = null;
    for (let attempt = 0; attempt < 4 && (!m || m.moved <= 0); attempt++) {
      const b0 = await helpers.getClip(page);
      const g0 = await handleX();
      await helpers.mouseDrag(page, g0.x, g0.y, g0.x + 30, g0.y);
      const g1 = await handleX();
      const c1 = await helpers.getClip(page);
      m = { moved: c1.start - b0.start, dx: Math.max(1, g1.x - g0.x), w: g0.w };
    }
    // Firefox may coalesce trailing move events, so use the real delta.
    const expectedPerPx = (zwPreDrag.end - zwPreDrag.start) / m.w;
    expect(m.moved).toBeGreaterThan(0);
    expect(m.moved).toBeLessThan(expectedPerPx * m.dx * 1.6); // follows the window mapping
    expect(m.moved).toBeLessThan((3600 / m.w) * m.dx / 10); // ≥10× finer than the main bar

    // Pan the body right by ~100px: span preserved, window shifts forward.
    const zwPanBefore = await helpers.getZoom(page);
    const panFrom = await page.evaluate(() => {
      const host = document.querySelector('#movie_player .yt-snip-host');
      const s = host.shadowRoot.querySelector('.snip-zoom').getBoundingClientRect();
      return { x: s.left + s.width * 0.6, y: s.top + s.height / 2 };
    });
    let zwPanAfter = null;
    for (let attempt = 0; attempt < 4 && !zwPanAfter; attempt++) {
      await helpers.mouseDrag(page, panFrom.x, panFrom.y, panFrom.x + 100, panFrom.y);
      const z = await helpers.getZoom(page);
      if (z.start > zwPanBefore.start) zwPanAfter = z;
    }
    expect(zwPanAfter).not.toBeNull();
    expect(zwPanAfter.end - zwPanAfter.start).toBeCloseTo(zwPanBefore.end - zwPanBefore.start, 3);
  });

  test('wheel zooms at the cursor and Fit resets to the full duration', async ({ page }) => {
    await engage(page, { query: { duration: '3600' } });
    const spanOf = () =>
      helpers.getZoom(page).then((z) => (z ? z.end - z.start : -1));

    // Establish the full-duration baseline explicitly (M13 engages oriented
    // on the default selection; Fit is the reset-under-test anyway).
    expect(await helpers.clickZoomCtl(page, 'Fit')).toBe(true);
    await expect.poll(spanOf, { timeout: 5000 }).toBeCloseTo(3600, 0);

    // Wheel up over the strip center → zoom in ×2 around that point.
    const spot = await page.evaluate(() => {
      const host = document.querySelector('#movie_player .yt-snip-host');
      const s = host.shadowRoot.querySelector('.snip-zoom').getBoundingClientRect();
      return { x: s.left + s.width * 0.75, y: s.top + s.height / 2 };
    });
    await page.mouse.move(spot.x, spot.y);
    await page.mouse.wheel(0, -120);
    await expect.poll(spanOf, { timeout: 5000 }).toBeCloseTo(1800, 0);

    // Wheel down → back out ×2.
    await page.mouse.wheel(0, 120);
    await expect.poll(spanOf, { timeout: 5000 }).toBeCloseTo(3600, 0);

    // Zoom in again, then Fit resets to the whole video.
    await page.mouse.wheel(0, -120);
    await expect.poll(spanOf, { timeout: 5000 }).toBeCloseTo(1800, 0);
    expect(await helpers.clickZoomCtl(page, 'Fit')).toBe(true);
    await expect
      .poll(() => helpers.getZoom(page), { timeout: 5000 })
      .toEqual({ start: 0, end: 3600 });
  });
});

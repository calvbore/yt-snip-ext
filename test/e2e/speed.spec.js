'use strict';

/*
 * test/e2e/speed.spec.js
 *
 * Tier 1 — M17 playback-speed control: preset chips, live preview via
 * video.playbackRate, menu-local Esc, saved-output timing (slow motion
 * doubles the output duration; speed-up halves it), and the activation
 * playbackRate restore on disengage.
 */

const { test, expect } = require('@playwright/test');
const h = require('./helpers');
const { decodeGif } = require('../helpers/gif-validate');
const { validateWebm } = require('../helpers/webm-validate');

const VIDEO_W = 640;
const VIDEO_H = 360;

async function engage(page, options) {
  await h.openWatch(page, { options });
  await page.evaluate(() => {
    document.querySelector('video.html5-main-video').currentTime = 2.5;
  });
  await h.startSnip(page);
  await h.dragSelect(page, { x: 0, y: 0 }, { x: VIDEO_W, y: VIDEO_H });
}

async function speedButton(page) {
  return page.evaluate(() => {
    const host = document.querySelector('#movie_player .yt-snip-host');
    if (!host || !host.shadowRoot) return null;
    const btn = Array.from(host.shadowRoot.querySelectorAll('.snip-toolbar button'))
      .find((b) => (b.textContent || '').includes('Speed'));
    return btn ? btn.textContent : null;
  });
}

test.describe('M17 playback speed', () => {
  test('preset chips apply immediately and preview via video.playbackRate', async ({ page }) => {
    await engage(page, { fps: 12, format: 'gif' });
    expect(await speedButton(page)).toBe('Speed 1×');

    const clicked = await clickToolbarSpeed(page);
    expect(clicked).toBe(true);
    // Menu is visible with the 7 presets.
    const chips = await page.evaluate(() => {
      const host = document.querySelector('#movie_player .yt-snip-host');
      const menu = host.shadowRoot.querySelector('.snip-speed-menu');
      return menu && menu.style.display !== 'none'
        ? Array.from(menu.querySelectorAll('button')).map((b) => b.textContent)
        : null;
    });
    expect(chips).toEqual(['0.25×', '0.5×', '1×', '1.5×', '2×', '3×', '4×']);

    await clickChip(page, '0.5');
    expect(await speedButton(page)).toBe('Speed 0.5×');
    const rate = await page.evaluate(() =>
      document.querySelector('video.html5-main-video').playbackRate
    );
    expect(rate).toBe(0.5);

    // 3× also works and is applied to the live player.
    await clickToolbarSpeed(page);
    await clickChip(page, '3');
    expect(await speedButton(page)).toBe('Speed 3×');
    expect(
      await page.evaluate(() => document.querySelector('video.html5-main-video').playbackRate)
    ).toBe(3);
  });

  test('Esc closes an open speed menu first; a second Esc disengages', async ({ page }) => {
    await engage(page, { fps: 12, format: 'gif' });
    await clickToolbarSpeed(page);
    await page.keyboard.press('Escape');
    // Menu closed, tool still engaged.
    const menuHidden = await page.evaluate(() => {
      const host = document.querySelector('#movie_player .yt-snip-host');
      const menu = host.shadowRoot.querySelector('.snip-speed-menu');
      return !menu || menu.style.display === 'none';
    });
    expect(menuHidden).toBe(true);
    expect(await page.evaluate(() => window.ytSnip._getState())).toBe('engaged');

    await page.keyboard.press('Escape');
    await expect.poll(() => page.evaluate(() => window.ytSnip._getState())).toBe('idle');
  });

  test('disengage restores the activation playbackRate', async ({ page }) => {
    await engage(page, { fps: 12, format: 'gif' });
    // Give the video a user rate before the session; engage snapshots it.
    await clickToolbarSpeed(page);
    await clickChip(page, '3');
    expect(
      await page.evaluate(() => document.querySelector('video.html5-main-video').playbackRate)
    ).toBe(3);

    await page.keyboard.press('Escape'); // close menu
    await page.keyboard.press('Escape'); // disengage
    await expect.poll(() => page.evaluate(() => window.ytSnip._getState())).toBe('idle');
    expect(
      await page.evaluate(() => document.querySelector('video.html5-main-video').playbackRate)
    ).toBe(1);
  });

  test('0.5× GIF: ~2× the frames and ~2× the summed duration', async ({ page }) => {
    await engage(page, { fps: 1, maxDimension: 256, format: 'gif' });
    await clickToolbarSpeed(page);
    await clickChip(page, '0.5');

    const res = await h.saveAndGetMessage(page);
    expect(res.filename).toMatch(/\.gif$/);
    const gif = decodeGif(Uint8Array.from(res.bytes));
    // 5 s clip @ sampleRate 2 (1 fps / 0.5) → ~10-11 frames.
    expect(gif.frames.length).toBeGreaterThanOrEqual(9);
    expect(gif.frames.length).toBeLessThanOrEqual(12);
    // Output fps stays at the nominal 1 → 1000 ms delay per frame; total
    // duration ≈ clip duration / speed = 10 s.
    const totalMs = gif.frames.reduce((a, f) => a + f.delayMs, 0);
    expect(totalMs).toBeGreaterThanOrEqual(9000);
    expect(totalMs).toBeLessThanOrEqual(12500);
  });

  test('2× WebM: native sampling at doubled output fps, halved duration', async ({ page }) => {
    await engage(page, { fps: 1, maxDimension: 256, format: 'webm' });
    await clickToolbarSpeed(page);
    await clickChip(page, '2');

    const res = await h.saveAndGetMessage(page);
    expect(res.filename).toMatch(/\.webm$/);
    const v = await validateWebm(Uint8Array.from(res.bytes));
    // 5 s clip @ 1 fps sampling → ~5-6 packets at 2 fps output timestamps.
    expect(v.packets.length).toBeGreaterThanOrEqual(4);
    expect(v.packets.length).toBeLessThanOrEqual(7);
    // Output duration ≈ 5 / 2 s.
    expect(Math.abs(v.duration - 5 / 2)).toBeLessThan(0.9);
  });
});

/* ---- helpers (shadow-DOM scoped) ----------------------------------- */

async function clickToolbarSpeed(page) {
  return page.evaluate(() => {
    const host = document.querySelector('#movie_player .yt-snip-host');
    const btn = Array.from(host.shadowRoot.querySelectorAll('.snip-toolbar button'))
      .find((b) => (b.textContent || '').includes('Speed'));
    if (!btn) return false;
    btn.click();
    return true;
  });
}

async function clickChip(page, label) {
  return page.evaluate((label) => {
    const host = document.querySelector('#movie_player .yt-snip-host');
    const menu = host.shadowRoot.querySelector('.snip-speed-menu');
    const chip = Array.from(menu.querySelectorAll('button'))
      .find((b) => (b.textContent || '').startsWith(label));
    if (!chip) return false;
    chip.click();
    return true;
  }, label);
}

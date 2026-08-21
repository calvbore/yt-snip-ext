/*
 * test/e2e/helpers.js
 *
 * Shared helpers for the Tier 1 Playwright suite. Mirrors the deterministic
 * watch-page shell served by test/fixtures/serve.mjs + harness.html and
 * drives the real content scripts through their public UI + window.ytSnip
 * introspection seam.
 */
'use strict';

const { expect } = require('@playwright/test');

const WATCH_URL = 'http://127.0.0.1:8123/watch';

/** Navigate to the harness, wait for the video + button, and prime options. */
async function openWatch(page, { media, options, query } = {}) {
  const params = new URLSearchParams(query || {});
  if (media) params.set('media', media);
  const qs = params.toString();
  await page.goto(WATCH_URL + (qs ? '?' + qs : ''), { waitUntil: 'load' });
  if (options) {
    await page.evaluate((opts) => {
      window.__ytSnipStorage = Object.assign({}, opts);
    }, options);
  }
  await expect(page.locator('button.yt-snip-trigger')).toBeVisible();
  await waitForVideo(page);
  return page;
}

async function waitForVideo(page) {
  await page.waitForFunction(() => {
    const v = document.querySelector('video.html5-main-video');
    return v && v.readyState >= 2 && isFinite(v.duration) && v.duration > 0 && v.videoWidth > 0;
  }, null, { timeout: 15000 });
}

/** Resolve an element inside the yt-snip shadow root. */
async function shadowQuery(page, selector) {
  return page.evaluateHandle((sel) => {
    const host = document.querySelector('#movie_player .yt-snip-host');
    if (!host || !host.shadowRoot) return null;
    return host.shadowRoot.querySelector(sel);
  }, selector);
}

async function shadowRect(page, selector) {
  return page.evaluate((sel) => {
    const host = document.querySelector('#movie_player .yt-snip-host');
    if (!host || !host.shadowRoot) return null;
    const el = host.shadowRoot.querySelector(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { left: r.left, top: r.top, width: r.width, height: r.height, display: getComputedStyle(el).display };
  }, selector);
}

async function mouseDrag(page, x1, y1, x2, y2) {
  await page.mouse.move(x1, y1);
  await page.mouse.down();
  await page.mouse.move(x2, y2, { steps: 8 });
  await page.mouse.up();
}

/** Click the snip trigger, wait for the overlay to reach a state. */
async function startSnip(page) {
  await page.locator('button.yt-snip-trigger').click();
  await expect.poll(() => page.evaluate(() => window.ytSnip._getState())).toBe('activating');
}

/** Drag a selection over the video; expect the engaged state + rect. */
async function dragSelect(page, from, to) {
  const vr = await page.evaluate(() => {
    const v = document.querySelector('video.html5-main-video');
    const r = v.getBoundingClientRect();
    return { left: r.left, top: r.top, width: r.width, height: r.height };
  });
  await mouseDrag(page, vr.left + from.x, vr.top + from.y, vr.left + to.x, vr.top + to.y);
  await expect.poll(() => page.evaluate(() => window.ytSnip._getState())).toBe('engaged');
  return vr;
}

async function getSelection(page) {
  return page.evaluate(() => window.ytSnip._getSelection());
}

async function getClip(page) {
  return page.evaluate(() => window.ytSnip._getClip());
}

async function getZoom(page) {
  return page.evaluate(() => window.ytSnip._getZoom());
}

/**
 * Drag a detail-strip handle to `targetFrac` of the strip (window-aware).
 * Uses the real mouse so pointer capture works, like dragTimelineHandle.
 */
async function dragZoomHandle(page, role, targetFrac) {
  const pos = await page.evaluate((arg) => {
    const host = document.querySelector('#movie_player .yt-snip-host');
    const strip = host.shadowRoot.querySelector('.snip-zoom');
    const handle = strip ? strip.querySelector('.snip-tl-handle[data-role="' + arg.role + '"]') : null;
    if (!handle) return null;
    const h = handle.getBoundingClientRect();
    const s = strip.getBoundingClientRect();
    return { x1: h.left + h.width / 2, y: h.top + h.height / 2, x2: s.left + s.width * arg.frac };
  }, { role, frac: targetFrac });
  expect(pos).not.toBeNull();
  await mouseDrag(page, pos.x1, pos.y, pos.x2, pos.y);
}

/** Click a detail-strip control button ('+', '−', 'Fit'). */
async function clickZoomCtl(page, label) {
  return page.evaluate((lbl) => {
    const host = document.querySelector('#movie_player .yt-snip-host');
    const buttons = host.shadowRoot.querySelectorAll('.snip-zl-ctl button');
    for (const b of buttons) {
      if (b.textContent.includes(lbl)) { b.click(); return true; }
    }
    return false;
  }, label);
}

async function clickToolbar(page, label) {
  const btn = await shadowQuery(page, '.snip-toolbar button');
  // Find the button whose text matches label.
  return page.evaluate((lbl) => {
    const host = document.querySelector('#movie_player .yt-snip-host');
    const buttons = host.shadowRoot.querySelectorAll('.snip-toolbar button');
    for (const b of buttons) {
      if (b.textContent.includes(lbl)) { b.click(); return true; }
    }
    return false;
  }, label);
}

/**
 * Drag a timeline handle to `targetFrac` of the progress bar. Uses the real
 * mouse (not synthetic events) so pointer capture set in yt-snip.js works.
 */
async function dragTimelineHandle(page, role, targetFrac) {
  const pos = await page.evaluate((arg) => {
    const host = document.querySelector('#movie_player .yt-snip-host');
    const handle = host.shadowRoot.querySelector('.snip-tl-handle[data-role="' + arg.role + '"]');
    if (!handle) return null;
    const h = handle.getBoundingClientRect();
    const bar = document.querySelector('#movie_player .ytp-progress-bar');
    const b = bar.getBoundingClientRect();
    return {
      x1: h.left + h.width / 2,
      y: h.top + h.height / 2,
      x2: b.left + b.width * arg.frac,
    };
  }, { role, frac: targetFrac });
  expect(pos).not.toBeNull();
  await mouseDrag(page, pos.x1, pos.y, pos.x2, pos.y);
}

/** Save via the real flow; resolves with the decoded+transmitted message. */
async function saveAndGetMessage(page) {
  const clicked = await clickToolbar(page, 'Save');
  expect(clicked).toBe(true);
  await page.waitForFunction(() => {
    return window.__ytSnipMessages.some((m) => m && m.type === 'yt-snip:save');
  }, null, { timeout: 30000 });
  return page.evaluate(() => {
    const m = window.__ytSnipMessages.find((x) => x && x.type === 'yt-snip:save');
    const bytes = new Uint8Array(m.payload.data);
    return {
      filename: m.payload.filename,
      saveAs: m.payload.saveAs,
      bytes: Array.from(bytes),
    };
  });
}

module.exports = {
  WATCH_URL,
  openWatch,
  waitForVideo,
  shadowQuery,
  shadowRect,
  mouseDrag,
  startSnip,
  dragSelect,
  getSelection,
  getClip,
  getZoom,
  dragTimelineHandle,
  dragZoomHandle,
  clickZoomCtl,
  clickToolbar,
  saveAndGetMessage,
};
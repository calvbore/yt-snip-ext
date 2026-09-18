/*
 * test/yt/live.mjs — Tier 3 opt-in live-YouTube check (`RUN_REAL_YT=1`).
 *
 * Covers the only boundary an organic harness cannot: the LIVE YouTube DOM,
 * the MSE stream, and real googlevideo CORS. It drives the real content-script
 * files as page scripts (same technique as Tier 1, so no extension install is
 * needed — the Selenium host-permission env defect from the Tier 2 de-scope
 * does not apply here) against a real watch page, and validates:
 *   - the scripts inject the snip trigger into real YouTube chrome
 *   - engage → drag a region → the timeline handles anchor over the real
 *     `.ytp-progress-bar` and narrow the clip to a short window
 *   - capture runs against the real MSE stream and the transmitted GIF
 *     real-decodes via the shared validator (primary same-origin blob path)
 *   - disengage restores the activation timestamp
 *
 * Opt-in and excluded from `npm test`: YouTube flakiness must not gate the
 * pre-packaging suite. Run `RUN_REAL_YT=1 npm run test:yt` on-demand / before
 * release. Not covered here (deferred to a normal-profile manual soak and the
 * Tier 2 smoke when the env grants host permissions again): the extension's
 * real `browser.downloads` save path and isolated-world injection.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { firefox } from '@playwright/test';

import { decodeGif } from '../helpers/gif-validate.js';

const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const DEFAULT_VIDEO_URL = 'https://www.youtube.com/watch?v=aqz-KE-bpKQ'; // Big Buck Bunny (CC-BY, ~33 s)

// Same order as test/manifest.json content_scripts js list.
const CONTENT_FILES = [
  'lib/messaging.js',
  'lib/scheduler.js',
  'lib/crop.js',
  'lib/timeline.js',
  'lib/state.js',
  'lib/options.js',
  'lib/storage.js',
  'lib/filename.js',
  'lib/saveflow.js',
  'content/gif-encoder.js',
  'lib/vendor/mediabunny.js',
  'content/webm-encoder.js',
  'content/capture.js',
  'content/fallback-capture.js',
  'content/yt-snip.js',
];

const CLIP_SECONDS = 3; // live window we narrow the clip to
const OPTIONS = { fps: 4, maxDimension: 320, saveAs: false, format: 'gif' };

function log(msg) {
  console.log(`[yt] ${msg}`);
}

async function acceptConsent(page) {
  for (let i = 0; i < 3; i++) {
    const wall = await page
      .locator('ytd-consent-bump-v2-lightbox, tp-yt-paper-dialog, [id*="consent"]')
      .first()
      .isVisible()
      .catch(() => false);
    if (!wall) return;
    const accepted = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button, tp-yt-paper-button, [role="button"]'));
      const text = (b) => (b.textContent || '').trim().toLowerCase();
      const b = btns.find(
        (x) =>
          /^(accept all|accept the use of cookies and other data for the purposes described|i agree|accept)$/.test(
            text(x)
          )
      );
      if (b) { b.click(); return true; }
      const form = document.querySelector('form input[type="submit"]');
      if (form) { form.click(); return true; }
      return false;
    });
    if (!accepted) break;
    await page.waitForTimeout(1500);
  }
}

async function waitForVideo(page, timeoutMs) {
  await page.waitForFunction(() => {
    const v = document.querySelector('#movie_player video');
    return v && v.readyState >= 2 && isFinite(v.duration) && v.duration > 0 && v.videoWidth > 0;
  }, null, { timeout: timeoutMs });
}

/**
 * Drag a timeline handle (start/end/preview) so the edited time lands at
 * `frac` of the full duration. M15: handles live only on the detail strip,
 * which shows a magnified window — Fit first to make fractions meaningful.
 */
async function dragHandle(page, role, frac) {
  await page.evaluate(() => {
    const host = document.querySelector('#movie_player .yt-snip-host');
    if (!host || !host.shadowRoot) return;
    for (const b of host.shadowRoot.querySelectorAll('.snip-zl-ctl button')) {
      if (b.textContent.includes('Fit')) { b.click(); break; }
    }
  });
  await page.waitForTimeout(150); // let positionZoom place the fitted handles
  const pos = await page.evaluate((arg) => {
    const host = document.querySelector('#movie_player .yt-snip-host');
    if (!host || !host.shadowRoot) return null;
    const strip = host.shadowRoot.querySelector('.snip-zoom');
    const handle = strip ? strip.querySelector('.snip-tl-handle[data-role="' + arg.role + '"]') : null;
    if (!handle) return null;
    const h = handle.getBoundingClientRect();
    const s = strip.getBoundingClientRect();
    return { x1: h.left + h.width / 2, y: h.top + h.height / 2, x2: s.left + s.width * arg.frac };
  }, { role, frac });
  if (!pos) throw new Error('timeline handle not found: ' + role);
  await page.mouse.move(pos.x1, pos.y);
  await page.mouse.down();
  await page.mouse.move(pos.x2, pos.y, { steps: 8 });
  await page.mouse.up();
}

async function main() {
  if (process.env.RUN_REAL_YT !== '1') {
    console.log('[yt] RUN_REAL_YT is not set — skipping the opt-in live-YouTube tier.');
    return;
  }

  const args = process.argv.slice(2);
  const url = (args.find((a) => !a.startsWith('--')) || process.env.YT_TEST_URL) || DEFAULT_VIDEO_URL;
  const startedAt = Date.now();

  const browser = await firefox.launch({ headless: true });
  let closed = false;
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const page = await context.newPage();
    page.setDefaultTimeout(90000);

    // Boundary stub first, then the real content scripts, as document-start
    // init scripts (manifest order, lib before content). Init scripts are not
    // subject to YouTube's CSP (which blocks inline addScriptTag injection).
    await page.addInitScript(function (opts) {
      window.__ytSnipMessages = [];
      window.__ytSnipStorage = Object.assign({}, opts);
      window.browser = {
        runtime: {
          sendMessage(msg) {
            window.__ytSnipMessages.push(msg);
            if (msg && msg.type === 'yt-snip:save') return Promise.resolve({ ok: true, id: 1 });
            return Promise.resolve({});
          },
        },
        storage: {
          local: {
            get(keys, cb) {
              const items = window.__ytSnipStorage;
              if (typeof cb === 'function') { cb(items); return; }
              return Promise.resolve(items);
            },
            set(values, cb) {
              Object.assign(window.__ytSnipStorage, values || {});
              if (typeof cb === 'function') cb();
              return Promise.resolve();
            },
          },
        },
      };
    }, OPTIONS);
    for (const file of CONTENT_FILES) {
      const content = await fs.promises.readFile(path.join(ROOT, file), 'utf8');
      await page.addInitScript(content);
    }

    log(`loading ${url}`);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForURL(/youtube\.com/, { timeout: 15000 }).catch(() => {});
    await acceptConsent(page);

    await page.waitForSelector('#movie_player', { timeout: 20000 });
    await waitForVideo(page, 60000);
    log('real video ready (MSE stream loaded)');

    await page.waitForSelector('button.yt-snip-trigger', { timeout: 20000 });
    log('content scripts live: snip trigger injected into real YouTube chrome');

    // Seek to a mid point so there is room for a CLIP_SECONDS window.
    const meta = await page.evaluate(() => {
      const v = document.querySelector('#movie_player video');
      return { duration: v.duration };
    });
    // Work within the headless player's already-buffered MSE range (~0–20 s).
// Seeking far ahead (e.g. 317 s) while paused forces a fresh range fetch and
// YouTube resets the element (emptied) before the first sample renders, so
// the capture hangs. Early-range clips decode instantly and still exercise
// the real MSE stream. Far-seek capture is covered by Tier 1 on the seekable
// synthetic stream.
const clipStart = Math.min(2, Math.max(0, meta.duration - CLIP_SECONDS - 1));
    await page.evaluate((t) => {
      document.querySelector('#movie_player video').currentTime = t;
    }, clipStart);
    await page.waitForFunction(
      (t) => Math.abs(document.querySelector('#movie_player video').currentTime - t) < 1.5,
      clipStart,
      { timeout: 20000 }
    );

    // Pause before activating so the machine snapshots `paused` — the restore
    // then deterministically rewinds to the activation timestamp and stays put
    // (in headless the MSE playback clock rushes, so a playing-restore can't be
    // asserted against wall-clock tolerances).
    await page.evaluate(() => {
      const v = document.querySelector('#movie_player video');
      if (!v.paused) v.pause();
    });
    await page.waitForFunction(() => document.querySelector('#movie_player video').paused === true, null, { timeout: 10000 });

    // Activate + drag a region. YouTube autohides the controls bar, which can
    // make the trigger unreachable at its last-known coordinates — hover the
    // player first, click for real, and fall back to a DOM click if the hover
    // didn't wake the chrome.
    const vr = await page.evaluate(() => {
      const r = document.querySelector('#movie_player').getBoundingClientRect();
      return { left: r.left, top: r.top, width: r.width, height: r.height };
    });
    await page.mouse.move(vr.left + vr.width * 0.5, vr.top + vr.height * 0.5);
    await page.waitForTimeout(400);
    const triggerBox = await page.evaluate(() => {
      const r = document.querySelector('button.yt-snip-trigger').getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height };
    });
    let state = await page.evaluate(() => (window.ytSnip ? window.ytSnip._getState() : 'no-ytSnip'));
    if (triggerBox.w > 0 && triggerBox.h > 0 && state === 'idle') {
      await page.mouse.click(triggerBox.x, triggerBox.y);
      state = await page.evaluate(() => (window.ytSnip ? window.ytSnip._getState() : 'no-ytSnip'));
    }
    if (state !== 'activating') {
      await page.evaluate(() => document.querySelector('button.yt-snip-trigger').click());
      state = await page.evaluate(() => (window.ytSnip ? window.ytSnip._getState() : 'no-ytSnip'));
    }
    log('state after activating: ' + state);
    await page.waitForFunction(
      () => window.ytSnip && window.ytSnip._getState() === 'activating',
      null,
      { timeout: 10000 }
    );

    // The overlay is positioned by the rAF frame loop after activation; wait
    // until it geometrically covers the video before dragging, or the drag
    // would hit a 0×0/not-yet-positioned overlay.
    await page.waitForFunction(() => {
      const host = document.querySelector('#movie_player .yt-snip-host');
      if (!host || !host.shadowRoot) return false;
      const ov = host.shadowRoot.querySelector('.snip-overlay');
      if (!ov) return false;
      const cs = getComputedStyle(ov);
      return parseFloat(cs.width) > 10 && parseFloat(cs.height) > 10;
    }, null, { timeout: 10000 });
    await page.waitForTimeout(150);

    // Re-read the live player rect right before the drag — the overlay tracks
    // the #movie_player stage every rAF, so drag against THAT (the video
    // element's viewport rect is state-dependent on YouTube).
    const vrDrag = await page.evaluate(() => {
      const r = document.querySelector('#movie_player').getBoundingClientRect();
      return { left: r.left, top: r.top, width: r.width, height: r.height };
    });
    if (!(vrDrag.top > 0 && vrDrag.top < 720 && vrDrag.width > 100 && vrDrag.height > 100)) {
      throw new Error('video frame not in a draggable viewport position: ' + JSON.stringify(vrDrag));
    }

    await page.mouse.move(vrDrag.left + vrDrag.width * 0.1, vrDrag.top + vrDrag.height * 0.2);
    await page.mouse.down();
    await page.mouse.move(vrDrag.left + vrDrag.width * 0.9, vrDrag.top + vrDrag.height * 0.8, { steps: 8 });
    await page.mouse.up();
    await page.waitForFunction(() => window.ytSnip._getState() === 'engaged', null, { timeout: 10000 });
    log('engaged on live DOM');

    // Narrow the clip with the real timeline handles (live anchoring check).
    const endFrac = Math.min(0.97, (clipStart + CLIP_SECONDS) / meta.duration);
    const startFrac = clipStart / meta.duration;
    await dragHandle(page, 'start', startFrac);
    await dragHandle(page, 'end', endFrac);

    const clip = await page.evaluate(() => window.ytSnip._getClip());
    const span = clip.end - clip.start;
    log(`clip window: ${clip.start.toFixed(2)}s → ${clip.end.toFixed(2)}s (${span.toFixed(2)}s span)`);
    if (!(span >= 1)) throw new Error('live clip window unexpectedly short: ' + JSON.stringify(clip));

    // Opt into the machine's atomic restore trace (see yt-snip.js saveClip).
    await page.evaluate(() => {
      window.__ytSnipTrace = true;
    });

    // Save → real capture against the MSE stream → decode the transmitted GIF.
    const clicked = await page.evaluate(() => {
      const host = document.querySelector('#movie_player .yt-snip-host');
      if (!host || !host.shadowRoot) return false;
      const btn = Array.from(host.shadowRoot.querySelectorAll('.snip-toolbar button')).find((b) =>
        (b.textContent || '').includes('Save')
      );
      if (!btn) return false;
      btn.click();
      return true;
    });
    if (!clicked) throw new Error('Save button not found in the toolbar');
    log('capture started; waiting for the GIF to reach the background boundary…');
    const deadline = Date.now() + 150000;
    let saved = false;
    while (Date.now() < deadline) {
      const has = await page.evaluate(() => window.__ytSnipMessages.some((m) => m && m.type === 'yt-snip:save'));
      if (has) { saved = true; break; }
      const probe = await page.evaluate(() => {
        const host = document.querySelector('#movie_player .yt-snip-host');
        const cap = host && host.shadowRoot ? host.shadowRoot.querySelector('.snip-capture') : null;
        const fill = cap && cap.querySelector('.fill') ? cap.querySelector('.fill').style.width : null;
        const label = cap && cap.querySelector('#yt-snip-cap-label') ? cap.querySelector('#yt-snip-cap-label').textContent : null;
        const v = document.querySelector('#movie_player video');
        return {
          state: window.ytSnip ? window.ytSnip._getState() : 'none',
          label,
          fill,
          paused: v ? v.paused : null,
          t: v ? v.currentTime.toFixed(2) : '?',
          rs: v ? v.readyState : -1,
        };
      });
      log('capture still running: ' + JSON.stringify(probe));
      await page.waitForTimeout(5000);
    }
    if (!saved) throw new Error('yt-snip:save never reached the background boundary (capture stalled?)');
    const byteList = await page.evaluate(() => {
      const m = window.__ytSnipMessages.find((x) => x && x.type === 'yt-snip:save');
      return Array.from(new Uint8Array(m.payload.data));
    });
    const bytes = new Uint8Array(byteList);
    if (bytes.length < 64) throw new Error('live GIF suspiciously small: ' + bytes.length + ' bytes');

    const gif = decodeGif(bytes);
    if (!(gif.width > 0) || !(gif.height > 0)) throw new Error('live GIF has zero dimensions');
    if (!(gif.frames.length >= 1)) throw new Error('live GIF has no frames');
    log(`live capture decoded: ${gif.width}x${gif.height}, ${gif.frames.length} frames`);

    // Disengage restore: assert on the machine's own atomic record (applied in
    // the same tick as the state flip) rather than an external poll — the
    // headless MSE clock rushes forward as soon as playback resumes, so a
    // wall-clock re-read lands seconds away from the restored timestamp.
    const trace = await page.evaluate(() => window.__ytSnipLastRestore || null);
    if (!trace) throw new Error('live restore trace missing (did the save settle?)');
    if (Math.abs(trace.t - trace.target) > 1.5) {
      throw new Error(`live restore failed: target ${trace.target}, restored ${trace.t}`);
    }
    log(`restore verified: target ${trace.target.toFixed(2)} → restored ${trace.t.toFixed(2)} (paused=${trace.paused})`);

    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
    log(`LIVE YT PASS (${elapsed}s)`);
    await browser.close();
    closed = true;
  } finally {
    if (!closed) await browser.close();
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(`\nLIVE YT FAIL: ${err && err.message ? err.message : err}`);
    process.exit(1);
  }
);
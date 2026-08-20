/*
 * test/e2e-chromium/extension.spec.js
 *
 * Tier 3 (B3, PLAN.md) — full end-to-end extension test in Chromium.
 *
 * Playwright cannot drive Firefox extensions, but it CAN load a Chromium
 * extension via a persistent context + --load-extension (new headless).
 * This exercises the pieces the Firefox de-scoped smoke cannot:
 *
 *   - real manifest content-script injection into the page (isolated world)
 *   - the MV3 background as a service worker (prod manifest form)
 *   - the entire snip → save → downloads.download → OS-disk chain
 *   - the Chromium downloads API path (blob URL created in the SW)
 *
 * The downloaded file is read straight off the disk (via CDP
 * Browser.setDownloadBehavior) and real-decoded with the shared validator.
 *
 * Requires the 8123 fixture webServer (shared with the other projects).
 */
'use strict';

const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { test, expect } = require('@playwright/test');
const { chromium } = require('@playwright/test');

const { decodeGif } = require('../helpers/gif-validate');

const ROOT = path.join(__dirname, '..', '..');
// `bare=1` = no page-side stubs (the real extension injects into an isolated
// world). `play=1` = harness keeps the video playing, because headless
// Chromium won't present a paused seek (see harness.html); the yt-snip engine
// pauses before capture, so without playback no frame ever renders.
const HARNESS_URL = 'http://127.0.0.1:8123/watch?bare=1&play=1';

async function buildCrxDir() {
  const tmp = path.join(await fs.promises.mkdtemp(path.join(os.tmpdir(), 'yt-snip-crx-')), 'crx');
  for (const item of ['background.js', 'content', 'lib', 'options', 'offscreen.html', 'offscreen.js']) {
    await fs.promises.cp(path.join(ROOT, item), path.join(tmp, item), { recursive: true });
  }
  await fs.promises.copyFile(
    path.join(ROOT, 'test', 'manifest-chromium.json'),
    path.join(tmp, 'manifest.json')
  );
  return tmp;
}

async function resolveExtensionId(context) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    for (const w of context.serviceWorkers()) {
      const m = /^chrome-extension:\/\/([^/]+)\//.exec(w.url());
      if (m) return m[1];
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return null;
}

async function waitForDownload(downloadDir) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const files = await fs.promises.readdir(downloadDir);
    const matches = files.filter((f) => f.endsWith('.gif') && !f.endsWith('.crdownload'));
    if (matches.length > 0) {
      const withMtime = await Promise.all(
        matches.map(async (m) => ({
          p: path.join(downloadDir, m),
          t: (await fs.promises.stat(path.join(downloadDir, m))).mtimeMs,
        }))
      );
      withMtime.sort((a, b) => b.t - a.t);
      return withMtime[0].p;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return null;
}

test('extension injects, snips, and saves a decodable GIF to the OS download folder', async () => {
  const crx = await buildCrxDir();
  const downloadDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'yt-snip-crx-dl-'));
  const userDataDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'yt-snip-crx-profile-'));

  // `channel: 'chromium'` selects the full Chrome-for-Testing build in new
  // headless mode, which is what supports extensions (the headless shell does
  // not accept --load-extension).
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium',
    headless: true,
    viewport: { width: 900, height: 600 },
    args: [
      `--disable-extensions-except=${crx}`,
      `--load-extension=${crx}`,
      '--mute-audio',
    ],
  });

  try {
    const extId = await resolveExtensionId(context);
    expect(extId, 'extension service worker never spawned').toBeTruthy();

    // Route every download (extension SW included) to a temp dir we control.
    const driverPage = context.pages()[0] || (await context.newPage());
    const cdp = await context.newCDPSession(driverPage);
    await cdp.send('Browser.setDownloadBehavior', {
      behavior: 'allow',
      downloadPath: downloadDir,
      eventsEnabled: false,
    });

    const page = await context.newPage();
    await page.goto(HARNESS_URL, { waitUntil: 'load' });

    // Headless Chromium ignores `downloads.download`'s `filename` (even for
    // http: URLs — the on-disk name comes from Content-Disposition / the URL),
    // so poll the dir for any new .gif and validate the CONTENT, not the name.
    // Named, Anki-ready files are verified in real Firefox by the B1 smoke.

    await expect(page.locator('button.yt-snip-trigger')).toBeVisible({ timeout: 20000 });
    await page.waitForFunction(() => {
      const v = document.querySelector('video.html5-main-video');
      return !!(v && v.readyState >= 2 && isFinite(v.duration) && v.duration > 0 && v.videoWidth > 0);
    }, null, { timeout: 15000 });

    const preActivation = await page.evaluate(() =>
      document.querySelector('video.html5-main-video').currentTime
    );

    await page.locator('button.yt-snip-trigger').click();

    const vbox = await page.evaluate(() => {
      const r = document.querySelector('video.html5-main-video').getBoundingClientRect();
      return { left: r.left, top: r.top, width: r.width, height: r.height };
    });
    expect(vbox.width).toBeGreaterThan(0);
    await page.mouse.move(vbox.left + vbox.width * 0.1, vbox.top + vbox.height * 0.15);
    await page.mouse.down();
    await page.mouse.move(vbox.left + vbox.width * 0.9, vbox.top + vbox.height * 0.85, { steps: 8 });
    await page.mouse.up();

    // The Save button lives in the extension-created shadow root (open shadow
    // DOM is reachable from the page's main world).
    const saved = await page.evaluate(() => {
      const host = document.querySelector('#movie_player .yt-snip-host');
      if (!host || !host.shadowRoot) return false;
      const btn = Array.from(host.shadowRoot.querySelectorAll('.snip-toolbar button'))
        .find((b) => (b.textContent || '').includes('Save'));
      if (!btn) return false;
      btn.click();
      return true;
    });
    expect(saved, 'Save button not found in the extension shadow root').toBe(true);

    const gifFile = await waitForDownload(downloadDir);
    expect(gifFile, 'no GIF download landed on disk').toBeTruthy();

    const bytes = new Uint8Array(await fs.promises.readFile(gifFile));
    expect(bytes.length).toBeGreaterThan(64);
    expect(Buffer.from(bytes.subarray(0, 6)).toString('ascii')).toBe('GIF89a');
    const gif = decodeGif(bytes);
    expect(gif.width).toBeGreaterThan(0);
    expect(gif.height).toBeGreaterThan(0);
    // Headless Chromium only renders ~1–2 fps, so the seek-lenient sweep
    // yields just a couple of distinct frames here (sometimes only one).
    // Frame fidelity (>= 5 distinct frames) is asserted in the Firefox Tier-1
    // e2e and in unit tests; this test proves the full chain (capture →
    // encode → SW → offscreen blob → downloads API → disk → decodable GIF).
    expect(gif.frames.length).toBeGreaterThanOrEqual(1);

    // State-transition rule: tool returned to idle (toolbar hidden) and the
    // video restored to its pre-activation timestamp.
    await expect
      .poll(() =>
        page.evaluate(() => {
          const host = document.querySelector('#movie_player .yt-snip-host');
          if (!host || !host.shadowRoot) return true;
          const toolbar = host.shadowRoot.querySelector('.snip-toolbar');
          return !toolbar || getComputedStyle(toolbar).display === 'none';
        })
      , { timeout: 10000 })
      .toBe(true);

    const restored = await page.evaluate(() =>
      document.querySelector('video.html5-main-video').currentTime
    );
    expect(Math.abs(restored - preActivation)).toBeLessThan(0.5);
  } finally {
    await context.close();
    await fs.promises.rm(crx, { recursive: true, force: true }).catch(() => {});
    await fs.promises.rm(userDataDir, { recursive: true, force: true }).catch(() => {});
    await fs.promises.rm(downloadDir, { recursive: true, force: true }).catch(() => {});
  }
});
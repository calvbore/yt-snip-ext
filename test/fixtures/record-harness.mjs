/*
 * test/fixtures/record-harness.mjs
 *
 * `harness:refresh` recorder. Rewrites the watch-page SHELL inside
 * test/fixtures/harness.html from a LIVE YouTube watch page, so the Tier 1
 * harness stays a faithful mirror of YouTube's player chrome instead of being
 * maintained by hand (see test/fixtures/harness.html shell markers and the
 * "harness recorder" note in PLAN.md).
 *
 * What gets recorded: the minimal skeleton the extension actually touches —
 *   #movie_player, video.html5-main-video (under .html5-video-container),
 *   .ytp-progress-bar (under .ytp-progress-bar-container/.ytp-chrome-bottom),
 *   .ytp-right-controls (under .ytp-chrome-controls) — i.e. nodes on the
 *   ancestor path of those anchors, plus a bounded, shallow sample of the
 *   anchors' first-level children (so buttons/wrappers remain visible when
 *   diffing against reality). CSS, the media-source picker, and the Tier 1/Tier
 *   2 script-wiring blocks of harness.html are left untouched.
 *
 * Opt-in (network): only elements that are structurally reachable from
 * `#movie_player` are kept, the output is node/depth-capped, and SVG subtrees
 * are dropped (harness.css supplies its own button glyphs). Requires a working
 * connection to youtube.com; deterministic given a fixed video URL —
 * `--url <...>` overrides the default test video.
 */
'use strict';

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { firefox } from '@playwright/test';

const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const HARNESS = path.join(ROOT, 'test', 'fixtures', 'harness.html');

const DEFAULT_VIDEO_URL = 'https://www.youtube.com/watch?v=aqz-KE-bpKQ'; // Big Buck Bunny (CC-BY, stable)
const SHELL_START = '<!-- @harness-shell-start -->';
const SHELL_END = '<!-- @harness-shell-end -->';
/**
 * Record only what the extension touches: filter out YouTube's enormous
 * ancillary DOM (ephemeral spinners, menus, captions, svg icons, ...) and
 * return a small, stable HTML string rooted at `#movie_player`.
 *
 * This function is serialized into the page by Playwright, so it must be
 * fully self-contained (no closure references to module constants).
 */
function recordShell(moviePlayer) {
  const MAX_NODES = 300;
  const MAX_DEPTH = 12;
  const SIBLING_CAP = 6;
  const WRAPPERS = ['ytp-chrome-bottom', 'ytp-chrome-controls', 'ytp-progress-bar-container', 'ytp-progress-list'];
  const ATTR_KEEP = ['class', 'id', 'title', 'aria-label', 'aria-expanded', 'aria-haspopup', 'dir', 'role', 'disabled'];

  const attrString = (el) => {
    const parts = [];
    for (const name of ATTR_KEEP) {
      if (!el.hasAttribute(name)) continue;
      const value = el.getAttribute(name);
      parts.push(value === '' ? name : name + '="' + String(value).replace(/"/g, '&quot;') + '"');
    }
    return parts.length ? ' ' + parts.join(' ') : '';
  };

  const anchors = [
    moviePlayer.querySelector('.html5-video-container video'),
    moviePlayer.querySelector('.ytp-progress-bar'),
    moviePlayer.querySelector('.ytp-right-controls'),
  ];
  if (anchors.some((a) => !a)) {
    throw new Error('player shell incomplete: missing video/.ytp-progress-bar/.ytp-right-controls');
  }

  const keep = new Set();
  for (const a of anchors) {
    for (let n = a; n; n = n.parentElement) {
      keep.add(n);
      if (n === moviePlayer) break;
    }
  }

  let count = 0;
  const visit = (el, depth) => {
    if (++count > MAX_NODES || depth > MAX_DEPTH) return null;
    const tag = el.tagName.toLowerCase();
    if (tag === 'svg') return null; // icons come from harness.css

    const onPath = keep.has(el);
    const wrapper = el.classList && !onPath && Array.from(el.classList).some((c) => WRAPPERS.indexOf(c) >= 0);

    const html = ['<' + tag + attrString(el) + '>'];

    let children = Array.from(el.children);
    if (!onPath && !wrapper) {
      // Not needed: emit a void tag so the container shape stays visible in
      // diffs without pulling in YouTube's full subtree.
      children = [];
    } else if (onPath || wrapper) {
      // Anchors/wrappers keep a bounded sample of children so buttons/bars
      // stay visible without recording everything.
      children = children.filter((c, idx) => {
        if (keep.has(c) || (c.classList && Array.from(c.classList).some((x) => WRAPPERS.indexOf(x) >= 0))) return true;
        return wrapper || idx < SIBLING_CAP;
      });
    }

    for (const c of children) {
      const inner = visit(c, depth + 1);
      if (inner !== null) html.push(inner);
    }
    html.push('</' + tag + '>');
    return html.join('');
  };

  return visit(moviePlayer, 0);
}

async function acceptConsent(page) {
  // YouTube shows a consent/bump surface in some locales; best-effort dismiss.
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
      // Some consent walls submit via a form.
      const form = document.querySelector('form input[type="submit"]');
      if (form) { form.click(); return true; }
      return false;
    });
    if (!accepted) break;
    await page.waitForTimeout(1500);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const url =
    (args.find((a) => !a.startsWith('--')) || process.env.HARNESS_RECORD_URL || DEFAULT_VIDEO_URL) ||
    DEFAULT_VIDEO_URL;
  if (args.includes('--help')) {
    console.log('usage: node test/fixtures/record-harness.mjs [--url <youtube watch url>]');
    return;
  }

  const browser = await firefox.launch({ headless: true });
  let closed = false;
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const page = await context.newPage();
    await page.setDefaultTimeout(60000);

    console.log(`[harness:refresh] recording player shell from ${url}`);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForURL(/youtube\.com/, { timeout: 15000 }).catch(() => {});
    await acceptConsent(page);

    await page.waitForSelector('#movie_player', { timeout: 15000 });
    await page.waitForSelector('#movie_player .ytp-progress-bar', { timeout: 15000 });
    await page.waitForSelector('#movie_player .ytp-right-controls', { timeout: 15000 });

    const playerHandle = await page.$('#movie_player');
    const shell = await page.evaluate(recordShell, playerHandle);
    await playerHandle.dispose();
    if (!shell || shell.length < 200) {
      throw new Error('recorded shell too small — player chrome probably not rendered yet');
    }
    await browser.close();
    closed = true;

    const trimmed = shell
      .replace(/\s{2,}/g, ' ')
      .replace(/>\s+</g, '><')
      .trim();

    let html = fs.readFileSync(HARNESS, 'utf8');
    const startIdx = html.indexOf(SHELL_START);
    const endIdx = html.indexOf(SHELL_END);
    if (startIdx < 0 || endIdx < 0) throw new Error('harness.html shell markers not found');
    const indent = '\n    ';
    const block =
      `\n    <!-- recorded ${new Date().toISOString()} from ${url} -->` +
      `${indent}${trimmed}`;
    html = html.slice(0, startIdx + SHELL_START.length) + block + indent + html.slice(endIdx);
    fs.writeFileSync(HARNESS, html);
    console.log(`[harness:refresh] harness.html shell updated (${trimmed.length} chars)`);
  } finally {
    if (!closed) await browser.close();
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(`[harness:refresh] FAIL: ${err && err.message ? err.message : err}`);
    process.exit(1);
  }
);
/*
 * test/e2e/ux.spec.js — Tier 1 coverage for the M11 snip-session UX fixes:
 *
 *   - window blur keeps the session alive (only in-flight drags cancel)
 *   - auto-loop: starting playback by any means loops within the selection
 *   - live playhead: the preview head tracks actual playback
 *   - handle drags coalesce into throttled seeks, flushed on release
 *   - transient degenerate videoWidth/videoHeight cannot resize the rect
 *   - minimap: shows the zoom window against the full duration, jumps on click
 *   - +/- zoom preserves the window center (no sideways view slides)
 */
'use strict';

const { test, expect } = require('@playwright/test');

const h = require('./helpers');

async function engage(page, query) {
  await h.openWatch(page, query);
  await h.startSnip(page);
  await h.dragSelect(page, { x: 40, y: 40 }, { x: 400, y: 220 });
}

test.describe('M11 session UX', () => {
  test('window blur keeps the session; Esc still exits', async ({ page }) => {
    await engage(page);
    await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    await page.waitForTimeout(100);
    expect(await page.evaluate(() => window.ytSnip._getState())).toBe('engaged');
    expect(await h.getZoom(page)).not.toBeNull();
    expect((await h.shadowRect(page, '.snip-toolbar')).display).toBe('flex');

    // The explicit exits are untouched.
    await page.keyboard.press('Escape');
    await expect.poll(() => page.evaluate(() => window.ytSnip._getState())).toBe('idle');
  });

  test('starting playback by any means auto-loops within the selection', async ({ page }) => {
    await engage(page);
    // Narrow the clip to the first half so a wrap is distinguishable from the
    // media's natural end (the default harness does not loop natively).
    await h.dragTimelineHandle(page, 'end', 0.5);
    const clip = await h.getClip(page);

    // Just press play (no Loop click): auto-loop must arm itself…
    // (The edge drag above sought the video; a real user takes a beat
    // before pressing play — and playback starting in a seek's wake is
    // treated as YouTube buffering recovery, not user intent.)
    await page.waitForTimeout(1700);
    await page.evaluate(async () => {
      const v = document.querySelector('video.html5-main-video');
      v.muted = true;
      await v.play().catch(() => {});
    });
    await expect.poll(() => page.evaluate(() => window.ytSnip._isLooping())).toBe(true);
    const label = await page.evaluate(() => {
      const host = document.querySelector('#movie_player .yt-snip-host');
      return [...host.shadowRoot.querySelectorAll('.snip-toolbar button')]
        .map((b) => b.textContent).join('|');
    });
    expect(label).toContain('Loop: on');

    // …and playback must wrap back into the clip instead of running past it.
    await page.evaluate((t) => {
      document.querySelector('video.html5-main-video').currentTime = t;
    }, clip.end - 0.15);
    await expect.poll(() => page.evaluate(() =>
      document.querySelector('video.html5-main-video').currentTime),
      { timeout: 3000 }).toBeLessThan(clip.start + 0.75);
  });

  test('a paused session stays paused when an end-handle drag parks at the edge', async ({ page }) => {
    // Regression: play (arms auto-loop) → pause → drag the end handle. The
    // edge-scrub parks the playhead AT clip.end; tickLoop's media-end
    // exception used to treat "paused at the edge" like "media ended" and
    // fired a wrap+play right after the drag grace expired.
    await engage(page);
    await h.dragTimelineHandle(page, 'end', 0.5);
    const clip = await h.getClip(page);

    // Arm auto-loop by playing, then pause like the user does.
    await page.waitForTimeout(1700);
    await page.evaluate(async () => {
      const v = document.querySelector('video.html5-main-video');
      v.muted = true;
      await v.play().catch(() => {});
    });
    await expect.poll(() => page.evaluate(() => window.ytSnip._isLooping())).toBe(true);
    await page.evaluate(() => document.querySelector('video.html5-main-video').pause());
    await expect.poll(() => page.evaluate(() =>
      document.querySelector('video.html5-main-video').paused)).toBe(true);

    // Drag the end handle again: the release parks the head at the new edge.
    await h.dragTimelineHandle(page, 'end', 0.7);
    const clip2 = await h.getClip(page);
    expect(clip2.end).toBeGreaterThan(clip.end);

    // Well past the wrap grace: nothing may start playing or wrap the head.
    await page.waitForTimeout(800);
    const vState = await page.evaluate(() => {
      const v = document.querySelector('video.html5-main-video');
      return { paused: v.paused, t: v.currentTime };
    });
    expect(vState.paused).toBe(true);
    expect(Math.abs(vState.t - clip2.end)).toBeLessThan(0.1);
    expect(await page.evaluate(() => window.ytSnip._getState())).toBe('engaged');
  });

  test('the preview head tracks playback on its own', async ({ page }) => {
    await engage(page);
    await h.dragTimelineHandle(page, 'end', 0.5);
    const clip = await h.getClip(page);

    // Let the drag-seek settle so the play below isn't ghost-classified.
    await page.waitForTimeout(1700);
    await page.evaluate(async () => {
      const v = document.querySelector('video.html5-main-video');
      v.muted = true;
      await v.play().catch(() => {});
    });
    await page.evaluate((t) => {
      document.querySelector('video.html5-main-video').currentTime = t;
    }, Math.min(clip.start + 0.8, clip.end - 0.5));

    // Without touching any handle, clip.preview must follow playback…
    await expect.poll(() => h.getClip(page).then((c) => c.preview), { timeout: 4000 })
      .toBeGreaterThan(clip.start + 1.0);
    // …and stay inside the selection.
    const c = await h.getClip(page);
    expect(c.preview).toBeLessThanOrEqual(c.end + 1e-6);
    expect(c.preview).toBeGreaterThanOrEqual(c.start - 1e-6);
  });

  test('handle drags coalesce seeks (throttle) and flush the final value', async ({ page }) => {
    await h.openWatch(page);
    // Count currentTime writes from the page world (same world as the
    // content scripts in Tier 1).
    await page.evaluate(() => {
      const v = document.querySelector('video.html5-main-video');
      // Walk the prototype chain: Firefox defines currentTime on
      // HTMLMediaElement.prototype, not on the immediate video prototype.
      let desc = null;
      let o = Object.getPrototypeOf(v);
      while (o && !desc) {
        desc = Object.getOwnPropertyDescriptor(o, 'currentTime');
        if (!desc) o = Object.getPrototypeOf(o);
      }
      window.__seekCount = 0;
      Object.defineProperty(v, 'currentTime', {
        get() { return desc.get.call(this); },
        set(x) { window.__seekCount++; desc.set.call(this, x); },
        configurable: true,
      });
    });
    await h.startSnip(page);
    await h.dragSelect(page, { x: 30, y: 30 }, { x: 400, y: 180 });

    // Drag the preview handle across the bar in small delayed steps — the
    // unthrottled code would write currentTime once per pointermove.
    const pos = await page.evaluate(() => {
      const host = document.querySelector('#movie_player .yt-snip-host');
      const handle = host.shadowRoot.querySelector('.snip-tl-handle[data-role="preview"]');
      const r = handle.getBoundingClientRect();
      const bar = document.querySelector('#movie_player .ytp-progress-bar').getBoundingClientRect();
      return { x1: r.left + r.width / 2, y: r.top + r.height / 2, x2: bar.left + bar.width * 0.7 };
    });
    const before = await page.evaluate(() => window.__seekCount);
    await page.mouse.move(pos.x1, pos.y);
    await page.mouse.down();
    const t0 = Date.now();
    for (let i = 1; i <= 10; i++) {
      await page.mouse.move(pos.x1 + (pos.x2 - pos.x1) * (i / 10), pos.y);
      await page.waitForTimeout(45);
    }
    await page.mouse.up();
    const elapsed = Date.now() - t0;

    const writes = await page.evaluate(() => window.__seekCount) - before;
    // 1 (handle-down seek) + at most one staged seek per ~120 ms + 1 flush.
    expect(writes).toBeLessThanOrEqual(Math.ceil(elapsed / 120) + 3);
    // The flush committed the final handle position to the video.
    const clip = await h.getClip(page);
    const duration = await page.evaluate(() =>
      document.querySelector('video.html5-main-video').duration);
    expect(Math.abs(clip.preview - 0.7 * duration)).toBeLessThan(duration * 0.08);
    const t = await page.evaluate(() =>
      document.querySelector('video.html5-main-video').currentTime);
    expect(Math.abs(t - clip.preview)).toBeLessThan(duration * 0.08);
  });

  test('a degenerate videoWidth glitch cannot resize the selection rect', async ({ page }) => {
    await engage(page);
    const boxA = await h.shadowRect(page, '.snip-rect');

    // Simulate a buffering/stream-reload glitch: intrinsic size collapses.
    await page.evaluate(() => {
      const v = document.querySelector('video.html5-main-video');
      for (const prop of ['videoWidth', 'videoHeight']) {
        Object.defineProperty(v, prop, { get: () => 0, configurable: true });
      }
    });
    // Let the rAF loop redraw several times with the broken dims.
    await page.waitForTimeout(150);

    const boxB = await h.shadowRect(page, '.snip-rect');
    expect(Math.abs(boxB.left - boxA.left)).toBeLessThan(1.5);
    expect(Math.abs(boxB.top - boxA.top)).toBeLessThan(1.5);
    expect(Math.abs(boxB.width - boxA.width)).toBeLessThan(1.5);
    expect(Math.abs(boxB.height - boxA.height)).toBeLessThan(1.5);
  });

  test('minimap mirrors the window against the full duration and jumps on click', async ({ page }) => {
    await engage(page, { query: { duration: '3600' } });

    const mini = await h.shadowRect(page, '.snip-mini');
    const strip = await h.shadowRect(page, '.snip-zoom');
    const barTop = await page.evaluate(() =>
      document.querySelector('#movie_player .ytp-progress-bar').getBoundingClientRect().top);
    expect(mini.display).toBe('block');
    // Stacked between the detail strip and the progress bar.
    expect(mini.top).toBeGreaterThan(strip.top + strip.height - 1);
    expect(mini.top + mini.height).toBeLessThanOrEqual(barTop);

    const winBox = () => page.evaluate(() => {
      const host = document.querySelector('#movie_player .yt-snip-host');
      const w = host.shadowRoot.querySelector('.snip-mini-win');
      return { left: parseFloat(w.style.left), width: parseFloat(w.style.width) };
    });

    // '+' halves the span → the bracket halves with it.
    const w0 = await winBox();
    expect(await h.clickZoomCtl(page, '+')).toBe(true);
    await expect.poll(async () => (await winBox()).width).toBeCloseTo(w0.width / 2, 0);

    // Click at 80% of the full duration: the window recenters there,
    // preserving its span.
    const zwBefore = await h.getZoom(page);
    const spot = await page.evaluate(() => {
      const host = document.querySelector('#movie_player .yt-snip-host');
      const m = host.shadowRoot.querySelector('.snip-mini-body').getBoundingClientRect();
      return { x: m.left + m.width * 0.8, y: m.top + m.height / 2 };
    });
    await page.mouse.click(spot.x, spot.y);
    await expect.poll(async () => {
      const z = await h.getZoom(page);
      return z.end - z.start;
    }).toBeCloseTo(zwBefore.end - zwBefore.start, 3);
    await expect.poll(async () => (await h.getZoom(page)).start)
      .toBeGreaterThan(zwBefore.start);
  });

  test('+/- zoom preserves the window center', async ({ page }) => {
    await engage(page, { query: { duration: '3600' } });
    const zw0 = await h.getZoom(page);
    expect(await h.clickZoomCtl(page, '+')).toBe(true);
    let zw1 = await h.getZoom(page);
    expect((zw1.end - zw1.start)).toBeCloseTo((zw0.end - zw0.start) / 2, 3);
    expect((zw1.start + zw1.end) / 2).toBeCloseTo((zw0.start + zw0.end) / 2, 1);

    expect(await h.clickZoomCtl(page, '\u2212')).toBe(true);
    await expect.poll(async () => {
      const z = await h.getZoom(page);
      return z.end - z.start;
    }).toBeCloseTo(zw0.end - zw0.start, 3);
    const zw2 = await h.getZoom(page);
    expect((zw2.start + zw2.end) / 2).toBeCloseTo((zw0.start + zw0.end) / 2, 1);
  });
});

test.describe('M13 exit behavior + origin marker', () => {
  test('any exit ends paused — saving while activated mid-playback pauses', async ({ page }) => {
    await h.openWatch(page);
    await page.evaluate(async () => {
      const v = document.querySelector('video.html5-main-video');
      v.muted = true;
      await v.play().catch(() => {});
    });
    await expect.poll(() => page.evaluate(() =>
      !document.querySelector('video.html5-main-video').paused)).toBe(true);

    await h.startSnip(page); // the tool pauses on activate; snapshot says "playing"
    await h.dragSelect(page, { x: 60, y: 40 }, { x: 380, y: 200 });

    // Arm the restore trace seam and save through the real flow.
    await page.evaluate(() => { window.__ytSnipTrace = true; });
    expect(await h.clickToolbar(page, 'Save')).toBe(true);
    await page.waitForFunction(() =>
      window.__ytSnipMessages.some((m) => m && m.type === 'yt-snip:save'),
      null, { timeout: 30000 });
    await page.waitForFunction(() => window.__ytSnipLastRestore, null, { timeout: 30000 });
    await expect.poll(() => page.evaluate(() => window.ytSnip._getState())).toBe('idle');

    const st = await page.evaluate(() => {
      const v = document.querySelector('video.html5-main-video');
      return { paused: v.paused, t: v.currentTime, target: window.__ytSnipLastRestore.target };
    });
    expect(st.paused).toBe(true);
    expect(Math.abs(st.t - st.target)).toBeLessThan(0.3);
  });

  test('the origin tick marks the activation timestamp on both bars', async ({ page }) => {
    await h.openWatch(page);
    await page.evaluate(() => {
      document.querySelector('video.html5-main-video').currentTime = 2;
    });
    await h.startSnip(page);
    await h.dragSelect(page, { x: 60, y: 40 }, { x: 380, y: 200 });

    const readTick = () => page.evaluate(() => {
      const host = document.querySelector('#movie_player .yt-snip-host');
      const el = host.shadowRoot.querySelector('.snip-timeline .snip-origin');
      return { display: el.style.display, left: parseFloat(el.style.left) };
    });
    const tick0 = await readTick();
    expect(tick0.display).toBe('block');

    // The tick sits at activation time (2s of the fixture duration).
    const geo = await page.evaluate(() => {
      const host = document.querySelector('#movie_player .yt-snip-host');
      const tl = host.shadowRoot.querySelector('.snip-timeline').getBoundingClientRect();
      const d = document.querySelector('video.html5-main-video').duration;
      return { w: tl.width, d };
    });
    expect(Math.abs(tick0.left - (2 / geo.d) * geo.w)).toBeLessThan(2);

    // Edge drag parks the playhead elsewhere; the origin tick does not move.
    await h.dragTimelineHandle(page, 'end', 0.9);
    let tick = await readTick();
    expect(Math.abs(tick.left - tick0.left)).toBeLessThan(1);

    // Preview drag likewise.
    await h.dragTimelineHandle(page, 'preview', 0.5);
    tick = await readTick();
    expect(Math.abs(tick.left - tick0.left)).toBeLessThan(1);

    // Strip tick mirrors the origin while the window contains it…
    expect(await page.evaluate(() => {
      const host = document.querySelector('#movie_player .yt-snip-host');
      return host.shadowRoot.querySelector('.snip-zoom .snip-origin').style.display;
    })).toBe('block');

    // …and hides once the window is panned away from it (bar tick persists).
    await h.clickZoomCtl(page, '+');
    await h.clickZoomCtl(page, '+');
    const mini = await page.evaluate(() => {
      const host = document.querySelector('#movie_player .yt-snip-host');
      const b = host.shadowRoot.querySelector('.snip-mini').getBoundingClientRect();
      return { x: b.left + b.width * 0.97, y: b.top + b.height / 2 };
    });
    await page.mouse.click(mini.x, mini.y);
    expect(await page.evaluate(() => {
      const host = document.querySelector('#movie_player .yt-snip-host');
      return host.shadowRoot.querySelector('.snip-zoom .snip-origin').style.display;
    })).toBe('none');
    expect((await readTick()).display).toBe('block');
  });
});

test.describe('M13 default selection', () => {
  test('engaging defaults the selection to ±3 s around the activation time', async ({ page }) => {
    await h.openWatch(page);

    // Activate near the end of the 5 s fixture: window clamps at the end.
    await page.evaluate(() => {
      document.querySelector('video.html5-main-video').currentTime = 4;
    });
    await h.startSnip(page);
    await h.dragSelect(page, { x: 60, y: 40 }, { x: 380, y: 200 });
    let clip = await h.getClip(page);
    expect(Math.abs(clip.start - 1)).toBeLessThan(0.3);
    expect(Math.abs(clip.end - 5)).toBeLessThan(0.3);

    // Re-engage near the start: window clamps at zero.
    await page.keyboard.press('Escape');
    await expect.poll(() => page.evaluate(() => window.ytSnip._getState())).toBe('idle');
    await page.evaluate(() => {
      document.querySelector('video.html5-main-video').currentTime = 1;
    });
    await h.startSnip(page);
    await h.dragSelect(page, { x: 60, y: 40 }, { x: 380, y: 200 });
    clip = await h.getClip(page);
    expect(Math.abs(clip.start - 0)).toBeLessThan(0.3);
    expect(Math.abs(clip.end - 4)).toBeLessThan(0.3);
  });

  test('the start/end padding is independently configurable', async ({ page }) => {
    // Asymmetric pads (1 s before, 2 s after) must beat both the defaults
    // (3 s each) and each other: seek to 2 on the 5 s fixture → [1, 4].
    await h.openWatch(page, { options: { clipPadStart: 1, clipPadEnd: 2 } });
    await page.evaluate(() => {
      document.querySelector('video.html5-main-video').currentTime = 2;
    });
    await h.startSnip(page);
    await h.dragSelect(page, { x: 60, y: 40 }, { x: 380, y: 200 });
    const clip = await h.getClip(page);
    expect(Math.abs(clip.start - 1)).toBeLessThan(0.3);
    expect(Math.abs(clip.end - 4)).toBeLessThan(0.3);
  });
});

/*
 * test/e2e/ux.spec.js — Tier 1 coverage for the M11 snip-session UX fixes:
 *
 *   - window blur keeps the session alive (only in-flight drags cancel)
 *   - auto-loop: starting playback by any means loops within the selection
 *   - live playhead: the preview head tracks actual playback
 *   - handle drags coalesce into throttled seeks, flushed on release
 *   - transient degenerate videoWidth/videoHeight cannot resize the rect
 *   - M15 scrubber: overlays the progress bar; track clicks jump the window;
 *     bracket grips resize zoom; band click refits; band drag relocates
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

    // Drag the preview handle across the strip in small delayed steps —
    // the unthrottled code would write currentTime once per pointermove.
    // Fit first so 70% of the strip maps to 70% of the duration (M15).
    await h.clickZoomCtl(page, 'Fit');
    const pos = await page.evaluate(() => {
      const host = document.querySelector('#movie_player .yt-snip-host');
      const handle = host.shadowRoot.querySelector('.snip-zoom .snip-tl-handle[data-role="preview"]');
      const r = handle.getBoundingClientRect();
      const s = host.shadowRoot.querySelector('.snip-zoom').getBoundingClientRect();
      return { x1: r.left + r.width / 2, y: r.top + r.height / 2, x2: s.left + s.width * 0.7 };
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

  test('the scrubber overlays the progress bar and jumps the window on track clicks', async ({ page }) => {
    await engage(page, { query: { duration: '3600' } });

    const scrub = await h.shadowRect(page, '.snip-scrub');
    const strip = await h.shadowRect(page, '.snip-zoom');
    const bar = await page.evaluate(() => {
      const b = document.querySelector('#movie_player .ytp-progress-bar')
        .getBoundingClientRect();
      return { top: b.top, bottom: b.bottom };
    });
    expect(scrub.display).toBe('block');
    // M15: centered ON the progress bar line (the pill is taller than the
    // native bar, so it may overhang); the strip stays above the scrubber.
    const barMid = (bar.top + bar.bottom) / 2;
    expect(Math.abs(scrub.top + scrub.height / 2 - barMid)).toBeLessThan(2);
    expect(scrub.top).toBeGreaterThanOrEqual(bar.top - 10);
    expect(strip.top + strip.height).toBeLessThanOrEqual(scrub.top);

    const winBox = () => page.evaluate(() => {
      const host = document.querySelector('#movie_player .yt-snip-host');
      const w = host.shadowRoot.querySelector('.snip-scrub-win');
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
      const m = host.shadowRoot.querySelector('.snip-scrub-body').getBoundingClientRect();
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

  test('scrubber bracket grips resize the zoom window from their edge', async ({ page }) => {
    await engage(page, { query: { duration: '3600' } });
    expect(await h.clickZoomCtl(page, 'Fit')).toBe(true);
    const zw0 = await h.getZoom(page);
    expect(zw0.end - zw0.start).toBeCloseTo(3600, 0);

    // Drag the right grip left by ~25% of the scrubber width: the end edge
    // follows the pointer while the start stays anchored.
    const grip = await page.evaluate(() => {
      const host = document.querySelector('#movie_player .yt-snip-host');
      const g = host.shadowRoot.querySelector('.snip-scrub-grip.right').getBoundingClientRect();
      const w = host.shadowRoot.querySelector('.snip-scrub-win').getBoundingClientRect();
      return { x: g.left + g.width / 2, y: g.top + g.height / 2, winLeft: w.left, winW: w.width };
    });
    await h.mouseDrag(page, grip.x, grip.y, grip.winLeft + grip.winW * 0.75, grip.y);

    const zw1 = await h.getZoom(page);
    expect(zw1.end - zw1.start).toBeCloseTo(3600 * 0.75, 0);
    expect(zw1.start).toBeCloseTo(zw0.start, 0);

    // Left grip back out past the start: clamps at zero, min-span holds.
    const gripL = await page.evaluate(() => {
      const host = document.querySelector('#movie_player .yt-snip-host');
      const g = host.shadowRoot.querySelector('.snip-scrub-grip.left').getBoundingClientRect();
      return { x: g.left + g.width / 2, y: g.top + g.height / 2 };
    });
    await h.mouseDrag(page, gripL.x, gripL.y, gripL.x - 4000, gripL.y);
    const zw2 = await h.getZoom(page);
    expect(zw2.start).toBeCloseTo(0, 0);
    expect(zw2.end).toBeCloseTo(zw1.end, 0);
  });

  test('clicking the scrubber band snaps the view back around the clip', async ({ page }) => {
    // Engage mid-video so the clip band sits clear of the bracket grips.
    await h.openWatch(page, { query: { duration: '3600' } });
    await page.evaluate(() => {
      document.querySelector('video.html5-main-video').currentTime = 1800;
    });
    await h.startSnip(page);
    await h.dragSelect(page, { x: 60, y: 40 }, { x: 380, y: 200 });

    // Pan the window far right of the clip first (track click at ~90%).
    const spot = await page.evaluate(() => {
      const host = document.querySelector('#movie_player .yt-snip-host');
      const m = host.shadowRoot.querySelector('.snip-scrub-body').getBoundingClientRect();
      return { x: m.left + m.width * 0.9, y: m.top + m.height / 2 };
    });
    await page.mouse.click(spot.x, spot.y);
    await expect.poll(async () => {
      const z = await h.getZoom(page);
      const c = await h.getClip(page);
      return z.start > c.end ? 'away' : 'near';
    }).toBe('away');

    // A clean click on the band refits the window around the clip.
    const bandSpot = await page.evaluate(() => {
      const host = document.querySelector('#movie_player .yt-snip-host');
      const b = host.shadowRoot.querySelector('.snip-scrub-band').getBoundingClientRect();
      return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
    });
    await page.mouse.click(bandSpot.x, bandSpot.y);
    await expect.poll(async () => {
      const z = await h.getZoom(page);
      const c = await h.getClip(page);
      return z.start <= c.start && z.end >= c.end ? 'around' : 'off';
    }).toBe('around');
    // A click must not have edited the clip itself.
    const c = await h.getClip(page);
    expect(c.end - c.start).toBeCloseTo(6, 1); // default ±3 s pad
  });

  test('dragging the scrubber band relocates the clip rigidly and seeks on release', async ({ page }) => {
    // Engage mid-video so the band is grabbable clear of the grips.
    await h.openWatch(page, { query: { duration: '3600' } });
    await page.evaluate(() => {
      document.querySelector('video.html5-main-video').currentTime = 1000;
    });
    await h.startSnip(page);
    await h.dragSelect(page, { x: 60, y: 40 }, { x: 380, y: 200 });
    // Fit so the bracket spans the whole track and the ±3 s band (~28%)
    // sits clear of its grips.
    expect(await h.clickZoomCtl(page, 'Fit')).toBe(true);
    const before = await h.getClip(page);
    expect(before.end - before.start).toBeCloseTo(6, 1); // sanity: mid-clip
    const span0 = before.end - before.start;

    // Drag the band right by 20% of the scrubber width (= 720 s here).
    const drag = await page.evaluate(() => {
      const host = document.querySelector('#movie_player .yt-snip-host');
      const b = host.shadowRoot.querySelector('.snip-scrub-band').getBoundingClientRect();
      const s = host.shadowRoot.querySelector('.snip-scrub-body').getBoundingClientRect();
      return {
        x1: b.left + b.width / 2, y: b.top + b.height / 2,
        x2: b.left + b.width / 2 + s.width * 0.2,
      };
    });
    await h.mouseDrag(page, drag.x1, drag.y, drag.x2, drag.y);

    const after = await h.getClip(page);
    // Rigid move: same span, both edges shifted by the same amount…
    expect(after.end - after.start).toBeCloseTo(span0, 3);
    const shift = after.start - before.start;
    expect(shift).toBeGreaterThan(600); // ≈ 0.2 × 3600 minus clamp slop
    expect(after.end - before.end).toBeCloseTo(shift, 0);
    // …with one seek on release parking the playhead at the new start.
    const t = await page.evaluate(() =>
      document.querySelector('video.html5-main-video').currentTime);
    expect(Math.abs(t - after.start)).toBeLessThan(0.05);
    expect(after.preview).toBeCloseTo(after.start, 3);

    // The detail window followed the relocated clip.
    const z = await h.getZoom(page);
    expect(z.start).toBeLessThanOrEqual(after.start);
    expect(z.end).toBeGreaterThanOrEqual(after.end);
  });

  test('dragging the strip band translates the clip through the window mapping', async ({ page }) => {
    // Engage mid-video (virtualized timeline) so the band clears the
    // handles, then fit so the window mapping is linear across the track.
    await h.openWatch(page, { query: { duration: '3600' } });
    await page.evaluate(() => {
      document.querySelector('video.html5-main-video').currentTime = 1800;
    });
    await h.startSnip(page);
    await h.dragSelect(page, { x: 60, y: 40 }, { x: 380, y: 200 });
    // Widen the clip (moves the preview handle off the band's center) and
    // re-fit so the band sits clear of every handle and grip.
    await h.dragTimelineHandle(page, 'end', 0.75);
    expect(await h.clickZoomCtl(page, 'Fit')).toBe(true);
    const before = await h.getClip(page);
    expect(before.end - before.start).toBeGreaterThan(500); // widened clip
    const span0 = before.end - before.start;

    const drag = await page.evaluate(() => {
      const host = document.querySelector('#movie_player .yt-snip-host');
      const band = host.shadowRoot.querySelector('.snip-zl-band').getBoundingClientRect();
      return { x1: band.left + band.width / 2, y: band.top + band.height / 2 };
    });
    // +100 px on a fitted 3600 s window maps to ≈ +100/width × 3600 s.
    const width = await page.evaluate(() => {
      const host = document.querySelector('#movie_player .yt-snip-host');
      return host.shadowRoot.querySelector('.snip-zoom').getBoundingClientRect().width;
    });
    await h.mouseDrag(page, drag.x1, drag.y, drag.x1 + 100, drag.y);

    const after = await h.getClip(page);
    const expectedDt = (100 / width) * 3600;
    expect(after.start - before.start).toBeGreaterThan(expectedDt * 0.7);
    expect(after.start - before.start).toBeLessThan(expectedDt * 1.3);
    expect(after.end - after.start).toBeCloseTo(span0, 3);
    // Seek-on-release parks at the translated start.
    const t = await page.evaluate(() =>
      document.querySelector('video.html5-main-video').currentTime);
    expect(Math.abs(t - after.start)).toBeLessThan(0.05);
  });

  test('holding a strip band drag at the strip edge auto-pans the window', async ({ page }) => {
    // Engage mid-video, then zoom out twice so the clip band is ~18% of the
    // strip wide — clear interior between the handles to grab.
    await h.openWatch(page, { query: { duration: '3600' } });
    await page.evaluate(() => {
      document.querySelector('video.html5-main-video').currentTime = 1800;
    });
    await h.startSnip(page);
    await h.dragSelect(page, { x: 60, y: 40 }, { x: 380, y: 200 });
    expect(await h.clickZoomCtl(page, '\u2212')).toBe(true);
    expect(await h.clickZoomCtl(page, '\u2212')).toBe(true);
    const zw0 = await h.getZoom(page);

    // Grab the band's interior (a quarter point in from its start edge,
    // clear of every handle) and drag it to just inside the LEFT edge,
    // then hold: translate drags auto-pan the window under the cursor.
    const grab = await page.evaluate(() => {
      const host = document.querySelector('#movie_player .yt-snip-host');
      const strip = host.shadowRoot.querySelector('.snip-zoom');
      const band = strip.querySelector('.snip-zl-band').getBoundingClientRect();
      return {
        x1: band.left + band.width * 0.25, y: band.top + band.height / 2,
        x2: strip.getBoundingClientRect().left + 8,
      };
    });
    await page.mouse.move(grab.x1, grab.y);
    await page.mouse.down();
    await page.mouse.move(grab.x2, grab.y, { steps: 10 });
    for (let i = 0; i < 22; i++) {
      await page.mouse.move(grab.x2 + (i % 2), grab.y); // tiny jitters keep moves flowing
      await page.waitForTimeout(60);
    }
    await page.mouse.up();

    const zw1 = await h.getZoom(page);
    expect(zw1.start).toBeLessThan(zw0.start - 4);
    // Span preserved by panning.
    expect(zw1.end - zw1.start).toBeCloseTo(zw0.end - zw0.start, 0);
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

    const readTick = (sel) => page.evaluate((s) => {
      const host = document.querySelector('#movie_player .yt-snip-host');
      const el = host.shadowRoot.querySelector(s);
      return { display: el.style.display, left: parseFloat(el.style.left) };
    }, sel);
    const STRIP_TICK = '.snip-zoom .snip-origin';
    const BAR_TICK = '.snip-scrub-origin';

    // The strip carries the tick — and so does the pill riding on
    // YouTube's progress bar.
    const tick0 = await readTick(STRIP_TICK);
    expect(tick0.display).toBe('block');
    const barTick0 = await readTick(BAR_TICK);
    expect(barTick0.display).toBe('block');

    // The pill's tick sits at activation time as a full-duration fraction.
    const dur = await page.evaluate(() =>
      document.querySelector('video.html5-main-video').duration);
    const scrubW = await page.evaluate(() => {
      const host = document.querySelector('#movie_player .yt-snip-host');
      return host.shadowRoot.querySelector('.snip-scrub').getBoundingClientRect().width;
    });
    expect(barTick0.left).toBeCloseTo((2 / dur) * scrubW, 0);

    // Edge drag parks the playhead elsewhere; neither tick moves.
    // (0.75, not nearer the end: a fully-clamped end handle hides beneath
    // the zoom controls' hover zone at the strip's right edge.)
    await h.dragTimelineHandle(page, 'end', 0.75);
    let tick = await readTick(STRIP_TICK);
    let barTick = await readTick(BAR_TICK);
    expect(Math.abs(tick.left - tick0.left)).toBeLessThan(1);
    expect(Math.abs(barTick.left - barTick0.left)).toBeLessThan(1);

    // Preview drag likewise.
    await h.dragTimelineHandle(page, 'preview', 0.5);
    tick = await readTick(STRIP_TICK);
    barTick = await readTick(BAR_TICK);
    expect(Math.abs(tick.left - tick0.left)).toBeLessThan(1);
    expect(Math.abs(barTick.left - barTick0.left)).toBeLessThan(1);

    // Zoom in hard around a spot far from t=2: once the activation time
    // leaves the magnified window, the strip tick hides…
    await h.clickZoomCtl(page, '+');
    await h.clickZoomCtl(page, '+');
    const mini = await page.evaluate(() => {
      const host = document.querySelector('#movie_player .yt-snip-host');
      const b = host.shadowRoot.querySelector('.snip-scrub-body').getBoundingClientRect();
      return { x: b.left + b.width * 0.97, y: b.top + b.height / 2 };
    });
    await page.mouse.click(mini.x, mini.y);
    await expect.poll(() => readTick(STRIP_TICK)).toMatchObject({ display: 'none' });

    // …while the pill's tick persists — that is its whole point…
    expect((await readTick(BAR_TICK)).display).toBe('block');

    // …and a band click snaps the view back around the clip (t=2 inside),
    // bringing the strip tick back too.
    const bandSpot = await page.evaluate(() => {
      const host = document.querySelector('#movie_player .yt-snip-host');
      const b = host.shadowRoot.querySelector('.snip-scrub-band').getBoundingClientRect();
      return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
    });
    await page.mouse.click(bandSpot.x, bandSpot.y);
    await expect.poll(async () => {
      const z = await page.evaluate(() => window.ytSnip._getZoom());
      return z.start <= 2 && z.end >= 2;
    }).toBe(true);
    await expect.poll(() => readTick(STRIP_TICK)).toMatchObject({ display: 'block' });
    expect((await readTick(BAR_TICK)).display).toBe('block');
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

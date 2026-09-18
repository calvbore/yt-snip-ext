'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { scheduledFrames } = require('../../lib/scheduler.js');

/**
 * A fake capture source whose seeks land EXACTLY (all-keyframe fixture
 * behavior). `landFunc` can override the landing for seek-lenient scenarios.
 */
function exactSource({ start = 0, end = 3, fps = 30, epsilon = 0 } = {}) {
  const seeks = [];
  let cancelled = false;
  const source = {
    seeks,
    cancel: () => { cancelled = true; },
    async seek(t) {
      seeks.push(t);
      source._land = t;
    },
    async waitRendered() {
      return cancelled ? null : source._land;
    },
  };
  return source;
}

test('scheduler: emits a frame per target at the requested fps (exact seeks)', async () => {
  const source = exactSource({ start: 0, end: 1, fps: 4 });
  const frames = [];
  for await (const f of scheduledFrames(source, { start: 0, end: 1, fps: 4 })) {
    frames.push(f);
  }
  assert.deepEqual(frames.map((f) => f.target), [0, 0.25, 0.5, 0.75, 1]);
  assert.deepEqual(frames.map((f) => f.media), frames.map((f) => f.target));
});

test('scheduler: stops after media reaches end', async () => {
  const source = exactSource({ start: 0, end: 0.5, fps: 2 });
  const frames = [];
  for await (const f of scheduledFrames(source, { start: 0, end: 0.5, fps: 2 })) frames.push(f);
  assert.equal(frames.length, 2); // t=0 and t=0.5
});

test('scheduler: dedups repeated mediaTimes (coarse keyframes)', async () => {
  // Every seek lands on the same keyframe (t=1) until target passes 1.
  const seeks = [];
  const source = {
    seeks,
    async seek(t) {
      seeks.push(t);
      source._land = 1;
    },
    async waitRendered() {
      return source._land;
    },
  };
  const frames = [];
  for await (const f of scheduledFrames(source, { start: 0, end: 3, fps: 5 })) {
    frames.push(f);
  }
  // Only ONE distinct media (1.0) should be emitted; target must jump past it.
  assert.equal(frames.length, 1);
  assert.equal(frames[0].media, 1);
  assert.ok(seeks.some((t) => t > 1), 'target advanced past the landed keyframe');
});

test('scheduler: filters frames whose mediaTime falls outside the window', async () => {
  // Seek lands far outside the clip window → skipped entirely.
  const source = {
    async seek(t) { source._land = 100; },
    async waitRendered() { return source._land; },
  };
  const frames = [];
  for await (const f of scheduledFrames(source, { start: 0, end: 2, fps: 2 })) frames.push(f);
  assert.equal(frames.length, 0);
});

test('scheduler: tolerates small epsilon for MSE roundoff', async () => {
  const seeks = [];
  const source = {
    seeks,
    async seek(t) { seeks.push(t); source._land = t + 0.01; },
    async waitRendered() { return source._land; },
  };
  const frames = [];
  for await (const f of scheduledFrames(source, { start: 0, end: 1, fps: 4, epsilon: 0.03 })) {
    frames.push(f);
  }
  assert.equal(frames.length, 5);
});

test('scheduler: aborts when waitRendered returns null', async () => {
  let calls = 0;
  const source = {
    async seek() { calls++; },
    async waitRendered() { return calls === 2 ? null : 0; },
  };
  const frames = [];
  for await (const f of scheduledFrames(source, { start: 0, end: 5, fps: 1 })) frames.push(f);
  assert.equal(frames.length, 1); // first frame (t=0) then abort
});

/* ---- M17 hold mode (slow motion) ----------------------------------- */

test('scheduler: hold mode emits repeated mediaTimes as separate samples', () => {
  return (async () => {
    // Coarse keyframes: every seek within a 1 s keyframe interval lands on the
    // same mediaTime. Default mode dedups (1 sample); hold mode must emit one
    // sample per target so slow-mo doesn't collapse to 1×.
    const seeks = [];
    const source = {
      seeks,
      async seek(t) { seeks.push(t); source._land = Math.floor(t); },
      async waitRendered() { return source._land; },
    };
    const frames = [];
    for await (const f of scheduledFrames(source, { start: 0, end: 3, fps: 5, hold: true })) {
      frames.push(f);
    }
    assert.equal(frames.length, 16); // targets 0..3 step 0.2
    // The slow-mo timeline: media stays flat per keyframe and strictly
    // increases across keyframe boundaries.
    const media = frames.map((f) => f.media);
    for (let k = 1; k < media.length; k++) {
      assert.ok(media[k] >= media[k - 1], 'media went backwards in hold mode');
    }
    assert.deepEqual(
      Array.from(new Set(media)),
      [0, 1, 2, 3]
    );
  })();
});

test('scheduler: hold mode advances the target strictly by dt (no jump-past)', () => {
  return (async () => {
    const seeks = [];
    const source = {
      seeks,
      async seek(t) { seeks.push(t); source._land = t; },
      async waitRendered() { return source._land; },
    };
    const targets = [];
    for await (const f of scheduledFrames(source, { start: 0, end: 1, fps: 4, hold: true })) {
      targets.push(f.target);
    }
    assert.deepEqual(targets, [0, 0.25, 0.5, 0.75, 1]);
  })();
});

test('scheduler: hold mode still breaks on null renders and out-of-window jumps', () => {
  return (async () => {
    let calls = 0;
    const source = {
      async seek() { calls++; },
      async waitRendered() { return calls === 3 ? null : Math.floor(calls - 1); },
    };
    const frames = [];
    for await (const f of scheduledFrames(source, { start: 0, end: 5, fps: 1, hold: true })) {
      frames.push(f);
    }
    assert.equal(frames.length, 2); // two samples, then the null abort

    const far = {
      async seek() { far._land = 99; },
      async waitRendered() { return far._land; },
    };
    const none = [];
    for await (const f of scheduledFrames(far, { start: 0, end: 2, fps: 2, hold: true })) none.push(f);
    assert.equal(none.length, 0);
  })();
});

test('scheduler: default mode is unchanged (no hold option)', () => {
  return (async () => {
    const seeks = [];
    const source = {
      seeks,
      async seek(t) { seeks.push(t); source._land = Math.floor(t); },
      async waitRendered() { return source._land; },
    };
    const frames = [];
    for await (const f of scheduledFrames(source, { start: 0, end: 3, fps: 5 })) {
      frames.push(f);
    }
    assert.equal(frames.length, 3); // the pre-M17 dedup behavior
    assert.deepEqual(frames.map((f) => f.media), [0, 1, 2]);
  })();
});
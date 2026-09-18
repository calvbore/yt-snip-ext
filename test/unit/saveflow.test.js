'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const saveflow = require('../../lib/saveflow.js');

const CROP = { x: 0, y: 0, w: 0.5, h: 0.5 };
const OUT = { w: 256, h: 256 };

test('saveflow: clipParams assembles params with sane defaults', () => {
  const p = saveflow.clipParams({ start: 1.5, end: 3.5 }, 5, { fps: 12 }, CROP, OUT);
  assert.deepEqual(p, {
    start: 1.5,
    end: 3.5,
    fps: 12,
    outputFps: 12,
    speed: 1,
    hold: false,
    crop: CROP,
    outW: 256,
    outH: 256,
  });
});

test('saveflow: clipParams clamps a negative start to 0', () => {
  const p = saveflow.clipParams({ start: -2, end: 3 }, 5, { fps: 12 }, CROP, OUT);
  assert.equal(p.start, 0);
});

test('saveflow: clipParams clamps end to the video duration', () => {
  const p = saveflow.clipParams({ start: 1, end: 99 }, 5, { fps: 12 }, CROP, OUT);
  assert.equal(p.end, 5);
});

test('saveflow: clipParams preserves end when the duration is missing', () => {
  const p = saveflow.clipParams({ start: 1, end: 3.25 }, null, { fps: 12 }, CROP, OUT);
  assert.equal(p.end, 3.25);
  const p2 = saveflow.clipParams({ start: 1, end: 3.25 }, 0, { fps: 12 }, CROP, OUT);
  assert.equal(p2.end, 3.25);
});

test('saveflow: clipParams floors fps at 1', () => {
  assert.equal(saveflow.clipParams({ start: 0, end: 1 }, 5, { fps: 0 }, CROP, OUT).fps, 1);
  assert.equal(saveflow.clipParams({ start: 0, end: 1 }, 5, { fps: -4 }, CROP, OUT).fps, 1);
  assert.equal(saveflow.clipParams({ start: 0, end: 1 }, 5, {}, CROP, OUT).fps, 1);
  assert.equal(saveflow.clipParams({ start: 0, end: 1 }, 5, null, CROP, OUT).fps, 1);
});

test('saveflow: clipParams clamps end not below start', () => {
  const p = saveflow.clipParams({ start: 4, end: 1 }, 5, { fps: 12 }, CROP, OUT);
  assert.equal(p.end, 1);
});

/* ---- M17 playback speed: sample/output rate matrix ----------------- */

test('saveflow: speed=1 keeps native sampling and output fps', () => {
  const p = saveflow.clipParams({ start: 0, end: 5 }, 5, { fps: 12, format: 'gif' }, CROP, OUT, 1);
  assert.equal(p.speed, 1);
  assert.equal(p.hold, false);
  assert.equal(p.fps, 12);
  assert.equal(p.outputFps, 12);
});

test('saveflow: slow motion samples denser at the nominal output fps', () => {
  // 0.5× @ 12 fps: capture 24 src frames/s, play back at 12 → duration ×2.
  const p = saveflow.clipParams({ start: 0, end: 5 }, 5, { fps: 12, format: 'webm' }, CROP, OUT, 0.5);
  assert.equal(p.hold, true);
  assert.equal(p.fps, 24);
  assert.equal(p.outputFps, 12);
  // 0.25× @ 12 fps: 48 src frames/s.
  const q = saveflow.clipParams({ start: 0, end: 5 }, 5, { fps: 12, format: 'gif' }, CROP, OUT, 0.25);
  assert.equal(q.fps, 48);
  assert.equal(q.outputFps, 12);
  // Fractional rates round but never fall below 1.
  const r = saveflow.clipParams({ start: 0, end: 5 }, 5, { fps: 5, format: 'gif' }, CROP, OUT, 0.9);
  assert.equal(r.fps, Math.max(1, Math.round(5 / 0.9)));
});

test('saveflow: speed-up scales output fps, GIF-capped at 50, WebM uncapped', () => {
  // 2× @ 12 fps: native sampling, 24 fps out.
  const g = saveflow.clipParams({ start: 0, end: 5 }, 5, { fps: 12, format: 'gif' }, CROP, OUT, 2);
  assert.equal(g.hold, false);
  assert.equal(g.fps, 12);
  assert.equal(g.outputFps, 24);
  // 4× @ 12 = 48 ≤ 50 → untouched; GIF cap at 50 for higher fps.
  assert.equal(saveflow.clipParams({ start: 0, end: 5 }, 5, { fps: 12, format: 'gif' }, CROP, OUT, 4).outputFps, 48);
  assert.equal(saveflow.clipParams({ start: 0, end: 5 }, 5, { fps: 24, format: 'gif' }, CROP, OUT, 4).outputFps, 50);
  // WebM has no GIF-delay floor.
  assert.equal(saveflow.clipParams({ start: 0, end: 5 }, 5, { fps: 24, format: 'webm' }, CROP, OUT, 4).outputFps, 96);
});

test('saveflow: normalizeSpeed sanitizes into [0.25, 4]', () => {
  assert.equal(saveflow.normalizeSpeed(1), 1);
  assert.equal(saveflow.normalizeSpeed(0.5), 0.5);
  assert.equal(saveflow.normalizeSpeed(4), 4);
  assert.equal(saveflow.normalizeSpeed(8), 4);
  assert.equal(saveflow.normalizeSpeed(0.1), 0.25);
  assert.equal(saveflow.normalizeSpeed(0), 1);
  assert.equal(saveflow.normalizeSpeed(-2), 1);
  assert.equal(saveflow.normalizeSpeed('fast'), 1);
  assert.equal(saveflow.normalizeSpeed(NaN), 1);
  assert.equal(saveflow.normalizeSpeed(undefined), 1);
});

test('saveflow: mapSaveResult passes through a successful response', () => {
  assert.deepEqual(saveflow.mapSaveResult({ ok: true, id: 7 }, 'a.gif'), {
    ok: true,
    error: null,
    filename: 'a.gif',
  });
});

test('saveflow: mapSaveResult surfaces a background error', () => {
  assert.deepEqual(saveflow.mapSaveResult({ ok: false, error: 'background: boom' }, 'a.gif'), {
    ok: false,
    error: 'background: boom',
    filename: 'a.gif',
  });
});

test('saveflow: mapSaveResult treats a missing/empty response as failure', () => {
  assert.deepEqual(saveflow.mapSaveResult(null, 'a.gif'), { ok: false, error: 'no response', filename: 'a.gif' });
  assert.deepEqual(saveflow.mapSaveResult(undefined, 'a.gif'), { ok: false, error: 'no response', filename: 'a.gif' });
  assert.deepEqual(saveflow.mapSaveResult({}, 'a.gif'), { ok: false, error: null, filename: 'a.gif' });
});

test('saveflow: mapSaveError captures the error message', () => {
  assert.deepEqual(saveflow.mapSaveError(new Error('background: boom'), 'a.gif'), {
    ok: false,
    error: 'background: boom',
    filename: 'a.gif',
  });
});

test('saveflow: mapSaveError strips the messaging yt-snip: prefix', () => {
  assert.equal(saveflow.mapSaveError(new Error('yt-snip: background: boom'), 'a.gif').error, 'background: boom');
});

test('saveflow: mapSaveError tolerates non-Error throw values', () => {
  assert.equal(saveflow.mapSaveError('background: boom', 'a.gif').error, 'background: boom');
  assert.equal(saveflow.mapSaveError({}, 'a.gif').error, 'unknown error');
});

test('saveflow: toastTextForError maps known background failures', () => {
  assert.equal(
    saveflow.toastTextForError(new Error('background: downloads API unavailable'), 'Save failed'),
    'Save failed: downloads unavailable in this browser'
  );
  assert.equal(
    saveflow.toastTextForError(new Error('background: no clip data received'), 'Save failed'),
    'Save failed: nothing to save'
  );
});

test('saveflow: toastTextForError prefixes unknown failures', () => {
  assert.equal(
    saveflow.toastTextForError(new Error('background: disk full'), 'Save failed'),
    'Save failed: background: disk full'
  );
  assert.equal(saveflow.toastTextForError('background: disk full', 'Save failed'), 'Save failed: background: disk full');
});

test('saveflow: toastTextForError uses the fallback when no error is given', () => {
  assert.equal(saveflow.toastTextForError(null, 'Save failed'), 'Save failed');
  assert.equal(saveflow.toastTextForError('', 'Save failed'), 'Save failed');
});

test('saveflow: toastTextForError strips the messaging prefix before matching', () => {
  assert.equal(
    saveflow.toastTextForError(new Error('yt-snip: background: no filename received'), 'Save failed'),
    'Save failed: missing filename'
  );
});
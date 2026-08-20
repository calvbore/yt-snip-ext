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
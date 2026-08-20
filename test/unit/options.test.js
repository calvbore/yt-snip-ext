'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const options = require('../../lib/options.js');

test('options: defaults when nothing stored', () => {
  assert.deepEqual(options.resolve(undefined), {
    fps: 12,
    maxDimension: 512,
    saveAs: false,
    format: 'gif',
  });
  assert.deepEqual(options.resolve(null), options.DEFAULTS);
});

test('options: passes through valid values', () => {
  assert.deepEqual(options.resolve({ fps: 20, maxDimension: 640, saveAs: true }), {
    fps: 20,
    maxDimension: 640,
    saveAs: true,
    format: 'gif',
  });
});

test('options: clamps fps into [1, 60]', () => {
  assert.equal(options.resolve({ fps: 0 }).fps, 1);
  assert.equal(options.resolve({ fps: -5 }).fps, 1);
  assert.equal(options.resolve({ fps: 999 }).fps, 60);
  assert.equal(options.resolve({ fps: '18' }).fps, 18);
  assert.equal(options.resolve({ fps: 'abc' }).fps, 1);
});

test('options: clamps maxDimension into [64, 8000]', () => {
  assert.equal(options.resolve({ maxDimension: 8 }).maxDimension, 64);
  assert.equal(options.resolve({ maxDimension: 99999 }).maxDimension, 8000);
  assert.equal(options.resolve({ maxDimension: 300 }).maxDimension, 300);
});

test('options: saveAs accepts several truthy encodings', () => {
  assert.equal(options.resolve({ saveAs: true }).saveAs, true);
  assert.equal(options.resolve({ saveAs: 'true' }).saveAs, true);
  assert.equal(options.resolve({ saveAs: 1 }).saveAs, true);
  assert.equal(options.resolve({ saveAs: false }).saveAs, false);
  assert.equal(options.resolve({ saveAs: 'yes' }).saveAs, false);
});

test('options: unknown format falls back to gif', () => {
  assert.equal(options.resolve({ format: 'webm' }).format, 'gif');
  assert.equal(options.resolve({ format: 'gif' }).format, 'gif');
});
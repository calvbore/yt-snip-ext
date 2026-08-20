'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const filename = require('../../lib/filename.js');

const FIXED = new Date('2026-08-16T10:04:05');

test('filename: timestamp formats YYYYMMDD-HHMMSS', () => {
  assert.equal(filename.timestamp(FIXED), '20260816-100405');
});

test('filename: slugs out unsafe characters and collapses whitespace', () => {
  assert.equal(filename.slugify('a/b:c*d?e'), 'a b c d e');
  assert.equal(filename.slugify('  spaced   out  '), 'spaced out');
});

test('filename: makeFilename combines base + ext', () => {
  const name = filename.makeFilename('My Fancy Video', FIXED, 'gif');
  assert.match(name, /^yt-snip-My Fancy Video-20260816-100405\.gif$/);
});

test('filename: title omitted when empty', () => {
  const name = filename.makeFilename('', FIXED);
  assert.match(name, /^yt-snip-20260816-100405\.gif$/);
});

test('filename: default extension is gif', () => {
  assert.equal(filename.makeFilename('t', FIXED).endsWith('.gif'), true);
});

test('filename: title is capped to keep names sane', () => {
  const long = 'x'.repeat(200);
  const name = filename.makeFilename(long, FIXED);
  assert.ok(name.length < 120, 'name length ' + name.length);
});
/*
 * lib/filename.js
 *
 * Pure filename generation for saved clips. Auto-downloads use a unique,
 * collision-tolerant name; the extension's `downloads.download` is called with
 * `conflictAction: 'uniquify'`, so the base name just needs to be unique per
 * invocation.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else if (typeof define === 'function' && define.amd) {
    define([], factory);
  } else {
    root.ytSnipFilename = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var DEFAULT_EXT = 'gif';

  function pad(n, width) {
    var s = String(Math.abs(n));
    while (s.length < width) {
      s = '0' + s;
    }
    return s;
  }

  /** Format a Date as a compact UTC-ish local timestamp YYYYMMDD-HHMMSS. */
  function timestamp(date) {
    var d = date || new Date();
    return (
      d.getFullYear() +
      pad(d.getMonth() + 1, 2) +
      pad(d.getDate(), 2) +
      '-' +
      pad(d.getHours(), 2) +
      pad(d.getMinutes(), 2) +
      pad(d.getSeconds(), 2)
    );
  }

  /** Keep only filename-safe characters, cap the length, trim empty tails. */
  function slugify(title) {
    if (!title) {
      return '';
    }
    var out = String(title)
      .replace(/["\\/:*?<>|]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return out.slice(0, 64);
  }

  /**
   * Default base: `yt-snip< -title>-<timestamp>` (title omitted when empty).
   */
  function makeBase(title, date) {
    var slug = slugify(title);
    var stem = 'yt-snip' + (slug ? '-' + slug : '');
    return stem + '-' + timestamp(date);
  }

  /**
   * Full local filename with extension.
   */
  function makeFilename(title, date, ext) {
    return makeBase(title, date) + '.' + (ext || DEFAULT_EXT);
  }

  return {
    timestamp: timestamp,
    slugify: slugify,
    makeBase: makeBase,
    makeFilename: makeFilename,
    DEFAULT_EXT: DEFAULT_EXT,
  };
});
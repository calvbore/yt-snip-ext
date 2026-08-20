/*
 * lib/storage.js
 *
 * Promise-based storage access that works identically across engines.
 *
 * Firefox exposes `browser.storage.local` as a promise API (arity 1 for
 * `get`/`set`); Chromium exposes `chrome.storage.local` as a callback API
 * (arity 2: `get(keys, callback)`). The content scripts already relied on
 * this arity difference to pick a path; this module centralizes the heuristic
 * so the options page and the content script can't disagree about it (the
 * options page previously used a `>= 1` test that silently broke persistence
 * in Chromium).
 *
 * UMD: `require`d in Node unit tests; loaded as a classic content script
 * (attaches `window.ytSnipStorage`) or via the options page's <script> tags.
 * Performs no DOM access at load time.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else if (typeof define === 'function' && define.amd) {
    define([], factory);
  } else {
    root.ytSnipStorage = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /**
   * Detect the storage API style. Chromium's callback-based functions are
   * declared `get(keys, callback)` / `set(items, callback)` → arity 2;
   * Firefox's promise-based ones are `get(keys)` / `set(items)` → arity 1.
   * Returns 'callback' or 'promise'.
   */
  function detectStyle(store) {
    if (store && store.get) {
      return store.get.length >= 2 ? 'callback' : 'promise';
    }
    return 'promise';
  }

  function resolveStorage() {
    if (typeof browser !== 'undefined' && browser && browser.storage) {
      return browser.storage.local;
    }
    if (typeof chrome !== 'undefined' && chrome && chrome.storage) {
      return chrome.storage.local;
    }
    return null;
  }

  /** Read chrome.runtime.lastError; null when chrome isn't present (harness/Node). */
  function runtimeLastError() {
    if (typeof chrome !== 'undefined' && chrome && chrome.runtime) {
      return chrome.runtime.lastError;
    }
    return null;
  }

  /**
   * Read stored values. `keys` is passed through as-is (null/undefined means
   * "everything"). Resolves the raw items object; rejects when storage is
   * unavailable or the read failed.
   */
  function get(keys) {
    var store = resolveStorage();
    if (!store || !store.get) {
      return Promise.reject(new Error('yt-snip: storage unavailable'));
    }
    if (detectStyle(store) === 'callback') {
      return new Promise(function (resolve, reject) {
        store.get(keys, function (items) {
          var lastErr = runtimeLastError();
          if (lastErr) {
            reject(new Error(lastErr.message));
          } else {
            resolve(items || {});
          }
        });
      });
    }
    return Promise.resolve(store.get(keys)).then(function (items) {
      return items || {};
    });
  }

  /** Persist `values`; rejects when storage is unavailable or the write failed. */
  function set(values) {
    var store = resolveStorage();
    if (!store || !store.set) {
      return Promise.reject(new Error('yt-snip: storage unavailable'));
    }
    if (detectStyle(store) === 'callback') {
      return new Promise(function (resolve, reject) {
        store.set(values, function () {
          var lastErr = runtimeLastError();
          if (lastErr) {
            reject(new Error(lastErr.message));
          } else {
            resolve();
          }
        });
      });
    }
    return Promise.resolve(store.set(values));
  }

  return {
    detectStyle: detectStyle,
    get: get,
    set: set,
  };
});

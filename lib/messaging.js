/*
 * lib/messaging.js
 *
 * Promise-based browser/chrome runtime messaging wrapper.
 *
 * This module is UMD-style: it can be `require`d from Node unit tests, or
 * loaded as a classic script into a content-script context (where it attaches
 * itself to `window.ytSnipMessaging`). It performs no DOM access at load time.
 *
 * Support matrix:
 *   - Firefox `browser.runtime.sendMessage(message[, transfer])` -> Promise
 *   - Chromium `chrome.runtime.sendMessage(message[, options], callback)`
 *   - In-page fakes that expose either shape (used by the test harness).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else if (typeof define === 'function' && define.amd) {
    define([], factory);
  } else {
    root.ytSnipMessaging = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /**
   * Resolve to a descriptor for the current runtime's messaging API.
   * Returns null when neither `browser` nor `chrome` is available.
   *
   * `browser.*` namespaces are promise-based in Firefox AND in Chromium's
   * MV3 browser-alias, so promise-ness alone cannot tell the engines apart.
   * Firefox is the only one that (a) exposes `getBrowserInfo` and (b) accepts
   * a transfer list as `sendMessage`'s second argument; Chromium rejects that
   * extra argument with "No matching signature" and structured-clones the
   * ArrayBuffer instead. The `transfer` capability is therefore keyed on the
   * presence of `browser.runtime.getBrowserInfo`.
   */
  function runtimeDescriptor() {
    if (
      typeof browser !== 'undefined' &&
      browser &&
      browser.runtime &&
      typeof browser.runtime.sendMessage === 'function'
    ) {
      var isFirefox = typeof browser.runtime.getBrowserInfo === 'function';
      return { promise: true, rt: browser.runtime, label: 'browser', transfer: isFirefox };
    }
    if (
      typeof chrome !== 'undefined' &&
      chrome &&
      chrome.runtime &&
      typeof chrome.runtime.sendMessage === 'function'
    ) {
      // Chromium callback-style API (also the legacy Firefox `chrome.*` alias).
      return { promise: false, rt: chrome.runtime, label: 'chrome', transfer: false };
    }
    return null;
  }

  /**
   * Send a message to the extension background, resolving with the response.
   * `transfer` is optional; when provided it is passed as the transfer list for
   * ArrayBuffers (subject to the runtime's support).
   */
  function sendMessage(message, transfer) {
    var desc = runtimeDescriptor();
    if (!desc) {
      return Promise.reject(
        new Error('yt-snip: no extension messaging runtime available')
      );
    }
    return new Promise(function (resolve, reject) {
      var result;
      try {
        if (desc.promise) {
          result =
            desc.transfer && transfer !== undefined
              ? desc.rt.sendMessage(message, transfer)
              : desc.rt.sendMessage(message);
        } else {
          desc.rt.sendMessage(message, function (response) {
            var err = desc.rt.lastError;
            if (err) {
              reject(new Error('yt-snip: ' + err.message));
            } else {
              resolve(response);
            }
          });
          return;
        }
      } catch (err) {
        reject(err);
        return;
      }
      if (result && typeof result.then === 'function') {
        result.then(resolve, reject);
      } else {
        // sync fakes / sealed responses
        resolve(result);
      }
    });
  }

  /**
   * Convenience: `request` sends a typed message and resolves with the
   * response payload, rejecting when the response carries an `error` field.
   */
  function request(type, payload, transfer) {
    var message = { type: type, payload: payload };
    return sendMessage(message, transfer).then(function (response) {
      if (response && response.error) {
        throw new Error('yt-snip: ' + response.error);
      }
      return response && response.payload !== undefined ? response.payload : response;
    });
  }

  return {
    sendMessage: sendMessage,
    request: request,
    runtimeDescriptor: runtimeDescriptor,
    runtimeAvailable: function () {
      return runtimeDescriptor() !== null;
    },
  };
});
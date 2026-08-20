'use strict';

/*
 * background.js
 *
 * MV3 background script. The manifest declares BOTH `scripts` (Firefox event
 * page) and `service_worker` (Chromium) entries pointing here, so the same
 * file serves both engines.
 *
 * Responsibilities:
 *   - Receive encoded clip bytes from a content script and hand them to the
 *     `downloads` API as a Blob URL. The Blob is created in the background,
 *     never in a content script: Firefox rejects blob: URLs produced in
 *     content-script/web-page contexts for `downloads.download` (bug 1696174).
 *   - Keep the message channel open on the non-persistent Firefox event page
 *     by returning `true` from the listener while the async work runs.
 */

function downloadsApi() {
  if (typeof browser !== 'undefined' && browser && browser.downloads) {
    return browser.downloads;
  }
  if (typeof chrome !== 'undefined' && chrome && chrome.downloads) {
    return chrome.downloads;
  }
  return null;
}

/**
 * Service workers (Chromium MV3 background) do not expose
 * `URL.createObjectURL`, so as a fallback build a base64 data URL from the
 * raw bytes. `btoa` is available in both contexts.
 */
function toBase64(u8) {
  var CHUNK = 0x8000;
  var bin = '';
  for (var i = 0; i < u8.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, u8.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

function toDataUrl(u8) {
  return 'data:image/gif;base64,' + toBase64(u8);
}

var offscreenReady = false;

function ensureOffscreen() {
  var api = typeof chrome !== 'undefined' && chrome && chrome.offscreen;
  if (!api || typeof api.createDocument !== 'function') {
    return Promise.resolve(false);
  }
  if (offscreenReady) {
    return Promise.resolve(true);
  }
  var promise;
  try {
    promise = api.createDocument({
      url: 'offscreen.html',
      reasons: ['BLOBS'],
      justification: 'yt-snip encodes captured clips as browser downloads',
    });
  } catch (err) {
    return Promise.resolve(false);
  }
  if (promise && typeof promise.then === 'function') {
    return promise.then(function () {
      offscreenReady = true;
      return true;
    }, function (err) {
      console.error('yt-snip: offscreen document failed: ' + (err && err.message || err));
      return false;
    });
  }
  offscreenReady = true;
  return Promise.resolve(true);
}

function sendBlobUrlMessage(message) {
  if (typeof browser !== 'undefined' && browser && browser.runtime) {
    return browser.runtime.sendMessage(message);
  }
  return chrome.runtime.sendMessage(message);
}

/**
 * Resolve a download URL for the encoded bytes. Prefers a blob: URL — needed
 * for the file to keep its real name and for Chromium's MV3 service worker,
 * which cannot create blob URLs itself (that's what the offscreen document
 * is for). Falls back to a data URL.
 */
function makeDownloadUrl(u8) {
  if (typeof URL.createObjectURL === 'function') {
    try {
      return Promise.resolve({
        url: URL.createObjectURL(new Blob([u8], { type: 'image/gif' })),
        isBlobUrl: true,
      });
    } catch (e) {
      return Promise.resolve({ url: null, isBlobUrl: false });
    }
  }
  return ensureOffscreen().then(function (ok) {
    if (!ok) {
      return { url: toDataUrl(u8), isBlobUrl: false };
    }
    return sendBlobUrlMessage({ type: 'yt-snip:make-blob-url', b64: toBase64(u8) })
      .then(function (resp) {
        if (resp && resp.ok && resp.url) {
          return { url: resp.url, isBlobUrl: true };
        }
        return { url: toDataUrl(u8), isBlobUrl: false };
      }, function () {
        return { url: toDataUrl(u8), isBlobUrl: false };
      });
  });
}

function promiseFromDownloads(api, method, args) {
  // Firefox `browser.*` is promise-based; Chromium `chrome.*` is callback-based.
  var promiseStyle = typeof browser !== 'undefined' && browser && browser.downloads;
  return new Promise(function (resolve, reject) {
    if (promiseStyle) {
      var result;
      try {
        result = api[method].apply(api, args);
      } catch (e) {
        reject(e);
        return;
      }
      if (result && typeof result.then === 'function') {
        result.then(resolve, reject);
      } else {
        resolve(result);
      }
      return;
    }
    try {
      api[method].apply(api, args.concat([function (res) {
        var err = api.lastError;
        if (err) reject(new Error(err.message));
        else resolve(res);
      }]));
    } catch (e) {
      reject(e);
    }
  });
}

/**
 * Kick off a download for `payload.data` — the clip's encoded bytes accepted
 * as an ArrayBuffer, a typed array, or a plain array of byte values (the
 * latter is what content scripts send, since Chromium's message serialization
 * does not preserve ArrayBuffers across the content→service-worker boundary).
 * Resolves `{ ok: true, id }` or `{ ok: false, error }`.
 */
function downloadClip(payload) {
  if (!payload) {
    return Promise.resolve({ ok: false, error: 'background: no payload received' });
  }
  var raw = payload.data;
  var u8 = null;
  if (raw instanceof ArrayBuffer) {
    u8 = new Uint8Array(raw);
  } else if (typeof ArrayBuffer.isView === 'function' && ArrayBuffer.isView(raw)) {
    u8 = new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
  } else if (Array.isArray(raw) && raw.length > 0) {
    u8 = Uint8Array.from(raw);
  }
  if (!u8) {
    return Promise.resolve({ ok: false, error: 'background: no clip data received' });
  }
  if (!payload.filename) {
    return Promise.resolve({ ok: false, error: 'background: no filename received' });
  }
  var api = downloadsApi();
  if (!api) {
    return Promise.resolve({ ok: false, error: 'background: downloads API unavailable' });
  }

  return makeDownloadUrl(u8).then(function (route) {
    return promiseFromDownloads(api, 'download', [{
      url: route.url,
      filename: payload.filename,
      saveAs: !!payload.saveAs,
      conflictAction: 'uniquify',
    }]).then(
      function (id) {
        return { ok: true, id: id, isBlobUrl: route.isBlobUrl, url: route.url };
      },
      function (err) {
        return { ok: false, error: 'background: ' + (err && err.message || err), isBlobUrl: route.isBlobUrl, url: route.url };
      }
    );
  }).then(function (result) {
    // Let the download engine read a blob URL, then release it (data URLs
    // need no release). Blob URLs built here are revoked in place; ones made
    // by the offscreen document are revoked there via a delayed message.
    // Firefox keeps the event page alive through the promise above;
    // `downloads.onChanged` would also work but a fixed grace period is
    // simpler and test-friendly.
    if (result.isBlobUrl) {
      setTimeout(function () {
        if (typeof URL.revokeObjectURL === 'function') {
          try {
            URL.revokeObjectURL(result.url);
          } catch (e) { /* ignore */ }
        } else {
          try {
            sendBlobUrlMessage({ type: 'yt-snip:revoke-blob-url', url: result.url });
          } catch (e) { /* ignore */ }
        }
      }, 60000);
    }
    return { ok: result.ok, id: result.id, error: result.error };
  });
}

function handleMessage(message, sender, sendResponse) {
  if (!message || message.type !== 'yt-snip:save') {
    return false;
  }
  downloadClip(message.payload).then(sendResponse);
  return true; // keep the async channel open (Firefox event page)
}

if (typeof browser !== 'undefined' && browser && browser.runtime) {
  browser.runtime.onMessage.addListener(handleMessage);
} else if (typeof chrome !== 'undefined' && chrome && chrome.runtime) {
  chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
    var keepOpen = handleMessage(message, sender, sendResponse);
    // Chromium MV3: returning true keeps the SW alive for the async response.
    return keepOpen;
  });
}
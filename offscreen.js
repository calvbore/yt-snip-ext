'use strict';
/*
 * offscreen.js — runs in the extension's offscreen document (Chromium MV3).
 * A service worker has no `URL.createObjectURL`, but `downloads.download`
 * needs a blob: URL to give the file its real name (data: URLs are saved as
 * "download.gif"). Chromium lets an extension open an offscreen document with
 * the "BLOBS" reason and build blob URLs here. Firefox's event page keeps the
 * in-background blob path and never opens this document.
 */
if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
  chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
    if (!message) {
      sendResponse();
      return false;
    }
    if (message.type === 'yt-snip:make-blob-url') {
      try {
        var bytes = Uint8Array.from(
          atob(message.b64),
          function (c) { return c.charCodeAt(0); }
        );
        var url = URL.createObjectURL(new Blob([bytes], { type: 'image/gif' }));
        sendResponse({ ok: true, url: url });
      } catch (e) {
        sendResponse({ ok: false, error: e.message });
      }
      return false;
    }
    if (message.type === 'yt-snip:revoke-blob-url') {
      try {
        URL.revokeObjectURL(message.url);
      } catch (e) { /* ignore */ }
      sendResponse({ ok: true });
      return false;
    }
    sendResponse();
    return false;
  });
}
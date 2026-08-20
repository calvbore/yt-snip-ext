'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const messaging = require('../../lib/messaging.js');

function withGlobals(globals, fn) {
  const saved = {};
  for (const key of Object.keys(globals)) {
    saved[key] = globalThis[key];
    globalThis[key] = globals[key];
  }
  try {
    return fn();
  } finally {
    for (const key of Object.keys(globals)) globalThis[key] = saved[key];
  }
}

test('messaging: no runtime available → rejects', async () => {
  await assert.rejects(
    withGlobals({ browser: undefined, chrome: undefined }, () =>
      messaging.sendMessage({ type: 'x' })
    ),
    /no extension messaging runtime/
  );
});

test('messaging: uses promise-based browser.runtime.sendMessage (Firefox)', async () => {
  const calls = [];
  const fakeBrowser = {
    runtime: {
      getBrowserInfo() {},
      sendMessage(message, transfer) {
        calls.push({ message, transfer });
        return Promise.resolve({ ok: true, id: 7 });
      },
    },
  };
  const result = await withGlobals({ browser: fakeBrowser, chrome: undefined }, () =>
    messaging.sendMessage({ type: 'yt-snip:save', payload: { n: 1 } })
  );
  assert.deepEqual(result, { ok: true, id: 7 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].message.type, 'yt-snip:save');
  assert.equal(calls[0].transfer, undefined);
});

test('messaging: forwards the transfer list only on Firefox', async () => {
  let seenTransfer;
  const fakeBrowser = {
    runtime: {
      getBrowserInfo() {},
      sendMessage(message, transfer) {
        seenTransfer = transfer;
        return Promise.resolve({ ok: true });
      },
    },
  };
  const transfer = [new ArrayBuffer(8)];
  await withGlobals({ browser: fakeBrowser, chrome: undefined }, () =>
    messaging.sendMessage({ type: 'x' }, transfer)
  );
  assert.equal(seenTransfer, transfer);
});

test('messaging: Chromium browser-alias (no getBrowserInfo) skips the transfer list', async () => {
  let seenArgs;
  const fakeBrowser = {
    runtime: {
      sendMessage(...args) {
        seenArgs = args;
        return Promise.resolve({ ok: true });
      },
    },
  };
  const transfer = [new ArrayBuffer(8)];
  await withGlobals({ browser: fakeBrowser, chrome: undefined }, () =>
    messaging.sendMessage({ type: 'x' }, transfer)
  );
  // A bare transfer array as the second positional arg would throw
  // "No matching signature" in Chromium; only the message must be passed.
  assert.equal(seenArgs.length, 1);
  assert.equal(seenArgs[0].type, 'x');
});

test('messaging: uses callback-style chrome.runtime.sendMessage (Chromium)', async () => {
  const calls = [];
  const fakeChrome = {
    runtime: {
      lastError: null,
      sendMessage(message, cb) {
        calls.push(message);
        cb({ ok: true, id: 3 });
      },
    },
  };
  const result = await withGlobals({ browser: undefined, chrome: fakeChrome }, () =>
    messaging.sendMessage({ type: 'yt-snip:save' })
  );
  assert.deepEqual(result, { ok: true, id: 3 });
  assert.equal(calls.length, 1);
});

test('messaging: surfaces chrome.runtime.lastError', async () => {
  const fakeChrome = {
    runtime: {
      lastError: { message: 'download failed' },
      sendMessage(message, cb) {
        cb(null);
      },
    },
  };
  await assert.rejects(
    withGlobals({ browser: undefined, chrome: fakeChrome }, () =>
      messaging.sendMessage({ type: 'x' })
    ),
    /download failed/
  );
});

test('messaging: request() unwraps payload and rejects on response.error', async () => {
  const fakeBrowser = {
    runtime: {
      sendMessage(message) {
        if (message.type === 'good') return Promise.resolve({ payload: { bytes: 1 } });
        return Promise.resolve({ error: 'nope' });
      },
    },
  };
  const good = await withGlobals({ browser: fakeBrowser, chrome: undefined }, () =>
    messaging.request('good', {})
  );
  assert.deepEqual(good, { bytes: 1 });

  await assert.rejects(
    withGlobals({ browser: fakeBrowser, chrome: undefined }, () =>
      messaging.request('bad', {})
    ),
    /nope/
  );
});

test('messaging: runtimeAvailable is false with no runtime', () => {
  const available = withGlobals({ browser: undefined, chrome: undefined }, () =>
    messaging.runtimeAvailable()
  );
  assert.equal(available, false);
});

test('messaging: runtimeAvailable true with a fake runtime', () => {
  const available = withGlobals(
    { browser: { runtime: { sendMessage() {} } }, chrome: undefined },
    () => messaging.runtimeAvailable()
  );
  assert.equal(available, true);
});
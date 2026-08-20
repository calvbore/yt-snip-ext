'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const storage = require('../../lib/storage.js');

/** Run `fn` with fake `browser`/`chrome` globals set, then restore them. */
async function withGlobals(fakes, fn) {
  if (fakes.browser) global.browser = fakes.browser;
  if (fakes.chrome) global.chrome = fakes.chrome;
  try {
    return await fn();
  } finally {
    delete global.browser;
    delete global.chrome;
  }
}

test('storage: detectStyle — arity 2 get means callback API (Chromium)', () => {
  assert.equal(storage.detectStyle({ get: function (keys, cb) {} }), 'callback');
  assert.equal(storage.detectStyle({ get: function (a, b) {} }), 'callback');
});

test('storage: detectStyle — arity 1 get means promise API (Firefox)', () => {
  assert.equal(storage.detectStyle({ get: function (keys) {} }), 'promise');
});

test('storage: detectStyle — missing/empty store falls back to promise', () => {
  assert.equal(storage.detectStyle({}), 'promise');
  assert.equal(storage.detectStyle(null), 'promise');
  assert.equal(storage.detectStyle(undefined), 'promise');
});

test('storage: get() resolves stored items via the Firefox promise API', async () => {
  await withGlobals(
    { browser: { storage: { local: { get: function (keys) { return Promise.resolve({ fps: 30 }); } } } } },
    async () => {
      assert.deepEqual(await storage.get(null), { fps: 30 });
      assert.deepEqual(await storage.get(['fps']), { fps: 30 });
    }
  );
});

test('storage: get() resolves via the Chromium callback API', async () => {
  await withGlobals(
    {
      chrome: {
        storage: { local: { get: function (keys, cb) { cb({ fps: 30 }); } } },
        runtime: { lastError: null },
      },
    },
    async () => {
      assert.deepEqual(await storage.get(null), { fps: 30 });
    }
  );
});

test('storage: get() handles a browser-only callback store with no chrome global (harness shape)', async () => {
  await withGlobals(
    { browser: { storage: { local: { get: function (keys, cb) { cb({ fps: 30 }); } } } } },
    async () => {
      assert.deepEqual(await storage.get(null), { fps: 30 });
    }
  );
});

test('storage: set() handles a browser-only callback store with no chrome global (harness shape)', async () => {
  let written = null;
  await withGlobals(
    { browser: { storage: { local: { set: function (values, cb) { written = values; cb(); } } } } },
    async () => {
      await storage.set({ fps: 30 });
      assert.deepEqual(written, { fps: 30 });
    }
  );
});

test('storage: get() normalizes a missing items argument to {}', async () => {
  await withGlobals(
    {
      chrome: {
        storage: { local: { get: function (keys, cb) { cb(); } } },
        runtime: { lastError: null },
      },
    },
    async () => {
      assert.deepEqual(await storage.get(null), {});
    }
  );
});

test('storage: get() rejects when no storage exists', async () => {
  await assert.rejects(storage.get(null), /storage unavailable/);
  await withGlobals({ browser: { storage: null } }, async () => {
    await assert.rejects(storage.get(null), /storage unavailable/);
  });
});

test('storage: get() rejects on a Firefox rejection', async () => {
  await withGlobals(
    { browser: { storage: { local: { get: function () { return Promise.reject(new Error('boom')); } } } } },
    async () => {
      await assert.rejects(storage.get(null), /boom/);
    }
  );
});

test('storage: get() rejects on a Chromium runtime lastError', async () => {
  await withGlobals(
    {
      chrome: {
        storage: { local: { get: function (keys, cb) { cb({}); } } },
        runtime: { lastError: { message: 'nope' } },
      },
    },
    async () => {
      await assert.rejects(storage.get(null), /nope/);
    }
  );
});

test('storage: set() persists via the Firefox promise API', async () => {
  let written = null;
  await withGlobals(
    {
      browser: {
        storage: { local: { set: function (values) { written = values; return Promise.resolve(); } } },
      },
    },
    async () => {
      await storage.set({ fps: 20 });
      assert.deepEqual(written, { fps: 20 });
    }
  );
});

test('storage: set() persists via the Chromium callback API', async () => {
  let written = null;
  await withGlobals(
    {
      chrome: {
        storage: {
          local: {
            get: function (keys, cb) { cb({}); },
            set: function (values, cb) { written = values; cb(); },
          },
        },
        runtime: { lastError: null },
      },
    },
    async () => {
      await storage.set({ saveAs: true });
      assert.deepEqual(written, { saveAs: true });
    }
  );
});

test('storage: set() rejects when no storage exists', async () => {
  await assert.rejects(storage.set({}), /storage unavailable/);
});

test('storage: set() rejects on a Chromium runtime lastError', async () => {
  await withGlobals(
    {
      chrome: {
        storage: {
          local: {
            get: function (keys, cb) { cb({}); },
            set: function (values, cb) { cb(); },
          },
        },
        runtime: { lastError: { message: 'quota exceeded' } },
      },
    },
    async () => {
      await assert.rejects(storage.set({}), /quota exceeded/);
    }
  );
});

test('storage: set() rejects on a Firefox rejection', async () => {
  await withGlobals(
    { browser: { storage: { local: { set: function () { return Promise.reject(new Error('boom')); } } } } },
    async () => {
      await assert.rejects(storage.set({}), /boom/);
    }
  );
});
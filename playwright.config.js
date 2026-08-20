/*
 * playwright.config.js
 *
 * Tier 1 — DOM/UI E2E on headless Firefox (Playwright). The harness loads the
 * real content/* scripts as plain <script> tags and stubs messaging/storage at
 * the boundary; everything else (crop math, scheduler, encoder, capture
 * engine) runs for real against the synthesized media fixture.
 *
 * Two fixture servers are started as webServers: 8123 (primary origin, serves
 * the harness + media with CORS) and 8124 (cross-origin media with CORS) used
 * by the real-taint pass to force a genuine SecurityError, then a successful
 * fallback capture.
 */
'use strict';

const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  timeout: 60000,
  retries: 1,
  workers: 2,
  reporter: [['list'], ['html', { open: 'never' }]],
  globalSetup: './test/helpers/synth-global-setup.js',
  use: {
    headless: true,
    viewport: { width: 900, height: 600 },
    actionTimeout: 15000,
  },
  projects: [
    {
      // Tier 1 — DOM/UI E2E on headless Firefox (the original project).
      name: 'firefox',
      testDir: './test/e2e',
      testMatch: /.*\.spec\.js/,
      use: { browserName: 'firefox' },
    },
    {
      // Tier 3 (B3) — real extension inside Chromium (service-worker MV3
      // background + manifest content-script injection). The spec itself calls
      // chromium.launchPersistentContext with --load-extension; `channel:
      // 'chromium'` selects the full Chrome-for-Testing build in new headless
      // mode (the headless shell does not support extensions).
      name: 'chromium-ext',
      testDir: './test/e2e-chromium',
      testMatch: /.*\.spec\.js/,
      use: { browserName: 'chromium' },
    },
  ],
  webServer: [
    {
      command: 'node test/fixtures/serve.mjs 8123',
      url: 'http://127.0.0.1:8123/watch',
      reuseExistingServer: !process.env.CI,
      timeout: 30000,
    },
    {
      command: 'node test/fixtures/serve.mjs 8124',
      // Health URL must not depend on the synthesized fixture: the webServer
      // readiness gate is evaluated before globalSetup finishes here, so a
      // config.json-based URL would time out on a fresh checkout. `/` maps to
      // the always-present harness and 200s regardless. The fixture itself is
      // guaranteed present before any test by the globalSetup below.
      url: 'http://127.0.0.1:8124/',
      reuseExistingServer: !process.env.CI,
      timeout: 30000,
    },
  ],
});
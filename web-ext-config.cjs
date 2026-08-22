/*
 * web-ext-config.cjs — defaults for `npm run dev` (web-ext run) and
 * `npm run package` (web-ext build).
 *
 * Dev: launches a throwaway Firefox instance with the extension temporarily
 * installed and auto-reloads the add-on on every file save. No build step —
 * this config only trims the watcher's scope and sets the start page.
 * Content-script changes still need an F5 on the tab.
 *
 * Package: zips exactly the runtime files into dist/ for AMO self-
 * distribution signing (see README "Install permanently").
 */
module.exports = {
  // Keep the watcher/packager out of everything that isn't the extension.
  // Bare directory names drop the (empty) dir entries from packages; the
  // `/**` forms catch nested files for the dev watcher.
  ignoreFiles: [
    'test',
    'test/**',
    'test-results',
    'test-results/**',
    'playwright-report',
    'playwright-report/**',
    'coverage',
    'coverage/**',
    'dist',
    'dist/**',
    'PLAN.md',
    'DIAGNOSTIC.md',
    'AGENTS.md',
    'README.md',
    'LICENSE',
    '.nvmrc',
    '.amo.env',
    'web-ext-config.cjs',
    'playwright.config.js',
    'package.json',
    'package-lock.json',
    'icons/generate.mjs',
  ],
  run: {
    startUrl: ['https://www.youtube.com/watch?v=aqz-KE-bpKQ'],
  },
};

/*
 * web-ext-config.cjs — defaults for `npm run dev` (web-ext run).
 *
 * Watch-only dev convenience: launches a throwaway Firefox instance with the
 * extension temporarily installed and auto-reloads the add-on on every file
 * save. No build step — this config only trims the watcher's scope and sets
 * the start page. Content-script changes still need an F5 on the tab.
 */
module.exports = {
  // Keep the watcher/packager out of everything that isn't the extension.
  ignoreFiles: ['test/**', 'PLAN.md', 'README.md', 'LICENSE', 'web-ext-config.cjs'],
  run: {
    startUrl: ['https://www.youtube.com/watch?v=aqz-KE-bpKQ'],
  },
};

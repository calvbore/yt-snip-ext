# lib/vendor

Third-party runtime code vendored verbatim (no build step; loaded as a plain
classic content script).

- `mediabunny.js` — [Mediabunny](https://github.com/Vanilagy/mediabunny)
  v1.56.1, `dist/bundles/mediabunny.min.cjs` from the npm package, unmodified.
  The bundle is dual-mode: `var Mediabunny = IIFE` for classic script loading
  (content scripts) and a CJS `module.exports` tail, so Node tests can
  `require()` it.
  License: **MPL-2.0** (see `MEDIABUNNY-LICENSE.txt`). Used for WebM/MP4
  multiplexing (and, in tests, WebM demux validation) behind
  `content/webm-encoder.js`.

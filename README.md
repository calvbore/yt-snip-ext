# yt-snip

A Windows-style snipping tool for YouTube. Drag a rectangle over the video to
crop a region, scrub start/end points on the timeline, and save an animated
GIF that Anki's media manager can ingest directly.

- Firefox-first **MV3 WebExtension**, browser-agnostic API usage (also runs in
  Chromium-family browsers).
- Runs entirely in a content script on `youtube.com`; the only YouTube DOM
  mutations are the injected snip trigger and a temporary `ytp-autohide`
  class while the tool is open. All tool UI lives in a shadow DOM inside
  `#movie_player`.
- State-transition rule: whenever the tool is disengaged (escape, save, error),
  the video returns to the timestamp it was at when the tool was activated and
  is left paused.

## Install (unpacked extension)

Firefox:

1. `about:debugging` → *Load Temporary Add-on* → select `manifest.json`.
2. Open `about:addons` → yt-snip → Preferences if you want to tweak settings
   (the toolbar icon opens the same page).

Chromium:

1. `chrome://extensions` → enable *Developer mode* → *Load unpacked* → select
   this directory.

## Install permanently (regular Firefox)

A temporary add-on is wiped every time Firefox restarts, and release builds of
Firefox refuse permanently-installed extensions unless Mozilla has signed
them. To install yt-snip for real, get a signed build via AMO
(addons.mozilla.org) self-distribution — nothing is published publicly and no
review wait applies to basic validation:

1. Package the runtime files: `npm run package` → `dist/yt-snip-<version>.zip`
2. Sign it, either way works:
   - **Web upload (no API keys):** sign in at addons.mozilla.org →
     *Developer Hub* → *Submit a New Add-on* → *On your own* (self-
     distribution) → upload the zip → download the returned **signed .xpi**.
   - **CLI:** create API keys under *Developer Hub → Manage API Keys*, store
     them in an untracked `.amo.env` (`AMO_API_KEY=…`, `AMO_API_SECRET=…`),
     then `source .amo.env && npx web-ext sign --channel=unlisted \
     --api-key=$AMO_API_KEY --api-secret=$AMO_API_SECRET --artifacts-dir dist`
3. In Firefox: `about:addons` → ⚙ gear menu → *Install Add-on From File…* →
   pick the signed `.xpi`. It now survives restarts like any store add-on.

Notes: unlisted builds don't auto-update — bump `version` in `manifest.json`
and re-sign to upgrade (AMO rejects re-uploading an identical version). The
`gecko.id` needed for signing is already in the manifest. On Developer
Edition / Nightly / ESR you can skip signing entirely by setting
`xpinstall.signatures.required = false` in `about:config`.

## Usage

1. On any YouTube watch page, click the snip button next to the player chrome
   (top-right of the controls).
2. Drag a rectangle over the video — that's the crop. Resize handles let you
   fine-tune it once drawn, and dragging the rectangle's body moves the whole
   crop without resizing it.
3. The **detail strip** above the player controls is the editing timeline: it
   shows a magnified zoom window with start/preview/end handles, pre-placed
   a few seconds around where the video was when you activated the tool.
   Drag the handles to narrow or extend the time window — while you drag an
   edge the video scrubs along with it, and the playhead parks at that edge
   on release. The thin **white tick** marks where the video was when you
   activated the tool; it never moves, and leaving the tool returns the
   video to it. Dragging the blue band between the handles moves the whole
   clip without changing its length (the view follows along; if you push
   against the strip's edge it auto-pans). `+` / `−` zoom around the center
   of the view, the mouse wheel zooms at the cursor, dragging empty track
   pans the window, and **Fit** resets it to the whole video.
4. The **scrubber pill** sits right on top of YouTube's progress bar while
   snipping and is navigation only. Click or drag anywhere on it to slide
   the magnified view to another part of the video; drag its yellow bracket
   edges to resize the zoom; click the blue clip band to snap the view back
   around your selection; drag that band to relocate the whole clip to
   wherever you've browsed (one seek on release parks the playhead at the
   clip's new start). The white activation tick appears here too, so "where
   the video was when you started" stays visible even when the magnified
   view has panned elsewhere.
5. Pressing **play by any means** (YouTube's button, spacebar, `k`) loops
   playback within your selection so you can preview it (disable via the
   *Loop on play* option; the Loop button is always a manual override). The
   preview head follows playback.
6. Switching windows/tabs never ends a snip session — only Esc, **Exit**,
   saving, or navigating away do.
7. Click **Save**. The clip is encoded in-page and handed to the extension
   background, which downloads it to your OS Downloads folder as
   `yt-snip-<title>-<timestamp>.gif`. Saving — or leaving the tool any other
   way — returns the video to where it was when you started and leaves it
   paused.

The saved GIF loops infinitely (NETSCAPE extension), so it plays correctly as
an Anki media file.

## Options

| Setting | Meaning |
| --- | --- |
| Frames per second | Capture rate of the saved clip (1–60; lower is smaller). |
| Max dimension (px) | Long edge of the output; the short edge scales with the crop, keeping the clip Anki-friendly. |
| Ask where to save each clip | Prompt for a location instead of auto-downloading. |
| Loop on play | While snipping, pressing play loops within the selection instead of playing through it (on by default). |
| Selection start padding (s) | Where the start handle sits when you open the tool: this many seconds before the video's current position (0–600; default 3). |
| Selection end padding (s) | Where the end handle sits: this many seconds after the video's current position (0–600; default 3). |

## Development

Requirements: Node.js ≥ 20 (`.nvmrc`), Firefox for the e2e tier, `ffmpeg`
(or `imageio-ffmpeg`) for the media fixture, and Playwright browsers.

| Command | What it runs |
| --- | --- |
| `npm run dev` | Launch a throwaway Firefox with the extension temporarily installed and **auto-reload the add-on on every file save** (web-ext watch; no build step). Content-script changes still need an F5 on the tab. Useful flags: `-- --firefox-profile=<name> --keep-profile-changes` to reuse a profile (persist YouTube consent/login across runs), `--args="--headless"`, `-f <path-to-firefox>` to pin a binary. Chromium has no equivalent — reload manually via `chrome://extensions`. |
| `npm test` | Full pre-packaging suite: unit + coverage gate ≥ 90% on `lib/*`, Tier 1 Firefox e2e (DOM/UI on a synthesized time-coded fixture), Tier 2 Firefox extension + downloads smoke (`test:smoke`), Tier 3 Chromium extension full-flow (`test:ext`). |
| `npm run test:fast` | Unit + Tier 1 e2e. |
| `npm run test:yt` | Tier 3 opt-in live-YouTube check against a real watch page. Set `RUN_REAL_YT=1` (flaky by nature; run before release, not on every MR). |
| `npm run test:fixture` | (Re)synthesize the media fixture (`test/.fixtures/current/media.webm`). |
| `npm run harness:refresh` | Re-record the YouTube player chrome snapshot the harness embeds. |
| `node icons/generate.mjs` | Regenerate the extension icons (`icons/*.png`) from the glyph in that script after changing its geometry; commit the outputs. |

`npm test` bootstraps the gitignored media fixture automatically (a Playwright
`globalSetup`), so a fresh checkout works without manual steps.

### Architecture

```
lib/            pure, unit-tested modules (options, crop, timeline, state,
                scheduler, messaging, filename, storage, saveflow)
content/        content scripts: capture engine, fallback (CORS) capture,
                GIF89a encoder, and the yt-snip integration (yt-snip.js)
background.js   receives encoded bytes; downloads the clip via downloads.download
options/        options page
test/           unit (Node), e2e (Playwright), smoke (Selenium), yt (Tier 3),
                fixtures (synthesizer + static server), helpers
```

### Known gaps (deliberate de-scopes — see PLAN.md)

- **Firefox full-flow e2e**: temporary add-on installs in the automation
  environment never receive MV3 host permissions (verified environment defect,
  Bugzilla 1860304 territory), so Tier 2's trigger→drag→save→disk flow cannot
  run there. The Tier 2 smoke keeps the entire interaction flow intact and
  re-engages it automatically when permissions work again; meanwhile the
  Firefox gate is the Tier 3 live-YouTube check plus a normal-profile manual
  soak before each release.
- The live-YouTube tier captures only within the headless player's already
  buffered MSE range; far-seek capture is covered by Tier 1 on the synthetic
  stream.

## License

MIT — see [LICENSE](LICENSE).
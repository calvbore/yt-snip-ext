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
  the video returns to the timestamp it was at when the tool was activated.

## Install (unpacked extension)

This is a personal, private-use project — there is no store submission and no
packaging pipeline.

Firefox:

1. `about:debugging` → *Load Temporary Add-on* → select `manifest.json`.
2. Open `about:addons` → yt-snip → Preferences if you want to tweak settings.

Chromium:

1. `chrome://extensions` → enable *Developer mode* → *Load unpacked* → select
   this directory.

## Usage

1. On any YouTube watch page, click the snip button next to the player chrome
   (top-right of the controls).
2. Drag a rectangle over the video — that's the crop. Resize handles let you
   fine-tune it once drawn.
3. The timeline under the player shows start/preview/end handles. Drag them to
   narrow or extend the time window.
4. The loop button toggles looping playback of the window while you scrub.
5. Click **Save**. The clip is encoded in-page and handed to the extension
   background, which downloads it to your OS Downloads folder as
   `yt-snip-<title>-<timestamp>.gif`.

The saved GIF loops infinitely (NETSCAPE extension), so it plays correctly as
an Anki media file.

## Options

| Setting | Meaning |
| --- | --- |
| Frames per second | Capture rate of the saved clip (1–60; lower is smaller). |
| Max dimension (px) | Long edge of the output; the short edge scales with the crop, keeping the clip Anki-friendly. |
| Ask where to save each clip | Prompt for a location instead of auto-downloading. |

## Development

Requirements: Node.js ≥ 20 (`.nvmrc`), Firefox for the e2e tier, `ffmpeg`
(or `imageio-ffmpeg`) for the media fixture, and Playwright browsers.

| Command | What it runs |
| --- | --- |
| `npm test` | Full pre-packaging suite: unit + coverage gate ≥ 90% on `lib/*`, Tier 1 Firefox e2e (DOM/UI on a synthesized time-coded fixture), Tier 2 Firefox extension + downloads smoke (`test:smoke`), Tier 3 Chromium extension full-flow (`test:ext`). |
| `npm run test:fast` | Unit + Tier 1 e2e. |
| `npm run test:yt` | Tier 3 opt-in live-YouTube check against a real watch page. Set `RUN_REAL_YT=1` (flaky by nature; run before release, not on every MR). |
| `npm run test:fixture` | (Re)synthesize the media fixture (`test/.fixtures/current/media.webm`). |
| `npm run harness:refresh` | Re-record the YouTube player chrome snapshot the harness embeds. |

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
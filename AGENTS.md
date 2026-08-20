# AGENTS.md

## Project state

Greenfield repo: **no code, tooling, or config exists yet**. `PLAN.md` is the single source of truth for project goals. Read it before planning work.

## Conventions

- Write implementation plans in `PLAN.md` under the `# agent plans` heading, appending to it as work proceeds.
- Do not scaffold tooling that the plan doesn't require. If you add a build/test/lint setup, keep the extension runnable as a plain WebExtension (no mandatory build step).

## Product constraints (from PLAN.md)

- Firefox-first WebExtension, but must remain browser-agnostic in API usage.
- Must run as a content script on `youtube.com` and touch YouTube's existing video UI (player chrome, timeline, scrubber).
- Clip output must survive the browser into the OS downloads folder and be viewable in Anki (GIF or similar format).
- State-transition rule: whenever the snipping tool is disengaged, the video must return to the timestamp where the tool was activated.
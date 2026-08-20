'use strict';

/*
 * test/helpers/synth-global-setup.js
 *
 * Playwright globalSetup (registered in playwright.config.js): ensures the
 * deterministic media fixture exists before any Tier 1 / Tier 3 spec runs.
 *
 * The fixture is gitignored and previously was only synthesized by test:smoke
 * or test:fixture — both run AFTER test:e2e in `npm test`, so a fresh checkout
 * 404'd the video and Tier 1 timed out on `waitForVideo`. synthMedia() is
 * cached/hash-checked, so this is near-free when the fixture is already up to
 * date and makes each runner self-sufficient.
 */

module.exports = async function () {
  const { synthMedia } = await import('../fixtures/synth.mjs');
  await synthMedia({ quiet: true });
};

#!/usr/bin/env node
/*
 * icons/generate.mjs — rasterize the yt-snip glyph into the PNG sets the
 * manifests reference. Committed tooling, not a build step: run it by hand
 * after changing icon.svg's geometry, then commit the outputs.
 *
 *   node icons/generate.mjs
 *
 * Outputs (transparent-background PNGs via element screenshots):
 *   icon{16,32,48,96,128}.png            static set — snip blue (about:addons)
 *   theme-icon{16,32}-light.png          near-white strokes — dark toolbars
 *   theme-icon{16,32}-dark.png           near-black strokes — light toolbars
 */
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pkg from '../node_modules/@playwright/test/index.js';

const { firefox } = pkg;
const HERE = path.dirname(fileURLToPath(import.meta.url));

// Same geometry as content/yt-snip.js triggerIcon() — keep in sync.
const GLYPH = `
  <path d="M8 3 H5 Q3 3 3 5 V8"/>
  <path d="M16 3 H19 Q21 3 21 5 V8"/>
  <path d="M21 16 V19 Q21 21 19 21 H16"/>
  <path d="M8 21 H5 Q3 21 3 19 V16"/>
  <circle cx="9.6" cy="9.6" r="1.8"/>
  <circle cx="9.6" cy="14.4" r="1.8"/>
  <path d="M16.8 7.2 L9.67 14.33"/>
  <path d="M13.49 13.49 L16.8 16.8"/>
  <path d="M9.67 9.67 L12 12"/>`;

function svgMarkup(color) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" ` +
    `stroke="${color}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${GLYPH}</svg>`;
}

const STATIC_SET = { color: '#0f9dff', sizes: [16, 32, 48, 96, 128], name: (n) => `icon${n}.png` };
const THEME_SETS = [
  { color: '#f2f2f2', sizes: [16, 32], name: (n) => `theme-icon${n}-light.png` },
  { color: '#333333', sizes: [16, 32], name: (n) => `theme-icon${n}-dark.png` },
];

async function rasterize(page, color, size) {
  // Draw the SVG into an in-page canvas and export PNG bytes — no reliance
  // on screenshot APIs (Playwright's Firefox build implements none).
  const dataUrl = await page.evaluate(async ({ markup, size }) => {
    const img = new Image();
    const src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(markup);
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = () => reject(new Error('svg decode failed'));
      img.src = src;
    });
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0, size, size);
    return canvas.toDataURL('image/png');
  }, { markup: svgMarkup(color), size });
  return Buffer.from(dataUrl.replace(/^data:image\/png;base64,/, ''), 'base64');
}

async function main() {
  const browser = await firefox.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 200, height: 200 } });
    const page = await context.newPage();
    await page.setContent('<body></body>');
    for (const set of [STATIC_SET, ...THEME_SETS]) {
      for (const size of set.sizes) {
        const png = await rasterize(page, set.color, size);
        const out = path.join(HERE, set.name(size));
        await writeFile(out, png);
        console.log('wrote', path.basename(out), png.length + 'B');
      }
    }
    await browser.close();
  } catch (e) {
    await browser.close().catch(() => {});
    console.error(e);
    process.exit(1);
  }
}

main();

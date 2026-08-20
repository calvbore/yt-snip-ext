#!/usr/bin/env node
/*
 * test/fixtures/synth.mjs
 *
 * Synthesizes the deterministic, time-coded media fixture used by Tier 1 and
 * Tier 2 tests.
 *
 * Frames are generated in-process (raw RGB) and piped into ffmpeg, which
 * produces an H.264 MP4 with every frame a keyframe (`-g 1`) so seeks land
 * exactly on the intended frame.
 *
 * Time encoding (robust to codec rounding):
 *   - Top 8 rows: an 8-bit time barcode. `level(t) = floor(t / duration) *
 *     (2^8 - 1)`. Bit i of `level` colors slot i green vs near-black.
 *   - Marker band (rows 10..10+markerSize): a white square whose left edge
 *     sweeps left → right with t.
 *   - Everywhere else: constant mid-gray, ideal for crop in/out probes.
 *
 * The output is cached under test/.fixtures/current/, keyed by a hash of the
 * synthesis config. If a fixture already exists for the current config it is
 * left untouched (no per-run in-page encoding).
 */
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const FIXTURES_DIR = path.join(ROOT, 'test', '.fixtures');
const CURRENT_DIR = path.join(FIXTURES_DIR, 'current');

export const CONFIG = Object.freeze({
  width: 640,
  height: 360,
  fps: 30,
  durationSec: 5,
  markerSize: 48,
  barcodeHeight: 8,
  barcodeSlots: 8,
  background: [60, 60, 60], // RGB
  marker: [255, 255, 255], // RGB
  bitOn: [0, 200, 0], // RGB for barcode bit = 1
  bitOff: [16, 16, 16], // RGB for barcode bit = 0
});

function configHash() {
  return createHash('sha256').update(JSON.stringify(CONFIG)).digest('hex').slice(0, 16);
}

function findFfmpeg() {
  if (process.env.FFMPEG_PATH) return process.env.FFMPEG_PATH;
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    return 'ffmpeg';
  } catch {
    // imageio-ffmpeg ships a static binary — query it via python3.
    try {
      const exe = execFileSync('python3', [
        '-c',
        'import imageio_ffmpeg, sys; print(imageio_ffmpeg.get_ffmpeg_exe())',
      ])
        .toString()
        .trim();
      if (exe) return exe;
    } catch {
      /* fall through */
    }
  }
  throw new Error(
    'ffmpeg not found — install it, set FFMPEG_PATH, or `pip install imageio-ffmpeg`'
  );
}

/**
 * level(t): 0..255 encoding the current time across the clip.
 * The barcode encodes this so any crop containing the top rows reveals t.
 */
export function timeLevel(t, cfg = CONFIG) {
  const frac = Math.min(1, Math.max(0, t / cfg.durationSec));
  return Math.round(frac * (2 ** cfg.barcodeSlots - 1));
}

function rgbForPixel(x, y, t, cfg) {
  const width = cfg.width;
  const level = timeLevel(t, cfg);
  if (y < cfg.barcodeHeight) {
    const slot = Math.min(cfg.barcodeSlots - 1, Math.floor((x * cfg.barcodeSlots) / width));
    const on = (level & (1 << slot)) !== 0;
    return on ? cfg.bitOn : cfg.bitOff;
  }
  const markerTop = cfg.barcodeHeight + 2;
  const markerBottom = markerTop + cfg.markerSize;
  if (y >= markerTop && y < markerBottom) {
    const frac = Math.min(1, Math.max(0, t / cfg.durationSec));
    const mx = Math.round(frac * (width - cfg.markerSize));
    if (x >= mx && x < mx + cfg.markerSize) {
      return cfg.marker;
    }
  }
  return cfg.background;
}

function makePpmFrame(t, cfg) {
  const { width, height } = cfg;
  const header = `P6\n${width} ${height}\n255\n`;
  const body = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b] = rgbForPixel(x, y, t, cfg);
      const p = (y * width + x) * 3;
      body[p] = r;
      body[p + 1] = g;
      body[p + 2] = b;
    }
  }
  return Buffer.concat([Buffer.from(header), body]);
}

export async function synthMedia({ cfg = CONFIG, outDir = CURRENT_DIR, quiet = false } = {}) {
  const hash = configHash();
  const outFile = path.join(outDir, 'media.webm');
  const configFile = path.join(outDir, 'config.json');

  if (existsSync(outFile) && existsSync(configFile)) {
    let existingHash = null;
    try {
      existingHash = JSON.parse(readFileSync(configFile, 'utf8')).hash;
    } catch {
      /* fall through */
    }
    if (existingHash === hash) {
      if (!quiet) console.log(`[fixture] cached ${path.relative(ROOT, outFile)}`);
      return { outFile, configHash: hash, cached: true };
    }
  }

  mkdirSync(outDir, { recursive: true });
  const tmp = outFile + '.tmp.webm';
  if (existsSync(tmp)) rmSync(tmp);

  const ffmpeg = findFfmpeg();
  const totalFrames = cfg.fps * cfg.durationSec;
  const child = spawn(
    ffmpeg,
    [
      '-y',
      '-f', 'image2pipe',
      '-vcodec', 'ppm',
      '-framerate', String(cfg.fps),
      '-i', '-',
      '-c:v', 'libvpx-vp9',
      '-deadline', 'realtime',
      '-cpu-used', '8',
      '-crf', '24',
      '-pix_fmt', 'yuv420p',
      '-g', '1',
      '-r', String(cfg.fps),
      tmp,
    ],
    { stdio: ['pipe', 'inherit', 'inherit'] }
  );

  const encoder = new Promise((resolve, reject) => {
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error('ffmpeg exited ' + code))));
    child.on('error', reject);
  });

  for (let i = 0; i < totalFrames; i++) {
    const t = i / cfg.fps;
    child.stdin.write(makePpmFrame(t, cfg));
  }
  child.stdin.end();

  await encoder;
  rmSync(outFile, { force: true });
  writeFileSync(outFile, readFileSync(tmp));
  rmSync(tmp);
  writeFileSync(configFile, JSON.stringify({ hash, config: cfg }, null, 2));

  if (!quiet) console.log(`[fixture] wrote ${path.relative(ROOT, outFile)} (${totalFrames} frames)`);
  return { outFile, configHash: hash, cached: false };
}

/* CLI entrypoint: `node test/fixtures/synth.mjs [outDir]` */
if (import.meta.url === `file://${process.argv[1]}`) {
  const outDir = process.argv[2] ? path.resolve(process.argv[2]) : CURRENT_DIR;
  synthMedia({ outDir }).then(() => process.exit(0)).catch((e) => {
    console.error('[fixture] synthesis failed:', e.message);
    process.exit(1);
  });
}
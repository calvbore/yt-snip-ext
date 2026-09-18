'use strict';

/*
 * test/helpers/webm-validate.js
 *
 * A real WebM validator used as the shared semantic checker for M16 output,
 * mirroring gif-validate.js's role for GIFs. Two layers:
 *
 *   1. `validateWebm()` — container/track semantic validation through the
 *      vendored mediabunny demuxer (independent of the encode path): codec,
 *      dimensions, duration, and the full per-packet timestamp/duration/
 *      keyframe model. No WebCodecs needed — packet-level inspection works
 *      in Node 20.
 *
 *   2. `decodeFrameRgba()` — pixel-level validation via ffmpeg: decodes the
 *      Nth frame to raw RGB24 so tests can assert actual rendered colors.
 *      Uses the same ffmpeg-locating strategy as test/fixtures/synth.mjs.
 *
 * The muxer/encoder and this validator are deliberately separate
 * implementations sharing only the container spec.
 */

const { spawnSync } = require('node:child_process');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

const M = require('../../lib/vendor/mediabunny.js');

function toBytes(input) {
  if (input instanceof Uint8Array) return input;
  if (input && input.buffer instanceof ArrayBuffer) {
    return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  }
  throw new Error('unexpected buffer type');
}

/** Structural signature check: EBML magic (Matroska/WebM). */
function hasEbmlMagic(bytes) {
  return bytes.length > 4 &&
    bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3;
}

/**
 * Semantic container validation. Resolves:
 *   { codec, width, height, duration, packets: [{ timestamp, duration, key }] }
 */
async function validateWebm(input) {
  const bytes = toBytes(input);
  if (!hasEbmlMagic(bytes)) {
    throw new Error('not a WebM/EBML container (missing EBML magic)');
  }
  const webmInput = new M.Input({
    formats: [new M.WebMInputFormat()],
    source: new M.BufferSource(bytes),
  });
  const track = await webmInput.getPrimaryVideoTrack();
  if (!track) throw new Error('WebM contains no video track');
  const duration = await track.computeDuration();
  const sink = new M.EncodedPacketSink(track);
  const packets = [];
  for await (const packet of sink.packets()) {
    packets.push({
      timestamp: packet.timestamp,
      duration: packet.duration,
      key: packet.type === 'key',
    });
  }
  return {
    codec: track.codec,
    width: track.codedWidth,
    height: track.codedHeight,
    duration: duration,
    packets: packets,
  };
}

function findFfmpeg() {
  if (process.env.FFMPEG_PATH) return process.env.FFMPEG_PATH;
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    return 'ffmpeg';
  } catch {
    try {
      const exe = execFileSync('python3', [
        '-c',
        'import imageio_ffmpeg, sys; print(imageio_ffmpeg.get_ffmpeg_exe())',
      ]).toString().trim();
      if (exe) return exe;
    } catch {
      /* fall through */
    }
  }
  throw new Error('ffmpeg not found — install it, set FFMPEG_PATH, or `pip install imageio-ffmpeg`');
}

/**
 * Decode one frame of a WebM (0-based index) to RGBA via ffmpeg's rawvideo
 * pipe. Returns { width, height, rgba: Uint8Array }.
 */
function decodeFrameRgba(input, frameIndex, width, height) {
  const bytes = toBytes(input);
  const res = spawnSync(
    findFfmpeg(),
    [
      '-v', 'error',
      '-i', 'pipe:0',
      '-vf', 'select=eq(n\\,' + Math.max(0, frameIndex) + ')',
      '-frames:v', '1',
      '-f', 'rawvideo',
      '-pix_fmt', 'rgba',
      '-',
    ],
    { input: Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength), maxBuffer: 64 * 1024 * 1024 }
  );
  if (res.status !== 0 || res.stderr.toString().trim()) {
    throw new Error('ffmpeg frame decode failed: ' + res.stderr.toString().slice(0, 400));
  }
  const out = new Uint8Array(res.stdout);
  if (out.length !== width * height * 4) {
    throw new Error('decoded frame size mismatch: ' + out.length + ' vs ' + width * height * 4);
  }
  return { rgba: out, width: width, height: height };
}

module.exports = {
  validateWebm: validateWebm,
  decodeFrameRgba: decodeFrameRgba,
  hasEbmlMagic: hasEbmlMagic,
};

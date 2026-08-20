'use strict';

/*
 * test/helpers/gif-validate.js
 *
 * A real, dependency-free GIF decoder used as the shared semantic validator
 * across all three test tiers. This is *not* the encoder used by the
 * extension — it is an independent implementation (own LZW decompressor) so
 * encode/decode are cross-checked against each other rather than sharing bugs.
 *
 * Supports GIF87a/89a, local color tables, graphics control extensions
 * (disposal/transparency/delay), and interlace. Frame pixel data is
 * composited onto a full logical-screen RGBA buffer per the GIF semantics, so
 * semantic assertions (crop region, frame content, timing) can be made against
 * actual rendered pixels.
 */

const BUFFER_FORMAT = /^(?:ArrayBuffer|Buffer|Uint8Array)$/;

class GifDecodeError extends Error {
  constructor(message) {
    super(message);
    this.name = 'GifDecodeError';
  }
}

function toBytes(input) {
  if (input instanceof Uint8Array) {
    return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  }
  if (typeof Buffer !== 'undefined' && Buffer.isBuffer(input)) {
    return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  }
  if (input && input.buffer instanceof ArrayBuffer) {
    return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  }
  throw new GifDecodeError('unexpected buffer type');
}

function collectSubBlocks(bytes, offset) {
  const out = [];
  let consumed = 0;
  for (;;) {
    const size = bytes[offset + consumed];
    consumed += 1;
    if (size === 0) break;
    for (let i = 0; i < size; i++) {
      out.push(bytes[offset + consumed + i]);
    }
    consumed += size;
  }
  return { data: out, consumed: consumed };
}

/*
 * LZW decompression, ported from omggif's GifReaderLZWOutputIndexStream
 * (Dean McNamee, MIT). The code table is indexed by CODE VALUE, not by
 * insertion order — new codes begin at `eoi_code + 1`, so entries at
 * dictionary["clear"], dictionary["eoi"] are never occupied. Porting the
 * battle-tested table/chase strategy avoids the off-by-one code-size and
 * index-convention bugs a from-scratch implementation tends to hit.
 *
 * `expectedLength` (pixels) is enforced so corrupt streams fail loudly.
 */
function lzwDecode(minCodeSize, dataBytes, expectedLength) {
  if (minCodeSize < 2 || minCodeSize > 8) {
    throw new GifDecodeError('invalid LZW minimum code size: ' + minCodeSize);
  }
  const clearCode = 1 << minCodeSize;
  const eoiCode = clearCode + 1;
  let nextCode = eoiCode + 1; // first available dictionary slot == its code
  let curCodeSize = minCodeSize + 1;
  let codeMask = (1 << curCodeSize) - 1;

  const output = [];
  const codeTable = new Int32Array(4096);

  let bitShift = 0; // valid bits held in `cur`
  let cur = 0;
  let bitPos = 0;
  let prevCode = null;

  while (true) {
    // Top up a 16-bit window (LSB-first, GIF convention).
    while (bitShift < 16) {
      if (bitPos >= dataBytes.length) break; // stream exhausted (byte padding)
      cur |= dataBytes[bitPos++] << bitShift;
      bitShift += 8;
    }
    if (bitShift < curCodeSize) break; // truncated final code — treat as EOI

    const code = cur & codeMask;
    cur >>= curCodeSize;
    bitShift -= curCodeSize;

    if (code === clearCode) {
      nextCode = eoiCode + 1;
      curCodeSize = minCodeSize + 1;
      codeMask = (1 << curCodeSize) - 1;
      prevCode = null;
      continue;
    }
    if (code === eoiCode) {
      break;
    }

    // When the decoder first encounters a fresh slot (code === next_code) it
    // must reconstruct {CODE-1} + k; chase prev_code for that case.
    const chaseCode = code < nextCode ? code : prevCode;
    if (chaseCode === null || chaseCode > 4095) {
      throw new GifDecodeError('LZW stream error: dangling code ' + code);
    }

    // Chase chaseCode's prefix chain to its root literal. Each table entry
    // holds `prefix << 8 | lastByte`; the chased byte is the LOW byte of the
    // stored value, and the prefix is its HIGH byte.
    const mid = [];
    let chain = chaseCode;
    while (chain > clearCode) {
      const stored = codeTable[chain];
      mid.push(stored & 0xff);
      chain = stored >> 8;
    }
    const root = chain; // the entry's first byte (a literal code)

    // Full entry bytes: root + reverse(mid), plus a trailing root for the
    // fresh-slot {CODE-1}+k case.
    const entry = [root];
    for (let i = mid.length - 1; i >= 0; i--) entry.push(mid[i]);
    if (chaseCode !== code) entry.push(root);

    if (expectedLength !== undefined && output.length + entry.length > expectedLength) {
      throw new GifDecodeError('LZW stream exceeds expected output length');
    }
    for (const b of entry) output.push(b);

    if (prevCode !== null && nextCode < 4096) {
      codeTable[nextCode++] = (prevCode << 8) | root;
      if (nextCode >= codeMask + 1 && curCodeSize < 12) {
        ++curCodeSize;
        codeMask = (codeMask << 1) | 1;
      }
    }
    prevCode = code;
  }

  return output;
}

function deinterlace(indices, width, height) {
  const reordered = new Array(indices.length);
  let pos = 0;
  const passes = [
    { start: 0, step: 8 },
    { start: 4, step: 8 },
    { start: 2, step: 4 },
    { start: 1, step: 2 },
  ];
  for (const pass of passes) {
    for (let y = pass.start; y < height; y += pass.step) {
      const rowStart = y * width;
      for (let x = 0; x < width; x++) {
        reordered[rowStart + x] = indices[pos++];
      }
    }
  }
  return reordered;
}

/**
 * Decode a GIF into a composed RGBA pixel model.
 *
 * Returns:
 *   {
 *     width, height,                     // logical screen dimensions
 *     frames: [{
 *       delayMs,                          // GCE delay (0 when absent)
 *       dispose,                          // numeric disposal method
 *       transparent,                      // color-table index or -1
 *       rgba,                             // Uint8Array(w*h*4) composed state
 *     }],
 *     extensions: ['89a', 'app:NETSCAPE2.0', ...],  // informational
 *   }
 */
function decodeGif(input) {
  const bytes = toBytes(input);
  if (bytes.length < 13) {
    throw new GifDecodeError('input too short to be a GIF');
  }
  const header = String.fromCharCode(...bytes.slice(0, 6));
  if (header !== 'GIF87a' && header !== 'GIF89a') {
    throw new GifDecodeError('bad GIF header: ' + header);
  }

  const width = bytes[6] | (bytes[7] << 8);
  const height = bytes[8] | (bytes[9] << 8);
  if (!width || !height) {
    throw new GifDecodeError('zero-dimension GIF');
  }
  const packed = bytes[10];
  const globalTableSize = 2 << (packed & 0x07);
  const bgIndex = bytes[11];

  let offset = 13;
  let globalTable = null;
  if (packed & 0x80) {
    globalTable = readColorTable(bytes, offset, globalTableSize);
    offset += 3 * globalTableSize;
  }

  const frames = [];
  let canvas = new Uint8Array(width * height * 4);
  let haveCanvas = false;
  let pending = null; // parsed GCE waiting for the next image

  while (offset < bytes.length) {
    const block = bytes[offset++];
    if (block === 0x3b) {
      break; // trailer
    }
    if (block === 0x21) {
      // extension
      const label = bytes[offset++];
      if (label === 0xf9) {
        // graphics control extension: fixed 4-byte content + terminator
        const size = bytes[offset++];
        if (size !== 4) {
          throw new GifDecodeError('bad graphic control extension size');
        }
        const flags = bytes[offset];
        pending = {
          dispose: (flags >> 2) & 0x07,
          transparentFlag: flags & 0x01,
          transparent: flags & 0x01 ? bytes[offset + 3] : -1,
          // 2-byte little-endian delay in units of 1/100 s.
          delayMs: (bytes[offset + 1] | (bytes[offset + 2] << 8)) * 10,
        };
        offset += 4;
        offset += 1; // terminator
        continue;
      }
      if (label === 0xff) {
        // application extension: size byte + identifier/auth, then sub-blocks
        offset += bytes[offset] + 1; // skip content incl. its size byte
      }
      // comment (0xfe), plain-text (0x01) and trailing app sub-blocks: skip
      // concatenated sub-blocks up to the terminator.
      for (;;) {
        const s = bytes[offset++];
        if (s === 0) break;
        offset += s;
      }
      continue;
    }
    if (block === 0x2c) {
      // image descriptor
      const left = bytes[offset] | (bytes[offset + 1] << 8);
      const top = bytes[offset + 2] | (bytes[offset + 3] << 8);
      const imgW = bytes[offset + 4] | (bytes[offset + 5] << 8);
      const imgH = bytes[offset + 6] | (bytes[offset + 7] << 8);
      const imgPacked = bytes[offset + 8];
      offset += 9;

      let table = globalTable;
      let tableSize = globalTableSize;
      if (imgPacked & 0x80) {
        tableSize = 2 << (imgPacked & 0x07);
        table = readColorTable(bytes, offset, tableSize);
        offset += 3 * tableSize;
      }

      const minCode = bytes[offset++];
      const collected = collectSubBlocks(bytes, offset);
      offset += collected.consumed;
      const data = collected.data;

      const indices = lzwDecode(minCode, data, imgW * imgH);
      if (indices.length !== imgW * imgH) {
        throw new GifDecodeError(
          'decoded ' + indices.length + ' pixels, expected ' + imgW * imgH
        );
      }
      const finalIndices = imgPacked & 0x40 ? deinterlace(indices, imgW, imgH) : indices;

      if (!haveCanvas) {
        canvas = new Uint8Array(width * height * 4);
        for (let i = 0; i < canvas.length; i += 4) {
          if (table && bgIndex >= 0 && bgIndex < table.length) {
            const c = table[bgIndex];
            canvas[i] = c[0];
            canvas[i + 1] = c[1];
            canvas[i + 2] = c[2];
            canvas[i + 3] = 255;
          }
        }
        haveCanvas = true;
      }

      const gce = pending || { dispose: 0, transparent: -1, delayMs: 0 };
      pending = null;

      // Dispose of the previous frame according to its stored disposal before
      // compositing the new one (frame 0 has nothing to dispose).
      if (frames.length > 0) {
        const prevData = frames[frames.length - 1];
        if (prevData.dispose === 2 || prevData.dispose === 3) {
          for (let y = prevData.top; y < prevData.top + prevData.height && y < height; y++) {
            for (let x = prevData.left; x < prevData.left + prevData.width && x < width; x++) {
              const p = (y * width + x) * 4;
              canvas[p] = 0;
              canvas[p + 1] = 0;
              canvas[p + 2] = 0;
              canvas[p + 3] = prevData.dispose === 2 ? 0 : 255;
            }
          }
        }
      }

      // composite
      for (let y = 0; y < imgH; y++) {
        const cy = top + y;
        if (cy >= height) continue;
        for (let x = 0; x < imgW; x++) {
          const cx = left + x;
          if (cx >= width) continue;
          const idx = finalIndices[y * imgW + x];
          const p = (cy * width + cx) * 4;
          if (idx === gce.transparent) {
            if (gce.dispose === 2) {
              canvas[p + 3] = 0;
            }
            continue;
          }
          if (!table || idx >= table.length) {
            continue;
          }
          const c = table[idx];
          canvas[p] = c[0];
          canvas[p + 1] = c[1];
          canvas[p + 2] = c[2];
          canvas[p + 3] = 255;
        }
      }

      const rgba = new Uint8Array(canvas);
      frames.push({
        delayMs: gce.delayMs,
        dispose: gce.dispose,
        transparent: gce.transparent,
        top: top,
        left: left,
        width: imgW,
        height: imgH,
        rgba: rgba,
      });
      continue;
    }
    throw new GifDecodeError('unexpected block 0x' + block.toString(16));
  }

  if (frames.length === 0) {
    throw new GifDecodeError('GIF contains no frames');
  }

  return { width, height, frames };
}

function readColorTable(bytes, offset, count) {
  const table = [];
  for (let i = 0; i < count; i++) {
    table.push([
      bytes[offset + i * 3],
      bytes[offset + i * 3 + 1],
      bytes[offset + i * 3 + 2],
    ]);
  }
  return table;
}

/** Equality helper used by assertions across tiers. */
function pixelAt(rgba, width, x, y) {
  const p = (y * width + x) * 4;
  return [rgba[p], rgba[p + 1], rgba[p + 2], rgba[p + 3]];
}

function approxEqual(a, b, tol) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (Math.abs(a[i] - b[i]) > tol) return false;
  }
  return true;
}

module.exports = {
  decodeGif,
  pixelAt,
  approxEqual,
  lzwDecode,
  GifDecodeError,
};
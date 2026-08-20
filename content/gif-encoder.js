/*
 * content/gif-encoder.js
 *
 * Self-contained GIF89a encoder for yt-snip output.
 *
 *  - Median-cut quantizer maps an RGBA frame to a per-frame local palette
 *    (≤ 256 colors), so each captured frame is quantized independently.
 *  - LZW code-stream writer follows the classic "compress" / GIF approach
 *    (the same algorithm as omggif's GifWriter, MIT; adapted here so the
 *    encoder and the test-tier decoder stay independent implementations).
 *  - Emits the NETSCAPE2.0 loop extension (infinite) so the clip loops in Anki.
 *
 * UMD: `require`d in Node unit tests, loaded as a classic content script
 * otherwise (attaches `window.ytSnipGif`).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else if (typeof define === 'function' && define.amd) {
    define([], factory);
  } else {
    root.ytSnipGif = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var MAX_COLORS = 256;
  var BITS = 12;

  /* ------------------------------------------------------------------ *
   * Median-cut quantization
   * ------------------------------------------------------------------ */

  function gatherColors(rgba) {
    var map = new Map();
    for (var i = 0; i < rgba.length; i += 4) {
      var key = ((rgba[i] << 16) | (rgba[i + 1] << 8) | rgba[i + 2]) >>> 0;
      if (!map.has(key)) {
        map.set(key, 1);
      } else {
        map.set(key, map.get(key) + 1);
      }
    }
    var entries = [];
    map.forEach(function (count, key) {
      entries.push({
        r: (key >> 16) & 0xff,
        g: (key >> 8) & 0xff,
        b: key & 0xff,
        count: count,
      });
    });
    return entries;
  }

  function range(list) {
    var minR = 255, maxR = 0, minG = 255, maxG = 0, minB = 255, maxB = 0;
    for (var i = 0; i < list.length; i++) {
      var c = list[i];
      if (c.r < minR) minR = c.r; if (c.r > maxR) maxR = c.r;
      if (c.g < minG) minG = c.g; if (c.g > maxG) maxG = c.g;
      if (c.b < minB) minB = c.b; if (c.b > maxB) maxB = c.b;
    }
    return { r: maxR - minR, g: maxG - minG, b: maxB - minB };
  }

  function medianCut(colors, target) {
    if (colors.length <= target) {
      return colors.map(function (c) {
        return { r: c.r, g: c.g, b: c.b, count: c.count };
      });
    }
    var boxes = [colors];

    while (boxes.length < target) {
      // pick the box with the most pixels (or largest range as a tiebreak)
      var bi = 0;
      var bestCount = -1;
      for (var i = 0; i < boxes.length; i++) {
        var total = 0;
        for (var j = 0; j < boxes[i].length; j++) total += boxes[i][j].count;
        if (total > bestCount) {
          bestCount = total;
          bi = i;
        }
      }
      var box = boxes[bi];
      if (box.length === 1) break; // cannot split a solid box
      var rng = range(box);
      var channel = rng.r >= rng.g && rng.r >= rng.b ? 'r' : rng.g >= rng.b ? 'g' : 'b';

      // sort by the chosen channel, split at the weighted median
      box.sort(function (a, b) { return a[channel] - b[channel]; });
      var sum = 0;
      for (var k = 0; k < box.length; k++) sum += box[k].count;
      var half = sum / 2;
      var acc = 0;
      var splitAt = box.length - 1;
      for (var m = 0; m < box.length; m++) {
        acc += box[m].count;
        if (acc >= half) {
          splitAt = m + 1;
          break;
        }
      }
      if (splitAt <= 0 || splitAt >= box.length) splitAt = Math.floor(box.length / 2);
      boxes[bi] = box.slice(0, splitAt);
      boxes.push(box.slice(splitAt));
    }

    return boxes.map(function (box) {
      var r = 0, g = 0, b = 0, n = 0;
      for (var i = 0; i < box.length; i++) {
        r += box[i].r * box[i].count;
        g += box[i].g * box[i].count;
        b += box[i].b * box[i].count;
        n += box[i].count;
      }
      return { r: Math.round(r / n), g: Math.round(g / n), b: Math.round(b / n) };
    });
  }

  function nearest(palette, r, g, b) {
    var best = 0;
    var bestDist = Infinity;
    for (var i = 0; i < palette.length; i++) {
      var dr = palette[i].r - r, dg = palette[i].g - g, db = palette[i].b - b;
      var dist = dr * dr + dg * dg + db * db;
      if (dist < bestDist) {
        bestDist = dist;
        best = i;
      }
    }
    return best;
  }

  /**
   * Quantize an RGBA frame. Returns { palette: [r,g,b, ...], indices: Uint8Array }.
   * Only opaque pixels are considered; alpha is dropped (video frames are opaque).
   */
  function quantizeFrame(rgba, maxColors) {
    var max = maxColors || MAX_COLORS;
    var colors = gatherColors(rgba);
    var boxes = medianCut(colors, max);
    var palette = [];
    for (var i = 0; i < boxes.length; i++) {
      palette.push(boxes[i].r, boxes[i].g, boxes[i].b);
    }
    var indices = new Uint8Array(rgba.length / 4);
    // cache nearest lookups per distinct color key
    var lookup = new Map();
    var key = 0;
    for (var px = 0; px < indices.length; px++) {
      var i4 = px * 4;
      key = ((rgba[i4] << 16) | (rgba[i4 + 1] << 8) | rgba[i4 + 2]) >>> 0;
      var idx = lookup.get(key);
      if (idx === undefined) {
        idx = nearest(boxes, rgba[i4], rgba[i4 + 1], rgba[i4 + 2]);
        lookup.set(key, idx);
      }
      indices[px] = idx;
    }
    return { palette: palette, indices: indices };
  }

  /* ------------------------------------------------------------------ *
   * LZW code stream (classic GIF, matches the shared decoder)
   * ------------------------------------------------------------------ */

  function GifWriterLZW(out, indexStream, minCodeSize) {
    var clearCode = 1 << minCodeSize;
    var codeMask = clearCode - 1;
    var eoiCode = clearCode + 1;
    var nextCode = eoiCode + 1;
    var curCodeSize = minCodeSize + 1;
    var curShift = 0;
    var cur = 0;

    function emitByte(b) {
      out.push(b);
    }

    function emitCode(c) {
      cur |= c << curShift;
      curShift += curCodeSize;
      while (curShift >= 8) {
        emitByte(cur & 0xff);
        cur >>= 8;
        curShift -= 8;
      }
    }

    var ibCode = indexStream[0] & codeMask;
    var table = new Map();

    emitCode(clearCode);

    for (var i = 1; i < indexStream.length; i++) {
      var k = indexStream[i] & codeMask;
      var key = ((ibCode << 8) | k) >>> 0;
      var existing = table.get(key);

      if (existing === undefined) {
        emitCode(ibCode);
        if (nextCode === (1 << BITS)) {
          emitCode(clearCode);
          nextCode = eoiCode + 1;
          curCodeSize = minCodeSize + 1;
          table = new Map();
        } else {
          if (nextCode >= (1 << curCodeSize)) ++curCodeSize;
          table.set(key, nextCode++);
        }
        ibCode = k;
      } else {
        ibCode = existing;
      }
    }

    emitCode(ibCode);
    emitCode(eoiCode);

    // flush remaining bits
    if (curShift > 0) {
      emitByte(cur & 0xff);
      cur = 0;
      curShift = 0;
    }
  }

  /* ------------------------------------------------------------------ *
   * GIF89a writer
   * ------------------------------------------------------------------ */

  function pad2(n) { return n & 0xff; }

  function GifEncoder(width, height) {
    if (!(width > 0 && height > 0)) throw new Error('GifEncoder: bad dimensions');
    this.width = width;
    this.height = height;
    this.frames = [];
  }

  GifEncoder.prototype.addFrame = function (pixels, opts) {
    opts = opts || {};
    var data, w, h;
    if (pixels && pixels.data && pixels.width !== undefined) {
      data = pixels.data;
      w = pixels.width;
      h = pixels.height;
    } else {
      data = pixels;
      w = this.width;
      h = this.height;
    }
    if (w !== this.width || h !== this.height) {
      throw new Error('GifEncoder: frame size mismatch ' + w + 'x' + h);
    }
    var delayMs = opts.delayMs === undefined ? 100 : opts.delayMs;
    var delayCs = Math.max(1, Math.round(delayMs / 10));
    var q = quantizeFrame(data, MAX_COLORS);
    this.frames.push({ q: q, delayCs: delayCs });
    return this;
  };

  /** Serialize all frames to a GIF89a byte array. */
  GifEncoder.prototype.end = function () {
    if (this.frames.length === 0) throw new Error('GifEncoder: no frames');
    var out = [];
    var W = this.width, H = this.height;

    // header
    out.push(0x47, 0x49, 0x46, 0x38, 0x39, 0x61); // GIF89a
    out.push(pad2(W), pad2(W >> 8), pad2(H), pad2(H >> 8));
    out.push(0x00, 0x00, 0x00); // no global table, bg 0, aspect 0

    // loop extension (infinite)
    out.push(0x21, 0xff, 0x0b, 0x4e, 0x45, 0x54, 0x53, 0x43, 0x41, 0x50, 0x45,
      0x32, 0x2e, 0x30, 0x03, 0x01, 0x00, 0x00, 0x00);

    for (var f = 0; f < this.frames.length; f++) {
      var frame = this.frames[f];
      var numColors = frame.q.palette.length / 3;
      var minCodeSize = Math.max(2, Math.ceil(Math.log2(numColors)));
      var tableSize = 1 << minCodeSize;

      // graphics control extension (delay only)
      var delayLo = frame.delayCs & 0xff;
      var delayHi = (frame.delayCs >> 8) & 0xff;
      out.push(0x21, 0xf9, 0x04, 0x00, delayLo, delayHi, 0x00, 0x00);

      // image descriptor (full frame, local color table)
      out.push(0x2c);
      out.push(0x00, 0x00, 0x00, 0x00);
      out.push(pad2(W), pad2(W >> 8), pad2(H), pad2(H >> 8));
      out.push(0x80 | (minCodeSize - 1));

      // local color table
      for (var c = 0; c < tableSize; c++) {
        if (c < numColors) {
          out.push(frame.q.palette[c * 3], frame.q.palette[c * 3 + 1], frame.q.palette[c * 3 + 2]);
        } else {
          out.push(0, 0, 0); // pad the table to a power of two
        }
      }

      // image data: min code size + LZW stream in ≤255-byte sub-blocks
      out.push(minCodeSize);
      var stream = [];
      GifWriterLZW(stream, frame.q.indices, minCodeSize);
      for (var p = 0; p < stream.length; p += 255) {
        var chunk = Math.min(255, stream.length - p);
        out.push(chunk);
        for (var q = 0; q < chunk; q++) out.push(stream[p + q]);
      }
      out.push(0x00); // end of image data
    }

    out.push(0x3b); // trailer
    return new Uint8Array(out);
  };

  /** Convenience: quantize is exposed for tests. */
  GifEncoder.quantizeFrame = quantizeFrame;

  return { GifEncoder: GifEncoder, quantizeFrame: quantizeFrame, medianCut: medianCut };
});
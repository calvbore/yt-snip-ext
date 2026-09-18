/*
 * content/gif-encoder.js
 *
 * Self-contained GIF89a encoder for yt-snip output.
 *
 *  - Median-cut quantizer maps an RGBA frame to a per-frame local palette
 *    (≤ 256 colors). Quality upgrades (M16): the box to split is chosen by
 *    *variance × pixel count* (not count alone — a dominant background used
 *    to starve small objects of palette entries), and the palette is refined
 *    with 2 weighted k-means (Lloyd) passes over the distinct colors.
 *  - Optional Floyd–Steinberg error-diffusion dithering (serpentine, clamped,
 *    5-bit bucket cache) turns residual quantization error into noise instead
 *    of hard-edged banding — the main defense for smooth video gradients.
 *    Nearest-color lookups are perceptually weighted (2/4/3).
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

  function boxTotal(list) {
    var total = 0;
    for (var i = 0; i < list.length; i++) total += list[i].count;
    return total;
  }

  /**
   * Median cut with a variance-aware box picker: the box to split maximizes
   * (color volume × pixel count) rather than pixel count alone, so a huge
   * uniform background cannot monopolize the palette while small-but-distinct
   * objects collapse into averaged blends (M16 finding 2).
   */
  function medianCut(colors, target) {
    if (colors.length <= target) {
      return colors.map(function (c) {
        return { r: c.r, g: c.g, b: c.b, count: c.count };
      });
    }
    var boxes = [colors];

    while (boxes.length < target) {
      var bi = -1;
      var bestScore = -1;
      for (var i = 0; i < boxes.length; i++) {
        var box = boxes[i];
        if (box.length === 1) continue; // cannot split a single-color box
        var rng = range(box);
        var spread = rng.r + rng.g + rng.b;
        if (spread === 0) continue; // solid box — splitting adds nothing
        var score = boxTotal(box) * (spread + 1);
        if (score > bestScore) {
          bestScore = score;
          bi = i;
        }
      }
      if (bi < 0) break; // every remaining box is solid or single-color

      var chosen = boxes[bi];
      var crng = range(chosen);
      var channel = crng.r >= crng.g && crng.r >= crng.b ? 'r' : crng.g >= crng.b ? 'g' : 'b';

      // sort by the chosen channel, split at the weighted median
      chosen.sort(function (a, b) { return a[channel] - b[channel]; });
      var sum = boxTotal(chosen);
      var half = sum / 2;
      var acc = 0;
      var splitAt = chosen.length - 1;
      for (var m = 0; m < chosen.length; m++) {
        acc += chosen[m].count;
        if (acc >= half) {
          splitAt = m + 1;
          break;
        }
      }
      if (splitAt <= 0 || splitAt >= chosen.length) splitAt = Math.floor(chosen.length / 2);
      boxes[bi] = chosen.slice(0, splitAt);
      boxes.push(chosen.slice(splitAt));
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

  /** Perceptual squared distance (green dominates human perception). */
  function perceptualDist(r, g, b, pr, pg, pb) {
    var dr = pr - r, dg = pg - g, db = pb - b;
    return 2 * dr * dr + 4 * dg * dg + 3 * db * db;
  }

  function nearest(palette, r, g, b) {
    var best = 0;
    var bestDist = Infinity;
    for (var i = 0; i < palette.length; i++) {
      var dist = perceptualDist(r, g, b, palette[i].r, palette[i].g, palette[i].b);
      if (dist < bestDist) {
        bestDist = dist;
        best = i;
      }
    }
    return best;
  }

  /**
   * Weighted k-means (Lloyd) refinement of a median-cut palette, run over the
   * distinct colors (capped by frequency — the tail is perceptually rare).
   * Two iterations: reassign colors to the nearest centroid, recompute each
   * centroid as its members' count-weighted mean. Empty centroids keep their
   * previous position so the palette size stays stable.
   */
  function kmeansRefine(colors, palette, iterations) {
    if (palette.length === 0) return palette;
    var K = palette.length;
    var cent = new Float64Array(K * 3);
    for (var c0 = 0; c0 < K; c0++) {
      cent[c0 * 3] = palette[c0].r;
      cent[c0 * 3 + 1] = palette[c0].g;
      cent[c0 * 3 + 2] = palette[c0].b;
    }
    var MAX_KMEANS_COLORS = 20000;
    var pool = colors;
    if (colors.length > MAX_KMEANS_COLORS) {
      pool = colors.slice().sort(function (a, b) { return b.count - a.count; })
        .slice(0, MAX_KMEANS_COLORS);
    }
    for (var it = 0; it < iterations; it++) {
      var sums = new Float64Array(K * 4); // r,g,b,count per centroid
      for (var i = 0; i < pool.length; i++) {
        var c = pool[i];
        var best = 0;
        var bestDist = Infinity;
        for (var k = 0; k < K; k++) {
          var dist = perceptualDist(c.r, c.g, c.b, cent[k * 3], cent[k * 3 + 1], cent[k * 3 + 2]);
          if (dist < bestDist) { bestDist = dist; best = k; }
        }
        sums[best * 4] += c.r * c.count;
        sums[best * 4 + 1] += c.g * c.count;
        sums[best * 4 + 2] += c.b * c.count;
        sums[best * 4 + 3] += c.count;
      }
      for (var k2 = 0; k2 < K; k2++) {
        if (sums[k2 * 4 + 3] > 0) {
          cent[k2 * 3] = sums[k2 * 4] / sums[k2 * 4 + 3];
          cent[k2 * 3 + 1] = sums[k2 * 4 + 1] / sums[k2 * 4 + 3];
          cent[k2 * 3 + 2] = sums[k2 * 4 + 2] / sums[k2 * 4 + 3];
        }
      }
    }
    var out = new Array(K);
    for (var k3 = 0; k3 < K; k3++) {
      out[k3] = {
        r: Math.min(255, Math.max(0, Math.round(cent[k3 * 3]))),
        g: Math.min(255, Math.max(0, Math.round(cent[k3 * 3 + 1]))),
        b: Math.min(255, Math.max(0, Math.round(cent[k3 * 3 + 2]))),
      };
    }
    return out;
  }

  /**
   * Floyd–Steinberg error diffusion (serpentine scan, clamped diffusion
   * buffer). Nearest lookups are cached on a 5-bit-per-channel bucket key —
   * diffused colors only ever move a few steps from their source, so the
   * bucket approximation is safe and keeps the cost near O(1) per pixel.
   */
  function ditherIndices(rgba, palette, width, height) {
    var K = palette.length;
    var cache = new Int16Array(32768).fill(-1);
    var buf = new Float32Array(width * height * 3);
    var i, p;
    for (p = 0, i = 0; p < width * height; p++, i += 4) {
      buf[p * 3] = rgba[i];
      buf[p * 3 + 1] = rgba[i + 1];
      buf[p * 3 + 2] = rgba[i + 2];
    }
    var indices = new Uint8Array(width * height);
    var clamp = function (v) { return v < 0 ? 0 : v > 255 ? 255 : v; };

    function nearestCached(r, g, b) {
      var key = (((r & 0xf8) << 7) | ((g & 0xf8) << 2) | (b >> 3)) & 0x7fff;
      var hit = cache[key];
      if (hit >= 0) return hit;
      var best = nearest(palette, r, g, b);
      cache[key] = best;
      return best;
    }

    for (var y = 0; y < height; y++) {
      var reverse = (y & 1) === 1; // serpentine: alternate scan direction
      for (var step = 0; step < width; step++) {
        var x = reverse ? width - 1 - step : step;
        p = y * width + x;
        var o = p * 3;
        var r = clamp(buf[o]);
        var g = clamp(buf[o + 1]);
        var b = clamp(buf[o + 2]);
        var idx = nearestCached(r, g, b);
        indices[p] = idx;
        var er = r - palette[idx].r;
        var eg = g - palette[idx].g;
        var eb = b - palette[idx].b;
        // (dx, weight) pairs; mirrored when scanning right-to-left
        var spread = [
          [1, 7 / 16],
          [-1, 3 / 16],
          [0, 5 / 16],
          [1, 1 / 16],
        ];
        for (var s = 0; s < 4; s++) {
          var dx = reverse ? -spread[s][0] : spread[s][0];
          var w = spread[s][1];
          var nx = x + dx;
          var ny = y + (s === 0 ? 0 : 1);
          if (nx < 0 || nx >= width || ny >= height) continue;
          var no = (ny * width + nx) * 3;
          buf[no] += er * w;
          buf[no + 1] += eg * w;
          buf[no + 2] += eb * w;
        }
      }
    }
    return indices;
  }

  /**
   * Quantize an RGBA frame. Returns { palette: [r,g,b, ...], indices: Uint8Array }.
   * Only opaque pixels are considered; alpha is dropped (video frames are opaque).
   * `opts.dither` (default true) enables Floyd–Steinberg error diffusion.
   */
  function quantizeFrame(rgba, maxColors, opts) {
    opts = opts || {};
    var dither = opts.dither !== false;
    var max = maxColors || MAX_COLORS;
    var colors = gatherColors(rgba);
    var boxes = medianCut(colors, max);
    var palette = kmeansRefine(colors, boxes, 2);
    var w = opts.width, h = opts.height;
    var width = w && h ? w : 0;
    var height = w && h ? h : 0;
    var indices;
    if (dither && width > 0) {
      indices = ditherIndices(rgba, palette, width, height);
    } else {
      indices = new Uint8Array(rgba.length / 4);
      var lookup = new Map();
      var key = 0;
      for (var px = 0; px < indices.length; px++) {
        var i4 = px * 4;
        key = ((rgba[i4] << 16) | (rgba[i4 + 1] << 8) | rgba[i4 + 2]) >>> 0;
        var idx = lookup.get(key);
        if (idx === undefined) {
          idx = nearest(palette, rgba[i4], rgba[i4 + 1], rgba[i4 + 2]);
          lookup.set(key, idx);
        }
        indices[px] = idx;
      }
    }
    var flat = [];
    for (var i = 0; i < palette.length; i++) {
      flat.push(palette[i].r, palette[i].g, palette[i].b);
    }
    return { palette: flat, indices: indices };
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

  /**
   * `opts.dither` (default true) enables Floyd–Steinberg error diffusion on
   * each frame; `opts.maxColors` (default 256) caps the palette.
   */
  function GifEncoder(width, height, opts) {
    if (!(width > 0 && height > 0)) throw new Error('GifEncoder: bad dimensions');
    this.width = width;
    this.height = height;
    this.opts = opts || {};
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
    var q = quantizeFrame(data, this.opts.maxColors || MAX_COLORS, {
      dither: this.opts.dither !== false,
      width: w,
      height: h,
    });
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

  return {
    GifEncoder: GifEncoder,
    quantizeFrame: quantizeFrame,
    medianCut: medianCut,
    kmeansRefine: kmeansRefine,
    ditherIndices: ditherIndices,
  };
});
/*
 * content/yt-snip.js
 *
 * The yt-snip integration for YouTube. Injects a "snip" button into the
 * player's right chrome controls, then runs the full snipping-tool flow:
 *
 *   idle → activating → selecting → engaged → saving → idle
 *
 * All UI lives inside a single shadow-DOM host appended to `#movie_player`,
 * so YouTube's DOM is never mutated (except the injected trigger button and
 * the temporary removal of the `ytp-autohide` class while the tool is open).
 *
 * State transitions, video-restore semantics, and geometry math all live in
 * the pure lib/ modules; this file only wires them to the page.
 *
 * Loaded last by the manifest, after: lib/messaging, lib/scheduler, lib/crop,
 * lib/timeline, lib/state, lib/options, lib/filename, content/gif-encoder,
 * content/capture, content/fallback-capture. Each is read lazily so a missing
 * dependency surfaces as a clear error instead of a silent crash.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else if (typeof define === 'function' && define.amd) {
    define([], factory);
  } else {
    root.ytSnip = factory();
  }
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  var g = typeof self !== 'undefined' ? self : globalThis;
  var MIN_FRAC = 0.02; // minimum crop fraction (matches lib/crop default)
  var MIN_DRAG_IN_ELEM_PX = 8; // finish a selection only after this much drag
  var HANDLE_W = 12; // timeline handle graphic width, px
  var MIN_GAP = 0.05; // seconds between start and end handles
  var CLIP_PAD_S = 3; // default clip bounds: this many seconds each side of
                      // the activation timestamp (clamped to the video)
  var ZOOM_STRIP_H = 14; // detail strip height, px
  var ZOOM_GAP = 10; // gap between the detail strip and the minimap, px
  var MINIMAP_H = 6; // full-duration minimap height, px
  var MINIMAP_GAP = 4; // gap between the minimap and the progress bar, px
  var SEEK_MIN_INTERVAL = 120; // ms between staged seeks during handle drags

  var crop = g.ytSnipCrop;
  var timeline = g.ytSnipTimeline;
  var stateMod = g.ytSnipState;
  var optionsMod = g.ytSnipOptions;
  var filenameMod = g.ytSnipFilename;
  var messaging = g.ytSnipMessaging;
  var storageMod = g.ytSnipStorage;
  var saveflow = g.ytSnipSaveflow;
  var captureEngine = g.ytSnipCapture;
  var fallbackEngine = g.ytSnipFallback;
  var gifEngine = g.ytSnipGif;

  var appState = 'idle';
  var machine = null;
  var selection = null; // normalized {x,y,w,h} in content-box fractions
  var clip = null; // { start, end, preview } times in seconds
  var zoomWindow = null; // { start, end } seconds — detail strip's magnified range
  var looping = false;

  // In-flight interaction state. `pendingSeek` stages scrub targets so a
  // handle drag coalesces into ~one seek per SEEK_MIN_INTERVAL instead of one
  // per pointermove (which buffer-storms YouTube's DASH player).
  var pendingSeek = null;
  var lastSeekAt = 0;
  // Timestamp of the last handle-drag seek activity; loop-wrapping pauses
  // during drags and for a short grace so an edge dragged across the playhead
  // can't be snatched back mid-move.
  var lastDragAt = 0;
  var DRAG_LOOP_GRACE_MS = 250;
  // Last non-degenerate intrinsic dimensions: buffering/stream reloads can
  // transiently zero videoWidth/videoHeight and collapse the letterbox math.
  var dimCache = null; // { vw, vh }
  // Content box frozen at drag start so mid-drag quality switches can't jump
  // the selection rect under the pointer.
  var dragBox = null;

  var hostEl = null;
  var shadow = null;
  var overlayEl = null;
  var rectEl = null;
  var hintEl = null;
  var timelineEl = null;
  var zoomEl = null;
  var miniEl = null;
  var toolbarEl = null;
  var captureEl = null;
  var loopBtn = null;
  var saveBtn = null;
  var exitBtn = null;
  var cancelBtn = null;
  var progressFill = null;
  var clipLabel = null;
  var toastEl = null;

  var triggerBtn = null;
  var rafActive = false;
  var captureSignal = null;
  var lastAbortReason = null;
  // Resolved options, refreshed on each engage (gates loop-on-play).
  var cachedOpts = null;
  // Ghost-playback suppression: seeking (especially the far seeks the edge
  // scrubs produce) can make YouTube's buffering recovery RESUME playback on
  // its own. When a seek begins we remember whether the video was paused;
  // a paused-before-seek video must still be paused after it — anything
  // playing in the seek's wake is a ghost and gets re-paused. Playback that
  // was already running before the seek continues legitimately.
  var prevSeeking = false;
  var expectPausedAfterSeek = false;
  var lastSeekEndedAt = -1e9;
  var lastPlayCommandAt = -1e9;

  /** True while YouTube is showing an ad (player carries `.ad-showing`). */
  function playerHasAd() {
    var player = getPlayer();
    return !!(player && player.classList && player.classList.contains('ad-showing'));
  }

  function requireDep(name) {
    // Lazy getters so a missing script surfaces as a precise error.
    var holder = {
      crop: crop,
      timeline: timeline,
      state: stateMod,
      options: optionsMod,
      filename: filenameMod,
      messaging: messaging,
      storage: storageMod,
      saveflow: saveflow,
      capture: captureEngine,
      fallback: fallbackEngine,
      gif: gifEngine,
    };
    var v = holder[name];
    if (!v) throw new Error('yt-snip: module "' + name + '" not loaded');
    return v;
  }

  /* ---------------------------------------------------------------- *
   * DOM discovery
   * ---------------------------------------------------------------- */

  function isWatchPage() {
    return /^\/watch(\/|$|\?|#)/.test(location.pathname + location.search);
  }

  function getPlayer() {
    return document.querySelector('#movie_player');
  }

  function getVideo() {
    var player = getPlayer();
    if (!player) return null;
    return player.querySelector('video.html5-main-video') || player.querySelector('video');
  }

  function getProgressBar() {
    var player = getPlayer();
    if (!player) return null;
    return player.querySelector('.ytp-progress-bar');
  }

  /**
   * YouTube's player API, when present. Pausing the <video> element directly
   * leaves #movie_player's internal state at "playing", and it re-asserts that
   * by calling play() itself — right after activation and around every seek
   * (verified: test/smoke/debug/debug-autoplay.mjs stack capture). Going
   * through the player's own playVideo/pauseVideo keeps both state machines
   * in agreement.
   */
  function playerApi() {
    var p = getPlayer();
    return p && typeof p.playVideo === 'function' && typeof p.pauseVideo === 'function' ? p : null;
  }

  function pausePlayback() {
    var api = playerApi();
    if (api) { api.pauseVideo(); return; }
    var el = getVideo();
    if (el && el.pause) el.pause();
  }

  /* NOTE: pausing via the player API (not the bare element) is the fix for
   * "playback resumes on its own after interacting with the tool": an
   * element-level pause leaves #movie_player's internal state at "playing",
   * and it re-asserts that around the next seek. pauseVideo() from the
   * playing/paused states is a clean transition YouTube respects. (An
   * UNSTARTED player may still autoplay later per YouTube's own design; the
   * session tolerates playback — all tools work while playing.) */

  function resumePlayback() {
    lastPlayCommandAt = Date.now();
    var api = playerApi();
    if (api) { api.playVideo(); return; }
    var v = getVideo();
    if (v && v.play) v.play().catch(function () { /* autoplay policy */ });
  }

  function getRightControls() {
    var player = getPlayer();
    if (!player) return null;
    return player.querySelector('.ytp-right-controls');
  }

  /* ---------------------------------------------------------------- *
   * Trigger button injection (idempotent, re-attached on SPA nav)
   * ---------------------------------------------------------------- */

  function triggerIcon() {
    var NS = 'http://www.w3.org/2000/svg';
    function el(name, attrs) {
      var n = document.createElementNS(NS, name);
      for (var k in attrs) n.setAttribute(k, attrs[k]);
      return n;
    }
    // Explicit dimensions AND inline size: YouTube's .ytp-button cascade
    // sizes its own icons and leaves a foreign unconstrained SVG stretched
    // or cropped, which is why the first icon rendered malformed.
    var e = el('svg', {
      viewBox: '0 0 24 24',
      width: '24',
      height: '24',
      fill: 'none',
      stroke: 'currentColor',
      'stroke-width': '1.8',
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round',
    });
    e.style.width = '24px';
    e.style.height = '24px';
    e.style.display = 'block';
    // Selection-marquee corner brackets framing the glyph.
    [
      'M8 3 H5 Q3 3 3 5 V8',
      'M16 3 H19 Q21 3 21 5 V8',
      'M21 16 V19 Q21 21 19 21 H16',
      'M8 21 H5 Q3 21 3 19 V16',
    ].forEach(function (d) { e.appendChild(el('path', { d: d })); });
    // Scissors centered inside (Feather geometry scaled ×0.6 about 12,12):
    // "cut out this region".
    e.appendChild(el('circle', { cx: '9.6', cy: '9.6', r: '1.8' }));
    e.appendChild(el('circle', { cx: '9.6', cy: '14.4', r: '1.8' }));
    e.appendChild(el('path', { d: 'M16.8 7.2 L9.67 14.33' }));
    e.appendChild(el('path', { d: 'M13.49 13.49 L16.8 16.8' }));
    e.appendChild(el('path', { d: 'M9.67 9.67 L12 12' }));
    return e;
  }

  function ensureTrigger() {
    if (!isWatchPage()) return;
    // Fast path: the trigger is already attached to the live document — skip
    // the two querySelectors this otherwise runs on EVERY DOM mutation
    // (YouTube mutates constantly). `isConnected` is false iff the button was
    // orphaned by an SPA nav rebuilding the controls, so re-create only then.
    if (triggerBtn && triggerBtn.isConnected) return;
    var controls = getRightControls();
    var player = getPlayer();
    if (!controls || !player) return;
    triggerBtn = document.createElement('button');
    triggerBtn.type = 'button';
    triggerBtn.className = 'ytp-button yt-snip-trigger';
    triggerBtn.title = 'Snip a clip from this video';
    triggerBtn.setAttribute('aria-label', 'Snip a clip');
    triggerBtn.appendChild(triggerIcon());
    triggerBtn.addEventListener('click', onTriggerClick);
    // First child of .ytp-right-controls = visually LEFTMOST of the cluster:
    // every default button keeps its familiar spot and the cluster grows
    // leftward instead of the snip button displacing fullscreen.
    controls.insertBefore(triggerBtn, controls.firstChild);
  }

  function onTriggerClick(e) {
    e.stopPropagation();
    e.preventDefault();
    if (appState === 'idle') activate();
  }

  /* ---------------------------------------------------------------- *
   * Shadow DOM host + UI skeleton
   * ---------------------------------------------------------------- */

  var SHADOW_STYLES = [
    // Lifted above the real player: YouTube positions the video inside an
    // absolutely-positioned container, which paints above a plain inline/static
    // host and would eat every pointer event aimed at the overlay (caught by
    // the live Tier 3 test). The host itself stays event-transparent; each
    // interactive piece re-enables pointer events explicitly.
    ':host { all: initial; position: absolute; top: 0; left: 0; right: 0;',
    '  bottom: 0; z-index: 2147483647; pointer-events: none; }',
    '* { box-sizing: border-box; }',
    'button { font: inherit; }',
    '.snip-overlay { position: absolute; cursor: crosshair; pointer-events: auto; }',
    /* Outline, not border: outlines paint OUTSIDE the box without affecting
       layout, so the padding box (where the resize handles are positioned)
       coincides exactly with the selection edges. A border made the e/s/se…
       handles land ~2px outside the visual box and made the bottom edge jump
       on the first resize movement. */
    '.snip-rect { position: absolute; outline: 2px solid #0f9dff;',
    '  box-shadow: 0 0 0 100000px rgba(0,0,0,0.6); pointer-events: auto;',
    '  cursor: move; }',
    '.snip-handle { position: absolute; width: 10px; height: 10px;',
    '  background: #fff; border: 2px solid #0f9dff; pointer-events: auto;',
    '  transform: translate(-50%, -50%); }',
    '.snip-handle[data-dir="n"], [data-dir="s"] { cursor: ns-resize; }',
    '.snip-handle[data-dir="e"], [data-dir="w"] { cursor: ew-resize; }',
    '.snip-handle[data-dir="ne"], [data-dir="sw"] { cursor: nesw-resize; }',
    '.snip-handle[data-dir="nw"], [data-dir="se"] { cursor: nwse-resize; }',
    '.snip-hint { position: absolute; top: 50%; left: 50%;',
    '  transform: translate(-50%, -50%); background: rgba(0,0,0,0.75);',
    '  color: #fff; padding: 8px 14px; border-radius: 4px;',
    '  font: 13px/1.4 system-ui, sans-serif; pointer-events: none;',
    '  white-space: nowrap; }',
    '.snip-timeline { position: absolute; pointer-events: none; }',
    '.snip-tl-band { position: absolute; height: 100%;',
    '  background: rgba(15,157,255,0.4); pointer-events: none; }',
    /* Origin tick: where the video was when the tool was activated (the exact
       timestamp any exit restores to). Static, non-interactive, visually
       distinct from the yellow preview head and blue edge handles. */
    '.snip-origin { position: absolute; top: 12%; height: 76%; width: 2px;',
    '  background: rgba(255,255,255,0.85); border-radius: 1px;',
    '  transform: translateX(-1px); pointer-events: none; display: none; }',
    '.snip-tl-handle { position: absolute; top: 50%; transform: translate(-50%, -50%);',
    '  width: ' + HANDLE_W + 'px; height: 26px; background: #ffd400;',
    '  border: 1px solid #111; border-radius: 3px; pointer-events: auto;',
    '  cursor: ew-resize; }',
    '.snip-zoom { position: absolute; pointer-events: none; }',
    '.snip-zl-body { position: absolute; left: 0; top: 0; width: 100%; height: 100%;',
    '  background: rgba(0,0,0,0.45); border-radius: 3px; cursor: grab;',
    '  pointer-events: auto; }',
    '.snip-zoom.panning .snip-zl-body { cursor: grabbing; }',
    '.snip-zl-band { position: absolute; height: 100%;',
    '  background: rgba(15,157,255,0.25); pointer-events: none; }',
    /* Strip handles stay inside the strip so their hitboxes never overlap
       the main bar's own handles (a taller handle would steal its drags). */
    '.snip-zl-handle.snip-tl-handle { height: ' + ZOOM_STRIP_H + 'px; }',
    '.snip-zl-ctl { position: absolute; right: 4px; top: 50%;',
    '  transform: translateY(-50%); display: flex; gap: 3px; pointer-events: auto; }',
    '.snip-zl-ctl button { padding: 2px 6px; font: bold 11px/1.2 system-ui, sans-serif;',
    '  border: 0; border-radius: 3px; background: rgba(0,0,0,0.85); color: #fff;',
    '  cursor: pointer; }',
    '.snip-zl-ctl button:hover { filter: brightness(1.2); }',
    '.snip-zl-label { position: absolute; top: 50%; transform: translateY(-50%);',
    '  font: 9px/1 system-ui, sans-serif; color: rgba(255,255,255,0.8);',
    '  text-shadow: 0 0 2px #000; pointer-events: none;',
    '  font-variant-numeric: tabular-nums; }',
    '.snip-zl-label.left { left: 4px; }',
    '.snip-zl-label.right { right: 84px; }', // clear of the ＋/－/Fit cluster
    /* Full-duration minimap between the detail strip and the progress bar:
       shows where the zoom window (bracket) and clip (band) sit overall. */
    '.snip-mini { position: absolute; pointer-events: none; }',
    '.snip-mini-body { position: absolute; left: 0; top: 0; width: 100%; height: 100%;',
    '  background: rgba(0,0,0,0.45); border-radius: 2px; cursor: pointer;',
    '  pointer-events: auto; }',
    '.snip-mini-band { position: absolute; left: 0; top: 0; height: 100%;',
    '  background: rgba(15,157,255,0.35); pointer-events: none; }',
    '.snip-mini-win { position: absolute; top: 0; height: 100%;',
    '  border: 1px solid #ffd400; background: rgba(255,212,0,0.15);',
    '  pointer-events: none; }',
    '.snip-toolbar { position: absolute; top: 8px; right: 8px; display: flex;',
    '  gap: 6px; align-items: center; background: rgba(0,0,0,0.85);',
    '  padding: 6px 8px; border-radius: 6px; font: 13px/1 system-ui, sans-serif;',
    '  color: #fff; pointer-events: auto; }',
    '.snip-toolbar button { border: 0; border-radius: 4px; padding: 6px 10px;',
    '  cursor: pointer; background: #3ea6ff; color: #fff; }',
    '.snip-toolbar button:hover { filter: brightness(1.1); }',
    '.snip-toolbar button.loop-on { background: #2ba640; }',
    '.snip-toolbar button.exit { background: #555; }',
    '.snip-clip { margin-right: 6px; font-variant-numeric: tabular-nums; }',
    '.snip-capture { position: absolute; top: 50%; left: 50%;',
    '  transform: translate(-50%, -50%); width: 320px; background: rgba(0,0,0,0.92);',
    '  border-radius: 8px; padding: 16px; color: #fff; flex-direction: column;',
    '  gap: 10px; font: 13px/1.4 system-ui, sans-serif; pointer-events: auto; }',
    '.snip-capture .bar { height: 8px; border-radius: 4px; background: #333;',
    '  overflow: hidden; }',
    '.snip-capture .fill { height: 100%; width: 0; background: #0f9dff;',
    '  transition: width 0.08s linear; }',
    '.snip-capture .row { display: flex; justify-content: space-between;',
    '  align-items: center; }',
    '.snip-capture button { border: 0; border-radius: 4px; padding: 6px 12px;',
    '  cursor: pointer; background: #555; color: #fff; }',
    '.snip-toast { position: absolute; left: 50%; bottom: 56px;',
    '  transform: translateX(-50%); background: rgba(0,0,0,0.9); color: #fff;',
    '  padding: 8px 14px; border-radius: 4px; font: 13px/1.4 system-ui, sans-serif;',
    '  pointer-events: none; opacity: 0; transition: opacity 0.15s; }',
    '.snip-toast.show { opacity: 1; }',
  ].join('\n');

  /**
   * Wire a click handler that also releases focus: a focused button would
   * otherwise re-fire on Space/Enter (e.g. Loop toggling when the user only
   * meant to toggle YouTube playback).
   */
  function wireButton(btn, handler) {
    btn.addEventListener('click', function (e) {
      handler(e);
      btn.blur();
    });
  }

  function ensureHost() {
    var player = getPlayer();
    if (!player) return;
    if (hostEl && hostEl.isConnected) return;
    hostEl = document.createElement('div');
    hostEl.className = 'yt-snip-host';
    hostEl.dataset.ytSnip = 'host';
    shadow = hostEl.attachShadow({ mode: 'open' });

    var style = document.createElement('style');
    style.textContent = SHADOW_STYLES;
    shadow.appendChild(style);

    overlayEl = document.createElement('div');
    overlayEl.className = 'snip-overlay';
    overlayEl.style.display = 'none';
    overlayEl.addEventListener('pointerdown', onOverlayDown);
    overlayEl.addEventListener('pointermove', onOverlayMove);
    overlayEl.addEventListener('pointerup', onOverlayUp);
    overlayEl.addEventListener('pointercancel', onOverlayUp);

    rectEl = document.createElement('div');
    rectEl.className = 'snip-rect';
    rectEl.style.display = 'none';
    // The rect body is grabbable in engaged state: drag it to move the whole
    // selection as a unit (resize handles are children and keep priority).
    rectEl.addEventListener('pointerdown', onRectDown);
    rectEl.addEventListener('pointermove', onRectMove);
    rectEl.addEventListener('pointerup', onRectUp);
    rectEl.addEventListener('pointercancel', onRectUp);
    for (var i = 0; i < 8; i++) {
      var dirs = ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw'];
      var h = document.createElement('div');
      h.className = 'snip-handle';
      h.dataset.dir = dirs[i];
      (function (handle) {
        handle.addEventListener('pointerdown', onHandleDown);
        handle.addEventListener('pointermove', onHandleMove);
        handle.addEventListener('pointerup', onHandleUp);
        handle.addEventListener('pointercancel', onHandleUp);
      })(h);
      rectEl.appendChild(h);
    }
    overlayEl.appendChild(rectEl);

    hintEl = document.createElement('div');
    hintEl.className = 'snip-hint';
    hintEl.style.display = 'none';
    overlayEl.appendChild(hintEl);

    shadow.appendChild(overlayEl);

    timelineEl = document.createElement('div');
    timelineEl.className = 'snip-timeline';
    timelineEl.style.display = 'none';

    var band = document.createElement('div');
    band.className = 'snip-tl-band';
    timelineEl.appendChild(band);

    var otick = document.createElement('div');
    otick.className = 'snip-origin';
    timelineEl._origin = otick;
    timelineEl.appendChild(otick);

    timelineEl._band = band;
    timelineEl._handles = {};
    // Preview first so the start/end edges paint above it where they
    // coincide (e.g. both at t=0 right after engaging).
    ['preview', 'start', 'end'].forEach(function (role) {
      var th = document.createElement('div');
      th.className = 'snip-tl-handle';
      th.dataset.role = role;
      (function (role, el) {
        el.addEventListener('pointerdown', onTlDown);
        el.addEventListener('pointermove', onTlMove);
        el.addEventListener('pointerup', onTlUp);
        el.addEventListener('pointercancel', onTlUp);
      })(role, th);
      timelineEl._handles[role] = th;
      timelineEl.appendChild(th);
    });
    shadow.appendChild(timelineEl);

    // Detail strip: the zoom window magnified across its full width, with
    // its own start/preview/end handles editing the same clip.
    zoomEl = document.createElement('div');
    zoomEl.className = 'snip-zoom';
    zoomEl.style.display = 'none';

    var zbody = document.createElement('div');
    zbody.className = 'snip-zl-body';
    // The grabbable pan surface needs its own handlers — the ones below are
    // per-handle and never see body-targeted events.
    zbody.addEventListener('pointerdown', onZoomDown);
    zbody.addEventListener('pointermove', onZoomMove);
    zbody.addEventListener('pointerup', onZoomUp);
    zbody.addEventListener('pointercancel', onZoomUp);
    zoomEl._body = zbody;
    zoomEl.appendChild(zbody);

    var zband = document.createElement('div');
    zband.className = 'snip-zl-band';
    zoomEl._band = zband;
    zoomEl.appendChild(zband);

    var zorigin = document.createElement('div');
    zorigin.className = 'snip-origin';
    zoomEl._origin = zorigin;
    zoomEl.appendChild(zorigin);

    zoomEl._handles = {};
    // Same z-order rule as the main bar: edges above the preview handle.
    ['preview', 'start', 'end'].forEach(function (role) {
      var zh = document.createElement('div');
      zh.className = 'snip-tl-handle snip-zl-handle';
      zh.dataset.role = role;
      (function (role, el) {
        el.addEventListener('pointerdown', onZoomDown);
        el.addEventListener('pointermove', onZoomMove);
        el.addEventListener('pointerup', onZoomUp);
        el.addEventListener('pointercancel', onZoomUp);
      })(role, zh);
      zoomEl._handles[role] = zh;
      zoomEl.appendChild(zh);
    });

    var zctl = document.createElement('div');
    zctl.className = 'snip-zl-ctl';
    var zinBtn = document.createElement('button');
    zinBtn.textContent = '+';
    zinBtn.title = 'Zoom in around the center of the view';
    wireButton(zinBtn, function () { zoomStep(1 / timeline.ZOOM_FACTOR); });
    var zoutBtn = document.createElement('button');
    zoutBtn.textContent = '\u2212';
    zoutBtn.title = 'Zoom out around the center of the view';
    wireButton(zoutBtn, function () { zoomStep(timeline.ZOOM_FACTOR); });
    var zfitBtn = document.createElement('button');
    zfitBtn.textContent = 'Fit';
    zfitBtn.title = 'Reset the zoom window to the whole video';
    wireButton(zfitBtn, onZoomFit);
    zctl.appendChild(zinBtn);
    zctl.appendChild(zoutBtn);
    zctl.appendChild(zfitBtn);
    zoomEl.appendChild(zctl);

    // Edge timestamps: where the magnified window starts/ends in the video.
    var zLeft = document.createElement('span');
    zLeft.className = 'snip-zl-label left';
    var zRight = document.createElement('span');
    zRight.className = 'snip-zl-label right';
    zoomEl._labelStart = zLeft;
    zoomEl._labelEnd = zRight;
    zoomEl.appendChild(zLeft);
    zoomEl.appendChild(zRight);

    zoomEl.addEventListener('wheel', onZoomWheel, { passive: false });
    shadow.appendChild(zoomEl);

    // Minimap: full-duration track under the detail strip. Click/drag jumps
    // the zoom window; the bracket always answers "where am I?".
    miniEl = document.createElement('div');
    miniEl.className = 'snip-mini';
    miniEl.style.display = 'none';
    var mbody = document.createElement('div');
    mbody.className = 'snip-mini-body';
    mbody.addEventListener('pointerdown', onMiniDown);
    mbody.addEventListener('pointermove', onMiniMove);
    mbody.addEventListener('pointerup', onMiniUp);
    mbody.addEventListener('pointercancel', onMiniUp);
    miniEl._body = mbody;
    miniEl.appendChild(mbody);
    var mband = document.createElement('div');
    mband.className = 'snip-mini-band';
    miniEl._band = mband;
    miniEl.appendChild(mband);
    var mwin = document.createElement('div');
    mwin.className = 'snip-mini-win';
    miniEl._win = mwin;
    miniEl.appendChild(mwin);
    shadow.appendChild(miniEl);

    toolbarEl = document.createElement('div');
    toolbarEl.className = 'snip-toolbar';
    toolbarEl.style.display = 'none';
    clipLabel = document.createElement('span');
    clipLabel.className = 'snip-clip';
    loopBtn = document.createElement('button');
    loopBtn.textContent = 'Loop';
    wireButton(loopBtn, onLoopClick);
    saveBtn = document.createElement('button');
    saveBtn.textContent = 'Save';
    wireButton(saveBtn, onSaveClick);
    exitBtn = document.createElement('button');
    exitBtn.className = 'exit';
    exitBtn.textContent = 'Exit';
    wireButton(exitBtn, function () { exitFlip('exit'); });
    toolbarEl.appendChild(clipLabel);
    toolbarEl.appendChild(loopBtn);
    toolbarEl.appendChild(saveBtn);
    toolbarEl.appendChild(exitBtn);
    shadow.appendChild(toolbarEl);

    captureEl = document.createElement('div');
    captureEl.className = 'snip-capture';
    captureEl.style.display = 'none';
    var capRow = document.createElement('div');
    capRow.className = 'row';
    var capLabel = document.createElement('span');
    capLabel.id = 'yt-snip-cap-label';
    capLabel.textContent = 'Capturing…';
    cancelBtn = document.createElement('button');
    cancelBtn.textContent = 'Cancel';
    wireButton(cancelBtn, onCancelClick);
    capRow.appendChild(capLabel);
    capRow.appendChild(cancelBtn);
    var bar = document.createElement('div');
    bar.className = 'bar';
    progressFill = document.createElement('div');
    progressFill.className = 'fill';
    bar.appendChild(progressFill);
    captureEl.appendChild(capRow);
    captureEl.appendChild(bar);
    shadow.appendChild(captureEl);

    toastEl = document.createElement('div');
    toastEl.className = 'snip-toast';
    shadow.appendChild(toastEl);

    player.appendChild(hostEl);
  }

  /* ---------------------------------------------------------------- *
   * Geometry helpers
   * ---------------------------------------------------------------- */

  function rectOf(el) {
    if (!el) return { left: 0, top: 0, width: 0, height: 0 };
    var r = el.getBoundingClientRect();
    return { left: r.left, top: r.top, width: r.width, height: r.height };
  }

  /**
   * Intrinsic dimensions, resilient to buffering glitches: YouTube can
   * transiently report videoWidth/videoHeight 0 while reloading a stream
   * (hard seeks, quality switches). The last valid pair is cached so the
   * letterbox mapping never collapses to the degenerate `|| 1` fallback
   * mid-session (which visibly resized the selection rect).
   */
  function videoDims() {
    var video = getVideo();
    if (!video) return dimCache || { vw: 1, vh: 1 };
    var vw = video.videoWidth;
    var vh = video.videoHeight;
    if (vw > 0 && vh > 0) {
      dimCache = { vw: vw, vh: vh };
      return dimCache;
    }
    if (dimCache) return dimCache;
    return { vw: video.width || 1, vh: video.height || 1 };
  }

  function contentBoxInVideoSpace() {
    var video = getVideo();
    if (!video) return { x: 0, y: 0, w: 1, h: 1 };
    var dims = videoDims();
    // The overlay anchors to the player (#movie_player), not the <video>
    // element: YouTube re-lays the video element out depending on state
    // (e.g. while paused it carries an inline `top: -videoHeight` that moves
    // its viewport rect off-screen), while the player stage is stable. The
    // letterbox fit is computed against the stable stage geometry.
    var pr = rectOf(getPlayer());
    return crop.contentBox(dims.vw, dims.vh, pr.width || dims.vw, pr.height || dims.vh);
  }

  function overlayToVideo(ox, oy) {
    // The overlay is positioned exactly over the player stage, so
    // element-local coordinates == overlay-local coordinates: client coords
    // minus the player's viewport origin.
    var pr = rectOf(getPlayer());
    return { x: ox - pr.left, y: oy - pr.top };
  }

  /**
   * Letterboxed content box in overlay coordinates. The overlay coincides with
   * the player stage, so this is the stage-local letterbox (no offsets).
   */
  function contentBoxInOverlay() {
    return contentBoxInVideoSpace();
  }

  function selectionToRect() {
    if (!selection) return null;
    var box = contentBoxInOverlay();
    return {
      x: box.x + selection.x * box.w,
      y: box.y + selection.y * box.h,
      w: selection.w * box.w,
      h: selection.h * box.h,
    };
  }

  function positionOverlay() {
    if (!hostEl || !overlayEl) return;
    // Anchor to the player stage, not the <video> element: YouTube's layout
    // for the video element is state-dependent (off-screen while paused), but
    // the #movie_player stage is the stable, user-visible surface.
    var pr = rectOf(getPlayer());
    var hr = rectOf(hostEl);
    overlayEl.style.left = pr.left - hr.left + 'px';
    overlayEl.style.top = pr.top - hr.top + 'px';
    overlayEl.style.width = pr.width + 'px';
    overlayEl.style.height = pr.height + 'px';
  }

  function positionRect() {
    if (!selection || !rectEl) return;
    var r = selectionToRect();
    if (!r) return;
    rectEl.style.display = 'block';
    rectEl.style.left = r.x + 'px';
    rectEl.style.top = r.y + 'px';
    rectEl.style.width = r.w + 'px';
    rectEl.style.height = r.h + 'px';
    var handles = rectEl.querySelectorAll('.snip-handle');
    var positions = {
      n: [r.w / 2, 0], ne: [r.w, 0], e: [r.w, r.h / 2], se: [r.w, r.h],
      s: [r.w / 2, r.h], sw: [0, r.h], w: [0, r.h / 2], nw: [0, 0],
    };
    for (var i = 0; i < handles.length; i++) {
      var dir = handles[i].dataset.dir;
      var p = positions[dir];
      handles[i].style.left = p[0] + 'px';
      handles[i].style.top = p[1] + 'px';
    }
  }

  function positionTimeline() {
    if (!hostEl || !timelineEl) return;
    var bar = getProgressBar();
    if (!bar || appState !== 'engaged') {
      timelineEl.style.display = 'none';
      return;
    }
    var br = rectOf(bar);
    var hr = rectOf(hostEl);
    timelineEl.style.display = 'block';
    timelineEl.style.left = br.left - hr.left + 'px';
    timelineEl.style.top = br.top - hr.top + 'px';
    timelineEl.style.width = br.width + 'px';
    timelineEl.style.height = br.height + 'px';

    var duration = (getVideo() && getVideo().duration) || 0;
    if (!duration || !clip) return;
    var bar0 = { x: 0, y: 0, w: br.width, h: br.height };
    var startX = timeline.timeToX(clip.start, duration, bar0, HANDLE_W);
    var prevX = timeline.timeToX(clip.preview, duration, bar0, HANDLE_W);
    var endX = timeline.timeToX(clip.end, duration, bar0, HANDLE_W);
    timelineEl._handles.start.style.left = startX + 'px';
    timelineEl._handles.preview.style.left = prevX + 'px';
    timelineEl._handles.end.style.left = endX + 'px';
    var band = timeline.rangeBand(clip.start, clip.end, duration, bar0);
    timelineEl._band.style.left = band.x + 'px';
    timelineEl._band.style.width = band.w + 'px';
    // Origin tick: the activation timestamp any exit restores to.
    var act = machine ? machine.getActivation() : null;
    if (act && timelineEl._origin) {
      timelineEl._origin.style.display = 'block';
      timelineEl._origin.style.left =
        timeline.timeToX(act.currentTime, duration, bar0) + 'px';
    } else if (timelineEl._origin) {
      timelineEl._origin.style.display = 'none';
    }
  }

  function positionZoom() {
    if (!hostEl || !zoomEl) return;
    var bar = getProgressBar();
    if (!bar || appState !== 'engaged') {
      zoomEl.style.display = 'none';
      positionMini();
      return;
    }
    var br = rectOf(bar);
    var hr = rectOf(hostEl);
    zoomEl.style.display = 'block';
    zoomEl.style.left = br.left - hr.left + 'px';
    zoomEl.style.width = br.width + 'px';
    // Stack above the bar: [detail strip][gap][minimap][gap][progress bar].
    zoomEl.style.top = br.top - hr.top - MINIMAP_H - MINIMAP_GAP - ZOOM_GAP - ZOOM_STRIP_H + 'px';
    zoomEl.style.height = ZOOM_STRIP_H + 'px';

    var duration = (getVideo() && getVideo().duration) || 0;
    if (!duration || !clip || !zoomWindow) {
      positionMini();
      return;
    }
    var strip = { x: 0, y: 0, w: br.width, h: ZOOM_STRIP_H };
    ['start', 'preview', 'end'].forEach(function (role) {
      var x = timeline.timeToXInWindow(clip[role], zoomWindow, strip, HANDLE_W);
      zoomEl._handles[role].style.left = x + 'px';
    });
    // Clip band within the window.
    var span = zoomWindow.end - zoomWindow.start;
    var f0 = span > 0 ? (timeline.clamp(clip.start, zoomWindow.start, zoomWindow.end) - zoomWindow.start) / span : 0;
    var f1 = span > 0 ? (timeline.clamp(clip.end, zoomWindow.start, zoomWindow.end) - zoomWindow.start) / span : 0;
    zoomEl._band.style.left = f0 * strip.w + 'px';
    zoomEl._band.style.width = Math.max(0, (f1 - f0) * strip.w) + 'px';
    // Edge timestamps answer "where in the video am I?" at a glance.
    zoomEl._labelStart.textContent = formatTime(zoomWindow.start);
    zoomEl._labelEnd.textContent = formatTime(zoomWindow.end);
    // Origin tick on the strip: hidden while the activation timestamp is
    // outside the magnified window (the main bar's tick always shows it).
    var zact = machine ? machine.getActivation() : null;
    if (zact && zoomEl._origin &&
        zact.currentTime >= zoomWindow.start && zact.currentTime <= zoomWindow.end) {
      zoomEl._origin.style.display = 'block';
      zoomEl._origin.style.left =
        timeline.timeToXInWindow(zact.currentTime, zoomWindow, strip) + 'px';
    } else if (zoomEl._origin) {
      zoomEl._origin.style.display = 'none';
    }
    // The minimap mirrors this window against the full duration; keeping the
    // redraw in one place means every zoom/pan/refit path stays in sync.
    positionMini();
  }

  /**
   * Full-duration minimap under the detail strip: clip band + zoom-window
   * bracket. Click/drag on it recenters the window ("where am I?" / "go there").
   */
  function positionMini() {
    if (!hostEl || !miniEl) return;
    var bar = getProgressBar();
    if (!bar || appState !== 'engaged') {
      miniEl.style.display = 'none';
      return;
    }
    var br = rectOf(bar);
    var hr = rectOf(hostEl);
    miniEl.style.display = 'block';
    miniEl.style.left = br.left - hr.left + 'px';
    miniEl.style.width = br.width + 'px';
    miniEl.style.top = br.top - hr.top - MINIMAP_H - MINIMAP_GAP + 'px';
    miniEl.style.height = MINIMAP_H + 'px';

    var duration = (getVideo() && getVideo().duration) || 0;
    if (!duration) return;
    var w = br.width;
    if (clip) {
      miniEl._band.style.left = (clip.start / duration) * w + 'px';
      miniEl._band.style.width = ((clip.end - clip.start) / duration) * w + 'px';
    }
    if (zoomWindow) {
      miniEl._win.style.left = (zoomWindow.start / duration) * w + 'px';
      miniEl._win.style.width = ((zoomWindow.end - zoomWindow.start) / duration) * w + 'px';
    }
  }

  /* --------------------------- minimap interaction ------------------------- */

  var miniDrag = false;

  /** Recenter the zoom window around `clientX`, preserving its span. */
  function jumpWindowTo(clientX) {
    if (!zoomWindow || appState !== 'engaged') return;
    var video = getVideo();
    var duration = (video && video.duration) || 0;
    if (!duration) return;
    var mr = rectOf(miniEl);
    var frac = timeline.clamp((clientX - mr.left) / (mr.width || 1), 0, 1);
    var t = frac * duration;
    var span = zoomWindow.end - zoomWindow.start;
    var s = timeline.clamp(t - span / 2, 0, duration - span);
    zoomWindow = { start: s, end: s + span };
    positionZoom();
  }

  function onMiniDown(e) {
    if (appState !== 'engaged' || !zoomWindow) return;
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    miniDrag = true;
    jumpWindowTo(e.clientX);
  }

  function onMiniMove(e) {
    if (!miniDrag) return;
    jumpWindowTo(e.clientX);
  }

  function onMiniUp() {
    miniDrag = false;
  }

  /* ---------------------------------------------------------------- *
   * Selection dragging (pointer handlers over the video overlay)
   * ---------------------------------------------------------------- */

  var dragState = null; // { kind: 'select'|'resize', ... }

  function onOverlayDown(e) {
    if (appState === 'activating' || appState === 'selecting') {
      if (appState === 'activating') {
        machine.startSelect();
      }
      e.preventDefault();
      e.stopPropagation();
      overlayEl.setPointerCapture(e.pointerId);
      var p = overlayToVideo(e.clientX, e.clientY);
      dragState = { kind: 'select', start: p, sel: null };
      // Freeze the letterbox box for the whole drag: a mid-drag quality
      // switch must not move the rect under the pointer.
      dragBox = contentBoxInVideoSpace();
      selection = { x: 0, y: 0, w: MIN_FRAC, h: MIN_FRAC };
      hideHint();
      positionRect();
    } else if (appState === 'engaged') {
      // Clicking the dim area outside the rect in engaged does nothing.
      return;
    }
  }

  function onOverlayMove(e) {
    if (appState !== 'selecting' || !dragState || dragState.kind !== 'select') return;
    var box = dragBox || contentBoxInVideoSpace();
    var cur = overlayToVideo(e.clientX, e.clientY);
    var rect = {
      x: Math.min(dragState.start.x, cur.x),
      y: Math.min(dragState.start.y, cur.y),
      w: Math.abs(cur.x - dragState.start.x),
      h: Math.abs(cur.y - dragState.start.y),
    };
    selection = crop.normalizeRect(rect, box, MIN_FRAC);
    positionRect();
  }

  function onOverlayUp(e) {
    if (!dragState || dragState.kind !== 'select') return;
    var finished = finishPendingSelection();
    dragState = null;
    dragBox = null;
    if (finished && appState === 'selecting') {
      machine.finishSelect();
    }
  }

  function finishPendingSelection() {
    if (!selection) return false;
    var box = contentBoxInVideoSpace();
    // Require a meaningful drag in element pixels before committing.
    var px = crop.toPixelRect(selection, box.w, box.h);
    if (px.w < MIN_DRAG_IN_ELEM_PX || px.h < MIN_DRAG_IN_ELEM_PX) {
      showHint('Drag a larger region');
      return false;
    }
    return true;
  }

  /* ---------------------------------------------------------------- *
   * Resize handles on the selection rect (engaged state)
   * ---------------------------------------------------------------- */

  var DIR_EDGES = {
    n: ['n'], s: ['s'], e: ['e'], w: ['w'],
    ne: ['n', 'e'], nw: ['n', 'w'], se: ['s', 'e'], sw: ['s', 'w'],
  };

  function onHandleDown(e) {
    if (appState !== 'engaged') return;
    e.preventDefault();
    e.stopPropagation();
    var handle = e.target;
    if (!handle.dataset || !handle.dataset.dir) return;
    handle.setPointerCapture(e.pointerId);
    var p = overlayToVideo(e.clientX, e.clientY);
    // Same drag-time freeze as selection: the box must not shift mid-resize.
    dragBox = contentBoxInVideoSpace();
    dragState = {
      kind: 'resize',
      start: p,
      sel: selection ? { x: selection.x, y: selection.y, w: selection.w, h: selection.h } : null,
      dir: handle.dataset.dir,
      edges: DIR_EDGES[handle.dataset.dir] || [],
    };
  }

  function onHandleMove(e) {
    if (appState !== 'engaged' || !dragState || dragState.kind !== 'resize') return;
    var box = dragBox || contentBoxInVideoSpace();
    var cur = overlayToVideo(e.clientX, e.clientY);
    var dx = cur.x - dragState.start.x;
    var dy = cur.y - dragState.start.y;
    // Fractions are relative to the letterbox box — re-enter PLAYER space
    // with the box offset included, or the first move snaps the rect up/left
    // by exactly (box.y, box.x) whenever the stage isn't the video's aspect.
    var px = {
      x: box.x + dragState.sel.x * box.w,
      y: box.y + dragState.sel.y * box.h,
      w: dragState.sel.w * box.w,
      h: dragState.sel.h * box.h,
    };
    if (dragState.edges.indexOf('w') >= 0) { px.x += dx; px.w -= dx; }
    if (dragState.edges.indexOf('e') >= 0) { px.w += dx; }
    if (dragState.edges.indexOf('n') >= 0) { px.y += dy; px.h -= dy; }
    if (dragState.edges.indexOf('s') >= 0) { px.h += dy; }
    selection = crop.normalizeRect(px, box, MIN_FRAC);
    positionRect();
  }

  function onHandleUp(e) {
    if (dragState && dragState.kind === 'resize') {
      dragState = null;
      dragBox = null;
    }
  }

  /* ---------------------------------------------------------------- *
   * Move the whole selection rect as a unit (grab the rect body)
   * ---------------------------------------------------------------- */

  function onRectDown(e) {
    if (appState !== 'engaged' || !selection) return;
    e.preventDefault();
    e.stopPropagation();
    rectEl.setPointerCapture(e.pointerId);
    var p = overlayToVideo(e.clientX, e.clientY);
    dragBox = contentBoxInVideoSpace(); // same mid-drag freeze as resize
    dragState = {
      kind: 'move',
      start: p,
      sel: { x: selection.x, y: selection.y, w: selection.w, h: selection.h },
    };
  }

  function onRectMove(e) {
    if (appState !== 'engaged' || !dragState || dragState.kind !== 'move') return;
    var box = dragBox || contentBoxInVideoSpace();
    var cur = overlayToVideo(e.clientX, e.clientY);
    // Same box-offset rule as the resize path: fractions → player space
    // WITH the letterbox origin, then translate and clamp.
    var px = {
      x: box.x + dragState.sel.x * box.w + (cur.x - dragState.start.x),
      y: box.y + dragState.sel.y * box.h + (cur.y - dragState.start.y),
      w: dragState.sel.w * box.w,
      h: dragState.sel.h * box.h,
    };
    // Clamp the TRANSLATION, not the edges: the move must preserve the rect's
    // size and stop at the letterbox wall (edge-clamping here would shrink
    // the rect against the boundary instead).
    var nx = Math.min(Math.max(px.x, box.x), box.x + box.w - px.w);
    var ny = Math.min(Math.max(px.y, box.y), box.y + box.h - px.h);
    selection = {
      x: (nx - box.x) / box.w,
      y: (ny - box.y) / box.h,
      w: dragState.sel.w,
      h: dragState.sel.h,
    };
    positionRect();
  }

  function onRectUp(e) {
    if (dragState && dragState.kind === 'move') {
      dragState = null;
      dragBox = null;
    }
  }

  /* ---------------------------------------------------------------- *
   * Seek staging: drags coalesce into throttled seeks so scrubbing a long
   * video doesn't fire hundreds of currentTime writes (each one makes
   * YouTube's DASH player abort and refetch — the "buffer storm").
   * ---------------------------------------------------------------- */

  function stageSeek(t) {
    pendingSeek = t;
    lastDragAt = Date.now();
  }

  /** Apply the staged seek unless one is still in flight or it's too soon. */
  function applyPendingSeek() {
    if (pendingSeek === null) return;
    var video = getVideo();
    if (!video) { pendingSeek = null; return; }
    var now = Date.now();
    if (video.seeking || now - lastSeekAt < SEEK_MIN_INTERVAL) return;
    lastSeekAt = now;
    video.currentTime = pendingSeek;
    pendingSeek = null;
  }

  /** Commit the staged seek immediately (pointerup, drag end). */
  function flushSeek() {
    if (pendingSeek === null) return;
    var t = pendingSeek;
    pendingSeek = null;
    var video = getVideo();
    if (!video) return;
    lastSeekAt = Date.now();
    lastDragAt = Date.now();
    video.currentTime = t;
  }

  function dropStagedSeek() {
    pendingSeek = null;
  }

  /**
   * Cancel every in-flight drag without touching the session (blur, or any
   * future "soft interrupt"). Committed clip/selection edits are kept; only
   * the interaction state is dropped so no handler is left latched.
   */
  function cancelDrags() {
    dragState = null;
    tlDrag = null;
    miniDrag = false;
    dragBox = null;
    if (zoomDrag) {
      if (zoomEl) zoomEl.classList.remove('panning');
      zoomDrag = null;
    }
    flushSeek();
  }

  /* ---------------------------------------------------------------- *
   * Timeline handles (start / preview / end)
   * ---------------------------------------------------------------- */

  var tlDrag = null; // { role, startSel, startX }

  function onTlDown(e) {
    if (appState !== 'engaged') return;
    e.preventDefault();
    e.stopPropagation();
    var el = e.target.closest('.snip-tl-handle');
    if (!el || !el.dataset || !el.dataset.role) return;
    el.setPointerCapture(e.pointerId);
    tlDrag = { role: el.dataset.role };
    seekToRole(el.dataset.role);
  }

  function onTlMove(e) {
    if (appState !== 'engaged' || !tlDrag) return;
    var video = getVideo();
    var duration = (video && video.duration) || 0;
    var bar = getProgressBar();
    if (!duration || !bar) return;
    var br = rectOf(bar);
    var t = timeline.xToTime(e.clientX, duration, { x: br.left, y: br.top, w: br.width, h: br.height });
    var ordered = timeline.orderHandles(
      tlDrag.role === 'start' ? t : clip.start,
      clip.preview,
      tlDrag.role === 'end' ? t : clip.end
    );
    if (tlDrag.role === 'preview') {
      ordered.preview = timeline.clamp(t, ordered.start, ordered.end);
    }
    if (tlDrag.role === 'end') ordered.end = Math.max(ordered.start, Math.min(t, duration));
    if (tlDrag.role === 'start') ordered.start = Math.max(0, Math.min(t, ordered.end - MIN_GAP));
    if (ordered.end - ordered.start < MIN_GAP) {
      ordered.end = Math.min(duration, ordered.start + MIN_GAP);
    }
    // Scrub-under-cursor: an edge drag previews the frame under the dragged
    // edge (the playhead parks there on release).
    if (tlDrag.role === 'start') ordered.preview = ordered.start;
    else if (tlDrag.role === 'end') ordered.preview = ordered.end;
    clip = ordered;
    stageSeek(ordered.preview);
    updateClipLabel();
    positionTimeline();
    // Sync rule: a main-bar handle drag refits the detail window around the
    // new clip so the strip always shows the action (preview drags don't).
    if (tlDrag.role !== 'preview') refitZoomToClip();
  }

  function onTlUp(e) {
    flushSeek();
    tlDrag = null;
  }

  function seekToRole(role) {
    if (!clip) return;
    var video = getVideo();
    if (!video) return;
    dropStagedSeek(); // an immediate seek must not be overridden by a stale one
    var t = role === 'end' ? clip.end : role === 'start' ? clip.start : clip.preview;
    video.currentTime = t;
    updateClipLabel();
    positionTimeline();
  }

  /* ---------------------------------------------------------------- *
   * Detail strip (zoomed window): pan / zoom / window-aware handles
   * ---------------------------------------------------------------- */

  var zoomDrag = null; // { kind: 'handle'|'pan', ... }

  /** Fit the zoom window around the current clip (span padded ~20%/side). */
  function refitZoomToClip() {
    var video = getVideo();
    var d = (video && video.duration) || 0;
    if (!d || !clip) return;
    var span = Math.min(d, Math.max((clip.end - clip.start) * 1.4, timeline.MIN_WINDOW_SPAN));
    var center = (clip.start + clip.end) / 2;
    var s = timeline.clamp(center - span / 2, 0, d - span);
    zoomWindow = { start: s, end: s + span };
  }

  function onZoomDown(e) {
    if (appState !== 'engaged') return;
    e.preventDefault();
    e.stopPropagation();
    var el = e.target.closest('.snip-tl-handle');
    if (el && el.dataset && el.dataset.role && zoomEl.contains(el)) {
      el.setPointerCapture(e.pointerId);
      zoomDrag = { kind: 'handle', role: el.dataset.role };
      seekToRole(el.dataset.role);
      positionZoom();
      return;
    }
    if (e.target === zoomEl._body && zoomWindow) {
      zoomEl._body.setPointerCapture(e.pointerId);
      zoomDrag = {
        kind: 'pan',
        startX: e.clientX,
        win: { start: zoomWindow.start, end: zoomWindow.end },
        w: rectOf(zoomEl).width,
      };
      zoomEl.classList.add('panning');
    }
  }

  function onZoomMove(e) {
    if (appState !== 'engaged' || !zoomDrag || !zoomWindow) return;
    var video = getVideo();
    var duration = (video && video.duration) || 0;
    if (!duration || !clip) return;

    if (zoomDrag.kind === 'pan') {
      var w = zoomDrag.w || rectOf(zoomEl).width || 1;
      zoomWindow = timeline.panWindow(zoomDrag.win, (e.clientX - zoomDrag.startX) / w, duration);
      positionZoom();
      return;
    }

    var zr = rectOf(zoomEl);
    var t = timeline.xToTimeInWindow(e.clientX, zoomWindow, { x: zr.left, y: zr.top, w: zr.width, h: zr.height });
    var ordered = timeline.orderHandles(
      zoomDrag.role === 'start' ? t : clip.start,
      clip.preview,
      zoomDrag.role === 'end' ? t : clip.end
    );
    if (zoomDrag.role === 'preview') {
      ordered.preview = timeline.clamp(t, ordered.start, ordered.end);
    }
    if (zoomDrag.role === 'end') ordered.end = Math.max(ordered.start, Math.min(t, duration));
    if (zoomDrag.role === 'start') ordered.start = Math.max(0, Math.min(t, ordered.end - MIN_GAP));
    if (ordered.end - ordered.start < MIN_GAP) {
      ordered.end = Math.min(duration, ordered.start + MIN_GAP);
    }
    // Same scrub-under-cursor rule as the main bar.
    if (zoomDrag.role === 'start') ordered.preview = ordered.start;
    else if (zoomDrag.role === 'end') ordered.preview = ordered.end;
    clip = ordered;
    stageSeek(ordered.preview);
    updateClipLabel();
    positionTimeline();
    positionZoom();
  }

  function onZoomUp() {
    if (zoomDrag && zoomDrag.kind === 'pan') zoomEl.classList.remove('panning');
    flushSeek();
    zoomDrag = null;
  }

  function onZoomWheel(e) {
    if (appState !== 'engaged' || !zoomWindow) return;
    e.preventDefault();
    var duration = (getVideo() && getVideo().duration) || 0;
    if (!duration) return;
    var zr = rectOf(zoomEl);
    var anchor = timeline.xToTimeInWindow(e.clientX, zoomWindow, { x: zr.left, y: zr.top, w: zr.width, h: zr.height });
    var factor = e.deltaY > 0 ? timeline.ZOOM_FACTOR : 1 / timeline.ZOOM_FACTOR;
    zoomWindow = timeline.zoomWindow(zoomWindow, factor, anchor, duration, timeline.MIN_WINDOW_SPAN);
    positionZoom();
  }

  function zoomStep(factor) {
    if (appState !== 'engaged' || !zoomWindow) return;
    var video = getVideo();
    var d = (video && video.duration) || 0;
    if (!d) return;
    // Anchor at the window CENTER, not the preview handle: zooming must not
    // slide the view sideways (the old preview anchor made users lose their
    // place).
    var center = (zoomWindow.start + zoomWindow.end) / 2;
    zoomWindow = timeline.zoomWindow(zoomWindow, factor, center, d, timeline.MIN_WINDOW_SPAN);
    positionZoom();
  }

  function onZoomFit() {
    if (appState !== 'engaged') return;
    var video = getVideo();
    var d = (video && video.duration) || 0;
    if (!d) return;
    zoomWindow = { start: 0, end: d };
    positionZoom();
  }

  /* ---------------------------------------------------------------- *
   * Toolbar actions
   * ---------------------------------------------------------------- */

  function setLooping(on) {
    looping = on;
    if (loopBtn) {
      loopBtn.classList.toggle('loop-on', looping);
      loopBtn.textContent = looping ? 'Loop: on' : 'Loop';
    }
  }

  function onLoopClick() {
    if (appState !== 'engaged' || !clip) return;
    setLooping(!looping);
    if (looping) {
      var video = getVideo();
      if (video) {
        if (video.currentTime < clip.start || video.currentTime > clip.end) {
          video.currentTime = clip.start;
        }
        lastPlayCommandAt = Date.now();
        video.play().catch(function () { /* autoplay policy */ });
      }
    }
  }

  function tickLoop() {
    if (!looping || appState !== 'engaged' || !clip) return;
    var video = getVideo();
    if (!video) return;
    var atEnd = video.currentTime >= clip.end - 0.02;
    // Manual pause stops the loop — full stop. Only a video that genuinely
    // reached media end (ended latches paused=true in Firefox) may wrap and
    // resume; "paused while parked at the clip edge" (edge-scrub parking)
    // must NOT: that fired a wrap+play DRAG_LOOP_GRACE_MS after every
    // end-handle release whenever looping was armed.
    if (video.paused && !video.ended) return;
    // A pending wrap-seek hasn't landed yet — rewriting currentTime now would
    // stack seeks on a buffering player.
    if (video.seeking) return;
    // Never snatch the playhead while (or just after) the user is dragging a
    // handle — the drag owns the position.
    if (Date.now() - lastDragAt < DRAG_LOOP_GRACE_MS) return;
    if (atEnd) {
      video.currentTime = clip.start;
      // An ended video stays stopped unless playback is resumed explicitly.
      if (video.paused || video.ended) {
        lastPlayCommandAt = Date.now();
        video.play().catch(function () { /* autoplay policy */ });
      }
    }
  }

  /**
   * Live playhead: the preview head tracks actual playback on both bars.
   * Skipped while the user is dragging the preview handle (the drag owns the
   * position); clamped so an un-looped play past the end parks at clip.end
   * instead of dragging the head outside the selection.
   */
  function trackPlayhead() {
    if (appState !== 'engaged' || !clip) return;
    // Any active handle drag owns the playhead (preview drags drive it
    // directly; W3 edge drags scrub to the dragged edge).
    if (tlDrag || zoomDrag) return;
    var video = getVideo();
    if (!video) return;
    var t = timeline.clamp(video.currentTime, clip.start, clip.end);
    if (t !== clip.preview) clip.preview = t;
  }

  function onSaveClick() {
    if (appState !== 'engaged' || !clip || !selection) return;
    saveClip();
  }

  function onCancelClick() {
    if (appState !== 'saving') return;
    abortCapture('cancel');
  }

  function exitFlip(reason) {
    if (!machine || appState === 'idle') return;
    if (appState === 'saving') abortCapture(reason);
    machine.disengage(reason);
  }

  /* ---------------------------------------------------------------- *
   * Capture + save
   * ---------------------------------------------------------------- */

  function loadOptions() {
    var def = requireDep('options').resolve(null);
    return requireDep('storage')
      .get(null)
      .then(function (items) {
        return requireDep('options').resolve(items || {});
      })
      .catch(function () {
        // storage unavailable (e.g. the harness without a stub) → defaults
        return def;
      });
  }

  function makeSignal() {
    var subs = [];
    return {
      aborted: false,
      subscribe: function (cb) { subs.push(cb); },
      abort: function () {
        this.aborted = true;
        for (var i = 0; i < subs.length; i++) subs[i]();
      },
    };
  }

  function saveClip() {
    if (!machine || !machine.can('save')) return;
    // A1: refuse to capture while an ad owns the player (plan deviation fix).
    if (playerHasAd()) {
      toast('Ads can\'t be captured');
      return;
    }
    lastAbortReason = null;
    machine.save();
    showCaptureUI();
    captureSignal = makeSignal();

    loadOptions().then(function (opts) {
      var video = getVideo();
      // Cached dims: a capture launched right after a seek storm must not
      // crop against degenerate intrinsics.
      var dims = videoDims();
      var vw = dims.vw;
      var vh = dims.vh;
      var cropPx = requireDep('crop').toPixelRect(selection, vw, vh);
      var out = requireDep('crop').outputSize(selection, vw, vh, opts.maxDimension);
      var encoder = new (requireDep('gif').GifEncoder)(out.w, out.h);

      var params = requireDep('saveflow').clipParams(clip, video.duration, opts, cropPx, out);
      var hooks = {
        onProgress: function (f) { updateCaptureProgress(Math.round((f || 0) * 100)); },
        render: function (index, mediaTime, canvas, ctx) {
          var img = ctx.getImageData(0, 0, out.w, out.h);
          encoder.addFrame({ data: img.data, width: out.w, height: out.h }, { delayMs: 1000 / params.fps });
        },
      };

      if (video.muted === false) { /* keep audio for preview only; not captured */ }

      var attempt = requireDep('capture').captureFromVideo(video, params, hooks, captureSignal)
        .catch(function (err) {
          if (err && err.code === 'taint') {
            updateCaptureLabel('Retrying (CORS mode)…');
            return requireDep('fallback').captureFromLiveVideo(video, params, hooks, captureSignal);
          }
          throw err;
        })
        .then(function () {
          if (captureSignal.aborted) throw { code: 'aborted' };
          if (encoder.frames.length === 0) throw { code: 'no-frames' };
          return { encoder: encoder, opts: opts };
        });

      return attempt.then(function (res) {
        var bytes = res.encoder.end();
        // Send the bytes as a plain array, not an ArrayBuffer: Chromium's
        // runtime message serialization mangles ArrayBuffers into plain
        // objects (the structured clone is not preserved across the
        // content-script→service-worker boundary), while an array of byte
        // values survives both engines' serialization. The background
        // rebuilds a Uint8Array from it.
        var byteArray = Array.from(bytes);
        var title = (document.title || '').replace(/ - YouTube$/, '').trim();
        var filename = requireDep('filename').makeFilename(title || 'clip', null, 'gif');
        return requireDep('messaging').request(
          'yt-snip:save',
          { data: byteArray, filename: filename, saveAs: !!res.opts.saveAs }
        ).then(
          function (r) { return requireDep('saveflow').mapSaveResult(r, filename); },
          function (err) { return requireDep('saveflow').mapSaveError(err, filename); }
        );
      });
    }).then(function (r) {
      hideCaptureUI();
      if (r.ok) {
        toast('Saved: ' + r.filename.split('/').pop());
      } else {
        toast(requireDep('saveflow').toastTextForError(r.error));
      }
      // Test seam (no-op unless the page opts in): record the restore that the
      // state machine applied in the same tick it applies it. External polling
      // can't observe this on fast/racing media clocks.
      var tgt = machine ? machine.getActivation() : null;
      if (machine && machine.can('complete')) machine.complete();
      if (g.__ytSnipTrace) {
        var tv = getVideo();
        g.__ytSnipLastRestore = {
          target: tgt ? tgt.currentTime : null,
          t: tv ? tv.currentTime : null,
          paused: tv ? tv.paused : null,
          last: machine ? machine.lastReason() : null,
        };
      }
      if (machine && machine.getState() !== 'idle') machine.disengage(r.ok ? 'save-complete' : 'save-error');
    }).catch(function (err) {
      hideCaptureUI();
      var code = err && err.code;
      if (code === 'aborted' || code === 'cancel' || code === 'taint' ||
          code === 'no-frames' || code === 'no-video') {
        if (code === 'taint') {
          toast('Could not capture: video is protected (CORS taint)');
        } else if (code === 'no-frames') {
          toast('No frames captured — clip too short?');
        } else if (code === 'no-video') {
          toast('Could not capture: the video was interrupted');
        } else if (lastAbortReason === 'ad') {
          toast('Ads can\'t be captured');
        } else {
          toast('Capture cancelled');
        }
      } else {
        toast('Capture failed: ' + (err && err.message ? err.message : String(err)));
      }
      if (machine) {
        if (machine.can('disengage')) machine.disengage('error');
        else if (machine.can('complete')) machine.complete();
      }
    });
  }

  function abortCapture(reason) {
    lastAbortReason = reason;
    if (captureSignal) captureSignal.abort();
    hideCaptureUI();
    if (machine && machine.can('disengage')) machine.disengage(reason);
  }

  function showCaptureUI() {
    if (!captureEl) return;
    captureEl.style.display = 'flex';
    updateCaptureLabel('Capturing…');
    updateCaptureProgress(0);
  }

  function hideCaptureUI() {
    if (captureEl) captureEl.style.display = 'none';
  }

  function updateCaptureLabel(text) {
    var el = captureEl && captureEl.querySelector('#yt-snip-cap-label');
    if (el) el.textContent = text;
  }

  function updateCaptureProgress(pct) {
    if (progressFill) progressFill.style.width = pct + '%';
  }

  function showHint(text) {
    if (hintEl) {
      hintEl.textContent = text;
      hintEl.style.display = 'block';
    }
  }

  function hideHint() {
    if (hintEl) hintEl.style.display = 'none';
  }

  var toastTimer = null;
  function toast(text) {
    if (!toastEl) return;
    toastEl.textContent = text;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      toastEl.classList.remove('show');
    }, 2200);
  }

  function formatTime(t) {
    if (!isFinite(t)) return '0:00';
    var m = Math.floor(t / 60);
    var s = Math.floor(t % 60);
    return m + ':' + (s < 10 ? '0' : '') + s;
  }

  function updateClipLabel() {
    if (clipLabel && clip) {
      clipLabel.textContent = formatTime(clip.start) + ' – ' + formatTime(clip.end);
    }
  }

  /* ---------------------------------------------------------------- *
   * State machine wiring
   * ---------------------------------------------------------------- */

  function onStateChange(s) {
    appState = s;
    if (overlayEl) overlayEl.style.display =
      (s === 'activating' || s === 'selecting' || s === 'engaged') ? 'block' : 'none';
    if (timelineEl) {
      timelineEl.style.display = s === 'engaged' ? 'block' : 'none';
      positionTimeline();
      positionZoom();
    }
    if (toolbarEl) toolbarEl.style.display = s === 'engaged' ? 'flex' : 'none';
    if (captureEl) captureEl.style.display = s === 'saving' ? 'flex' : 'none';

    if (s === 'activating') {
      showHint('Drag across the video to select a region');
    } else if (s === 'engaged') {
      hideHint();
      var video = getVideo();
      var d = (video && video.duration) || 0;
      // Default selection: a window around where the user actually is, not
      // the whole video. The activation timestamp (the restore target) sits
      // inside it by construction. Padding is user-configurable per side
      // (options: clipPadStart/clipPadEnd, default 3 s each).
      var act = machine ? machine.getActivation() : null;
      var t0 = act ? act.currentTime : ((video && video.currentTime) || 0);
      var padStart = (cachedOpts && isFinite(cachedOpts.clipPadStart)) ? cachedOpts.clipPadStart : CLIP_PAD_S;
      var padEnd = (cachedOpts && isFinite(cachedOpts.clipPadEnd)) ? cachedOpts.clipPadEnd : CLIP_PAD_S;
      var cs = Math.max(0, t0 - padStart);
      var ce = Math.min(d, t0 + padEnd);
      if (!(ce - cs >= 1)) { cs = 0; ce = d; } // degenerate guard
      clip = {
        start: cs,
        end: ce,
        preview: timeline.clamp(t0, cs, ce),
      };
      zoomWindow = { start: 0, end: d };
      // Orient the detail strip around the default selection instead of the
      // whole duration — the fine-trim surface should start useful.
      refitZoomToClip();
      setLooping(false);
      updateClipLabel();
      positionRect();
      // The display block above ran before `clip` existed, so the timeline
      // and strip handles are still at their unpositioned origin — place
      // them now (the rAF loop takes over from the next frame).
      positionTimeline();
      positionZoom();
    } else if (s === 'idle') {
      selection = null;
      clip = null;
      zoomWindow = null;
      setLooping(false);
      dropStagedSeek();
      dragBox = null;
      miniDrag = false;
      hideHint();
      if (rectEl) rectEl.style.display = 'none';
      if (loopBtn) { loopBtn.classList.remove('loop-on'); loopBtn.textContent = 'Loop'; }
      hideCaptureUI();
    }

    if (s !== 'idle') startFrameLoop();
    else stopFrameLoop();
  }

  function activate() {
    if (appState !== 'idle') return;
    var video = getVideo();
    if (!video || !video.duration || !video.videoWidth) {
      toast('Video not ready yet');
      return;
    }
    // Refresh options for this session (loop-on-play gating reads the cache).
    cachedOpts = null;
    loadOptions().then(function (o) { cachedOpts = o; }).catch(function () {});
    // The machine's restore must go through the player API too, or YouTube
    // fights the element-level play/pause (see playerApi()).
    machine = requireDep('state').create({
      get currentTime() { return video.currentTime; },
      set currentTime(t) { video.currentTime = t; },
      get paused() { return video.paused; },
      pause: function () { pausePlayback(); },
      play: function () { resumePlayback(); },
    }, { onChange: onStateChange });
    showHint('Drag across the video to select a region');
    machine.request('button');
    pausePlayback();
  }

  /* ---------------------------------------------------------------- *
   * Frame loop driving live geometry + loop playback
   * ---------------------------------------------------------------- */

  function frame() {
    if (appState === 'idle' || !hostEl) { rafActive = false; return; }
    // A1: an ad started mid-capture — abort fast and restore (frame-loop guard).
    if (appState === 'saving' && playerHasAd()) {
      abortCapture('ad');
      toast('Ads can\'t be captured');
      return;
    }
    // Ghost-playback suppression (see the vars above): a paused-before-seek
    // video that starts playing in the seek's wake is YouTube's buffering
    // recovery, not the user — re-pause it.
    var gv = getVideo();
    if (appState === 'engaged' && gv) {
      var seekingNow = !!gv.seeking;
      if (!prevSeeking && seekingNow) {
        expectPausedAfterSeek = gv.paused;
      } else if (prevSeeking && !seekingNow) {
        lastSeekEndedAt = Date.now();
      }
      prevSeeking = seekingNow;
      if (!looping && !gv.paused && !seekingNow &&
          expectPausedAfterSeek &&
          Date.now() - lastSeekEndedAt < 1500 &&
          Date.now() - lastPlayCommandAt > 700) {
        pausePlayback();
      }
    }
    positionOverlay();
    if (selection) positionRect();
    applyPendingSeek();
    trackPlayhead();
    positionTimeline();
    positionZoom();
    suppressAutohide();
    tickLoop();
    requestAnimationFrame(frame);
  }

  function startFrameLoop() {
    if (rafActive) return;
    rafActive = true;
    requestAnimationFrame(frame);
  }

  function stopFrameLoop() {
    rafActive = false;
  }

  function suppressAutohide() {
    if (appState === 'idle') return;
    var player = getPlayer();
    if (player && player.classList && player.classList.contains('ytp-autohide')) {
      player.classList.remove('ytp-autohide');
    }
  }

  /* ---------------------------------------------------------------- *
   * Init: idempotent, re-attaches on SPA navigation
   * ---------------------------------------------------------------- */

  var lastUrl = '';
  var urlTimer = null;

  function onNavigate() {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      if (!isWatchPage()) {
        if (appState !== 'idle' && machine) machine.disengage('nav');
        teardownHost();
        return;
      }
      if (appState !== 'idle' && machine) machine.disengage('nav');
      ensureTrigger();
      ensureHost();
      return;
    }
    // Initial pass (init calls onNavigate() directly): make sure the trigger
    // and host exist on a fresh watch page without waiting for a mutation.
    if (isWatchPage()) {
      ensureTrigger();
      ensureHost();
    }
  }

  function teardownHost() {
    if (hostEl && hostEl.parentNode) hostEl.parentNode.removeChild(hostEl);
    hostEl = null;
    shadow = null;
  }

  function init() {
    // Always register SPA-navigation / polling / observer hooks so a later
    // navigate onto /watch is picked up even if we loaded on another page.
    lastUrl = location.href;

    // YouTube SPA emits this after each navigate.
    window.addEventListener('yt-navigate-finish', onNavigate);
    document.addEventListener('yt-navigate-finish', onNavigate);
    // Poll as a fallback (navigate-finish is not documented/stable).
    urlTimer = setInterval(onNavigate, 500);

    // Escape exits the tool from any state.
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && appState !== 'idle') {
        e.preventDefault();
        e.stopPropagation();
        exitFlip('esc');
      }
    }, true);

    // Losing window focus must NOT end the session: alt-tab, DevTools, or a
    // second monitor would otherwise wipe all clip progress. Pointer capture
    // dies with focus anyway, so just cancel in-flight drags to avoid stuck
    // states; the session stays armed until Esc / Exit / save / navigation.
    window.addEventListener('blur', function () {
      cancelDrags();
    });

    // Auto-loop: starting playback by ANY means while engaged (YouTube's play
    // button, spacebar, k) previews the selection on repeat. 'play' doesn't
    // bubble, so listen in the capture phase at the document level. Gated by
    // the loopOnPlay option (default on). A ghost play (buffering recovery
    // after a seek — see the frame-loop guard) does NOT arm looping.
    document.addEventListener('play', function (e) {
      if (appState !== 'engaged' || !clip) return;
      if (cachedOpts && !cachedOpts.loopOnPlay) return;
      var video = getVideo();
      if (!video || e.target !== video) return;
      if (expectPausedAfterSeek &&
          Date.now() - lastSeekEndedAt < 1500 &&
          Date.now() - lastPlayCommandAt > 700) {
        return;
      }
      setLooping(true);
    }, true);

    // A MutationObserver keeps the trigger button present across SPA nav and
    // while YouTube re-renders the chrome controls.
    var observer = new MutationObserver(function () { ensureTrigger(); });
    observer.observe(document.body ? document.body : document.documentElement, { childList: true, subtree: true });

    onNavigate();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  /* Exposed seam for tests / introspection. */
  return {
    _getState: function () { return appState; },
    _getSelection: function () { return selection; },
    _getClip: function () { return clip; },
    _getZoom: function () { return zoomWindow; },
    _isLooping: function () { return looping; },
    isWatchPage: isWatchPage,
    _init: init,
  };
});
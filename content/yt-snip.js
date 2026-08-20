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
  var looping = false;

  var hostEl = null;
  var shadow = null;
  var overlayEl = null;
  var rectEl = null;
  var hintEl = null;
  var timelineEl = null;
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

  function getRightControls() {
    var player = getPlayer();
    if (!player) return null;
    return player.querySelector('.ytp-right-controls');
  }

  /* ---------------------------------------------------------------- *
   * Trigger button injection (idempotent, re-attached on SPA nav)
   * ---------------------------------------------------------------- */

  function triggerIcon() {
    var e = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    e.setAttribute('viewBox', '0 0 24 24');
    e.setAttribute('fill', 'none');
    e.setAttribute('stroke', 'currentColor');
    e.setAttribute('stroke-width', '1.8');
    e.setAttribute('stroke-linecap', 'round');
    e.setAttribute('stroke-linejoin', 'round');
    var path1 = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path1.setAttribute('d', 'M6 4 L6 14');
    var path2 = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path2.setAttribute('d', 'M6 20 L6 14 M6 14 L4 16');
    var circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    circle.setAttribute('cx', '6');
    circle.setAttribute('cy', '4');
    circle.setAttribute('r', '2');
    var path3 = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path3.setAttribute('d', 'M11 14 L20 5 M11 14 L14 20 L20 14 Z');
    e.appendChild(path1);
    e.appendChild(path2);
    e.appendChild(circle);
    e.appendChild(path3);
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
    controls.appendChild(triggerBtn);
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
    '.snip-rect { position: absolute; border: 2px solid #0f9dff;',
    '  box-shadow: 0 0 0 100000px rgba(0,0,0,0.6); pointer-events: none; }',
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
    '.snip-tl-handle { position: absolute; top: 50%; transform: translate(-50%, -50%);',
    '  width: ' + HANDLE_W + 'px; height: 26px; background: #ffd400;',
    '  border: 1px solid #111; border-radius: 3px; pointer-events: auto;',
    '  cursor: ew-resize; }',
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

    timelineEl._band = band;
    timelineEl._handles = {};
    ['start', 'preview', 'end'].forEach(function (role) {
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

    toolbarEl = document.createElement('div');
    toolbarEl.className = 'snip-toolbar';
    toolbarEl.style.display = 'none';
    clipLabel = document.createElement('span');
    clipLabel.className = 'snip-clip';
    loopBtn = document.createElement('button');
    loopBtn.textContent = 'Loop';
    loopBtn.addEventListener('click', onLoopClick);
    saveBtn = document.createElement('button');
    saveBtn.textContent = 'Save';
    saveBtn.addEventListener('click', onSaveClick);
    exitBtn = document.createElement('button');
    exitBtn.className = 'exit';
    exitBtn.textContent = 'Exit';
    exitBtn.addEventListener('click', function () { exitFlip('exit'); });
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
    cancelBtn.addEventListener('click', onCancelClick);
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

  function contentBoxInVideoSpace() {
    var video = getVideo();
    if (!video) return { x: 0, y: 0, w: 1, h: 1 };
    var vw = video.videoWidth || video.width || 1;
    var vh = video.videoHeight || video.height || 1;
    // The overlay anchors to the player (#movie_player), not the <video>
    // element: YouTube re-lays the video element out depending on state
    // (e.g. while paused it carries an inline `top: -videoHeight` that moves
    // its viewport rect off-screen), while the player stage is stable. The
    // letterbox fit is computed against the stable stage geometry.
    var pr = rectOf(getPlayer());
    return crop.contentBox(vw, vh, pr.width || vw, pr.height || vh);
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
    var box = contentBoxInVideoSpace();
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
    var box = contentBoxInVideoSpace();
    var cur = overlayToVideo(e.clientX, e.clientY);
    var dx = cur.x - dragState.start.x;
    var dy = cur.y - dragState.start.y;
    var px = {
      x: dragState.sel.x * box.w,
      y: dragState.sel.y * box.h,
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
    if (dragState && dragState.kind === 'resize') dragState = null;
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
    clip = ordered;
    video.currentTime = ordered.preview;
    updateClipLabel();
    positionTimeline();
  }

  function onTlUp(e) {
    tlDrag = null;
  }

  function seekToRole(role) {
    if (!clip) return;
    var video = getVideo();
    if (!video) return;
    var t = role === 'end' ? clip.end : role === 'start' ? clip.start : clip.preview;
    video.currentTime = t;
    updateClipLabel();
    positionTimeline();
  }

  /* ---------------------------------------------------------------- *
   * Toolbar actions
   * ---------------------------------------------------------------- */

  function onLoopClick() {
    if (appState !== 'engaged' || !clip) return;
    looping = !looping;
    loopBtn.classList.toggle('loop-on', looping);
    loopBtn.textContent = looping ? 'Loop: on' : 'Loop';
    if (looping) {
      var video = getVideo();
      if (video) {
        if (video.currentTime < clip.start || video.currentTime > clip.end) {
          video.currentTime = clip.start;
        }
        video.play().catch(function () { /* autoplay policy */ });
      }
    }
  }

  function tickLoop() {
    if (!looping || appState !== 'engaged' || !clip) return;
    var video = getVideo();
    if (!video || video.paused) return;
    if (video.currentTime >= clip.end - 0.02) {
      video.currentTime = clip.start;
    }
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
      var vw = video.videoWidth || video.width || 1;
      var vh = video.videoHeight || video.height || 1;
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
    }
    if (toolbarEl) toolbarEl.style.display = s === 'engaged' ? 'flex' : 'none';
    if (captureEl) captureEl.style.display = s === 'saving' ? 'flex' : 'none';

    if (s === 'activating') {
      showHint('Drag across the video to select a region');
    } else if (s === 'engaged') {
      hideHint();
      var video = getVideo();
      var d = (video && video.duration) || 0;
      clip = {
        start: 0,
        end: d,
        preview: timeline.clamp((video && video.currentTime) || 0, 0, d),
      };
      looping = false;
      loopBtn.classList.remove('loop-on');
      loopBtn.textContent = 'Loop';
      updateClipLabel();
      positionRect();
    } else if (s === 'idle') {
      selection = null;
      clip = null;
      looping = false;
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
    machine = requireDep('state').create(video, { onChange: onStateChange });
    showHint('Drag across the video to select a region');
    machine.request('button');
    if (video.pause) video.pause();
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
    positionOverlay();
    if (selection) positionRect();
    positionTimeline();
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

    // Losing window focus disengages and restores.
    window.addEventListener('blur', function () {
      if (appState !== 'idle' && machine) machine.disengage('blur');
    });

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
    _isLooping: function () { return looping; },
    isWatchPage: isWatchPage,
    _init: init,
  };
});
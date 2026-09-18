/*
 * lib/state.js
 *
 * Pure state machine for the snipping flow:
 *
 *   idle → activating → selecting → engaged → saving → idle
 *                  ↘          ↘            ↘      ↘
 *                  (any disengage reason → idle, restoring the video)
 *
 * On `request` (button or shortcut) the machine snapshots the video's
 * currentTime + play/pause state. Every exit back to `idle` restores the
 * activation timestamp and ends PAUSED, regardless of the play state at
 * activation (product rule amended M13: closing the tool by any path —
 * save, Esc, nav, abort — leaves the video paused where you started).
 *
 * The `video` is a duck-typed adapter ({ currentTime, paused, pause(), play() })
 * so the machine runs identically in Node unit tests and against the real
 * HTMLVideoElement.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else if (typeof define === 'function' && define.amd) {
    define([], factory);
  } else {
    root.ytSnipState = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var STATES = Object.freeze(['idle', 'activating', 'selecting', 'engaged', 'saving']);

  // state → allowed event → next state
  var TRANSITIONS = Object.freeze({
    idle: { request: 'activating' },
    activating: { startSelect: 'selecting', disengage: 'idle' },
    selecting: { finishSelect: 'engaged', disengage: 'idle' },
    engaged: { save: 'saving', disengage: 'idle' },
    saving: { complete: 'idle', disengage: 'idle' },
  });

  /**
   * Create a state machine bound to `video`.
   * `opts.onChange(state, machine)` is notified after every transition.
   */
  function create(video, opts) {
    if (!video) throw new Error('state machine requires a video adapter');
    opts = opts || {};
    var state = 'idle';
    var activation = null;
    var lastReason = null;

    function applyRestore() {
      if (!activation) return;
      video.currentTime = activation.currentTime;
      // Any exit ends paused (M13 rule): the tool is a preview/trim surface —
      // closing it by any path should never leave the video running.
      video.pause();
      // M17: undo any preview playback-speed change from the session (the
      // speed control mutates video.playbackRate for live preview).
      if (activation.playbackRate !== undefined && 'playbackRate' in video) {
        video.playbackRate = activation.playbackRate;
      }
    }

    function transition(event, reason) {
      var next = TRANSITIONS[state] && TRANSITIONS[state][event];
      if (!next) return false;

      if (state === 'idle' && event === 'request') {
        activation = {
          currentTime: video.currentTime,
          paused: video.paused,
          // M17: snapshot the playback rate so speed previews are undone on
          // any exit (adapters without a playbackRate snapshot as undefined).
          playbackRate: 'playbackRate' in video ? video.playbackRate : undefined,
        };
      }

      state = next;
      lastReason = event === 'disengage' || event === 'complete' ? reason || event : null;

      if (next === 'idle' && activation) {
        applyRestore();
        activation = null;
      }

      if (opts.onChange) opts.onChange(state, machine);
      return true;
    }

    var machine = {
      getState: function () { return state; },
      getActivation: function () { return activation; },
      lastReason: function () { return lastReason; },
      request: function (reason) { return transition('request', reason); },
      startSelect: function () { return transition('startSelect'); },
      finishSelect: function () { return transition('finishSelect'); },
      save: function () { return transition('save'); },
      complete: function () { return transition('complete', 'save-complete'); },
      disengage: function (reason) { return transition('disengage', reason); },
      can: function (event) { return !!(TRANSITIONS[state] && TRANSITIONS[state][event]); },
    };

    return machine;
  }

  return {
    STATES: STATES,
    TRANSITIONS: TRANSITIONS,
    create: create,
  };
});
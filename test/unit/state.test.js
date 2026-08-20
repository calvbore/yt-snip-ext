'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const state = require('../../lib/state.js');

/** Duck-typed video adapter that records restore calls. */
function makeVideo({ currentTime = 42.5, paused = true } = {}) {
  const calls = [];
  const video = {
    currentTime,
    paused,
    calls,
    play() { this.paused = false; calls.push('play'); },
    pause() { this.paused = true; calls.push('pause'); },
  };
  return video;
}

// The full permutation matrix: entry point × exit path × initial play/pause.
// Every disengage (and the successful save) must restore currentTime + play state.
const EXITS = {
  'save (complete)': (m) => m.save() && m.complete(),
  'esc': (m) => m.disengage('esc'),
  'unfocus': (m) => m.disengage('unfocus'),
  'spa-nav': (m) => m.disengage('nav'),
  'ad-abort': (m) => m.disengage('ad'),
  'window-blur': (m) => m.disengage('blur'),
};

const ENTRIES = {
  button: (m) => m.request('button'),
  shortcut: (m) => m.request('shortcut'),
};

for (const [entryName, entry] of Object.entries(ENTRIES)) {
  for (const [exitName, exit] of Object.entries(EXITS)) {
    for (const paused of [true, false]) {
      test(`state: ${entryName} × ${exitName} × ${paused ? 'paused' : 'playing'} restores`, () => {
        const video = makeVideo({ currentTime: 33.3, paused });
        const machine = state.create(video);

        // enter the flow from idle
        assert.equal(machine.request(entryName === 'shortcut' ? 'shortcut' : 'button'), true);
        assert.equal(machine.getState(), 'activating');
        assert.deepEqual(machine.getActivation(), { currentTime: 33.3, paused });

        // walk to a fully engaged state so every exit path is reachable
        machine.startSelect();
        assert.equal(machine.getState(), 'selecting');
        machine.finishSelect();
        assert.equal(machine.getState(), 'engaged');

        // change the video state while engaged (simulates preview seeks/play)
        video.currentTime = 9.9;
        video.paused = !paused;

        exit(machine);
        assert.equal(machine.getState(), 'idle');
        assert.equal(video.currentTime, 33.3, 'currentTime restored');
        assert.equal(video.paused, paused, 'play state restored');
        assert.equal(machine.getActivation(), null);
      });
    }
  }
}

test('state: restore fires on save-complete too (tool disengages after save)', () => {
  const video = makeVideo({ currentTime: 12, paused: true });
  const machine = state.create(video);
  machine.request();
  machine.startSelect();
  machine.finishSelect();
  video.currentTime = 1;
  video.paused = false;
  machine.save();
  assert.equal(machine.getState(), 'saving');
  machine.complete();
  assert.equal(machine.getState(), 'idle');
  assert.equal(video.currentTime, 12);
  assert.equal(video.paused, true);
});

test('state: invalid transitions are rejected and leave state unchanged', () => {
  const video = makeVideo({ currentTime: 5, paused: true });
  const machine = state.create(video);
  assert.equal(machine.save(), false);
  assert.equal(machine.getState(), 'idle');
  assert.equal(machine.finishSelect(), false);
  assert.equal(machine.getState(), 'idle');
});

test('state: disengage from activating/selecting also restores', () => {
  const video = makeVideo({ currentTime: 8, paused: false });
  const machine = state.create(video);
  machine.request();
  machine.startSelect();
  video.paused = true;
  video.currentTime = 0;
  machine.disengage('esc');
  assert.equal(machine.getState(), 'idle');
  assert.equal(video.currentTime, 8);
  assert.equal(video.paused, false);
});

test('state: onChange is notified after each transition', () => {
  const seen = [];
  const machine = state.create(makeVideo({ currentTime: 0, paused: true }), {
    onChange: (s) => seen.push(s),
  });
  machine.request();
  machine.startSelect();
  machine.finishSelect();
  machine.save();
  machine.complete();
  assert.deepEqual(seen, ['activating', 'selecting', 'engaged', 'saving', 'idle']);
});

test('state: lastReason records the disengage cause', () => {
  const machine = state.create(makeVideo({ currentTime: 0, paused: true }));
  machine.request();
  machine.disengage('window-blur');
  assert.equal(machine.lastReason(), 'window-blur');
});

test('state: requires a video adapter', () => {
  assert.throws(() => state.create(null), /video adapter/);
});
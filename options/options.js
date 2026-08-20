'use strict';

/*
 * options.js
 *
 * Options page controller: loads stored settings into the form and persists
 * validated values to `storage.local`. The pure resolution/validation logic
 * lives in lib/options.js and the storage wrappers in lib/storage.js, so this
 * file only handles DOM + wiring.
 */

(function () {
  var form = document.getElementById('settings');
  var statusEl = document.getElementById('status');

  function flash(message, ok) {
    statusEl.textContent = message;
    statusEl.className = 'status ' + (ok ? 'ok' : 'err');
    clearTimeout(flash._t);
    flash._t = setTimeout(function () { statusEl.textContent = ''; }, 2000);
  }

  ytSnipStorage.get(null).then(function (items) {
    var opts = ytSnipOptions.resolve(items);
    document.getElementById('fps').value = opts.fps;
    document.getElementById('maxDimension').value = opts.maxDimension;
    document.getElementById('saveAs').checked = opts.saveAs;
  }).catch(function (e) {
    flash('Could not load settings: ' + e.message, false);
  });

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var fps = parseInt(document.getElementById('fps').value, 10);
    var maxDimension = parseInt(document.getElementById('maxDimension').value, 10);
    var saveAs = document.getElementById('saveAs').checked;
    var normalized = ytSnipOptions.resolve({ fps: fps, maxDimension: maxDimension, saveAs: saveAs });

    ytSnipStorage.set({
      fps: normalized.fps,
      maxDimension: normalized.maxDimension,
      saveAs: normalized.saveAs,
      format: normalized.format,
    }).then(function () {
      flash('Settings saved', true);
      // reflect clamped values back into the form
      document.getElementById('fps').value = normalized.fps;
      document.getElementById('maxDimension').value = normalized.maxDimension;
    }).catch(function (err) {
      flash('Could not save settings: ' + err.message, false);
    });
  });
})();
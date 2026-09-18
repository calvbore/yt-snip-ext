/*
 * lib/scheduler.js
 *
 * Pure frame scheduler for seek-lenient capture.
 *
 * The capture engine seeks the live player to a target time and captures
 * whatever frame is actually *rendered* — it never trusts the seek to land
 * exactly (YouTube's MSE only keyframes at ~1–2 s intervals). The scheduler
 * therefore:
 *   1. seeks to each target time at `1/fps`
 *   2. waits for the next rendered frame and reads its real `mediaTime`
 *   3. emits only frames whose mediaTime lies inside the clip window
 *   4. dedups repeated mediaTimes (multiple targets landing on one keyframe)
 *   5. advances the target past the landed mediaTime so it doesn't chase a
 *      keyframe it has already captured
 *
 * `source` is a duck-typed interface (see content/capture.js):
 *   seek(t)            → Promise<void>
 *   waitRendered()     → Promise<number|null> (the next rendered mediaTime)
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else if (typeof define === 'function' && define.amd) {
    define([], factory);
  } else {
    root.ytSnipScheduler = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /**
   * Async generator of { target, media } capture samples.
   * Options: { start, end, fps, epsilon, hold }
   *
   * `hold` (M17 slow motion) changes the sampling contract: the same rendered
   * frame may serve several consecutive output slots, so repeated mediaTimes
   * are EXPECTED and emitted as-is. Emit whenever the rendered mediaTime has
   * reached the current target and advance the target strictly by dt —
   * without this, the default-mode dedup silently collapses slow-motion
   * output back to 1× (every duplicate would be dropped). The default mode
   * (hold falsy) is byte-identical to the pre-M17 behavior.
   */
  async function* scheduledFrames(source, options) {
    var start = options.start;
    var end = options.end;
    var fps = options.fps > 0 ? options.fps : 1;
    var epsilon = options.epsilon || 0.03; // window fuzz for MSE roundoff
    var hold = !!options.hold;
    var dt = 1 / fps;

    var t = start;
    var prevMedia = -Infinity;
    // Hold mode steps by index to avoid float drift (0.2 × 3 accumulates to
    // 3.0000000000000004 and would silently drop the clip's final frame); the
    // break bound tolerates sub-step drift so the end target still lands.
    var step = 0;

    while (true) {
      if (hold ? t > end + dt * 0.5 : t > end) break;

      await source.seek(t);
      var media = await source.waitRendered();
      if (media === null || media === undefined) break; // aborted / exhausted

      if (media > end + epsilon) break; // jumped past the clip end

      if (hold) {
        yield { target: t, media: media };
        step++;
        t = start + step * dt;
        continue;
      }

      if (media >= start - epsilon && media <= end + epsilon && media > prevMedia + 1e-6) {
        yield { target: t, media: media };
        prevMedia = media;
        // Jump the target past the landed frame so we don't re-seek onto it.
        t = Math.min(end, media + dt);
      } else {
        t += dt;
      }
    }
  }

  return { scheduledFrames: scheduledFrames };
});
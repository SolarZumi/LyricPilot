(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.LyricPilotMediaBinding = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // Take this snapshot immediately before clicking the page's play control.
  // Keep the same snapshot for every poll so a seek can finish before binding.
  function capture(candidates) {
    var seen = new Set();
    var result = [];
    (candidates || []).forEach(function (candidate) {
      var element = candidate && candidate.element;
      if (!element || seen.has(element)) return;
      seen.add(element);
      result.push({
        element: element,
        document: candidate.document || element.ownerDocument,
        isConnected: element.isConnected === true,
        paused: element.paused !== false,
        ended: element.ended === true,
        currentTime: element.currentTime,
        currentSrc: element.currentSrc || '',
        seeking: element.seeking === true
      });
    });
    return result;
  }

  function isPlaying(snapshot) {
    return snapshot.isConnected && !snapshot.paused && !snapshot.ended;
  }

  function resolve(candidates) {
    if (candidates.length > 1) return { status: 'ambiguous' };
    if (!candidates.length || candidates[0].seeking) return { status: 'waiting' };
    return { status: 'bound', element: candidates[0].element };
  }

  function select(baseline, candidates) {
    var previous = new Map();
    (baseline || []).forEach(function (snapshot) {
      previous.set(snapshot.element, snapshot);
    });
    var started = [];
    capture(candidates).forEach(function (snapshot) {
      if (!isPlaying(snapshot)) return;
      var before = previous.get(snapshot.element);
      if (!before || !isPlaying(before)) {
        started.push(snapshot);
      }
    });
    // Already-playing media can loop or switch tracks without the chosen click.
    // Require a new start; the user should pause the page before starting again.
    // Do not resolve ties by DOM order or media labels.
    return resolve(started);
  }

  // This deliberately bypasses change detection. Use only when the user has
  // explicitly requested attaching to the media that is already playing.
  function uniquePlaying(candidates) {
    return resolve(capture(candidates).filter(isPlaying));
  }

  return Object.freeze({ capture: capture, select: select, uniquePlaying: uniquePlaying });
});

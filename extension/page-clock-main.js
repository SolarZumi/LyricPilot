// Runs in the page world: DistroKid's WaveSurfer clock is not an HTML media element.
(() => {
  'use strict';
  if (!/^(www\.)?distrokid\.com$/.test(location.hostname) || !/^\/potato\/?$/.test(location.pathname)) return;
  const installed = '__lyricPilotDistroKidClockV1';
  if (window[installed]) return;
  window[installed] = true;
  const requestEvent = 'lyricpilot:clock-request-v1', responseEvent = 'lyricpilot:clock-response-v1';
  let current = null, nextId = 0;

  function release() {
    if (!current) return;
    for (const [event, fn] of current.listeners) current.player.un(event, fn);
    current = null;
  }
  function find() {
    const player = window.track?.[0], container = document.getElementById('track0');
    if (!container?.isConnected || !player || player.container !== container || player.backend?.media?.isConnected ||
        !['getCurrentTime','getDuration','isPlaying','pause','on','un'].every(key => typeof player[key] === 'function')) {
      release(); return null;
    }
    const source = player.backend?.buffer || player.backend?.media || null;
    if (current?.player !== player || current?.source !== source) {
      release();
      const record = {player, source, id:String(++nextId), seekSerial:0, ended:false, listeners:[]};
      for (const [event, fn] of [
        ['seek', () => { record.seekSerial++; }],
        ['finish', () => { record.ended = true; }],
        ['play', () => { record.ended = false; }]
      ]) { player.on(event, fn); record.listeners.push([event, fn]); }
      current = record;
    }
    return current;
  }
  function snapshot(record) {
    if (!record) return null;
    const {player} = record;
    const time = player.getCurrentTime(), duration = player.getDuration();
    const rate = player.backend?.playbackRate ?? 1;
    if (!Number.isFinite(time) || time < 0 || !Number.isFinite(duration) || duration <= 0 || !Number.isFinite(rate) || rate <= 0) return null;
    return {id:record.id, time, duration, rate, paused:!player.isPlaying(), ended:record.ended, seekSerial:record.seekSerial};
  }
  document.addEventListener(requestEvent, event => {
    if (event.target !== document || typeof event.detail !== 'string' || event.detail.length > 512) return;
    let message;
    try { message = JSON.parse(event.detail); } catch (_) { return; }
    if (!message || !Number.isSafeInteger(message.requestId) || !['read','pause','release'].includes(message.action)) return;
    let result = null;
    try {
      if (message.action === 'release') release();
      else {
        const record = find();
        // Only pause the exact player/buffer that the client previously sampled.
        if (message.action === 'pause' && record?.id === message.id && record.player.isPlaying()) {
          record.player.pause();
          if (typeof window.setPlayButton === 'function') window.setPlayButton(0);
        }
        result = snapshot(record);
      }
    } catch (_) { result = null; }
    document.dispatchEvent(new CustomEvent(responseEvent, {detail:JSON.stringify({requestId:message.requestId, clock:result})}));
  });
})();

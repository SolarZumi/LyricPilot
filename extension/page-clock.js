(() => {
  'use strict';
  const requestEvent = 'lyricpilot:clock-request-v1', responseEvent = 'lyricpilot:clock-response-v1';
  class PageClock {
    constructor(doc) { this.document = doc; this.sequence = 0; this.audio = null; }
    request(action, id) {
      const requestId = ++this.sequence;
      let response = null;
      const receive = event => {
        if (event.target !== this.document || typeof event.detail !== 'string' || event.detail.length > 1024) return;
        try { const data = JSON.parse(event.detail); if (data?.requestId === requestId) response = data.clock; } catch (_) {}
      };
      this.document.addEventListener(responseEvent, receive);
      try { this.document.dispatchEvent(new this.document.defaultView.CustomEvent(requestEvent, {detail:JSON.stringify({requestId, action, id})})); }
      finally { this.document.removeEventListener(responseEvent, receive); }
      return response;
    }
    refresh() {
      const value = this.request('read');
      const valid = value && typeof value.id === 'string' && /^\d+$/.test(value.id) &&
        Number.isFinite(value.time) && value.time >= 0 && Number.isFinite(value.duration) && value.duration > 0 &&
        Number.isFinite(value.rate) && value.rate > 0 && Number.isSafeInteger(value.seekSerial) && value.seekSerial >= 0 &&
        typeof value.paused === 'boolean' && typeof value.ended === 'boolean';
      if (!valid || (this.audio && this.audio.id !== value.id)) {
        if (this.audio) this.audio.isConnected = false;
        this.audio = null;
      }
      if (!valid) return;
      if (!this.audio) {
        const id = value.id;
        this.audio = {id, ownerDocument:this.document, currentSrc:`page-clock:${id}`, readyState:4,
          pause:() => { this.request('pause',id); this.refresh(); }};
      }
      Object.assign(this.audio, {isConnected:true, currentTime:value.time, paused:value.paused, ended:value.ended,
        playbackRate:value.rate, seeking:false, seekSerial:value.seekSerial});
    }
    discover() {
      this.refresh();
      return this.audio ? [{element:this.audio, document:this.document}] : [];
    }
    destroy() {
      this.request('release');
      if (this.audio) this.audio.isConnected = false;
      this.audio = null;
    }
  }
  globalThis.LyricPilotPageClock = PageClock;
})();

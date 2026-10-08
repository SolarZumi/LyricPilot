(() => {
  'use strict';
  const C = globalThis.LyricPilotCore, A = globalThis.LyricPilotActions, M = globalThis.LyricPilotMediaBinding;
  class Session {
    constructor(onChange, onDocument) {
      this.onChange = onChange; this.onDocument = onDocument; this.phase = 'ready'; this.documents = new Set();
      this.watch(document);
      this.visibility = () => { if (document.hidden && this.active) this.fail('标签页已隐藏，对齐已停止'); };
      this.blur = () => { if (this.active && this.config?.duration === 'hold') this.fail('页面失去焦点，已释放按住的输入'); };
      document.addEventListener('visibilitychange',this.visibility);
      window.addEventListener('blur',this.blur);
    }
    get active() { return this.phase === 'running'; }
    watch(doc) {
      if (this.documents.has(doc)) return;
      this.documents.add(doc); this.onDocument?.(doc);
      const seek = e => { if (e.target === this.audio && this.active && !this.waiting) this.fail('播放位置发生跳转，请在网页复位后重新开始'); };
      const hide = () => { if (this.active) this.fail('页面已离开，对齐已停止'); };
      doc.addEventListener('seeking',seek,true); doc.defaultView?.addEventListener('pagehide',hide);
      this.cleanups ||= []; this.cleanups.push(() => {doc.removeEventListener('seeking',seek,true);doc.defaultView?.removeEventListener('pagehide',hide);});
    }
    discover() { const media = A.discoverMedia(document); media.forEach(m => this.watch(m.document)); return media; }
    emit(phase,message = '') { this.phase = phase; this.onChange({phase,message}); }
    release() { const controller = this.controller; this.controller = null; try { controller?.destroy(); } catch (_) {} }
    clear() { clearInterval(this.interval); cancelAnimationFrame(this.frame); this.interval = this.frame = null; }
    stop(message = '', silent = false) {
      this.ending = true; this.waiting = null; this.resuming = false; this.clear();
      if (this.runner && ['armed','running','paused'].includes(this.runner.status)) this.runner.stop('manual');
      this.release(); if (this.audio && !this.audio.paused) this.audio.pause();
      this.runner = null; this.audio = null; this.ending = false;
      if (!silent) this.emit('ready',message); else this.phase = 'ready';
    }
    targetAction(which, action) {
      try { return action(); }
      catch (error) {
        if (error.code === 'target-unavailable') { error.target = which; this.selectionFailure = error; }
        throw error;
      }
    }
    fail(error) {
      const target = error?.target || this.selectionFailure?.target;
      this.selectionFailure = null;
      this.stop(target ? '' : typeof error === 'string' ? error : error?.message || '对齐已停止');
      if (target) this.onChange({targetError:target});
    }
    start(config) {
      if (this.active) return;
      if (!config.cues.length || !config.playTarget) throw new Error('请先导入歌词并选择播放按钮');
      if (config.kind === 'button' && !config.target) throw new Error('请先选择标记按钮');
      if (config.kind === 'custom' && !config.key?.code) throw new Error('请先录入标记按键');
      const schedule = C.buildSchedule(config.cues,{mode:config.duration === 'hold' ? 'hold' : 'click',offsetMs:Math.round(config.offset*1000),allowEstimatedEnds:false});
      this.stop('',true); this.config = config; this.schedule = schedule; this.selectionFailure = null;
      try {
        this.targetAction('play',() => A.checkTarget(config.playTarget));
        if (config.kind === 'button') this.targetAction('mark',() => A.checkTarget(config.target));
      } catch (error) { this.fail(error); return; }
      this.baseline = M.capture(this.discover()); this.lastScan = -Infinity;
      this.waiting = {deadline:performance.now()+10000}; this.emit('running','等待网页播放…');
      this.onChange({index:0});
      try { this.targetAction('play',() => A.performClick(config.playTarget)); this.startClock(); }
      catch (e) { this.fail(e); }
    }
    attach(audio) {
      this.audio = audio; this.src = audio.currentSrc; this.waiting = null;
      if (this.config.kind !== 'button' || this.config.duration === 'hold') this.controller = this.makeController();
      this.runner = new C.TimingRunner({events:this.schedule.events,maxLateMs:180,
        readClock:() => {
          if (!audio.isConnected || (this.src && audio.currentSrc !== this.src)) throw new Error('音频已更换');
          return {time:audio.currentTime,paused:audio.paused,seeking:audio.seeking,ended:audio.ended,playbackRate:audio.playbackRate};
        },
        onEvent:e => {
          if (e.type !== 'keyup') this.onChange({index:e.cueIndex});
          if (e.type === 'click') {
            if (this.config.kind === 'button') this.targetAction('mark',() => A.performClick(this.config.target));
            else { try { this.controller.press(); } finally { this.controller.release(); } }
          } else if (e.type === 'keydown') this.targetAction('mark',() => this.controller.press());
          else this.controller?.release();
        },
        onState:s => {
          if (this.ending) return;
          if (s.status === 'running') this.emit('running');
          if (s.status === 'completed') { this.clear(); this.release(); this.emit('done'); }
          if (s.status === 'stopped') this.fail(this.reason(s.reason));
        }
      });
      this.runner.start();
    }
    makeController() {
      return this.config.kind === 'button' ? this.targetAction('mark',() => A.createButtonController({target:this.config.target})) :
        A.createKeyController({target:A.chooseKeyboardTarget(this.config.playTarget.document || document),binding:this.config.kind === 'custom' ? this.config.key : undefined});
    }
    pause() {
      if (!this.active) return;
      if (!this.runner || !this.audio) { this.stop('已取消等待播放'); return; }
      this.clear(); this.resuming = false; this.pausedAt = this.audio.currentTime;
      const partial = this.runner.pause(); this.audio.pause();
      this.emit('paused',partial ? '当前句已提前松开，继续时从下一句开始' : '');
    }
    resume() {
      if (this.phase !== 'paused') return;
      if (!this.audio?.isConnected || (this.src && this.audio.currentSrc !== this.src) || Math.abs(this.audio.currentTime-this.pausedAt)>.18) {
        this.fail('暂停后播放位置已改变，请在网页复位后重新开始'); return;
      }
      if (this.runner.cursor >= this.runner.events.length) { this.release(); this.emit('done'); return; }
      this.resuming = true; this.resumeDeadline = performance.now()+10000; this.emit('running','等待网页继续播放…');
      try { this.targetAction('play',() => A.performClick(this.config.playTarget)); this.startClock(); } catch(e) { this.fail(e); }
    }
    startClock() {
      this.clear(); this.interval = setInterval(() => this.tick(),10);
      const frame = () => { if (!this.active) return; this.tick(); if (this.active) this.frame = requestAnimationFrame(frame); };
      this.frame = requestAnimationFrame(frame); this.tick();
    }
    tick() {
      if (!this.active) return;
      try {
        if (document.hidden) { this.fail('标签页已隐藏，对齐已停止'); return; }
        const now = performance.now();
        if (this.resuming) {
          if (!this.audio?.isConnected || (this.src && this.audio.currentSrc !== this.src) || this.audio.currentTime < this.pausedAt-.03) throw new Error('网页播放按钮重置了进度，请在网页复位后重新开始');
          if (!this.audio.paused && !this.audio.seeking) { this.resuming = false; this.runner.resume(); }
          else if (now >= this.resumeDeadline) throw new Error('网页没有继续播放，请检查播放按钮');
          else return;
        }
        if (now-this.lastScan >= (this.waiting ? 50 : 500)) {
          this.lastScan = now; const found = M.select(this.baseline,this.discover());
          if (found.status === 'ambiguous') throw new Error('多个音频同时启动，请暂停其他音频后重试');
          if (this.waiting && found.status === 'bound' && found.element.readyState >= 3) this.attach(found.element);
          else if (this.waiting && now >= this.waiting.deadline) throw new Error('未检测到音频，请检查网页播放按钮');
        }
        if (this.runner?.held != null && this.controller && !this.controller.isPressed) {
          if (this.config.kind === 'button') this.selectionFailure = {target:'mark'};
          throw new Error('网页提前释放了输入，请在网页复位后重新开始');
        }
        this.runner?.tick();
      } catch(e) { this.fail(e); }
    }
    reason(code) {
      return ({'late-start':'已错过开始时间，请将歌曲和网页歌词复位后重试','late-event':'网页响应过慢，对齐已停止','paused':'网页已暂停，请复位后重新开始','clock-backwards':'播放进度倒退，对齐已停止','seeking':'播放位置已改变，对齐已停止','event-error':'标记操作失败，请检查所选控件','clock-error':'网页更换了音频或播放器，请重新开始','media-ended':'音频已结束','missed-hold':'已错过整句演唱区间，对齐已停止'})[code] || '对齐已停止，请检查网页和时间轴';
    }
    destroy() { this.stop('',true); this.cleanups?.forEach(fn=>fn()); document.removeEventListener('visibilitychange',this.visibility); window.removeEventListener('blur',this.blur); }
  }
  globalThis.LyricPilotSession = Session;
})();

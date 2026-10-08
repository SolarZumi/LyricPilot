/* LyricPilot: local-only timeline parsing and media-clock scheduling. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.LyricPilotCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const EPSILON = 1e-7;

  function parseTime(value) {
    if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? value : NaN;
    if (typeof value !== 'string') return NaN;
    const input = value.trim().replace(',', '.');
    if (!/^(?:\d+:){0,2}\d+(?:\.\d+)?$/.test(input)) return NaN;
    const pieces = input.split(':').map(Number);
    if (pieces.length > 1 && pieces[pieces.length - 1] >= 60) return NaN;
    if (pieces.length === 3 && pieces[1] >= 60) return NaN;
    const result = pieces.reduce((sum, component) => sum * 60 + component, 0);
    return Number.isFinite(result) ? result : NaN;
  }

  function isDirection(text) {
    return /^\[(?:intro|outro|verse|pre[- ]?chorus|chorus|post[- ]?chorus|bridge|break(?:down)?|instrumental|interlude|solo|end|cold open|final chorus|refrain|hook|tag|lift|build|half[- ]time|beat drop|turnaround|chant)\b[^\]]*\]$/i.test(text)
      || /^(?:\(?no vocals\)?|\(?instrumental\)?|纯音乐|无歌词)$/i.test(text);
  }

  function parseLyrics(input, filename = '') {
    const warnings = [];
    const metadata = { filename, format: 'unknown' };
    const cues = [];
    if (typeof input !== 'string') return { cues, warnings: ['歌词必须是文本内容。'], metadata };
    const text = input.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
    let serial = 0;
    function add(startRaw, endRaw, words, location, extra) {
      if (typeof words !== 'string' || !words.trim()) {
        warnings.push(`${location}：没有歌词，已跳过。`);
        return;
      }
      const cleanText = words.trim();
      if (isDirection(cleanText)) {
        warnings.push(`${location}：已跳过段落或无演唱标注「${cleanText}」。`);
        return;
      }
      const start = parseTime(startRaw);
      const missingEnd = endRaw === undefined || endRaw === null || endRaw === '';
      const end = missingEnd ? null : parseTime(endRaw);
      if (!Number.isFinite(start) || (end !== null && !Number.isFinite(end))) {
        warnings.push(`${location}：时间无效或为负数，已跳过。`);
        return;
      }
      if (end !== null && end < start) {
        warnings.push(`${location}：结束时间早于开始时间，已跳过。`);
        return;
      }
      if (end === start) warnings.push(`${location}：开始和结束时间相同，不能用于长按模式。`);
      cues.push({ id: `cue-${serial++}`, start, end, text: cleanText,
        endSource: end === null ? 'missing' : 'explicit', ...(extra || {}) });
    }

    const trimmed = text.trim();
    if (!trimmed) return { cues, warnings: ['文件为空。'], metadata };
    const ext = filename.toLowerCase().split('.').pop();
    const isJSON = ext === 'json' || trimmed.startsWith('{') || /^\[\s*(?:\{|\])/.test(trimmed);
    if (isJSON) {
      metadata.format = 'unsupported';
      warnings.push('不支持 JSON 歌词文件，请转换为 LRC、TSV、SRT 或 VTT。');
      return { cues, warnings, metadata };
    } else if (ext === 'srt' || ext === 'vtt' || /^WEBVTT\b/.test(trimmed) || text.includes('-->')) {
      metadata.format = /^WEBVTT\b/.test(trimmed) || ext === 'vtt' ? 'vtt' : 'srt';
      const blocks = text.split(/\n[ \t]*\n/);
      blocks.forEach((block, index) => {
        const lines = block.trim().split('\n');
        if (!block.trim()) return;
        if (/^WEBVTT\b/.test(lines[0]) || /^(?:NOTE|STYLE|REGION)(?:\s|$)/.test(lines[0])) return;
        const timingIndex = lines.findIndex(line => line.includes('-->'));
        if (timingIndex < 0) { warnings.push(`字幕块${index + 1}：缺少时间轴，已跳过。`); return; }
        const match = lines[timingIndex].match(/^\s*(\S+)\s+-->\s+(\S+)(?:\s+.*)?$/);
        if (!match) { warnings.push(`字幕块${index + 1}：时间轴格式无效，已跳过。`); return; }
        add(match[1], match[2], lines.slice(timingIndex + 1).join('\n'), `字幕块${index + 1}`);
      });
    } else if (ext === 'tsv' || text.includes('\t')) {
      metadata.format = 'tsv';
      const rows = text.split('\n').map((line, index) => ({ columns: line.split('\t'), line, index }))
        .filter(row => row.line.trim());
      const names = rows[0].columns.map(value => value.trim().toLowerCase());
      const find = aliases => names.findIndex(name => aliases.includes(name));
      const startColumn = find(['start', 'start_time', 'starttime', 'begin', '开始', '开始时间']);
      const endColumn = find(['end', 'end_time', 'endtime', '结束', '结束时间']);
      const textColumn = ['text', 'line', 'lyric', 'lyrics', '歌词', 'subtitle', '字幕']
        .map(name => names.indexOf(name)).find(index => index >= 0);
      const hasHeader = startColumn >= 0;
      if (hasHeader && textColumn === undefined) warnings.push('TSV表头缺少歌词列（text / line / lyric / 歌词 / subtitle）。');
      else {
        if (hasHeader) {
          metadata.textColumn = names[textColumn];
          if (names.includes('subtitle') || names.includes('字幕'))
            warnings.push(`已使用「${names[textColumn]}」列；字幕与演唱行的分句可能不同，请核对网页行数。`);
        }
        rows.slice(hasHeader ? 1 : 0).forEach(row => {
          if (!hasHeader && row.columns.length < 3) {
            warnings.push(`第${row.index + 1}行：没有开始、结束和歌词三列，不能生成时间轴。`); return;
          }
          add(row.columns[hasHeader ? startColumn : 0], row.columns[hasHeader ? endColumn : 1],
            hasHeader ? row.columns[textColumn] : row.columns.slice(2).join('\t'), `第${row.index + 1}行`);
        });
      }
    } else {
      metadata.format = 'lrc';
      const lines = text.split('\n');
      let offset = 0;
      // LRC offset is an advance: a positive value means lyrics appear sooner.
      lines.forEach((line, index) => {
        const match = line.trim().match(/^\[offset:([^\]]*)\]$/i);
        if (!match) return;
        if (!/^[+-]?\d+$/.test(match[1].trim()) || !Number.isFinite(Number(match[1])))
          warnings.push(`第${index + 1}行：offset必须是整数毫秒，已忽略。`);
        else offset = Number(match[1]);
      });
      metadata.offsetMs = offset;
      lines.forEach((line, index) => {
        if (!line.trim()) return;
        const meta = line.trim().match(/^\[([a-z][a-z0-9_]*):([^\]]*)\]$/i);
        if (meta) {
          if (meta[1].toLowerCase() !== 'offset') metadata[meta[1].toLowerCase()] = meta[2];
          return;
        }
        const tags = [];
        let rest = line.trim();
        while (rest.startsWith('[')) {
          const close = rest.indexOf(']');
          if (close < 0) break;
          tags.push(rest.slice(1, close));
          rest = rest.slice(close + 1);
        }
        if (!tags.length) { warnings.push(`第${index + 1}行：没有有效时间戳，已跳过。`); return; }
        if (/<\d+(?::\d+){1,2}(?:\.\d+)?>/.test(rest)) {
          warnings.push(`第${index + 1}行：字级时间戳已移除，本版本只导入逐行时间。`);
          rest = rest.replace(/<\d+(?::\d+){1,2}(?:\.\d+)?>/g, '');
        }
        tags.forEach(tag => {
          const time = parseTime(tag);
          add(Number.isFinite(time) ? time - offset / 1000 : NaN, null, rest, `第${index + 1}行`);
        });
      });
      if (!cues.length && !lines.some(line => /^\s*\[\d/.test(line))) metadata.format = 'plain';
    }
    cues.sort((a, b) => a.start - b.start);
    if (!cues.length) warnings.push('没有可用时间轴；纯歌词不能自动推断演唱时间，请导入已计时歌词。');
    else {
      const missing = cues.filter(cue => cue.end === null).length;
      if (missing) warnings.push(`${missing}句没有明确结束时间；点击模式可用，长按模式需要补充结束时间。`);
      for (let index = 1; index < cues.length; index++) {
        const previous = cues[index - 1];
        if (previous.end !== null && previous.end > cues[index].start + EPSILON)
          warnings.push(`第${index}句与第${index + 1}句时间重叠；长按模式不可直接运行。`);
        else if (Math.abs(previous.start - cues[index].start) <= EPSILON)
          warnings.push(`第${index}句与第${index + 1}句同时开始，请确认不是双语重复行。`);
      }
    }
    return { cues, warnings, metadata };
  }

  function buildSchedule(cues, options = {}) {
    const { mode = 'click', offsetMs = 0, gapMs = 40, lastDuration = 0, allowEstimatedEnds = false } = options;
    const warnings = [];
    function fail(message) { const error = new Error(message); error.warnings = warnings.slice(); throw error; }
    if (!Array.isArray(cues) || !cues.length) fail('没有可运行的歌词。');
    if (mode !== 'click' && mode !== 'hold') fail('未知录入模式。');
    if (![offsetMs, gapMs, lastDuration].every(Number.isFinite) || gapMs < 0 || lastDuration < 0)
      fail('偏移、间隔和末句时长必须为有效数字；间隔和时长不能为负。');
    const events = [];
    let previousEnd = null;
    cues.forEach((cue, index) => {
      if (!cue || !Number.isFinite(cue.start) || cue.start < 0 ||
        (cue.end != null && (!Number.isFinite(cue.end) || cue.end < cue.start))) fail(`第${index + 1}句时间无效。`);
      if (index && cue.start < cues[index - 1].start) fail('歌词顺序错误，请先按开始时间排序。');
      const start = cue.start + offsetMs / 1000;
      if (start < 0) fail(`第${index + 1}句加偏移后早于0秒，请调整偏移。`);
      if (mode === 'click') { events.push({ time: start, type: 'click', cueIndex: index }); return; }
      let end = cue.end;
      if (end == null) {
        if (!allowEstimatedEnds) fail(`第${index + 1}句缺少结束时间；请补充或明确允许估算。`);
        if (index < cues.length - 1) end = cues[index + 1].start - gapMs / 1000;
        else if (lastDuration > 0) end = cue.start + lastDuration;
        else fail('末句缺少结束时间；必须填写末句时长。');
        warnings.push(`第${index + 1}句使用估算结束时间${end.toFixed(3)}秒，请试听核对。`);
      } else if (cue.endSource === 'estimated' && !allowEstimatedEnds) fail(`第${index + 1}句为估算结束时间，尚未允许估算。`);
      end += offsetMs / 1000;
      if (!Number.isFinite(end) || end <= start) fail(`第${index + 1}句长按时长必须大于0。`);
      if (previousEnd !== null && start < previousEnd - EPSILON) fail(`第${index}句与第${index + 1}句重叠，不能连续长按；请先修正结束时间。`);
      events.push({ time: start, type: 'keydown', cueIndex: index }, { time: end, type: 'keyup', cueIndex: index });
      previousEnd = end;
    });
    const rank = { keyup: 0, click: 1, keydown: 2 };
    events.sort((a, b) => a.time - b.time || rank[a.type] - rank[b.type] || a.cueIndex - b.cueIndex);
    return { events, warnings };
  }

  class TimingRunner {
    constructor({ events, readClock, onEvent, onState = () => {}, maxLateMs = 180 }) {
      if (!Array.isArray(events) || typeof readClock !== 'function' || typeof onEvent !== 'function')
        throw new Error('TimingRunner需要events、readClock和onEvent。');
      if (!Number.isFinite(maxLateMs) || maxLateMs < 0) throw new Error('maxLateMs必须是非负数。');
      events.forEach((event, index) => {
        if (!Number.isFinite(event.time) || event.time < 0 || !['click', 'keydown', 'keyup'].includes(event.type))
          throw new Error(`事件${index + 1}无效。`);
        if (index && event.time < events[index - 1].time) throw new Error('事件未按时间排序。');
      });
      this.events = events.map(event => ({ ...event }));
      this.readClock = readClock;
      this.onEvent = onEvent;
      this.onState = onState;
      this.maxLate = maxLateMs / 1000;
      this.status = 'idle';
      this.cursor = 0;
      this.reason = '';
      this.held = null;
      this.lastTime = null;
      this.startedPlayback = false;
    }
    _state(status, reason) {
      this.status = status;
      this.reason = reason;
      try { this.onState({ status, reason, cursor: this.cursor }); } catch (_) { /* Observers cannot prevent key release. */ }
    }
    _release(reason) {
      if (this.held === null) return;
      const cueIndex = this.held;
      this.held = null;
      try { this.onEvent({ type: 'keyup', time: this.lastTime ?? 0, cueIndex, emergency: true, reason }); }
      catch (_) { /* The DOM callback has failed; do not send additional keys. */ }
    }
    stop(reason = 'manual') {
      this._release(reason);
      this._state('stopped', reason);
    }
    pause() {
      if (!['armed', 'running'].includes(this.status)) return false;
      const held = this.held;
      this._release('pause');
      if (held !== null) {
        const end = this.events.findIndex((event, index) => index >= this.cursor && event.type === 'keyup' && event.cueIndex === held);
        if (end >= this.cursor) this.cursor = end + 1;
      }
      this._state('paused', held !== null ? 'partial-hold' : 'pause');
      return held !== null;
    }
    resume() {
      if (this.status !== 'paused') return;
      this.startedPlayback = false;
      this.lastTime = null;
      this._state(this.cursor < this.events.length ? 'armed' : 'completed', 'resume');
    }
    start() {
      this._release('restart');
      this.cursor = 0;
      this.lastTime = null;
      this.startedPlayback = false;
      this._state(this.events.length ? 'armed' : 'completed', this.events.length ? 'waiting-playback' : 'complete');
      if (this.events.length) this.tick();
      return this.status;
    }
    tick() {
      if (this.status !== 'armed' && this.status !== 'running') return;
      let clock;
      try { clock = this.readClock(); } catch (_) { this.stop('clock-error'); return; }
      if (!clock || !Number.isFinite(clock.time) || clock.time < 0) { this.stop('invalid-clock'); return; }
      if (clock.seeking) {
        // The page may reset its media before the first stable playback sample.
        if (this.startedPlayback) this.stop('seeking');
        return;
      }
      if (clock.ended) { this.stop('media-ended'); return; }
      const rate = clock.playbackRate == null ? 1 : clock.playbackRate;
      if (!Number.isFinite(rate) || rate <= 0) { this.stop('invalid-playback-rate'); return; }
      if (this.startedPlayback && this.lastTime !== null && clock.time < this.lastTime - 0.001) { this.stop('clock-backwards'); return; }
      this.lastTime = clock.time;
      if (clock.paused) {
        if (this.startedPlayback) this.stop('paused');
        return;
      }
      if (!this.startedPlayback) {
        if (this.events[this.cursor] && clock.time - this.events[this.cursor].time > this.maxLate + EPSILON) { this.stop('late-start'); return; }
        this.startedPlayback = true;
        this._state('running', 'playing');
        if (this.status !== 'running') return;
      }
      const next = this.events[this.cursor];
      if (next && clock.time - next.time > this.maxLate + EPSILON) { this.stop('late-event'); return; }
      while (this.cursor < this.events.length && this.events[this.cursor].time <= clock.time + EPSILON) {
        const event = this.events[this.cursor];
        // Do not replay both a press and release after a short complete phrase was missed.
        if (event.type === 'keydown') {
          const release = this.events.slice(this.cursor + 1).find(item => item.type === 'keyup' && item.cueIndex === event.cueIndex);
          if (release && release.time <= clock.time + EPSILON) { this.stop('missed-hold'); return; }
          if (this.held !== null) { this.stop('overlapping-hold'); return; }
          this.held = event.cueIndex;
        }
        if (event.type === 'keyup') this.held = null;
        this.cursor++;
        try { this.onEvent({ ...event }); }
        catch (_) {
          if (event.type === 'keyup') this.held = event.cueIndex;
          this.stop('event-error'); return;
        }
        if (this.status !== 'running') return;
      }
      if (this.cursor === this.events.length) {
        this._release('complete');
        this._state('completed', 'complete');
      }
    }
  }
  return { parseTime, parseLyrics, buildSchedule, TimingRunner };
});

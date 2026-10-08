'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { parseTime, parseLyrics, buildSchedule, TimingRunner } = require('../extension/core.js');
const cue = (start, end, text = '詞') => ({ start, end, text, endSource: end == null ? 'missing' : 'explicit' });

function harness(events, initial = {}) {
  let clock = { time: 0, paused: false, seeking: false, ended: false, playbackRate: 1, ...initial };
  const emitted = [];
  const states = [];
  const runner = new TimingRunner({ events, readClock: () => clock,
    onEvent: event => emitted.push(event), onState: state => states.push(state) });
  return { runner, emitted, states, update: change => { clock = { ...clock, ...change }; runner.tick(); } };
}

test('CommonJS and plain browser script both expose the documented API', () => {
  const context = {};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../extension/core.js'), 'utf8'), context);
  assert.equal(typeof context.LyricPilotCore.parseLyrics, 'function');
  assert.equal(typeof context.LyricPilotCore.TimingRunner, 'function');
});

test('time parser supports seconds, minutes, hours, decimal comma and strict rejection', () => {
  assert.equal(parseTime('12.345'), 12.345);
  assert.equal(parseTime('01:02.345'), 62.345);
  assert.equal(parseTime('1:02:03,125'), 3723.125);
  assert.equal(parseTime('100:00'), 6000);
  for (const bad of [NaN, Infinity, -1, '-1', '01:60', '1:60:00', '1:2:3:4', '', 'word', {}, null])
    assert.ok(Number.isNaN(parseTime(bad)), String(bad));
});

test('LRC repeated timestamps sort stably and retain missing ends', () => {
  const result = parseLyrics('[ti:歌曲]\n[00:03.50][00:01.20]一\n[00:01.20]二\n[00:02]三', 'song.lrc');
  assert.deepEqual(result.cues.map(item => [item.start, item.end, item.text]), [
    [1.2, null, '一'], [1.2, null, '二'], [2, null, '三'], [3.5, null, '一']]);
  assert.equal(new Set(result.cues.map(item => item.id)).size, 4);
  assert.equal(result.metadata.ti, '歌曲');
  assert.ok(result.warnings.some(warning => warning.includes('没有明确结束')));
  assert.ok(result.warnings.some(warning => warning.includes('同时开始')));
});

test('positive LRC offset advances while user scheduling offset delays', () => {
  const result = parseLyrics('[00:01]词\n[offset:+250]', 'song.lrc');
  assert.equal(result.cues[0].start, .75);
  assert.equal(result.metadata.offsetMs, 250);
  assert.equal(buildSchedule(result.cues, { offsetMs: 250 }).events[0].time, 1);
  const negative = parseLyrics('[offset:-250]\n[00:01]词', 'song.lrc');
  assert.equal(negative.cues[0].start, 1.25);
  const beforeZero = parseLyrics('[offset:2000]\n[00:01]词', 'song.lrc');
  assert.equal(beforeZero.cues.length, 0);
  assert.ok(beforeZero.warnings.some(warning => warning.includes('负数')));
});

test('LRC invalid lines, enhanced word timestamps and invalid offset are visible warnings', () => {
  const result = parseLyrics('[offset:broken]\n[00:01]<00:01.00>你好<00:02.00>世界\nnot timed\n[00:99]坏行\n[00:04]', 'song.lrc');
  assert.equal(result.cues.length, 1);
  assert.equal(result.cues[0].text, '你好世界');
  assert.ok(result.warnings.some(warning => warning.includes('offset必须')));
  assert.ok(result.warnings.some(warning => warning.includes('字级')));
  assert.ok(result.warnings.some(warning => warning.includes('第3行')));
  assert.ok(result.warnings.some(warning => warning.includes('第4行')));
  assert.ok(result.warnings.some(warning => warning.includes('第5行')));
});

test('plain lyrics never invent timing', () => {
  const result = parseLyrics('どうしよう\n明日はどうなる', '歌词.txt');
  assert.equal(result.metadata.format, 'plain');
  assert.equal(result.cues.length, 0);
  assert.ok(result.warnings.some(warning => warning.includes('纯歌词不能自动推断')));
});

test('JSON files, renamed JSON and pasted JSON are rejected without treating embedded timestamps as lyrics', () => {
  const data = [{ start: 1, end: 2, text: '[00:01]一' }];
  for (const [text, name] of [
    [JSON.stringify({ lines: data }), 'aligned_lines.json'],
    [JSON.stringify(data), 'lyrics.txt'],
    [JSON.stringify({ cues: data }), '粘贴的歌词'],
    ['[00:01]一', 'renamed.JSON'],
    ['{bad}', 'bad.json'],
  ]) {
    const result = parseLyrics(text, name);
    assert.equal(result.cues.length, 0);
    assert.equal(result.metadata.format, 'unsupported');
    assert.match(result.warnings[0], /不支持 JSON/);
  }
});

test('TSV actual section/line/note and bilingual columns select original lyrics', () => {
  const rows = 'section\tstart\tend\tline\tnote\nVerse\t1\t2\t歌声\tinfo\nInstrumental\t2\t3\t(no vocals)\tend';
  const result = parseLyrics(rows, 'aligned_lines.tsv');
  assert.equal(result.cues.length, 1);
  assert.equal(result.cues[0].text, '歌声');
  assert.ok(result.warnings.some(warning => warning.includes('无演唱标注')));
  const bilingual = parseLyrics('start\tend\t字幕\t歌词\n0.96\t2.80\t怎么办\tどうしよう', '字幕.tsv');
  assert.equal(bilingual.cues[0].text, 'どうしよう');
  assert.equal(bilingual.metadata.textColumn, '歌词');
});

test('TSV section headings and missing times are not treated as lyrics', () => {
  const result = parseLyrics('start\tend\ttext\n1\t1\t[Intro — dry]\n1\t2\t词\n4\t3\t坏\nfoo\t6\t坏', 'x.tsv');
  assert.equal(result.cues.length, 1);
  assert.ok(result.warnings.some(warning => warning.includes('段落')));
  assert.ok(result.warnings.some(warning => warning.includes('第4行')));
  const untimed = parseLyrics('どうしよう\t怎么办\nあした\t明天', 'subtitles.tsv');
  assert.equal(untimed.cues.length, 0);
});

test('SRT preserves multiline cue text and decimal comma', () => {
  const result = parseLyrics('1\n00:00:01,250 --> 00:00:02,500\n一\n二\n\n2\n00:00:03,000 --> 00:00:04,000\n三', 'x.srt');
  assert.equal(result.cues.length, 2);
  assert.deepEqual([result.cues[0].start, result.cues[0].end, result.cues[0].text], [1.25, 2.5, '一\n二']);
});

test('WebVTT skips standard metadata, handles cue IDs and settings, warns malformed blocks', () => {
  const result = parseLyrics('WEBVTT\n\nNOTE source text\nignored\n\nverse-1\n00:01.000 --> 00:02.000 align:start\n詞\n\nbad block', 'x.vtt');
  assert.equal(result.cues.length, 1);
  assert.equal(result.cues[0].end, 2);
  assert.ok(result.warnings.some(warning => warning.includes('字幕块4')));
});

test('click schedule uses starts only, validates cue order, offset and invalid numbers', () => {
  assert.deepEqual(buildSchedule([cue(1, null), cue(2, 3)], { mode: 'click', offsetMs: 100 }).events,
    [{ time: 1.1, type: 'click', cueIndex: 0 }, { time: 2.1, type: 'click', cueIndex: 1 }]);
  assert.throws(() => buildSchedule([cue(2, 3), cue(1, 2)]), /顺序/);
  assert.throws(() => buildSchedule([cue(1, 2)], { offsetMs: -2000 }), /早于0/);
  assert.throws(() => buildSchedule([cue(NaN, 2)]), /无效/);
  assert.throws(() => buildSchedule([cue(1, 0)]), /无效/);
  assert.throws(() => buildSchedule([cue(1, 2)], { gapMs: -1 }), /不能为负/);
});

test('hold requires real ends unless estimates explicitly permitted, and requires a final duration', () => {
  assert.throws(() => buildSchedule([cue(1, null), cue(3, null)], { mode: 'hold' }), /缺少结束/);
  assert.throws(() => buildSchedule([cue(1, null), cue(3, null)], { mode: 'hold', allowEstimatedEnds: true }), /末句/);
  const result = buildSchedule([cue(1, null), cue(3, null)], { mode: 'hold', allowEstimatedEnds: true, lastDuration: 2, gapMs: 40 });
  assert.deepEqual(result.events.map(event => [event.time, event.type]), [[1, 'keydown'], [2.96, 'keyup'], [3, 'keydown'], [5, 'keyup']]);
  assert.equal(result.warnings.length, 2);
});

test('hold refuses overlaps and zero-length cues; boundary release comes before next press', () => {
  assert.throws(() => buildSchedule([cue(1, 3), cue(2, 4)], { mode: 'hold' }), /重叠/);
  assert.throws(() => buildSchedule([cue(1, 1)], { mode: 'hold' }), /大于0/);
  const result = buildSchedule([cue(1, 2), cue(2, 3)], { mode: 'hold' });
  assert.deepEqual(result.events.filter(event => event.time === 2).map(event => event.type), ['keyup', 'keydown']);
});

test('runner arms while paused, runs with media clock and completes exactly once', () => {
  const h = harness(buildSchedule([cue(1, 2), cue(2, 3)], { mode: 'hold' }).events, { paused: true });
  assert.equal(h.runner.start(), 'armed');
  h.update({ time: .9, paused: false, playbackRate: 2 });
  assert.equal(h.runner.status, 'running');
  h.update({ time: 1 }); h.update({ time: 2 }); h.update({ time: 3 }); h.update({ time: 4 });
  assert.deepEqual(h.emitted.map(event => event.type), ['keydown', 'keyup', 'keydown', 'keyup']);
  assert.equal(h.runner.status, 'completed');
  assert.equal(h.runner.cursor, 4);
});

test('runner never batches old cues on late start', () => {
  const h = harness(buildSchedule([cue(1, null), cue(2, null), cue(3, null)]).events, { time: 8 });
  h.runner.start();
  assert.equal(h.runner.status, 'stopped');
  assert.equal(h.runner.reason, 'late-start');
  assert.equal(h.emitted.length, 0);
});

test('armed runner waits through page initialization seeking before the first stable playback', () => {
  const h = harness(buildSchedule([cue(1, null)]).events, { time: 5, paused: true });
  assert.equal(h.runner.start(), 'armed');
  h.update({ time: 0, seeking: true });
  h.update({ paused: false });
  assert.equal(h.runner.status, 'armed');
  assert.equal(h.emitted.length, 0);
  h.update({ time: .2, seeking: false });
  assert.equal(h.runner.status, 'running');
  assert.equal(h.emitted.length, 0);
  h.update({ time: 1 });
  assert.deepEqual(h.emitted.map(event => event.type), ['click']);
  assert.equal(h.runner.status, 'completed');
});

test('an initialization seek completed between ticks does not count as playback going backwards', () => {
  const h = harness(buildSchedule([cue(1, null)]).events, { time: 5, paused: true });
  h.runner.start();
  h.update({ time: .2, paused: false });
  assert.equal(h.runner.status, 'running');
  assert.equal(h.emitted.length, 0);
  h.update({ time: 1 });
  assert.equal(h.emitted.length, 1);
  assert.equal(h.runner.status, 'completed');
});

test('first stable playback after initialization still stops if the first cue has expired', () => {
  const h = harness(buildSchedule([cue(1, null), cue(2, null)]).events, { paused: true });
  h.runner.start();
  h.update({ time: 1.5, seeking: true, paused: false });
  assert.equal(h.runner.status, 'armed');
  h.update({ seeking: false });
  assert.equal(h.runner.status, 'stopped');
  assert.equal(h.runner.reason, 'late-start');
  assert.equal(h.emitted.length, 0);
  h.update({ time: 2 });
  assert.equal(h.emitted.length, 0);
});

test('seeking after playback starts stops and releases a held key without resuming', () => {
  const h = harness(buildSchedule([cue(1, 2), cue(3, 4)], { mode: 'hold' }).events, { paused: true });
  h.runner.start();
  h.update({ time: 1, paused: false });
  assert.equal(h.runner.status, 'running');
  h.update({ time: .1, seeking: true });
  assert.equal(h.runner.status, 'stopped');
  assert.equal(h.runner.reason, 'seeking');
  assert.deepEqual(h.emitted.map(event => event.type), ['keydown', 'keyup']);
  assert.equal(h.emitted[1].emergency, true);
  h.update({ time: 3, seeking: false });
  assert.equal(h.emitted.length, 2);
});

test('a late tick stops and releases held key instead of catching up', () => {
  const h = harness(buildSchedule([cue(1, 2), cue(3, 4)], { mode: 'hold' }).events);
  h.runner.start(); h.update({ time: 1 }); h.update({ time: 3.5 });
  assert.equal(h.runner.reason, 'late-event');
  assert.deepEqual(h.emitted.map(event => event.type), ['keydown', 'keyup']);
  assert.equal(h.emitted[1].emergency, true);
});

test('pause, seek, rewind, end and invalid playback rate release key and require manual restart', () => {
  for (const [change, reason] of [
    [{ paused: true }, 'paused'], [{ seeking: true }, 'seeking'], [{ time: .5 }, 'clock-backwards'],
    [{ ended: true }, 'media-ended'], [{ playbackRate: -1 }, 'invalid-playback-rate']
  ]) {
    const h = harness(buildSchedule([cue(1, 2)], { mode: 'hold' }).events);
    h.runner.start(); h.update({ time: 1 }); h.update(change);
    assert.equal(h.runner.reason, reason);
    assert.equal(h.emitted.at(-1).type, 'keyup');
    assert.equal(h.emitted.at(-1).emergency, true);
    const count = h.emitted.length;
    h.update({ time: 1.2, paused: false, seeking: false, ended: false, playbackRate: 1 });
    assert.equal(h.emitted.length, count);
  }
});

test('onEvent failure stops and attempts key release', () => {
  let clock = { time: 0, paused: false };
  const emitted = [];
  const runner = new TimingRunner({ events: buildSchedule([cue(1, 2)], { mode: 'hold' }).events,
    readClock: () => clock, onEvent: event => { emitted.push(event); if (event.type === 'keydown') throw Error('DOM failure'); } });
  runner.start(); clock.time = 1; runner.tick();
  assert.equal(runner.reason, 'event-error');
  assert.deepEqual(emitted.map(event => event.type), ['keydown', 'keyup']);
  assert.equal(emitted[1].emergency, true);
});

test('a failed normal keyup is retried as an emergency release', () => {
  const clock = { time: 0, paused: false };
  const emitted = [];
  const runner = new TimingRunner({ events: buildSchedule([cue(1, 2)], { mode: 'hold' }).events,
    readClock: () => clock, onEvent: event => {
      emitted.push(event);
      if (event.type === 'keyup' && !event.emergency) throw Error('release DOM failure');
    } });
  runner.start(); clock.time = 1; runner.tick(); clock.time = 2; runner.tick();
  assert.equal(runner.reason, 'event-error');
  assert.deepEqual(emitted.map(event => event.type), ['keydown', 'keyup', 'keyup']);
  assert.equal(emitted[2].emergency, true);
});

test('a state observer can cancel playback before any input is sent', () => {
  const emitted = [];
  const runner = new TimingRunner({ events: buildSchedule([cue(0, 1)], { mode: 'hold' }).events,
    readClock: () => ({ time: 0, paused: false }), onEvent: event => emitted.push(event),
    onState: state => { if (state.status === 'running') runner.stop('observer-cancel'); } });
  runner.start();
  assert.equal(runner.reason, 'observer-cancel');
  assert.equal(emitted.length, 0);
});

test('runner rejects a missed entire short hold instead of issuing instantaneous press/release', () => {
  const h = harness(buildSchedule([cue(1, 1.05)], { mode: 'hold' }).events);
  h.runner.start(); h.update({ time: 1.1 });
  assert.equal(h.runner.reason, 'missed-hold');
  assert.equal(h.emitted.length, 0);
});

test('manual stop releases key at most once and restart begins at cue zero', () => {
  const h = harness(buildSchedule([cue(1, 2)], { mode: 'hold' }).events);
  h.runner.start(); h.update({ time: 1 }); h.runner.stop(); h.runner.stop();
  assert.equal(h.emitted.filter(event => event.type === 'keyup').length, 1);
  h.update({ time: 0, paused: true });
  h.runner.start(); assert.equal(h.runner.cursor, 0);
  h.update({ time: 1, paused: false }); assert.equal(h.emitted.at(-1).type, 'keydown');
});

test('distributed lyric examples parse and preserve the same four cue starts', () => {
  const dir = path.join(__dirname, '../examples');
  const load = name => parseLyrics(fs.readFileSync(path.join(dir, name), 'utf8'), name);
  const lrc = load('sample.lrc');
  assert.deepEqual(lrc.cues.map(cue=>cue.start),[1,3,6,9]);
  assert.ok(lrc.cues.every(cue=>cue.end===null));
  for (const extension of ['tsv','srt','vtt']) {
    const parsed = load('sample.'+extension);
    assert.deepEqual(parsed.cues.map(cue=>cue.start),[1,3,6,9]);
    assert.equal(parsed.cues[0].text,'第一句，在一秒开始');
    assert.equal(buildSchedule(parsed.cues,{mode:'hold'}).events.length,8);
  }
});

test('manual pause preserves pending clicks and resume never replays completed cues', () => {
  const h = harness(buildSchedule([cue(1,null),cue(3,null),cue(6,null)]).events);
  h.runner.start(); h.update({time:1});
  assert.equal(h.runner.pause(),false);
  h.update({time:2,paused:true});
  assert.equal(h.emitted.length,1);
  h.runner.resume(); h.update({time:2,paused:false}); h.update({time:3}); h.update({time:6});
  assert.deepEqual(h.emitted.map(e=>e.cueIndex),[0,1,2]);
  assert.equal(h.runner.status,'completed');
});

test('pausing a held line releases it once and continues with the next line', () => {
  const h = harness(buildSchedule([cue(1,2.4),cue(3,4.5)],{mode:'hold'}).events);
  h.runner.start(); h.update({time:1}); h.update({time:1.5});
  assert.equal(h.runner.pause(),true);
  assert.equal(h.emitted.at(-1).emergency,true);
  assert.equal(h.runner.cursor,2);
  h.runner.pause();
  h.runner.resume(); h.update({time:1.5}); h.update({time:2.4}); h.update({time:3}); h.update({time:4.5});
  assert.deepEqual(h.emitted.map(e=>[e.type,e.cueIndex]),[['keydown',0],['keyup',0],['keydown',1],['keyup',1]]);
  assert.equal(h.runner.status,'completed');
});

test('pause inside a keydown callback cannot skip the following line', () => {
  let clock={time:0,paused:false},events=[];
  const runner = new TimingRunner({events:buildSchedule([cue(1,2),cue(3,4)],{mode:'hold'}).events,
    readClock:()=>clock,onEvent:event=>{events.push(event);if(event.type==='keydown'&&event.cueIndex===0)runner.pause();}});
  runner.start(); clock.time=1;runner.tick();
  assert.equal(runner.cursor,2);assert.equal(runner.status,'paused');
  runner.resume();clock.time=3;runner.tick();clock.time=4;runner.tick();
  assert.deepEqual(events.map(e=>[e.type,e.cueIndex]),[['keydown',0],['keyup',0],['keydown',1],['keyup',1]]);
});

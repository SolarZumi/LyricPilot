'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const binding = require('../extension/media-binding.js');

function media(properties = {}) {
  return {
    isConnected: true, paused: true, ended: false, currentTime: 0,
    currentSrc: 'https://example.invalid/song.mp3', seeking: false,
    ownerDocument: {}, ...properties
  };
}

function candidates(...elements) {
  return elements.map(element => ({ element, document: element.ownerDocument }));
}

test('loads without a DOM as CommonJS and as a browser global', () => {
  assert.equal(typeof binding.capture, 'function');
  const context = vm.createContext({});
  vm.runInContext(fs.readFileSync(require.resolve('../extension/media-binding.js'), 'utf8'), context);
  assert.equal(typeof context.LyricPilotMediaBinding.select, 'function');
});

test('capture keeps independent playback values and deduplicates elements', () => {
  const element = media({ currentTime: 12, seeking: true });
  const baseline = binding.capture(candidates(element, element));
  assert.equal(baseline.length, 1);
  assert.deepEqual(baseline[0], {
    element, document: element.ownerDocument, isConnected: true,
    paused: true, ended: false, currentTime: 12,
    currentSrc: 'https://example.invalid/song.mp3', seeking: true
  });
  Object.assign(element, { paused: false, currentTime: 0, currentSrc: 'blob:new', seeking: false });
  assert.equal(baseline[0].paused, true);
  assert.equal(baseline[0].currentTime, 12);
  assert.equal(baseline[0].currentSrc, 'https://example.invalid/song.mp3');
  assert.equal(baseline[0].seeking, true);
});

test('binds the player started by the play action while background audio continues', () => {
  const background = media({ paused: false, currentTime: 40 });
  const song = media();
  const all = candidates(background, song);
  const baseline = binding.capture(all);
  Object.freeze(baseline);
  baseline.forEach(Object.freeze);
  background.currentTime = 40.5;
  song.paused = false;
  Object.freeze(song);
  assert.deepEqual(binding.select(baseline, all), { status: 'bound', element: song });
});

test('binds a media element created after the click and ignores a paused new element', () => {
  const background = media({ paused: false });
  const baseline = binding.capture(candidates(background));
  const paused = media();
  assert.deepEqual(binding.select(baseline, candidates(background, paused)), { status: 'waiting' });
  const song = media({ paused: false });
  assert.deepEqual(binding.select(baseline, candidates(background, paused, song)), { status: 'bound', element: song });
});

test('restarting an ended player and connecting a previously detached player count as starts', () => {
  for (const initial of [{ paused: false, ended: true }, { paused: false, isConnected: false }]) {
    const element = media(initial);
    const all = candidates(element);
    const baseline = binding.capture(all);
    Object.assign(element, { isConnected: true, paused: false, ended: false });
    assert.deepEqual(binding.select(baseline, all), { status: 'bound', element });
  }
});

test('does not bind an unchanged playing element, even when it is the only one', () => {
  const song = media({ paused: false, currentTime: 10 });
  const all = candidates(song);
  const baseline = binding.capture(all);
  assert.deepEqual(binding.select(baseline, all), { status: 'waiting' });
  song.currentTime = 11;
  assert.deepEqual(binding.select(baseline, all), { status: 'waiting' });
});

test('two started players are ambiguous regardless of order or labels', () => {
  const first = media();
  const second = media();
  const all = candidates(first, second);
  all[0].label = '歌词音频';
  all[1].label = '背景广告';
  const baseline = binding.capture(all);
  first.paused = second.paused = false;
  assert.deepEqual(binding.select(baseline, all), { status: 'ambiguous' });
  assert.deepEqual(binding.select(baseline, all.slice().reverse()), { status: 'ambiguous' });
  assert.deepEqual(binding.select([], all), { status: 'ambiguous' });
});

test('ignores source changes and loops in media that was already playing', () => {
  for (const change of [{ currentSrc: 'blob:new-song' }, { currentTime: 0 }]) {
    const element = media({ paused: false, currentTime: 50 });
    const all = candidates(element);
    const baseline = binding.capture(all);
    Object.assign(element, change);
    assert.deepEqual(binding.select(baseline, all), { status: 'waiting' });
  }
});

test('multiple background players looping are not new starts', () => {
  const first = media({ paused: false, currentTime: 10 });
  const second = media({ paused: false, currentTime: 20 });
  const all = candidates(first, second);
  const baseline = binding.capture(all);
  first.currentTime = second.currentTime = 0;
  assert.deepEqual(binding.select(baseline, all), { status: 'waiting' });
});

test('binds a started player while background audio loops or changes source', () => {
  for (const change of [{ currentTime: 0 }, { currentSrc: 'blob:next-background' }]) {
    const background = media({ paused: false, currentTime: 10 });
    const song = media();
    const all = candidates(background, song);
    const baseline = binding.capture(all);
    Object.assign(background, change);
    assert.deepEqual(binding.select(baseline, all), { status: 'waiting' });
    song.paused = false;
    assert.deepEqual(binding.select(baseline, all), { status: 'bound', element: song });
  }
});

test('waits for a seek to finish while keeping the original baseline', () => {
  for (const initial of [{ paused: true }, { paused: false, ended: true }]) {
    const element = media({ currentTime: 30, ...initial });
    const all = candidates(element);
    const baseline = binding.capture(all);
    Object.assign(element, { paused: false, ended: false, currentTime: 0, seeking: true });
    assert.deepEqual(binding.select(baseline, all), { status: 'waiting' });
    element.seeking = false;
    assert.deepEqual(binding.select(baseline, all), { status: 'bound', element });
  }
});

test('a second started player remains ambiguous while it is seeking', () => {
  const first = media();
  const second = media();
  const all = candidates(first, second);
  const baseline = binding.capture(all);
  first.paused = second.paused = false;
  second.seeking = true;
  assert.deepEqual(binding.select(baseline, all), { status: 'ambiguous' });
});

test('a seek that began before the baseline is not evidence of a new start', () => {
  const element = media({ paused: false, currentTime: 20, seeking: true });
  const all = candidates(element);
  const baseline = binding.capture(all);
  Object.assign(element, { currentTime: 0, seeking: false });
  assert.deepEqual(binding.select(baseline, all), { status: 'waiting' });
});

test('ignores disconnected, paused, ended, and no-longer-discovered media', () => {
  for (const change of [{ isConnected: false, paused: false }, { paused: true }, { paused: false, ended: true }]) {
    const element = media();
    const baseline = binding.capture(candidates(element));
    Object.assign(element, change);
    assert.deepEqual(binding.select(baseline, candidates(element)), { status: 'waiting' });
    assert.deepEqual(binding.select(baseline, []), { status: 'waiting' });
  }
  assert.deepEqual(binding.select([], []), { status: 'waiting' });
});

test('does not infer a time reset from unknown times', () => {
  for (const time of [NaN, Infinity, undefined]) {
    const element = media({ paused: false, currentTime: time });
    const all = candidates(element);
    const baseline = binding.capture(all);
    element.currentTime = 0;
    assert.deepEqual(binding.select(baseline, all), { status: 'waiting' });
  }
});

test('explicit attachment requires exactly one connected playing element', () => {
  const first = media({ paused: false });
  const second = media();
  assert.deepEqual(binding.uniquePlaying(candidates(first, second, first)), { status: 'bound', element: first });
  second.paused = false;
  assert.deepEqual(binding.uniquePlaying(candidates(first, second)), { status: 'ambiguous' });
  first.seeking = true;
  assert.deepEqual(binding.uniquePlaying(candidates(first)), { status: 'waiting' });
  first.isConnected = false;
  assert.deepEqual(binding.uniquePlaying(candidates(first)), { status: 'waiting' });
  assert.deepEqual(binding.uniquePlaying([]), { status: 'waiting' });
});

'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const vm = require('node:vm'), fs = require('node:fs'), path = require('node:path');
const C = require('../extension/core.js'), M = require('../extension/media-binding.js');
const source = name => fs.readFileSync(path.join(__dirname,'../extension',name),'utf8');

function setup({hostname='distrokid.com', pathname='/potato/'} = {}) {
  const document = new EventTarget(), window = new EventTarget();
  document.defaultView = window; document.hidden = false; window.CustomEvent = CustomEvent;
  const container = {isConnected:true}; document.getElementById = id => id === 'track0' ? container : null;
  function player() {
    const handlers = new Map();
    return {container, backend:{buffer:{},playbackRate:1}, time:0, duration:8, playing:false, handlers,
      getCurrentTime(){return this.time;},getDuration(){return this.duration;},isPlaying(){return this.playing;},
      pause(){this.playing=false;this.fire('pause');},play(){this.playing=true;this.fire('play');},
      seek(time){this.time=time;this.fire('seek');},
      on(event, fn){if(!handlers.has(event))handlers.set(event,new Set());handlers.get(event).add(fn);},
      un(event, fn){handlers.get(event)?.delete(fn);},fire(event){handlers.get(event)?.forEach(fn=>fn());}
    };
  }
  window.track = [player()];let buttonUpdates=0;
  window.setPlayButton = () => buttonUpdates++;
  const main = vm.createContext({window,document,CustomEvent,location:{hostname,pathname}});
  vm.runInContext(source('page-clock-main.js'),main);
  let now = 0, nextTimer = 0, clicks = 0, pressed = false;
  const timers = new Map(), marks = [], changes = [], playTarget = {document};
  const A = {
    checkTarget:t=>t,discoverMedia:()=>[],chooseKeyboardTarget:()=>document,
    performClick(){clicks++;window.track[0].playing?window.track[0].pause():window.track[0].play();},
    createKeyController(){return {
      press(){pressed=true;marks.push(['down',window.track[0].time]);},
      release(){if(pressed){pressed=false;marks.push(['up',window.track[0].time]);}},
      destroy(){this.release();},get isPressed(){return pressed;}
    };}
  };
  const isolated = vm.createContext({document,window,LyricPilotCore:C,LyricPilotMediaBinding:M,LyricPilotActions:A,
    performance:{now:()=>now},setInterval(fn){timers.set(++nextTimer,fn);return nextTimer;},clearInterval(id){timers.delete(id);},
    requestAnimationFrame(fn){timers.set(++nextTimer,fn);return nextTimer;},cancelAnimationFrame(id){timers.delete(id);}});
  vm.runInContext(source('page-clock.js'),isolated);vm.runInContext(source('session.js'),isolated);
  const client = new isolated.LyricPilotPageClock(document);
  const session = new isolated.LyricPilotSession(change=>changes.push(change));
  const config = {cues:[{start:.8,end:1.12,text:'First'},{start:2,end:2.8,text:'Second'}],offset:0,kind:'space',duration:'hold',playTarget};
  return {document,window,container,main,client,session,config,marks,changes,timers,player,
    get audio(){return window.track[0];},get clicks(){return clicks;},get pressed(){return pressed;},get buttonUpdates(){return buttonUpdates;},
    tick(time){window.track[0].time=time;now+=10;session.tick();},setNow(time){now=time;}};
}

test('DistroKid Web Audio starts via the selected button and sends paired holds from its actual clock',()=>{
  const h=setup();h.session.start(h.config);assert.equal(h.clicks,1);assert.equal(h.session.phase,'running');
  h.tick(.8);h.tick(1.12);h.tick(2);h.tick(2.8);
  assert.deepEqual(h.marks,[['down',.8],['up',1.12],['down',2],['up',2.8]]);
  assert.equal(h.session.phase,'done');assert.equal(h.timers.size,0);assert.equal(h.pressed,false);
  h.session.destroy();assert.equal(h.audio.playing,false);
  assert.ok([...h.audio.handlers.values()].every(set=>set.size===0));
});
test('the page clock does not advance on wall time when Web Audio has not advanced',()=>{
  const h=setup();h.session.start(h.config);h.setNow(5000);h.session.tick();assert.equal(h.marks.length,0);
  h.tick(.8);assert.deepEqual(h.marks,[['down',.8]]);
});
test('pausing and resuming uses the page player, updates its button, and does not repeat a partial hold',()=>{
  const h=setup();h.session.start(h.config);h.tick(.8);h.tick(1);h.session.pause();
  assert.equal(h.audio.playing,false);assert.equal(h.pressed,false);assert.equal(h.buttonUpdates,1);
  assert.equal(h.session.phase,'paused');h.session.resume();assert.equal(h.clicks,2);
  h.tick(2);h.tick(2.8);assert.deepEqual(h.marks,[['down',.8],['up',1],['down',2],['up',2.8]]);
  assert.equal(h.session.phase,'done');
});
test('even a short seek during a held lyric stops and releases instead of silently shifting timings',()=>{
  const h=setup();h.session.start(h.config);h.tick(.8);h.audio.seek(.84);h.tick(.84);
  assert.equal(h.session.phase,'ready');assert.equal(h.pressed,false);assert.equal(h.audio.playing,false);
  assert.deepEqual(h.marks.map(m=>m[0]),['down','up']);assert.match(h.changes.at(-1).message,/播放位置/);
});
test('seek while paused requires reset even if the final position is unchanged',()=>{
  const h=setup();h.session.start(h.config);h.tick(.3);h.session.pause();h.audio.seek(4);h.audio.seek(.3);h.session.resume();
  assert.equal(h.session.phase,'ready');assert.equal(h.clicks,1);assert.match(h.changes.at(-1).message,/播放位置已改变/);
});
test('replacing the buffer/player or removing the waveform releases a held input',()=>{
  for(const change of [h=>{h.audio.backend.buffer={};},h=>{h.window.track=[h.player()];},h=>{h.container.isConnected=false;}]){
    const h=setup();h.session.start(h.config);h.tick(.8);change(h);h.tick(.9);
    assert.equal(h.session.phase,'ready');assert.equal(h.pressed,false);assert.equal(h.timers.size,0);
    assert.deepEqual(h.marks.map(m=>m[0]),['down','up']);
  }
});
test('finish followed by DistroKid rewind never starts the lyrics over',()=>{
  const h=setup();h.session.start(h.config);h.tick(.8);h.audio.pause();h.audio.seek(0);h.audio.fire('finish');h.tick(0);
  assert.equal(h.session.phase,'ready');assert.equal(h.pressed,false);assert.deepEqual(h.marks.map(m=>m[0]),['down','up']);
});
test('missing, unloaded, or native-media players do not produce a fabricated clock',()=>{
  for(const change of [h=>{delete h.window.track;},h=>{h.audio.duration=0;},h=>{h.audio.backend.media={isConnected:true};}]){
    const h=setup();change(h);assert.equal(h.client.discover().length,0);
  }
  for(const url of [{hostname:'example.com'},{pathname:'/bank/'}])assert.equal(setup(url).client.discover().length,0);
});
test('reinjection is idempotent and exit releases player event listeners',()=>{
  const h=setup();const initial=h.client.discover()[0].element;
  vm.runInContext(source('page-clock-main.js'),h.main);
  assert.equal(h.client.discover()[0].element,initial);assert.equal(h.audio.handlers.get('seek').size,1);
  h.client.destroy();assert.equal(initial.isConnected,false);assert.ok([...h.audio.handlers.values()].every(set=>set.size===0));
});
test('a stale pause command cannot pause a replacement song',()=>{
  const h=setup();const old=h.client.discover()[0].element;h.audio.backend.buffer={};h.audio.play();old.pause();
  assert.equal(h.audio.playing,true);assert.equal(old.isConnected,false);
});
test('malformed responses are ignored, and a missing bridge stops instead of extrapolating',()=>{
  const h=setup();h.session.start(h.config);h.tick(.8);delete h.window.track;h.session.tick();
  assert.equal(h.pressed,false);assert.equal(h.session.phase,'ready');
  h.document.addEventListener('lyricpilot:clock-request-v1',event=>{
    const {requestId}=JSON.parse(event.detail);
    h.document.dispatchEvent(new CustomEvent('lyricpilot:clock-response-v1',{detail:JSON.stringify({requestId,clock:{id:'1',time:'1'}})}));
  });assert.equal(h.client.discover().length,0);
});

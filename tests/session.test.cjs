'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const C=require('../extension/core.js'),M=require('../extension/media-binding.js');
function setup(options={}) {
  const win=new EventTarget(),doc=new EventTarget();doc.defaultView=win;doc.hidden=false;
  let now=0,clicks=0,pressed=false,controllerDestroyed=0;
  const audio={isConnected:true,paused:true,seeking:false,ended:false,playbackRate:1,currentTime:0,currentSrc:'track.wav',readyState:4,pause(){this.paused=true;}};
  const marks=[],changes=[],timers=new Map();let timerID=0;
  const play={document:doc},mark={document:doc};
  const A={checkTarget(target){if(target.invalid){const error=new Error('请重新选择');error.code='target-unavailable';throw error;}return target;},discoverMedia:()=>[{element:audio,document:doc}],chooseKeyboardTarget:()=>doc,
    performClick(target){A.checkTarget(target);if(target===play){clicks++;if(options.resetOnPlay)audio.currentTime=0;if(!options.neverPlay)audio.paused=false;}else marks.push(['click',audio.currentTime]);},
    createKeyController(){return {press(){pressed=true;marks.push(['down',audio.currentTime]);},release(){if(pressed){pressed=false;marks.push(['up',audio.currentTime]);}},destroy(){this.release();controllerDestroyed++;},get isPressed(){return pressed;}};}
  };
  A.createButtonController=A.createKeyController;
  const context={LyricPilotCore:C,LyricPilotActions:A,LyricPilotMediaBinding:M,document:doc,window:win,performance:{now:()=>now},
    setInterval(fn){timers.set(++timerID,fn);return timerID;},clearInterval(id){timers.delete(id);},requestAnimationFrame(fn){timers.set(++timerID,fn);return timerID;},cancelAnimationFrame(id){timers.delete(id);}};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../extension/session.js'),'utf8'),context);
  const session=new context.LyricPilotSession(change=>changes.push(change));
  const config={cues:[{start:1,end:2.4,text:'一'},{start:3,end:4.5,text:'二'}],offset:0,kind:'space',duration:'hold',playTarget:play,target:mark};
  return {session,config,audio,doc,marks,changes,timers,play,mark,get clicks(){return clicks;},get pressed(){return pressed;},get destroyed(){return controllerDestroyed;},tick(time){audio.currentTime=time;now=time*1000;session.tick();},setNow(value){now=value;}};
}
test('session starts through the page button and continues without replaying markers',()=>{
  const h=setup();h.config.duration='tap';h.session.start(h.config);assert.equal(h.clicks,1);
  h.tick(1);h.tick(1.7);h.session.pause();assert.equal(h.audio.paused,true);assert.equal(h.timers.size,0);
  h.session.resume();assert.equal(h.clicks,2);h.tick(3);
  assert.equal(h.session.phase,'done');assert.deepEqual(h.marks,[['down',1],['up',1],['down',3],['up',3]]);assert.equal(h.timers.size,0);
});
test('pause while holding releases once and displays that the current line ended early',()=>{
  const h=setup();h.session.start(h.config);h.tick(1);h.tick(1.5);h.session.pause();
  assert.equal(h.pressed,false);assert.match(h.changes.at(-1).message,/当前句已提前松开/);
  h.session.resume();h.tick(2.4);h.tick(3);h.tick(4.5);
  assert.deepEqual(h.marks,[['down',1],['up',1.5],['down',3],['up',4.5]]);
  assert.equal(h.session.phase,'done');
});
test('a page button that resets on resume cannot duplicate earlier marks',()=>{
  const h=setup({resetOnPlay:true});h.config.duration='tap';h.session.start(h.config);h.tick(1);h.tick(1.8);h.session.pause();h.session.resume();
  assert.equal(h.session.phase,'ready');assert.equal(h.audio.paused,true);assert.match(h.changes.at(-1).message,/重置了进度/);assert.equal(h.marks.length,2);
});
test('changing audio or seeking during a pause requires a restart',()=>{
  for(const change of [{currentTime:2.8},{currentSrc:'other.wav'}]){
    const h=setup();h.session.start(h.config);h.tick(.5);h.session.pause();Object.assign(h.audio,change);h.session.resume();
    assert.equal(h.session.phase,'ready');assert.equal(h.clicks,1);assert.equal(h.marks.length,0);
  }
});
test('closing or hiding the page always releases a held input and removes ticking',()=>{
  for(const stop of [h=>h.session.destroy(),h=>{h.doc.hidden=true;h.doc.dispatchEvent(new Event('visibilitychange'));}]){
    const h=setup();h.session.start(h.config);h.tick(1);stop(h);assert.equal(h.pressed,false);assert.equal(h.timers.size,0);assert.deepEqual(h.marks.map(m=>m[0]),['down','up']);
  }
});
test('waiting for a nonfunctional play button times out without marking',()=>{
  const h=setup({neverPlay:true});h.session.start(h.config);h.setNow(10001);h.session.tick();assert.equal(h.session.phase,'ready');assert.equal(h.marks.length,0);assert.match(h.changes.at(-1).message,/未检测到音频/);assert.equal(h.timers.size,0);
});

test('a missing play or marker target reports its row before any playback starts',()=>{
  for(const which of ['play','mark']) {
    const h=setup();h.config.kind='button';h[which].invalid=true;h.session.start(h.config);
    assert.equal(h.clicks,0);assert.equal(h.marks.length,0);assert.equal(h.session.phase,'ready');
    assert.equal(h.changes.at(-1).targetError,which);assert.equal(h.changes.at(-2).message,'');
  }
});
test('a removed marker during playback reports only the marker row and stops audio',()=>{
  const h=setup();h.config.kind='button';h.config.duration='tap';h.session.start(h.config);h.mark.invalid=true;h.tick(1);
  assert.equal(h.session.phase,'ready');assert.equal(h.audio.paused,true);assert.equal(h.marks.length,0);
  assert.equal(h.changes.at(-1).targetError,'mark');assert.equal(h.changes.at(-2).message,'');
});
test('a play button removed during pause reports the play row on resume',()=>{
  const h=setup();h.session.start(h.config);h.tick(.5);h.session.pause();h.play.invalid=true;h.session.resume();
  assert.equal(h.clicks,1);assert.equal(h.changes.at(-1).targetError,'play');assert.equal(h.session.phase,'ready');
});

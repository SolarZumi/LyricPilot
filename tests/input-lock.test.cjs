'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
function fixture(){
  const points=[],shield={hidden:true};const host={},listeners=new Map(),attrs=new Map(),body={getAttribute:n=>attrs.get(n)??null,setAttribute:(n,v)=>attrs.set(n,v),removeAttribute:n=>attrs.delete(n)};
  const target={addEventListener(type,fn){if(!listeners.has(type))listeners.set(type,new Set());listeners.get(type).add(fn);},removeEventListener(type,fn){listeners.get(type)?.delete(fn);}};
  const controls=[0,1].map(()=>({closest:()=>null,getClientRects:()=>[{}],focus(){shadow.activeElement=this;}}));
  const shadow={activeElement:controls[0],querySelector:()=>shield,querySelectorAll:()=>controls},doc={nodeType:9,body,defaultView:target};let escapes=0;
  const context={getComputedStyle:()=>({visibility:'visible'})};vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../extension/input-lock.js'),'utf8'),context);
  const lock=context.LyricPilotInputLock(host,shadow,()=>escapes++,point=>points.push(point));lock.watch(doc);
  function send(type,{trusted=true,inside=false,onShield=false,key='',shiftKey=false}={}){const result={blocked:0,prevented:0};const e={type,isTrusted:trusted,key,shiftKey,clientX:100,clientY:150,composedPath:()=>onShield?[shield,host]:inside?[host]:[body],stopImmediatePropagation(){result.blocked++;},preventDefault(){result.prevented++;}};for(const fn of listeners.get(type)||[])fn(e);return result;}
  return {lock,send,attrs,listeners,shadow,controls,shield,points,get escapes(){return escapes;}};
}
test('page lock blocks physical page input while allowing synthetic timing events and panel controls',()=>{
  const h=fixture();h.lock.set(true);
  for(const type of ['click','pointerdown','mousedown','keydown','keyup','wheel','touchmove']){
    assert.equal(h.send(type).blocked,1);
    assert.equal(h.send(type,{trusted:false}).blocked,0);
    assert.equal(h.send(type,{inside:true}).blocked,0);
  }
  assert.equal(h.attrs.has('aria-hidden'),false);assert.equal(h.shield.hidden,false);h.lock.set(false);assert.equal(h.shield.hidden,true);
  assert.equal(h.send('click').blocked,0);assert.equal(h.attrs.has('aria-hidden'),false);
});
test('Tab stays in panel controls, Escape pauses once, destroy restores existing page accessibility',()=>{
  const h=fixture();h.attrs.set('aria-hidden','false');h.lock.set(true);
  h.send('keydown',{key:'Tab'});assert.equal(h.shadow.activeElement,h.controls[1]);
  h.send('keydown',{key:'Tab'});assert.equal(h.shadow.activeElement,h.controls[0]);
  h.send('keydown',{key:'Escape',inside:true});assert.equal(h.escapes,1);
  h.lock.destroy();assert.equal(h.shield.hidden,true);assert.equal(h.attrs.get('aria-hidden'),'false');assert.ok([...h.listeners.values()].every(v=>v.size===0));
});

test('pointer feedback appears only over the locked page and adds a message on blocked clicks',()=>{
  const h=fixture();h.lock.set(true);h.send('pointermove');assert.equal(h.points.at(-1).visible,true);assert.equal(h.points.at(-1).x,100);
  h.send('pointerdown');assert.equal(h.points.at(-1).blocked,true);
  h.send('pointermove',{inside:true});assert.equal(h.points.at(-1).visible,false);
  h.lock.set(false);assert.equal(h.shield.hidden,true);assert.equal(h.points.at(-1).visible,false);
});

test('shield events are blocked even though their composed path includes the extension host',()=>{
  const h=fixture();h.lock.set(true);
  for(const type of ['pointerover','pointerenter','pointermove','pointerrawupdate','pointerout','pointerleave','mouseover','mouseenter','mousemove','mouseout','mouseleave','click','auxclick','contextmenu','dragover','selectstart']){
    assert.equal(h.send(type,{onShield:true}).blocked,1,type);
    assert.equal(h.send(type,{trusted:false}).blocked,0,'synthetic '+type);
    assert.equal(h.send(type,{inside:true}).blocked,0,'panel '+type);
  }
  h.send('pointermove',{onShield:true});assert.equal(h.points.at(-1).visible,true);
  h.lock.set(false);assert.equal(h.send('pointermove',{onShield:true}).blocked,0);
  h.lock.set(true);assert.equal(h.shield.hidden,false);
  h.lock.destroy();assert.equal(h.shield.hidden,true);
});

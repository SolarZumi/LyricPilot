'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const {create,constrain} = require('../extension/panel-position.js');

function fixture() {
  function events(object = {}) {
    const listeners = new Map();
    return Object.assign(object, {listeners,
      addEventListener:(type,fn) => listeners.set(type,fn),
      removeEventListener:type => listeners.delete(type),
      emit(type,properties = {}) { const e = {preventDefault(){},stopPropagation(){},...properties}; listeners.get(type)?.(e); }
    });
  }
  let mini = false, changes = 0, observed = true;
  const view = events({innerWidth:1200,innerHeight:900,ResizeObserver:class {observe(){} disconnect(){observed=false;}}});
  const classes = new Set();
  const shell = {ownerDocument:{defaultView:view},offsetHeight:664,style:{},
    getBoundingClientRect:() => ({width:376}),classList:{add:c=>classes.add(c),remove:c=>classes.delete(c)}};
  const panel = {getBoundingClientRect:() => ({right:parseFloat(shell.style.left)+376,top:parseFloat(shell.style.top)})};
  const handle = events({capture:null,setPointerCapture(id){this.capture=id;},hasPointerCapture(id){return this.capture===id;},releasePointerCapture(){this.capture=null;}});
  const controller = create({shell,panel,handle,isMini:()=>mini,onChange:()=>changes++});
  return {controller,view,shell,handle,classes,get changes(){return changes;},get observed(){return observed;},
    mini(value){mini=value;controller.layout();},point(){return {x:parseFloat(shell.style.left)+376,y:parseFloat(shell.style.top)};}};
}

test('compact and expanded bounds keep every panel edge within the viewport',()=>{
  const viewport={width:1200,height:800};
  assert.deepEqual(constrain({x:-80,y:990},{width:376,height:664},viewport),{x:388,y:124});
  assert.deepEqual(constrain({x:1800,y:-90},{width:232,height:64},viewport),{x:1188,y:12});
  assert.deepEqual(constrain({x:0,y:0},{width:300,height:280},{width:320,height:300}),{x:310,y:10});
});
test('drag keeps pointer capture, persists on release, and ignores other pointers',()=>{
  const h=fixture();h.handle.emit('pointerdown',{button:0,pointerId:7,clientX:1000,clientY:40});
  h.handle.emit('pointermove',{pointerId:8,clientX:10,clientY:90});assert.deepEqual(h.point(),{x:1180,y:20});
  h.handle.emit('pointermove',{pointerId:7,clientX:550,clientY:150});assert.deepEqual(h.point(),{x:730,y:130});
  assert.equal(h.changes,0);assert.equal(h.handle.capture,7);
  h.handle.emit('pointerup',{pointerId:7});assert.equal(h.changes,1);assert.equal(h.handle.capture,null);assert.equal(h.classes.size,0);
  assert.deepEqual(h.controller.save(),{x:730,y:130});h.controller.destroy();
});
test('expand clamps the saved compact position, collapse returns to it',()=>{
  const h=fixture();h.mini(true);h.controller.restore({x:244,y:800});
  assert.deepEqual(h.point(),{x:244,y:800});h.mini(false);assert.deepEqual(h.point(),{x:388,y:224});
  h.mini(true);assert.deepEqual(h.point(),{x:244,y:800});h.controller.destroy();
});
test('resize keeps controls on screen without overwriting the preferred position',()=>{
  const h=fixture();h.controller.restore({x:1100,y:180});h.view.innerWidth=800;h.view.innerHeight=750;h.view.emit('resize');
  assert.deepEqual(h.point(),{x:788,y:74});h.view.innerWidth=1200;h.view.innerHeight=900;h.view.emit('resize');
  assert.deepEqual(h.point(),{x:1100,y:180});h.controller.destroy();
});
test('keyboard movement persists and late storage cannot replace a user move',()=>{
  const h=fixture();h.handle.emit('keydown',{key:'ArrowLeft'});h.handle.emit('keydown',{key:'ArrowDown',shiftKey:true});
  assert.deepEqual(h.point(),{x:1170,y:21});h.controller.restore({x:400,y:100});assert.deepEqual(h.point(),{x:1170,y:21});
  h.handle.emit('keydown',{key:'Enter'});assert.equal(h.changes,2);h.controller.destroy();
});
test('cancel and window blur finish a drag and cleanup removes listeners',()=>{
  const h=fixture();h.handle.emit('pointerdown',{button:2,pointerId:1,clientX:0,clientY:0});assert.equal(h.handle.capture,null);
  for(const end of ['pointercancel','blur']) {
    h.handle.emit('pointerdown',{button:0,pointerId:1,clientX:1000,clientY:40});
    h.handle.emit('pointermove',{pointerId:1,clientX:900,clientY:50});
    (end==='blur'?h.view:h.handle).emit(end,{pointerId:1});
    assert.equal(h.handle.capture,null);assert.equal(h.classes.size,0);
  }
  assert.equal(h.changes,2);h.controller.destroy();assert.equal(h.observed,false);assert.equal(h.handle.listeners.size,0);assert.equal(h.view.listeners.size,0);
});

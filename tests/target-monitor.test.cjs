'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const createMonitor=require('../extension/target-monitor.js');

function fixture() {
  const observers=new Set(),timeouts=new Map(),intervals=new Map(),events=new Map();
  let next=1;
  function eventTarget(target={}) {
    target.addEventListener=(type,fn)=>{if(!events.has(target))events.set(target,new Map());events.get(target).set(type,fn);};
    target.removeEventListener=type=>events.get(target)?.delete(type);
    return target;
  }
  const view=eventTarget({getComputedStyle:el=>el.style||{},
    setTimeout:fn=>{const id=next++;timeouts.set(id,fn);return id;},clearTimeout:id=>timeouts.delete(id),
    setInterval:fn=>{const id=next++;intervals.set(id,fn);return id;},clearInterval:id=>intervals.delete(id),
    MutationObserver:class {
      constructor(callback){this.callback=callback;}
      observe(root){this.root=root;observers.add(this);}
      disconnect(){observers.delete(this);}
    }
  });
  const doc=eventTarget({nodeType:9,defaultView:view});
  const node=(parent=null,owner=doc,scope=owner)=>({nodeType:1,isConnected:true,parentElement:parent,ownerDocument:owner,getRootNode:()=>scope,style:{display:'block',visibility:'visible'}});
  const targets={play:node(),mark:node()},lost=[];
  const host={contains:()=>false};
  const monitor=createMonitor({document:doc,excludeRoot:host,getTargets:()=>targets,onInvalid:names=>{
    lost.push(names);for(const name of names)targets[name]=null;
  }});
  const flush=()=>{const tasks=[...timeouts.values()];timeouts.clear();tasks.forEach(fn=>fn());};
  const mutate=(target=doc)=>{for(const observer of [...observers])observer.callback([{target}]);};
  monitor.refresh();
  return {doc,view,node,targets,lost,host,monitor,observers,timeouts,intervals,events,eventTarget,flush,mutate};
}

test('both lost selections are reported together after DOM changes, without starting playback',()=>{
  const h=fixture();h.targets.play.isConnected=false;h.targets.mark.isConnected=false;
  h.mutate();h.mutate();assert.equal(h.timeouts.size,1);h.flush();
  assert.deepEqual(h.lost,[['play','mark']]);assert.equal(h.intervals.size,0);assert.equal(h.observers.size,0);
});
test('normal updates and a temporary disabled button preserve selections; extension updates do not schedule checks',()=>{
  const h=fixture();h.mutate(h.host);assert.equal(h.timeouts.size,0);
  h.targets.play.disabled=true;h.mutate();h.flush();assert.equal(h.lost.length,0);
  assert.equal(h.observers.size,1);h.monitor.destroy();
});
test('hidden ancestors invalidate only their selected control and retain the other selection',()=>{
  const h=fixture(),parent=h.node();h.targets.mark.parentElement=parent;parent.style.display='none';
  h.mutate();h.flush();assert.deepEqual(h.lost,[['mark']]);assert.ok(h.targets.play);
  h.monitor.destroy();
});
test('a visible child that overrides ancestor visibility is still a valid selection',()=>{
  const h=fixture(),parent=h.node();parent.style.visibility='hidden';h.targets.mark.parentElement=parent;
  h.mutate();h.flush();assert.equal(h.lost.length,0);h.monitor.destroy();
});
test('resolves the final DOM state after a re-render, but reports a locator that can no longer resolve',()=>{
  const h=fixture();let current=h.node();h.targets.mark={resolve:()=>{if(!current)throw new Error('missing');return current;}};
  h.monitor.refresh();current=null;h.mutate();current=h.node();h.flush();assert.equal(h.lost.length,0);
  current=null;h.mutate();h.flush();assert.deepEqual(h.lost,[['mark']]);h.monitor.destroy();
});
test('observes shadow roots and iframe documents, including the frame disappearing',()=>{
  const h=fixture(),frame=h.node(),frameView={...h.view,frameElement:frame};
  const frameDoc=h.eventTarget({nodeType:9,defaultView:frameView});
  const shadowHost=h.node(null,frameDoc),shadow=h.eventTarget({nodeType:11,ownerDocument:frameDoc,host:shadowHost});
  h.targets.mark=h.node(null,frameDoc,shadow);h.monitor.refresh();
  assert.deepEqual(new Set([...h.observers].map(o=>o.root)),new Set([h.doc,frameDoc,shadow]));
  frame.isConnected=false;h.mutate();h.flush();assert.deepEqual(h.lost,[['mark']]);h.monitor.destroy();
});
test('fallback checks detect style changes without mutation events, and never shift to a different target',()=>{
  const h=fixture();h.targets.play.style.visibility='hidden';
  for(const fn of [...h.intervals.values()])fn();
  assert.deepEqual(h.lost,[['play']]);assert.equal(h.targets.play,null);h.monitor.destroy();
});
test('closing suspends monitoring; reopening catches stale selections and destroy removes every listener',()=>{
  const h=fixture();h.monitor.setEnabled(false);h.targets.play.isConnected=false;
  assert.equal(h.timeouts.size,0);assert.equal(h.intervals.size,0);assert.equal(h.observers.size,0);
  h.monitor.setEnabled(true);assert.deepEqual(h.lost,[['play']]);
  h.mutate();h.monitor.destroy();h.flush();
  assert.equal(h.timeouts.size,0);assert.equal(h.intervals.size,0);assert.equal(h.observers.size,0);
  assert.ok([...h.events.values()].every(entries=>entries.size===0));
});

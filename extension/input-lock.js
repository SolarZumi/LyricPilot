(() => {
  'use strict';
  // A transparent hit target keeps page elements out of :hover and native tooltips.
  // Capture listeners also stop physical events; synthetic lyric marks still pass.
  globalThis.LyricPilotInputLock = function(host, shadow, escape, onPointer = () => {}) {
    let active = false;
    const documents = new Map();
    const shield = shadow.querySelector('.page-input-shield');
    function block(event) { event.preventDefault(); event.stopImmediatePropagation(); }
    function internal(event) {
      const path = event.composedPath();
      return path.includes(host) && !path.includes(shield);
    }
    function controls() {
      return [...shadow.querySelectorAll('button:not(:disabled),input:not(:disabled)')].filter(el =>
        !el.closest('[inert]') && el.getClientRects().length && getComputedStyle(el).visibility === 'visible');
    }
    function key(event) {
      if (!active || !event.isTrusted) return;
      if (event.key === 'Escape') { block(event); escape(); return; }
      if (event.key === 'Tab') {
        block(event); const items = controls(); if (!items.length) return;
        const index = items.indexOf(shadow.activeElement), step = event.shiftKey ? -1 : 1;
        items[(index+step+items.length)%items.length].focus({preventScroll:true}); return;
      }
      if (!internal(event)) block(event);
    }
    function pointer(event, blocked = false) {
      if (!event.isTrusted) return;
      if (!active || internal(event) || event.pointerType === 'touch') { onPointer({visible:false}); return; }
      if (!Number.isFinite(event.clientX) || !Number.isFinite(event.clientY)) return;
      let x = event.clientX, y = event.clientY, view = event.view;
      try {
        while (view?.frameElement) {
          const frame = view.frameElement, rect = frame.getBoundingClientRect();
          x += rect.left + frame.clientLeft; y += rect.top + frame.clientTop; view = frame.ownerDocument.defaultView;
        }
      } catch (_) { onPointer({visible:false}); return; }
      onPointer({visible:true,x,y,blocked});
    }
    function input(event) {
      if (!active || !event.isTrusted) return;
      if (internal(event)) { onPointer({visible:false}); return; }
      block(event);
      if (['pointerout','pointerleave','mouseout','mouseleave'].includes(event.type) && !event.relatedTarget) {
        onPointer({visible:false});
      } else if (event.type.startsWith('pointer') || event.type.startsWith('mouse') || event.type === 'click') {
        pointer(event,['pointerdown','mousedown','click'].includes(event.type));
      }
    }
    function focus(event) { if (active && event.isTrusted && !internal(event)) controls()[0]?.focus({preventScroll:true}); }
    const types = [
      'pointerdown','pointerup','pointercancel','pointermove','pointerrawupdate','pointerover','pointerout','pointerenter','pointerleave',
      'mousedown','mouseup','mousemove','mouseover','mouseout','mouseenter','mouseleave',
      'click','auxclick','dblclick','contextmenu','wheel','selectstart',
      'touchstart','touchmove','touchend','touchcancel','dragstart','drag','dragenter','dragover','dragleave','dragend','drop'
    ];
    function watch(doc) {
      if (documents.has(doc)) return;
      const target = doc.defaultView || doc; documents.set(doc,{target});
      types.forEach(type=>target.addEventListener(type,input,{capture:true,passive:false}));
      target.addEventListener('keydown',key,true); target.addEventListener('keyup',input,true); target.addEventListener('focusin',focus,true);
    }
    return {watch, set(value) {
      if (active === value) return;
      active = value;
      // Immediate hit-testing change: no transition can leak clicks during pause/close.
      shield.hidden = !active;
      if (!active) onPointer({visible:false});
    },destroy() {
      active = false;shield.hidden = true;onPointer({visible:false});
      documents.forEach(({target})=>{
        types.forEach(type=>target.removeEventListener(type,input,true));
        target.removeEventListener('keydown',key,true);target.removeEventListener('keyup',input,true);target.removeEventListener('focusin',focus,true);
      });documents.clear();
    }};
  };
})();

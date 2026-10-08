(() => {
  'use strict';
  function constrain(point, size, viewport) {
    const gapX = Math.min(12, Math.max(0, (viewport.width - size.width) / 2));
    const gapY = Math.min(12, Math.max(0, (viewport.height - size.height) / 2));
    return {
      x: Math.max(size.width + gapX, Math.min(viewport.width - gapX, point.x)),
      y: Math.max(gapY, Math.min(viewport.height - size.height - gapY, point.y))
    };
  }
  function create({shell, panel, handle, isMini, onChange = () => {}}) {
    const view = shell.ownerDocument.defaultView;
    let preferred = null, drag = null, touched = false;
    function layout() {
      const width = shell.getBoundingClientRect().width;
      const size = {width: isMini() ? Math.min(232, width) : width, height: isMini() ? 64 : shell.offsetHeight};
      const point = constrain(preferred || {x:view.innerWidth - 20,y:20}, size, {width:view.innerWidth,height:view.innerHeight});
      shell.style.left = `${point.x - width}px`;
      shell.style.right = 'auto';
      shell.style.top = `${point.y}px`;
      return point;
    }
    function commit() { preferred = layout(); touched = true; onChange(); }
    function finish() {
      if (!drag) return;
      const id = drag.id, moved = drag.moved;
      drag = null;
      if (handle.hasPointerCapture(id)) handle.releasePointerCapture(id);
      shell.classList.remove('is-dragging');
      if (moved) commit();
    }
    function down(event) {
      if (event.button !== 0 || event.isPrimary === false || drag) return;
      event.preventDefault();
      const rect = panel.getBoundingClientRect();
      drag = {id:event.pointerId,x:event.clientX,y:event.clientY,right:rect.right,top:rect.top,moved:false};
      shell.classList.add('is-dragging');
      preferred = {x:rect.right,y:rect.top};
      layout();
      handle.setPointerCapture(event.pointerId);
    }
    function move(event) {
      if (!drag || event.pointerId !== drag.id) return;
      event.preventDefault();
      const dx = event.clientX - drag.x, dy = event.clientY - drag.y;
      if (!drag.moved && Math.hypot(dx,dy) < 3) return;
      drag.moved = true;
      preferred = {x:drag.right + dx,y:drag.top + dy};
      layout();
    }
    function up(event) { if (drag?.id === event.pointerId) finish(); }
    function key(event) {
      const delta = {ArrowLeft:[-1,0],ArrowRight:[1,0],ArrowUp:[0,-1],ArrowDown:[0,1]}[event.key];
      if (!delta) return;
      event.preventDefault(); event.stopPropagation();
      const current = layout(), step = event.shiftKey ? 1 : 10;
      preferred = {x:current.x + delta[0] * step,y:current.y + delta[1] * step};
      commit();
    }
    handle.addEventListener('pointerdown',down);
    handle.addEventListener('pointermove',move);
    handle.addEventListener('pointerup',up);
    handle.addEventListener('pointercancel',up);
    handle.addEventListener('lostpointercapture',finish);
    handle.addEventListener('keydown',key);
    view.addEventListener('blur',finish);
    view.addEventListener('resize',layout);
    const observer = new view.ResizeObserver(layout); observer.observe(shell);
    layout();
    return {layout,finish,
      save:() => preferred ? {...preferred} : null,
      restore(point) {
        // A late storage response must not move a panel the user has already dragged.
        if (touched || drag || !Number.isFinite(point?.x) || !Number.isFinite(point?.y)) return;
        preferred = {x:point.x,y:point.y}; layout();
      },
      destroy() {
        finish(); observer.disconnect();
        handle.removeEventListener('pointerdown',down);
        handle.removeEventListener('pointermove',move);
        handle.removeEventListener('pointerup',up);
        handle.removeEventListener('pointercancel',up);
        handle.removeEventListener('lostpointercapture',finish);
        handle.removeEventListener('keydown',key);
        view.removeEventListener('blur',finish);
        view.removeEventListener('resize',layout);
      }
    };
  }
  globalThis.LyricPilotPanelPosition = create;
  if (typeof module !== 'undefined' && module.exports) module.exports = {create,constrain};
})();

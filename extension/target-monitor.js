(function(root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory;
  else root.LyricPilotTargetMonitor = factory;
})(typeof globalThis !== 'undefined' ? globalThis : this, function(options) {
  'use strict';
  const doc = options.document, view = doc.defaultView;
  const roots = new Map();
  let enabled = true, destroyed = false, checking = false, pending = null, interval = null;

  // Inspect the selected element, its shadow hosts, and containing frames.
  // Temporary disabled states are not a lost selection; action-time checks handle them.
  function inspect(element, scopes) {
    if (!element || element.nodeType !== 1 || !element.isConnected) throw new Error('missing');
    let node = element, checkVisibility = true;
    while (node) {
      if (!node.isConnected) throw new Error('detached');
      const owner = node.ownerDocument, scope = node.getRootNode();
      scopes.add(scope);
      const style = owner.defaultView?.getComputedStyle?.(node);
      if (style?.display === 'none' || (checkVisibility && ['hidden','collapse'].includes(style?.visibility))) throw new Error('hidden');
      // A child may override an ancestor's visibility, but cannot override display:none.
      if (node.parentElement) { node = node.parentElement; checkVisibility = false; }
      else if (scope.host) { node = scope.host; checkVisibility = false; }
      else { node = owner.defaultView?.frameElement || null; checkVisibility = true; }
    }
  }
  function schedule() {
    // Coalesce one DOM update without postponing indefinitely on a live progress clock.
    if (!enabled || destroyed || pending !== null) return;
    pending = view.setTimeout(() => { pending = null; check(); },60);
  }
  function changed(records) {
    if (records.some(record => record.target !== options.excludeRoot && !options.excludeRoot?.contains(record.target))) schedule();
  }
  function syncScopes(scopes) {
    roots.forEach((cleanup, root) => {
      if (!scopes.has(root)) { cleanup(); roots.delete(root); }
    });
    for (const scope of scopes) {
      if (roots.has(scope)) continue;
      const owner = scope.nodeType === 9 ? scope : scope.ownerDocument;
      const Observer = owner.defaultView?.MutationObserver;
      const observer = Observer ? new Observer(changed) : null;
      observer?.observe(scope,{childList:true,subtree:true,attributes:true,characterData:true});
      for (const type of ['load','transitionend','animationend']) scope.addEventListener(type,schedule,true);
      const window = scope.nodeType === 9 ? scope.defaultView : null;
      window?.addEventListener('resize',schedule);
      roots.set(scope,() => {
        observer?.disconnect();
        for (const type of ['load','transitionend','animationend']) scope.removeEventListener(type,schedule,true);
        window?.removeEventListener('resize',schedule);
      });
    }
  }
  function cancelTimers() {
    if (pending !== null) view.clearTimeout(pending);
    if (interval !== null) view.clearInterval(interval);
    pending = interval = null;
  }
  function check() {
    if (!enabled || destroyed || checking) return;
    checking = true;
    try {
      const invalid = [], scopes = new Set([doc]);
      for (const [name, target] of Object.entries(options.getTargets())) {
        if (!target) continue;
        try { inspect(typeof target.resolve === 'function' ? target.resolve() : target,scopes); }
        catch (_) { invalid.push(name); }
      }
      // Report both missing controls together, without a click or focus change.
      if (invalid.length) options.onInvalid(invalid);
      if (!enabled || destroyed) return;
      const selected = Object.values(options.getTargets()).some(Boolean);
      syncScopes(selected ? scopes : new Set());
      if (selected && interval === null) interval = view.setInterval(check,500);
      if (!selected) cancelTimers();
    } finally { checking = false; }
  }
  function refresh() {
    if (pending !== null) view.clearTimeout(pending);
    pending = null; check();
  }
  return {
    refresh,
    setEnabled(value) {
      if (enabled === value || destroyed) return;
      enabled = value;
      if (enabled) refresh();
      else { cancelTimers(); syncScopes(new Set()); }
    },
    destroy() { destroyed = true; enabled = false; cancelTimers(); syncScopes(new Set()); }
  };
});

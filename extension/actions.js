(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.LyricPilotActions = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function getDocument(doc) {
    var result = doc || (typeof document !== 'undefined' ? document : null);
    if (!result || result.nodeType !== 9) throw new Error('无法访问网页文档。');
    return result;
  }

  function sameOriginDocument(frame) {
    try {
      var doc = frame.contentDocument;
      // Accessing contentDocument returns null or throws for a cross-origin frame.
      return doc && doc.documentElement ? doc : null;
    } catch (_) { return null; }
  }

  function walkRoots(doc, visit) {
    var seen = new Set();
    function walk(scope) {
      if (!scope || seen.has(scope)) return;
      seen.add(scope);
      visit(scope);
      Array.from(scope.querySelectorAll('*')).forEach(function (element) {
        if (element.shadowRoot && element.shadowRoot.mode === 'open') walk(element.shadowRoot);
        if (/^(iframe|frame)$/i.test(element.localName)) walk(sameOriginDocument(element));
      });
    }
    walk(doc);
  }

  function shortText(text) {
    return String(text || '').replace(/\s+/g, ' ').trim().slice(0, 160);
  }

  function discoverMedia(doc) {
    doc = getDocument(doc);
    var media = [];
    walkRoots(doc, function (scope) {
      Array.from(scope.querySelectorAll('audio, video')).forEach(function (element) {
        var source = element.currentSrc || element.getAttribute('src') || '';
        var filename = source.split('/').pop().split('?')[0];
        try { filename = decodeURIComponent(filename); } catch (_) {}
        var label = element.getAttribute('aria-label') || element.getAttribute('title') ||
          (source.startsWith('blob:') ? '网页音频流' : filename) || '未命名媒体';
        var type = element.localName === 'video' ? '视频' : '音频';
        media.push({ element: element, label: type + ' ' + (media.length + 1) + '，' + shortText(label), document: element.ownerDocument });
      });
    });
    return media;
  }

  function cssEscape(value) {
    // CSS.escape is not needed for attribute strings; escaping strings also handles
    // arbitrary Unicode IDs without depending on the parent window's CSS object.
    return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\n\r\f]/g, function (c) {
      return '\\' + c.charCodeAt(0).toString(16) + ' ';
    });
  }

  function unique(scope, selector, original) {
    try {
      var found = scope.querySelectorAll(selector);
      return found.length === 1 && found[0] === original;
    } catch (_) { return false; }
  }

  function selectorFor(element, scope) {
    var tag = element.localName;
    var candidates = [];
    ['id', 'data-testid', 'data-test', 'data-test-id', 'data-qa', 'aria-label', 'name', 'title'].forEach(function (attribute) {
      var value = element.getAttribute(attribute);
      if (value) candidates.push({
        selector: tag + '[' + attribute + '="' + cssEscape(value) + '"]',
        stableIdentity: /^(id|data-testid|data-test|data-test-id|data-qa)$/.test(attribute)
      });
    });
    if (element.getAttribute('role')) candidates.push({ selector: tag + '[role="' + cssEscape(element.getAttribute('role')) + '"]', stableIdentity: false });
    candidates.push({ selector: tag, stableIdentity: false });
    for (var i = 0; i < candidates.length; i += 1) {
      if (unique(scope, candidates[i].selector, element)) return candidates[i];
    }
    var parts = [];
    var node = element;
    while (node && node.nodeType === 1) {
      var part = node.localName;
      if (node.id) part += '[id="' + cssEscape(node.id) + '"]';
      else {
        var position = 1;
        var sibling = node.previousElementSibling;
        while (sibling) {
          if (sibling.localName === node.localName) position += 1;
          sibling = sibling.previousElementSibling;
        }
        part += ':nth-of-type(' + position + ')';
      }
      parts.unshift(part);
      var selector = parts.join(' > ');
      if (unique(scope, selector, element)) return { selector: selector, stableIdentity: false };
      node = node.parentElement;
    }
    throw new Error('无法唯一定位这个元素，请选择它的按钮或容器。');
  }

  function fingerprint(element) {
    var keys = ['id', 'data-testid', 'data-test', 'data-test-id', 'data-qa', 'aria-label', 'name', 'title', 'role', 'type'];
    return JSON.stringify([element.localName, keys.map(function (key) { return element.getAttribute(key); }), shortText(element.textContent)]);
  }

  function descriptor(element) {
    var selection = selectorFor(element, element.getRootNode());
    return { selector: selection.selector, stableIdentity: selection.stableIdentity, original: element, fingerprint: fingerprint(element) };
  }

  function selectionError(reason) {
    var error = new Error('请重新选择'); error.code = 'target-unavailable'; error.reason = reason; return error;
  }

  function resolveOne(scope, part) {
    var found = scope.querySelectorAll(part.selector);
    if (!found.length) throw selectionError('missing');
    if (found.length !== 1) throw selectionError('ambiguous');
    var element = found[0];
    if (element !== part.original && !part.stableIdentity) {
      throw selectionError('unstable-identity');
    }
    if (element !== part.original && fingerprint(element) !== part.fingerprint) {
      throw selectionError('changed-identity');
    }
    return element;
  }

  function makeLocator(element) {
    if (!element || element.nodeType !== 1 || !element.isConnected) throw new Error('请选取网页上仍然存在的元素。');
    var leaf = descriptor(element);
    var scope = element.getRootNode();
    var chain = [];
    while (scope) {
      if (scope.nodeType === 11 && scope.host) {
        if (scope.mode !== 'open') throw new Error('无法定位封闭的 Shadow DOM 内容。');
        chain.unshift({ kind: 'shadow', part: descriptor(scope.host) });
        scope = scope.host.getRootNode();
      } else if (scope.nodeType === 9) {
        var frame = null;
        try { frame = scope.defaultView && scope.defaultView.frameElement; } catch (_) {}
        if (!frame) break;
        chain.unshift({ kind: 'frame', part: descriptor(frame) });
        scope = frame.getRootNode();
      } else throw new Error('无法访问目标所属的网页。');
    }
    var baseDocument = scope;
    return {
      selector: chain.map(function (step) { return step.part.selector + (step.kind === 'shadow' ? ' >>> ' : ' ::frame '); }).join('') + leaf.selector,
      document: element.ownerDocument,
      resolve: function () {
        var current = baseDocument;
        chain.forEach(function (step) {
          var container = resolveOne(current, step.part);
          current = step.kind === 'shadow' ? container.shadowRoot : sameOriginDocument(container);
          if (!current) throw selectionError('inaccessible');
        });
        return resolveOne(current, leaf);
      }
    };
  }

  function composedParent(element) {
    return element.parentElement || (element.getRootNode && element.getRootNode().host) || null;
  }

  function isEditable(element) {
    var node = element;
    while (node && node.nodeType === 1) {
      if (/^(input|textarea|select)$/i.test(node.localName) || node.isContentEditable ||
        node.getAttribute('role') === 'textbox' || node.getAttribute('contenteditable') === '' ||
        node.getAttribute('contenteditable') === 'true' || node.getAttribute('contenteditable') === 'plaintext-only') return true;
      node = composedParent(node);
    }
    return false;
  }

  function targetElement(target) {
    var element = target && typeof target.resolve === 'function' ? target.resolve() : target;
    if (!element || element.nodeType !== 1 || !element.isConnected) throw selectionError('unavailable');
    return element;
  }

  // Use one resolved target for both the hover outline and the final selection.
  // Text/SVG/image descendants normally belong to a larger interactive control.
  function actionTarget(element) {
    if (element && element.nodeType === 3) element = element.parentElement;
    if (!element || element.nodeType !== 1) return null;
    var firstHTML = null, pointerTarget = null, node = element;
    while (node && node.nodeType === 1) {
      var view = node.ownerDocument && node.ownerDocument.defaultView;
      if (!firstHTML && view && view.HTMLElement && node instanceof view.HTMLElement) firstHTML = node;
      var tag = (node.localName || '').toLowerCase();
      var role = node.getAttribute('role') || '';
      if (/^(button|a|input|select|textarea|summary|label)$/.test(tag) ||
        /^(button|link|tab|menuitem|menuitemcheckbox|menuitemradio|checkbox|radio|switch|option)$/.test(role) ||
        typeof node.onclick === 'function' || node.hasAttribute('onclick') ||
        (node.hasAttribute('tabindex') && Number(node.getAttribute('tabindex')) >= 0)) return node;
      var parent = composedParent(node);
      // cursor is inherited; choose its outer boundary, not every icon inside it.
      if (!pointerTarget && view && typeof view.getComputedStyle === 'function' && !/^(body|html)$/.test(tag)) {
        try {
          if (view.getComputedStyle(node).cursor === 'pointer' &&
            (!parent || view.getComputedStyle(parent).cursor !== 'pointer')) pointerTarget = node;
        } catch (_) {}
      }
      if (!parent || /^(body|html)$/i.test(parent.localName)) break;
      node = parent;
    }
    return pointerTarget || firstHTML || element;
  }

  function assertClickable(element) {
    var view = element.ownerDocument.defaultView;
    if (!view || !element.localName) throw selectionError('unavailable');
    var node = element;
    while (node && node.nodeType === 1) {
      if (node.disabled || node.getAttribute('aria-disabled') === 'true' || node.hasAttribute('inert') ||
        (node.matches && node.matches(':disabled'))) throw selectionError('disabled');
      node = composedParent(node);
    }
  }

  function checkTarget(target) { var element = targetElement(target); assertClickable(element); return element; }

  function performClick(target) {
    var element = targetElement(target);
    assertClickable(element);
    var view = element.ownerDocument.defaultView;
    // One click only. SVG controls without an HTML wrapper can receive a bubbling click too.
    if (view.HTMLElement && element instanceof view.HTMLElement) view.HTMLElement.prototype.click.call(element);
    else element.dispatchEvent(new view.MouseEvent('click', {bubbles:true, cancelable:true, composed:true, view:view, detail:1, button:0}));
    return element;
  }

  function buttonEvents(element) {
    var view = element.ownerDocument.defaultView;
    if (!view || !view.PointerEvent || !view.MouseEvent) throw new Error('当前网页不支持创建按钮按压事件。');
    var rect = element.getBoundingClientRect();
    function event(type) {
      var down = /down$/.test(type);
      var EventType = type.indexOf('pointer') === 0 ? view.PointerEvent : view.MouseEvent;
      return new EventType(type, {
        bubbles: true, cancelable: true, composed: true, view: view,
        button: 0, buttons: down ? 1 : 0, detail: 1,
        clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2,
        pointerId: 1, pointerType: 'mouse', isPrimary: true, pressure: down ? 0.5 : 0
      });
    }
    // Prepare releases before sending any down event. Unsupported constructors
    // must not leave the page with an unmatched press. All events remain untrusted.
    return {
      pointerdown: event('pointerdown'), mousedown: event('mousedown'),
      pointerup: event('pointerup'), mouseup: event('mouseup'),
      documentPointerup: event('pointerup'), documentMouseup: event('mouseup')
    };
  }

  function buttonContext(element) {
    var roots = [];
    var anchors = [];
    var node = element;
    while (node) {
      var scope = node.getRootNode();
      roots.push(scope);
      anchors.push({ element: node, document: node.ownerDocument, root: scope });
      if (scope.nodeType === 11 && scope.host) node = scope.host;
      else {
        try { node = scope.defaultView && scope.defaultView.frameElement; } catch (_) { node = null; }
      }
    }
    return {
      roots: roots,
      attached: function () {
        return anchors.every(function (anchor) {
          return anchor.element.isConnected && anchor.element.ownerDocument === anchor.document &&
            anchor.element.getRootNode() === anchor.root;
        });
      }
    };
  }

  function createButtonController(options) {
    options = options || {};
    var target = options.target;
    var held = null;
    var destroyed = false;
    var dispatching = false;
    var releasing = false;

    function release() {
      if (!held) return false;
      // A listener may stop playback inside a down event. Finish its propagation
      // before releasing, and do not send the next down event after that stop.
      if (dispatching) { held.releaseRequested = true; return true; }
      var state = held;
      held = null;
      releasing = true;
      var accepted = true;
      var error = null;
      function attempt(fn) {
        try { accepted = fn() !== false && accepted; } catch (failure) { if (!error) error = failure; }
      }
      if (state.observer) attempt(function () { state.observer.disconnect(); });
      [['pointerdown', 'pointerup', 'documentPointerup'], ['mousedown', 'mouseup', 'documentMouseup']].forEach(function (pair) {
        if (!state.sent[pair[0]]) return;
        // Capture this before dispatch: removal inside an up listener cannot
        // change the propagation path that the browser has already captured.
        var needsDocumentRelease = !state.element.isConnected || state.element.ownerDocument !== state.document;
        attempt(function () { return state.element.dispatchEvent(state.events[pair[1]]); });
        if (needsDocumentRelease) attempt(function () { return state.document.dispatchEvent(state.events[pair[2]]); });
      });
      releasing = false;
      if (error) throw error;
      return accepted;
    }

    return {
      press: function () {
        if (destroyed) throw new Error('按钮控制器已关闭。');
        if (held || releasing) return false;
        var element = targetElement(target);
        assertClickable(element);
        var state = {
          element: element, document: element.ownerDocument, events: buttonEvents(element),
          context: buttonContext(element), sent: {}, releaseRequested: false, observer: null
        };
        if (!state.context.attached()) throw selectionError('unavailable');
        held = state;
        try {
          var Observer = state.document.defaultView.MutationObserver;
          if (Observer) {
            state.observer = new Observer(function () {
              if (held === state && !state.context.attached()) release();
            });
            state.context.roots.forEach(function (scope) { state.observer.observe(scope, { childList: true, subtree: true }); });
          }
          var accepted = true;
          var types = ['pointerdown', 'mousedown'];
          for (var i = 0; i < types.length; i += 1) {
            state.sent[types[i]] = true;
            dispatching = true;
            try { accepted = element.dispatchEvent(state.events[types[i]]) && accepted; }
            finally { dispatching = false; }
            if (state.releaseRequested || !state.context.attached()) { release(); break; }
          }
          // Dispatching synthetic pointer/mouse events does not create a click.
          // Single-click mode uses performClick separately.
          return accepted;
        } catch (error) {
          try { release(); } catch (_) {}
          throw error;
        }
      },
      release: release,
      destroy: function () { destroyed = true; release(); },
      get isPressed() { return !!held; }
    };
  }

  function chooseKeyboardTarget(candidate) {
    var element;
    if (candidate && candidate.nodeType === 9) element = candidate.body;
    else if (candidate) element = targetElement(candidate);
    else element = getDocument().body;
    if (!element || !element.isConnected) throw new Error('网页尚未准备好接收按键。');
    if (isEditable(element)) throw new Error('不能向输入框或可编辑区域发送空格。请选择歌词计时区域。');
    // Editable areas cannot receive timing keys; normal action targets remain valid.
    if (/^(button|a|label)$/i.test(element.localName) || element.getAttribute('role') === 'button') assertClickable(element);
    return element;
  }

  function keyboardEvent(element, type, binding) {
    var view = element.ownerDocument.defaultView;
    if (!view || !view.KeyboardEvent) throw new Error('当前网页不支持创建按键事件。');
    binding = binding || {key:' ', code:'Space', keyCode:32};
    var legacy = binding.keyCode || (binding.code === 'Space' ? 32 : binding.code === 'Enter' ? 13 : binding.key.length === 1 ? binding.key.toUpperCase().charCodeAt(0) : 0);
    var event = new view.KeyboardEvent(type, {
      key: binding.key, code: binding.code, keyCode: legacy, which: legacy, charCode: 0,
      ctrlKey:!!binding.ctrlKey, altKey:!!binding.altKey, shiftKey:!!binding.shiftKey, metaKey:!!binding.metaKey,
      repeat: false, bubbles: true, cancelable: true, composed: true, view: view
    });
    // Older WebKit versions ignore legacy constructor fields. Do not modify isTrusted.
    ['keyCode', 'which'].forEach(function (property) {
      if (event[property] !== legacy) {
        try { Object.defineProperty(event, property, { get: function () { return legacy; } }); } catch (_) {}
      }
    });
    return event;
  }

  function createKeyController(options) {
    options = options || {};
    var target = options.target || chooseKeyboardTarget(options.document);
    var binding = options.binding ? Object.assign({}, options.binding) : null;
    var heldTarget = null;
    var heldDocument = null;
    var destroyed = false;
    var dispatching = false, releaseRequested = false, releasing = false;
    function release() {
      if (!heldTarget) return false;
      if (dispatching) { releaseRequested = true; return true; }
      var element = heldTarget;
      var pressDocument = heldDocument;
      heldTarget = null;
      heldDocument = null;
      // Event propagation paths are fixed when dispatch begins. A disconnected
      // target cannot reach its former document, even though its own listeners
      // still need their paired keyup. Dispatch to the document only when that
      // propagation path is absent, so document/window listeners receive one up.
      var needsDocumentRelease = !element.isConnected || element.ownerDocument !== pressDocument;
      var accepted = true;
      releasing = true;
      try {
        try { accepted = element.dispatchEvent(keyboardEvent(element, 'keyup', binding)); }
        finally {
          if (needsDocumentRelease && pressDocument && typeof pressDocument.dispatchEvent === 'function') {
            var fallback = keyboardEvent({ ownerDocument: pressDocument }, 'keyup', binding);
            accepted = pressDocument.dispatchEvent(fallback) && accepted;
          }
        }
      } finally { releasing = false; }
      return accepted;
    }
    return {
      press: function () {
        if (destroyed) throw new Error('按键控制器已关闭。');
        if (heldTarget || releasing) return false;
        var element = chooseKeyboardTarget(target);
        var event = keyboardEvent(element, 'keydown', binding);
        // Do not redirect a held key if a page re-renders between keydown and keyup.
        heldTarget = element;
        heldDocument = element.ownerDocument;
        releaseRequested = false;
        try {
          dispatching = true;
          var accepted;
          try { accepted = element.dispatchEvent(event); }
          finally { dispatching = false; }
          // A page can pause synchronously during keydown. Complete propagation
          // before sending keyup so later page listeners do not remain pressed.
          if (releaseRequested) release();
          return accepted;
        }
        catch (error) {
          // A page can throw after receiving keydown. It still needs keyup;
          // a second failure while releasing must not hide the press failure.
          try { release(); } catch (_) {}
          throw error;
        }
      },
      release: release,
      destroy: function () {
        destroyed = true;
        release();
      },
      get isPressed() { return !!heldTarget; }
    };
  }

  function createPicker(options) {
    options = options || {};
    var doc = getDocument(options.document);
    var stopped = false;
    var cleanupTasks = [];
    var overlays = new Map();
    var exclude = options.excludeRoot;

    function excluded(element, event) {
      if (!element || !exclude) return !element;
      var path = event && event.composedPath ? event.composedPath() : [];
      return path.indexOf(exclude) !== -1 || element === exclude ||
        (typeof exclude.contains === 'function' && exclude.contains(element));
    }
    function candidate(event) {
      var path = event.composedPath ? event.composedPath() : [event.target];
      return actionTarget(path.find(function (node) { return node && (node.nodeType === 1 || node.nodeType === 3); }));
    }
    function hide() { overlays.forEach(function (overlay) { overlay.style.display = 'none'; }); }
    function cleanup() {
      if (stopped) return;
      stopped = true;
      cleanupTasks.forEach(function (fn) { fn(); });
      overlays.forEach(function (overlay) { overlay.remove(); });
      overlays.clear();
    }
    function block(event) {
      event.preventDefault();
      event.stopImmediatePropagation();
      event.stopPropagation();
    }
    var documents = new Set();
    walkRoots(doc, function (scope) {
      if (scope.nodeType === 9) documents.add(scope);
    });
    documents.forEach(function (currentDocument) {
      var overlay = currentDocument.createElement('div');
      overlay.setAttribute('aria-hidden', 'true');
      overlay.style.cssText = 'display:none;position:fixed;z-index:2147483647;pointer-events:none;border:2px solid #57d4c1;background:rgba(87,212,193,.13);border-radius:4px;box-sizing:border-box;';
      (currentDocument.body || currentDocument.documentElement).appendChild(overlay);
      overlays.set(currentDocument, overlay);
      var host = currentDocument.defaultView || currentDocument;
      function move(event) {
        if (stopped) return;
        var element = candidate(event);
        hide();
        if (excluded(element, event)) return;
        var rect = element.getBoundingClientRect();
        overlay.style.left = rect.left + 'px';
        overlay.style.top = rect.top + 'px';
        overlay.style.width = rect.width + 'px';
        overlay.style.height = rect.height + 'px';
        overlay.style.display = 'block';
      }
      function intercept(event) {
        var element = candidate(event);
        if (!stopped && !excluded(element, event)) block(event);
      }
      function pick(event) {
        if (stopped) return;
        var element = candidate(event);
        if (excluded(element, event)) return;
        block(event);
        cleanup();
        if (typeof options.onPick === 'function') options.onPick(element);
      }
      function key(event) {
        if (event.key !== 'Escape' || stopped) return;
        block(event);
        cleanup();
        if (typeof options.onCancel === 'function') options.onCancel();
      }
      var listeners = [
        ['pointermove', move], ['mousemove', move], ['pointerdown', intercept],
        ['pointerup', intercept], ['mousedown', intercept], ['mouseup', intercept],
        ['click', pick], ['keydown', key]
      ];
      listeners.forEach(function (entry) {
        host.addEventListener(entry[0], entry[1], true);
        cleanupTasks.push(function () { host.removeEventListener(entry[0], entry[1], true); });
      });
      host.addEventListener('scroll', hide, true);
      cleanupTasks.push(function () { host.removeEventListener('scroll', hide, true); });
    });
    return cleanup;
  }

  return Object.freeze({
    discoverMedia: discoverMedia, createPicker: createPicker, actionTarget: actionTarget,
    makeLocator: makeLocator, checkTarget: checkTarget, performClick: performClick, createButtonController: createButtonController,
    chooseKeyboardTarget: chooseKeyboardTarget, createKeyController: createKeyController
  });
});

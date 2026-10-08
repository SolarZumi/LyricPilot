'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const actions = require('../extension/actions.js');

// An offline DOM/event model: only the browser contracts used by actions.js are
// implemented. This tests release paths and safety decisions, not site support.
class FakeEvent {
  constructor(type, options = {}) {
    this.type = type;
    Object.assign(this, options);
    this.isTrusted = false;
    this.defaultPrevented = false;
  }
  preventDefault() { if (this.cancelable) this.defaultPrevented = true; }
}

class FakeTarget {
  constructor() { this.listeners = new Map(); this.eventParent = null; }
  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(listener);
  }
  dispatchEvent(event) {
    const path = [this];
    if (event.bubbles) {
      let parent = this.eventParent;
      while (parent) { path.push(parent); parent = parent.eventParent; }
    }
    event.target = this;
    // Snapshot before invoking listeners, as DOM dispatch does. Removal during
    // keyup does not remove the document from the existing propagation path.
    for (const receiver of path) {
      event.currentTarget = receiver;
      for (const listener of receiver.listeners.get(event.type) || []) listener(event);
    }
    return !event.defaultPrevented;
  }
}

function fixture() {
  const window = new FakeTarget();
  const document = new FakeTarget();
  document.nodeType = 9;
  document.defaultView = window;
  document.eventParent = window;
  const selectors = new Map();
  document.querySelectorAll = selector => selectors.get(selector) || [];
  const observers = new Set();
  let mutationPending = false;
  function notifyMutation() {
    if (mutationPending) return;
    mutationPending = true;
    queueMicrotask(() => {
      mutationPending = false;
      for (const observer of [...observers]) observer.callback();
    });
  }
  class MutationObserver {
    constructor(callback) { this.callback = callback; this.roots = []; }
    observe(root) { this.roots.push(root); observers.add(this); }
    disconnect() { observers.delete(this); }
  }
  class Element extends FakeTarget {
    constructor(tag, attributes = {}, text = '') {
      super();
      this.nodeType = 1;
      this.localName = tag;
      this.attributes = attributes;
      this.textContent = text;
      this.ownerDocument = document;
      this.isConnected = true;
      this.parentElement = document.body || null;
      this.eventParent = document.body || document;
      this.clickCount = 0;
    }
    getAttribute(name) { return this.attributes[name] ?? null; }
    hasAttribute(name) { return name in this.attributes; }
    get id() { return this.attributes.id || ''; }
    getRootNode() { return document; }
    matches(selector) { return selector === ':disabled' && !!this.disabled; }
    getBoundingClientRect() { return { left: 10, top: 20, width: 100, height: 40 }; }
    click() { this.clickCount += 1; }
    remove() {
      this.isConnected = false; this.eventParent = null; this.parentElement = null;
      notifyMutation();
    }
  }
  window.HTMLElement = Element;
  window.KeyboardEvent = FakeEvent;
  window.PointerEvent = FakeEvent;
  window.MouseEvent = FakeEvent;
  window.MutationObserver = MutationObserver;
  document.body = new Element('body');
  return { window, document, Element, selectors, observers, notifyMutation };
}

test('loads as CommonJS without a DOM', () => {
  assert.equal(typeof global.document, 'undefined');
  assert.equal(typeof actions.makeLocator, 'function');
  assert.equal('profiles' in actions, false);
});

function recordButtonEvents(target) {
  const events = [];
  for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
    target.addEventListener(type, event => events.push(event));
  }
  return events;
}

test('button holds send paired pointer/mouse events without a click or forged trust', () => {
  const { Element, document, window, observers } = fixture();
  const target = new Element('button', { type: 'button' }, '打点');
  const targetEvents = recordButtonEvents(target);
  const documentEvents = recordButtonEvents(document);
  const windowEvents = recordButtonEvents(window);
  const button = actions.createButtonController({ target });
  assert.equal(button.isPressed, false);
  assert.equal(button.press(), true);
  assert.equal(button.isPressed, true);
  assert.equal(button.press(), false);
  assert.deepEqual(targetEvents.map(e => e.type), ['pointerdown', 'mousedown']);
  assert.equal(button.release(), true);
  assert.equal(button.isPressed, false);
  assert.equal(button.release(), false);
  button.destroy(); button.destroy();
  assert.equal(observers.size, 0);
  assert.throws(() => button.press(), /已关闭/);
  for (const events of [targetEvents, documentEvents, windowEvents]) {
    assert.deepEqual(events.map(e => e.type), ['pointerdown', 'mousedown', 'pointerup', 'mouseup']);
  }
  for (const event of targetEvents) {
    assert.equal(event.target, target);
    assert.equal(event.button, 0);
    assert.equal(event.buttons, event.type.endsWith('down') ? 1 : 0);
    assert.equal(event.clientX, 60);
    assert.equal(event.clientY, 40);
    assert.equal(event.bubbles, true);
    assert.equal(event.composed, true);
    assert.equal(event.isTrusted, false);
  }
  for (const event of targetEvents.filter(e => e.type.startsWith('pointer'))) {
    assert.equal(event.pointerType, 'mouse');
    assert.equal(event.isPrimary, true);
    assert.equal(event.pointerId, targetEvents[0].pointerId);
  }
  assert.equal(target.clickCount, 0);
});

test('destroy releases a held button once and cannot be reopened by a release listener', () => {
  const { Element } = fixture();
  const target = new Element('button', { type: 'button' }, '打点');
  const events = recordButtonEvents(target);
  const button = actions.createButtonController({ target });
  target.addEventListener('pointerup', () => assert.throws(() => button.press(), /已关闭/));
  button.press();
  const destroy = button.destroy;
  destroy(); destroy();
  assert.equal(button.isPressed, false);
  assert.deepEqual(events.map(e => e.type), ['pointerdown', 'mousedown', 'pointerup', 'mouseup']);
});

test('button removal automatically releases the original target and its document exactly once', async () => {
  const { Element, document, window, observers } = fixture();
  const target = new Element('button', { type: 'button' }, '打点');
  const targetEvents = recordButtonEvents(target);
  const documentEvents = recordButtonEvents(document);
  const windowEvents = recordButtonEvents(window);
  const button = actions.createButtonController({ target });
  button.press(); target.remove();
  await Promise.resolve();
  assert.equal(button.isPressed, false);
  assert.equal(button.release(), false);
  button.destroy();
  assert.equal(observers.size, 0);
  for (const events of [targetEvents, documentEvents, windowEvents]) {
    assert.deepEqual(events.map(e => e.type), ['pointerdown', 'mousedown', 'pointerup', 'mouseup']);
  }
  assert.equal(targetEvents[2].target, target);
  assert.equal(documentEvents[2].target, document);
  assert.notEqual(targetEvents[2], documentEvents[2]);
  assert.equal(windowEvents[2], documentEvents[2]);
});

test('a re-render never redirects a pending release to the replacement button', () => {
  const { Element, selectors } = fixture();
  const original = new Element('button', { id: 'mark', type: 'button' }, '打点');
  selectors.set('button[id="mark"]', [original]);
  const originalEvents = recordButtonEvents(original);
  const button = actions.createButtonController({ target: actions.makeLocator(original) });
  button.press();
  const replacement = new Element('button', { id: 'mark', type: 'button' }, '打点');
  const replacementEvents = recordButtonEvents(replacement);
  original.remove(); selectors.set('button[id="mark"]', [replacement]);
  button.release();
  assert.deepEqual(originalEvents.map(e => e.type), ['pointerdown', 'mousedown', 'pointerup', 'mouseup']);
  assert.equal(replacementEvents.length, 0);
  button.press(); button.release();
  assert.deepEqual(replacementEvents.map(e => e.type), ['pointerdown', 'mousedown', 'pointerup', 'mouseup']);
});

test('removal during pointerup preserves its captured path and sends one document mouseup', () => {
  const { Element, document, window } = fixture();
  const target = new Element('button', { type: 'button' }, '打点');
  const documentEvents = recordButtonEvents(document);
  const windowEvents = recordButtonEvents(window);
  target.addEventListener('pointerup', () => target.remove());
  const button = actions.createButtonController({ target });
  button.press(); button.release(); button.release();
  for (const events of [documentEvents, windowEvents]) {
    assert.deepEqual(events.map(e => e.type), ['pointerdown', 'mousedown', 'pointerup', 'mouseup']);
  }
});

test('removal inside pointerdown releases before any further press events', () => {
  const { Element, document, observers } = fixture();
  const target = new Element('button', { type: 'button' }, '打点');
  const events = recordButtonEvents(document);
  target.addEventListener('pointerdown', () => target.remove());
  const button = actions.createButtonController({ target });
  button.press();
  assert.equal(button.isPressed, false);
  assert.equal(observers.size, 0);
  assert.deepEqual(events.map(e => e.type), ['pointerdown', 'pointerup']);
});

test('a stop inside mousedown finishes down propagation before releasing and blocks reentrant press', () => {
  const { Element, document } = fixture();
  const target = new Element('button', { type: 'button' }, '打点');
  const events = recordButtonEvents(document);
  const button = actions.createButtonController({ target });
  target.addEventListener('mousedown', () => button.release());
  target.addEventListener('pointerup', () => assert.equal(button.press(), false));
  button.press();
  assert.equal(button.isPressed, false);
  assert.deepEqual(events.map(e => e.type), ['pointerdown', 'mousedown', 'pointerup', 'mouseup']);
});

test('adopting a held button into another document still releases the press document', async () => {
  const first = fixture(), second = fixture();
  const target = new first.Element('button', { type: 'button' }, '打点');
  const events = recordButtonEvents(first.document);
  const button = actions.createButtonController({ target });
  button.press();
  target.ownerDocument = second.document;
  target.eventParent = second.document.body;
  first.notifyMutation();
  await Promise.resolve();
  assert.equal(button.isPressed, false);
  assert.deepEqual(events.map(e => e.type), ['pointerdown', 'mousedown', 'pointerup', 'mouseup']);
  assert.equal(events[2].view, first.window);
});

test('button holds reject unavailable targets, including disabled ancestors', () => {
  const { Element } = fixture();
  const disabled = new Element('button', { type: 'button' }, '打点');
  disabled.disabled = true;
  const detached = new Element('button', { type: 'button' }, '打点'); detached.remove();
  const nested = new Element('span', {}, '打点');
  nested.parentElement = new Element('div', { 'aria-disabled': 'true' });
  const svg = new FakeTarget();
  Object.assign(svg, { nodeType: 1, ownerDocument: disabled.ownerDocument, isConnected: true });
  for (const target of [disabled, detached, nested, svg, new Element('div', { inert: '' })]) {
    const events = recordButtonEvents(target);
    const button = actions.createButtonController({ target });
    assert.throws(() => button.press());
    assert.equal(button.isPressed, false);
    assert.equal(events.length, 0);
  }
});

test('a button that becomes disabled while held still receives its releases', () => {
  const { Element } = fixture();
  const target = new Element('button', { type: 'button' }, '打点');
  const events = recordButtonEvents(target);
  const button = actions.createButtonController({ target });
  button.press(); target.disabled = true; button.release();
  assert.deepEqual(events.map(e => e.type), ['pointerdown', 'mousedown', 'pointerup', 'mouseup']);
  assert.throws(() => button.press(), error => error.message === '请重新选择' && error.code === 'target-unavailable');
  assert.equal(button.isPressed, false);
});

test('a failed down dispatch releases both sent event types, clears observers, and preserves the first error', () => {
  const { Element, observers } = fixture();
  const target = new Element('button', { type: 'button' }, '打点');
  const events = recordButtonEvents(target);
  const dispatch = target.dispatchEvent;
  const downError = new Error('down dispatch failed');
  target.dispatchEvent = function (event) {
    const accepted = dispatch.call(this, event);
    if (event.type === 'mousedown') throw downError;
    if (event.type === 'pointerup') throw new Error('up dispatch failed');
    return accepted;
  };
  const button = actions.createButtonController({ target });
  assert.throws(() => button.press(), error => error === downError);
  assert.equal(button.isPressed, false);
  assert.equal(button.release(), false);
  assert.equal(observers.size, 0);
  assert.deepEqual(events.map(e => e.type), ['pointerdown', 'mousedown', 'pointerup', 'mouseup']);
  target.dispatchEvent = dispatch;
  button.press(); button.release();
  assert.equal(events.length, 8);
});

test('a failed pointerup cannot prevent mouseup or leave a destroyed controller open', () => {
  const { Element, observers } = fixture();
  const target = new Element('button', { type: 'button' }, '打点');
  const events = recordButtonEvents(target);
  const dispatch = target.dispatchEvent;
  target.dispatchEvent = function (event) {
    const accepted = dispatch.call(this, event);
    if (event.type === 'pointerup') throw new Error('up dispatch failed');
    return accepted;
  };
  const button = actions.createButtonController({ target });
  button.press();
  assert.throws(() => button.destroy(), /up dispatch failed/);
  button.destroy();
  assert.equal(button.isPressed, false);
  assert.equal(observers.size, 0);
  assert.throws(() => button.press(), /已关闭/);
  assert.deepEqual(events.map(e => e.type), ['pointerdown', 'mousedown', 'pointerup', 'mouseup']);
});

test('unsupported button event constructors fail before any down event', () => {
  for (const name of ['PointerEvent', 'MouseEvent']) {
    const { Element, window, observers } = fixture();
    const target = new Element('button', { type: 'button' }, '打点');
    const events = recordButtonEvents(target);
    window[name] = class {
      constructor(type) { if (type.endsWith('up')) throw new Error('unsupported release event'); }
    };
    const button = actions.createButtonController({ target });
    assert.throws(() => button.press(), /unsupported release event/);
    assert.equal(button.isPressed, false);
    assert.equal(events.length, 0);
    assert.equal(observers.size, 0);
  }
});

test('manual button and link targets are not rejected by text, tag, or destination', () => {
  const { Element } = fixture();
  const submit = new Element('button', {}, '继续'); submit.form = {};
  for (const element of [submit, new Element('label', { for: 'entry' }, '继续'),
    new Element('input'), new Element('a', { href: 'https://example.invalid' }, '下一步'),
    ...['保存', 'Publish', '删除', 'Pay'].map(text => new Element('button', { type: 'button' }, text))]) {
    actions.performClick(element);
    assert.equal(element.clickCount, 1);
  }
  const disabled = new Element('button'); disabled.disabled = true;
  assert.throws(() => actions.performClick(disabled), error => error.message === '请重新选择' && error.code === 'target-unavailable');
  assert.equal(disabled.clickCount, 0);
});

test('text, images and nested SVG paths resolve to the nearest button or link', () => {
  const { Element } = fixture();
  for (const tag of ['button','a']) {
    const control = new Element(tag, tag === 'a' ? {href:'https://example.invalid'} : {});
    for (const leafTag of ['span','img','path']) {
      const leaf = new Element(leafTag); leaf.parentElement = control;
      assert.equal(actions.actionTarget(leaf), control);
      assert.equal(actions.actionTarget({nodeType:3,parentElement:leaf}), control);
    }
  }
});

test('nearest custom control wins over an outer action', () => {
  const { Element } = fixture();
  const outer = new Element('a', {href:'/song'});
  const inner = new Element('div', {'role':'button'}); inner.parentElement=outer;
  const path = new Element('path'); path.parentElement=inner;
  assert.equal(actions.actionTarget(path),inner);
});

test('unlabelled cursor controls select the pointer boundary, not the inherited icon cursor', () => {
  const { Element, window } = fixture();
  window.getComputedStyle = node => ({cursor:node.cursor||'auto'});
  const control = new Element('div'); control.cursor='pointer';
  const icon = new Element('svg'); icon.cursor='pointer'; icon.parentElement=control;
  const path = new Element('path'); path.cursor='pointer'; path.parentElement=icon;
  assert.equal(actions.actionTarget(path),control);
});

test('custom handlers and focusable controls are selected through open shadow roots', () => {
  const { Element } = fixture();
  for (const attributes of [{onclick:'play()'},{tabindex:'0'},{role:'tab'}]) {
    const host = new Element('div',attributes), icon = new Element('span');
    icon.parentElement=null; icon.getRootNode=()=>({nodeType:11,mode:'open',host});
    assert.equal(actions.actionTarget(icon),host);
  }
});

test('generic manually selected containers remain selectable without semantic roles', () => {
  const { Element } = fixture();
  const container = new Element('div');
  assert.equal(actions.actionTarget(container),container);
  assert.equal(actions.actionTarget(null),null);
});

test('stable identity restores an equivalent re-render; ambiguity and changed identity stop', () => {
  const { Element, selectors } = fixture();
  const original = new Element('button', { id: 'mark' }, '打点');
  selectors.set('button[id="mark"]', [original]);
  const locator = actions.makeLocator(original);
  const replacement = new Element('button', { id: 'mark' }, '打点');
  original.remove();
  selectors.set('button[id="mark"]', [replacement]);
  assert.equal(locator.resolve(), replacement);
  selectors.set('button[id="mark"]', []);
  assert.throws(() => locator.resolve(), error => error.message === '请重新选择' && error.code === 'target-unavailable' && error.reason === 'missing');
  selectors.set('button[id="mark"]', [replacement, replacement]);
  assert.throws(() => locator.resolve(), error => error.message === '请重新选择' && error.code === 'target-unavailable' && error.reason === 'ambiguous');
  selectors.set('button[id="mark"]', [new Element('button', { id: 'mark' }, '保存')]);
  assert.throws(() => locator.resolve(), error => error.message === '请重新选择' && error.code === 'target-unavailable' && error.reason === 'changed-identity');
});

test('a structural locator cannot switch to an identical button in the next row', () => {
  const { Element, selectors } = fixture();
  const first = new Element('button', {}, '打点');
  const second = new Element('button', {}, '打点');
  selectors.set('button', [first, second]);
  selectors.set('button:nth-of-type(1)', [first]);
  const locator = actions.makeLocator(first);
  assert.equal(locator.resolve(), first);
  first.remove();
  selectors.set('button', [second]);
  selectors.set('button:nth-of-type(1)', [second]);
  assert.throws(() => locator.resolve(), error => error.message === '请重新选择' && error.code === 'target-unavailable' && error.reason === 'unstable-identity');
  assert.equal(second.clickCount, 0);
});

test('an aria-label alone is not sufficient identity for replacing a target', () => {
  const { Element, selectors } = fixture();
  const first = new Element('button', { 'aria-label': '打点' });
  selectors.set('button[aria-label="打点"]', [first]);
  const locator = actions.makeLocator(first);
  first.remove();
  selectors.set('button[aria-label="打点"]', [new Element('button', { 'aria-label': '打点' })]);
  assert.throws(() => locator.resolve(), error => error.message === '请重新选择' && error.code === 'target-unavailable' && error.reason === 'unstable-identity');
});

test('space key events stay paired and repeat calls are idempotent', () => {
  const { Element, document, window } = fixture();
  const target = new Element('div');
  const events = [], documentEvents = [], windowEvents = [];
  for (const type of ['keydown', 'keyup']) {
    target.addEventListener(type, event => events.push(event));
    document.addEventListener(type, event => documentEvents.push(event));
    window.addEventListener(type, event => windowEvents.push(event));
  }
  const keys = actions.createKeyController({ target });
  keys.press(); keys.press(); keys.release(); keys.release(); keys.destroy();
  assert.deepEqual(events.map(e => e.type), ['keydown', 'keyup']);
  assert.equal(documentEvents.length, 2);
  assert.equal(windowEvents.length, 2);
  assert.equal(events[0].target, events[1].target);
  for (const event of events) {
    assert.equal(event.key, ' ');
    assert.equal(event.code, 'Space');
    assert.equal(event.keyCode, 32);
    assert.equal(event.which, 32);
    assert.equal(event.repeat, false);
    assert.equal(event.isTrusted, false);
  }
});

test('detached target receives its paired keyup and document/window receive one emergency keyup', () => {
  const { Element, document, window } = fixture();
  const target = new Element('div');
  const targetEvents = [], documentEvents = [], windowEvents = [];
  for (const type of ['keydown', 'keyup']) {
    target.addEventListener(type, event => targetEvents.push(event));
    document.addEventListener(type, event => documentEvents.push(event));
    window.addEventListener(type, event => windowEvents.push(event));
  }
  const keys = actions.createKeyController({ target });
  keys.press();
  target.remove();
  keys.release(); keys.release(); keys.destroy();
  for (const events of [targetEvents, documentEvents, windowEvents]) {
    assert.deepEqual(events.map(e => e.type), ['keydown', 'keyup']);
    assert.equal(events[1].isTrusted, false);
  }
  assert.equal(targetEvents[1].target, target);
  assert.equal(documentEvents[1].target, document);
  assert.equal(windowEvents[1], documentEvents[1]);
  assert.notEqual(targetEvents[1], documentEvents[1]);
});

test('removal during keyup does not duplicate release on the captured document path', () => {
  const { Element, document, window } = fixture();
  const target = new Element('div');
  let documentUps = 0, windowUps = 0;
  target.addEventListener('keyup', () => target.remove());
  document.addEventListener('keyup', () => documentUps++);
  window.addEventListener('keyup', () => windowUps++);
  const keys = actions.createKeyController({ target });
  keys.press(); keys.release();
  assert.equal(documentUps, 1);
  assert.equal(windowUps, 1);
});

test('destroy is safe as a callback, releases once, and closes the controller', () => {
  const { Element } = fixture();
  const target = new Element('div');
  let releases = 0;
  target.addEventListener('keyup', () => releases++);
  const keys = actions.createKeyController({ target });
  keys.press();
  const destroy = keys.destroy;
  destroy(); destroy();
  assert.equal(releases, 1);
  assert.equal(keys.isPressed, false);
  assert.throws(() => keys.press(), /已关闭/);
});

test('space is never sent to inputs or editable areas', () => {
  const { Element } = fixture();
  for (const target of [new Element('input'), new Element('textarea'),
    new Element('div', { contenteditable: 'true' })]) {
    assert.throws(() => actions.createKeyController({ target }).press());
  }
});

test('a failed keydown dispatch attempts one keyup and retains the original failure', () => {
  const { Element, document } = fixture();
  const target = new Element('div');
  const events = [];
  document.addEventListener('keydown', event => events.push(event.type));
  document.addEventListener('keyup', event => events.push(event.type));
  const dispatch = target.dispatchEvent;
  const downError = new Error('keydown failed');
  target.dispatchEvent = function (event) {
    dispatch.call(this, event);
    if (event.type === 'keydown') throw downError;
    if (event.type === 'keyup') throw new Error('keyup failed');
  };
  const keys = actions.createKeyController({ target });
  assert.throws(() => keys.press(), error => error === downError);
  assert.deepEqual(events, ['keydown', 'keyup']);
  assert.equal(keys.isPressed, false);
  assert.equal(keys.release(), false);
  keys.destroy();
  assert.deepEqual(events, ['keydown', 'keyup']);
});

test('a failed key event constructor does not send an unmatched keyup', () => {
  const { Element, window } = fixture();
  const target = new Element('div');
  let releases = 0;
  target.addEventListener('keyup', () => releases++);
  window.KeyboardEvent = class extends FakeEvent {
    constructor(type, options) {
      if (type === 'keydown') throw new Error('unsupported keydown');
      super(type, options);
    }
  };
  const keys = actions.createKeyController({ target });
  assert.throws(() => keys.press(), /unsupported keydown/);
  assert.equal(keys.isPressed, false);
  assert.equal(releases, 0);
});

test('destroy closes a key controller before release listeners can press again', () => {
  const { Element } = fixture();
  const target = new Element('div');
  const keys = actions.createKeyController({ target });
  target.addEventListener('keyup', () => assert.throws(() => keys.press(), /已关闭/));
  keys.press(); keys.destroy();
  assert.equal(keys.isPressed, false);
});

test('custom keys retain code and modifiers for paired down/up, even after target removal', () => {
  const {document,Element}=fixture(),target=new Element('div',{tabindex:'0'}),events=[];
  document.addEventListener('keydown',e=>events.push(e));
  document.addEventListener('keyup',e=>events.push(e));
  const binding={key:'Enter',code:'Enter',keyCode:13,ctrlKey:true,shiftKey:true};
  const keys=actions.createKeyController({target,binding});
  binding.key='Escape';binding.ctrlKey=false;
  keys.press();target.remove();keys.destroy();
  assert.deepEqual(events.map(e=>[e.type,e.key,e.code,e.keyCode,e.ctrlKey,e.shiftKey]),[
    ['keydown','Enter','Enter',13,true,true],['keyup','Enter','Enter',13,true,true]
  ]);
  assert.ok(events.every(e=>!e.isTrusted));
});

test('stopping within keydown finishes down propagation before releasing the key', () => {
  for (const end of ['release','destroy']) {
    const {Element,document,window}=fixture(),target=new Element('div'),events=[];
    const keys=actions.createKeyController({target});
    target.addEventListener('keydown',()=>keys[end]());
    for (const type of ['keydown','keyup']) {
      document.addEventListener(type,()=>events.push('document:'+type));
      window.addEventListener(type,()=>events.push('window:'+type));
    }
    keys.press();
    assert.deepEqual(events,['document:keydown','window:keydown','document:keyup','window:keyup']);
    assert.equal(keys.isPressed,false);
  }
});

test('release callbacks cannot interleave a new keydown into a pending keyup',()=>{
  const {Element,document}=fixture(),target=new Element('div'),events=[];
  const keys=actions.createKeyController({target});
  target.addEventListener('keyup',()=>assert.equal(keys.press(),false));
  for (const type of ['keydown','keyup']) document.addEventListener(type,()=>events.push(type));
  keys.press();keys.release();
  assert.deepEqual(events,['keydown','keyup']);assert.equal(keys.isPressed,false);
});

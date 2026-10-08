
(() => {
  'use strict';
  if (globalThis.__lyricPilotPanel) { globalThis.__lyricPilotPanel.show(); return; }
  const C = globalThis.LyricPilotCore, A = globalThis.LyricPilotActions;
  const host = document.createElement('div'); host.id = 'lyric-pilot-root';
  const shadow = host.attachShadow({mode:'open'});
  const style = document.createElement('style'); style.textContent = globalThis.LyricPilotStyles; shadow.append(style);
  const content = document.createElement('div'); content.style.height = '100%'; content.innerHTML = globalThis.LyricPilotTemplate; shadow.append(content);
  document.documentElement.append(host);
  const root = shadow.getElementById('lyricpilot');
  let playTarget = null, markTarget = null, pickerCleanup = null;
  let playLabel = '播放', markLabel = '下一句';
  const $ = s => root.querySelector(s);
  const $$ = s => [...root.querySelectorAll(s)];
  function rangeInfo(cues) {
    return {
      total: cues.length,
      missing: cues.filter(cue => !Number.isFinite(cue.end)).length,
      overlap: cues.some((cue,index) => index && Number.isFinite(cues[index-1].end) && cue.start < cues[index-1].end),
      invalid: cues.filter(cue => Number.isFinite(cue.end) && (!Number.isFinite(cue.start) || cue.end <= cue.start)).length
    };
  }
  function holdReason(ranges) {
    if (!ranges?.total) return '请先导入含起止时间的歌词';
    if (ranges.missing) return '歌词缺少持续时间，无法按住';
    if (ranges.invalid) return '歌词持续时间无效，无法按住';
    if (ranges.overlap) return '歌词时间重叠，无法按住';
    return '';
  }
  let state = { phase: 'ready', input: 'button', duration: 'tap', offset: 0, file: false, play: false, mark: false, customKey: null, format: 'lrc', index: 0, name: '', cues: [], minimized: false, closed: false, appearance: 'system', palette: 'green' };
  let picking = null;
  let importVersion = 0;
  let more = false;
  let recording = false;
  let pendingKey = null;
  let heldModifiers = [];
  let lastTargetInput = 'button';
  const targetErrors = {play:false,mark:false};
  let cursorTimer = null;
  const layerTimers = new Map();
  let returnFocusTimer = null;
  const systemTheme = matchMedia('(prefers-color-scheme: dark)');
  const motionPreference = matchMedia('(prefers-reduced-motion: reduce)');
  let reduced = motionPreference.matches;
  const updateMotion = () => { reduced = motionPreference.matches; };
  motionPreference.addEventListener('change',updateMotion);
  function icons() { globalThis.LyricPilotIcons(root); }
  function persist() {
    const preferences = {appearance:state.appearance,palette:state.palette,position:panelPosition.save()};
    if (globalThis.chrome?.storage?.local) chrome.storage.local.set({lyricPilotPreferences:preferences}).catch(()=>{});
    else globalThis.__lyricPilotPreferences = preferences;
  }
  function centerList(viewport,list,smooth) {
    const el = list.querySelector('.is-current');
    if (!el) return;
    list.style.paddingTop = Math.max(0,viewport.clientHeight / 2 - list.firstElementChild.offsetHeight / 2) + 'px';
    list.style.paddingBottom = Math.max(0,viewport.clientHeight / 2 - list.lastElementChild.offsetHeight / 2) + 'px';
    const y = el.offsetTop + el.offsetHeight / 2 - viewport.clientHeight / 2;
    viewport.scrollTo({top:Math.max(0,y),behavior:smooth && !reduced ? 'smooth':'instant'});
  }
  function centerCurrent(smooth = true) {
    if (!state.minimized) centerList($('.lyric-viewport'),$('.lyric-list'),smooth);
  }
  function fillLines() {
    ['.lyric-list'].forEach(selector => {
      const list = $(selector); list.replaceChildren();
      state.cues.forEach((cue,index) => {
        const li = document.createElement('li'); li.dataset.index = index;
        const time = document.createElement('span'); time.className = 'lyric-time';
        const text = document.createElement('span'); text.className = 'lyric-text'; text.textContent = cue.text;
        li.append(time,text); list.append(li);
      });
    });
    renderTimes();
  }
  function formatLyricTime(seconds) {
    const milliseconds = Math.round(seconds * 1000);
    const absolute = Math.abs(milliseconds);
    const minutes = Math.floor(absolute / 60000);
    const wholeSeconds = Math.floor(absolute / 1000) % 60;
    return `${milliseconds < 0 ? '−' : ''}${String(minutes).padStart(2,'0')}:${String(wholeSeconds).padStart(2,'0')}.${String(absolute % 1000).padStart(3,'0')}`;
  }
  function cueTimeLabel(cue,offset) {
    const start = formatLyricTime(cue.start + offset);
    return Number.isFinite(cue.end) ? `${start} – ${formatLyricTime(cue.end + offset)}` : start;
  }
  function renderTimes() {
    $$('.lyric-time').forEach(el => { const cue = state.cues[Number(el.closest('li').dataset.index)]; if (cue) el.textContent = cueTimeLabel(cue,state.offset); });
  }
  function cursorHint(point) {
    const hint = $('.cursor-hint');
    if (!point?.visible || state.phase !== 'running' || state.closed) {
      hint.classList.remove('is-visible','is-blocked'); clearTimeout(cursorTimer); return;
    }
    if (point.blocked) {
      hint.classList.add('is-blocked'); clearTimeout(cursorTimer);
      cursorTimer = setTimeout(() => hint.classList.remove('is-blocked'),1600);
    }
    // Reserve the full message width so a click never moves the badge across the pointer.
    const width = Math.max(170,hint.offsetWidth), height = Math.max(64,hint.offsetHeight);
    const x = point.x + 18 + width <= innerWidth - 8 ? point.x + 18 : Math.max(8,point.x - width - 12);
    const y = point.y + 20 + height <= innerHeight - 8 ? point.y + 20 : Math.max(8,point.y - height - 12);
    hint.style.transform = `translate3d(${Math.round(x)}px,${Math.round(y)}px,0)`;
    hint.classList.add('is-visible');
  }
  function renderProtection() {
    $('.stage').dataset.phase = state.phase;
    $('.panel-shell').classList.toggle('is-closed',state.closed);
    $('.panel-shell').inert = state.closed || !!picking;
    $('.panel-shell').setAttribute('aria-hidden',String(state.closed || !!picking));
    inputLock.set(state.phase === 'running' && !state.closed);
    targetMonitor.setEnabled(!state.closed);
  }
  function invalidateTargets(names, focus = false) {
    const lost = names.filter(which => which === 'play' || which === 'mark');
    if (!lost.length) return;
    for (const which of lost) {
      targetErrors[which] = true; state[which] = false;
      if (which === 'play') playTarget = null; else markTarget = null;
    }
    const required = lost.includes('play') || (state.input === 'button' && lost.includes('mark'));
    if (required && state.phase !== 'ready') session.stop();
    if (focus) state.minimized = false;
    render(); targetMonitor.refresh();
    if (focus) returnFocus(`[data-pick="${lost[0]}"]`);
  }
  function invalidateTarget(which) { invalidateTargets([which],true); }
  function renderTarget(which) {
    const el = $(`[data-target="${which}"]`);
    const status = targetErrors[which] ? 'invalid' : String(state[which]);
    if (el.dataset.selected === status) return;
    el.dataset.selected = status;
    if (state[which]) {
      el.innerHTML = `<i class="target-check" data-lucide="check" aria-hidden="true"></i><span class="target-name"></span><button type="button" class="icon-button cursor-interaction" data-clear="${which}" aria-label="清除${which === 'play' ? '播放' : '标记'}按钮"><i data-lucide="x" aria-hidden="true"></i></button>`;
      el.querySelector('.target-name').textContent = which === 'play' ? playLabel : markLabel;
    } else {
      el.innerHTML = `<button type="button" class="select-target cursor-interaction${targetErrors[which] ? ' target-retry' : ''}" data-pick="${which}" aria-label="${which === 'play' ? '播放按钮' : '标记按钮'}：${targetErrors[which] ? '请重新选择' : '选择按钮'}"><i data-lucide="mouse-pointer-2" aria-hidden="true"></i>${targetErrors[which] ? '请重新选择' : '选择按钮'}</button>`;
    }
  }
  function renderKey() {
    const button = $('[data-action="record-key"]');
    button.setAttribute('aria-pressed',String(recording));
    $('[data-key-hint]').textContent = recording ? 'Esc 取消' : '标记按键';
    $('[data-action="clear-key"]').hidden = !state.customKey || recording;
    const label = $('.key-label'); label.replaceChildren();
    if (recording) label.textContent = pendingKey?.label || (heldModifiers.length ? heldModifiers.join(' + ') + ' + …' : '按下按键');
    else if (state.customKey) state.customKey.parts.forEach(part => { const key = document.createElement('kbd'); key.textContent = part; label.append(key); });
    else label.textContent = '点击录入';
  }
  function endRecording() { recording = false; pendingKey = null; heldModifiers = []; renderKey(); }
  const examples = {
    lrc: { text: '[00:01.20]明天一定\n[00:04.50]再往前走一步', note: '每行以开始时间标记。LRC 没有明确的句尾时间，适合「单击」。' },
    tsv: { text: 'start\tend\ttext\n1.2\t3.4\t明天一定\n4.5\t6.7\t再往前走一步', note: '三列分别是开始时间、结束时间和歌词。列之间用 Tab 分隔，时间单位为秒。' },
    srt: { text: '1\n00:00:01,200 --> 00:00:03,400\n明天一定\n\n2\n00:00:04,500 --> 00:00:06,700\n再往前走一步', note: '每段包含序号、起止时间和歌词。段落之间空一行。' },
    vtt: { text: 'WEBVTT\n\n00:01.200 --> 00:03.400\n明天一定\n\n00:04.500 --> 00:06.700\n再往前走一步', note: '首行写 WEBVTT，时间中的小数用点分隔。段落之间空一行。' },
    txt: { text: '[00:01.20]明天一定\n[00:04.50]再往前走一步', note: 'TXT 内容需要使用一种带时间的格式。这里用的是 LRC 写法；只有文字的歌词无法自动对齐。' }
  };
  function renderFormat() {
    const example = examples[state.format];
    $('.format-code').textContent = example.text;
    $('.format-note').textContent = example.note;
    $('#lp-format-content').setAttribute('aria-labelledby','lp-example-' + state.format);
    $$('[data-format]').forEach(button => {
      const selected = button.dataset.format === state.format;
      button.setAttribute('aria-selected',String(selected)); button.tabIndex = selected ? 0 : -1;
    });
  }
  function setLayer(selector,open) {
    const el = $(selector);
    const wasOpen = el.classList.contains('is-open');
    el.classList.toggle('is-open',open); el.inert = !open; el.setAttribute('aria-hidden',String(!open));
    if (!el.classList.contains('motion-layer')) return;
    if (open) {
      clearTimeout(layerTimers.get(el)); el.classList.remove('is-exiting');
    } else if (wasOpen) {
      clearTimeout(layerTimers.get(el)); el.classList.add('is-exiting');
      layerTimers.set(el,setTimeout(() => {
        el.classList.remove('is-exiting'); layerTimers.delete(el); syncAccess();
      },reduced ? 0 : 280));
    }
  }
  function setActive(selector,active) {
    const el = $(selector);
    el.classList.toggle('is-active',active); el.inert = !active; el.setAttribute('aria-hidden',String(!active));
  }
  function setFold(selector,open) { setLayer(selector,open); }
  function syncAccess() {
    const covered = $$('.motion-layer').some(el => el.classList.contains('is-open') || el.classList.contains('is-exiting'));
    const sheetCovered = ['.format-sheet'].some(selector => {
      const el = $(selector); return el.classList.contains('is-open') || el.classList.contains('is-exiting');
    });
    ['.file-head','.lyrics-body','.settings-wrap','.footer'].forEach(selector => $(selector).inert = covered || (selector === '.settings-wrap' && state.phase !== 'ready'));
    $('[data-action="more"]').disabled = sheetCovered;
  }
  function returnFocus(selector) {
    clearTimeout(returnFocusTimer);
    returnFocusTimer = setTimeout(() => {
      if (state.closed || state.minimized || $('.motion-layer.is-open')) return;
      $(selector)?.focus({preventScroll:true});
    },reduced ? 0 : 300);
  }
  function setFormats(open,focus = true) {
    setLayer('.format-sheet',open); syncAccess();
    if (open) { endRecording(); setMore(false); renderFormat(); if (focus) $('[data-action="close-formats"]').focus({preventScroll:true}); }
    else if (focus && !state.file) returnFocus('[data-action="open-formats"]');
  }
  function setPicker(open) {
    const banner = $('.pick-banner'); banner.classList.toggle('is-open',open); banner.inert = !open; banner.setAttribute('aria-hidden',String(!open));
    $('.panel-shell').classList.toggle('is-picking',open); $('.panel-shell').inert = open || state.closed;
  }
  function cancelPicking() { pickerCleanup?.(); pickerCleanup = null; const target = picking; picking = null; setPicker(false); if (target) returnFocus(`[data-pick="${target}"]`); }
  function chooseTarget(purpose) {
    if (state.phase !== 'ready') return;
    endRecording(); setMore(false); picking = purpose; setPicker(true);
    $('[data-pick-title]').textContent = purpose === 'play' ? '点击网页上的播放按钮' : '点击网页上的标记按钮';
    pickerCleanup = A.createPicker({excludeRoot:host,onPick(element) {
      pickerCleanup = null; picking = null; setPicker(false);
      try {
        const locator = A.makeLocator(element);
        const label = element.getAttribute('aria-label') || element.textContent.trim().slice(0,100) || element.getAttribute('title') || (purpose === 'play' ? '播放' : '标记');
        if (purpose === 'play') {playTarget = locator; playLabel = label;} else {markTarget = locator; markLabel = label;}
        session.watch(locator.document); targetErrors[purpose] = false; state[purpose] = true; render(); targetMonitor.refresh();
        returnFocus(`[data-clear="${purpose}"]`);
      } catch(e) { invalidateTarget(purpose); }
    },onCancel:() => {pickerCleanup = null; picking = null; setPicker(false); returnFocus(`[data-pick="${purpose}"]`);}});
    $('[data-action="cancel-pick"]').focus({preventScroll:true});
  }
  function renderAppearance() {
    root.dataset.theme = state.appearance === 'system' ? (systemTheme.matches ? 'dark' : 'light') : state.appearance;
    root.dataset.palette = state.palette;
    const segment = $('[data-group="appearance"]');
    segment.style.setProperty('--selected',['system','light','dark'].indexOf(state.appearance));
    segment.querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed',String(b.dataset.value === state.appearance)));
    $$('[data-palette-choice]').forEach(b => b.setAttribute('aria-pressed',String(b.dataset.paletteChoice === state.palette)));
  }
  systemTheme.addEventListener('change',renderAppearance);
  function renderMini() {
    $('.panel').classList.toggle('is-mini',state.minimized);
    $('.panel-full').inert = state.minimized;
    $('.panel-full').setAttribute('aria-hidden',String(state.minimized));
    const title = ({running:'正在对齐',paused:'已暂停',done:'对齐完成'})[state.phase] || 'LyricPilot';
    const status = $('.brand-status');
    if (status.textContent !== title) status.textContent = title;
    $('.brand-name').setAttribute('aria-hidden',String(state.minimized));
    status.setAttribute('aria-hidden',String(!state.minimized));
    const toggle = $('[data-action="toggle-panel"]');
    toggle.setAttribute('aria-label',state.minimized ? '展开面板' : '收起面板');
    toggle.setAttribute('aria-expanded',String(!state.minimized));
    panelPosition.layout();
    renderProtection();
  }
  function setMinimized(minimized) {
    clearTimeout(returnFocusTimer);
    endRecording(); setFormats(false,false); setMore(false); cancelPicking();
    state.minimized = minimized; renderMini();
    $('[data-action="toggle-panel"]').focus({preventScroll:true});
    if (state.phase !== 'ready') requestAnimationFrame(() => centerCurrent(false));
    persist();
  }
  function render() {
    renderAppearance();
    const reason = holdReason(state.file ? rangeInfo(state.cues) : null);
    const hold = $('[data-group="duration"] [data-value="hold"]');
    hold.disabled = !!reason;
    if (reason) state.duration = 'tap';
    const note = $('#lp-hold-reason');
    const showReason = state.file && !!reason;
    if (showReason) note.textContent = reason;
    setFold('.duration-wrap',showReason);
    if (showReason) hold.setAttribute('aria-describedby',note.id);
    else hold.removeAttribute('aria-describedby');
    const running = ['running','paused','done'].includes(state.phase);
    $('.panel').dataset.phase = state.phase;
    if (!running) { $('.lyric-list').style.paddingTop = ''; $('.lyric-list').style.paddingBottom = ''; }
    $('.file-name').textContent = state.file ? state.name : '歌词';
    setActive('.drop-area',!state.file);
    setActive('.lyric-viewport',state.file);
    $('[data-action="clear-file"]').hidden = !state.file || running;
    $('.count').hidden = !running;
    $('.count').textContent = `${Math.min(state.index + 1,state.cues.length)} / ${state.cues.length}`;
    $('.settings-wrap').classList.toggle('collapsed',running);
    $('.settings-wrap').inert = running;
    setFold('.run-wrap',running);
    if (running) $('[data-status]').textContent = ({running:'正在对齐',paused:'已暂停',done:'对齐完成'})[state.phase];
    setFold('.stop-slot',['running','paused'].includes(state.phase));
    const primary = $('.panel [data-action="primary"]');
    const label = {running:'暂停',paused:'继续对齐',done:'返回设置'}[state.phase] || '开始对齐';
    if (primary.dataset.phase !== state.phase) { primary.textContent = label; primary.dataset.phase = state.phase; }
    const markerReady = state.input === 'button' ? state.mark : state.input === 'space' || !!state.customKey;
    primary.disabled = !running && !(state.file && state.play && markerReady && !recording);
    $$('.offset-stepper input,.offset-stepper button').forEach(el => { el.disabled = running; });
    for (const group of ['input','duration']) {
      const segment = $(`[data-group="${group}"]`);
      const values = group === 'input' ? ['button','space','custom'] : ['tap','hold'];
      segment.style.setProperty('--selected',values.indexOf(state[group]));
      segment.querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed',String(b.dataset.value === state[group])));
    }
    $('.target-collapse').classList.toggle('closed',state.input === 'space');
    $('.target-collapse').inert = state.input === 'space';
    $('.target-collapse').setAttribute('aria-hidden',String(state.input === 'space'));
    if (state.input !== 'space') lastTargetInput = state.input;
    setActive('.marker-row',lastTargetInput === 'button');
    setActive('.key-row',lastTargetInput === 'custom');
    $$('.lyric-list li').forEach(el => el.classList.toggle('is-current',running && Number(el.dataset.index) === state.index));
    renderTarget('play'); renderTarget('mark'); renderKey();
    renderMini(); syncAccess();
    icons();
  }
  function setMore(open) {
    more = open; setLayer('.more-popover',open);
    $('[data-action="more"]').setAttribute('aria-expanded',String(open));
    syncAccess();
  }
  function showMessage(text) { $('.message').textContent = text || ''; $('.message').hidden = !text; }
  function resetReady() { state.index = 0; session.stop(); $('.lyric-viewport').scrollTop = 0; }
  function begin() {
    endRecording(); setFormats(false,false); setMore(false); cancelPicking();
    targetMonitor.refresh();
    if (!playTarget || (state.input === 'button' && !markTarget)) return;
    session.start({cues:state.cues,offset:state.offset,kind:state.input,duration:state.duration,key:state.customKey,playTarget,target:markTarget});
  }
  const lyricResize = new ResizeObserver(() => { if (['running','paused','done'].includes(state.phase)) centerCurrent(false); });
  lyricResize.observe($('.lyric-viewport'));
  function measurePanel() { const width = $('.panel-shell').getBoundingClientRect().width + 'px'; $('.panel').style.setProperty('--lp-expanded-width',width); }
  const panelResize = new ResizeObserver(measurePanel); panelResize.observe($('.panel-shell'));
  measurePanel();
  $('.settings-wrap').addEventListener('transitionend',() => {
    if (['running','paused','done'].includes(state.phase)) centerCurrent();
  });
  root.addEventListener('click',e => {
    const b = e.target.closest('button'); if (!b || b.disabled) return;
    const group = b.closest('[data-group]');
    if (group) { endRecording(); state[group.dataset.group] = b.dataset.value; render(); persist(); return; }
    if (b.dataset.paletteChoice) { state.palette = b.dataset.paletteChoice; renderAppearance(); persist(); return; }
    if (b.dataset.format) { state.format = b.dataset.format; renderFormat(); persist(); return; }
    if (b.dataset.clear) { targetErrors[b.dataset.clear] = false; if (b.dataset.clear === 'play') playTarget = null; else markTarget = null; state[b.dataset.clear] = false; render(); targetMonitor.refresh(); persist(); $(`[data-pick="${b.dataset.clear}"]`).focus({preventScroll:true}); return; }
    if (b.dataset.pick) { chooseTarget(b.dataset.pick); return; }
    const action = b.dataset.action;
    if (action === 'close-extension') {
      panelPosition.finish();
      clearTimeout(returnFocusTimer); session.stop(); cancelPicking(); endRecording(); setMore(false); setFormats(false,false);
      state.closed = true; render(); return;
    }
    if (action === 'open-formats') { setFormats(true); return; }
    if (action === 'close-formats') { setFormats(false); return; }
    if (action === 'record-key') {
      if (recording) endRecording();
      else { recording = true; pendingKey = null; heldModifiers = []; }
      render(); b.focus({preventScroll:true}); return;
    }
    if (action === 'clear-key') { endRecording(); state.customKey = null; render(); persist(); $('[data-action="record-key"]').focus({preventScroll:true}); return; }
    if (action === 'clear-file') { session.stop(); state.file = false; state.cues = []; importVersion++; state.phase = 'ready'; fillLines(); render(); persist(); $('.drop-area input').focus({preventScroll:true}); }
    if (action === 'more') setMore(!more);
    if (action === 'primary') {
      try {
        if (state.phase === 'running') session.pause();
        else if (state.phase === 'paused') session.resume();
        else if (state.phase === 'done') resetReady();
        else begin();
      } catch(e) { showMessage(e.message); }
    }
    if (action === 'stop') resetReady();
    if (action === 'toggle-panel') setMinimized(!state.minimized);
    if (action === 'cancel-pick') cancelPicking();
    if (action?.startsWith('offset-')) updateOffset(state.offset + (action === 'offset-plus' ? .1 : -.1));
  });
  function handleEscape() {
    if (recording) { endRecording(); render(); }
    else if ($('.format-sheet').classList.contains('is-open')) setFormats(false);
    else if (picking) cancelPicking();
    else if (more) { setMore(false); returnFocus('[data-action="more"]'); }
    else if (state.phase === 'running') session.pause();
  }
  function updateOffset(value,formatInput = true) {
    state.offset = Math.max(-10,Math.min(10,Math.round((Number(value)||0)*10)/10));
    if (formatInput) $('.offset-stepper input').value = state.offset.toFixed(1);
    renderTimes(); persist();
  }
  $('.offset-stepper input').addEventListener('input',e => { if (e.target.value !== '' && Number.isFinite(e.target.valueAsNumber)) updateOffset(e.target.value,false); });
  $('.offset-stepper input').addEventListener('change',e => updateOffset(e.target.value));
  function modifierNames(e) {
    return [['ctrlKey','Ctrl'],['altKey','Alt'],['shiftKey','Shift'],['metaKey','⌘']].filter(([flag]) => e[flag]).map(([,name]) => name);
  }
  function keyBinding(e) {
    const names = { ' ':'Space',ArrowUp:'↑',ArrowDown:'↓',ArrowLeft:'←',ArrowRight:'→',Enter:'Enter',Backspace:'Backspace',Delete:'Delete' };
    const name = names[e.key] || (e.key.length === 1 ? e.key.toUpperCase() : e.key);
    const parts = [...modifierNames(e),name];
    return {key:e.key,code:e.code,keyCode:e.keyCode,ctrlKey:e.ctrlKey,altKey:e.altKey,shiftKey:e.shiftKey,metaKey:e.metaKey,parts,label:parts.join(' + ')};
  }
  root.addEventListener('keydown',e => {
    if (recording) {
      e.preventDefault(); e.stopImmediatePropagation();
      if (e.key === 'Escape') { endRecording(); render(); return; }
      if (e.repeat || e.isComposing || ['Dead','Process','Unidentified'].includes(e.key)) return;
      heldModifiers = modifierNames(e);
      if (!['Control','Alt','Shift','Meta','AltGraph'].includes(e.key)) pendingKey = keyBinding(e);
      renderKey(); return;
    }
    if (e.target.matches('[data-format]') && ['ArrowLeft','ArrowRight','Home','End'].includes(e.key)) {
      e.preventDefault(); e.stopPropagation();
      const tabs = $$('[data-format]'), index = tabs.indexOf(e.target);
      const next = e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : (index + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
      state.format = tabs[next].dataset.format; renderFormat(); tabs[next].focus(); return;
    }
    if (e.key === 'Escape') {
      e.preventDefault(); e.stopImmediatePropagation();
      handleEscape();
    }
  },true);
  root.addEventListener('keyup',e => {
    if (!recording) return;
    e.preventDefault(); e.stopImmediatePropagation();
    if (pendingKey && e.code === pendingKey.code) {
      state.customKey = pendingKey; endRecording(); render(); persist();
    } else { heldModifiers = modifierNames(e); renderKey(); }
  },true);
  root.addEventListener('focusout',e => { if (recording && !e.relatedTarget?.closest('[data-action="record-key"]')) { endRecording(); render(); } });
  const stopRecordingOnBlur = () => { if (recording) { endRecording(); render(); } };
  window.addEventListener('blur',stopRecordingOnBlur);
  root.addEventListener('pointerdown',e => { if (more && !e.target.closest('.more-popover,[data-action="more"]')) setMore(false); });
  async function importFile(file) {
    if (!file || state.phase !== 'ready') return;
    const version = ++importVersion;
    if (file.size > 3*1024*1024) { $('.message').textContent = '请选择小于 3 MB 的歌词文件'; $('.message').hidden = false; return; }
    try {
      const text = await file.text();
      if (version !== importVersion || state.phase !== 'ready' || state.closed) return;
      const parsed = C.parseLyrics(text, file.name);
      if (parsed.metadata.format === 'unsupported') throw new Error(parsed.warnings[0]);
      if (parsed.cues.length > 3000) throw new Error('一次最多导入 3000 句');
      if (!parsed.cues.length) throw new Error('没有找到带时间标记的歌词，请检查文件');
      state.cues = parsed.cues.map(({text,start,end}) => ({text,start,end})); state.name = file.name.replace(/\.[^.]+$/,''); state.file = true; state.index = 0;
      showMessage(parsed.warnings.filter(warning => !warning.includes('没有明确结束时间') && !warning.includes('时间重叠')).join('；'));  fillLines(); state.phase = 'ready'; state.minimized = false; render(); $('.lyric-viewport').scrollTop = 0;
    } catch (error) { if (version !== importVersion) return; $('.message').textContent = error.message || '读取失败，请重新选择文件'; $('.message').hidden = false; }
  }
  $('.drop-area input').addEventListener('change',e => { importFile(e.target.files[0]); e.target.value = ''; });
  const drop = $('.drop-area');
  drop.addEventListener('dragover',e => { e.preventDefault(); drop.classList.add('dragging'); });
  drop.addEventListener('dragleave',() => drop.classList.remove('dragging'));
  drop.addEventListener('drop',e => { e.preventDefault(); drop.classList.remove('dragging'); importFile(e.dataTransfer.files[0]); });
  const inputLock = globalThis.LyricPilotInputLock(host,shadow,handleEscape,cursorHint);
  const session = new globalThis.LyricPilotSession(change => {
    if (change.phase) {
      const changed = state.phase !== change.phase;
      state.phase = change.phase;
      showMessage(change.message); render();
      if (changed) requestAnimationFrame(() => {
        centerCurrent(false);
        const button = state.minimized ? $('[data-action="toggle-panel"]') : $('.panel [data-action="primary"]');
        button.focus({preventScroll:true});
      });
    }
    if (change.targetError) invalidateTarget(change.targetError);
    if (Number.isInteger(change.index)) {
      state.index = change.index; render(); centerCurrent();
    }
  },doc=>inputLock.watch(doc));
  const targetMonitor = globalThis.LyricPilotTargetMonitor({
    document,excludeRoot:host,getTargets:() => ({play:playTarget,mark:markTarget}),
    onInvalid:names => invalidateTargets(names)
  });
  const panelPosition = globalThis.LyricPilotPanelPosition({
    shell:$('.panel-shell'),panel:$('.panel'),handle:$('.panel-drag'),
    isMini:() => state.minimized,onChange:persist
  });
  function preferences(saved) {
    if (['system','light','dark'].includes(saved?.appearance)) state.appearance = saved.appearance;
    if (['green','blue','purple','orange'].includes(saved?.palette)) state.palette = saved.palette;
    panelPosition.restore(saved?.position);
    renderAppearance();
  }
  fillLines(); render();
  if (globalThis.chrome?.storage?.local) chrome.storage.local.get(['lyricPilotPreferences','autoLyricsPreferences']).then(result=>{preferences(result.lyricPilotPreferences || result.autoLyricsPreferences);persist();}).catch(()=>{});
  else preferences(globalThis.__lyricPilotPreferences);
  globalThis.__lyricPilotPanel = {show() {state.closed = false; state.minimized = false; render(); $('[data-action="toggle-panel"]').focus({preventScroll:true});}};
  window.addEventListener('pagehide',()=>{
    state.closed = true; importVersion++;
    panelPosition.destroy();targetMonitor.destroy();session.destroy();inputLock.destroy();cancelPicking();
    lyricResize.disconnect(); panelResize.disconnect();
    systemTheme.removeEventListener('change',renderAppearance); motionPreference.removeEventListener('change',updateMotion);
    window.removeEventListener('blur',stopRecordingOnBlur);
    clearTimeout(returnFocusTimer); clearTimeout(cursorTimer); layerTimers.forEach(clearTimeout); layerTimers.clear();
    host.remove();delete globalThis.__lyricPilotPanel;
  },{once:true});
  requestAnimationFrame(() => requestAnimationFrame(() => root.removeAttribute('data-initializing')));
})();

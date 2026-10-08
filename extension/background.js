'use strict';
const panelFiles = ['core.js','actions.js','media-binding.js','page-clock.js','icons.js','panel-style.js','panel-template.js','input-lock.js','panel-position.js','target-monitor.js','session.js','content.js'];
const opening = new Set();
chrome.action.onClicked.addListener(async tab => {
  if (tab.id == null || opening.has(tab.id)) return;
  opening.add(tab.id);
  try {
    if (!/^https?:\/\//.test(tab.url || '')) throw new Error('请在普通网页中使用 LyricPilot');
    const url = new URL(tab.url);
    if (/^(www\.)?distrokid\.com$/.test(url.hostname) && /^\/potato\/?$/.test(url.pathname)) {
      await chrome.scripting.executeScript({target:{tabId:tab.id},world:'MAIN',files:['page-clock-main.js']});
    }
    await chrome.scripting.executeScript({target:{tabId:tab.id},files:panelFiles});
    await chrome.action.setBadgeText({tabId:tab.id,text:''});
    await chrome.action.setTitle({tabId:tab.id,title:'打开 LyricPilot'});
  } catch (_) {
    await chrome.action.setBadgeText({tabId:tab.id,text:'!'});
    await chrome.action.setBadgeBackgroundColor({tabId:tab.id,color:'#A03A30'});
    await chrome.action.setTitle({tabId:tab.id,title:'当前页面无法打开 LyricPilot，请切换到普通网页后重试'});
  } finally { opening.delete(tab.id); }
});

'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
function setup(fail=false){
 let click;const calls=[];
 const chrome={action:{onClicked:{addListener(fn){click=fn;}},setBadgeText:async arg=>calls.push(['badge',arg]),setTitle:async arg=>calls.push(['title',arg]),setBadgeBackgroundColor:async arg=>calls.push(['color',arg])},
 scripting:{executeScript:async arg=>{calls.push(['inject',arg]);if(fail)throw new Error('restricted');}}};
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../extension/background.js'),'utf8'),{chrome});
 return {click,calls};
}
test('toolbar action injects the panel directly, without a popup or second click',async()=>{
 const manifest=JSON.parse(fs.readFileSync(path.join(__dirname,'../extension/manifest.json'),'utf8'));
 assert.equal(manifest.action.default_popup,undefined);assert.equal(manifest.background.service_worker,'background.js');
 const h=setup();await h.click({id:7,url:'https://music.example/edit'});
 const injection=h.calls.find(c=>c[0]==='inject')[1];assert.equal(injection.target.tabId,7);assert.equal(injection.files.at(-1),'content.js');
 for(const file of injection.files)assert.ok(fs.existsSync(path.join(__dirname,'../extension',file)));
 assert.equal(h.calls.at(-1)[1].title,'打开 LyricPilot');
});
test('restricted pages report an action tooltip and never open another page',async()=>{
 const h=setup();await h.click({id:7,url:'chrome://extensions'});assert.ok(h.calls.every(c=>c[0]!=='inject'));assert.equal(h.calls[0][1].text,'!');
 const r=setup(true);await r.click({id:8,url:'https://blocked.example'});assert.match(r.calls.at(-1)[1].title,/当前页面无法打开/);
});

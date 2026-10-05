/** Recipient projection and original gates in an isolated DOM. No browser/CU. */
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import path from 'node:path';
import vm from 'node:vm';
import {build} from 'esbuild';
const root=path.resolve(import.meta.dirname,'..');
const require=createRequire(path.join(root,'artifacts/ccgui-compat/ccgui-host-src/package.json'));
const {JSDOM}=require('jsdom');
const dom=new JSDOM('<html><body><div id="route"><span id="summary"></span><button id="change"></button><div id="picker"><select id="workspace"></select><select id="target"></select></div></div><p id="notice"></p></body></html>',{url:'http://localhost/'});
dom.window.HTMLDialogElement.prototype.showModal=function(){this.open=true;};
dom.window.HTMLDialogElement.prototype.close=function(){this.open=false;this.dispatchEvent(new dom.window.Event('close'));};
const bundle=await build({stdin:{contents:"export * from './src/canvas-recipient'; export {setLocale} from './src/i18n';",resolveDir:root,loader:'ts'},bundle:true,write:false,format:'cjs',platform:'browser',define:{'import.meta.env':'{}'}});
const module={exports:{}};
vm.runInContext(bundle.outputFiles[0].text,vm.createContext({module,exports:module.exports,window:dom.window,document:dom.window.document,navigator:dom.window.navigator,localStorage:dom.window.localStorage,Event:dom.window.Event,CustomEvent:dom.window.CustomEvent,console,setTimeout,clearTimeout}));
const api=module.exports;api.setLocale('zh-CN');
const a='42345678-1234-4234-8234-123456789abc',b='52345678-1234-4234-8234-123456789abc';
const binding={source_id:'codex:'+a,thread_id:a,cwd:'G:/P',label:'真实 Codex 任务',protocol_agent:'codex',bound_at_ms:1};
const pin={source_id:'claude:'+b,native_session_id:b,gui_session_id:b,cwd:'G:/P',engine:'claude',client:'ccgui',client_instance_id:'instance',window_id:'window-1',lease_id:'lease-1',generation:1};
let hosts=[{host_pin:pin,label:'CC GUI · '+b.slice(0,8),capabilities:['canvas_requests','durable_receipts'],reachable:true,active:true,last_seen_ms:1,expires_at_ms:2}];
const board={nodes:[],replies:[],canvas:{objects:[
  {id:'codex',source_id:binding.source_id,content:{type:'text',title:'原 Codex 内容'}},
  {id:'claude',source_id:pin.source_id,origin:{source_id:pin.source_id,thread_id:b,cwd:'G:/P'},content:{type:'text',title:'原 Claude 内容'}},
  {id:'free',content:{type:'text',title:'新内容'}}
]}};
let blocked=true,checked='available';const doc=dom.window.document,select=doc.querySelector('#target'),workspace=doc.querySelector('#workspace');
const control=new api.CanvasRecipient(select,workspace,doc.querySelector('#notice'),async target=>({...target,status:checked,message:'',checked_at_ms:Date.now()}),value=>{blocked=value;},
  {root:doc.querySelector('#route'),summary:doc.querySelector('#summary'),toggle:doc.querySelector('#change'),picker:doc.querySelector('#picker')});
const paint=id=>control.update(board,{object_id:id,object_ids:[id],anchors:[{object_id:id}]},[binding],[],hosts);
const settle=async()=>{await new Promise(setImmediate);await new Promise(setImmediate);};

assert.equal(api.recipientClient(binding,[binding]),'codex');
assert.equal(api.recipientClient({...binding,source_id:a},[binding]),'codex');
assert.equal(api.recipientClient({...binding,thread_id:b},[binding]),undefined);
assert.equal(api.recipientClient({source_id:'claude:'+b,thread_id:b,label:'x',host_pin:pin},[binding]),'claude');
assert.equal(api.recipientClient({source_id:'claude:'+b,thread_id:a,label:'x'},[binding]),undefined);
assert.equal(api.recipientClient({...binding,source_id:'model:codex'},[]),undefined);
for(const label of ['codex-'+a.slice(0,8),'Codex·'+a,'Codex · '+a.slice(0,8)]) assert.equal(api.readableRecipientLabel({...binding,label}),'');
assert.equal(api.readableRecipientLabel({...binding,label:'Codex 设计讨论'}),'Codex 设计讨论');
for(const label of [b,'Claude Code·'+b])assert.equal(api.readableRecipientLabel({source_id:'claude:'+b,label}),'');
const inconsistent={source_id:'claude:'+b,thread_id:a,label:b};assert.equal(api.recipientClient(inconsistent),undefined);assert.equal(api.readableRecipientLabel(inconsistent),'');assert.equal(inconsistent.thread_id,a);

paint('codex');await settle();assert.equal(control.target().source_id,binding.source_id);assert.equal(blocked,false);
assert.match(doc.querySelector('#summary').textContent,/发送到：Codex.*真实 Codex 任务/);assert.doesNotMatch(doc.querySelector('#summary').textContent,/G:\/P|42345678/);
assert.doesNotMatch(doc.querySelector('#summary').title,/G:\/P|42345678/);
assert.doesNotMatch(workspace.title,/G:\/P/);assert.ok([...workspace.options].every(option=>!option.textContent.includes('G:/P')&&!option.title.includes('G:/P')));
assert.ok([...select.options].every(option=>!option.title.includes('G:/P')&&!option.title.includes(a)&&!option.title.includes(b)));
const recipientDetails=doc.querySelector('[data-recipient-diagnostics]');assert.equal(recipientDetails.open,false);assert.ok(recipientDetails.textContent.includes(a));assert.ok(recipientDetails.textContent.includes('G:/P'));
assert.deepEqual([...select.querySelectorAll('optgroup')].map(x=>x.label),['Codex','Claude Code']);
doc.querySelector('#change').click();select.value=pin.source_id;select.dispatchEvent(new dom.window.Event('change'));await settle();
assert.equal(control.target().source_id,binding.source_id);assert.match(doc.querySelector('#summary').textContent,/发送到：Codex/);assert.equal(blocked,true);
const confirmation=doc.querySelector('.recipient-confirm');assert.ok([...confirmation.querySelectorAll('.recipient-diagnostics')].every(details=>details.open===false));assert.ok(confirmation.querySelector('.recipient-diagnostics').textContent.includes(a));
doc.querySelector('.recipient-confirm .primary').click();await settle();
assert.equal(control.target().source_id,pin.source_id);assert.match(doc.querySelector('#summary').textContent,/发送到：Claude Code/);assert.doesNotMatch(doc.querySelector('#summary').textContent,/52345678|CC GUI ·/);assert.equal(blocked,false);
control.resetChoice();paint('claude');await settle();assert.equal(control.target().source_id,pin.source_id);
hosts=[];paint('claude');await settle();assert.equal(control.target().source_id,pin.source_id);assert.equal(blocked,true);assert.match(doc.querySelector('#summary').textContent,/Claude Code/);
control.resetChoice();hosts=[{host_pin:pin,label:'CC GUI · '+b.slice(0,8),capabilities:['canvas_requests','durable_receipts'],reachable:true,active:true}];paint('free');await settle();assert.equal(control.target().source_id,pin.source_id);assert.equal(blocked,false);
hosts.push({...hosts[0],host_pin:{...pin,window_id:'window-2',lease_id:'lease-2'}});paint('free');await settle();assert.equal(control.target(),undefined);assert.equal(blocked,true);
control.resetChoice();checked='unknown';paint('codex');control.refresh();await settle();assert.equal(control.target().source_id,binding.source_id);assert.equal(blocked,true);
await assert.rejects(control.verify());
api.setLocale('en');paint('codex');assert.match(doc.querySelector('#summary').textContent,/Send to: Codex/);
console.log(JSON.stringify({pass:true,checks:12,method:'Actual recipient class in isolated DOM; same target choice and send gates; no CU or browser automation'}));

/** Isolated UI checks: no real Codex conversation, user data or desktop pipe is touched. */
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {homedir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {mkdir, writeFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {build} from 'esbuild';
const require=createRequire(import.meta.url);
let playwright;try{playwright=require('playwright');}catch{playwright=require(path.join(homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));}
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),out=path.join(root,'artifacts/new-chat-ui');
await mkdir(out,{recursive:true});
const bundle=await build({stdin:{contents:'import "./src/styles.css"; import "./src/board-workspace.css"; import "./src/theme.css"; export * from "./src/canvas-new-chat"; export { replyDrafts, draftKey } from "./src/reply-drafts";',resolveDir:root},bundle:true,write:false,format:'esm',outfile:'fixture.js',define:{'import.meta.env':'{}'}});
const files=new Map(bundle.outputFiles.map(file=>[path.basename(file.path),file.text]));
const server=createServer((req,res)=>{const file=req.url.slice(1);res.setHeader('Content-Type',file.endsWith('.css')?'text/css':'text/javascript');res.end(files.get(file)||'');});
await new Promise(resolve=>server.listen(47324,'127.0.0.1',resolve));
const browser=await playwright.chromium.launch({channel:'chrome',headless:true,timeout:15000});let page;const errors=[];const results=[];
try{
  page=await browser.newPage({viewport:{width:1440,height:900}});
  page.setDefaultTimeout(10000);
  await page.route('**/*',route=>{const url=new URL(route.request().url());if(url.origin!=='http://127.0.0.1:47324')return route.abort();return route.continue();});
  await page.route('http://127.0.0.1:47324/new-chat-fixture',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><html><head><link rel="stylesheet" href="/fixture.css"></head><body><button id="start">选择任务</button></body></html>'}));
  page.on('pageerror',error=>errors.push(String(error)));
  await page.goto('http://127.0.0.1:47324/new-chat-fixture');
  await page.evaluate(async()=>{
    localStorage.setItem('spellcast.locale','zh-CN');
    document.body.dataset.theme='light';
    const module=await import('/fixture.js');
    window.calls=[];window.done=[];window.rejectOpen=false;window.deferLoad=false;
    window.show=()=>module.showNewChatDialog({text:'分析这个规则 <img src=x onerror="window.injected=1">',workspaces:[{path:'G:/Old',label:'已接入工作区'}],
      load:()=>window.deferLoad?new Promise(resolve=>{window.resolveLoad=resolve;}):Promise.resolve([{path:'G:/Game',label:'游戏工作区',project_id:'game'}]),
      open:async workspace=>{window.calls.push(workspace);if(window.rejectOpen)throw new Error('目录已变化，草稿保留');await new Promise(resolve=>setTimeout(resolve,100));return {context_path:'C:/fixture/context.json',status:'draft_open_requested'};},done:result=>window.done.push(result)});
    document.querySelector('#start').onclick=()=>void window.show();
  });
  await page.click('#start');await page.waitForSelector('#new-chat-workspace option[value="0"]',{state:'attached'});
  await page.waitForFunction(()=>document.querySelector('#new-chat-workspace').textContent.includes('游戏工作区'));
  assert.equal(await page.locator('#canvas-new-chat .primary').isDisabled(),true);
  await page.selectOption('#new-chat-workspace','0');assert.equal(await page.evaluate(()=>window.calls.length),0);
  assert.equal(await page.locator('#new-chat-request').inputValue(),'分析这个规则 <img src=x onerror="window.injected=1">');
  assert.equal(await page.evaluate(()=>window.injected),undefined);
  await page.screenshot({path:path.join(out,'workspace-choice.png')});
  await page.click('#canvas-new-chat .primary');await page.waitForSelector('#canvas-new-chat',{state:'detached'});
  assert.deepEqual(await page.evaluate(()=>window.calls),[{path:'G:/Game',label:'游戏工作区',project_id:'game'}]);results.push('选择工作区不提交；明确打开才传递所选项目');
  await page.click('#start');await page.waitForFunction(()=>document.querySelector('#new-chat-workspace').textContent.includes('游戏工作区'));
  await page.selectOption('#new-chat-workspace','other');await page.fill('#new-chat-path','G:/Other & 中文');
  await page.evaluate(()=>window.rejectOpen=true);await page.click('#canvas-new-chat .primary');
  await page.waitForFunction(()=>document.querySelector('.new-chat-status').textContent.includes('目录已变化'));
  assert.equal(await page.locator('#new-chat-path').inputValue(),'G:/Other & 中文');assert.equal(await page.locator('#new-chat-request').inputValue(),'分析这个规则 <img src=x onerror="window.injected=1">');
  await page.keyboard.press('Escape');assert.equal(await page.locator('#canvas-new-chat').count(),0);results.push('手动目录和失败提示保留请求；取消不产生新对话');
  await page.evaluate(()=>{window.deferLoad=true;window.rejectOpen=false;});await page.click('#start');await page.selectOption('#new-chat-workspace','other');await page.fill('#new-chat-path','G:/Chosen');
  await page.evaluate(()=>window.resolveLoad([{path:'G:/Late',label:'稍后返回的工作区'}]));await page.waitForTimeout(30);
  assert.equal(await page.locator('#new-chat-workspace').inputValue(),'other');assert.equal(await page.locator('#new-chat-path').inputValue(),'G:/Chosen');results.push('异步工作区列表不会覆盖用户刚选的目录');
  await page.setViewportSize({width:390,height:844});await page.screenshot({path:path.join(out,'narrow-dialog.png')});
  const bounds=await page.locator('#canvas-new-chat').boundingBox();assert(bounds.x>=0&&bounds.x+bounds.width<=391);results.push('390px 窄窗内可完整操作');
  // Exercise the real draft store and desktop handoff adapter, with isolated IPC.
  // The file/open boundary is simulated; no real Codex task is created.
  for(const failure of ['none','read','write','corrupt','full','native']){
    await page.reload();
    await page.evaluate(async failure=>{
      localStorage.clear();localStorage.setItem('spellcast.locale','zh-CN');
      const module=await import('/fixture.js'),key='spellcast.reply-drafts.v1';
      const anchors=[{object_id:'selected-rule',content_revision:4,annotations:[{id:'review-note',revision:2}]}];
      const draft={source_id:'canvas',reply_id:'canvas:selected-rule',reply_title:'规则',block_id:'canvas',block_type:'text',kind:'ask',channel:'composer',expected_revision:4,updated_at:1,anchors,text:'检查这些哪些需要清理合并，帮我处理一下吧'};
      if(failure==='corrupt')localStorage.setItem(key,'{invalid saved draft');
      if(failure==='full')localStorage.setItem(key,JSON.stringify(Array.from({length:96},(_,i)=>({...draft,source_id:`saved-${i}`}))));
      const get=Storage.prototype.getItem,set=Storage.prototype.setItem;
      window.savedBefore=get.call(localStorage,key);
      if(failure==='read')Storage.prototype.getItem=function(k){if(k===key)throw new DOMException('Storage unavailable','SecurityError');return get.call(this,k);};
      if(['write','native'].includes(failure))Storage.prototype.setItem=function(k,v){if(k===key)throw new DOMException('Storage full','QuotaExceededError');return set.call(this,k,v);};
      const input=document.createElement('textarea');input.id='original-request';input.value=draft.text;document.body.append(input);
      window.nativeCalls=[];window.done=[];window.notice='';
      window.__TAURI_INTERNALS__={invoke:async(command,args)=>{
        if(command!=='open_canvas_new_chat')throw new Error(`Unexpected IPC: ${command}`);
        window.nativeCalls.push(structuredClone(args));
        await new Promise(resolve=>{window.releaseNative=resolve;});
        if(failure==='native')throw new Error('无法保存新对话上下文：磁盘不可写');
        return {context_path:'C:/fixture/durable-context.json',status:'draft_open_requested'};
      }};
      window.draftState=()=>({pending:module.replyDrafts.hasUnpersisted,error:module.replyDrafts.lastError,held:module.replyDrafts.get(module.draftKey(draft))?.text,saved:get.call(localStorage,key)});
      await module.showNewChatDialog({text:draft.text,workspaces:[{path:'G:/Game',label:'游戏工作区'}],preferredPath:'G:/Game',load:async()=>[],
        open:workspace=>module.openCanvasNewChat(workspace,input.value,anchors,draft),
        done:result=>{window.done.push(result);window.notice=module.newChatText(result.draft_saved===false?'openedWithBackup':'opened');}});
    },failure);
    await page.click('#canvas-new-chat .primary');
    await page.waitForFunction(()=>window.nativeCalls.length===1);
    assert.equal(await page.locator('#canvas-new-chat .primary').isDisabled(),true);
    assert.deepEqual(await page.evaluate(()=>window.done),[],'Never report success before native file/open completion');
    await page.evaluate(()=>window.releaseNative());
    const expected='检查这些哪些需要清理合并，帮我处理一下吧';
    assert.equal(await page.locator('#original-request').inputValue(),expected);
    assert.deepEqual(await page.evaluate(()=>window.nativeCalls[0].req),{workspace:{path:'G:/Game',label:'游戏工作区'},text:expected,anchors:[{object_id:'selected-rule',content_revision:4,annotations:[{id:'review-note',revision:2}]}]});
    if(failure==='native'){
      await page.waitForFunction(()=>document.querySelector('.new-chat-status')?.textContent.includes('磁盘不可写'));
      assert.deepEqual(await page.evaluate(()=>window.done),[]);
      assert.equal(await page.locator('#new-chat-request').inputValue(),expected);
      assert.equal(await page.locator('#canvas-new-chat .primary').isEnabled(),true);
      results.push('文件备份失败时保留弹窗与原输入，不报告已打开');
    }else{
      await page.waitForSelector('#canvas-new-chat',{state:'detached'});
      const result=await page.evaluate(()=>({done:window.done,notice:window.notice,state:window.draftState(),before:window.savedBefore}));
      assert.equal(result.done[0].context_path,'C:/fixture/durable-context.json');
      assert.equal(result.done[0].draft_saved,failure==='none');
      assert.equal(result.state.held,expected);
      if(failure==='none'){assert.equal(result.state.pending,false);assert.match(result.notice,/草稿已保留/);}
      else{assert.equal(result.state.pending,true);assert.match(result.notice,/已备份/);assert.doesNotMatch(result.notice,/草稿已保留/);assert.equal(result.state.saved,result.before);}
      results.push(`草稿缓存 ${failure}：原请求和注释引用完整到达桌面备份，保存状态如实显示`);
    }
  }
  assert.deepEqual(errors,[]);await writeFile(path.join(out,'report.json'),JSON.stringify({results,errors,boundary:'Isolated browser fixture; no actual Codex creation or send.'},null,2));
  console.log(JSON.stringify({passed:results.length,results,artifacts:out}));
}finally{await browser.close();await new Promise(resolve=>server.close(resolve));}

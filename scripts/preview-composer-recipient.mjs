/** Browser Use acceptance surface: current frontend, isolated API, no production connection. */
import { createServer } from 'node:http';
import { build } from 'vite';
import fs from 'node:fs';
import path from 'node:path';
const root=path.resolve(import.meta.dirname,'..');
const output=path.join(root,'artifacts/workbench-20260914',`browser-recipient-${Date.now()}`);
const dist=path.join(output,'dist'); fs.mkdirSync(output,{recursive:true});
const bindings=[
  {source_id:'fixture-a',thread_id:'11111111-1111-4111-8111-111111111111',cwd:'G:/BrowserAcceptance/Library',label:'借用规则任务'},
  {source_id:'fixture-a2',thread_id:'33333333-3333-4333-8333-333333333333',cwd:'G:/BrowserAcceptance/Library',label:'库存整理任务'},
  {source_id:'fixture-b',thread_id:'22222222-2222-4222-8222-222222222222',cwd:'G:/BrowserAcceptance/Repair',label:'报修流程任务'},
];
const object={id:'browser-fixture-card',source_id:'fixture-a',content_revision:1,content:{type:'text',title:'借用规则（浏览器测试）',text:'借用期限为7天，归还时检查工具。此卡片是隔离测试数据。'},origin:{source_id:'fixture-a',thread_id:bindings[0].thread_id,cwd:bindings[0].cwd,label:bindings[0].label},bindings:[],user_edited:false};
const board={topic:'Browser Use acceptance',form:'spatial',form_reason:'',nodes:[],edges:[],messages:[],replies:[],canvas:{revision:1,objects:[object],items:[{item_id:object.id,revision:1,x:80,y:60,width:460,height:280,z:0,removed:false,appearance:'card'}],compositions:[],proposals:[]}};
const feedback={bindings,deliveries:[],pending:[]};
const evidence={method:'Browser Use against the current frontend with isolated API fixtures; no native Codex dispatch',submissions:[],unexpected:[],buildOutput:dist};
const persist=()=>fs.writeFileSync(path.join(output,'evidence.json'),JSON.stringify(evidence,null,2));
const server=createServer(async(req,res)=>{
  const url=new URL(req.url,'http://127.0.0.1');
  res.setHeader('Content-Security-Policy',"default-src 'self' data: blob:; connect-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; worker-src 'self' blob:");
  if(url.pathname==='/__acceptance'){
    res.setHeader('Content-Type','text/html;charset=utf-8');
    const escaped=JSON.stringify(evidence,null,2).replace(/[&<>]/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[ch]));
    res.end(`<html><title>隔离发送记录</title><h1>Browser Use 隔离发送记录</h1><p>没有发送到真实 Codex 任务。</p><pre>${escaped}</pre></html>`);return;
  }
  if(url.pathname.startsWith('/api/')){
    let body={};try{let raw='';for await(const chunk of req)raw+=chunk;if(raw)body=JSON.parse(raw);}catch{res.writeHead(400);res.end('{}');return;}
    const name=req.method+' '+url.pathname;let value;
    if(name==='GET /api/board')value=board;
    else if(name==='GET /api/forms')value={forms:[{id:'spatial',label:'空间',blurb:''}]};
    else if(name==='GET /api/health'||name==='POST /api/surface')value={surface:'focus',port:server.address().port,calls:0,sources:bindings.map(b=>({id:b.source_id,label:b.label})),observer_enabled:false};
    else if(name==='GET /api/events')value={events:[],last_seq:0};
    else if(name==='GET /api/feedback')value=feedback;
    else if(name==='GET /api/memories')value={memories:[]};
    else if(name==='GET /api/observer/status')value={enabled:false,paused:false,allowed:false,reason:'isolated browser test',policy_revision:1};
    else if(name==='POST /api/task-target'){
      const binding=bindings.find(b=>b.source_id===body.source_id);
      value={...binding,status:binding?'available':'unlinked',checked_at_ms:Date.now(),message:''};
    }else if(name==='POST /api/say'){
      const target=bindings.find(b=>b.source_id===body.source_id&&b.thread_id===body.target_thread_id);
      if(!target){res.writeHead(400);res.end(JSON.stringify({error:'Fixture recipient mismatch'}));return;}
      evidence.submissions.push({at:new Date().toISOString(),...body});persist();
      value={...body,seq:100+evidence.submissions.length,kind:'say',at_ms:Date.now()};
    }else{evidence.unexpected.push(name);persist();res.writeHead(400);res.end(JSON.stringify({error:'Unsupported isolated test request'}));return;}
    res.setHeader('Content-Type','application/json');res.end(JSON.stringify(value));return;
  }
  const filename=path.resolve(dist,'.'+(url.pathname==='/'?'/index.html':url.pathname));
  if(!filename.startsWith(dist+path.sep)||!fs.existsSync(filename)){res.writeHead(404);res.end();return;}
  const ext=path.extname(filename);res.setHeader('Content-Type',({'.js':'text/javascript','.css':'text/css','.woff2':'font/woff2','.svg':'image/svg+xml'})[ext]||'text/html;charset=utf-8');
  let content=fs.readFileSync(filename);
  if(ext==='.html')content=content.toString().replace('<head>','<head><script>localStorage.setItem("spellcast.locale","zh-CN");localStorage.setItem("spellcast.mode","focus");</script>');
  res.end(content);
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin=`http://127.0.0.1:${server.address().port}`;
await build({root,logLevel:'error',define:{'import.meta.env.VITE_API_URL':JSON.stringify(origin)},build:{outDir:dist,emptyOutDir:false}});
evidence.origin=origin;persist();console.log(JSON.stringify({ready:true,origin,output,productionConnections:'blocked by API build override and same-origin CSP'}));

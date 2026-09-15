/** Browser Use against the real isolated Rust backend; task availability alone is a fixture. */
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {build} from 'vite';
import fs from 'node:fs';
import path from 'node:path';
const root=path.resolve(import.meta.dirname,'..'), output=path.join(root,'artifacts/workbench-20260914',`final-send-${Date.now()}`),dist=path.join(output,'dist');
fs.mkdirSync(output,{recursive:true});
const backendOrigin='http://127.0.0.1:47368';
if(await fetch(backendOrigin+'/api/health').catch(()=>null))throw Error('Isolated backend port is occupied');
const backend=spawn(path.join(root,'target/debug/spellcast-server.exe'),[],{cwd:root,env:{...process.env,SPELLCAST_PORT:'47368',SPELLCAST_STATE_FILE:path.join(output,'state.sqlite3')},windowsHide:true,stdio:'ignore'});
async function api(route,method='GET',body){const r=await fetch(backendOrigin+route,{method,headers:{'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});const value=await r.json();if(!r.ok)throw Error(JSON.stringify(value));return value;}
let ready=false;
for(let attempt=0;attempt<100;attempt++){if(backend.exitCode!==null)throw Error('Isolated backend exited');try{const b=await api('/api/board');if(b.canvas.objects.length)throw Error('Unexpected nonempty test database');ready=true;break;}catch{await new Promise(r=>setTimeout(r,100));}}
if(!ready){backend.kill();throw Error('Isolated backend did not start');}
const binding={source_id:'fixture-final-send',thread_id:'11111111-1111-4111-8111-111111111111',cwd:'G:/Fixtures/FinalSend',label:'最终发送验收任务'};
await api('/api/replies','POST',{id:'final-send-reply',source_id:binding.source_id,source_label:binding.label,title:'两种推进方式（隔离验收）',blocks:[
 {id:'choices',type:'comparison',title:'选择推进方式',criteria:['行动'],options:[{id:'a',title:'先做小实验',values:['做一个可运行的小样']},{id:'b',title:'先补足依据',values:['整理关键问题和已有证据']}]},
 {id:'note',type:'text',title:'备注',text:'选择和编辑先保存在本地，点击发送才提交。'}]});
const calls=[],observations=[];
const server=createServer(async(req,res)=>{
  try{
    const url=new URL(req.url,'http://127.0.0.1');res.setHeader('Content-Security-Policy',"default-src 'self' data: blob:; connect-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; worker-src 'self' blob:");
    if(url.pathname==='/__stop'&&req.method==='POST'){res.end('Isolated test stopped.');backend.kill();server.close();return;}
    if(url.pathname==='/__acceptance'){
      const [board,feedback]=await Promise.all([api('/api/board'),api('/api/feedback')]);
      const snapshot={at:new Date().toISOString(),reply:board.replies[0],objects:board.canvas.objects,pending:feedback.pending,deliveries:feedback.deliveries};observations.push(snapshot);
      const evidence={method:'Browser Use with real isolated Rust API and SQLite; task availability and destination binding are fixtures. The proxy validates the fixture task ID, then omits that field only for the unbound isolated backend so it cannot dispatch to a real model.',backendPid:backend.pid,backendOrigin,calls,observations};fs.writeFileSync(path.join(output,'evidence.json'),JSON.stringify(evidence,null,2));
      const escaped=JSON.stringify(snapshot,null,2).replace(/[&<>]/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[ch]));
      res.setHeader('Content-Type','text/html;charset=utf-8');res.end(`<html><title>最终发送验收</title><h1>真实隔离后端状态</h1><p>没有接入真实 Codex 任务。</p><pre>${escaped}</pre><form method="POST" action="/__stop"><button>结束隔离测试</button></form></html>`);return;
    }
    if(url.pathname.startsWith('/api/')){
      let raw='';for await(const chunk of req)raw+=chunk;const body=raw?JSON.parse(raw):undefined;
      const name=req.method+' '+url.pathname;let value;
      if(name==='POST /api/task-target')value={...binding,status:'available',checked_at_ms:Date.now(),message:''};
      else {
        let forwarded=body;
        if(name==='POST /api/say'){
          if(body.source_id!==binding.source_id||body.target_thread_id!==binding.thread_id)throw Error('Fixture destination mismatch');
          const {target_thread_id,...unboundRequest}=body;forwarded=unboundRequest;
        }
        value=await api(url.pathname+url.search,req.method,forwarded);if(name==='GET /api/feedback')value.bindings=[binding];
      }
      if(req.method==='POST'&&!['POST /api/task-target','POST /api/surface'].includes(name))calls.push({at:new Date().toISOString(),route:name,body});
      res.setHeader('Content-Type','application/json');res.end(JSON.stringify(value));return;
    }
    const filename=path.resolve(dist,'.'+(url.pathname==='/'?'/index.html':url.pathname));
    if(!filename.startsWith(dist+path.sep)||!fs.existsSync(filename)){res.writeHead(404);res.end();return;}
    const ext=path.extname(filename);res.setHeader('Content-Type',({'.js':'text/javascript','.css':'text/css','.woff2':'font/woff2','.svg':'image/svg+xml'})[ext]||'text/html;charset=utf-8');
    let content=fs.readFileSync(filename);if(ext==='.html')content=content.toString().replace('<head>','<head><script>localStorage.setItem("spellcast.locale","zh-CN");localStorage.setItem("spellcast.mode","focus");</script>');res.end(content);
  }catch(error){res.writeHead(500);res.end(JSON.stringify({error:String(error)}));}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin=`http://127.0.0.1:${server.address().port}`;
await build({root,logLevel:'error',define:{'import.meta.env.VITE_API_URL':JSON.stringify(origin)},build:{outDir:dist,emptyOutDir:false}});
console.log(JSON.stringify({ready:true,origin,output,backendPid:backend.pid,backendOrigin}));

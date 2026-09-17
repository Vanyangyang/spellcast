/** Real isolated Rust API + SQLite. Destination availability is a fixture; no real task is bound. */
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {deflateSync} from 'node:zlib';
import {build} from 'vite';
import fs from 'node:fs';
import path from 'node:path';
const root=path.resolve(import.meta.dirname,'..'), output=path.join(root,'artifacts/atomic-references-20260915',`browser-${Date.now()}`),dist=path.join(output,'dist');
fs.mkdirSync(output,{recursive:true});
const backendOrigin='http://127.0.0.1:47369';
if(await fetch(backendOrigin+'/api/health').catch(()=>null))throw Error('Isolated backend port occupied');
const backend=spawn(path.join(root,'target/debug/spellcast-server.exe'),[],{cwd:root,env:{...process.env,SPELLCAST_PORT:'47369',SPELLCAST_STATE_FILE:path.join(output,'state.sqlite3')},windowsHide:true,stdio:'ignore'});
async function api(route,method='GET',body){const r=await fetch(backendOrigin+route,{method,headers:{'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});const value=await r.json();if(!r.ok)throw Error(JSON.stringify(value));return value;}
let ready=false;
for(let attempt=0;attempt<100;attempt++){if(backend.exitCode!==null)throw Error('Backend exited');try{const b=await api('/api/board');if(b.canvas.objects.length)throw Error('Test DB must be empty');ready=true;break;}catch{await new Promise(r=>setTimeout(r,100));}}
if(!ready){backend.kill();throw Error('Backend not ready');}
// Small deterministic calendar drawings, not user screenshots.
function png(busy){
  function crc(data){let n=0xffffffff;for(const b of data){n^=b;for(let i=0;i<8;i++)n=(n>>>1)^((n&1)?0xedb88320:0);}return(n^0xffffffff)>>>0;}
  function chunk(type,data){const tag=Buffer.from(type),len=Buffer.alloc(4),sum=Buffer.alloc(4);len.writeUInt32BE(data.length);sum.writeUInt32BE(crc(Buffer.concat([tag,data])));return Buffer.concat([len,tag,data,sum]);}
  const w=360,h=180,raw=Buffer.alloc(h*(w*3+1));
  for(let y=0;y<h;y++)for(let x=0;x<w;x++){const event=x>20&&x<340&&x%64>12&&y>34&&y<160&&(busy||Math.floor(x/64)%2===0)&&(busy?y%36<29:y>70&&y<103);const line=x%64===8||y===26;const rgb=event?(busy?[196,137,111]:[90,163,148]):line?[222,219,211]:[249,247,240];for(let c=0;c<3;c++)raw[y*(w*3+1)+1+x*3+c]=rgb[c];}
  const header=Buffer.alloc(13);header.writeUInt32BE(w);header.writeUInt32BE(h,4);header[8]=8;header[9]=2;
  return 'data:image/png;base64,'+Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(raw)),chunk('IEND',Buffer.alloc(0))]).toString('base64');
}
const binding={source_id:'fixture-image-reference',thread_id:'11111111-1111-4111-8111-111111111111',cwd:'G:/Fixtures/AtomicReference',label:'原子画面验收任务'};
await api('/api/replies','POST',{id:'fixture-source',source_id:binding.source_id,source_label:binding.label,title:'隔离验收',blocks:[{id:'note',type:'text',text:'仅用于注册隔离测试来源，不连接真实任务。'}]});
const initial=await api('/api/board'), registration=initial.canvas.objects.find(o=>o.content.type==='reply'&&o.content.id==='fixture-source');
await api('/api/canvas/batch','POST',{request_id:'hide-fixture-registration',operations:[{op:'place',id:registration.id,expected_revision:initial.canvas.items.find(p=>p.item_id===registration.id).revision,fields:{removed:true}}]});
const picture=(id,title,busy)=>({op:'create',id,content:{type:'image',title,alt:title,src:png(busy)},placement:{x:id==='open-image'?0:400,y:650,width:360,height:240}});
const imageA=picture('open-image','留白的周视图',false),imageB=picture('busy-image','排满的周视图',true);
const ref=p=>({object_id:p.id,content_revision:1,...p.content,type:undefined});
const seed={request_id:'seed',operations:[imageA,imageB,
 {op:'create',id:'compare',content:{type:'block',block:{id:'compare-block',type:'comparison',title:'日历也许需要留白',criteria:['感觉'],options:[{id:'open',title:'留白',summary:'让一天有喘息空间。',values:['舒展'],image:ref(imageA)},{id:'busy',title:'排满',summary:'每段时间都有安排。',values:['紧凑'],image:ref(imageB)}]}},placement:{x:0,y:0,width:700,height:580}},
 {op:'create',id:'sequence',content:{type:'block',block:{id:'sequence-block',type:'sequence',title:'看看它怎样变化',steps:[{id:'first',title:'当前安排',action:'先观察拥挤的时段。'},{id:'second',title:'留一点空白',action:'在会议之间加入缓冲。'}]}},placement:{x:760,y:0,width:580,height:600}},
 {op:'create',id:'light-native',content:{type:'text',title:'',text:'你也许需要 **留白**，而不是更多提醒。\n\n> 让一天有喘息的空间。\n\n- 会议之间留出 `15 分钟`\n- 给临时变化留一点余地'},placement:{x:1460,y:0,width:460,height:300}},
 {op:'create',id:'light-block',content:{type:'block',block:{id:'light-block-text',type:'text',text:'一句 *轻一点* 的补充。\n\n[查看说明](https://example.com)\n\n```js\nconst gap = 15;\n```\n\n<img src="https://invalid.example/x" onerror="alert(1)">\n\n[不可执行的链接](javascript:alert(1))'}},placement:{x:1460,y:400,width:460,height:340}},
 {op:'compose',id:'format-idea',expected_revision:0,title:'文字也有轻重',members:['light-native','light-block']},
 {op:'compose',id:'calendar-idea',expected_revision:0,title:'给日历留白',members:['compare','sequence','open-image','busy-image']}]};
for (const operation of seed.operations) if (operation.op === 'create') operation.origin = {cwd:binding.cwd,thread_id:binding.thread_id,source_id:binding.source_id,label:binding.label};
// The local batch and fixture provenance do not bind an actual Desktop task.
await api('/api/canvas/batch','POST',seed);
const calls=[],observations=[];
const server=createServer(async(req,res)=>{try{
 const url=new URL(req.url,'http://127.0.0.1');res.setHeader('Content-Security-Policy',"default-src 'self' data: blob:; connect-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; worker-src 'self' blob:");
 if(url.pathname==='/__stop'&&req.method==='POST'){res.end('Test stopped');backend.kill();server.close();return;}
 if(url.pathname==='/__change'&&req.method==='POST'){const b=await api('/api/board'),o=b.canvas.objects.find(o=>o.id==='open-image');await api('/api/canvas/batch','POST',{request_id:crypto.randomUUID(),operations:[{op:'patch_content',id:o.id,expected_revision:o.content_revision,fields:{title:'更新后的周视图',src:png(true)}}]});res.writeHead(303,{Location:'/__acceptance'});res.end();return;}
 if(url.pathname==='/__acceptance'){
  const [board,feedback]=await Promise.all([api('/api/board'),api('/api/feedback')]);observations.push({at:Date.now(),board,feedback});
  fs.writeFileSync(path.join(output,'evidence.json'),JSON.stringify({method:'Real isolated Rust API/SQLite; Browser Use for UI actions; fixture destination cannot start a model.',backendPid:backend.pid,calls,observations},null,2));
  const summary={pending:feedback.pending.length,deliveries:feedback.deliveries.length,calls:calls.map(c=>c.route),objects:board.canvas.objects.map(o=>({id:o.id,revision:o.content_revision})),last:feedback.pending.at(-1)?.anchors?.map(a=>({object:a.object_id,target:a.target,region:a.region?{...a.region,resource:'fixed-image'}:undefined,image:a.image?{id:a.image.object_id,revision:a.image.content_revision,title:a.image.title}:undefined}))};
  res.setHeader('Content-Type','text/html;charset=utf-8');res.end(`<h1>隔离验收记录</h1><pre>${JSON.stringify(summary,null,2).replace(/</g,'&lt;')}</pre><a href="/">返回画布</a><form method="POST" action="/__change"><button>模拟原图更新</button></form><form method="POST" action="/__stop"><button>结束隔离测试</button></form>`);return;
 }
 if(url.pathname.startsWith('/api/')){
  let raw='';for await(const c of req)raw+=c;const body=raw?JSON.parse(raw):undefined;const name=req.method+' '+url.pathname;let value;
  if(name==='POST /api/task-target')value={...binding,status:'available',checked_at_ms:Date.now(),message:''};
  else {let forwarded=body;if(name==='POST /api/say'){if(body.source_id!==binding.source_id||body.target_thread_id!==binding.thread_id)throw Error('Wrong fixture task');const{target_thread_id,...unbound}=body;forwarded=unbound;}
   value=await api(url.pathname+url.search,req.method,forwarded);if(name==='GET /api/feedback')value.bindings=[binding];}
  if(req.method==='POST'&&!['POST /api/task-target','POST /api/surface'].includes(name))calls.push({route:name,body});
  res.setHeader('Content-Type','application/json');res.end(JSON.stringify(value));return;
 }
 const filename=path.resolve(dist,'.'+(url.pathname==='/'?'/index.html':url.pathname));if(!filename.startsWith(dist+path.sep)||!fs.existsSync(filename)){res.writeHead(404);res.end();return;}
 const ext=path.extname(filename);res.setHeader('Content-Type',({'.js':'text/javascript','.css':'text/css','.woff2':'font/woff2','.svg':'image/svg+xml'})[ext]||'text/html;charset=utf-8');let content=fs.readFileSync(filename);
 if(ext==='.html')content=content.toString().replace('<head>','<head><script>localStorage.setItem("spellcast.locale","zh-CN");localStorage.setItem("spellcast.mode","focus");</script>');res.end(content);
 }catch(error){res.writeHead(500);res.end(JSON.stringify({error:String(error)}));}});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin=`http://127.0.0.1:${server.address().port}`;
await build({root,logLevel:'error',define:{'import.meta.env.VITE_API_URL':JSON.stringify(origin)},build:{outDir:dist,emptyOutDir:false}});
console.log(JSON.stringify({ready:true,origin,output,backendPid:backend.pid,backendOrigin}));

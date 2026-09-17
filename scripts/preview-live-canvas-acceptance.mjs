/** Browser frontend for real desktop acceptance. API requests are forwarded unchanged. */
import {createServer} from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {build} from 'vite';

const root=path.resolve(import.meta.dirname,'..');
const output=path.join(root,'artifacts/atomic-references-20260915',`live-${Date.now()}`);
const dist=path.join(output,'dist');
const backend='http://127.0.0.1:47194';
const calls=[], observations=[];
fs.mkdirSync(output,{recursive:true});
async function snapshot(label){
  const [board,feedback]=await Promise.all(['/api/board','/api/feedback'].map(async p=>{
    const r=await fetch(backend+p); if(!r.ok)throw Error(`${p}: ${r.status}`); return r.json();
  }));
  observations.push({label,at:Date.now(),board,feedback});
  fs.writeFileSync(path.join(output,'evidence.json'),JSON.stringify({method:'Browser UI forwards unchanged to the production desktop API; model reads and writes use native MCP.',calls,observations},null,2));
  return {label,pending:feedback.pending.length,deliveries:feedback.deliveries.length,calls:calls.map(c=>({route:c.route,status:c.status})),objects:board.canvas.objects.filter(o=>o.id.startsWith('atomic-live-')).map(o=>({id:o.id,revision:o.content_revision,content:o.content.type==='block'?{...o.content,block:{...o.content.block,options:o.content.block.options?.map(v=>({...v,image:v.image?{object_id:v.image.object_id,content_revision:v.image.content_revision}:undefined})),steps:o.content.block.steps?.map(v=>({...v,image:v.image?{object_id:v.image.object_id,content_revision:v.image.content_revision}:undefined}))}}:undefined}))};
}
await snapshot('before');
const server=createServer(async(req,res)=>{try{
  const url=new URL(req.url,'http://127.0.0.1');
  if(url.pathname==='/__stop'&&req.method==='POST'){await snapshot('stopped');res.end('Stopped');server.close();return;}
  if(url.pathname==='/__acceptance'){
    const s=await snapshot(url.searchParams.get('label')||'observe');
    res.setHeader('Content-Type','text/html;charset=utf-8');
    res.end(`<h1>真实任务往返验收</h1><pre>${JSON.stringify(s,null,2).replace(/</g,'&lt;')}</pre><a href="/">画布</a><form method="POST" action="/__stop"><button>结束验收服务</button></form>`);return;
  }
  if(url.pathname.startsWith('/api/')||url.pathname.startsWith('/artifacts/')){
    const chunks=[];for await(const c of req)chunks.push(c);const body=Buffer.concat(chunks);
    const headers={};if(req.headers['content-type'])headers['content-type']=req.headers['content-type'];
    const upstream=await fetch(backend+url.pathname+url.search,{method:req.method,headers,...(body.length?{body}:{}),redirect:'manual'});
    if(req.method!=='GET'&&req.method!=='HEAD')calls.push({at:Date.now(),route:req.method+' '+url.pathname,status:upstream.status,body:body.toString()});
    res.statusCode=upstream.status;for(const key of ['content-type','cache-control','location'])if(upstream.headers.has(key))res.setHeader(key,upstream.headers.get(key));
    res.end(Buffer.from(await upstream.arrayBuffer()));return;
  }
  const filename=path.resolve(dist,'.'+(url.pathname==='/'?'/index.html':url.pathname));
  if(!filename.startsWith(dist+path.sep)||!fs.existsSync(filename)){res.writeHead(404);res.end();return;}
  const ext=path.extname(filename);
  res.setHeader('Content-Type',({'.js':'text/javascript','.css':'text/css','.woff2':'font/woff2','.svg':'image/svg+xml','.png':'image/png'})[ext]||'text/html;charset=utf-8');
  let content=fs.readFileSync(filename);
  if(ext==='.html')content=content.toString().replace('<head>','<head><script>localStorage.setItem("spellcast.locale","zh-CN");localStorage.setItem("spellcast.mode","focus");</script>');
  res.end(content);
}catch(error){res.writeHead(500);res.end(JSON.stringify({error:String(error)}));}});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin=`http://127.0.0.1:${server.address().port}`;
await build({root,logLevel:'error',define:{'import.meta.env.VITE_API_URL':JSON.stringify(origin)},build:{outDir:dist,emptyOutDir:false}});
console.log(JSON.stringify({ready:true,origin,output,backend}));

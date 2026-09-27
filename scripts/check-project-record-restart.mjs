/** Isolated process/REST/MCP-wire integration. Never connects to the installed app. */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const directory=await mkdtemp(path.join(tmpdir(),'spellcast-project-restart-'));
const state=path.join(directory,'fixture.sqlite3');
const allocator=net.createServer();allocator.listen(0,'127.0.0.1');await once(allocator,'listening');
const port=allocator.address().port;await new Promise(resolve=>allocator.close(resolve));
const base=`http://127.0.0.1:${port}`;
const uiKey=(randomUUID()+randomUUID()).replaceAll('-','');
const localKey=(randomUUID()+randomUUID()).replaceAll('-','');
let server,logs='';
async function start(){
  server=spawn(path.join(root,'target','debug',process.platform==='win32'?'spellcast-server.exe':'spellcast-server'),[],{
    cwd:root,env:{...process.env,SPELLCAST_PORT:String(port),SPELLCAST_STATE_FILE:state,SPELLCAST_PROJECT_UI_KEY:uiKey,SPELLCAST_PROJECT_LOCAL_KEY:localKey},windowsHide:true,stdio:['ignore','pipe','pipe']});
  server.stdout.on('data',b=>{logs+=b;});server.stderr.on('data',b=>{logs+=b;});
  for(let i=0;i<100;i++){
    if(server.exitCode!==null)throw Error(`fixture server exited: ${logs}`);
    try{if((await fetch(base+'/api/health')).ok)return;}catch{}
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  throw Error(`fixture server did not become ready: ${logs}`);
}
async function stop(){if(server&&server.exitCode===null){const done=once(server,'exit');server.kill();await done;}}
async function api(url,body,method=body?'POST':'GET',expected=200){
  const response=await fetch(base+url,{method,headers:{'content-type':'application/json',origin:'http://tauri.localhost','x-spellcast-window':uiKey},body:body?JSON.stringify(body):undefined});
  const data=await response.json();assert.equal(response.status,expected,JSON.stringify(data));return data;
}
let rpcId=0;
async function rpc(name,args={}){
  const response=await fetch(base+'/mcp',{method:'POST',headers:{'content-type':'application/json',accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:++rpcId,method:'tools/call',params:{name,arguments:args}})});
  const reply=await response.json();assert.ok(!reply.error&&!reply.result?.isError,JSON.stringify(reply));return reply.result.structuredContent;
}
const projectId=randomUUID(),objectId=randomUUID(),recordId=randomUUID();
const command=(op,fields={})=>({request_id:randomUUID(),project_id:projectId,op,...fields});
const send=(value,status=200)=>api('/api/projects/command',value,'POST',status);
try{
  await start();
  await send(command('create_project',{name:'Independent restart fixture',aliases:['C:/isolated-fixture']}));
  await send(command('put_object',{id:objectId,expected_revision:0,name:'Feature object',kind:'system',archived:false}));
  const fields={title:'Implement bounded route',object_id:objectId,goal:'Reach an observable result',scope:'One route',status:'active',result:'Source implementation exists',boundaries:'Runtime journey remains unverified',next_step:'Exercise real input',references:[{label:'Design source',uri:'file:///C:/isolated-fixture/design.md',version:'fixture-v1'}]};
  const create=command('put_record',{id:recordId,expected_revision:0,fields});
  await send(create);assert.equal((await send(create)).replayed,true);
  await send({...create,fields:{...fields,title:'Changed retry'}},400);
  await send(command('put_record',{id:recordId,expected_revision:0,fields}),400);
  const update=command('put_record',{id:recordId,expected_revision:1,fields:{...fields,status:'done',result:'Fixture path checked',boundaries:'Installation and external user path not verified'}});
  await send(update);
  const history=await rpc('spellcast_project_query',{view:'history',project_id:projectId,id:recordId,kind:'record'});
  assert.equal(history.length,2);assert.ok(history.some(h=>h.snapshot.boundaries==='Runtime journey remains unverified'));
  await send(command('restore_record',{id:recordId,expected_revision:2,restore_revision:1}));
  await send(command('archive_record',{id:recordId,expected_revision:3,archived:true}));
  assert.equal((await api(`/api/projects/${projectId}/records`)).length,0);
  await send(command('archive_record',{id:recordId,expected_revision:4,archived:false}));
  const before=await api(`/api/projects/${projectId}/records/${recordId}`);assert.equal(before.revision,5);assert.equal(before.status,'active');
  const pinned=await api(`/api/projects/${projectId}/pin`,{record_id:recordId,request_id:randomUUID()});
  const object=pinned.canvas.objects.find(o=>o.content.type==='work_record');assert.ok(object);
  assert.deepEqual(Object.keys(object.content).sort(),['project_id','record_id','type']);
  let item=pinned.canvas.items.find(i=>i.item_id===object.id);
  let board=await api('/api/canvas/delete-lock',{current:[{kind:'presentation',id:object.id,revision:item.revision}],locked:true});
  item=board.canvas.items.find(i=>i.item_id===object.id);
  await api('/api/canvas',{item_id:object.id,expected_revision:item.revision},'DELETE',400);
  board=await api('/api/canvas/delete-lock',{current:[{kind:'presentation',id:object.id,revision:item.revision}],locked:false});
  item=board.canvas.items.find(i=>i.item_id===object.id);
  await api('/api/canvas',{item_id:object.id,expected_revision:item.revision},'DELETE');
  assert.deepEqual(await api(`/api/projects/${projectId}/records/${recordId}`),before);
  const exported=await api(`/api/projects/${projectId}/export`);
  assert.ok(exported.external_files.some(f=>f.uri===fields.references[0].uri&&f.original_included===false));
  assert.equal(exported.history.filter(h=>h.kind==='record').length,5);
  const md=await api(`/api/projects/${projectId}/markdown`);assert.ok(md.markdown.includes(recordId)&&md.markdown.includes('5'));
  const importedId=randomUUID();
  await send({request_id:randomUUID(),project_id:importedId,op:'import_project',name:'Recovered fixture',bundle:exported});
  const imported=await api(`/api/projects/${importedId}/export`);
  assert.deepEqual(imported.records.map(r=>({...r,project_id:projectId})),exported.records);
  assert.deepEqual(imported.objects.map(o=>({...o,project_id:projectId})),exported.objects);
  assert.deepEqual(imported.history.filter(h=>h.kind==='record').map(h=>({...h,project_id:projectId,snapshot:{...h.snapshot,project_id:projectId}})),exported.history.filter(h=>h.kind==='record'));
  await stop();await start();
  assert.deepEqual(await api(`/api/projects/${projectId}/records/${recordId}`),before);
  assert.equal((await rpc('spellcast_project_query',{view:'history',project_id:projectId,id:recordId,kind:'record'})).length,5);
  assert.deepEqual((await api(`/api/projects/${importedId}/export`)).records,imported.records);
  assert.equal((await send(create)).replayed,true);
  let hostMetadataVerified=false,localManagementVerified=false;
  if(process.env.SPELLCAST_VERIFY_CODEX_TASK==='1'){
    const thread=process.env.CODEX_THREAD_ID;assert.ok(thread,'actual CODEX_THREAD_ID required');
    const access=await rpc('spellcast_project_access',{project_id:projectId,source_id:thread,thread_id:thread,cwd:root});
    assert.equal(access.access.state,'pending');assert.equal(access.access.thread_id,thread);
    await api(`/api/projects/${projectId}/access/${access.access.id}`,{expected_revision:1,decision:'approved'});
    const authorized=await rpc('spellcast_project_update',{access_token:access.access_token,command:command('put_record',{id:randomUUID(),expected_revision:0,fields:{title:'Real host metadata fixture',boundaries:'MCP protocol test, not host-native tool registration'}})});
    assert.equal(authorized.record.updated_by.thread_id,thread);
    await api(`/api/projects/${projectId}/access/${access.access.id}`,{expected_revision:2,decision:'revoked'});
    hostMetadataVerified=true;
    const localProject=randomUUID(),localRecord=randomUUID();
    const requests=[
      {request_id:randomUUID(),project_id:localProject,op:'create_project',name:'Local owner API fixture',aliases:['C:/local-fixture']},
      {request_id:randomUUID(),project_id:localProject,op:'put_record',id:localRecord,expected_revision:0,fields:{title:'API-created record',status:'planned',boundaries:'Isolated test only'}},
    ];
    const requestFile=path.join(directory,'local-commands.json'),keyFile=path.join(directory,'local-api.key');
    await writeFile(requestFile,JSON.stringify(requests));await writeFile(keyFile,localKey,{mode:0o600});
    const client=()=>{
      const out=spawnSync('node',[path.join(root,'skills/spellcast/scripts/project-api.mjs'),requestFile],{cwd:root,env:{...process.env,CODEX_THREAD_ID:thread,SPELLCAST_PROJECT_API_URL:base,SPELLCAST_PROJECT_KEY_FILE:keyFile},encoding:'utf8',windowsHide:true,timeout:60000});
      assert.equal(out.status,0,out.stderr);assert.ok(!out.stdout.includes(localKey));
      return out.stdout.trim().split('\n').map(line=>JSON.parse(line));
    };
    const initial=client();assert.equal(initial[1].record.updated_by.thread_id,thread);
    assert.equal(initial[1].record.updated_by.kind,'agent');
    await stop();await start();
    assert.ok(client().every(result=>result.replayed));
    const managed=await rpc('spellcast_project_manage',{local_token:localKey,request:{source_id:thread,thread_id:thread,cwd:root,command:{...requests[1],request_id:randomUUID(),expected_revision:1,fields:{title:'MCP management update',status:'active'}}}});
    assert.equal(managed.record.revision,2);
    const localExport=await api(`/api/projects/${localProject}/export`);
    assert.equal(localExport.history.filter(item=>item.kind==='record').length,2);
    assert.ok(!JSON.stringify(localExport).includes(localKey));
    localManagementVerified=true;
  }
  const result={passed:true,scope:'isolated REST and MCP protocol, real server process restart; not host native-tool registration',projectId,importedId,recordId,revisions:5,externalOriginalsIncluded:false,hostMetadataVerified,localManagementVerified,state};
  await mkdir(path.join(root,'artifacts'),{recursive:true});await writeFile(path.join(root,'artifacts','project-record-restart-result.json'),JSON.stringify(result,null,2));
  console.log(JSON.stringify(result));
}finally{await stop();}

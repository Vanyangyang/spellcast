/** Isolated real-server check for flow anchors, candidates, trials and adoptions. Never touches the installed app. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const directory=await mkdtemp(path.join(tmpdir(),'spellcast-workbench-trials-'));
const state=path.join(directory,'fixture.sqlite3');
const allocator=net.createServer();allocator.listen(0,'127.0.0.1');await once(allocator,'listening');
const port=allocator.address().port;await new Promise(resolve=>allocator.close(resolve));
const base=`http://127.0.0.1:${port}`, uiKey=(randomUUID()+randomUUID()).replaceAll('-','');
let server,logs='';
async function start(){
  server=spawn(path.join(root,'target','debug',process.platform==='win32'?'spellcast-server.exe':'spellcast-server'),[],{cwd:root,env:{...process.env,SPELLCAST_PORT:String(port),SPELLCAST_STATE_FILE:state,SPELLCAST_PROJECT_UI_KEY:uiKey},windowsHide:true,stdio:['ignore','pipe','pipe']});
  server.stdout.on('data',b=>{logs+=b;});server.stderr.on('data',b=>{logs+=b;});
  for(let i=0;i<100;i++){ if(server.exitCode!==null)throw Error(`fixture server exited: ${logs}`); try{if((await fetch(base+'/api/health')).ok)return;}catch{} await new Promise(r=>setTimeout(r,100)); }
  throw Error(`fixture server did not become ready: ${logs}`);
}
async function stop(){if(server&&server.exitCode===null){const done=once(server,'exit');server.kill();await done;}}
async function api(url,body,expected=200){
  const response=await fetch(base+url,{method:body?'POST':'GET',headers:{'content-type':'application/json',origin:'http://tauri.localhost','x-spellcast-window':uiKey},body:body?JSON.stringify(body):undefined});
  const data=await response.json();assert.equal(response.status,expected,`${url} ${JSON.stringify(data).slice(0,400)}`);return data;
}
async function rpc(args){
  const response=await fetch(base+'/mcp',{method:'POST',headers:{'content-type':'application/json',accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'spellcast_project_query',arguments:args}})});
  const reply=await response.json();assert.ok(!reply.error&&!reply.result?.isError,JSON.stringify(reply));return reply.result.structuredContent;
}
const project=randomUUID(), send=(op,fields,status=200)=>api('/api/projects/command',{request_id:randomUUID(),project_id:project,op,...fields},status);
const put=(id,revision,kind,planning,status)=>send('put_object',{id,expected_revision:revision,name:id,kind,archived:false,planning},status);
const objects=async()=>Object.fromEntries((await api(`/api/projects/${project}/objects`)).map(o=>[o.id,o]));
const step=(id,title,extra={})=>({id,title,goal:'',action:'',feedback:'',external:false,terminal:false,choices:[],...extra});
const flowPlanning=(locked,withGate=true)=>({scopes:['R0'],locked,links:[{target_id:'energy',relation:'uses',note:''}],flow:{entry:withGate?'gate':'fight',variables:[{id:'stamina',name:'Stamina',value_type:'number',initial:'',unit:'',parameter_id:'energy'}],
  steps:[...(withGate?[step('gate','Gate',{choices:[{id:'enter',label:'Pay two',to:'fight',conditions:[{variable_id:'stamina',op:'gte',operand:{kind:'literal',value:'2'}}],effects:[{variable_id:'stamina',op:'subtract',operand:{kind:'literal',value:'2'}}]}]})]:[]),
    step('fight','Fight',{external:true,choices:[{id:'finish',label:'Finish',to:'end',conditions:[],effects:[]}]}),step('end','Settle',{terminal:true})]}});
// Mirrors the client model's run shape; the store checks structure, continuity and saved snapshots.
// Like the client: a value other than the shared one without a candidate is a typed override.
const run=(o,stamina,candidate)=>{const after=stamina-2,s=v=>({stamina:v}),dep=o.energy,shared=!candidate&&String(stamina)===dep.planning.parameter.value;
  const source=candidate?{variable_id:'stamina',value:String(stamina),source:'candidate',parameter_id:'energy',parameter_revision:dep.revision,candidate_id:candidate.id,candidate_revision:candidate.revision}
    :{variable_id:'stamina',value:String(stamina),source:shared?'shared':'override',parameter_id:'energy',parameter_revision:dep.revision};
  return {version:2,id:randomUUID(),started:new Date().toISOString(),source:o.flow,dependencies:[dep],inputs:candidate||shared?{}:{stamina:String(stamina)},initial:s(stamina),
  events:[{kind:'choice',from:'gate',to:'fight',label:'Pay two',choice_id:'enter',before:s(stamina),after:s(after),at:new Date().toISOString()},{kind:'manual',from:'fight',to:'fight',label:'手动确认结果',before:s(after),after:s(after),at:new Date().toISOString()}],
  input_sources:[source],...(candidate?{candidates:[candidate]}:{}),anchors:[{object_id:'hook',name:'hook',kind:'hook',revision:o.hook.revision,step_id:'gate',phase:'cue'}]};};
try{
  await start();
  await send('create_project',{name:'Workbench trials fixture',aliases:[]});
  await put('energy',0,'parameter',{scopes:['R0'],locked:true,parameter:{value:'3',min:'0',max:'10',unit:'pt'}});
  await put('flow',0,'flow',flowPlanning(true));
  await put('local-user',0,'content',{scopes:['R0'],links:[{target_id:'energy',relation:'uses',local:{value:'5',reason:'intro'}}]});
  await put('hook',0,'hook',{scopes:['R0'],hook:{},anchors:[{flow_id:'flow',step_id:'gate',phase:'cue'},{flow_id:'flow',step_id:'end',phase:'payoff'}]});
  await put('rule',0,'rule',{scopes:['R0'],rule:{},anchors:[{flow_id:'flow',step_id:'gate',choice_id:'enter',note:'cost'}]});
  let o=await objects();
  assert.deepEqual([o.flow.revision,o.flow.planning.locked],[1,true],'Anchors leave the locked flow untouched');
  await put('bad',0,'hook',{scopes:['R0'],hook:{},anchors:[{flow_id:'flow',step_id:'fight',choice_id:'enter'}]},400);
  await send('set_object_lock',{id:'flow',expected_revision:1,locked:false});
  const guard=await put('flow',2,'flow',flowPlanning(false,false),400);assert.match(guard.error,/hook.*解除/);
  await send('set_object_lock',{id:'flow',expected_revision:2,locked:true});
  // Candidates need no unlock and never touch the parameter.
  const low=(await send('put_candidate',{id:'low',expected_revision:0,parameter_id:'energy',label:'Low',value:'1',reason:'harder',base_revision:o.energy.revision})).candidate;
  const high=(await send('put_candidate',{id:'high',expected_revision:0,parameter_id:'energy',label:'High',value:'6',reason:'easier',base_revision:o.energy.revision})).candidate;
  await send('put_candidate',{id:'bad',expected_revision:0,parameter_id:'energy',label:'Out',value:'11',base_revision:o.energy.revision},400);
  o=await objects();assert.equal(o.energy.revision,1);
  // Trials: immutable, verified against saved snapshots, deduplicated by content.
  const baseRun=run(o,3);
  const saved=(await send('save_trial',{id:'base',origin:'walkthrough',label:'baseline',run:baseRun})).trial;
  assert.deepEqual([saved.event_count,saved.manual_count],[2,1]);
  assert.equal((await send('save_trial',{id:'again',origin:'walkthrough',run:baseRun})).deduplicated,true);
  await send('save_trial',{id:'base',origin:'walkthrough',run:run(o,4)},400);
  await send('save_trial',{id:'forged',origin:'walkthrough',run:{...run(o,4),source:{...o.flow,name:'forged'}}},400);
  const highRun={...run(o,6,high),replay:{base_trial_id:'base',base_run_id:baseRun.id,status:'complete',cursor:2}};
  highRun.events[1].assumption={base_trial_id:'base',base_event_index:1,context_changed:true};
  await send('save_trial',{id:'high-replay',origin:'replay',run:highRun});
  const lowRun={...run(o,1,low),events:[],replay:{base_trial_id:'base',base_run_id:baseRun.id,status:'diverged',cursor:0,divergence:{index:0,kind:'condition',detail:'Stamina 大于等于 2（当前 1）'}}};
  await send('save_trial',{id:'low-replay',origin:'replay',run:lowRun});
  // The store recomputes guards, effects and provenance; forged evidence is rejected at the HTTP boundary.
  const skippedGuard=await send('save_trial',{id:'forged-guard',origin:'walkthrough',run:run(o,1,low)},400);
  assert.match(skippedGuard.error,/条件未满足/);
  const wrongEffect=run(o,3);wrongEffect.events[0].after={stamina:2};wrongEffect.events[1].before={stamina:2};wrongEffect.events[1].after={stamina:2};
  assert.match((await send('save_trial',{id:'forged-effect',origin:'walkthrough',run:wrongEffect},400)).error,/重算应为 1/);
  const hiddenOverride=run(o,4);hiddenOverride.inputs={};hiddenOverride.input_sources[0].source='shared';
  assert.match((await send('save_trial',{id:'forged-source',origin:'walkthrough',run:hiddenOverride},400)).error,/初值/);
  const masked=run(o,3);masked.candidates=[low];
  assert.match((await send('save_trial',{id:'forged-candidate',origin:'walkthrough',run:masked},400)).error,/初值来源应为候选/);
  const listed=await api(`/api/projects/${project}/trials?flow_id=flow`);
  assert.deepEqual(listed.map(t=>t.id),['low-replay','high-replay','base']);
  assert.equal((await api(`/api/projects/${project}/trials/high-replay`)).run.events[1].assumption.context_changed,true);
  // Adoption: explicit unlock, latest revisions, reason and evidence in one write.
  const adopt=(revision,extra={})=>send('adopt_candidate',{adoption_id:randomUUID(),parameter_id:'energy',expected_revision:revision,candidate_id:'high',candidate_revision:1,trial_ids:['base','high-replay'],reason:'Six keeps two fights reachable',lock_after:true,...extra},extra.status||200);
  const lockedError=await send('adopt_candidate',{adoption_id:randomUUID(),parameter_id:'energy',expected_revision:1,candidate_id:'high',candidate_revision:1,trial_ids:[],reason:'x',lock_after:true},400);assert.match(lockedError.error,/已锁定/);
  await send('set_object_lock',{id:'energy',expected_revision:1,locked:false});
  await send('adopt_candidate',{adoption_id:randomUUID(),parameter_id:'energy',expected_revision:1,candidate_id:'high',candidate_revision:1,trial_ids:[],reason:'stale',lock_after:true},400);
  const adopted=await adopt(2);
  assert.deepEqual([adopted.object.planning.parameter.value,adopted.object.planning.locked,adopted.adoption.value_before],['6',true,'3']);
  o=await objects();assert.equal(o['local-user'].planning.links[0].local.value,'5');
  const history=await api(`/api/projects/${project}/history/object/energy`);assert.equal(history.at(-1).operation,'adopt_candidate');
  assert.equal((await api(`/api/projects/${project}/history/candidate/high`)).length,1);
  assert.equal((await rpc({view:'trials',project_id:project,flow_id:'flow'})).length,3);
  assert.equal((await rpc({view:'adoptions',project_id:project}))[0].candidate.id,'high');
  // The real client model's runs (walkthrough, candidate replay with a reused manual result, upgraded
  // legacy run) must pass the store's validation unchanged.
  const {build}=await import('esbuild');
  const compiled=await build({stdin:{contents:"export * from './src/game-flow-model.ts'; export * from './src/game-flow-replay.ts';",resolveDir:root,loader:'ts'},bundle:true,format:'esm',write:false,platform:'neutral',logLevel:'silent'});
  const model=await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`);
  o=await objects();const list=Object.values(o), candidates=await api(`/api/projects/${project}/candidates`);
  let walk=model.startFlowRun(o.flow,list,{});walk=model.advanceFlow(walk,'enter');walk=model.confirmManualResult(walk,{stamina:'3'});walk=model.advanceFlow(walk,'finish');
  assert.equal(model.runPosition(walk).complete,true);assert.equal(walk.anchors.length,3);
  const modelTrial=(await send('save_trial',{id:'model-walk',origin:'walkthrough',label:'model',run:walk})).trial;
  assert.equal(modelTrial.terminal,true);
  const stored=(await api(`/api/projects/${project}/trials/model-walk`)).run;
  assert.deepEqual(model.verifyRun(stored),[],'A stored trial re-verifies in the client model');
  let replay=model.startReplay({trialId:'model-walk',run:stored},o.flow,list,{},[candidates.find(c=>c.id==='low')]);
  assert.equal(replay.replay.status,'diverged');
  await send('save_trial',{id:'model-low',origin:'replay',run:replay});
  const back=(await send('put_candidate',{id:'back',expected_revision:0,parameter_id:'energy',label:'Back',value:'4',base_revision:o.energy.revision})).candidate;
  replay=model.startReplay({trialId:'model-walk',run:stored},o.flow,list,{},[back]);assert.equal(replay.replay.status,'paused');
  replay=model.replayReuseManual(replay,stored);assert.deepEqual([replay.replay.status,replay.events[1].assumption.context_changed],['complete',true]);
  await send('save_trial',{id:'model-back',origin:'replay',run:replay});
  const legacy={...model.startFlowRun(o.flow,list,{}),version:1};delete legacy.input_sources;delete legacy.anchors;
  const upgraded=model.upgradeRun(legacy);assert.deepEqual(model.verifyRun(upgraded),[]);
  await send('save_trial',{id:'model-legacy',origin:'legacy_local',run:upgraded});
  const comparison=model.compareRuns(stored,replay);assert.equal(comparison.route,undefined);assert.match(comparison.value.text,/初值：Stamina A 6 · B 4/);
  const allTrials=await api(`/api/projects/${project}/trials`);assert.equal(allTrials.length,7);
  // Legacy evidence still exports v3 until content sections enter the same project.
  assert.equal((await api(`/api/projects/${project}/export`)).version,3);
  const content={scopes:['R0'],locked:true,body:'',sections:[
    {id:'scene',role:'body',text:'# A complete scene\n\nLine one.\n\n> A line of dialogue.',references:[{label:'Source draft',uri:'https://example.test/design',version:'fixture-1'}]},
    {id:'open',role:'question',text:'How should the choice be signalled?',references:[]}],
    links:[{target_id:'energy',relation:'uses',note:''}],anchors:[{flow_id:'flow',step_id:'gate'}]};
  const flowBefore=(await objects()).flow;
  const created=(await put('chapter',0,'content',content)).object;
  assert.deepEqual((await objects()).flow,flowBefore,'Writing at a flow step never edits the flow');
  await put('chapter',1,'content',{...content,sections:[]},400);
  await send('set_object_lock',{id:'chapter',expected_revision:1,locked:false});
  const omitted={...content};delete omitted.sections;omitted.body='Old writer attempts downgrade';
  const rejected=await put('chapter',2,'content',omitted,400);assert.match(rejected.error,/sections/);
  assert.deepEqual((await objects()).chapter.planning.sections,created.planning.sections,'Rejected old writer keeps content');
  const changed={...content,sections:[...content.sections].reverse()};
  await put('chapter',2,'content',changed);
  const sectionSnapshot=(await objects()).chapter;
  assert.equal((await api(`/api/projects/${project}/history/object/chapter`)).length,3,'Refused writes do not append history');
  // Export v4 preserves both new content and the earlier v3 evidence through a real restart.
  const bundle=await api(`/api/projects/${project}/export`);
  assert.deepEqual([bundle.version,bundle.candidates.length,bundle.trials.length,bundle.adoptions.length],[4,3,7,1]);
  assert.ok(bundle.external_files.some(ref=>ref.uri==='https://example.test/design'));
  await stop();await start();
  assert.deepEqual((await objects()).chapter,sectionSnapshot,'Content order, source, lock and anchors survive process restart');
  assert.deepEqual((await rpc({view:'objects',project_id:project})).find(o=>o.id==='chapter').planning.sections,sectionSnapshot.planning.sections);
  assert.equal((await api(`/api/projects/${project}/trials`)).length,7);
  const sorted=value=>Array.isArray(value)?value.map(sorted):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,sorted(value[key])])):value;
  assert.deepEqual(sorted((await api(`/api/projects/${project}/trials/base`)).run),sorted(baseRun),'The saved trial is exactly what was sent, after restart');
  const copy=randomUUID();
  await api('/api/projects/command',{request_id:randomUUID(),project_id:copy,op:'import_project',bundle,name:'copy'});
  const copied=await api(`/api/projects/${copy}/trials`);
  const copiedChapter=(await api(`/api/projects/${copy}/objects`)).find(o=>o.id==='chapter');
  assert.deepEqual(copiedChapter.planning,sectionSnapshot.planning,'v4 content imports beside trial evidence');
  assert.deepEqual(copied.map(t=>t.digest).sort(),allTrials.map(t=>t.digest).sort(),'Digests survive the project ID remap');
  const tampered=structuredClone(bundle);tampered.trials[0].run.events[0].label='edited';
  await api('/api/projects/command',{request_id:randomUUID(),project_id:randomUUID(),op:'import_project',bundle:tampered,name:'bad'},400);
  await api('/api/projects/command',{request_id:randomUUID(),project_id:randomUUID(),op:'import_project',bundle:{...bundle,version:2},name:'bad'},400);
  await api('/api/projects/command',{request_id:randomUUID(),project_id:randomUUID(),op:'import_project',bundle:{...bundle,version:3},name:'bad'},400);
  console.log(JSON.stringify({passed:true,scope:'isolated REST/MCP, real server restart; content sections, old-writer refusal, anchors, candidates, immutable trials, adoption, v4 portability',project,copy,trials:copied.length,state}));
} finally { await stop(); }

import assert from 'node:assert/strict';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';

// Isolated in-memory fixtures only; no project database, Unity or network.
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const bundle=await build({stdin:{contents:"export * from './src/game-flow-model.ts'; export * from './src/game-flow-replay.ts'; export * from './src/project-planning-model.ts';",resolveDir:root,loader:'ts'},bundle:true,format:'esm',write:false,platform:'neutral',logLevel:'silent'});
const model=await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);

const P='fixture-project';
const actor={kind:'user',label:'fixture'};
const planning=extra=>({scopes:['R0'],confirmed:false,body:'',links:[],references:[],...extra});
const energy={id:'energy',project_id:P,name:'Energy',kind:'parameter',revision:2,archived:false,planning:planning({locked:true,parameter:{value:'3',unit:'pt',min:'0',max:'10',formula:'',variants:[]}})};
const step=(id,title,extra={})=>({id,title,goal:'',action:'',feedback:'',external:false,terminal:false,choices:[],...extra});
const flow={id:'flow',project_id:P,name:'First trip',kind:'flow',revision:3,archived:false,planning:planning({locked:true,links:[{target_id:'energy',relation:'uses',note:''}],flow:{entry:'start',variables:[
  {id:'stamina',name:'Stamina',value_type:'number',initial:'',unit:'',parameter_id:'energy'},{id:'reward',name:'Reward',value_type:'number',initial:'5',unit:''},{id:'coins',name:'Coins',value_type:'number',initial:'0',unit:''}],
  steps:[step('start','Start',{choices:[{id:'go',label:'Spend two',to:'fight',conditions:[{variable_id:'stamina',op:'gte',operand:{kind:'literal',value:'2'}}],effects:[{variable_id:'stamina',op:'subtract',operand:{kind:'literal',value:'2'}}]}]}),
    step('fight','Fight',{external:true,choices:[{id:'finish',label:'Collect',to:'end',conditions:[],effects:[{variable_id:'coins',op:'add',operand:{kind:'variable',value:'reward'}}]}]}),
    step('end','Settle',{terminal:true})]}})};
const hook={id:'hook',project_id:P,name:'Worth continuing',kind:'hook',revision:4,archived:false,planning:planning({hook:{cue:'',action:'',payoff:'',continuation:''},anchors:[{flow_id:'flow',step_id:'start',phase:'cue'},{flow_id:'flow',step_id:'end',phase:'payoff'}]})};
const rule={id:'rule',project_id:P,name:'Entry cost',kind:'rule',revision:1,archived:false,planning:planning({rule:{trigger:'',condition:'',effect:''},anchors:[{flow_id:'flow',step_id:'start',choice_id:'go',note:'costs two'}]})};
const candidate=(id,label,value)=>({id,project_id:P,parameter_id:'energy',label,value,reason:'fixture',base:{revision:2,value:'3',unit:'pt',min:'0',max:'10'},revision:1,archived:false,created_at_ms:1,updated_at_ms:1,updated_by:actor});
const low=candidate('low','Low','1'), high=candidate('high','High','5');
const objects=[energy,flow,hook,rule];

// Input precedence and provenance.
const byVariable=(items,id)=>items.find(item=>item.variable.id===id);
assert.equal(byVariable(model.resolveFlowInputs(flow,objects),'stamina').source.source,'shared');
const withLow=byVariable(model.resolveFlowInputs(flow,objects,{}, {energy:low}),'stamina');
assert.deepEqual([withLow.value,withLow.source.source,withLow.source.candidate_id],['1','candidate','low']);
const localFlow=structuredClone(flow);localFlow.planning.links[0].local={value:'4',reason:'intro'};
const masked=byVariable(model.resolveFlowInputs(localFlow,objects,{}, {energy:low}),'stamina');
assert.deepEqual([masked.value,masked.source.source],['4','local']);assert.match(masked.note,/未生效.*局部覆盖优先/);
const typed=byVariable(model.resolveFlowInputs(flow,objects,{stamina:'9'},{energy:low}),'stamina');
assert.deepEqual([typed.value,typed.source.source],['9','override']);assert.match(typed.note,/手动初值优先/);
const maskedRun=model.startFlowRun(localFlow,objects,{},{candidates:[low]});
assert.equal(maskedRun.candidates,undefined,'A masked candidate is not recorded as used');assert.equal(maskedRun.initial.stamina,4);

// A complete run with frozen anchors and path facts.
let base=model.startFlowRun(flow,objects,{});
assert.deepEqual([base.version,base.initial.stamina,base.anchors.length,base.input_sources.length],[2,3,3,3]);
const facts=run=>model.pathFacts(run).map(fact=>fact.text).join('\n');
assert.match(facts(base),/线索步骤「Start」已到达（开始时）/);assert.match(facts(base),/回报步骤「Settle」未到达/);assert.match(facts(base),/选择「Spend two」未执行/);
base=model.advanceFlow(base,'go');base=model.confirmManualResult(base,{reward:'7'});base=model.advanceFlow(base,'finish');
assert.equal(model.runPosition(base).complete,true);assert.equal(base.events.at(-1).after.coins,7);
assert.match(facts(base),/规则「Entry cost」 · 选择「Spend two」已执行（第 1 个动作）/);assert.match(facts(base),/回报步骤「Settle」已到达（第 3 个动作后）/);
assert.doesNotMatch(facts(base),/兑现|成功|理解|有效/,'Path facts must not claim experience outcomes');
assert.deepEqual(model.verifyRun(base),[]);
const tampered=structuredClone(base);tampered.events[2].after.coins=99;assert.match(model.verifyRun(tampered).join(),/结果与重算不一致/);
const wrongInitial=structuredClone(base);wrongInitial.initial.stamina=8;wrongInitial.events[0].before.stamina=8;assert.match(model.verifyRun(wrongInitial).join(),/初值与来源快照不一致/);
// Server-returned states are key-sorted; comparisons must not depend on key order.
const sorted=JSON.parse(JSON.stringify(base,(key,value)=>value&&typeof value==='object'&&!Array.isArray(value)?Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b))):value));
assert.deepEqual(model.verifyRun(sorted),[]);

// Legacy local runs keep what happened and gain rebuilt provenance.
const legacy={...structuredClone(base),version:1};delete legacy.input_sources;delete legacy.anchors;
const upgraded=model.upgradeRun(legacy);assert.equal(upgraded.version,2);assert.equal(upgraded.input_sources[0].source,'shared');assert.deepEqual(model.verifyRun(upgraded),[]);

// Record text references the saved trial, not a local slot that can be overwritten.
const record=model.flowRecord(base,{id:'trial-1',digest:'abcdef0123456789'});
assert.match(record.result,/项目试走记录 trial-1/);assert.doesNotMatch(record.result+record.boundaries,/完整轨迹保留在本地/);assert.match(record.boundaries,/不评价体验/);

// Replay: same inputs pause at the manual step; reuse is explicit and marked.
const frozen=JSON.stringify(base);
let same=model.startReplay({trialId:'trial-1',run:base},flow,objects,{},[]);
assert.deepEqual([same.replay.status,same.replay.cursor,same.events.length],['paused',1,1]);
const reuse=model.reusableManual(same,base);assert.equal(reuse.contextChanged,false);
same=model.replayReuseManual(same,base);
assert.equal(same.replay.status,'complete');assert.equal(same.events[1].assumption.base_trial_id,'trial-1');
let comparison=model.compareRuns(base,same);assert.equal(comparison.route,undefined);assert.equal(comparison.value,undefined);assert.equal(comparison.assumptions.length,1);
assert.equal(JSON.stringify(base),frozen,'Replay must not modify the base trial');

// A candidate that blocks the first choice stops with the exact reason.
const blocked=model.startReplay({trialId:'trial-1',run:base},flow,objects,{},[low]);
assert.deepEqual([blocked.replay.status,blocked.replay.divergence.kind,blocked.replay.divergence.index,blocked.events.length],['diverged','condition',0,0]);
assert.match(blocked.replay.divergence.detail,/Stamina 大于等于 2（当前 1）/);
comparison=model.compareRuns(base,blocked,{a:'基准',b:'候选 Low'});
assert.match(comparison.route.text,/第 1 个动作：候选 Low 停止重放/);assert.match(comparison.value.text,/初值：Stamina 基准 3 · 候选 Low 1/);
assert.match(comparison.candidateInputs.join(),/使用候选「Low」= 1/);assert.match(comparison.endB,/停止/);

// A candidate that changes the state before a manual step flags reused results.
let higher=model.startReplay({trialId:'trial-1',run:base},flow,objects,{},[high]);
assert.equal(model.reusableManual(higher,base).contextChanged,true);
const typedManual=model.replayManualInput(higher,base,{reward:'2'});assert.equal(typedManual.events[1].assumption,undefined);assert.equal(typedManual.replay.status,'complete');
higher=model.replayReuseManual(higher,base);assert.equal(higher.events[1].assumption.context_changed,true);
assert.match(model.compareRuns(base,higher).assumptions[0],/输入或依赖已与基准不同/);
assert.match(model.flowRecord(higher).boundaries,/手动假设/);

// A deleted choice or a changed target is a divergence, never a silent detour.
const noChoice=structuredClone(flow);noChoice.revision=4;noChoice.planning.flow.steps[0].choices=[{id:'other',label:'Rest',to:'end',conditions:[],effects:[]}];
assert.equal(model.startReplay({trialId:'trial-1',run:base},noChoice,objects,{},[]).replay.divergence.kind,'missing_choice');
const moved=structuredClone(flow);moved.planning.flow.steps[0].choices[0].to='end';
assert.equal(model.startReplay({trialId:'trial-1',run:base},moved,objects,{},[]).replay.divergence.kind,'target');

// Source status separates execution changes from editing metadata; snapshots are kept.
const unlocked={...structuredClone(flow),revision:4};delete unlocked.planning.locked;
let status=model.flowSourceStatus(base,unlocked,objects);
assert.deepEqual([status.changed,status.metadata],[false,true]);assert.match(status.details.join(),/执行定义未变/);
const note={...structuredClone(energy),revision:5};note.planning.body='new note';note.planning.parameter.variants=[{label:'x',value:'2',reason:''}];
status=model.flowSourceStatus(base,flow,[note,flow]);assert.deepEqual([status.changed,status.metadata],[false,true]);assert.match(status.details.join(),/执行值未变/);
const valued={...structuredClone(energy),revision:5};valued.planning.parameter.value='4';
status=model.flowSourceStatus(base,flow,[valued,flow]);assert.equal(status.changed,true);assert.match(status.details.join(),/共用值 3 → 4/);
assert.equal(model.flowSourceStatus(base,{...flow,archived:true},objects).changed,true);
assert.equal(model.flowSourceChanged(base,flow,objects),false);
assert.equal(base.source.revision,3,'The frozen source revision is kept');

// Candidate base differences and anchor helpers.
assert.deepEqual(model.candidateBaseChanges(low,energy),[]);assert.match(model.candidateBaseChanges(low,valued).join(),/共用值 3 → 4/);
assert.equal(model.anchoredDesigns(objects,'flow','start').length,2);assert.equal(model.anchoredDesigns(objects,'flow','start',null).length,1);
assert.equal(model.anchorProblem({flow_id:'flow',step_id:'gone'},objects),'流程「First trip」中已没有这个步骤');
assert.deepEqual(model.planningImpact(objects,'flow').map(item=>item.object.id).sort(),['hook','rule']);
console.log('game flow trials passed: input precedence/provenance, masked candidates, frozen anchors, factual path reports, recomputed verification, legacy upgrade, saved-trial record text, replay pause/explicit assumption, first divergence, comparison, execution vs metadata freshness');

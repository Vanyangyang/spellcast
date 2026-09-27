/**
 * Browser fixture for the AI-first game workspace. Every API call is intercepted: no real task,
 * repository, Codex pipe or database is touched. The fixture's "agent" steps are scripted state
 * changes that mimic what a bound Codex task would do through MCP; they prove UI behaviour only.
 * It also carries the safety assertions of the retired Level-objects fixture
 * (scripts/check-project-game-ui.mjs is now a compatibility entry for this file): repository text
 * renders as text, one snapshot per open, explicit vs incremental re-reads, stale writes refused,
 * retries keep their request id, records scoped to their object, and zone errors keep navigation.
 *   npm run build && node scripts/check-game-ai-workspace.mjs
 */
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {spawn} from 'node:child_process';
import {mkdir, writeFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const require=createRequire(import.meta.url);
let playwright;try{playwright=require('playwright');}catch{playwright=require(process.env.SPELLCAST_PLAYWRIGHT||path.join(homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));}
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const out=path.join(root,'artifacts/game-ai-workspace');
const port=Number(process.env.SPELLCAST_GAME_AI_PORT||47319),origin=`http://127.0.0.1:${port}`,api='http://127.0.0.1:47194';
const H=c=>c.repeat(64);
const project={id:'6e97a7c6-3fee-4348-a67e-9d6aefb6e185',name:'VESPERIX fixture',aliases:['C:/fixture/VESPERIX'],revision:1,archived:false,created_at_ms:1,updated_at_ms:1};
const connection={project_id:project.id,adapter:'vesperix',root:'C:/fixture/VESPERIX',revision:1,connected_at_ms:1};
const C='Assets/Resources/Configs/DungeonExploration';
const thread='22222222-2222-4222-8222-222222222222',source=`codex:${thread}`;
const agent={kind:'agent',label:'VESPERIX 主线',source_id:source,thread_id:thread,cwd:'C:/fixture/VESPERIX'};
const user={kind:'user',label:'用户'};
const now=Date.UTC(2026,8,27,8);
const src=(p,h='a')=>({path:p,hash:H(h)});
const documents=[
  {...src('Assets/Documents/Atlas/domains/cycle.md','1'),title:'四层循环',lines:120,headings:8,identifiers:4},
  {...src('Assets/Documents/Content/Regions/YongshengForest/ZoneDesign.md','d'),title:'神祠设计<img src=x onerror="window.injected=9">',lines:84,headings:4,identifiers:8},
  {...src('Assets/Documents/Standards/Battle-Standards.md','e'),title:'战斗标准',lines:45,headings:3,identifiers:1},
];

const loop={source:{path:'Assets/Documents/Atlas/domains/cycle.md',hash:H('1'),heading:'四层循环',line:46},columns:['层级','时长','循环内容'],basis:'design',rows:[
  ['短期','5-10 分钟','进入地牢 → 选择 Zone/SubLocation → 触发 Content → 战斗/商店/休息/事件/宝藏 → 获得资源 → 继续或退出'],
  ['中期','1-2 小时','多次探索 → 积累经验/资源 → 满足突破条件 → 消耗材料突破 → 解锁新能力 → 挑战更高难度'],
  ['长期','20-30 小时/周目','达到金丹后期 → 选择保留内容 → 执行轮回 → 获得永久加成 → 重新开始 → 探索新内容'],
  ['元循环','跨周目','多次轮回累积 → 天赋树完全解锁 → 顶级装备收集 → 最高难度挑战 → 真结局/完美通关']]};
const zoneRef=(id,name,locations,routes,extra={})=>({id,name,locations,routes,path:`${C}/Zones/${id}.json`,configured:true,...extra});
const overview={connection,world:{id:'shanhai_world',name:'山海世界',starting_region_id:'region_yongsheng_forest',region_order:['region_yongsheng_forest','region_cangyan_mountain'],source:src('Assets/Resources/Configs/Worlds/shanhai_world.json','2')},loop,
  regions:[{id:'region_yongsheng_forest',name:'永生林',description:'古老的森林，生机盎然却暗藏危机。',main_quest_id:'main_quest_yongsheng_forest',main_quest_found:false,in_world:true,source:src('Assets/Resources/Configs/Regions/region_yongsheng_forest.json','3'),
    dungeons:[{id:'dungeon_forest_shrine',name:'永生林神祠',zones:[zoneRef('zone_forest_shrine_outer','外围林地',6,6),zoneRef('zone_forest_shrine_inner','神社庭院',8,8,{hidden:true}),zoneRef('zone_forest_shrine_core','森林核心',4,0),{id:'zone_forest_shrine_sanctum',name:'zone_forest_shrine_sanctum',locations:0,routes:0,configured:false}],source:src(`${C}/Dungeons/region_yongsheng_forest/dungeon_forest_shrine.json`,'4')}]},
   {id:'region_cangyan_mountain',name:'苍岩山',description:'巍峨的山脉。',main_quest_id:'main_quest_cangyan_chain',main_quest_found:true,in_world:true,source:src('Assets/Resources/Configs/Regions/region_cangyan_mountain.json','5'),
    dungeons:[{id:'dungeon_jade_mountain_cavern',name:'玉山青石洞',zones:[zoneRef('zone_jade_cave_entry','洞口',5,0)],source:src(`${C}/Dungeons/region_cangyan_mountain/dungeon_jade_mountain_cavern.json`,'6')}]}],
  routed_zones:[{...zoneRef('zone_forest_shrine_outer','外围林地',6,6),dungeon_id:'dungeon_forest_shrine',region_id:'region_yongsheng_forest'},{...zoneRef('zone_forest_shrine_inner','神社庭院',8,8),dungeon_id:'dungeon_forest_shrine',region_id:'region_yongsheng_forest'}],
  counts:{regions:17,dungeons:37,zones:152,routed_zones:5,locations:611,contents:882,battles:37,loot_tables:690,missions:79,design_documents:398,code_files:917},
  issues:[{severity:'warning',message:'区域主线 MainQuestId=main_quest_yongsheng_forest 没有对应的任务配置。',path:'Assets/Resources/Configs/Regions/region_yongsheng_forest.json'}],documents,source_revision:H('c'),runtime_verified:false};

const cand=(id,name,kind,associated,assocName,extra={})=>({id,name,kind,description:'',weight:null,first_entry:false,gate:false,missing:false,associated_id:associated,associated_name:assocName,enemies:[],enemy_ids:[],loot_table_id:null,loot_table_name:null,paths:[`${C}/Contents/${id}.json`],...extra});
const loc=(id,name,x,extra={})=>({id,name,description:`${name}的配置描述。`,x,y:200,role:'location',missing:false,path:`${C}/SubLocations/${id}.json`,unlocks_zone:null,candidates:[],loot_points:[],rest:false,unlock_cost:null,...extra});
const locations=[
  loc('subloc_ancient_tree_root','古树根部',100,{candidates:[cand('content_battle_mutant_deer','变异灵鹿','Battle','battle_mutant_deer','异化之鹿',{weight:40,first_entry:true,enemies:['pet_haozhi · Lv 2'],enemy_ids:['pet_haozhi'],loot_table_id:'monster_drop_pet_haozhi',loot_table_name:'豪彘掉落'}),cand('content_treasure_buried_relic','埋藏的遗物','Treasure','treasure_buried_relic','埋藏的遗物',{weight:10,loot_table_id:'loot_treasure_buried_relic',loot_table_name:'遗物宝箱'})],
    loot_points:[{id:'loot_ancient_tree_herb1',name:'ui.loot.root_spirit_fungus',kind:'HerbGatheringPoint',loot_table_id:'loot_herb_forest_zone1',loot_table_name:'永生林·Z1 草药点',category:'GatheringPoint',unlock_condition:null,missing:false,path:`${C}/LootTables/loot_herb_forest_zone1.json`}]}),
  // Repository text is untrusted: these payloads must stay literal text wherever they render.
  loc('subloc_misty_path','迷雾小径',250,{description:'雾中小径<img src=x onerror="window.injected=1">的配置描述。',candidates:[cand('content_battle_forest_minor','林间小妖','Battle','battle_forest_spirit_minor_001','林间精怪',{enemies:['pet_forest_frog · Lv 1'],enemy_ids:['pet_forest_frog'],loot_table_id:'monster_drop_pet_forest_frog',loot_table_name:'林蛙掉落'}),cand('content_event_misty_lost','迷雾中迷失','Event','event_misty_lost','迷雾中迷失<svg onload="window.injected=5">')]}),
  loc('subloc_spirit_spring','灵泉',400,{rest:true,candidates:[cand('content_rest_spirit_spring','灵泉休息','Rest','rest_spirit_spring','灵泉')]}),
  loc('subloc_forest_clearing','林间空地',400,{role:'shop',candidates:[cand('shop_forest_merchant','永生林行商','shop',null,null)]}),
  loc('subloc_beast_den','野兽巢穴',620,{unlock_cost:30,candidates:[cand('content_battle_forest_beast','巢穴之主','Battle','battle_forest_beast_001','巢穴之主',{enemies:['pet_haozhi · Lv 2'],enemy_ids:['pet_haozhi'],loot_table_id:'monster_drop_pet_haozhi',loot_table_name:'豪彘掉落'})],
    loot_points:[{id:'loot_beast_den_chest1',name:'ui.loot.prey_remains',kind:'TreasureChest',loot_table_id:'loot_beast_den_trophy',loot_table_name:'兽穴·战利品',category:'BeastTrophy',unlock_condition:'BattleVictory',missing:false,path:`${C}/LootTables/loot_beast_den_trophy.json`}]}),
  loc('subloc_zone1_to_zone2_gate','迷雾出口',800,{role:'gate',unlocks_zone:'zone_forest_shrine_inner',candidates:[cand('content_battle_gate_guardian','守门树人','BossGate','battle_mist_treant_bossgate','雾林树人',{gate:true,enemies:['pet_shurenshouwei · Lv 4'],enemy_ids:['pet_shurenshouwei']})]}),
];
const zoneRoutes=[['subloc_ancient_tree_root','subloc_misty_path'],['subloc_misty_path','subloc_spirit_spring'],['subloc_misty_path','subloc_forest_clearing'],['subloc_forest_clearing','subloc_beast_den'],['subloc_beast_den','subloc_zone1_to_zone2_gate'],['subloc_spirit_spring','subloc_beast_den']].map(([from,to])=>({from,to}));
const sources=[src(`${C}/Zones/zone_forest_shrine_outer.json`,'7'),...locations.map((l,i)=>src(l.path,String.fromCharCode(98+i)))];
const mention=(heading,line,excerpt,file='Assets/Documents/Content/Regions/YongshengForest/EverlastingForestShrine/SubLocationDesign.md')=>({path:file,hash:H('d'),title:'EverlastingForestShrine - SubLocation 详细设计',heading,line,excerpt});
const relations={region:{id:'region_yongsheng_forest',name:'永生林',source:src('Assets/Resources/Configs/Regions/region_yongsheng_forest.json','3')},
  dungeon:{id:'dungeon_forest_shrine',name:'永生林神祠',type:'Shrine',zone_ids:['zone_forest_shrine_outer'],source:src(`${C}/Dungeons/region_yongsheng_forest/dungeon_forest_shrine.json`,'4')},
  missions:[{id:'main_quest_yongsheng_1_enter',name:'初入迷林',type:'Combat',dungeon_id:'dungeon_forest_shrine',objectives:[{id:'obj_yongsheng_1_kill_fox',name:'击败林间狐仙',type:'Combat',enemy_id:'pet_haozhi',amount:3,at:[{location_id:'subloc_ancient_tree_root',candidate_id:'content_battle_mutant_deer'}]}],
    basis:[{kind:'dungeon',text:'任务配置 dungeonId = dungeon_forest_shrine'},{kind:'enemy',text:'目标敌人 pet_haozhi 出现在本 Zone 的战斗候选中'}],source:src('Assets/Resources/Configs/Missions/region_yongsheng_forest/main_quest_yongsheng_chain.json','8')}],
  design:{zone_forest_shrine_outer:[mention('Zone: zone_forest_shrine_outer',40,'### Zone: zone_forest_shrine_outer'),mention('Zone 1: 外围林地 (Outer Woods)',43,'外围林地是第一次进入神祠的教学区域。','Assets/Documents/Content/Regions/YongshengForest/EverlastingForestShrine/ZoneDesign.md')],
    subloc_ancient_tree_root:[mention('`zone_forest_shrine_outer` 路线与首次内容',99,'| subloc_ancient_tree_root | 首次战斗 content_battle_mutant_deer |')],content_battle_mutant_deer:[mention('Zone: zone_forest_shrine_outer',44,'- content_battle_mutant_deer：入口的首次战斗。')],
    subloc_misty_path:[mention('迷雾小径',70,'<script>window.injected=2</script> 迷雾让玩家在这里迷失方向。')]},
  code:{SubLocationRoutes:[{path:'Assets/Scripts/DungeonExplorationSystem/Data/DungeonZoneConfig.cs',hash:H('e'),line:81,text:'public List<SubLocationRoute> SubLocationRoutes = new List<SubLocationRoute>();'}],
    ContentPoolWeights:[{path:'Assets/Scripts/DungeonExplorationSystem/Managers/ZoneExplorationManager.cs',hash:H('f'),line:512,text:'var weight = subLocation.ContentPoolWeights[contentId];'}],
    LootTableId:[{path:'Assets/Scripts/Services/LootService.cs',hash:H('9'),line:77,text:'var table = LoadTable(point.LootTableId);'}]},loop};
const zoneView={zone:{id:'zone_forest_shrine_outer',name:'外围林地',locations:6,routes:6,path:`${C}/Zones/zone_forest_shrine_outer.json`},dungeon_id:'dungeon_forest_shrine',description:'永生林神祠的外围，木系灵脉从地底渗入地表。',entry:'subloc_ancient_tree_root',locations,routes:zoneRoutes,sources,issues:[],source_revision:H('7'),runtime_verified:false};

const record=(id,title,status,extra={})=>({id,project_id:project.id,title,status,goal:'',scope:'',result:'',boundaries:'代码存在与配置接入不等于玩家路线验收。',next_step:'先从神祠外围选一条短路线。',references:[],revision:1,archived:false,created_at_ms:1,updated_at_ms:2,updated_by:agent,...extra});
let records=[record('bebcbd18-004b-47e0-89de-3719ff71b163','探索闭环：确认一条真实玩家路线','planned',{references:[{label:'神祠外围路线配置',uri:`file:///C:/fixture/VESPERIX/${C}/SubLocations/subloc_ancient_tree_root.json`,version:'ff12809e7'}]}),
  record('c47965a1-c33e-48ec-ae64-818837bb56a6','项目接入基线 · 2026-09-23','active',{updated_by:{kind:'agent',label:'改进 Canvas 内容可观测性',thread_id:'01a0ba9c-38d3-7190-ac76-076496862423',source_id:'01a0ba9c-38d3-7190-ac76-076496862423',cwd:'G:\\VibeProj\\spellcast'}}),
  record('aaaaaaaa-0000-4000-8000-000000000001','AI 预审：核对旧说法','active',{scope:'spellcast.document-review.v1',goal:'文档原文',result:'此处仍需用户核对，不自动认定过时。',references:[{label:'神祠设计',uri:'file:///C:/fixture/VESPERIX/Assets/Documents/Content/Regions/YongshengForest/ZoneDesign.md#L2-L2',version:H('d')},{label:'四层循环证据',uri:'file:///C:/fixture/VESPERIX/Assets/Documents/Atlas/domains/cycle.md#L1-L2',version:H('1')},{label:'代码依据',uri:'file:///C:/fixture/VESPERIX/Assets/Scripts/Test.cs#L8-L8',version:H('a')}],created_at_ms:now,updated_at_ms:now}),
  record('aaaaaaaa-0000-4000-8000-000000000002','旧版批注','active',{scope:'spellcast.document-review.v1',result:'旧版本的位置不可直接重用。',references:[{label:'神祠设计',uri:'file:///C:/fixture/VESPERIX/Assets/Documents/Content/Regions/YongshengForest/ZoneDesign.md#L2-L2',version:H('0')}],created_at_ms:now,updated_at_ms:now})];
const recordOrigins=new Map(records.map(r=>[r.id,r.updated_by]));
const planning=(extra)=>({scopes:['R0'],confirmed:false,body:'',links:[],references:[],...extra});
let objects=[{id:'elite-chance',project_id:project.id,name:'精英遭遇基础概率',kind:'parameter',revision:2,archived:false,planning:planning({confirmed:true,locked:true,parameter:{value:'0.08',unit:'',min:'0',max:'1',formula:'',variants:[]}})},
  {id:'loot-rhythm',project_id:project.id,name:'外围林地奖励节奏',kind:'content',revision:3,archived:false,planning:planning({body:'用户已经改写过的奖励节奏。'})}];
const item=(id,target_id,base,object,extra={})=>({id,target:'object',target_id,base_revision:base,object,reason:'路线与遭遇来自配置；节奏来自 ZoneDesign。',basis:['config','design'],references:[{label:'zone_forest_shrine_outer.json',uri:`file:///C:/fixture/VESPERIX/${C}/Zones/zone_forest_shrine_outer.json`,version:H('7')}],boundaries:'未在 Unity 中走过，也没有玩家输入。',status:'pending',...extra});
let proposals=[{id:'outer-first-visit',project_id:project.id,revision:1,title:'外围林地 · 第一次进入的体验',summary:'按已声明路线整理入口到出口的遭遇与奖励，并标出需要真实验证的地方。',subject:{scale:'experience',zone_id:'zone_forest_shrine_outer'},items:[
    item('route','outer-first-visit-content',0,{name:'外围林地 · 首次进入',kind:'content',planning:planning({sections:[{id:'s1',role:'body',text:'从古树根部的首次战斗开始，经迷雾小径到灵泉休整，再进入野兽巢穴与出口守门战。'},{id:'s2',role:'question',text:'野兽巢穴 30 的解锁花费是否符合 R0 的资源节奏？'}]})}),
    item('elite','elite-chance',2,{name:'精英遭遇基础概率',kind:'parameter',planning:planning({parameter:{value:'0.1',unit:'',min:'0',max:'1',formula:'',variants:[]}})},{basis:['config','inference']}),
    item('stale','loot-rhythm',1,{name:'外围林地奖励节奏',kind:'content',planning:planning({body:'基于旧版本的奖励节奏。'})},{reason:'<img src=x onerror="window.injected=3">基于旧版本写的奖励节奏理由。'}),
    {id:'verify',target:'record',target_id:'verify-outer-route',base_revision:0,record:{title:'在 Unity 中走一遍外围林地入口到出口',status:'planned',goal:'用真实输入确认路线与首次战斗。',boundaries:'尚未运行。'},reason:'配置事实不能证明玩家路线。',basis:['inference'],references:[],boundaries:'',status:'pending'}],
  references:[],boundaries:'静态配置与设计文档；没有运行结果。',status:'open',created_at_ms:now-3600e3,updated_at_ms:now-3600e3,created_by:agent,updated_by:agent}];
let bindings=[],accesses=[],goals=[],seq=0,decisions=[],returns=[],unexpected=[],pageErrors=[],bindCalls=[];
/** Read and replay evidence: which snapshots were requested, and every attempted goal id. */
let overviewRequests=[],viewRequests=[],goalPosts=[],forbidden=0,failNextGoal=false,failNextRecord=false;

function goalView(g){return {...g,delivery:g.delivery,proposal_ids:proposals.filter(p=>p.goal_id===g.id).map(p=>p.id)};}
/** Scripted "agent": each poll advances a sent goal one step; on reading it asks for access, then proposes. */
function advance(){for(const g of goals){if(g.status!=='sent')continue;const phase=g.delivery.phase;
  if(phase==='waiting')g.delivery={phase:'submitted',host_status:'active'};
  else if(phase==='submitted'){g.delivery={phase:'received'};if(!accesses.some(a=>a.thread_id===thread))accesses.push({id:'access-1',project_id:project.id,source_id:source,thread_id:thread,cwd:'C:/fixture/VESPERIX',label:'VESPERIX 主线',state:'pending',revision:1,created_at_ms:now,expires_at_ms:now+7*864e5});}
  else if(phase==='received'&&g.context.entity_kind!=='document_question'&&accesses.some(a=>a.thread_id===thread&&a.state==='approved')&&!proposals.some(p=>p.goal_id===g.id)){
    proposals.unshift({id:`answer-${g.id.slice(0,8)}`,project_id:project.id,revision:1,title:'灵泉 · 休整节奏',summary:'回应目标：在灵泉加入休整与回复的说明。',subject:{scale:'object',zone_id:'zone_forest_shrine_outer',location_id:'subloc_spirit_spring'},goal_id:g.id,
      items:[item('rest','spring-rest',0,{name:'灵泉 · 休整',kind:'content',planning:planning({body:'在灵泉恢复一半生命，并提示前方巢穴的危险。'})})],references:[],boundaries:'未验证。',status:'open',created_at_ms:now,updated_at_ms:now,created_by:agent,updated_by:agent});
    g.delivery={phase:'responded'};}}}

function decide(body){
  const proposal=proposals.find(p=>p.id===body.id);if(!proposal)return [400,{error:'找不到提案'}];
  if(proposal.revision!==body.expected_revision)return [400,{error:`提案 revision 已变化；当前是 ${proposal.revision}，请求的是 ${body.expected_revision}。`}];
  const adopted_objects=[],adopted_records=[];
  for(const id of body.item_ids){const it=proposal.items.find(i=>i.id===id);
    if(body.revised_object)it.object=body.revised_object,it.edited_by=user;
    if(body.decision==='adopt'){
      if(it.target==='object'){const current=objects.find(o=>o.id===it.target_id);
        if(it.base_revision===0&&current)return [400,{error:'已存在'}];
        if(it.base_revision&&current&&current.revision!==it.base_revision)return [400,{error:`对象「${current.name}」已从提案基准版本 ${it.base_revision} 变为 ${current.revision}；为避免覆盖，没有写入。`}];
        if(current?.planning?.locked&&!body.unlock)return [400,{error:`「${current.name}」已锁定。确认要用提案内容替换时，请明确选择「解锁并采纳」。`}];
        const next={id:it.target_id,project_id:project.id,name:it.object.name,kind:it.object.kind,revision:(current?.revision||0)+1,archived:false,planning:{...it.object.planning,confirmed:body.confirm,locked:body.confirm}};
        objects=[...objects.filter(o=>o.id!==next.id),next];adopted_objects.push(next);it.decision={status:'adopted',at_ms:now,actor:user,request_id:body.request_id,note:body.note,revised:!!it.edited_by,confirmed:body.confirm,unlocked:!!body.unlock,applied_revision:next.revision};}
      else{const next={...record(it.target_id,it.record.title,it.record.status||'planned'),goal:it.record.goal||'',boundaries:it.record.boundaries||'',updated_by:user};records=[...records,next];adopted_records.push(next);it.decision={status:'adopted',at_ms:now,actor:user,request_id:body.request_id,note:'',revised:false,confirmed:false,unlocked:false,applied_revision:1};}
      it.status='adopted';}
    else if(body.decision==='return'){it.status='returned';it.decision={status:'returned',at_ms:now,actor:user,request_id:body.request_id,note:body.note,revised:false,confirmed:false,unlocked:false};}
    else if(body.decision==='dismiss'){it.status='dismissed';it.decision={status:'dismissed',at_ms:now,actor:user,request_id:body.request_id,note:body.note,revised:false,confirmed:false,unlocked:false};}
    else if(body.decision==='revise'){it.status='pending';}}
  proposal.revision++;proposal.status=proposal.items.some(i=>i.status==='pending'||i.status==='returned')?'open':'closed';
  return [200,{proposal,adopted_objects,adopted_records,replayed:false}];
}

let holdNextRecordWrite;
const board={topic:'game-ai',form:'spatial',form_reason:'',nodes:[],edges:[],messages:[],replies:[],canvas:{revision:1,objects:[],items:[]}};
const health={surface:'ambient',port:47194,last_call_ms:0,calls:0,paused:false,observer_enabled:false,observer_policy_revision:1,observer_allowed:true,observer_reason:'fixture'};
const send=(route,value,status=200)=>route.fulfill({status,contentType:'application/json',headers:{'access-control-allow-origin':origin,'access-control-allow-headers':'content-type,x-spellcast-window','access-control-allow-methods':'GET,POST,OPTIONS,DELETE'},body:JSON.stringify(value)});
async function routes(route,request){
  const url=new URL(request.url());
  if(url.origin!==api){if(url.origin===origin)return route.continue();if(url.hostname.endsWith('googleapis.com')||url.hostname.endsWith('gstatic.com'))return route.fulfill({contentType:'text/css',body:''});unexpected.push(request.url());return route.abort();}
  if(request.method()==='OPTIONS')return send(route,{},204);
  const p=url.pathname,method=request.method(),body=method==='POST'?request.postDataJSON():undefined,key=request.headers()['x-spellcast-window'];
  const owner=p.includes('/game/')||p.includes('/goals')||p.includes('/proposals')||p.endsWith('/command');
  if(owner&&key!=='fixture-key'){forbidden++;return send(route,{error:'missing private window credential'},403);}
  if(p==='/api/board')return send(route,board);
  if(p==='/api/canvas/batch'&&method==='POST'){
    for(const operation of body.operations){
      if(operation.op==='create'){
        assert.equal(board.canvas.objects.some(item=>item.id===operation.id),false,'source table create keeps one identity');
        board.canvas.objects.push({id:operation.id,content:operation.content,content_revision:1,origin:operation.origin||null,bindings:[],source_id:null,user_edited:false});
        board.canvas.items.push({item_id:operation.id,revision:1,z:0,removed:false,appearance:operation.placement.appearance||'card',x:operation.placement.x,y:operation.placement.y,width:operation.placement.width,height:operation.placement.height});
      }else if(operation.op==='patch_content'){
        const item=board.canvas.objects.find(item=>item.id===operation.id);
        assert.equal(item.content_revision,operation.expected_revision);
        assert.equal(item.content.type,'source_table');
        item.content={type:'source_table',table:operation.fields.source_table};item.content_revision++;
      }else throw Error(`unexpected canvas operation ${operation.op}`);
    }
    board.canvas.revision++;
    return send(route,{result:{request_id:body.request_id,status:'applied',targets:[]},board});
  }
  if(p==='/api/forms')return send(route,{forms:[{id:'spatial',label:'Spatial',blurb:''}]});
  if(p==='/api/health'||p==='/api/surface')return send(route,health);
  if(p==='/api/events')return send(route,{events:[],last_seq:0});
  if(p==='/api/memories')return send(route,{memories:[]});
  if(p==='/api/observer/status')return send(route,{enabled:false,paused:false,allowed:true,reason:'fixture',policy_revision:1});
  if(p==='/api/feedback')return send(route,{pending:[],deliveries:[],bindings});
  if(p==='/api/bindings/codex'&&method==='POST'){bindCalls.push(body);if(body.thread_id!==thread)return send(route,{error:'Codex 没有返回指定任务。'},400);const binding={source_id:body.source_id,thread_id:body.thread_id,cwd:body.cwd||'C:/fixture/VESPERIX',label:'VESPERIX 主线',protocol_agent:'fixture',bound_at_ms:now};bindings=[binding];return send(route,binding);}
  if(p==='/api/projects')return send(route,[project]);
  const base=`/api/projects/${project.id}`;
  if(p===`${base}/game/connection`)return send(route,{connection});
  if(p===`${base}/game/overview`){overviewRequests.push(url.search);return send(route,overview);}
  if(p===`${base}/game/document`){const file=documents.find(item=>item.path===url.searchParams.get('path'));return file?send(route,{...file,text:`# ${file.title}\n文档原文，仅供审查。文档原文同词。\n<script>window.injected=10</script>` }):send(route,{error:'文档不在已连接仓库的索引中。'},400);}
  if(p===`${base}/game/view`){viewRequests.push(url.search);const zone=url.searchParams.get('zone_id');if(zone&&zone!=='zone_forest_shrine_outer')return send(route,{connection,view:null,view_error:'这个 Zone 没有声明路线。',zones:[],selected_zone_id:zone,records:[],targets:[]});
    return send(route,{connection,view:zoneView,relations,records,targets:bindings,zone_object_id:'game-vesperix-zone',object_ids:locations.map((l,i)=>({location_id:l.id,object_id:`game-vesperix-${i}`})),zones:[overview.routed_zones[0]],selected_zone_id:'zone_forest_shrine_outer'});}
  if(p===`${base}/game/source`)return send(route,{path:url.searchParams.get('path'),hash:H('a'),json:{SubLocationId:'subloc_ancient_tree_root',DisplayName:'古树根部'}});
  if(p===`${base}/goals`&&method==='GET'){advance();return send(route,goals.map(goalView));}
  if(p===`${base}/goals`&&method==='POST'){goalPosts.push(body.id);
    if(failNextGoal){failNextGoal=false;return send(route,{error:'模拟一次暂时失败，请重试。'},500);}
    const existing=goals.find(g=>g.id===body.id);if(existing)return send(route,goalView(existing));
    const g={id:body.id,project_id:project.id,text:body.text,context:body.context,status:'unsent',revision:1,created_at_ms:now+goals.length,updated_at_ms:now,delivery:null};goals.unshift(g);return send(route,goalView(g));}
  const sendMatch=p.match(/\/goals\/([^/]+)\/send$/);
  if(sendMatch){const g=goals.find(x=>x.id===decodeURIComponent(sendMatch[1]));if(!bindings.some(b=>b.source_id===body.source_id&&b.thread_id===body.thread_id))return send(route,{error:'接收任务不是当前已关联的 Codex 任务；目标仍保存为未发送。'},400);
    g.status='sent';g.target={...bindings[0]};g.sequence=++seq;g.delivery={phase:'waiting'};return send(route,goalView(g));}
  const promoteMatch=p.match(/\/goals\/([^/]+)\/record$/);
  if(promoteMatch){const g=goals.find(x=>x.id===decodeURIComponent(promoteMatch[1]));g.record_id=`goal-${g.id}`;if(!records.some(r=>r.id===g.record_id))records.push(record(g.record_id,g.text.slice(0,40),'planned',{updated_by:user,boundaries:'由目标转为事项；尚未执行，也没有 Unity 或玩家验证结果。'}));return send(route,goalView(g));}
  if(p===`${base}/proposals`)return send(route,url.searchParams.get('archived')==='true'?proposals:proposals.filter(x=>x.status==='open'));
  if(p===`${base}/proposals/return`){returns.push(body);const bound=bindings.some(b=>b.thread_id===thread);return send(route,bound?{sent:true,sequence:++seq}:{sent:false,reason:'not bound'});}
  if(p==='/api/projects/command'&&method==='POST'){if(body.op==='decide_proposal'){decisions.push(body);const [status,value]=decide(body);return send(route,value,status);}
    if(body.op==='put_record'){
      if(holdNextRecordWrite){const wait=holdNextRecordWrite;holdNextRecordWrite=undefined;await wait();}
      if(failNextRecord){failNextRecord=false;return send(route,{error:'simulated record write conflict'},409);}
      const old=records.find(r=>r.id===body.id);if((old?.revision||0)!==body.expected_revision)return send(route,{error:'record revision conflict'},409);
      const next={...old,...body.fields,id:body.id,project_id:project.id,revision:(old?.revision||0)+1,archived:false,created_at_ms:old?.created_at_ms||now,updated_at_ms:now+records.length,updated_by:user};
      records=[...records.filter(r=>r.id!==body.id),next];return send(route,{record:next,replayed:false});
    }return send(route,{error:`fixture has no ${body.op}`},400);}
  if(p===`${base}/access`)return send(route,accesses);
  const accessMatch=p.match(/\/access\/([^/]+)$/);
  if(accessMatch&&method==='POST'){const a=accesses.find(x=>x.id===accessMatch[1]);a.state=body.decision;a.revision++;return send(route,a);}
  if(p===`${base}/objects`)return send(route,objects);
  if(p===`${base}/records`)return send(route,records);
  if(p.startsWith(`${base}/records/`))return send(route,records.find(r=>r.id===decodeURIComponent(p.split('/').at(-1))));
  if(p.includes('/history/')){const id=decodeURIComponent(p.split('/').at(-1));const actor=recordOrigins.get(id);return send(route,actor?[{project_id:project.id,kind:'record',id,revision:1,at_ms:now,actor,operation:'put_record',request_id:'fixture',snapshot:null}]:[]);}
  if(p===`${base}/candidates`||p===`${base}/trials`||p===`${base}/adoptions`)return send(route,[]);
  unexpected.push(`${method} ${p}`);return send(route,{error:`unexpected fixture route ${p}`},404);
}

const vite=spawn(process.execPath,[path.join(root,'node_modules/vite/bin/vite.js'),'preview','--host','127.0.0.1','--port',String(port),'--strictPort'],{cwd:root,windowsHide:true,stdio:'pipe'});
let viteOutput='',browser;vite.stdout.on('data',b=>viteOutput+=b);vite.stderr.on('data',b=>viteOutput+=b);
const report={scope:'isolated browser fixture: intercepted API, scripted agent state; no real task, repository or database',screenshots:[],checks:[]};
const ok=name=>report.checks.push(name);
async function openPage(theme,width,height){
  const context=await browser.newContext({viewport:{width,height}});
  await context.addInitScript(([t,h,a])=>{localStorage.setItem('spellcast.locale','zh-CN');localStorage.setItem('spellcast.theme',t);
    window.__TAURI_INTERNALS__={invoke:async command=>command==='project_window_key'?'fixture-key':command==='bridge_status'||command==='set_surface'?h:command==='get_board'?fetch(`${a}/api/board`).then(response=>response.json()):command==='list_forms'?{forms:[{id:'spatial',label:'Spatial',blurb:''}]}:undefined,transformCallback:()=>1,unregisterCallback:()=>{}};},[theme,health,api]);
  await context.route('**/*',routes);
  const page=await context.newPage();page.on('pageerror',error=>pageErrors.push(error.message));
  // 400/404/500 are the fixture's intentional refusals and its one simulated transient failure.
  page.on('console',m=>{if(m.type()==='error'&&!/status of (400|404|500)/.test(m.text()))console.error('[console]',m.text());});
  await page.goto(origin,{waitUntil:'commit'});
  await page.waitForFunction(()=>document.querySelector('#projects-open')?.textContent?.includes('游戏开发'));
  await page.locator('#projects-open').evaluate(e=>e.click());
  await page.waitForSelector('[data-game-home] [data-gh-section="loop"]');
  return {page,context};
}
async function shot(page,name){const file=path.join(out,`${name}.png`);await page.screenshot({path:file});report.screenshots.push(path.relative(root,file));}
async function noOverflow(page,label){const overflow=await page.evaluate(()=>{const d=document.querySelector('.project-workspace');return {page:document.documentElement.scrollWidth>innerWidth+1,panel:d?d.scrollWidth>d.clientWidth+2:false};});assert.deepEqual(overflow,{page:false,panel:false},`horizontal overflow at ${label}`);}

try{
  await mkdir(out,{recursive:true});
  for(let i=0;i<100;i++){try{if((await fetch(origin)).ok)break;}catch{}if(vite.exitCode!==null)throw Error(viteOutput);await new Promise(r=>setTimeout(r,100));}
  for(const channel of ['chrome','msedge']){try{browser=await playwright.chromium.launch({channel,headless:true});break;}catch{}}
  browser??=await playwright.chromium.launch({headless:true});
  const {page,context}=await openPage('dark',1600,1000);
  const home=page.locator('[data-game-home]');

  // 1. The AI-first home is the default; manual tools are not a flat row.
  assert.equal(await home.isVisible(),true);
  assert.equal(await page.locator('[data-plan-action="flows"]').isVisible(),false,'planning tools must not be visible at the top level');
  assert.equal(await page.locator('[data-project-view="planning"]').isVisible(),false,'views are inside the tools menu');
  assert.equal(await home.locator('[data-gh-section="loop"] tbody tr').count(),4);
  assert.match(await home.locator('[data-gh-section="loop"]').innerText(),/设计意图[\s\S]*cycle\.md[\s\S]*四层循环/);
  assert.match(await home.locator('[data-gh-section="explorable"]').innerText(),/外围林地/);
  assert.match(await home.innerText(),/Unity 与真实玩家结果没有接入 Spellcast，状态未知/);
  assert.match(await home.locator('[data-gh-region="region_yongsheng_forest"] summary').innerText(),/主线 main_quest_yongsheng_forest 没有对应的任务配置/);
  assert.deepEqual(overviewRequests,[''],'opening loads one combined overview snapshot from the incremental index');
  assert.equal(viewRequests.length,0,'no zone is read before one is opened');
  ok('home default: loop table from design source, explorable zones from config, unknown verification, no flat tool row, one snapshot');
  await shot(page,'overview-dark-1600');

  // Review stays inside the source reader. Seeded AI comments are discoverable without changing the document.
  await home.locator('[data-gh-action="open-documents"]').click();
  await home.locator('[data-gh-section="documents"]').waitFor();
  assert.equal(await home.locator('[data-gh-document]').count(),3);
  assert.equal(await home.locator('.gh-side').isVisible(),false,'document review uses the full reading width');
  await home.locator('[data-gh-document-filter]').selectOption('comments');
  assert.equal(await home.locator('[data-gh-document]:visible').count(),1,'AI pre-review makes the document discoverable');
  assert.match(await home.locator('[data-gh-document]:visible').innerText(),/2 条批注 · 2 条待核对/);
  await home.locator('[data-gh-document-search]').fill('ZoneDesign');
  assert.equal(await home.locator('[data-gh-document]:visible').count(),1);
  await home.locator('[data-gh-document="Assets/Documents/Content/Regions/YongshengForest/ZoneDesign.md"] [data-gh-action="read-document"]').click();
  assert.match(await home.locator('[data-gh-document-text]').innerText(),/文档原文，仅供审查/);
  assert.equal(await page.evaluate(()=>window.injected),undefined,'untrusted document titles stay text');
  assert.match(await home.locator('[data-gh-review-record="aaaaaaaa-0000-4000-8000-000000000001"]').innerText(),/AI 预审[\s\S]*此处仍需用户核对/);
  await home.locator('[data-gh-review-record="aaaaaaaa-0000-4000-8000-000000000001"] .gh-review-evidence summary').click();
  assert.match(await home.locator('[data-gh-review-record="aaaaaaaa-0000-4000-8000-000000000001"] .gh-review-evidence').innerText(),/四层循环证据[\s\S]*cycle\.md#L1-L2[\s\S]*代码依据/);
  assert.equal(await home.locator('[data-gh-review-record="aaaaaaaa-0000-4000-8000-000000000001"] [data-gh-action="read-review-evidence"]').count(),1);
  assert.match(await home.locator('[data-gh-review-record="aaaaaaaa-0000-4000-8000-000000000002"]').innerText(),/来源版本已变化/);
  assert.equal(await home.locator('[data-gh-review-record="aaaaaaaa-0000-4000-8000-000000000002"] [data-gh-action="jump-comment"]').isDisabled(),true);
  const selectWord=async(second=false,ctrl=false)=>{await home.locator('[data-gh-document-line="2"]').waitFor();return page.evaluate(({second,ctrl})=>{const line=document.querySelector('[data-gh-document-line="2"]');const text=line.firstChild.textContent;const at=second?text.indexOf('文档原文',1):text.indexOf('文档原文');const range=document.createRange();range.setStart(line.firstChild,at);range.setEnd(line.firstChild,at+4);const selection=window.getSelection();selection.removeAllRanges();selection.addRange(range);line.dispatchEvent(new MouseEvent('mouseup',{bubbles:true,ctrlKey:ctrl}));},{second,ctrl});};
  await selectWord();await home.locator('[data-gh-selection-toolbar]:visible').waitFor();
  assert.match(await home.locator('[data-gh-selection-count]').innerText(),/已选 1 段/);
  await home.locator('[data-gh-action="toggle-append-selection"]').click();
  await selectWord(true);assert.match(await home.locator('[data-gh-selection-count]').innerText(),/已选 2 段/,'append switch works without Ctrl');
  await home.locator('[data-gh-action="remove-selection-range"]').first().click();assert.match(await home.locator('[data-gh-selection-count]').innerText(),/已选 1 段/);
  await home.locator('[data-gh-action="clear-selection-ranges"]').click();assert.equal(await home.locator('[data-gh-selection-toolbar]').isVisible(),false);
  await selectWord();await home.locator('[data-gh-action="toggle-append-selection"]').click();
  await selectWord(true,true);assert.match(await home.locator('[data-gh-selection-count]').innerText(),/已选 2 段/);
  assert.equal(await page.evaluate(()=>CSS.highlights.get('gh-temp-selection')?.size),2,'both temporary selections remain highlighted in the source');
  await shot(page,'documents-selection-dark-1600');
  const popupBounds=await page.evaluate(()=>{const popup=document.querySelector('[data-gh-selection-toolbar]').getBoundingClientRect(),dialog=document.querySelector('.gh-document-review').getBoundingClientRect();return {inside:popup.left>=dialog.left&&popup.right<=dialog.right&&popup.top>=dialog.top&&popup.bottom<=dialog.bottom,gap:Math.abs(popup.top-document.querySelector('[data-gh-document-line="2"]').getBoundingClientRect().bottom)};});
  assert.equal(popupBounds.inside,true,'selection actions stay inside the dialog');assert.ok(popupBounds.gap<180,'actions appear by the selected text');
  assert.equal(await home.locator('[data-gh-action="remove-selection-range"]').count(),2);
  failNextRecord=true;await home.locator('[data-gh-action="discard-selection"]').click();
  await page.waitForFunction(()=>document.querySelector('[data-gh-review-notice]')?.textContent?.includes('simulated record write conflict'));
  assert.equal(await home.locator('[data-gh-discarded-range]').count(),0,'failed write does not paint a strike out');
  assert.match(await home.locator('[data-gh-selection-count]').innerText(),/已选 2 段/,'failed write keeps selection');
  await home.locator('[data-gh-action="discard-selection"]').click();
  await page.waitForFunction(()=>document.querySelectorAll('[data-gh-discarded-range]').length===2);
  const discard=records.find(r=>r.scope==='spellcast.document-selection.v1');
  assert.equal(discard.status,'active');assert.equal(discard.result,'discard');assert.equal(discard.references.length,2);
  assert.equal(discard.references[0].version,H('d'));assert.match(discard.references[0].uri,/#L2-L2@\d+-\d+$/);
  assert.notEqual(discard.references[0].uri,discard.references[1].uri,'same-line repeated words have distinct offsets');
  await home.locator('[data-gh-discarded-range]').first().click();await home.locator('[data-gh-action="undo-discard"]').click();
  await page.waitForFunction(()=>document.querySelectorAll('[data-gh-discarded-range]').length===1);
  assert.equal(records.find(r=>r.id===discard.id).references.length,1);
  await home.locator('[data-gh-action="close-source"]').click();
  await home.locator('[data-gh-document]:visible [data-gh-action="read-document"]').click();
  await home.locator('[data-gh-document-text]').waitFor();
  assert.equal(await home.locator('[data-gh-discarded-range]').count(),1,'one strike out persists on reopen');
  await selectWord();await home.locator('[data-gh-action="ask-selection"]').click();await home.locator('[data-gh-question-draft]').fill('跨版本保留的问题文字');
  documents[1].hash=H('f');await home.locator('[data-gh-action="close-source"]').click();await home.locator('[data-gh-document]:visible [data-gh-action="read-document"]').click();
  await home.locator('[data-gh-document-text]').waitFor();
  assert.equal(await home.locator('[data-gh-discarded-range]').count(),0,'old hash does not paint current text');
  assert.match(await home.locator('.gh-review-head').locator('..').innerText(),/旧划掉段落待核对/);
  assert.equal(await home.locator('[data-gh-question-draft]').inputValue(),'跨版本保留的问题文字');
  assert.match(await home.locator('[data-gh-question-selection]').innerText(),/已选 0 段/);
  assert.equal(await home.locator('[data-gh-action="send-document-question"]').isDisabled(),true,'stale offsets require a new selection');
  documents[1].hash=H('d');await home.locator('[data-gh-action="close-source"]').click();await home.locator('[data-gh-document]:visible [data-gh-action="read-document"]').click();
  await selectWord();await home.locator('[data-gh-action="ask-selection"]').click();
  await home.locator('[data-gh-question-draft]').fill('这段是否仍适用于当前游戏？');
  await home.locator('[data-gh-action="send-document-question"]').click();
  await page.waitForFunction(()=>document.querySelector('[data-gh-question-results]')?.textContent?.includes('未发送'));
  const questionGoal=goals.find(g=>g.context.entity_kind==='document_question');
  assert.equal(questionGoal.status,'unsent');assert.equal(questionGoal.context.entity_id,documents[1].path);assert.equal(questionGoal.context.sources[0].hash,H('d'));
  assert.match(questionGoal.text,/这段是否仍适用于当前游戏[\s\S]*#L2-L2@\d+-\d+[\s\S]*文档原文/);
  assert.equal(seq,0,'no receiving task means no send');
  await home.locator('[data-gh-review-draft]').fill('这一句需要核对。');
  failNextRecord=true;
  await home.locator('[data-gh-action="save-review-comment"]').click();
  await page.waitForFunction(()=>document.querySelector('[data-gh-review-notice]')?.textContent?.includes('simulated record write conflict'));
  assert.equal(await home.locator('[data-gh-review-draft]').inputValue(),'这一句需要核对。','failed write keeps the draft');
  await home.locator('[data-gh-action="save-review-comment"]').click();
  await page.waitForFunction(()=>document.querySelectorAll('[data-gh-review-record]').length===3);
  const written=records.find(r=>r.result==='这一句需要核对。');
  assert.equal(written.scope,'spellcast.document-review.v1');assert.equal(written.goal,'');
  assert.equal(written.references[0].uri,'file:///C:/fixture/VESPERIX/Assets/Documents/Content/Regions/YongshengForest/ZoneDesign.md');
  assert.equal(written.references[0].version,H('d'));
  await home.locator('[data-gh-action="close-source"]').click();
  await home.locator('[data-gh-document]:visible [data-gh-action="read-document"]').click();
  await home.locator(`[data-gh-review-record="${written.id}"]`).waitFor();
  assert.equal(await home.locator(`[data-gh-review-record="${written.id}"]`).count(),1,'comment remains after reopening');
  await home.locator('[data-gh-review-record="aaaaaaaa-0000-4000-8000-000000000001"] [data-gh-action="reply-comment"]').click();
  await home.locator('[data-gh-review-draft]').fill('我会在游戏真源核对，再决定文档结论。');
  await home.locator('[data-gh-action="save-review-comment"]').click();
  await page.waitForFunction(()=>document.querySelectorAll('[data-gh-review-record]').length===4);
  const reply=records.find(r=>r.result==='我会在游戏真源核对，再决定文档结论。');
  assert.equal(reply.references[1].uri,`spellcast://project/${project.id}/record/aaaaaaaa-0000-4000-8000-000000000001`);
  assert.equal(records.find(r=>r.id==='aaaaaaaa-0000-4000-8000-000000000001').result,'此处仍需用户核对，不自动认定过时。');
  await home.locator('[data-gh-review-record="aaaaaaaa-0000-4000-8000-000000000001"] [data-gh-action="toggle-comment-resolved"]').click();
  await page.waitForFunction(()=>document.querySelector('[data-gh-review-record="aaaaaaaa-0000-4000-8000-000000000001"]')?.textContent?.includes('已处理'));
  await page.waitForFunction(()=>document.querySelector('[data-gh-review-record="aaaaaaaa-0000-4000-8000-000000000001"]')?.textContent?.includes('AI 预审'));
  assert.equal(records.find(r=>r.id==='aaaaaaaa-0000-4000-8000-000000000001').status,'done');
  await home.locator('[data-gh-action="whole-document-comment"]').click();
  await home.locator('[data-gh-review-draft]').fill('全文需要整体核对。');
  await home.locator('[data-gh-action="save-review-comment"]').click();
  await page.waitForFunction(()=>document.querySelectorAll('[data-gh-review-record]').length===5);
  assert.equal(records.find(r=>r.result==='全文需要整体核对。').references[0].uri.endsWith('#L2-L2'),false);
  await home.locator('[data-gh-review-draft]').fill('跨文档保留的草稿');
  await home.locator('[data-gh-action="next-document"]').click();
  await home.locator('[data-gh-action="previous-document"]').click();
  assert.equal(await home.locator('[data-gh-review-draft]').inputValue(),'跨文档保留的草稿');
  await home.locator('[data-gh-review-record="aaaaaaaa-0000-4000-8000-000000000001"] .gh-review-evidence summary').click();
  await home.locator('[data-gh-review-record="aaaaaaaa-0000-4000-8000-000000000001"] [data-gh-action="read-review-evidence"]').click();
  await page.waitForFunction(()=>document.querySelector('[data-gh-document-text]')?.textContent?.startsWith('# 四层循环'));
  await home.locator('[data-gh-action="next-document"]').click();
  assert.equal(await home.locator('[data-gh-review-draft]').inputValue(),'跨文档保留的草稿','evidence navigation preserves this document draft');
  // An old reader may finish saving after it was closed and a new reader took ownership.
  let releaseWrite, enteredWrite;
  const heldWrite=new Promise(resolve=>{releaseWrite=resolve;});
  const writeStarted=new Promise(resolve=>{enteredWrite=resolve;});
  holdNextRecordWrite=async()=>{enteredWrite();await heldWrite;};
  await home.locator('[data-gh-review-draft]').fill('正在保存的旧批注');
  await home.locator('[data-gh-action="save-review-comment"]').click();await writeStarted;
  await home.locator('[data-gh-action="close-source"]').click();
  await home.locator('[data-gh-document]:visible [data-gh-action="read-document"]').click();
  await home.locator('[data-gh-review-draft]').fill('重开后新写的草稿，旧请求不能清空');
  const refreshedAfterSave=page.waitForResponse(response=>response.url()===`${api}/api/projects/${project.id}/records`&&response.request().method()==='GET');
  releaseWrite();await refreshedAfterSave;
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  await home.locator('[data-gh-action="close-source"]').click();
  await home.locator('[data-gh-document]:visible [data-gh-action="read-document"]').click();
  assert.equal(await home.locator('[data-gh-review-draft]').inputValue(),'重开后新写的草稿，旧请求不能清空','completed old save preserves a newer reader draft');
  await page.setViewportSize({width:880,height:800});await noOverflow(page,'dark reader 880');await shot(page,'documents-reader-dark-880');
  await page.setViewportSize({width:1600,height:1000});await noOverflow(page,'dark reader 1600');await shot(page,'documents-reader-dark-1600');
  await home.locator('[data-gh-action="close-source"]').click();
  await home.locator('[data-gh-document-search]').fill('');
  await home.locator('[data-gh-document-filter]').selectOption('discarded');
  assert.equal(await home.locator('[data-gh-document]:visible').count(),1);
  assert.match(await home.locator('[data-gh-section="documents"]').innerText(),/划掉 1 段/);
  await shot(page,'documents-dark-1600');
  await home.locator('[data-gh-action="back-overview"]').click();
  await home.locator('[data-gh-section="loop"]').waitFor();
  goals=goals.filter(goal=>goal.context.entity_kind!=='document_question');goalPosts=[];
  await page.locator('[data-project-action="refresh"]').click();await home.locator('[data-gh-section="loop"]').waitFor();
  ok('document review: exact multi-selection, revisioned strike out, undo, stale hash, unsent question, preserved comments and drafts');

  // 2. Honest connection: no task → start instructions and prior tasks; nothing pretends to run.
  const connectionBox=home.locator('[data-gh-connection]');
  assert.match(await home.locator('.gh-connect-hint').innerText(),/没有连接的 Codex 任务/);
  await home.locator('[data-gh-action="how-to-connect"]').click();await home.locator('[data-gh-instructions]').waitFor();
  assert.equal(await connectionBox.getAttribute('data-gh-connection'),'none');
  assert.match(await connectionBox.innerText(),/没有连接的 Codex 任务[\s\S]*Claude Code、Grok、Cursor/);
  assert.match(await home.locator('[data-gh-instructions]').innerText(),/6e97a7c6-3fee-4348-a67e-9d6aefb6e185[\s\S]*spellcast_bind_codex[\s\S]*spellcast_project_access[\s\S]*put_proposal/);
  const sendButton=home.locator('[data-gh-send]');
  await home.locator('[data-gh-goal]').fill('整理外围林地第一次进入：地点、遭遇、奖励与任务，附来源。');
  assert.equal(await sendButton.isDisabled(),true,'no send without a receiving task');
  // A transient failure keeps the words; the retry replays the same goal id instead of creating a second goal.
  failNextGoal=true;
  await home.locator('[data-gh-action="save-unsent"]').click();
  await page.waitForFunction(()=>/暂时失败/.test(document.querySelector('.gh-status')?.textContent||''));
  assert.equal(goals.length,0,'a failed save creates nothing');
  assert.equal(await home.locator('[data-gh-goal]').inputValue(),'整理外围林地第一次进入：地点、遭遇、奖励与任务，附来源。','the words survive a failed save');
  await home.locator('[data-gh-action="save-unsent"]').click();
  await page.waitForFunction(()=>document.querySelector('[data-gh-side="goals"] [data-gh-goal-status]')?.textContent?.includes('未发送'));
  assert.match(await page.locator('.gh-status').innerText(),/已保存，未发送/);
  assert.equal(goals.length,1);assert.equal(goals[0].status,'unsent');assert.equal(goals[0].context.scale,'overview');
  assert.equal(goalPosts.length,2);assert.equal(goalPosts[0],goalPosts[1],'the retry reuses the same goal id');
  ok('without a bound task the goal is saved as unsent, never shown as processing; a failed save retries with the same id');

  // 3. Link a task that worked on this project before (verified by the bridge), then send.
  const candidate=id=>home.locator('[data-gh-connection] li').filter({hasText:id.slice(0,8)}).locator('[data-gh-action="link-task"]');
  await candidate('01a0ba9c-38d3-7190-ac76-076496862423').click();
  await page.waitForFunction(()=>/Codex 没有返回指定任务/.test(document.querySelector('.gh-status')?.textContent||''));
  assert.equal(await connectionBox.getAttribute('data-gh-connection'),'none','an unverifiable old task is refused honestly and nothing is bound');
  await candidate(thread).click();
  await page.waitForFunction(()=>document.querySelector('[data-gh-connection]')?.dataset.ghConnection==='ready');
  assert.deepEqual(bindCalls.map(call=>call.thread_id),['01a0ba9c-38d3-7190-ac76-076496862423',thread]);
  assert.equal(bindCalls[1].source_id,source);
  await page.keyboard.press('Escape');assert.equal(await home.locator('[data-gh-instructions], .gh-connection-panel').first().isVisible(),false,'Escape closes the connection popover first');
  assert.equal(await page.locator('dialog.project-workspace').evaluate(d=>d.open),true,'and does not close the workspace');
  await page.waitForFunction(()=>document.querySelector('[data-gh-side="goals"] [data-gh-action="send-saved"]'));
  await home.locator('[data-gh-side="goals"] [data-gh-action="send-saved"]').click();
  await page.waitForFunction(()=>/排队交给|已交给 Codex|任务已读取/.test(document.querySelector('[data-gh-side="goals"] [data-gh-goal-status]')?.textContent||''));
  assert.equal(goals[0].status,'sent');
  ok('explicit bound target; the saved goal is sent once and shows the real receipt phase');

  // A background poll while a goal is in flight must not replace what the user is typing.
  await home.locator('[data-gh-goal]').click();await page.keyboard.type('草稿不应被轮询覆盖');
  const polled=await page.waitForResponse(response=>new URL(response.url()).pathname.endsWith('/goals')&&response.request().method()==='GET',{timeout:15000});
  await polled.finished();await page.waitForTimeout(300);
  assert.equal(await home.locator('[data-gh-goal]').inputValue(),'草稿不应被轮询覆盖');
  assert.equal(await page.evaluate(()=>document.activeElement?.dataset?.ghGoal),'true','focus stays in the composer during a poll');
  await home.locator('[data-gh-goal]').fill('');
  ok('background polling keeps the composer text and focus');

  // 4. The scripted agent reads, asks for access; the user approves inline; a proposal answers.
  await page.waitForFunction(()=>document.querySelector('[data-gh-side="goals"]')?.textContent?.includes('申请为本项目提交提案'),null,{timeout:20000});
  await home.locator('[data-gh-side="goals"] [data-gh-action="approve-access"]').click();
  await page.waitForFunction(()=>document.querySelector('[data-gh-side="goals"] [data-gh-goal-status]')?.textContent?.includes('任务已提交提案'),null,{timeout:20000});
  assert.equal(accesses[0].state,'approved');
  ok('access approval happens in the workspace; the goal shows responded only after a proposal exists');

  // 5. Three scales from the same sources.
  await home.locator('[data-gh-section="explorable"] [data-gh-zone="zone_forest_shrine_outer"]').click();
  await home.locator('[data-gh-location="subloc_ancient_tree_root"]').waitFor();
  assert.equal(viewRequests.length,1,'entering a zone reads one zone snapshot');
  assert.match(await home.locator('[data-gh-section="chain"]').innerText(),/古树根部[\s\S]*战斗[\s\S]*豪彘掉落/);
  assert.match(await home.locator('[data-gh-section="missions"]').innerText(),/初入迷林[\s\S]*目标敌人 pet_haozhi/);
  assert.match(await home.locator('[data-gh-section="design"]').innerText(),/SubLocationDesign\.md|ZoneDesign\.md/);
  assert.match(await home.locator('.gh-crumbs').innerText(),/全貌[\s\S]*体验 · 外围林地/);
  await shot(page,'experience-dark-1600');
  await home.locator('[data-gh-location="subloc_ancient_tree_root"]').click();
  await home.locator('[data-gh-section="object-config"]').waitFor();
  assert.match(await home.locator('[data-gh-section="object-design"]').innerText(),/路线与首次内容/);
  assert.match(await home.locator('[data-gh-section="object-config"]').innerText(),/异化之鹿[\s\S]*pet_haozhi[\s\S]*豪彘掉落[\s\S]*草药点/);
  assert.match(await home.locator('[data-gh-section="object-code"]').innerText(),/SubLocationRoutes[\s\S]*DungeonZoneConfig\.cs/);
  assert.match(await home.locator('[data-gh-section="object-verification"]').innerText(),/状态未知[\s\S]*探索闭环/);
  assert.match(await home.locator('[data-gh-toggle-context], [data-gh-action="toggle-context"]').first().innerText(),/外围林地 \/ 古树根部/);
  await shot(page,'object-dark-1600');
  await home.locator('[data-gh-source]').first().click();await page.waitForSelector('dialog.gh-source-view[open] [data-gh-source-json]');
  await page.locator('dialog.gh-source-view [data-gh-action="close-source"]').click();
  // Records belong to the object they reference; untrusted repository text renders literally.
  await home.locator('[data-gh-action="scale-experience"]').click();
  await home.locator('[data-gh-location="subloc_misty_path"]').click();
  await home.locator('[data-gh-section="object-config"]').waitFor();
  assert.match(await home.locator('.gh-intro').first().innerText(),/雾中小径<img src=x onerror="window\.injected=1">/);
  assert.match(await home.locator('[data-gh-section="object-design"]').innerText(),/<script>window\.injected=2<\/script>/);
  assert.match(await home.locator('[data-gh-section="object-config"]').innerText(),/迷雾中迷失<svg onload="window\.injected=5">/);
  const mistyRecords=await home.locator('[data-gh-section="object-verification"]').innerText();
  assert.match(mistyRecords,/这个对象还没有关联事项/);assert.doesNotMatch(mistyRecords,/探索闭环/,'a record about another location is not shown here');
  assert.equal(viewRequests.length,1,'moving between objects of one zone reuses its snapshot');
  assert.equal(await page.evaluate(()=>window.injected),undefined,'repository text never executes');
  await page.locator('.gh-crumbs').click({position:{x:1,y:1}});
  await page.keyboard.press('Escape');await home.locator('[data-gh-section="chain"]').waitFor();
  assert.equal(await home.locator('[data-gh-location="subloc_misty_path"]').getAttribute('aria-pressed'),'true','the route keeps the object you came from selected');
  await page.keyboard.press('Escape');await home.locator('[data-gh-section="loop"]').waitFor();
  ok('overview → experience → object from one projection; sources viewable; records scoped to their object; literal repository text; Escape walks back up');

  // Sources: focus and Refresh stay incremental; only an explicit re-read asks for refresh=true.
  const reads=()=>[overviewRequests.length,viewRequests.length];
  const idle=reads();await page.evaluate(()=>window.dispatchEvent(new Event('focus')));await page.waitForTimeout(600);
  assert.deepEqual(reads(),idle,'window focus refreshes work state only, not the repository snapshot');
  const incremental=page.waitForResponse(response=>new URL(response.url()).pathname.endsWith('/game/overview'));
  await page.locator('[data-project-action="refresh"]').click();await incremental;
  assert.equal(overviewRequests.at(-1),'','Refresh uses the incremental index');
  const explicit=page.waitForResponse(response=>new URL(response.url()).pathname.endsWith('/game/overview'));
  await page.locator('[data-project-tools] > summary').click();await page.locator('[data-project-action="reload-sources"]').click();await explicit;
  assert.equal(new URLSearchParams(overviewRequests.at(-1)).get('refresh'),'true','re-reading sources rereads file contents');
  await home.locator('[data-gh-section="loop"]').waitFor();
  // A zone that cannot be projected says why and keeps the way back.
  await home.locator('[data-gh-section="explorable"] [data-gh-zone="zone_forest_shrine_inner"]').click();
  await home.locator('.gh-alert[role="alert"]').waitFor();
  assert.match(await home.locator('.gh-alert[role="alert"]').innerText(),/这个 Zone 没有声明路线/);
  await home.locator('[data-gh-action="back-overview"]').click();await home.locator('[data-gh-section="loop"]').waitFor();
  await home.locator('[data-gh-section="explorable"] [data-gh-zone="zone_forest_shrine_outer"]').click();await home.locator('[data-gh-section="chain"]').waitFor();
  for (let attempt = 0; attempt < 4; attempt++) {
    await page.keyboard.press('Escape');await home.locator('[data-gh-section="loop"]').waitFor();
    assert.equal(await page.locator('dialog.project-workspace').evaluate(dialog=>dialog.open),true,'repeated Escape must not close the workspace');
    if (attempt < 3) { await home.locator('[data-gh-section="explorable"] [data-gh-zone="zone_forest_shrine_outer"]').click();await home.locator('[data-gh-section="chain"]').waitFor(); }
  }
  ok('focus and Refresh stay incremental, re-reading sources is explicit, and a zone error keeps navigation');

  // 6. Proposal review: basis, reasons, boundaries; locked, stale, adopt, edit, return, dismiss.
  await home.locator('[data-gh-side="proposals"] [data-proposal-card="outer-first-visit"] [data-proposal-action="open"]').click();
  const review=home.locator('[data-proposal-review="outer-first-visit"]');await review.waitFor();
  assert.match(await review.locator('.gh-proposal-head').innerText(),/AI 推断/,'an Agent proposal is labelled AI inference');
  assert.match(await review.innerText(),/配置[\s\S]*设计[\s\S]*理由[\s\S]*未验证/);
  const elite=review.locator('[data-proposal-item="elite"]'),stale=review.locator('[data-proposal-item="stale"]');
  assert.match(await elite.innerText(),/已锁定/);assert.equal(await elite.locator('[data-proposal-action="unlock-adopt"]').count(),1);
  assert.match(await stale.innerText(),/提案基于 v1，对象现在是 v3/);assert.equal(await stale.locator('[data-proposal-action="adopt"]').isDisabled(),true);
  assert.match(await elite.locator('.gh-compare').innerText(),/当前 v2[\s\S]*0\.08[\s\S]*提案[\s\S]*0\.1/);
  assert.match(await stale.innerText(),/<img src=x onerror="window\.injected=3">/,'proposal text renders literally');
  await shot(page,'review-dark-1600');
  // A decision against a proposal revision that changed meanwhile is refused and shown; after a refresh it goes through.
  proposals.find(p=>p.id==='outer-first-visit').revision++;
  await review.locator('[data-proposal-item="route"] [data-proposal-action="adopt"]').click();
  await review.locator('.gh-alert[role="alert"]:not([hidden])').waitFor();
  assert.match(await review.locator('.gh-alert[role="alert"]').innerText(),/revision 已变化/);
  assert.equal(await review.locator('[data-proposal-item="route"]').getAttribute('data-status'),'pending');
  assert.equal(objects.some(o=>o.id==='outer-first-visit-content'),false,'a refused decision writes nothing');
  await page.locator('[data-project-action="refresh"]').click();
  await page.waitForFunction(()=>/rev 2(\D|$)/.test(document.querySelector('[data-proposal-review="outer-first-visit"]')?.innerText||''));
  await review.locator('[data-proposal-item="route"] [data-proposal-action="edit"]').click();
  const edited=review.locator('[data-proposal-editor="route"] textarea').first();await edited.fill('从古树根部的首次战斗开始（用户改写）。');
  await review.locator('[data-proposal-editor="route"] [data-proposal-action="edit-adopt"]').click();
  await page.waitForFunction(()=>document.querySelector('[data-proposal-item="route"]')?.dataset.status==='adopted');
  let last=decisions.at(-1);assert.equal(last.decision,'adopt');assert.equal(last.confirm,true);assert.equal(last.revised_object.planning.sections[0].text,'从古树根部的首次战斗开始（用户改写）。');
  assert.equal(objects.find(o=>o.id==='outer-first-visit-content').planning.confirmed,true);
  await review.locator('[data-proposal-item="elite"] [data-proposal-action="unlock-adopt"]').click();
  await page.waitForFunction(()=>document.querySelector('[data-proposal-item="elite"]')?.dataset.status==='adopted');
  last=decisions.at(-1);assert.equal(last.unlock,true);assert.equal(objects.find(o=>o.id==='elite-chance').planning.parameter.value,'0.1');
  await review.locator('[data-proposal-item="stale"] [data-proposal-action="return"]').click();
  await review.locator('[data-proposal-note="return"] [data-proposal-action="return-send"]').click();
  assert.equal(decisions.at(-1).decision,'adopt','an empty return note is not submitted');
  await review.locator('[data-proposal-note-text="return"]').fill('基于当前 v3 重新提出奖励节奏。');
  await review.locator('[data-proposal-note="return"] [data-proposal-action="return-send"]').click();
  await page.waitForFunction(()=>document.querySelector('[data-proposal-item="stale"]')?.dataset.status==='returned');
  assert.equal(returns.length,1);assert.deepEqual(returns[0].item_ids,['stale']);
  assert.match(await page.locator('.gh-status').innerText(),/已退回，并交给「VESPERIX 主线」/);
  await review.locator('[data-proposal-item="verify"] [data-proposal-action="dismiss"]').click();
  await review.locator('[data-proposal-note="dismiss"] [data-proposal-action="dismiss-confirm"]').click();
  await page.waitForFunction(()=>document.querySelector('[data-proposal-item="verify"]')?.dataset.status==='dismissed');
  assert.equal(records.some(r=>r.id==='verify-outer-route'),false,'a dismissed record proposal never creates a record');
  ok('review refuses a stale proposal revision until refreshed, adopts with edits and explicit unlock, blocks stale bases before sending, returns with a note to the bound author, dismisses without writes');

  // 7. Continue: track as work only when asked; the answering proposal is reviewable from the goal.
  await page.locator('[data-gh-action="close-review"]').click();
  await home.locator('[data-gh-side="goals"] [data-gh-action="open-goal-proposal"]').first().click();
  await home.locator('[data-proposal-review^="answer-"]').waitFor();
  await home.locator('[data-proposal-review^="answer-"] [data-proposal-action="adopt"]').click();
  await page.waitForFunction(()=>document.querySelector('[data-proposal-review^="answer-"] [data-proposal-item="rest"]')?.dataset.status==='adopted');
  await page.locator('[data-gh-action="close-review"]').click();
  const before=records.length;await home.locator('[data-gh-side="goals"] [data-gh-action="promote"]').first().click();
  await page.waitForFunction(()=>document.querySelector('.project-workspace')?.dataset.workspaceView==='records');
  assert.equal(records.length,before+1);
  ok('goal → proposal → adoption → tracked work, in the same workspace');

  // 8. Tools menu: manual planning and records remain available, and the planning tools are a menu.
  const tools=page.locator('[data-project-tools] > summary');
  await tools.click();await page.locator('[data-project-view="planning"]').click();
  await page.locator('.project-planning [data-plan-tools]').waitFor();
  assert.equal(await page.locator('[data-plan-action="flows"]').isVisible(),false);
  await page.locator('[data-plan-tools-toggle]').click();assert.equal(await page.locator('[data-plan-action="flows"]').isVisible(),true);
  await page.keyboard.press('Escape');assert.equal(await page.locator('[data-plan-action="flows"]').isVisible(),false,'Escape closes the planning tools menu');
  await tools.click();await page.keyboard.press('Escape');assert.equal(await page.locator('[data-project-view="game"]').isVisible(),false,'Escape closes the workspace tools menu');
  await tools.click();await page.locator('[data-project-view="game"]').click();await home.locator('[data-gh-section="loop"]').waitFor();
  ok('tools menu reaches manual planning and records; both menus close with Escape');

  // 9. Keyboard: the composer sends with Ctrl+Enter to the chosen task.
  await home.locator('[data-gh-goal]').focus();await page.keyboard.type('核对 16 个区域的主线任务配置缺失。<img src=x onerror="window.injected=4">');
  await page.keyboard.press('Control+Enter');
  await page.waitForFunction(()=>document.querySelectorAll('[data-gh-side="goals"] [data-gh-goal-id]').length>=2);
  assert.equal(goals[0].status,'sent');
  assert.match(await home.locator('[data-gh-side="goals"] [data-gh-goal-id]').first().innerText(),/<img src=x onerror="window\.injected=4">/);
  assert.equal(await page.evaluate(()=>window.injected),undefined,'repository, proposal and goal text never executes');
  ok('keyboard send (Ctrl+Enter) reaches the explicit target; typed markup stays text');

  await home.locator('[data-gh-action="open-documents"]').click();
  await home.locator('[data-gh-document-filter]').selectOption('discarded');
  await home.locator('[data-gh-document]:visible [data-gh-action="read-document"]').click();
  await selectWord();await home.locator('[data-gh-action="ask-selection"]').click();
  await home.locator('[data-gh-question-draft]').fill('Agent 请核对这一段。');
  await home.locator('[data-gh-question-target]').selectOption(source);
  const beforeQuestionSeq=seq;
  await home.locator('[data-gh-action="send-document-question"]').click();
  await page.waitForFunction(()=>document.querySelector('[data-gh-question-results]')?.textContent?.includes('排队交给')||document.querySelector('[data-gh-question-results]')?.textContent?.includes('已交给 Codex'));
  const sentQuestion=goals.find(g=>g.context.entity_kind==='document_question');
  assert.equal(sentQuestion.status,'sent');assert.equal(sentQuestion.target.thread_id,thread);assert.equal(seq,beforeQuestionSeq+1,'one explicit send');
  const answerId='document-answer-1';
  records.push(record(answerId,'所选段答复','active',{scope:'spellcast.document-review.v1',goal:'已核对选段',result:'这段属于旧版资料，暂不进入当前游戏设计。',references:[
    {label:'神祠设计',uri:`file:///C:/fixture/VESPERIX/${documents[1].path}#L2-L2@${sentQuestion.text.match(/@([0-9]+)-/)[1]}-${sentQuestion.text.match(/@\d+-([0-9]+)/)[1]}`,version:H('d')},
    {label:'问题',uri:`spellcast://project/${project.id}/goal/${sentQuestion.id}`,version:''}],updated_by:agent}));
  sentQuestion.response_record_ids=[answerId];sentQuestion.delivery={phase:'responded'};
  await home.locator('[data-gh-action="close-source"]').click();await home.locator('[data-gh-document]:visible [data-gh-action="read-document"]').click();
  await page.waitForFunction(()=>document.querySelector('[data-gh-document-answer]')?.textContent?.includes('旧版资料'));
  assert.match(await home.locator('[data-gh-question-results]').innerText(),/任务已回答/);
  await home.locator('[data-gh-discarded-range]').first().click();await home.locator('[data-gh-action="undo-discard"]').click();
  await page.waitForFunction(()=>!document.querySelector('[data-gh-discarded-range]'));
  const cancelled=records.find(r=>r.id===discard.id);assert.equal(cancelled.status,'cancelled');assert.equal(cancelled.references.length,1);assert.equal(cancelled.references[0].uri.includes('#'),false);
  assert.equal(cancelled.references[0].version,H('d'),'cancelled record preserves the source hash');
  await home.locator('[data-gh-action="close-source"]').click();await home.locator('[data-gh-action="back-overview"]').click();
  ok('bound document question sends once to the selected task and shows its goal-linked answer record; complete undo retains cancelled history');

  // 10. Themes and widths.
  for(const [width,height] of [[1600,1000],[1320,900],[880,800]]){await page.setViewportSize({width,height});await noOverflow(page,`dark ${width}`);await shot(page,`overview-dark-${width}`);}
  await context.close();
  const light=await openPage('light',1320,900);
  assert.equal(await light.page.evaluate(()=>document.body.dataset.theme),'light');
  await light.page.locator('[data-gh-action="open-documents"]').click();
  await light.page.locator('[data-gh-document-filter]').selectOption('comments');
  await light.page.locator('[data-gh-document]:visible [data-gh-action="read-document"]').click();
  await light.page.setViewportSize({width:880,height:800});await noOverflow(light.page,'light reader 880');await shot(light.page,'documents-reader-light-880');
  await light.page.setViewportSize({width:1600,height:1000});await noOverflow(light.page,'light reader 1600');await shot(light.page,'documents-reader-light-1600');
  await light.page.locator('[data-gh-action="close-source"]').click();
  await light.page.locator('[data-gh-action="back-overview"]').click();
  for(const [width,height] of [[1600,1000],[1320,900],[880,800]]){await light.page.setViewportSize({width,height});await noOverflow(light.page,`light ${width}`);await shot(light.page,`overview-light-${width}`);}
  await light.page.locator('[data-game-home] [data-gh-section="explorable"] [data-gh-zone="zone_forest_shrine_outer"]').click();
  await light.page.locator('[data-gh-location="subloc_beast_den"]').click();await light.page.locator('[data-gh-section="object-config"]').waitFor();
  await shot(light.page,'object-light-880');
  const contrast=await light.page.evaluate(()=>{const s=getComputedStyle(document.querySelector('.project-workspace'));return {bg:s.backgroundColor,fg:s.color};});
  assert.notEqual(contrast.bg,contrast.fg);
  await light.context.close();
  ok('dark and light at 1600/1320/880 without horizontal overflow');

  // The overview table opens one versioned, read-only Canvas object; reopening locates it.
  const canvas=await openPage('light',1320,900);
  await canvas.page.locator('[data-gh-action="open-loop-canvas"]').click();
  await canvas.page.locator('.canvas-source-table tbody tr').first().waitFor();
  assert.equal(board.canvas.objects.length,1);
  assert.equal(board.canvas.objects[0].content.type,'source_table');
  assert.equal(await canvas.page.locator('.canvas-source-table tbody tr').count(),4);
  assert.match(await canvas.page.locator('.canvas-source-table').innerText(),/cycle\.md[\s\S]*sha 11111111/);
  const savedId=board.canvas.objects[0].id,savedPlacement=structuredClone(board.canvas.items[0]);
  await canvas.page.locator('#projects-open').click();
  await canvas.page.locator('[data-gh-action="open-loop-canvas"]').click();
  await canvas.page.locator(`.canvas-frame[data-item-id="${savedId}"]`).waitFor();
  assert.equal(board.canvas.objects.length,1,'reopen locates rather than duplicates');
  board.canvas.annotations=[{id:'source-note',revision:1,anchor:{object_id:savedId,content_revision:1},snapshot:structuredClone(board.canvas.objects[0].content),text:'旧版批注',removed:false}];
  loop.source.hash=H('9');
  canvas.page.once('dialog',dialog=>dialog.accept());
  await canvas.page.locator('#projects-open').click();
  await canvas.page.locator('[data-project-action="reload-sources"]').evaluate(button=>button.click());
  await canvas.page.waitForFunction(()=>document.querySelector('[data-gh-section="loop"] .gh-source')?.textContent?.includes('99999999'));
  await canvas.page.locator('[data-gh-action="open-loop-canvas"]').click();
  await canvas.page.waitForFunction(()=>document.querySelector('.canvas-source-table')?.textContent?.includes('sha 99999999'));
  assert.equal(board.canvas.objects.length,1);assert.equal(board.canvas.objects[0].content_revision,2);
  assert.deepEqual(board.canvas.items[0],savedPlacement,'source refresh preserves the Canvas placement');
  assert.equal(board.canvas.annotations[0].anchor.content_revision,1,'old annotation stays tied to its original snapshot');
  await canvas.context.close();
  ok('player loop opens as one sourced Canvas table; a new source version refreshes without moving it or rewriting old annotations');

  // Unknown routes (including the retired /game/zones listing and /game/actions requests) count as unexpected.
  assert.deepEqual(pageErrors,[]);assert.deepEqual(unexpected,[]);
  assert.equal(forbidden,0,'every repository, goal, proposal and decision request carried the private window credential');
  report.passed=true;report.reads={overview:overviewRequests,view:viewRequests,goalPosts};report.decisions=decisions.map(d=>({decision:d.decision,items:d.item_ids,confirm:d.confirm,unlock:d.unlock,revised:!!d.revised_object}));
  await writeFile(path.join(out,'browser-fixture-report.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify({passed:true,checks:report.checks.length,screenshots:report.screenshots.length,report:'artifacts/game-ai-workspace/browser-fixture-report.json'}));
}catch(error){report.passed=false;report.error=String(error?.stack||error);report.pageErrors=pageErrors;report.unexpected=unexpected;await writeFile(path.join(out,'browser-fixture-report.json'),JSON.stringify(report,null,2)).catch(()=>{});console.error(JSON.stringify({pageErrors,unexpected,vite:viteOutput.slice(-1500)}));throw error;}
finally{await browser?.close();vite.kill();}

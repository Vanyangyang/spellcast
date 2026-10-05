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
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
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

// A small authored shape exercises the map without copying private game material into this fixture.
const skeletonSystems=['世界与地图','探索','战斗','角色成长','任务','经济','装备','社交','叙事','结算'].map((title,index)=>({
  id:`system_${index+1}`,kind:'system',title,summary:`${title}的规则入口`,state:'rules_preserved',sources:['Assets/Documents/GameDesign/Mechanics/README.md']}));
const syntheticSkeleton={schema_version:1,title:'游戏结构',description:'可选择的设计骨架',entry_ids:skeletonSystems.map(node=>node.id),
  loop:['进入','探索','遭遇','成长','推进','结算'].map((title,index)=>({id:`stage_${index+1}`,title,summary:`${title}阶段`,node_ids:[skeletonSystems[index].id]})),
  nodes:[...skeletonSystems,
    {id:'region_fixture',kind:'region',title:'示例区域',summary:'区域结构',parent_id:'system_1',state:'world_basis',sources:['Assets/Documents/GameDesign/Worldbuilding/README.md']},
    {id:'shape_fixture',kind:'structure',title:'示例关卡形状',summary:'关卡路径待填',parent_id:'region_fixture',state:'structure_only',sources:['Assets/Documents/GameDesign/ContentStructure.md']},
    {id:'condition_fixture',kind:'rule',title:'深入条件',summary:'进入下一层的条件',parent_id:'shape_fixture',state:'needs_reconciliation',steps:[{title:'判定',text:'满足条件后开放路线'}],sources:['Assets/Documents/GameDesign/Mechanics/README.md'],
      rule:{trigger:['到达入口'],conditions:['路线开放'],effects:['允许继续探索'],exceptions:['失败时不扣资源'],formulas:['stageScore = base + progress'],conflicts:['成功与领奖是两个时点，旧稿的描述有分歧。']},
      provenance:[{path:'Assets/Documents/Content/RetiredExample.md',hash:H('8'),start_line:7,end_line:8,quote:'历史证据 <img src=x onerror="window.injected=10">',archived:true}]},
    ...Array.from({length:30},(_,index)=>({id:`reference_fixture_${index}`,kind:'reference',title:`制作约束 ${index+1}`,summary:'辅助制作规则',parent_id:'system_10',state:'supporting_reference',sources:[]}))],
  relations:[{from:'region_fixture',to:'shape_fixture',label:'包含'},{from:'shape_fixture',to:'condition_fixture',label:'约束'}]};
const skeletonPath='Assets/Documents/GameDesign/Skeleton.json';
const skeletonSource={path:skeletonPath,hash:H('a')};
const addModelSources=model=>{for(const path of new Set(model.nodes.flatMap(node=>node.sources||[])))if(!documents.some(item=>item.path===path))documents.push({path,hash:createHash('sha256').update(path).digest('hex'),title:path.split('/').at(-1),lines:3,headings:1,identifiers:0});};

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
let overviewRequests=[],viewRequests=[],goalPosts=[],sayPosts=[],annotationOps=[],forbidden=0,failNextGoal=false,failNextRecord=false;
// Faults and request counters for the Canvas game tools: every delivery and write remains mocked.
let gameReadFault='',holdGameOverview,apiPosts=[],gameConnectionReads=0;

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
  if(method==='POST')apiPosts.push({path:p,body:structuredClone(body)});
  const owner=p.includes('/game/')||p.includes('/goals')||p.includes('/proposals')||p.endsWith('/command');
  if(owner&&key!=='fixture-key'){forbidden++;return send(route,{error:'missing private window credential'},403);}
  if(p==='/api/board')return send(route,board);
  if(p==='/api/canvas/batch'&&method==='POST'){
    for(const operation of body.operations){
      if(operation.op==='create'){
        assert.equal(board.canvas.objects.some(item=>item.id===operation.id),false,'source-backed Canvas create keeps one identity');
        board.canvas.objects.push({id:operation.id,content:operation.content,content_revision:1,origin:operation.origin||null,bindings:[],source_id:null,user_edited:false});
        board.canvas.items.push({item_id:operation.id,revision:1,z:0,removed:false,appearance:operation.placement.appearance||'card',x:operation.placement.x,y:operation.placement.y,width:operation.placement.width,height:operation.placement.height});
      }else if(operation.op==='patch_content'){
        const item=board.canvas.objects.find(item=>item.id===operation.id);
        assert.equal(item.content_revision,operation.expected_revision);
        assert(['source_table','source_skeleton'].includes(item.content.type),'only source-backed Canvas content is patched');
        if(item.content.type==='source_table')item.content={type:'source_table',table:operation.fields.source_table};
        else item.content={type:'source_skeleton',skeleton:operation.fields.source_skeleton};
        item.content_revision++;
      }else if(operation.op==='annotate'){
        const object=board.canvas.objects.find(item=>item.id===operation.anchor.object_id);
        assert(object,'annotation target exists');
        assert.equal(operation.anchor.content_revision,object.content_revision,'annotation cites the current content revision');
        annotationOps.push(structuredClone(operation));
        board.canvas.annotations??=[];
        board.canvas.annotations.push({id:operation.id,revision:1,anchor:operation.anchor,snapshot:structuredClone(object.content),text:operation.text,status:'pending',removed:false});
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
  if(p==='/api/task-target'&&method==='POST')return send(route,{...body,label:'VESPERIX 主线',status:'available',message:'',checked_at_ms:now});
  if(p==='/api/say'&&method==='POST'){sayPosts.push(body);return send(route,{seq:sayPosts.length,id:`say-${sayPosts.length}`,text:body.text,source_id:body.source_id,anchors:body.anchors||[],created_at_ms:now});}
  if(p==='/api/bindings/codex'&&method==='POST'){bindCalls.push(body);if(body.thread_id!==thread)return send(route,{error:'Codex 没有返回指定任务。'},400);const binding={source_id:body.source_id,thread_id:body.thread_id,cwd:body.cwd||'C:/fixture/VESPERIX',label:'VESPERIX 主线',protocol_agent:'fixture',bound_at_ms:now};bindings=[binding];return send(route,binding);}
  if(p==='/api/projects')return send(route,[project]);
  if(p==='/api/projects/bbbbbbbb-0000-4000-8000-000000000001/records/game-tools-record')return send(route,record('game-tools-record','其他项目的工作记录','planned',{project_id:'bbbbbbbb-0000-4000-8000-000000000001'}));
  const base=`/api/projects/${project.id}`;
  if(p===`${base}/game/connection`){gameConnectionReads++;return send(route,{connection});}
  if(p===`${base}/game/overview`){overviewRequests.push(url.search);if(holdGameOverview){const hold=holdGameOverview;holdGameOverview=undefined;await hold();}if(gameReadFault==='overview')return send(route,{error:'模拟游戏来源读取失败'},500);return send(route,overview);}
  if(p===`${base}/game/document`){if(gameReadFault==='document')return send(route,{error:'模拟来源文档读取失败'},500);const file=documents.find(item=>item.path===url.searchParams.get('path'));return file?send(route,{...file,text:`# ${file.title}\n文档原文，仅供审查。文档原文同词。\n<script>window.injected=10</script>` }):send(route,{error:'文档不在已连接仓库的索引中。'},400);}
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
async function openPage(theme,width,height,entry='workspace'){
  const context=await browser.newContext({viewport:{width,height}});
  await context.addInitScript(([t,h,a])=>{localStorage.setItem('spellcast.locale','zh-CN');localStorage.setItem('spellcast.theme',t);
    window.__TAURI_INTERNALS__={invoke:async(command,args)=>command==='project_window_key'?'fixture-key':command==='bridge_status'||command==='set_surface'?h:command==='get_board'?fetch(`${a}/api/board`).then(response=>response.json()):command==='list_forms'?{forms:[{id:'spatial',label:'Spatial',blurb:''}]}:command==='say'?fetch(`${a}/api/say`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(args.req)}).then(response=>response.json()):undefined,transformCallback:()=>1,unregisterCallback:()=>{}};},[theme,health,api]);
  await context.route('**/*',routes);
  const page=await context.newPage();page.on('pageerror',error=>pageErrors.push(error.message));
  if(entry==='workspace'&&overview.skeleton)page.on('dialog',dialog=>dialog.accept());
  // 400/404/500 are the fixture's intentional refusals and its one simulated transient failure.
  page.on('console',m=>{if(m.type()==='error'&&!/status of (400|404|500)/.test(m.text()))console.error('[console]',m.text());});
  await page.goto(origin,{waitUntil:'commit'});
  await page.waitForFunction(()=>document.querySelector('#projects-open')?.textContent?.includes('游戏开发'));
  await page.locator('#projects-open').evaluate(e=>e.click());
  if(overview.skeleton){
    await page.locator('.canvas-source-skeleton').waitFor();
    if(entry==='canvas')return {page,context};
    await skeletonAction(page.locator('.canvas-source-skeleton'),'manage');
    await page.locator('dialog.project-workspace[open][aria-busy="false"]').waitFor();
  }
  await page.waitForSelector('[data-game-home] [data-gh-section="loop"], [data-game-home] [data-game-skeleton="map"]');
  return {page,context};
}
async function skeletonAction(reader,action){
  await reader.locator('summary[data-skeleton-tools-toggle]').click();
  await reader.locator(`button[data-skeleton-action="${action}"]`).click();
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

  // A current design overview switches the entry while the legacy fixture above covers fallback.
  documents.splice(0, documents.length,
    {...src('Assets/Documents/GameDesign/Overview.md','a'),title:'全景骨架',lines:20},
    {...src('Assets/Documents/GameDesign/ContentStructure.md','b'),title:'关卡与任务结构',lines:12},
    {...src('Assets/Documents/GameDesign/Mechanics/README.md','c'),title:'机制规则索引',lines:15},
    ...Array.from({length:15},(_,index)=>({...src(`Assets/Documents/GameDesign/Mechanics/Rule${String(index+1).padStart(2,'0')}.md`,'c'),title:`domain:mechanic_${index+1}`,lines:15})),
    {...src('Assets/Documents/GameDesign/Worldbuilding/README.md','d'),title:'世界观基底',lines:10},
    {...src('Assets/Documents/GameDesign/Worldbuilding/World.md','d'),title:'世界设定',lines:10},
    {...src('Assets/Documents/GameDesign/ConfigReference/Config.md','f'),title:'配置映射',lines:8},
    {...src('Assets/Documents/Development/Build.md','e'),title:'制作说明',lines:8});
  loop.source={path:documents[0].path,hash:documents[0].hash,heading:'核心循环',line:3};
  const current=await openPage('light',880,640);
  const currentHome=current.page.locator('[data-game-home]');
  assert.match(await currentHome.locator('[data-gh-section="documents-entry"]').innerText(),/设计与机制[\s\S]*机制规则保留[\s\S]*关卡与任务结构待填充[\s\S]*旧名称和数值已退役/);
  assert.equal(await currentHome.getByText('文档审查大板').count(),0);
  assert.equal(await currentHome.locator('.gh-design-links button').count(),4,'the overview keeps four stable reading links despite 16 mechanics documents');
  assert.equal(await currentHome.locator('[data-gh-section="documents-entry"]').getByText('domain:mechanic_1').count(),0,'raw mechanism titles stay in the source browser');
  assert.match(await currentHome.locator('[data-gh-section="loop"] .gh-source').innerText(),/Overview\.md/);
  assert.match(await currentHome.locator('[data-gh-section="world"] header').innerText(),/配置事实/);
  await currentHome.locator('[data-gh-action="read-design-overview"]').click();
  assert.match(await currentHome.locator('[data-gh-document-text]').innerText(),/全景骨架/);
  await currentHome.locator('[data-gh-action="close-source"]').click();
  await currentHome.locator('[data-gh-action="read-design-structure"]').click();
  assert.match(await currentHome.locator('[data-gh-document-text]').innerText(),/关卡与任务结构/);
  await currentHome.locator('[data-gh-action="close-source"]').click();
  await currentHome.locator('[data-gh-action="read-design-mechanic"]').click();
  assert.match(await currentHome.locator('[data-gh-document-text]').innerText(),/机制规则索引/);
  await currentHome.locator('[data-gh-action="close-source"]').click();
  await currentHome.locator('[data-gh-action="read-design-worldbuilding"]').click();
  assert.match(await currentHome.locator('[data-gh-document-text]').innerText(),/世界观基底/);
  await currentHome.locator('[data-gh-action="close-source"]').click();
  await currentHome.locator('[data-gh-action="open-documents"]').click();
  assert.equal(await currentHome.locator('[data-gh-document]').count(),22,'all source documents remain in the browser');
  assert.match(await currentHome.locator('.gh-document-groups').innerText(),/机制规则[\s\S]*世界观[\s\S]*内容结构[\s\S]*制作参考[\s\S]*工程参考（辅助）/);
  await noOverflow(current.page,'current design light 880x640');
  await current.context.close();
  const currentDark=await openPage('dark',880,640);
  assert.equal(await currentDark.page.locator('[data-game-home] .gh-design-links button').count(),4);
  await noOverflow(currentDark.page,'current design dark 880x640');
  await currentDark.context.close();
  ok('current design entry: direct reader links, purpose groups, configuration labeling and 880x640 layouts in both themes');

  // The authored skeleton is the default game-development surface; no Markdown reader opens by default.
  addModelSources(syntheticSkeleton);
  const trackedSource=documents.find(item=>item.path==='Assets/Documents/GameDesign/Mechanics/README.md');
  const trackedHash=trackedSource.hash;
  const trackedRule=syntheticSkeleton.nodes.find(node=>node.id==='condition_fixture');
  trackedRule.provenance.push({path:trackedSource.path,hash:trackedHash,start_line:1,end_line:2,quote:'原有规则摘录：满足条件后继续探索。'});
  const siblingRule={id:'condition_sibling_fixture',kind:'rule',title:'旁支条件',summary:'同组规则入口',parent_id:'shape_fixture',state:'structure_only',sources:[]};
  const scrollSiblings=Array.from({length:14},(_,index)=>({id:`condition_scroll_fixture_${index+1}`,kind:'rule',title:`辅助条件 ${index+1}`,summary:'同组辅助规则',parent_id:'shape_fixture',state:'structure_only',sources:[]}));
  syntheticSkeleton.nodes.push(siblingRule,...scrollSiblings);
  overview.skeleton={source:skeletonSource,model:syntheticSkeleton};
  const canvasGoalsBefore=goalPosts.length;
  const canvasSkeleton=await openPage('dark',1600,900,'canvas');
  const skeletonReader=canvasSkeleton.page.locator('.canvas-source-skeleton');
  await skeletonReader.waitFor();
  assert.equal(await canvasSkeleton.page.locator('dialog.project-workspace[open], dialog.canvas-reader[open]').count(),0,'Game Development enters the Canvas itself without opening a separate reader');
  assert.equal(await skeletonReader.locator('.gs-system-card').count(),10);
  assert.equal(await skeletonReader.locator('.gs-stage').count(),6,'the root keeps the loop');
  assert.equal(await skeletonReader.locator('.gs-group-header[data-gs-group-id=""]').count(),1,'the root has one selectable group header');
  const skeletonObject=board.canvas.objects.find(item=>item.content.type==='source_skeleton');
  assert(skeletonObject,'one source skeleton object was created');
  const skeletonObjectId=skeletonObject.id;
  const skeletonFrame=canvasSkeleton.page.locator(`.canvas-frame[data-item-id="${skeletonObjectId}"]`);
  await canvasSkeleton.page.waitForFunction(id=>document.querySelector(`.canvas-frame[data-item-id="${id}"]`)?.classList.contains('is-active'),skeletonObjectId);
  const skeletonPlacement=structuredClone(board.canvas.items.find(item=>item.item_id===skeletonObjectId));
  assert.equal(skeletonObject.content.skeleton.path,skeletonPath);
  assert.equal(skeletonObject.content.skeleton.hash,skeletonSource.hash);
  assert(skeletonObject.content.skeleton.documents.some(item=>item.path===trackedSource.path&&item.hash===trackedHash));
  const skeletonBack=skeletonReader.getByRole('button',{name:'返回',exact:true});
  const skeletonForward=skeletonReader.getByRole('button',{name:'前进',exact:true});
  assert.equal(await skeletonBack.isDisabled(),true,'new overview has no previous location');
  assert.equal(await skeletonForward.isDisabled(),true,'new overview has no next location');
  await skeletonReader.locator('.gs-system-card[data-gs-node-id="system_1"]').click();
  assert.equal(await skeletonReader.locator('.gs-stage, .gs-system-card').count(),0,'a branch does not repeat root loop or system entrances');
  await skeletonReader.locator('.gs-branch-card[data-gs-node-id="region_fixture"]').click();
  await skeletonReader.locator('.gs-branch-card[data-gs-node-id="shape_fixture"]').click();
  await skeletonReader.locator('.gs-search-input').fill('深入条件');
  await skeletonReader.locator('.gs-result[data-gs-node-id="condition_fixture"]').click();
  assert.equal(await skeletonReader.locator('.gs-group-header[data-gs-group-id="shape_fixture"] .gs-group-title').innerText(),'示例关卡形状');
  const ruleEntry=skeletonReader.locator('.gs-node-entry[data-gs-node-id="condition_fixture"]');
  const siblingEntry=skeletonReader.locator('.gs-node-entry[data-gs-node-id="condition_sibling_fixture"]');
  assert.equal(await ruleEntry.count(),1,'the selected rule remains in its parent group');
  assert.equal(await siblingEntry.count(),1,'the selected rule keeps its sibling in the same list');
  assert.equal(await ruleEntry.locator('.gs-node-row').getAttribute('aria-pressed'),'true');
  assert.equal(await siblingEntry.locator('.gs-node-row').getAttribute('aria-pressed'),'false');
  assert.match(await ruleEntry.locator('.gs-node-row').innerText(),/存在待核分歧/,'review state is visible on the row');
  assert.equal(await skeletonReader.getByText('这个节点没有列出直接关联。').count(),0,'a branch omits empty relationship copy');
  await skeletonReader.locator('.gs-search-input').fill('stageScore');
  const historyScroll=await skeletonReader.evaluate(node=>{
    const map=node.querySelector('.canvas-source-skeleton-map'),detail=node.querySelector('.canvas-source-skeleton-detail');
    map.scrollTop=90;detail.scrollTop=80;return {map:map.scrollTop,detail:detail.scrollTop};
  });
  assert(historyScroll.map>0&&historyScroll.detail>0,'history fixture exercises both scroll panes');
  await skeletonBack.click();
  assert.equal(await skeletonReader.locator('.gs-detail-title').innerText(),'示例关卡形状','Back follows the visited node');
  assert.equal(await skeletonReader.locator('.gs-search-input').inputValue(),'深入条件','Back restores the previous search');
  assert.match(await canvasSkeleton.page.locator('#form-reason').innerText(),/示例关卡形状/,'Back updates the Canvas selection preview');
  await shot(canvasSkeleton.page,'canvas-skeleton-history-1600');
  await skeletonForward.click();
  assert.equal(await skeletonReader.locator('.gs-detail-title').innerText(),'深入条件','Forward restores the next node');
  assert.equal(await skeletonReader.locator('.gs-search-input').inputValue(),'stageScore','Forward restores its search');
  assert.deepEqual(await skeletonReader.evaluate(node=>({map:node.querySelector('.canvas-source-skeleton-map').scrollTop,detail:node.querySelector('.canvas-source-skeleton-detail').scrollTop})),historyScroll,'Forward restores both scroll positions');
  await skeletonBack.click();
  await siblingEntry.locator('.gs-node-row').click();
  assert.equal(await skeletonReader.getByText('这个节点没有列出直接关联。').count(),0,'a sibling with no relations has no empty relationship section');
  assert.equal(await skeletonForward.isDisabled(),true,'opening a new node after Back discards the old forward path');
  await skeletonBack.click();
  assert.equal(await skeletonReader.locator('.gs-detail-title').innerText(),'示例关卡形状');
  await skeletonForward.click();
  assert.equal(await skeletonReader.locator('.gs-detail-title').innerText(),'旁支条件','Forward follows the new sibling path');
  await skeletonBack.click();
  await skeletonReader.locator('.gs-search-clear').click();
  await ruleEntry.locator('.gs-node-row').click();
  await siblingEntry.locator('.gs-node-row').click();
  assert.equal(await siblingEntry.locator('.gs-node-row').getAttribute('aria-pressed'),'true');
  await skeletonBack.click();
  assert.equal(await ruleEntry.locator('.gs-node-row').getAttribute('aria-pressed'),'true','Back returns to the rule after a sibling visit');
  await skeletonForward.click();
  assert.equal(await siblingEntry.locator('.gs-node-row').getAttribute('aria-pressed'),'true','Forward returns to the sibling');
  await skeletonBack.click();
  assert.equal(await skeletonReader.locator('.gs-detail-title').innerText(),'深入条件');
  ok('Canvas Back and Forward restore each visited node, search, scroll and selection; sibling navigation replaces and traverses the forward path');
  assert.equal(await skeletonReader.locator('.gs-detail-title').innerText(),'深入条件');
  assert.match(await skeletonReader.locator('[data-gs-rule="effects"]').innerText(),/允许继续探索/);
  assert.match(await skeletonReader.locator('[data-gs-rule="conflicts"]').innerText(),/成功与领奖是两个时点/);
  await skeletonReader.locator('.gs-sources > summary').click();
  assert.match(await skeletonReader.locator('.gs-provenance[data-gs-evidence-state="archived"]').innerText(),/历史证据[\s\S]*<img src=x/);
  assert.equal(await skeletonReader.locator('.gs-provenance img').count(),0,'untrusted evidence remains literal text');
  await skeletonReader.locator('.gs-original-sources > summary').click();
  await skeletonReader.locator('.gs-source-links button').first().click();
  await skeletonReader.locator('.canvas-source-skeleton-source-text').waitFor();
  assert.match(await skeletonReader.locator('.canvas-source-skeleton-source-text').innerText(),/机制规则索引/);
  await skeletonReader.locator('.canvas-source-skeleton-source-head button').click();
  assert.equal(await canvasSkeleton.page.evaluate(()=>window.injected),undefined);
  await skeletonReader.locator('.canvas-source-skeleton-map, .canvas-source-skeleton-detail').evaluateAll(nodes=>nodes.forEach(node=>{node.scrollTop=0;}));
  await shot(canvasSkeleton.page,'canvas-skeleton-in-place-1600');
  await skeletonFrame.locator('.canvas-frame-head > button').nth(1).click();
  await canvasSkeleton.page.locator('dialog.canvas-reader[open]').waitFor();
  await shot(canvasSkeleton.page,'canvas-skeleton-rule-dark-1600');
  ok('Game Development browses the source directly on Canvas; optional reader, root-to-rule navigation and versioned evidence remain readable text');

  const readerFonts=()=>skeletonReader.evaluate(node=>{
    const size=selector=>parseFloat(getComputedStyle(node.querySelector(selector)).fontSize);
    return {body:size('.gs-detail-lead'),title:size('.gs-detail-title'),group:size('.gs-group-title'),interface:size('.gs-node-row .gs-card-title'),action:size('.gs-develop')};
  });
  const changeReaderFonts=async values=>{
    await canvasSkeleton.page.locator('dialog.canvas-reader[open] .canvas-reader-font-settings').click();
    for(const [kind,value] of Object.entries(values)){
      const input=canvasSkeleton.page.locator(`#settings-font-${kind}`);
      await input.focus();await input.press('Home');
      for(let step=80;step<value;step+=10)await input.press('ArrowRight');
      assert.equal(await input.inputValue(),String(value));
    }
    await canvasSkeleton.page.locator('#settings-close').click();
  };
  const normalFonts=await readerFonts();
  await changeReaderFonts({body:180});
  const enlargedFonts=await readerFonts();
  assert(Math.abs(enlargedFonts.body/normalFonts.body-1.8)<.02,'180% changes the actual skeleton body font');
  assert.equal(enlargedFonts.title,normalFonts.title,'body size does not overwrite the heading preference');
  assert.equal(enlargedFonts.interface,normalFonts.interface,'body size does not overwrite interface size');
  await canvasSkeleton.page.setViewportSize({width:3840,height:2088});
  const wideReader=await skeletonReader.evaluate(node=>{
    const root=node.getBoundingClientRect(),map=node.querySelector('.canvas-source-skeleton-map').getBoundingClientRect();
    return {width:root.width,center:(root.left+root.right)/2,viewport:innerWidth,mapWidth:map.width,overflow:node.scrollWidth>node.clientWidth+1};
  });
  assert(wideReader.width<2200&&wideReader.width>1200,'4K reader has a bounded reading width');
  assert(Math.abs(wideReader.center-wideReader.viewport/2)<4,'4K reading area is centered');
  assert(wideReader.mapWidth<=425,'the outline does not expand to half the monitor');
  assert.equal(wideReader.overflow,false);
  assert.equal(await canvasSkeleton.page.locator('dialog.canvas-reader[open] .canvas-reader-text-size').innerText(),'180%');
  await shot(canvasSkeleton.page,'canvas-skeleton-fullscreen-3840-180');
  await changeReaderFonts({title:140,interface:130});
  const separateFonts=await readerFonts();
  assert(Math.abs(separateFonts.title/normalFonts.title-1.4)<.02,'heading size applies to skeleton headings');
  assert(Math.abs(separateFonts.group/normalFonts.group-1.4)<.02,'dialog button styling does not override the group heading');
  assert(Math.abs(separateFonts.interface/normalFonts.interface-1.3)<.02,'interface size applies to skeleton rows');
  assert(Math.abs(separateFonts.action/normalFonts.action-1.3)<.02,'interface size applies to action buttons');
  assert.equal(separateFonts.body,enlargedFonts.body);
  await canvasSkeleton.page.setViewportSize({width:480,height:800});
  await skeletonReader.locator('.canvas-source-skeleton-body.is-narrow').waitFor();
  assert.equal(await skeletonReader.evaluate(node=>node.scrollWidth<=node.clientWidth+1),true,'large type remains contained at narrow width');
  await shot(canvasSkeleton.page,'canvas-skeleton-reader-large-type-480');
  await changeReaderFonts({body:100,title:100,interface:100});
  await canvasSkeleton.page.setViewportSize({width:1600,height:900});
  ok('skeleton reader honors independent font preferences and bounds its 4K reading layout without narrow overflow');

  const canvasAnnotation=canvasSkeleton.page.locator('dialog.canvas-annotations[open]');
  await canvasSkeleton.page.locator('.canvas-reader-annotation').click();
  await canvasAnnotation.waitFor();
  await canvasAnnotation.locator('.canvas-annotation-input').waitFor();
  await canvasAnnotation.locator('.canvas-annotation-input').fill('核对深入条件');
  await canvasAnnotation.locator('.canvas-annotations-save').click();
  await canvasSkeleton.page.waitForFunction(()=>document.querySelector('.canvas-annotation-card'));
  const nodeAnnotation=annotationOps.at(-1);
  assert.equal(nodeAnnotation.anchor.object_id,skeletonObjectId);
  assert.equal(nodeAnnotation.anchor.block_id,'condition_fixture','Canvas annotation targets the selected rule');
  assert.equal(nodeAnnotation.anchor.content_revision,1);
  await canvasAnnotation.locator('.canvas-annotations-close').click();
  await skeletonReader.locator('.gs-develop').click();
  assert.match(await canvasSkeleton.page.locator('#form-reason').innerText(),/深入条件/,'Canvas composer previews the selected node');
  assert.equal(await canvasSkeleton.page.locator('#input').isEnabled(),true,'node discussion uses the main Canvas composer');
  assert.equal(goalPosts.length,canvasGoalsBefore,'Canvas discussion does not create a project goal');
  await canvasSkeleton.page.locator('#input').fill('请核对深入条件的触发和例外。');
  await canvasSkeleton.page.locator('#recipient-change').click();
  const sendsBeforeNewChat=sayPosts.length;
  await canvasSkeleton.page.locator('#recipient-new-chat').click();
  const newChat=canvasSkeleton.page.locator('#canvas-new-chat');
  await newChat.waitFor();
  assert.equal(await newChat.locator('#new-chat-request').inputValue(),'请核对深入条件的触发和例外。');
  assert.match(await newChat.locator('#new-chat-workspace option:checked').innerText(),/VESPERIX/,'unlinked skeleton supplies its source workspace');
  await shot(canvasSkeleton.page,'canvas-skeleton-new-chat');
  await newChat.getByRole('button',{name:'取消',exact:true}).click();
  assert.equal(await canvasSkeleton.page.locator('#input').inputValue(),'请核对深入条件的触发和例外。');
  assert.equal(sayPosts.length,sendsBeforeNewChat,'opening or cancelling a new-chat draft does not send to an existing task');
  ok('unlinked skeleton offers a new conversation in its workspace and preserves the composer on cancellation');
  await canvasSkeleton.page.locator('#recipient-workspace').selectOption({index:1});
  await canvasSkeleton.page.locator('#recipient').selectOption(source);
  await canvasSkeleton.page.locator('#send').click();
  await canvasSkeleton.page.waitForFunction(()=>document.querySelector('#input')?.value==='');
  assert.equal(sayPosts.at(-1).anchors?.[0]?.object_id,skeletonObjectId);
  assert.equal(sayPosts.at(-1).anchors?.[0]?.block_id,'condition_fixture');
  assert.equal(sayPosts.at(-1).anchors?.[0]?.content_revision,1);
  assert.equal(goalPosts.length,canvasGoalsBefore,'Canvas send never creates a project goal');
  ok('selected Canvas node drives annotation and composer anchors; mocked say sends the exact node without a project goal');

  if(await canvasSkeleton.page.locator('dialog.canvas-reader[open]').count())await canvasSkeleton.page.locator('.canvas-reader-close').click();
  await canvasSkeleton.page.locator('#projects-open').click();
  await skeletonReader.waitFor();
  await canvasSkeleton.page.waitForFunction(id=>document.querySelector(`.canvas-frame[data-item-id="${id}"]`)?.classList.contains('is-active'),skeletonObjectId);
  assert.equal(board.canvas.objects.filter(item=>item.id===skeletonObjectId).length,1,'reopen reuses the source object');
  assert.equal(await skeletonReader.locator('.gs-detail-title').innerText(),'深入条件','reopen retains node selection');
  await skeletonReader.locator('.gs-search-input').fill('stageScore');
  assert.equal(await canvasSkeleton.page.evaluate(id=>JSON.parse(localStorage.getItem(`spellcast.canvas.skeleton.${id}`)||'{}').query,skeletonObjectId),'stageScore','search is persisted before reload');
  await canvasSkeleton.page.reload({waitUntil:'commit'});
  await skeletonReader.waitFor();
  assert.equal(await skeletonReader.locator('.gs-detail-title').innerText(),'深入条件','full reload retains node selection');
  assert.equal(await skeletonReader.locator('.gs-search-input').inputValue(),'stageScore','full reload retains search');
  await canvasSkeleton.page.locator('#projects-open').click();
  await canvasSkeleton.page.waitForFunction(id=>document.querySelector(`.canvas-frame[data-item-id="${id}"]`)?.classList.contains('is-active'),skeletonObjectId);
  await skeletonBack.click();
  assert.equal(await skeletonReader.locator('.gs-detail-title').innerText(),'示例关卡形状','Back history survives reload');
  await canvasSkeleton.page.reload({waitUntil:'commit'});
  await skeletonReader.waitFor();
  await canvasSkeleton.page.locator('#projects-open').click();
  await canvasSkeleton.page.waitForFunction(id=>document.querySelector(`.canvas-frame[data-item-id="${id}"]`)?.classList.contains('is-active'),skeletonObjectId);
  assert.equal(await skeletonReader.locator('.gs-detail-title').innerText(),'示例关卡形状','reload keeps the history cursor');
  await skeletonForward.click();
  assert.equal(await skeletonReader.locator('.gs-detail-title').innerText(),'深入条件','Forward history also survives reload');
  assert.equal(await skeletonReader.locator('.gs-search-input').inputValue(),'stageScore');
  await skeletonFrame.locator('.canvas-frame-head > button').nth(1).click();
  await canvasSkeleton.page.locator('dialog.canvas-reader[open]').waitFor();
  for(const width of [760,480]){
    await canvasSkeleton.page.setViewportSize({width,height:800});
    await skeletonReader.locator('.canvas-source-skeleton-body.is-narrow').waitFor();
    assert.equal(await skeletonReader.evaluate(node=>{
      const body=node.querySelector('.canvas-source-skeleton-body');
      return ['auto','scroll'].includes(getComputedStyle(body).overflowY);
    }),true,'the narrow body owns vertical scrolling');
    assert.equal(await ruleEntry.evaluate(entry=>{
      const row=entry.querySelector('.gs-node-row'),detail=entry.querySelector('.gs-detail');
      return !!row&&!!detail&&!!row.nextElementSibling?.contains(detail);
    }),true,'the selected rule body follows its row');
    assert.equal(await ruleEntry.locator('.gs-node-row').getAttribute('aria-pressed'),'true');
    await noOverflow(canvasSkeleton.page,`Canvas rule ${width}`);
    await shot(canvasSkeleton.page,`canvas-skeleton-rule-inline-${width}`);
    if(width===480){
      const scroll=await skeletonReader.locator('.canvas-source-skeleton-body').evaluate(node=>{node.scrollTop=180;return node.scrollTop;});
      assert(scroll>0,'narrow history exercises the shared scroll container');
      await skeletonBack.click();
      await skeletonForward.click();
      assert.equal(await skeletonReader.locator('.canvas-source-skeleton-body').evaluate(node=>node.scrollTop),scroll,'Forward restores the narrow reading position');
      assert.equal(await ruleEntry.locator('.gs-node-row').getAttribute('aria-pressed'),'true');
    }
  }
  await skeletonReader.locator('.gs-group-header[data-gs-group-id="shape_fixture"] button').click();
  assert.equal(await skeletonReader.locator('.gs-group-header[data-gs-group-id="shape_fixture"]').evaluate(header=>!!header.nextElementSibling?.contains(header.parentElement.querySelector('.gs-detail'))),true,'selected group body follows the group header at narrow width');
  await skeletonBack.click();
  assert.equal(await skeletonReader.locator('.gs-detail-title').innerText(),'深入条件','group selection adds a recoverable history location');
  await canvasSkeleton.page.setViewportSize({width:1600,height:900});
  await canvasSkeleton.page.locator('.canvas-reader-close').click();
  await canvasSkeleton.page.locator('#projects-open').click();
  await canvasSkeleton.page.waitForFunction(id=>document.querySelector(`.canvas-frame[data-item-id="${id}"]`)?.classList.contains('is-active'),skeletonObjectId);
  skeletonSource.hash=H('b');
  const skeletonRelations=syntheticSkeleton.relations;
  syntheticSkeleton.nodes=syntheticSkeleton.nodes.filter(node=>node.id!=='condition_fixture');
  syntheticSkeleton.relations=syntheticSkeleton.relations.filter(edge=>edge.from!=='condition_fixture'&&edge.to!=='condition_fixture');
  canvasSkeleton.page.once('dialog',dialog=>dialog.accept());
  await skeletonAction(skeletonReader,'refresh');
  await canvasSkeleton.page.waitForFunction(()=>document.querySelector('.canvas-source-skeleton-detail .gs-detail-title')?.textContent?.includes('游戏全貌'));
  assert.equal(board.canvas.objects.filter(item=>item.id===skeletonObjectId).length,1);
  assert.equal(board.canvas.objects.find(item=>item.id===skeletonObjectId).content_revision,2);
  assert.deepEqual(board.canvas.items.find(item=>item.item_id===skeletonObjectId),skeletonPlacement,'explicit refresh preserves placement');
  assert.equal(board.canvas.annotations.find(item=>item.id===nodeAnnotation.id).anchor.content_revision,1,'refresh preserves the old annotation snapshot');
  assert.equal(await skeletonReader.locator('.gs-detail-title').innerText(),'游戏全貌','removed selected node falls back to root');
  assert.equal(await canvasSkeleton.page.evaluate(id=>JSON.parse(localStorage.getItem(`spellcast.canvas.skeleton.${id}`)).history.some(view=>view.selectedId==='condition_fixture'),skeletonObjectId),false,'refresh removes missing nodes from browsing history');
  await skeletonBack.click();
  assert.equal(await skeletonReader.locator('.gs-detail-title').innerText(),'示例关卡形状','valid previous locations remain after refresh');
  await skeletonForward.click();
  assert.equal(await skeletonReader.locator('.gs-detail-title').innerText(),'游戏全貌');
  await skeletonFrame.locator('.canvas-frame-head > button').nth(1).click();
  await canvasSkeleton.page.locator('dialog.canvas-reader[open]').waitFor();
  for(const width of [760,480]){
    await canvasSkeleton.page.setViewportSize({width,height:800});
    await skeletonReader.locator('.canvas-source-skeleton-body.is-narrow').waitFor();
    assert.equal(await skeletonReader.locator('.gs-group-header[data-gs-group-id=""]').evaluate(header=>{
      const detail=header.parentElement.querySelector('.gs-detail');
      return !!detail&&!!header.nextElementSibling?.contains(detail);
    }),true,'root summary follows its group header at narrow width');
    assert.equal(await skeletonReader.locator('summary[data-skeleton-tools-toggle]').isVisible(),true,'the More menu stays visible');
    assert.equal(await skeletonReader.locator('.gs-search-input').isVisible(),true,'search stays usable');
    assert.equal(await skeletonBack.isVisible()&&await skeletonForward.isVisible(),true,'Back and Forward remain visible at narrow widths');
    await noOverflow(canvasSkeleton.page,`Canvas skeleton ${width}`);
    assert.equal(await skeletonReader.evaluate(node=>node.scrollWidth<=node.clientWidth+1),true,'Canvas browser has no horizontal overflow');
    assert.equal(await skeletonReader.locator('summary[data-skeleton-tools-toggle]').evaluate(node=>{const r=node.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth;}),true,'Canvas More stays within the viewport');
    assert.equal(await canvasSkeleton.page.locator('dialog.canvas-reader[open] > header h2').evaluate(node=>node.getBoundingClientRect().width>200),true,'reader title keeps a readable line at narrow widths');
    await shot(canvasSkeleton.page,`canvas-skeleton-${width}`);
  }
  await skeletonAction(skeletonReader,'manage');
  await canvasSkeleton.page.locator('dialog.project-workspace[open] [data-project-tools] > summary').waitFor();
  await canvasSkeleton.context.close();
  ok('Canvas skeleton reopens and survives reload, explicit refresh keeps identity, placement and annotation snapshot, missing node falls back, narrow tools stay usable');

  const canvasOnlyIds=new Set([siblingRule.id,...scrollSiblings.map(node=>node.id)]);
  syntheticSkeleton.nodes=syntheticSkeleton.nodes.filter(node=>!canvasOnlyIds.has(node.id));
  syntheticSkeleton.nodes.push(trackedRule);
  syntheticSkeleton.relations=skeletonRelations;
  skeletonSource.hash=H('a');
  const skeletonDark=await openPage('dark',1600,900);
  const skeletonHome=skeletonDark.page.locator('[data-game-home]');
  assert.equal(await skeletonHome.locator('[data-game-skeleton="map"]').count(),1);
  assert.equal(await skeletonHome.locator('.gs-system-card').count(),10);
  assert.equal(await skeletonHome.locator('.gs-stage').count(),6);
  assert.equal(await skeletonHome.locator('[data-gh-section="documents-entry"]').count(),0);
  assert.equal(await skeletonHome.locator('dialog[open]').count(),0);
  assert.equal(await skeletonHome.locator('[data-gh-action="browse-design-sources"]').count(),0,'source library is not a peer of game structure');
  const libraryButton=skeletonDark.page.locator('[data-project-action="source-library"]');
  assert.equal(await libraryButton.isVisible(),false,'source library starts inside closed Tools');
  await skeletonDark.page.locator('[data-project-tools] > summary').click();await libraryButton.click();
  assert.match(await skeletonHome.locator('[data-gh-section="documents"]').innerText(),/来源资料[\s\S]*当前规则在游戏节点里继续完善/);
  await skeletonDark.page.locator('[data-project-tools] > summary').click();await skeletonDark.page.locator('[data-project-view="game"]').click();
  assert.equal(await skeletonHome.locator('[data-game-skeleton="map"]').count(),1);
  await shot(skeletonDark.page,'skeleton-dark-1600');
  await noOverflow(skeletonDark.page,'skeleton dark 1600x900');

  await skeletonHome.locator('.gs-system-card[data-gs-node-id="system_1"]').click();
  await skeletonHome.locator('.gs-branch-card[data-gs-node-id="region_fixture"]').click();
  await skeletonHome.locator('.gs-branch-card[data-gs-node-id="shape_fixture"]').click();
  await skeletonHome.locator('.gs-branch-card[data-gs-node-id="condition_fixture"]').click();
  assert.equal(await skeletonHome.locator('.gs-detail-title').innerText(),'深入条件');
  assert.equal(await skeletonHome.locator('.gs-sources').getAttribute('open'),null,'evidence starts collapsed');
  assert.match(await skeletonHome.locator('.gs-detail').innerText(),/何时触发[\s\S]*需要满足[\s\S]*发生什么[\s\S]*例外与边界[\s\S]*公式与单位[\s\S]*待核分歧/);
  assert.match(await skeletonHome.locator('[data-gs-rule="formulas"]').innerText(),/stageScore = base \+ progress/);
  assert.equal(await skeletonHome.locator('dialog[open]').count(),0,'absorbed rules are readable in the node without the source reader');
  await skeletonHome.locator('.gs-sources > summary').click();
  const historicalEvidence=skeletonHome.locator('.gs-provenance[data-gs-evidence-state="archived"]');
  assert.match(await historicalEvidence.innerText(),/历史出处[\s\S]*<img src=x/);
  assert.doesNotMatch(await historicalEvidence.innerText(),/RetiredExample.md|SHA-256/,'technical source details start folded');
  assert.equal(await skeletonHome.locator('.gs-provenance[data-gs-evidence-state="matched"]').count(),1);
  assert.equal(await skeletonHome.locator('[data-gs-evidence-alert]').count(),0,'matching source versions need no warning');
  await historicalEvidence.locator('.gs-source-metadata > summary').click();
  assert.match(await historicalEvidence.innerText(),/RetiredExample.md[\s\S]*SHA-256/);
  assert.equal(await skeletonHome.locator('.gs-provenance img').count(),0,'source quotations remain text');
  assert.equal(await historicalEvidence.locator('button').count(),0,'archived paths are not treated as current documents');
  trackedSource.hash=H('0');
  await skeletonDark.page.locator('[data-project-action="refresh"]').click();
  await skeletonHome.locator('[data-gs-evidence-alert]').waitFor();
  assert.match(await skeletonHome.locator('[data-gs-evidence-alert]').innerText(),/1 份来源待核对/,'historical citations do not create a false drift alert');
  const changedEvidence=skeletonHome.locator('.gs-provenance[data-gs-evidence-state="changed"]');
  assert.equal(await changedEvidence.locator('blockquote').textContent(),'原有规则摘录：满足条件后继续探索。','source drift never rewrites the saved quote');
  assert.match(await skeletonHome.locator('[data-gs-rule="effects"]').innerText(),/允许继续探索/,'source drift preserves the authored rule');
  await skeletonHome.locator('[data-gs-evidence-alert] button').click();
  await changedEvidence.locator('.gs-source-metadata > summary').click();
  assert.match(await changedEvidence.innerText(),/摘录版本[\s\S]*当前版本/);
  await shot(skeletonDark.page,'skeleton-source-changed-dark-1600');
  await noOverflow(skeletonDark.page,'source drift dark 1600x900');
  for(const [theme,width,height] of [['light',1600,900],['dark',880,640],['light',880,640]]){
    const view=await openPage(theme,width,height);const h=view.page.locator('[data-game-home]');
    await h.locator('.gs-search-input').fill('深入条件');await h.locator('.gs-result[data-gs-node-id="condition_fixture"]').click();
    await h.locator('[data-gs-evidence-alert]').waitFor();await h.locator('[data-gs-evidence-alert] button').click();
    await h.locator('.gs-provenance[data-gs-evidence-state="changed"]').scrollIntoViewIfNeeded();
    await shot(view.page,`skeleton-source-changed-${theme}-${width}`);await noOverflow(view.page,`source drift ${theme} ${width}x${height}`);await view.context.close();
  }
  trackedSource.hash=trackedHash;
  await skeletonDark.page.locator('[data-project-action="refresh"]').click();
  await skeletonHome.locator('.gs-provenance[data-gs-evidence-state="matched"]').waitFor({state:'attached'});
  assert.equal(await skeletonHome.locator('[data-gs-evidence-alert]').count(),0,'a matching source revision clears the derived warning');
  if(await skeletonHome.locator('.gs-sources').getAttribute('open')!==null)await skeletonHome.locator('.gs-sources > summary').click();
  ok('source library in Tools; inline quotations with folded provenance; source changes warn without rewriting rules or treating archived history as current');
  await skeletonHome.locator('.gs-search-input').fill('stageScore');
  assert.equal(await skeletonHome.locator('.gs-result:visible').count(),1,'search includes full rule content');
  await skeletonHome.locator('.gs-system-card[data-gs-node-id="system_10"]').click();
  assert.equal(await skeletonHome.locator('.gs-branch-card').count(),24,'large branches open one readable page');
  await skeletonHome.locator('.gs-branch .gs-more').click();
  assert.equal(await skeletonHome.locator('.gs-branch-card').count(),30,'all remaining rules remain reachable');
  await skeletonHome.locator('.gs-search-input').fill('深入条件');
  assert.equal(await skeletonHome.locator('.gs-result:visible').count(),1,'deep nodes are directly searchable');
  await skeletonHome.locator('.gs-result[data-gs-node-id="condition_fixture"]').click();
  assert.equal(await skeletonHome.locator('.gs-detail-title').innerText(),'深入条件');

  const beforeSkeletonGoals=goalPosts.length;
  await skeletonHome.locator('.gs-develop').click();
  const skeletonDraft=skeletonHome.locator('[data-gh-goal]');
  assert.match(await skeletonDraft.inputValue(),/深入条件/);
  assert.equal(await skeletonDraft.evaluate(node=>document.activeElement===node),true,'AI action focuses the composer');
  assert.equal(goalPosts.length,beforeSkeletonGoals,'AI action never submits');
  await skeletonDraft.fill('已有用户草稿：深入条件要先核对路线。');
  await skeletonHome.locator('.gs-system-card[data-gs-node-id="system_2"]').click();
  await skeletonHome.locator('.gs-develop').click();
  assert.equal(await skeletonDraft.inputValue(),'已有用户草稿：深入条件要先核对路线。','AI action preserves a user draft');
  assert.equal(goalPosts.length,beforeSkeletonGoals);
  await skeletonHome.locator('.gs-search-input').fill('深入条件');
  await skeletonHome.locator('.gs-result[data-gs-node-id="condition_fixture"]').click();
  await skeletonHome.locator('[data-gh-action="save-unsent"]').click();
  await skeletonDark.page.waitForFunction(()=>document.querySelector('[data-gh-goal]')?.value==='');
  const savedSkeletonGoal=goals[0];
  assert.equal(goalPosts.length,beforeSkeletonGoals+1);
  assert.equal(savedSkeletonGoal.status,'unsent');
  assert.equal(savedSkeletonGoal.context.entity_kind,'design_node');
  assert.equal(savedSkeletonGoal.context.entity_id,'condition_fixture');
  assert.equal(savedSkeletonGoal.context.source_revision,skeletonSource.hash);
  assert(savedSkeletonGoal.context.sources.some(source=>source.path===skeletonPath&&source.hash===skeletonSource.hash));
  assert(savedSkeletonGoal.context.sources.some(source=>source.path==='Assets/Documents/GameDesign/Mechanics/README.md'));
  assert.equal(await skeletonHome.locator('dialog[open]').count(),0,'saving a goal does not open the reader');
  const postsAfterSave=goalPosts.length;
  proposals.unshift({id:'skeleton-adopted-by-goal',project_id:project.id,revision:2,title:'骨架节点内容',summary:'',
    subject:{scale:'overview'},goal_id:savedSkeletonGoal.id,status:'closed',created_at_ms:now,updated_at_ms:now,created_by:agent,updated_by:user,
    references:[],boundaries:'夹具已采纳内容，无玩家验证。',items:[{id:'adopted-node-content',target:'object',target_id:'skeleton-condition-content',
      status:'adopted',base_revision:0,reason:'来自节点目标',basis:['design'],references:[],boundaries:'无玩家验证。'}]});
  objects.push({id:'skeleton-condition-content',project_id:project.id,name:'深入条件 · 已采纳内容',kind:'content',revision:1,archived:false,
    planning:{body:'依据已采纳的节点目标整理条件。',sections:[{id:'skeleton-section',role:'body',text:'条件满足后开放下一层。'}]}});
  await skeletonDark.page.locator('[data-project-action="refresh"]').click();
  await skeletonHome.locator('[data-gh-section="skeleton-adopted"]').waitFor();
  assert.match(await skeletonHome.locator('[data-gh-section="skeleton-adopted"]').innerText(),/深入条件 · 已采纳内容[\s\S]*依据已采纳的节点目标整理条件[\s\S]*条件满足后开放下一层/);
  assert.equal(goalPosts.length,postsAfterSave,'refreshing adopted content sends no additional goal');
  await skeletonHome.locator('.gs-system-card[data-gs-node-id="system_2"]').click();
  assert.equal(await skeletonHome.locator('[data-gh-section="skeleton-adopted"]').count(),0,'adopted content stays on its target node');
  await skeletonHome.locator('.gs-search-input').fill('深入条件');
  await skeletonHome.locator('.gs-result[data-gs-node-id="condition_fixture"]').click();
  await skeletonHome.locator('.gs-sources > summary').click();
  await skeletonHome.locator('.gs-original-sources > summary').click();
  await skeletonHome.locator('.gs-source-links button').first().click();
  assert.match(await skeletonHome.locator('[data-gh-document-text]').innerText(),/机制规则索引/);
  await skeletonHome.locator('[data-gh-action="close-source"]').click();
  await skeletonHome.locator('[data-gh-action="overview-implementation"]').click();
  assert.equal(await skeletonHome.locator('[data-gh-section="loop"]').count(),1,'implementation view still shows sourced configuration');
  assert.match(await skeletonHome.locator('[data-gh-section="world"] header').innerText(),/配置事实/);
  await skeletonHome.locator('[data-gh-action="overview-design"]').click();
  assert.equal(await skeletonHome.locator('[data-game-skeleton="map"]').count(),1);
  await skeletonDark.context.close();
  ok('skeleton map: ten systems, six stages, region-to-condition drilldown, search, composer context, goal-linked adopted content, explicit source reading and implementation switch');

  for(const [theme,width,height] of [['light',1600,900],['dark',880,640],['light',880,640]]){
    const view=await openPage(theme,width,height);
    assert.equal(await view.page.locator('[data-game-home] [data-game-skeleton="map"] .gs-system-card').count(),10);
    await shot(view.page,`skeleton-${theme}-${width}`);
    await noOverflow(view.page,`skeleton ${theme} ${width}x${height}`);
    await view.context.close();
  }
  ok('skeleton map fits 1600x900 and 880x640 in both themes');

  // The fixed Canvas tools operate on one source, while the composer action only appends a draft.
  // Keep this fixture's data isolated from the optional real-model screenshots below.
  const savedToolCanvas=structuredClone(board.canvas);
  const toolSkeleton=structuredClone(board.canvas.objects.find(object=>object.content.type==='source_skeleton'));
  const toolTable=structuredClone(board.canvas.objects.find(object=>object.content.type==='source_table'));
  assert(toolSkeleton&&toolTable,'game tools fixture reuses the authored source objects');
  toolSkeleton.content.skeleton={...toolSkeleton.content.skeleton,hash:skeletonSource.hash,model:structuredClone(syntheticSkeleton),documents:structuredClone(documents)};
  const provenanceOnlyDocument=documents.find(document=>document.path==='Assets/Documents/GameDesign/ConfigReference/Config.md');
  toolSkeleton.content.skeleton.model.nodes.find(node=>node.id==='condition_fixture').provenance.push({path:provenanceOnlyDocument.path,hash:provenanceOnlyDocument.hash,start_line:1,end_line:1,quote:'仅列在证据中的配置边界。'});
  toolTable.content.table={...toolTable.content.table,project_id:project.id,root:connection.root,path:loop.source.path,hash:loop.source.hash,heading:loop.source.heading,line:loop.source.line,columns:structuredClone(loop.columns),rows:structuredClone(loop.rows)};
  const toolNote={id:'game-tools-note',content:{type:'text',title:'核对参考便签',text:'用户补充：失败后应可重试。<img src=x onerror="window.injected=12">'},content_revision:1,origin:null,bindings:[],source_id:null,user_edited:true};
  const foreignTable={...structuredClone(toolTable),id:'game-tools-foreign',content:{type:'source_table',table:{...structuredClone(toolTable.content.table),project_id:'bbbbbbbb-0000-4000-8000-000000000001',root:'C:/fixture/OtherGame',title:'另一个项目的循环'}}};
  const foreignRecord={id:'game-tools-record-card',content:{type:'work_record',project_id:foreignTable.content.table.project_id,record_id:'game-tools-record'},content_revision:1,origin:null,bindings:[],source_id:null,user_edited:false};
  const toolObjects=[toolSkeleton,toolTable,toolNote,foreignTable,foreignRecord];
  // The Canvas opens in the connected workspace scope; reference origin controls visibility only.
  for(const object of toolObjects)object.origin={cwd:connection.root,label:project.name};
  board.canvas={revision:1,objects:toolObjects,items:toolObjects.map((object,index)=>({item_id:object.id,revision:1,z:0,removed:false,appearance:'card',x:index*760,y:80,width:700,height:520})),annotations:[]};
  let toolContext;
  try{
    const view=await openPage('dark',1600,900,'canvas');toolContext=view.context;
    const toolPage=view.page,tools=toolPage.locator('#canvas-game-tools'),design=toolPage.locator('#canvas-game-design'),check=toolPage.locator('#canvas-game-check'),input=toolPage.locator('#input');
    const refresh=toolPage.locator('#canvas-game-refresh'),readSource=toolPage.locator('#canvas-game-source'),manage=toolPage.locator('#canvas-game-project');
    const directDisabled=async expected=>{for(const button of [refresh,readSource,manage])assert.equal(await button.isDisabled(),expected);};
    const select=async(id,append=false)=>{
      if(await tools.evaluate(node=>node.open))await tools.locator('summary').first().click();
      await toolPage.locator('.canvas-tool-camera button').first().click();
      await toolPage.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
      const frame=toolPage.locator(`.canvas-frame[data-item-id="${id}"]`);
      const title=frame.locator('.canvas-frame-head strong');
      const target=await title.isVisible()?title:frame.locator('.canvas-card-drag');
      await target.click({modifiers:append?['Control']:[]});
      await toolPage.waitForFunction(([id,append])=>document.querySelector(`.canvas-frame[data-item-id="${id}"]`)?.classList.contains('is-selected')&& (append||document.querySelectorAll('.canvas-frame.is-selected').length===1),[id,append]);
    };
    const clearSelection=async()=>{await toolPage.locator('.canvas-tool-selection').getByRole('button',{name:'清除选择',exact:true}).click();await toolPage.waitForFunction(()=>!document.querySelector('.canvas-frame.is-selected'));};
    const openTools=async()=>{if(!await tools.evaluate(node=>node.open))await tools.locator('summary').first().click();};
    const openDesign=async()=>{if(!await design.evaluate(node=>node.open))await toolPage.locator('#canvas-game-design-toggle').click();};
    const settleCheck=async()=>{await openDesign();await check.click();await toolPage.waitForFunction(()=>!document.querySelector('#canvas-game-check')?.disabled);};
    await tools.waitFor();await design.waitFor();
    assert.equal(await tools.evaluate(node=>node.open),false,'fixed game tools start collapsed');
    assert.equal(await tools.locator('summary').first().innerText(),'游戏工具');
    assert.equal(await toolPage.locator('#canvas-game-design-toggle').innerText(),'游戏设计');
    await tools.locator('summary').first().click();await toolPage.locator('#canvas-game-design-toggle').click();
    await toolPage.locator('.canvas-tool-camera button').first().click();
    await select(toolSkeleton.id);await directDisabled(false);
    await openTools();
    assert.match(await tools.innerText(),/VESPERIX/,'fixed tools identify the selected source project');
    await select(toolNote.id,true);await directDisabled(true);
    await clearSelection();await directDisabled(true);assert.equal(await check.isDisabled(),true);await openDesign();
    assert(await toolPage.locator('#canvas-game-context').innerText(),'empty selection explains why the request is unavailable');
    await select(toolNote.id);await directDisabled(true);assert.equal(await check.isDisabled(),true,'ordinary content does not infer a game project');
    await select(toolSkeleton.id);await select(foreignTable.id,true);await directDisabled(true);
    assert.equal(await check.isDisabled(),true,'sources from different projects cannot share a request');
    await select(toolSkeleton.id);await select(foreignRecord.id,true);
    assert.equal(await check.isDisabled(),true,'a work record from another project cannot join the request');
    foreignTable.content.table.project_id=project.id;await toolPage.reload();await tools.waitFor();
    await select(toolSkeleton.id);await select(foreignTable.id,true);
    assert.equal(await check.isDisabled(),true,'sources with the same project id but different roots cannot share a request');
    foreignTable.content.table.root='c:\\fixture\\VESPERIX\\';await toolPage.reload();await tools.waitFor();
    await select(toolSkeleton.id);await select(foreignTable.id,true);
    assert.equal(await check.isDisabled(),false,'equivalent Windows root spelling belongs to the same project');
    ok('Canvas game actions reject empty/ordinary selection, different project ids/roots and foreign work records; equivalent roots are accepted');

    const expand=toolPage.locator('#composer-expand'),composer=toolPage.locator('.composer');
    const settleEditor=()=>toolPage.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    const inputHeight=async()=>{await settleEditor();return input.evaluate(node=>node.getBoundingClientRect().height);};
    const selection=()=>input.evaluate(node=>({start:node.selectionStart,end:node.selectionEnd,direction:node.selectionDirection}));
    const initialHeight=await inputHeight();
    assert.equal(await expand.getAttribute('type'),'button');
    assert.equal(await expand.getAttribute('aria-controls'),'input');
    assert.equal(await expand.innerText(),'展开输入');
    await input.focus();
    assert.equal(await composer.evaluate(node=>node.classList.contains('is-editing')),true,'focusing the Canvas input expands it');
    const focusedHeight=await inputHeight();
    assert(focusedHeight>initialHeight+10,`focus expands the input (${initialHeight} → ${focusedHeight})`);
    assert.equal(await expand.innerText(),'收起输入');
    assert.equal(await input.evaluate(node=>getComputedStyle(node).resize),'vertical','the input exposes a native vertical resize handle');
    await input.fill('短草稿。');const shortHeight=await inputHeight();
    const longDraft=Array.from({length:48},(_,index)=>`第 ${index+1} 行：核对路线、条件和失败后的重试边界。`).join('\n');
    await input.fill(longDraft);const longHeight=await inputHeight();
    assert(longHeight>shortHeight+10,`long content grows beyond short content (${shortHeight} → ${longHeight})`);
    const expandedGeometry=await composer.evaluate(node=>{const r=node.getBoundingClientRect();return {top:r.top,bottom:r.bottom,height:r.height,viewport:innerHeight};});
    assert(expandedGeometry.top>=-1&&expandedGeometry.bottom<=expandedGeometry.viewport+1&&expandedGeometry.height<expandedGeometry.viewport,'long input remains bounded by the viewport');
    await input.fill('可保留的草稿：选区和输入高度。');
    assert(await inputHeight()<longHeight-10,'shorter content releases the automatically allocated height');
    await input.evaluate(node=>node.setSelectionRange(2,8,'backward'));
    const selectedBeforeCollapse=await selection(),draftBeforeCollapse=await input.inputValue();
    await expand.click();
    assert.equal(await composer.evaluate(node=>node.classList.contains('is-editing')),false,'the explicit toggle collapses the input');
    assert.equal(await input.inputValue(),draftBeforeCollapse,'collapse retains every draft byte');
    assert.deepEqual(await selection(),selectedBeforeCollapse,'collapse retains the textarea selection');
    await expand.click();
    assert.equal(await composer.evaluate(node=>node.classList.contains('is-editing')),true);
    assert.equal(await input.inputValue(),draftBeforeCollapse,'expansion restores the draft');
    assert.deepEqual(await selection(),selectedBeforeCollapse,'expansion retains the textarea selection');
    await input.focus();await input.evaluate(node=>node.setSelectionRange(3,9,'backward'));
    const selectedBeforeEscape=await selection();
    await input.evaluate(node=>node.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',isComposing:true,bubbles:true})));
    assert.equal(await composer.evaluate(node=>node.classList.contains('is-editing')),true,'IME Escape does not collapse the composer');
    await input.press('Escape');
    assert.equal(await composer.evaluate(node=>node.classList.contains('is-editing')),false,'Escape from the input collapses the composer');
    assert.deepEqual(await selection(),selectedBeforeEscape,'Escape retains the textarea selection');
    assert.equal(await input.inputValue(),draftBeforeCollapse,'Escape retains the draft');
    await expand.click();await tools.locator('summary').first().focus();
    assert.equal(await composer.evaluate(node=>node.classList.contains('is-editing')),true,'ordinary blur keeps the input expanded');
    await input.fill('拖动之后继续输入。');
    const resizeBox=await input.boundingBox();
    await toolPage.mouse.move(resizeBox.x+resizeBox.width-3,resizeBox.y+resizeBox.height-3);
    await toolPage.mouse.down();await toolPage.mouse.move(resizeBox.x+resizeBox.width-3,resizeBox.y+resizeBox.height+77,{steps:8});await toolPage.mouse.up();
    const manuallyResizedHeight=await inputHeight();
    assert(manuallyResizedHeight>resizeBox.height+25,`native drag enlarges the input (${resizeBox.height} → ${manuallyResizedHeight})`);
    await input.press('End');await input.pressSequentially('保留手动高度。');
    assert(await inputHeight()>=manuallyResizedHeight-2,'typing after a native resize retains the user height');
    await input.fill('');await expand.click();
    ok('Canvas composer expands on focus, adapts to content within the viewport, preserves draft/selection through toggle and Escape, ignores IME Escape and retains native resize height');

    await select(toolSkeleton.id);await select(toolNote.id,true);
    assert.equal(await check.isDisabled(),false,'a game source plus a reference note may be checked');
    const draft='已有用户草稿：保留标点、空格与换行。  \n继续核对例外。';
    await input.fill(draft);
    const postsBeforeDraft=apiPosts.length,readsBeforeDraft=overviewRequests.length,connectionsBeforeDraft=gameConnectionReads;
    await settleCheck();
    const generated=await input.inputValue();
    assert(generated.startsWith(draft),'the existing draft bytes stay at the beginning');
    assert(generated.length>draft.length,'the explicitly requested template is appended');
    assert.match(generated,/核对现有设计/);
    assert(generated.replaceAll('\\','/').toLowerCase().includes(connection.root.replaceAll('\\','/').replace(/\/+$/,'').toLowerCase()),'draft identifies the actual project directory regardless of equivalent Windows spelling');
    assert(generated.includes(skeletonPath)&&generated.includes(skeletonSource.hash),'draft cites the selected skeleton path and hash');
    assert.match(await toolPage.locator('#form-reason').innerText(),/核对参考便签/,'reference note remains part of the selected context');
    assert.equal(await input.evaluate(node=>document.activeElement===node),true,'generated draft gets focus');
    const titleOffset=generated.indexOf('核对现有设计',draft.length);
    assert(titleOffset>=draft.length,'the new request contains a title after the original draft');
    const appendPosition=await selection();
    assert(appendPosition.start<=titleOffset&&titleOffset-appendPosition.start<12,'generated request positions the caret at the newly appended title');
    await settleEditor();
    const titleVisible=await input.evaluate((node,titleOffset)=>{
      const style=getComputedStyle(node),mirror=document.createElement('div');
      for(const key of ['font','letterSpacing','lineHeight','padding','border','boxSizing','width','tabSize'])mirror.style[key]=style[key];
      Object.assign(mirror.style,{position:'fixed',left:'-10000px',top:'0',height:'auto',whiteSpace:'pre-wrap',overflowWrap:'break-word',visibility:'hidden'});
      mirror.append(document.createTextNode(node.value.slice(0,titleOffset)));
      const marker=document.createElement('span');marker.textContent='核对现有设计';mirror.append(marker,document.createTextNode(node.value.slice(titleOffset+marker.textContent.length)));
      document.body.append(mirror);const top=marker.getBoundingClientRect().top-mirror.getBoundingClientRect().top,lineHeight=parseFloat(style.lineHeight);mirror.remove();
      return {visible:top>=node.scrollTop-2&&top+lineHeight<=node.scrollTop+node.clientHeight+2,top,scrollTop:node.scrollTop,height:node.clientHeight};
    },titleOffset);
    assert(titleVisible.visible,`the appended request title is visible instead of only its final hash: ${JSON.stringify(titleVisible)}`);
    assert.equal(apiPosts.length,postsBeforeDraft,'generating a template does not send or mutate any project');
    assert(overviewRequests.length>readsBeforeDraft&&gameConnectionReads>connectionsBeforeDraft,'template validates the current connection and source snapshot');
    assert.equal(new URLSearchParams(overviewRequests.at(-1)).get('refresh'),'true');
    await settleCheck();assert.equal(await input.inputValue(),generated,'repeated template action does not duplicate the same request');
    const repeatReads=overviewRequests.length,canonicalRoot=connection.root;
    connection.root='\\\\?\\C:\\fixture\\VESPERIX\\';await settleCheck();connection.root=canonicalRoot;
    assert.equal(overviewRequests.length,repeatReads+1,'extended Windows root spelling passes connection validation and reads the live overview');
    assert.equal(await input.inputValue(),generated,'equivalent live root does not duplicate a template');
    assert.equal(apiPosts.length,postsBeforeDraft);
    assert.equal(await toolPage.evaluate(()=>window.injected),undefined,'reference text stays literal');
    ok('game design template validates live sources, appends context without overwriting draft, focuses it, deduplicates and performs no POST');

    await select(toolSkeleton.id);
    const selectedSkeletonFrame=toolPage.locator(`.canvas-frame[data-item-id="${toolSkeleton.id}"]`);
    if(!await selectedSkeletonFrame.evaluate(frame=>frame.classList.contains('is-active')))await selectedSkeletonFrame.locator('.canvas-frame-head > button').first().click();
    const inlineSkeleton=toolPage.locator(`.canvas-frame[data-item-id="${toolSkeleton.id}"] .canvas-source-skeleton`);
    await inlineSkeleton.locator('.gs-search-input').fill('深入条件');
    await inlineSkeleton.locator('.gs-result[data-gs-node-id="condition_fixture"]').click();
    await openTools();await readSource.click();
    const skeletonSources=inlineSkeleton.locator('.canvas-source-skeleton-source-list');
    await skeletonSources.waitFor();
    const sourceEntry=await skeletonSources.locator('button').first().innerText();
    await skeletonSources.locator('button').first().click();
    await inlineSkeleton.locator('.canvas-source-skeleton-source-text').waitFor();
    const sourceNavigation=await inlineSkeleton.locator('.canvas-source-skeleton-source-view').evaluate(panel=>{
      const button=panel.querySelector('.canvas-source-skeleton-source-actions button'),r=button.getBoundingClientRect(),box=panel.getBoundingClientRect();
      return {modal:panel.tagName==='DIALOG'&&panel.open,within:box.top>=0&&box.bottom<=innerHeight&&box.left>=0&&box.right<=innerWidth,clickable:button.contains(document.elementFromPoint(r.left+r.width/2,r.top+r.height/2))};
    });
    assert.deepEqual(sourceNavigation,{modal:true,within:true,clickable:true},'source return stays accessible above the Canvas when the composer is expanded');
    await inlineSkeleton.getByRole('button',{name:/返回来源列表/}).click();
    await skeletonSources.waitFor();
    assert.equal(await skeletonSources.locator('button').first().innerText(),sourceEntry,'document navigation returns to the same source list');
    assert.equal(await skeletonSources.locator('button').first().evaluate(node=>document.activeElement===node),true,'returning to the source list restores its document focus');
    await inlineSkeleton.getByRole('button',{name:'返回游戏骨架',exact:true}).click();
    assert.equal(await inlineSkeleton.locator('.canvas-source-skeleton-source-view').count(),0,'the labelled skeleton return closes the source panel');
    assert.equal(await inlineSkeleton.locator('.gs-detail-title').innerText(),'深入条件','closing the source retains the selected skeleton node');
    await openTools();await readSource.click();await skeletonSources.waitFor();
    await skeletonSources.locator('button').first().click();await inlineSkeleton.locator('.canvas-source-skeleton-source-text').waitFor();
    await toolPage.keyboard.press('Escape');
    assert.equal(await inlineSkeleton.locator('.canvas-source-skeleton-source-view').count(),0,'Escape closes a document source directly back to the skeleton');
    await openTools();await readSource.click();await skeletonSources.waitFor();await toolPage.keyboard.press('Escape');
    assert.equal(await inlineSkeleton.locator('.canvas-source-skeleton-source-view').count(),0,'Escape also closes the source list');
    ok('skeleton sources support list → document → list with restored focus, labelled return to the selected skeleton and Escape from document or list');
    const preserved='来源变化时保留这份草稿。';await input.fill(preserved);
    const stableSkeletonHash=skeletonSource.hash;
    skeletonSource.hash=H('6');await settleCheck();assert.equal(await input.inputValue(),preserved,'stale skeleton does not append a misleading request');
    assert(await toolPage.locator('#canvas-game-context').innerText(),'stale source has a visible explanation');
    skeletonSource.hash=stableSkeletonHash;
    const docHash=trackedSource.hash;trackedSource.hash=H('7');
    await settleCheck();assert.equal(await input.inputValue(),preserved,'changed node reference document refuses the request');trackedSource.hash=docHash;
    const provenanceDocHash=provenanceOnlyDocument.hash;provenanceOnlyDocument.hash=H('4');
    await settleCheck();assert.equal(await input.inputValue(),preserved,'a changed provenance-only node document refuses the request');provenanceOnlyDocument.hash=provenanceDocHash;
    const rootBefore=connection.root;connection.root='C:/fixture/ReconnectedGame';
    await settleCheck();assert.equal(await input.inputValue(),preserved,'a reconnected project does not reuse an old source root');connection.root=rootBefore;
    const currentModel=overview.skeleton;overview.skeleton=undefined;
    await settleCheck();assert.equal(await input.inputValue(),preserved,'a missing skeleton refuses the request');overview.skeleton=currentModel;
    let releaseOverview,notifyOverviewStarted;
    const heldRead=new Promise(resolve=>{notifyOverviewStarted=resolve;});
    holdGameOverview=()=>new Promise(resolve=>{releaseOverview=resolve;notifyOverviewStarted();});
    await openDesign();await check.click();await heldRead;
    await input.fill('请求期间新输入的草稿');
    releaseOverview();await toolPage.waitForFunction(()=>!document.querySelector('#canvas-game-check')?.disabled);
    assert.equal(await input.inputValue(),'请求期间新输入的草稿','a completed stale async check cannot overwrite newer input');
    const heldSelectionRead=new Promise(resolve=>{notifyOverviewStarted=resolve;});
    holdGameOverview=()=>new Promise(resolve=>{releaseOverview=resolve;notifyOverviewStarted();});
    await openDesign();await check.click();await heldSelectionRead;
    await select(toolTable.id);
    const tableDraft='切换选区后的循环表草稿';await input.fill(tableDraft);
    const selectionReadDone=toolPage.waitForResponse(response=>new URL(response.url()).pathname.endsWith('/game/overview'));
    releaseOverview();await selectionReadDone;await toolPage.waitForFunction(()=>!document.querySelector('#canvas-game-check')?.disabled);
    assert.equal(await input.inputValue(),tableDraft,'a completed check cannot append a template for the previously selected source');
    assert.equal(apiPosts.length,postsBeforeDraft);
    ok('stale/missing skeleton, changed source/provenance-only documents, reconnected root and in-flight input/selection changes preserve the draft without writes');

    // A removed node changes the discussion route; refreshing must migrate the current draft.
    await select(toolSkeleton.id);
    const refreshedSkeletonFrame=toolPage.locator(`.canvas-frame[data-item-id="${toolSkeleton.id}"]`);
    if(!await refreshedSkeletonFrame.evaluate(frame=>frame.classList.contains('is-active')))await refreshedSkeletonFrame.locator('.canvas-frame-head > button').first().click();
    await inlineSkeleton.locator('.gs-search-input').fill('深入条件');
    await inlineSkeleton.locator('.gs-result[data-gs-node-id="condition_fixture"]').click();
    const removedNodeDraft='节点移除后仍须保留这份设计核对草稿。  \n待确认例外。';await input.fill(removedNodeDraft);
    const nodesBeforeRemoval=syntheticSkeleton.nodes,relationsBeforeRemoval=syntheticSkeleton.relations,hashBeforeRemoval=skeletonSource.hash;
    syntheticSkeleton.nodes=syntheticSkeleton.nodes.filter(node=>node.id!=='condition_fixture');
    syntheticSkeleton.relations=syntheticSkeleton.relations.filter(relation=>relation.from!=='condition_fixture'&&relation.to!=='condition_fixture');
    skeletonSource.hash=H('2');
    const otherRootDraft='另一个窗口已保存的根选区草稿。  \n两份文字都要保留。';
    const nextSourceRevision=board.canvas.objects.find(object=>object.id===toolSkeleton.id).content_revision+1;
    await toolPage.evaluate(({objectId,revision,text,currentText})=>{
      const key='spellcast.reply-drafts.v1',records=JSON.parse(localStorage.getItem(key)||'[]');
      const existing=records.find(record=>record.object_id===objectId&&record.channel==='composer'&&record.text===currentText);
      if(!existing)throw new Error('Missing current node draft for concurrent root draft fixture');
      const anchors=existing.anchors.map(({block_id:_node,annotations:_annotations,...anchor})=>({...anchor,content_revision:revision}));
      records.push({...existing,anchors,expected_revision:revision,text,updated_at:Date.now()+1});
      localStorage.setItem(key,JSON.stringify(records));
    },{objectId:toolSkeleton.id,revision:nextSourceRevision,text:otherRootDraft,currentText:removedNodeDraft});
    toolPage.once('dialog',dialog=>dialog.accept());await openTools();await refresh.click();
    await toolPage.waitForFunction(()=>document.querySelector('.canvas-source-skeleton-detail .gs-detail-title')?.textContent?.includes('游戏全貌'));
    const carriedDraft=await input.inputValue();
    assert(carriedDraft.includes(removedNodeDraft)&&carriedDraft.includes(otherRootDraft),'source refresh preserves both the removed-node draft and the newer persisted root draft byte for byte');
    assert.doesNotMatch(await toolPage.locator('#form-reason').innerText(),/深入条件/,'composer context stops referring to the removed node');
    await settleCheck();const migratedDraft=await input.inputValue();
    assert(migratedDraft.includes(removedNodeDraft)&&migratedDraft.includes(otherRootDraft)&&migratedDraft.includes(H('2')),'a new request uses the refreshed root context and retains both migrated drafts');
    await select(toolNote.id);await select(toolSkeleton.id);
    assert.equal(await input.inputValue(),migratedDraft,'leaving and returning to the refreshed root recovers the migrated draft');
    syntheticSkeleton.nodes=nodesBeforeRemoval;syntheticSkeleton.relations=relationsBeforeRemoval;skeletonSource.hash=hashBeforeRemoval;
    ok('refreshing away a selected skeleton node updates composer anchors, preserves both local and newer stored drafts, allows a current request and recovers the migrated root draft');

    // Table sources use the same project validation and their own inline document reader.
    await select(toolTable.id);await directDisabled(false);
    gameReadFault='document';await openTools();await readSource.click();
    await toolPage.waitForFunction(()=>{const status=document.querySelector('.canvas-source-table-source-status');return status?.textContent&&!/读取中|正在读取/.test(status.textContent);});
    assert.equal(await toolPage.locator('.canvas-source-table-source-text').count(),0,'failed table source read never displays unverified text');
    assert(await toolPage.locator('.canvas-source-table-source-status').innerText(),'table source failure is visible');
    assert.equal(await input.inputValue(),tableDraft);
    await toolPage.locator('.canvas-source-table-source-head').getByRole('button',{name:'返回玩法循环',exact:true}).click();
    gameReadFault='';await openTools();await readSource.click();await toolPage.locator('.canvas-source-table-source-text').waitFor();
    assert.match(await toolPage.locator('.canvas-source-table-source-text').innerText(),/全景骨架/);
    await toolPage.locator('.canvas-source-table-source-head').getByRole('button',{name:'返回玩法循环',exact:true}).click();
    assert.equal(await toolPage.locator('.canvas-source-table-source-view').count(),0,'the labelled loop return closes the table source');
    await openTools();await readSource.click();await toolPage.locator('.canvas-source-table-source-text').waitFor();await toolPage.keyboard.press('Escape');
    assert.equal(await toolPage.locator('.canvas-source-table-source-view').count(),0,'Escape closes the table source and restores its loop card');
    assert.equal(await input.inputValue(),tableDraft,'table source navigation retains the composer draft');
    const tableBefore=structuredClone(board.canvas.objects.find(object=>object.id===toolTable.id));
    const tablePlacementBefore=structuredClone(board.canvas.items.find(item=>item.item_id===toolTable.id));
    board.canvas.annotations.push({id:'game-tools-table-note',revision:1,anchor:{object_id:toolTable.id,content_revision:tableBefore.content_revision},snapshot:structuredClone(tableBefore.content),text:'保留旧版批注',removed:false});
    const loopHashBefore=loop.source.hash,loopDocument=documents.find(document=>document.path===loop.source.path),loopDocumentHashBefore=loopDocument.hash;
    loop.source.hash=H('5');loopDocument.hash=loop.source.hash;
    const otherTableDraft='另一个窗口已保存的新循环版本草稿。';
    await toolPage.evaluate(({objectId,revision,text,currentText})=>{
      const key='spellcast.reply-drafts.v1',records=JSON.parse(localStorage.getItem(key)||'[]');
      const existing=records.find(record=>record.object_id===objectId&&record.channel==='composer'&&record.text===currentText);
      if(!existing)throw new Error('Missing current table draft for same-route refresh fixture');
      records.push({...existing,anchors:existing.anchors.map(anchor=>({...anchor,content_revision:revision})),expected_revision:revision,text,updated_at:Date.now()+1});
      localStorage.setItem(key,JSON.stringify(records));
    },{objectId:toolTable.id,revision:tableBefore.content_revision+1,text:otherTableDraft,currentText:tableDraft});
    toolPage.once('dialog',dialog=>dialog.accept());await openTools();await refresh.click();
    await toolPage.waitForFunction(()=>document.querySelector('.canvas-source-table')?.textContent?.includes('sha 55555555'));
    const refreshedTable=board.canvas.objects.find(object=>object.id===toolTable.id);
    assert.equal(board.canvas.objects.filter(object=>object.id===toolTable.id).length,1,'fixed refresh keeps source identity');
    assert.equal(refreshedTable.content_revision,tableBefore.content_revision+1);
    assert.deepEqual(board.canvas.items.find(item=>item.item_id===toolTable.id),tablePlacementBefore,'fixed refresh preserves source placement');
    assert.equal(board.canvas.annotations.find(annotation=>annotation.id==='game-tools-table-note').anchor.content_revision,tableBefore.content_revision,'fixed refresh preserves old annotation revision');
    const finalTableDraft=await input.inputValue();
    assert(finalTableDraft.includes(tableDraft)&&finalTableDraft.includes(otherTableDraft),'same-route refresh preserves current input and the newer stored version draft');
    loop.source.hash=loopHashBefore;loopDocument.hash=loopDocumentHashBefore;
    ok('fixed table source reader reports errors and retries; refresh preserves identity, placement, annotations and composer draft');

    // Explicit expanded/collapsed preferences and the ordinary reply draft survive reload.
    await openTools();assert.equal(await tools.evaluate(node=>node.open),true);
    await toolPage.reload();await tools.waitFor();
    assert.equal(await tools.evaluate(node=>node.open),true,'expanded fixed game tools persist');
    await select(toolTable.id);
    assert.equal(await input.inputValue(),finalTableDraft,'template dispatch uses the existing persisted composer draft');
    await openTools();
    await tools.locator('summary').first().click();
    await toolPage.waitForFunction(()=>localStorage.getItem('spellcast.canvas.game-tools.open')==='false');
    await toolPage.reload();await tools.waitFor();
    assert.equal(await tools.evaluate(node=>node.open),false,'collapsed fixed game tools persist');
    await select(toolTable.id);
    await tools.locator('summary').first().click();
    if(!await design.evaluate(node=>node.open))await toolPage.locator('#canvas-game-design-toggle').click();
    for(const [theme,width,height] of [['dark',1600,900],['light',880,640],['dark',480,800],['dark',880,380],['light',480,380],['dark',900,320]]){
      await toolPage.evaluate(theme=>{localStorage.setItem('spellcast.theme',theme);document.body.dataset.theme=theme;document.dispatchEvent(new CustomEvent('spellcast-theme-change',{detail:theme}));},theme);
      await toolPage.setViewportSize({width,height});
      const geometry=await toolPage.evaluate(()=>{const within=node=>{const r=node.getBoundingClientRect();return r.left>=-1&&r.right<=innerWidth+1;};return {tools:within(document.querySelector('#canvas-game-tools')),design:within(document.querySelector('#canvas-game-design')),page:document.documentElement.scrollWidth<=innerWidth+1};});
      assert.deepEqual(geometry,{tools:true,design:true,page:true},`Canvas game tools remain contained at ${theme} ${width}x${height}`);
      await input.fill(longDraft);await settleEditor();
      const composerGeometry=await composer.evaluate(node=>{const r=node.getBoundingClientRect(),input=node.querySelector('#input').getBoundingClientRect(),toggle=node.querySelector('#composer-expand').getBoundingClientRect();return {composer:r.left>=-1&&r.right<=innerWidth+1&&r.top>=-1&&r.bottom<=innerHeight+1,input:input.top>=r.top-1&&input.bottom<=r.bottom+1,toggle:toggle.top>=r.top-1&&toggle.bottom<=r.bottom+1,page:document.documentElement.scrollWidth<=innerWidth+1};});
      assert.deepEqual(composerGeometry,{composer:true,input:true,toggle:true,page:true},`expanded Canvas input remains accessible at ${theme} ${width}x${height}`);
      await openDesign();await settleEditor();
      const menuGeometry=await toolPage.locator('.composer-game-design-panel').evaluate(node=>{const r=node.getBoundingClientRect();return {left:r.left>=-1,right:r.right<=innerWidth+1,top:r.top>=-1,bottom:r.bottom<=innerHeight+1};});
      assert.deepEqual(menuGeometry,{left:true,right:true,top:true,bottom:true},`design menu remains accessible beside the expanded input at ${theme} ${width}x${height}`);
      await shot(toolPage,`canvas-game-tools-${theme}-${width}`);
    }
    ok('Canvas game tools remember expansion, preserve persisted draft and fit dark/light/narrow layouts');
  }finally{
    gameReadFault='';holdGameOverview=undefined;
    await toolContext?.close();board.canvas=savedToolCanvas;
  }

  if(process.env.SPELLCAST_SKELETON_FIXTURE){
    const bytes=await readFile(process.env.SPELLCAST_SKELETON_FIXTURE);
    const parsed=JSON.parse(bytes.toString('utf8'));
    const model=parsed.model||parsed;
    assert.equal(model.schema_version,1);
    addModelSources(model);
    // Real-model visuals assume matching current snapshots; the separate drift fixture above checks changed versions.
    for(const node of model.nodes)for(const evidence of node.provenance||[])if(!evidence.archived){const doc=documents.find(item=>item.path===evidence.path);if(doc)doc.hash=evidence.hash;}
    overview.skeleton={source:{path:skeletonPath,hash:createHash('sha256').update(bytes).digest('hex')},model};
    const byId=new Map(model.nodes.map(node=>[node.id,node]));
    const paths=model.nodes.map(node=>{const chain=[],seen=new Set();let cursor=node;
      while(cursor&&!seen.has(cursor.id)){chain.unshift(cursor);seen.add(cursor.id);cursor=byId.get(cursor.parent_id);}
      return chain;}).filter(chain=>chain[0]?.kind==='system'&&!chain[0].parent_id);
    const branch=paths.find(chain=>['system','region','structure','rule'].every((kind,index)=>chain[index]?.kind===kind))
      ||paths.sort((left,right)=>right.length-left.length)[0];
    assert(branch?.length,'real model has a navigable system branch');
    for(const [theme,width,height] of [['dark',1600,900],['light',1600,900],['dark',880,640],['light',880,640]]){
      const actual=await openPage(theme,width,height);
      const actualHome=actual.page.locator('[data-game-home]');
      assert.equal(await actualHome.locator('[data-game-skeleton="map"] .gs-system-card').count(),model.nodes.filter(node=>node.kind==='system'&&!node.parent_id).length);
      assert.equal(await actualHome.locator('.gs-stage').count(),model.loop.length);
      assert.equal(await actualHome.locator('.gs-system-card').first().isVisible(),true);
      assert.equal(await actualHome.locator('dialog[open]').count(),0);
      await shot(actual.page,`skeleton-real-root-${theme}-${width}`);
      await noOverflow(actual.page,`optional local skeleton root ${theme} ${width}x${height}`);
      await actualHome.locator(`.gs-system-card[data-gs-node-id="${branch[0].id}"]`).click();
      for(const node of branch.slice(1))await actualHome.locator(`.gs-branch-card[data-gs-node-id="${node.id}"]`).click();
      assert.equal(await actualHome.locator('.gs-detail-title').innerText(),branch.at(-1).title);
      assert.equal(await actualHome.locator('.gs-detail-title').isVisible(),true);
      assert.equal(await actualHome.locator('dialog[open]').count(),0,'node selection does not open the reader');
      await shot(actual.page,`skeleton-real-branch-${theme}-${width}`);
      await noOverflow(actual.page,`optional local skeleton branch ${theme} ${width}x${height}`);
      const absorbed = model.nodes.filter(node=>node.rule && Object.values(node.rule).some(values=>values?.length))
        .sort((a,b)=>Object.keys(b.rule).length-Object.keys(a.rule).length)[0];
      if(absorbed){
        await actualHome.locator('.gs-search-input').fill(absorbed.title);
        await actualHome.locator(`.gs-result[data-gs-node-id="${absorbed.id}"]`).click();
        assert.equal(await actualHome.locator('.gs-detail-title').innerText(),absorbed.title);
        for(const [field,values] of Object.entries(absorbed.rule))if(values.length)assert.match(await actualHome.locator(`[data-gs-rule="${field}"]`).innerText(),new RegExp(values[0].replace(/[.*+?^${}()|[\]\\]/g,'\\$&')));
        assert.equal(await actualHome.locator('dialog[open]').count(),0,'actual absorbed content is displayed directly in its node');
        await shot(actual.page,`skeleton-real-rule-${theme}-${width}`);
        await noOverflow(actual.page,`actual absorbed rule ${theme} ${width}x${height}`);
      }
      await actual.context.close();
    }
    ok('optional local Skeleton.json: root and selected branch render across desktop/small and both themes without opening the reader');
  }

  // Unknown routes (including the retired /game/zones listing and /game/actions requests) count as unexpected.
  assert.deepEqual(pageErrors,[]);assert.deepEqual(unexpected,[]);
  assert.equal(forbidden,0,'every repository, goal, proposal and decision request carried the private window credential');
  report.passed=true;report.reads={overview:overviewRequests,view:viewRequests,goalPosts};report.decisions=decisions.map(d=>({decision:d.decision,items:d.item_ids,confirm:d.confirm,unlock:d.unlock,revised:!!d.revised_object}));
  await writeFile(path.join(out,'browser-fixture-report.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify({passed:true,checks:report.checks.length,screenshots:report.screenshots.length,report:'artifacts/game-ai-workspace/browser-fixture-report.json'}));
}catch(error){report.passed=false;report.error=String(error?.stack||error);report.pageErrors=pageErrors;report.unexpected=unexpected;await writeFile(path.join(out,'browser-fixture-report.json'),JSON.stringify(report,null,2)).catch(()=>{});console.error(JSON.stringify({pageErrors,unexpected,vite:viteOutput.slice(-1500)}));throw error;}
finally{await browser?.close();vite.kill();}

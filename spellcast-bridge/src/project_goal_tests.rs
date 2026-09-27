//! Isolated repository and database fixtures for the AI-first game workspace: projection,
//! goals, delivery, Agent proposals and user adoption. Only the host-verification boundary is
//! simulated (a pre-verified binding); no Codex task, pipe or real repository is touched.
use super::*;
use crate::{
    game_config, project_game::ConnectGame, project_records::RecordCommand, project_workspace::{ProjectAgentMutation, ProjectQuery}, Headless,
};
use serde_json::json;
use std::{fs, path::PathBuf, sync::{Arc, Barrier}};

fn write(root: &std::path::Path, relative: &str, value: Value) {
    let path = root.join(relative);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, serde_json::to_vec_pretty(&value).unwrap()).unwrap();
}
fn text(root: &std::path::Path, relative: &str, value: &str) {
    let path = root.join(relative);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, value).unwrap();
}

/// A small repository shaped like VESPERIX: world → region → dungeon → zone → locations.
fn repository() -> (PathBuf, PathBuf) {
    let directory = std::env::temp_dir().join(format!("spellcast-game-home-{}", uuid::Uuid::new_v4()));
    let root = directory.join("game");
    let c = game_config::CONFIG_ROOT;
    text(&root, "ProjectSettings/ProjectVersion.txt", "m_EditorVersion: fixture");
    write(&root, &format!("{c}/Zones/region_fixture/zone_fixture.json"), json!({"DungeonId":"dungeon_fixture","ZoneId":"zone_fixture","DisplayName":"外围林地",
        "EntrySubLocationId":"location_a","SubLocationRefs":[{"SubLocationId":"location_a"},{"SubLocationId":"location_b"},{"SubLocationId":"location_c"}],
        "SubLocationRoutes":[{"FromSubLocationId":"location_a","ToSubLocationId":"location_b"},{"FromSubLocationId":"location_b","ToSubLocationId":"location_c"}]}));
    write(&root, &format!("{c}/Zones/region_fixture/zone_plain.json"), json!({"DungeonId":"dungeon_fixture","ZoneId":"zone_plain","DisplayName":"未声明路线","SubLocationRefs":[]}));
    write(&root, &format!("{c}/SubLocations/location_a.json"), json!({"SubLocationId":"location_a","DisplayName":"古树根部","FirstEntryContent":{"ContentId":"content_battle"},
        "ContentPoolIds":["content_battle","content_treasure"],"ContentPoolWeights":{"content_battle":40,"content_treasure":10},
        "LootPoints":[{"PointId":"herb","DisplayName":"草药点","LootableType":"HerbGatheringPoint","LootTableId":"loot_herb"}]}));
    write(&root, &format!("{c}/SubLocations/location_b.json"), json!({"SubLocationId":"location_b","DisplayName":"灵泉","IsRestPoint":true,"RestContentId":"content_rest",
        "IsShop":true,"ShopConfigId":"shop_fixture","UnlockCost":30}));
    write(&root, &format!("{c}/SubLocations/location_c.json"), json!({"SubLocationId":"location_c","DisplayName":"迷雾出口","IsBossGate":true,"UnlocksZoneId":"zone_next","BossGateContentId":"content_gate"}));
    write(&root, &format!("{c}/Contents/Battle/content_battle.json"), json!({"ContentId":"content_battle","DisplayName":"变异狐","Type":"Battle","AssociatedDataId":"battle_fixture"}));
    write(&root, &format!("{c}/Contents/Treasure/content_treasure.json"), json!({"ContentId":"content_treasure","DisplayName":"埋藏的遗物","Type":"Treasure","AssociatedDataId":"treasure_fixture"}));
    write(&root, &format!("{c}/Contents/Rest/content_rest.json"), json!({"ContentId":"content_rest","DisplayName":"灵泉休息","Type":"Rest","AssociatedDataId":"rest_fixture"}));
    write(&root, &format!("{c}/Contents/Battle/content_gate.json"), json!({"ContentId":"content_gate","DisplayName":"守门树人","Type":"BossGate","AssociatedDataId":"battle_gate"}));
    write(&root, &format!("{c}/Battles/battle_fixture.json"), json!({"BattleId":"battle_fixture","DisplayName":"狐影","Enemies":[{"TemplateId":"pet_fox","Level":2}],"LootTableId":"loot_battle"}));
    write(&root, &format!("{c}/Battles/battle_gate.json"), json!({"BattleId":"battle_gate","DisplayName":"树人","Enemies":[{"TemplateId":"pet_guardian","Level":4}],"LootTableId":"loot_battle"}));
    write(&root, &format!("{c}/Treasures/treasure_fixture.json"), json!({"TreasureId":"treasure_fixture","DisplayName":"铁盒","LootTableId":"loot_chest"}));
    write(&root, &format!("{c}/Rest/rest_fixture.json"), json!({"RestId":"rest_fixture","DisplayName":"休息"}));
    write(&root, &format!("{c}/Shop/shop_fixture.json"), json!({"ShopId":"shop_fixture","DisplayName":"行商"}));
    for (id, name) in [("loot_herb", "草药点掉落"), ("loot_battle", "战斗掉落"), ("loot_chest", "宝箱")] {
        write(&root, &format!("{c}/LootTables/{id}.json"), json!({"Id":id,"Name":name,"Category":"Fixture","Entries":[]}));
    }
    write(&root, &format!("{c}/Dungeons/region_fixture/dungeon_fixture.json"), json!({"Id":"dungeon_fixture","Name":"神祠","RegionId":"region_fixture",
        "ZoneIds":["zone_fixture","zone_plain","zone_unconfigured"],"HiddenZoneIds":["zone_unconfigured"]}));
    write(&root, "Assets/Resources/Configs/Worlds/world.json", json!({"id":"world_fixture","name":"山海世界","startingRegionId":"region_fixture","regions":[{"id":"region_fixture"}]}));
    write(&root, "Assets/Resources/Configs/Regions/region_fixture.json", json!({"Id":"region_fixture","Name":"永生林","MainQuestId":"quest_missing","ConnectedRegionIds":[]}));
    write(&root, "Assets/Resources/Configs/Missions/region_fixture/chain.json", json!([
        {"id":"quest_one","name":"初入迷林","dungeonId":"dungeon_fixture","objectives":[{"id":"o1","name":"击败狐","type":"Combat","requiredEnemyId":"pet_fox","requiredAmount":3}]},
        {"id":"quest_elsewhere","name":"别处","dungeonId":"dungeon_other","objectives":[{"id":"o2","requiredEnemyId":"pet_none"}]}]));
    text(&root, "Assets/Documents/Atlas/domains/cycle.md", "# domain: cycle\n## 核心循环架构\n### 四层循环\n\n| 层级 | 时长 | 循环内容 |\n|------|------|----------|\n| **短期** | 5-10 分钟 | 进入地牢 → 战斗 → 获得资源 |\n| **中期** | 1-2 小时 | 多次探索 → 突破 |\n\n### 节奏规划\n");
    text(&root, "Assets/Documents/Content/Regions/Fixture/ZoneDesign.md", "# 神祠 - Zone设计\n## Zone 1: 外围林地\n```json\n{\"SubLocationId\": \"location_a\"}\n```\nzone_fixture 是第一次进入的教学区域。\n### 地点\n- location_a：入口的首次战斗 content_battle。\n");
    text(&root, "Assets/Scripts/Fixture/ZoneRules.cs", "class ZoneRules {\n    public List<SubLocationRoute> SubLocationRoutes;\n    string LootTableId;\n}\n");
    (root, directory.join("state.sqlite3"))
}

fn open(db: &PathBuf, root: &std::path::Path) -> (Bridge, String) {
    let bridge = Bridge::open(Headless, 0, db).unwrap();
    let project = uuid::Uuid::new_v4().to_string();
    bridge.project_user_mutate(serde_json::from_value(json!({"request_id":"create","project_id":project,"op":"create_project","name":"VESPERIX fixture","aliases":[root.to_string_lossy()]})).unwrap()).unwrap();
    bridge.connect_game(&project, ConnectGame { request_id: "connect".into(), expected_revision: 0, root: root.to_string_lossy().into_owned() }).unwrap();
    (bridge, project)
}

fn bind(bridge: &Bridge, root: &std::path::Path) -> (String, String) {
    let thread = uuid::Uuid::new_v4().to_string();
    let source = format!("codex:{thread}");
    // Simulates ONLY an already verified binding; no delivery worker or real task starts.
    bridge.update(|state| {
        state.bindings.push(crate::codex::CodexBinding { source_id: source.clone(), thread_id: thread.clone(), cwd: game_config::display_path(root),
            label: "VESPERIX 主线".into(), executable: "fixture".into(), protocol_agent: "fixture".into(), bound_at_ms: now_ms() });
        Ok(())
    }).unwrap();
    (source, thread)
}

fn approved_access(bridge: &Bridge, project: &str, source: &str, thread: &str, root: &std::path::Path) -> String {
    let access = bridge.create_project_access(project, crate::codex::CodexBinding { source_id: source.into(), thread_id: thread.into(),
        cwd: game_config::display_path(root), label: "document answer".into(), executable: "fixture".into(),
        protocol_agent: "fixture".into(), bound_at_ms: now_ms() }).unwrap();
    bridge.project_decide_access(project, access["access"]["id"].as_str().unwrap(), 1, "approved").unwrap();
    access["access_token"].as_str().unwrap().into()
}

fn document_answer(project: &str, goal_id: &str, id: &str, uri: &str, hash: &str) -> RecordCommand {
    serde_json::from_value(json!({"request_id": uuid::Uuid::new_v4().to_string(), "project_id": project, "op": "put_record",
        "id": id, "expected_revision": 0, "fields": {"title": "选段答复", "goal": "引用的原文", "scope": "spellcast.document-review.v1",
        "status": "active", "result": "逐段回答，引用第 2 行。", "boundaries": "仅审阅所引版本。", "next_step": "",
        "references": [{"label": "设计文档", "uri": format!("{uri}#L2-L2@4-12"), "version": hash},
            {"label": "question", "uri": format!("spellcast://project/{project}/goal/{goal_id}"), "version": ""}]}})).unwrap()
}

#[test]
fn overview_and_zone_relations_come_from_sources_with_hashes() {
    let (root, db) = repository();
    let (bridge, project) = open(&db, &root);
    let overview = bridge.game_overview(&project, false).unwrap();
    assert_eq!(overview["world"]["name"], "山海世界");
    assert_eq!(overview["loop"]["columns"], json!(["层级", "时长", "循环内容"]));
    assert_eq!(overview["loop"]["rows"][0][0], "短期");
    assert_eq!(overview["loop"]["source"]["path"], crate::game_projection::LOOP_SOURCE);
    assert_eq!(overview["loop"]["source"]["hash"].as_str().unwrap().len(), 64);
    assert_eq!(overview["routed_zones"].as_array().unwrap().len(), 1, "only zones with declared routes are explorable");
    assert_eq!(overview["routed_zones"][0]["dungeon_id"], "dungeon_fixture");
    let zones = &overview["regions"][0]["dungeons"][0]["zones"];
    assert_eq!(zones.as_array().unwrap().len(), 3);
    assert_eq!(zones[2]["configured"], false, "a dungeon zone without configuration stays visible as missing");
    assert_eq!(overview["regions"][0]["main_quest_found"], false);
    assert!(overview["issues"].as_array().unwrap().iter().any(|issue| issue["message"].as_str().unwrap().contains("quest_missing")));
    assert_eq!(overview["runtime_verified"], false);
    let view = bridge.game_view(&project, Some("zone_fixture"), false).unwrap();
    let location = &view["view"]["locations"][0];
    assert_eq!(location["loot_points"][0]["loot_table_name"], "草药点掉落");
    assert_eq!(location["candidates"][0]["loot_table_name"], "战斗掉落");
    assert_eq!(location["candidates"][0]["enemy_ids"], json!(["pet_fox"]));
    let treasure = location["candidates"].as_array().unwrap().iter().find(|candidate| candidate["id"] == "content_treasure").unwrap();
    assert_eq!(treasure["loot_table_name"], "宝箱");
    let rest = &view["view"]["locations"][1];
    assert_eq!(rest["rest"], true);
    assert_eq!(rest["unlock_cost"], 30);
    assert!(rest["candidates"].as_array().unwrap().iter().any(|candidate| candidate["kind"] == "Rest"));
    let relations = &view["relations"];
    assert_eq!(relations["region"]["name"], "永生林");
    assert_eq!(relations["dungeon"]["name"], "神祠");
    let missions = relations["missions"].as_array().unwrap();
    assert_eq!(missions.len(), 1);
    assert_eq!(missions[0]["objectives"][0]["at"][0]["location_id"], "location_a");
    assert!(missions[0]["basis"].as_array().unwrap().iter().any(|basis| basis["kind"] == "enemy"));
    assert_eq!(relations["design"]["zone_fixture"][0]["heading"], "Zone 1: 外围林地");
    // Prose that states intent ranks before a literal example inside a code fence.
    assert_eq!(relations["design"]["location_a"][0]["line"], 8);
    assert_eq!(relations["design"]["location_a"][1]["line"], 4);
    assert_eq!(relations["code"]["SubLocationRoutes"][0]["line"], 2);
    // Edits are seen by the next read; the projection revision moves with its sources.
    let before = overview["source_revision"].clone();
    text(&root, "Assets/Documents/Atlas/domains/cycle.md", "# domain: cycle\n### 四层循环\n\n| 层级 | 时长 | 循环内容 |\n|---|---|---|\n| 短期 | 10 分钟 | 改过 |\n");
    let after = bridge.game_overview(&project, true).unwrap();
    assert_ne!(after["source_revision"], before);
    assert_eq!(after["loop"]["rows"][0][2], "改过");
    drop(bridge);
    let _ = fs::remove_dir_all(root.parent().unwrap());
}

#[test]
fn goals_stay_unsent_without_a_bound_task_and_never_guess_one() {
    let (root, db) = repository();
    let (bridge, project) = open(&db, &root);
    let id = uuid::Uuid::new_v4().to_string();
    let goal = bridge.create_project_goal(&project, CreateGoal { id: id.clone(), text: "整理外围林地的首次探索体验".into(),
        context: GoalContext { scale: "experience".into(), zone_id: "zone_fixture".into(), label: "外围林地".into(), ..Default::default() } }).unwrap();
    assert_eq!(goal.goal.status, "unsent");
    assert!(goal.delivery.is_none());
    let denied = bridge.send_project_goal(&project, &id, SendGoal { source_id: "codex:guess".into(), thread_id: uuid::Uuid::new_v4().to_string() }).unwrap_err();
    assert!(denied.to_string().contains("未发送"), "{denied}");
    assert_eq!(bridge.project_goals(&project).unwrap()[0].goal.status, "unsent");
    assert!(bridge.feedback_state(None).deliveries.is_empty(), "no delivery exists without an explicit bound target");
    // Idempotent creation; a reused id with different words is refused.
    assert_eq!(bridge.create_project_goal(&project, CreateGoal { id: id.clone(), text: "整理外围林地的首次探索体验".into(),
        context: GoalContext { scale: "experience".into(), zone_id: "zone_fixture".into(), label: "外围林地".into(), ..Default::default() } }).unwrap().goal.revision, 1);
    assert!(bridge.create_project_goal(&project, CreateGoal { id, text: "别的内容".into(), context: GoalContext::default() }).is_err());
    drop(bridge);
    let _ = fs::remove_dir_all(root.parent().unwrap());
}

#[test]
fn document_question_guidance_and_exact_agent_answer_receipt() {
    let (root, db) = repository();
    let (bridge, project) = open(&db, &root);
    let (source, thread) = bind(&bridge, &root);
    let token = approved_access(&bridge, &project, &source, &thread, &root);
    let path = "Assets/Documents/Atlas/domains/cycle.md";
    let source_hash = "a".repeat(64);
    let uri = document_reference_uri(&bridge.game_connection(&project).unwrap().unwrap().root, path);
    let create = |id: String| CreateGoal { id, text: format!("请解释这段循环设计。\n原文：短期循环\n来源：{uri}#L2-L2@4-12\nSHA-256：{source_hash}\n只回答，不修改文档。"),
        context: GoalContext { entity_kind: "document_question".into(), entity_id: path.into(), label: "循环架构".into(),
            sources: vec![GoalSource { path: path.into(), hash: source_hash.clone() }], ..Default::default() } };
    let goal_id = uuid::Uuid::new_v4().to_string();
    bridge.create_project_goal(&project, create(goal_id.clone())).unwrap();
    let sent = bridge.send_project_goal(&project, &goal_id, SendGoal { source_id: source.clone(), thread_id: thread.clone() }).unwrap();
    assert_eq!(sent.goal.status, "sent");
    assert_eq!(sent.delivery.as_ref().unwrap().phase, DeliveryPhase::Waiting);
    let receipt = bridge.feedback_state(Some(&source)).deliveries.into_iter().find(|receipt| receipt.event.seq == sent.goal.sequence.unwrap()).unwrap();
    assert_eq!(receipt.event.project_context.as_ref().unwrap()["kind"], "document_question");
    let read = bridge.read_feedback_request(&source, sent.goal.sequence.unwrap()).unwrap();
    let handling = read["handling"].to_string();
    for required in ["put_record", "spellcast.document-review.v1", "spellcast://project/", "spellcast_ack", "不改原文"] {
        assert!(handling.contains(required), "{required}: {handling}");
    }
    assert!(!handling.contains("command.op=put_proposal"), "document question must not require a design proposal");

    // A different approved task may create an ordinary review record, but cannot answer this goal.
    let (other_source, other_thread) = bind(&bridge, &root);
    let other_token = approved_access(&bridge, &project, &other_source, &other_thread, &root);
    bridge.project_agent_mutate(ProjectAgentMutation { access_token: other_token,
        command: document_answer(&project, &goal_id, "wrong-thread", &uri, &source_hash) }).unwrap();
    bridge.project_agent_mutate(ProjectAgentMutation { access_token: token.clone(),
        command: document_answer(&project, &goal_id, "wrong-path", "file:///different.md", &source_hash) }).unwrap();
    bridge.project_agent_mutate(ProjectAgentMutation { access_token: token.clone(),
        command: document_answer(&project, &goal_id, "wrong-hash", &uri, &"b".repeat(64)) }).unwrap();
    let mut wrong_scope = document_answer(&project, &goal_id, "wrong-scope", &uri, &source_hash);
    if let crate::project_records::RecordChange::PutRecord { fields, .. } = &mut wrong_scope.change { fields.scope = "other.scope".into(); }
    bridge.project_agent_mutate(ProjectAgentMutation { access_token: token.clone(), command: wrong_scope }).unwrap();
    bridge.project_agent_mutate(ProjectAgentMutation { access_token: token.clone(),
        command: document_answer(&project, &uuid::Uuid::new_v4().to_string(), "wrong-goal-uri", &uri, &source_hash) }).unwrap();
    let pending = bridge.project_goals(&project).unwrap().into_iter().find(|view| view.goal.id == goal_id).unwrap();
    assert_eq!(pending.delivery.unwrap().phase, DeliveryPhase::Received, "reading the request changes receipt phase, but invalid answers do not respond");
    assert!(pending.goal.response_record_ids.is_empty());

    let reply = document_answer(&project, &goal_id, "valid-answer", &uri, &source_hash);
    let answer = bridge.project_agent_mutate(ProjectAgentMutation { access_token: token.clone(), command: reply.clone() }).unwrap();
    assert_eq!(answer.record.as_ref().unwrap().updated_by.thread_id.as_deref(), Some(thread.as_str()));
    let replay = bridge.project_agent_mutate(ProjectAgentMutation { access_token: token, command: reply }).unwrap();
    assert!(replay.replayed);
    let answered = bridge.project_goals(&project).unwrap().into_iter().find(|view| view.goal.id == goal_id).unwrap();
    assert_eq!(answered.delivery.unwrap().phase, DeliveryPhase::Responded);
    assert_eq!(answered.goal.response_record_ids, vec!["valid-answer"]);
    let history = bridge.project_query(ProjectQuery { view: "history".into(), project_id: project.clone(), kind: "record".into(), id: "valid-answer".into(), ..Default::default() }).unwrap();
    assert_eq!(history[0]["actor"]["thread_id"], thread);
    drop(bridge);
    let bridge = Bridge::open(Headless, 0, &db).unwrap();
    assert_eq!(bridge.project_goals(&project).unwrap().into_iter().find(|view| view.goal.id == goal_id).unwrap().goal.response_record_ids, vec!["valid-answer"]);
    drop(bridge);
    let _ = fs::remove_dir_all(root.parent().unwrap());
}

#[test]
fn unsent_document_question_and_regular_goal_do_not_take_record_answer_receipts() {
    let (root, db) = repository();
    let (bridge, project) = open(&db, &root);
    let (source, thread) = bind(&bridge, &root);
    let token = approved_access(&bridge, &project, &source, &thread, &root);
    let path = "Assets/Documents/Atlas/domains/cycle.md";
    let source_hash = "c".repeat(64);
    let uri = document_reference_uri(&bridge.game_connection(&project).unwrap().unwrap().root, path);
    let unsent = uuid::Uuid::new_v4().to_string();
    bridge.create_project_goal(&project, CreateGoal { id: unsent.clone(), text: "这段是什么意思？".into(),
        context: GoalContext { entity_kind: "document_question".into(), entity_id: path.into(),
            sources: vec![GoalSource { path: path.into(), hash: source_hash.clone() }], ..Default::default() } }).unwrap();
    bridge.project_agent_mutate(ProjectAgentMutation { access_token: token.clone(),
        command: document_answer(&project, &unsent, "unsent-answer", &uri, &source_hash) }).unwrap();
    let regular = uuid::Uuid::new_v4().to_string();
    bridge.create_project_goal(&project, CreateGoal { id: regular.clone(), text: "请规划循环".into(), context: GoalContext::default() }).unwrap();
    let sent = bridge.send_project_goal(&project, &regular, SendGoal { source_id: source, thread_id: thread }).unwrap();
    bridge.project_agent_mutate(ProjectAgentMutation { access_token: token,
        command: document_answer(&project, &regular, "regular-answer", &uri, &source_hash) }).unwrap();
    let views = bridge.project_goals(&project).unwrap();
    assert_eq!(views.iter().find(|view| view.goal.id == unsent).unwrap().goal.status, "unsent");
    assert!(views.iter().find(|view| view.goal.id == unsent).unwrap().goal.response_record_ids.is_empty());
    assert_eq!(views.iter().find(|view| view.goal.id == regular).unwrap().delivery.as_ref().unwrap().phase, DeliveryPhase::Waiting);
    assert_eq!(sent.goal.context.entity_kind, "");
    drop(bridge);
    let _ = fs::remove_dir_all(root.parent().unwrap());
}

#[test]
fn concurrent_document_answers_append_both_ids_and_replays_do_not_duplicate_them() {
    let (root, db) = repository();
    let (bridge, project) = open(&db, &root);
    let (source, thread) = bind(&bridge, &root);
    let token = approved_access(&bridge, &project, &source, &thread, &root);
    let path = "Assets/Documents/Atlas/domains/cycle.md";
    let source_hash = "d".repeat(64);
    let uri = document_reference_uri(&bridge.game_connection(&project).unwrap().unwrap().root, path);
    let goal_id = uuid::Uuid::new_v4().to_string();
    bridge.create_project_goal(&project, CreateGoal { id: goal_id.clone(), text: "解释这段文档".into(),
        context: GoalContext { entity_kind: "document_question".into(), entity_id: path.into(),
            sources: vec![GoalSource { path: path.into(), hash: source_hash.clone() }], ..Default::default() } }).unwrap();
    bridge.send_project_goal(&project, &goal_id, SendGoal { source_id: source, thread_id: thread }).unwrap();
    let commands = [document_answer(&project, &goal_id, "answer-a", &uri, &source_hash),
        document_answer(&project, &goal_id, "answer-b", &uri, &source_hash)];
    let bridge = Arc::new(bridge);
    let barrier = Arc::new(Barrier::new(3));
    let threads: Vec<_> = commands.iter().cloned().map(|command| {
        let bridge = Arc::clone(&bridge);
        let barrier = Arc::clone(&barrier);
        let token = token.clone();
        std::thread::spawn(move || {
            barrier.wait();
            bridge.project_agent_mutate(ProjectAgentMutation { access_token: token, command }).unwrap();
        })
    }).collect();
    barrier.wait();
    for thread in threads { thread.join().unwrap(); }
    for command in commands {
        assert!(bridge.project_agent_mutate(ProjectAgentMutation { access_token: token.clone(), command }).unwrap().replayed);
    }
    let view = bridge.project_goals(&project).unwrap().into_iter().find(|view| view.goal.id == goal_id).unwrap();
    assert_eq!(view.delivery.unwrap().phase, DeliveryPhase::Responded);
    let mut ids = view.goal.response_record_ids;
    ids.sort();
    assert_eq!(ids, ["answer-a", "answer-b"]);
    drop(bridge);
    let _ = fs::remove_dir_all(root.parent().unwrap());
}

#[test]
fn a_goal_reaches_the_bound_task_and_its_proposal_is_reviewed_and_adopted_in_place() {
    let (root, db) = repository();
    let (bridge, project) = open(&db, &root);
    let (source, thread) = bind(&bridge, &root);
    let goal_id = uuid::Uuid::new_v4().to_string();
    bridge.create_project_goal(&project, CreateGoal { id: goal_id.clone(), text: "把外围林地的入口路线整理成可审阅的内容和数值".into(),
        context: GoalContext { scale: "experience".into(), zone_id: "zone_fixture".into(), label: "外围林地".into(), ..Default::default() } }).unwrap();
    let sent = bridge.send_project_goal(&project, &goal_id, SendGoal { source_id: source.clone(), thread_id: thread.clone() }).unwrap();
    assert_eq!(sent.goal.status, "sent");
    assert_eq!(sent.delivery.as_ref().unwrap().phase, DeliveryPhase::Waiting, "saved for delivery, not yet processed");
    let sequence = sent.goal.sequence.unwrap();
    // Idempotent resend to the same task; a different task is refused.
    assert_eq!(bridge.send_project_goal(&project, &goal_id, SendGoal { source_id: source.clone(), thread_id: thread.clone() }).unwrap().goal.sequence, Some(sequence));
    assert!(bridge.send_project_goal(&project, &goal_id, SendGoal { source_id: "codex:other".into(), thread_id: uuid::Uuid::new_v4().to_string() }).is_err());
    let receipt = bridge.feedback_state(Some(&source)).deliveries.into_iter().find(|receipt| receipt.event.seq == sequence).unwrap();
    assert!(receipt.notice.contains("游戏开发") && receipt.notice.contains(&goal_id));
    // The receiving task reads exactly this request and learns the proposal-only boundary.
    let read = bridge.read_feedback_request(&source, sequence).unwrap();
    let handling = read["handling"].to_string();
    assert!(handling.contains("put_proposal") && handling.contains("confirmed") && handling.contains("spellcast_project_access"), "{handling}");
    // Project access: pending until the user approves it in the workspace.
    let access = bridge.create_project_access(&project, crate::codex::CodexBinding { source_id: source.clone(), thread_id: thread.clone(),
        cwd: game_config::display_path(&root), label: "VESPERIX 主线".into(), executable: "fixture".into(), protocol_agent: "fixture".into(), bound_at_ms: now_ms() }).unwrap();
    let token = access["access_token"].as_str().unwrap().to_string();
    let proposal: RecordCommand = serde_json::from_value(json!({"request_id": uuid::Uuid::new_v4().to_string(), "project_id": project, "op": "put_proposal",
        "id": "entry-route", "expected_revision": 0, "title": "外围林地 · 入口路线", "goal_id": goal_id,
        "subject": {"scale": "experience", "zone_id": "zone_fixture"},
        "items": [{"id": "route", "target": "object", "target_id": "entry-route", "base_revision": 0,
            "object": {"name": "入口路线", "kind": "content", "planning": {"scopes": ["R0"], "sections": [{"id": "s1", "text": "古树根部 → 灵泉 → 迷雾出口。"}],
                "references": [{"label": "zone_fixture.json", "uri": "file:///fixture/zone_fixture.json", "version": "sha256"}]}},
            "reason": "路线来自配置的 SubLocationRoutes。", "basis": ["config", "design"], "boundaries": "未在 Unity 中走过。"}]})).unwrap();
    let pending = bridge.project_agent_mutate(ProjectAgentMutation { access_token: token.clone(), command: proposal.clone() }).unwrap_err();
    assert!(pending.to_string().contains("未批准"), "{pending}");
    bridge.project_decide_access(&project, access["access"]["id"].as_str().unwrap(), 1, "approved").unwrap();
    let submitted = bridge.project_agent_mutate(ProjectAgentMutation { access_token: token.clone(), command: proposal }).unwrap();
    assert_eq!(submitted.proposal.as_ref().unwrap().created_by.thread_id.as_deref(), Some(thread.as_str()));
    assert!(bridge.project_query(ProjectQuery { view: "objects".into(), project_id: project.clone(), ..Default::default() }).unwrap().as_array().unwrap().is_empty());
    let goals = bridge.project_goals(&project).unwrap();
    assert_eq!(goals[0].proposal_ids, vec!["entry-route".to_string()]);
    assert_eq!(goals[0].delivery.as_ref().unwrap().phase, DeliveryPhase::Responded, "a proposal answers the goal; acknowledgement stays the task's act");
    // The Agent cannot bypass review, even with an approved grant.
    let direct: RecordCommand = serde_json::from_value(json!({"request_id": uuid::Uuid::new_v4().to_string(), "project_id": project, "op": "put_object",
        "id": "entry-route", "expected_revision": 0, "name": "入口路线", "kind": "content", "archived": false,
        "planning": {"scopes": ["R0"], "confirmed": true, "body": "直接写入"}})).unwrap();
    assert!(bridge.project_agent_mutate(ProjectAgentMutation { access_token: token.clone(), command: direct }).unwrap_err().to_string().contains("put_proposal"));
    let decide: RecordCommand = serde_json::from_value(json!({"request_id": uuid::Uuid::new_v4().to_string(), "project_id": project, "op": "decide_proposal",
        "id": "entry-route", "expected_revision": 1, "item_ids": ["route"], "decision": "adopt"})).unwrap();
    assert!(bridge.project_agent_mutate(ProjectAgentMutation { access_token: token, command: decide.clone() }).is_err());
    // The user adopts in the workspace; only then does the project change.
    let adopted = bridge.project_user_mutate(decide).unwrap();
    let object = &adopted.adopted_objects[0];
    assert!(object.planning.as_ref().unwrap().confirmed);
    let history = bridge.project_query(ProjectQuery { view: "history".into(), project_id: project.clone(), kind: "object".into(), id: "entry-route".into(), ..Default::default() }).unwrap();
    assert_eq!(history[0]["actor"]["kind"], "user");
    assert_eq!(history[0]["operation"], "adopt_proposal");
    // Tracking implementation is an explicit upgrade, not a side effect of every goal.
    let promoted = bridge.promote_project_goal(&project, &goal_id).unwrap();
    let record_id = promoted.goal.record_id.clone().unwrap();
    assert_eq!(bridge.promote_project_goal(&project, &goal_id).unwrap().goal.record_id, Some(record_id.clone()));
    let record = bridge.project_query(ProjectQuery { view: "record".into(), project_id: project.clone(), id: record_id, ..Default::default() }).unwrap();
    assert!(record["boundaries"].as_str().unwrap().contains("没有 Unity"));
    // Development continues in the same workspace with a follow-up goal to the same task.
    let follow = uuid::Uuid::new_v4().to_string();
    bridge.create_project_goal(&project, CreateGoal { id: follow.clone(), text: "基于已采纳的入口路线补充灵泉的休息节奏".into(),
        context: GoalContext { scale: "object".into(), zone_id: "zone_fixture".into(), location_id: "location_b".into(), label: "灵泉".into(), ..Default::default() } }).unwrap();
    let second = bridge.send_project_goal(&project, &follow, SendGoal { source_id: source.clone(), thread_id: thread }).unwrap();
    assert!(second.goal.sequence.unwrap() > sequence);
    drop(bridge);
    // Goals, proposals and decisions survive a restart.
    let bridge = Bridge::open(Headless, 0, &db).unwrap();
    assert_eq!(bridge.project_goals(&project).unwrap().len(), 2);
    assert_eq!(bridge.project_query(ProjectQuery { view: "proposal".into(), project_id: project.clone(), id: "entry-route".into(), ..Default::default() }).unwrap()["status"], "closed");
    drop(bridge);
    let _ = fs::remove_dir_all(root.parent().unwrap());
}

#[test]
fn returned_items_go_back_to_the_author_only_when_it_is_still_bound() {
    let (root, db) = repository();
    let (bridge, project) = open(&db, &root);
    let (source, thread) = bind(&bridge, &root);
    let access = bridge.create_project_access(&project, crate::codex::CodexBinding { source_id: source.clone(), thread_id: thread.clone(),
        cwd: game_config::display_path(&root), label: "author".into(), executable: "fixture".into(), protocol_agent: "fixture".into(), bound_at_ms: now_ms() }).unwrap();
    bridge.project_decide_access(&project, access["access"]["id"].as_str().unwrap(), 1, "approved").unwrap();
    let proposal: RecordCommand = serde_json::from_value(json!({"request_id": uuid::Uuid::new_v4().to_string(), "project_id": project, "op": "put_proposal",
        "id": "p", "expected_revision": 0, "title": "灵泉", "items": [{"id": "a", "target": "object", "target_id": "rest", "base_revision": 0,
        "object": {"name": "灵泉休息", "kind": "content", "planning": {"scopes": ["R0"], "body": "恢复一半生命。"}}}]})).unwrap();
    bridge.project_agent_mutate(ProjectAgentMutation { access_token: access["access_token"].as_str().unwrap().into(), command: proposal }).unwrap();
    let request = || ReturnFeedback { request_id: uuid::Uuid::new_v4().to_string(), proposal_id: "p".into(), item_ids: vec!["a".into()], note: "按 ZoneDesign 的节奏改写。".into() };
    let sent = bridge.send_proposal_feedback(&project, request()).unwrap();
    assert_eq!(sent["sent"], true);
    let receipt = bridge.feedback_state(Some(&source)).deliveries.into_iter().last().unwrap();
    assert_eq!(receipt.event.project_context.as_ref().unwrap()["kind"], "proposal_return");
    bridge.unbind_codex(&source).unwrap();
    let unsent = bridge.send_proposal_feedback(&project, request()).unwrap();
    assert_eq!(unsent["sent"], false);
    drop(bridge);
    let _ = fs::remove_dir_all(root.parent().unwrap());
}

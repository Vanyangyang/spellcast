//! Isolated SQLite fixtures for the proposal layer and the Agent design-write boundary.
use super::*;
use crate::project_proposals::ProposalItemStatus;
use serde_json::{json, Value};
use std::path::PathBuf;

fn fresh_id() -> String { Uuid::new_v4().to_string() }

fn temp_store(label: &str) -> (Store, PathBuf) {
    let path = std::env::temp_dir().join(format!("spellcast-proposal-{label}-{}.sqlite3", Uuid::new_v4()));
    let _ = std::fs::remove_file(&path);
    (Store::open(&path).expect("temporary project store"), path)
}

fn cleanup(store: Store, path: PathBuf) {
    drop(store);
    let _ = std::fs::remove_file(path);
}

fn user() -> RecordActor {
    RecordActor { kind: "user".into(), source_id: None, thread_id: None, cwd: None, label: "User fixture".into() }
}

fn agent() -> RecordActor {
    RecordActor { kind: "agent".into(), source_id: Some("codex:fixture".into()), thread_id: Some("fixture-thread".into()), cwd: Some("C:/fixture".into()), label: "Agent fixture".into() }
}

fn run(store: &mut Store, project: &str, actor: &RecordActor, change: Value) -> Result<RecordMutationResult, String> {
    let mut body = change;
    body["project_id"] = project.into();
    if body.get("request_id").is_none() { body["request_id"] = fresh_id().into(); }
    let command: RecordCommand = serde_json::from_str(&serde_json::to_string(&body).unwrap()).map_err(|error| error.to_string())?;
    store.project_mutate(&command, actor)
}

fn project(store: &mut Store) -> String {
    let id = fresh_id();
    run(store, &id, &user(), json!({"op":"create_project","name":"Proposal fixture","aliases":[]})).unwrap();
    id
}

fn content(text: &str) -> Value {
    json!({"scopes":["R0"],"sections":[{"id":"body","role":"body","text":text},{"id":"why","role":"reason","text":"Grounded in the zone design."}],
        "references":[{"label":"ZoneDesign.md","uri":"file:///G:/fixture/ZoneDesign.md","version":"sha256:aa"}]})
}

fn item(id: &str, target: &str, base: u64, name: &str, kind: &str, planning: Value) -> Value {
    json!({"id":id,"target":"object","target_id":target,"base_revision":base,
        "object":{"name":name,"kind":kind,"planning":planning},
        "reason":"Keeps the first visit readable.","basis":["config","design"],
        "references":[{"label":"subloc_misty_path.json","uri":"file:///G:/fixture/subloc_misty_path.json","version":"abc123"}],
        "boundaries":"Not run in Unity; no player input observed."})
}

fn propose(store: &mut Store, project: &str, actor: &RecordActor, id: &str, revision: u64, items: Value) -> Result<RecordMutationResult, String> {
    run(store, project, actor, json!({"op":"put_proposal","id":id,"expected_revision":revision,"title":"First visit to the outer woods",
        "summary":"Organise the entry route.","subject":{"scale":"experience","zone_id":"zone_forest_shrine_outer"},"items":items,
        "references":[],"boundaries":"Static configuration only."}))
}

fn decide(store: &mut Store, project: &str, actor: &RecordActor, id: &str, revision: u64, items: &[&str], decision: &str, extra: Value) -> Result<RecordMutationResult, String> {
    let mut body = json!({"op":"decide_proposal","id":id,"expected_revision":revision,"item_ids":items,"decision":decision});
    if let (Some(target), Value::Object(fields)) = (body.as_object_mut(), extra) { target.extend(fields); }
    run(store, project, actor, body)
}

fn object(store: &Store, project: &str, id: &str) -> Option<DevelopmentObject> {
    store.project_objects(project).unwrap().into_iter().find(|object| object.id == id)
}

#[test]
fn agents_cannot_write_or_confirm_planning_design_directly() {
    let (mut store, path) = temp_store("guard");
    let project = project(&mut store);
    let planned = json!({"op":"put_object","id":"route","expected_revision":0,"name":"Route","kind":"content","archived":false,"planning":content("Agent text")});
    let denied = run(&mut store, &project, &agent(), planned.clone()).unwrap_err();
    assert!(denied.contains("put_proposal"), "{denied}");
    let confirmed = json!({"op":"put_object","id":"route","expected_revision":0,"name":"Route","kind":"content","archived":false,
        "planning":{"scopes":["R0"],"confirmed":true,"body":"self-confirmed"}});
    assert!(run(&mut store, &project, &agent(), confirmed).unwrap_err().contains("put_proposal"));
    // Minimal ownership objects without planning remain an Agent operation.
    run(&mut store, &project, &agent(), json!({"op":"put_object","id":"anchor","expected_revision":0,"name":"Game object","kind":"game_object","archived":false})).unwrap();
    // A user-owned planning object cannot be renamed, restored or unlocked by an Agent.
    run(&mut store, &project, &user(), planned).unwrap();
    let rename = json!({"op":"put_object","id":"route","expected_revision":1,"name":"Renamed","kind":"content","archived":false});
    assert!(run(&mut store, &project, &agent(), rename).unwrap_err().contains("put_proposal"));
    assert!(run(&mut store, &project, &agent(), json!({"op":"set_object_lock","id":"route","expected_revision":1,"locked":true})).unwrap_err().contains("put_proposal"));
    assert!(run(&mut store, &project, &agent(), json!({"op":"restore_object","id":"route","expected_revision":1,"restore_revision":1})).unwrap_err().contains("put_proposal"));
    assert_eq!(object(&store, &project, "route").unwrap().name, "Route");
    cleanup(store, path);
}

#[test]
fn proposals_stay_outside_objects_until_the_user_adopts_them() {
    let (mut store, path) = temp_store("lifecycle");
    let project = project(&mut store);
    let self_confirmed = json!([item("a", "route", 0, "Route", "content", json!({"scopes":["R0"],"confirmed":true,"body":"x"}))]);
    assert!(propose(&mut store, &project, &agent(), "p1", 0, self_confirmed).unwrap_err().contains("确认"));
    let items = json!([item("route", "route", 0, "Entry route", "content", content("Walk from the root to the misty path.")),
        item("chance", "elite-chance", 0, "Elite chance", "parameter", json!({"scopes":["R0"],"parameter":{"value":"0.08","min":"0","max":"1"},
            "links":[{"target_id":"route","relation":"uses"}]}))]);
    let created = propose(&mut store, &project, &agent(), "p1", 0, items.clone()).unwrap().proposal.unwrap();
    assert_eq!(created.status, "open");
    assert!(created.items.iter().all(|item| item.status == ProposalItemStatus::Pending));
    assert!(store.project_objects(&project).unwrap().is_empty(), "a proposal must not create objects");
    assert!(store.project_export(&project).unwrap().history.iter().all(|entry| entry.kind == RecordHistoryKind::Project), "a proposal must not enter the portable history");
    assert!(propose(&mut store, &project, &agent(), "p1", 0, items.clone()).unwrap_err().contains("已存在"));
    // Agents never decide.
    assert!(decide(&mut store, &project, &agent(), "p1", 1, &["route"], "adopt", json!({})).unwrap_err().contains("只有用户"));
    // Adopting the parameter first fails: its link target is still only proposed. Nothing is written.
    let dependent = decide(&mut store, &project, &user(), "p1", 1, &["chance"], "adopt", json!({})).unwrap_err();
    assert!(dependent.contains("route"), "{dependent}");
    assert!(store.project_objects(&project).unwrap().is_empty());
    // Adopting both in dependency order is one transaction.
    let adopted = decide(&mut store, &project, &user(), "p1", 1, &["route", "chance"], "adopt", json!({"note":"Looks right."})).unwrap();
    assert_eq!(adopted.adopted_objects.len(), 2);
    let route = object(&store, &project, "route").unwrap();
    let planning = route.planning.as_ref().unwrap();
    assert!(planning.confirmed && planning.locked);
    let history = store.project_history(&project, "object", "route").unwrap();
    assert_eq!(history.len(), 1);
    assert_eq!(history[0].operation, "adopt_proposal");
    assert_eq!(history[0].actor.kind, "user");
    let proposal = adopted.proposal.unwrap();
    assert_eq!(proposal.status, "closed");
    assert_eq!(proposal.revision, 2);
    assert_eq!(proposal.items[0].decision.as_ref().unwrap().applied_revision, Some(1));
    // Decided items are immutable; a revision may only add or change undecided items.
    let changed = json!([item("route", "route", 0, "Entry route", "content", content("Changed after adoption."))]);
    assert!(propose(&mut store, &project, &agent(), "p1", 2, changed).unwrap_err().contains("不能修改"));
    assert!(decide(&mut store, &project, &user(), "p1", 2, &["route"], "adopt", json!({})).unwrap_err().contains("已经决定"));
    cleanup(store, path);
}

#[test]
fn stale_bases_and_locks_block_adoption_with_explanations() {
    let (mut store, path) = temp_store("conflicts");
    let project = project(&mut store);
    run(&mut store, &project, &user(), json!({"op":"put_object","id":"route","expected_revision":0,"name":"Route","kind":"content","archived":false,
        "planning":{"scopes":["R0"],"body":"User original"}})).unwrap();
    // A stale base is refused when proposing.
    let stale = json!([item("route", "route", 7, "Route", "content", json!({"scopes":["R0"],"body":"x"}))]);
    assert!(propose(&mut store, &project, &agent(), "stale", 0, stale).unwrap_err().contains("版本"));
    let update = json!([item("route", "route", 1, "Route", "content", json!({"scopes":["R0"],"body":"Agent rewrite"}))]);
    propose(&mut store, &project, &agent(), "p2", 0, update).unwrap();
    // The user edits the canonical object after the proposal was written.
    run(&mut store, &project, &user(), json!({"op":"put_object","id":"route","expected_revision":1,"name":"Route","kind":"content","archived":false,
        "planning":{"scopes":["R0"],"body":"User edit","locked":true}})).unwrap();
    let conflict = decide(&mut store, &project, &user(), "p2", 1, &["route"], "adopt", json!({})).unwrap_err();
    assert!(conflict.contains("基准版本 1") && conflict.contains("避免覆盖"), "{conflict}");
    assert_eq!(object(&store, &project, "route").unwrap().planning.unwrap().body, "User edit");
    // Re-proposed against the current version: a locked target needs an explicit unlock.
    let rebased = json!([item("route2", "route", 2, "Route", "content", json!({"scopes":["R0"],"body":"Agent rewrite v2"}))]);
    propose(&mut store, &project, &agent(), "p3", 0, rebased).unwrap();
    let locked = decide(&mut store, &project, &user(), "p3", 1, &["route2"], "adopt", json!({})).unwrap_err();
    assert!(locked.contains("解锁并采纳"), "{locked}");
    let adopted = decide(&mut store, &project, &user(), "p3", 1, &["route2"], "adopt", json!({"unlock":true,"confirm":false})).unwrap();
    let route = &adopted.adopted_objects[0];
    assert_eq!(route.revision, 3);
    assert!(!route.planning.as_ref().unwrap().confirmed && !route.planning.as_ref().unwrap().locked);
    assert!(adopted.proposal.unwrap().items[0].decision.as_ref().unwrap().unlocked);
    cleanup(store, path);
}

#[test]
fn users_revise_return_and_dismiss_without_touching_the_project() {
    let (mut store, path) = temp_store("review");
    let project = project(&mut store);
    let items = json!([item("a", "route", 0, "Route", "content", content("Draft A")), item("b", "rest", 0, "Rest", "content", content("Draft B")),
        {"id":"verify","target":"record","target_id":"verify-route","base_revision":0,"record":{"title":"Walk the route in Unity","status":"planned",
         "goal":"Check entry to gate with real input.","boundaries":"Not yet run."},"reason":"Needs a real journey.","basis":["inference"]}]);
    propose(&mut store, &project, &agent(), "p", 0, items).unwrap();
    assert!(decide(&mut store, &project, &user(), "p", 1, &["a"], "return", json!({})).unwrap_err().contains("写明"));
    let returned = decide(&mut store, &project, &user(), "p", 1, &["a"], "return", json!({"note":"Use the shrine names from ZoneDesign."})).unwrap().proposal.unwrap();
    assert_eq!(returned.items[0].status, ProposalItemStatus::Returned);
    let dismissed = decide(&mut store, &project, &user(), "p", 2, &["b"], "dismiss", json!({"note":"Not needed for R0."})).unwrap().proposal.unwrap();
    assert_eq!(dismissed.items[1].status, ProposalItemStatus::Dismissed);
    let revised_object = json!({"name":"Route (user wording)","kind":"content","planning":content("User rewrite")});
    let revised = decide(&mut store, &project, &user(), "p", 3, &["a"], "revise", json!({"revised_object":revised_object})).unwrap().proposal.unwrap();
    assert_eq!(revised.items[0].status, ProposalItemStatus::Pending);
    assert!(revised.items[0].edited_by.is_some());
    assert!(store.project_objects(&project).unwrap().is_empty(), "review decisions other than adopt never write objects");
    // The Agent may revise the returned/pending item but not the dismissed one.
    let agent_revision = json!([item("a", "route", 0, "Route", "content", content("Agent second draft")),
        item("b", "rest", 0, "Rest", "content", content("Sneaky rewrite"))]);
    assert!(propose(&mut store, &project, &agent(), "p", 4, agent_revision).unwrap_err().contains("不能修改"));
    let adopted = decide(&mut store, &project, &user(), "p", 4, &["a", "verify"], "adopt", json!({})).unwrap();
    assert_eq!(adopted.adopted_objects[0].name, "Route (user wording)");
    assert_eq!(adopted.adopted_records[0].fields.title, "Walk the route in Unity");
    assert_eq!(adopted.adopted_records[0].updated_by.kind, "user");
    let proposal = adopted.proposal.unwrap();
    assert!(proposal.items[0].decision.as_ref().unwrap().revised);
    assert_eq!(proposal.status, "closed");
    // Replaying an identical decision returns the stored receipt instead of writing twice.
    let replay_id = fresh_id();
    let body = json!({"op":"put_proposal","id":"q","expected_revision":0,"title":"Replay","items":[item("x","x",0,"X","content",content("x"))],"request_id":replay_id});
    run(&mut store, &project, &agent(), body.clone()).unwrap();
    assert!(run(&mut store, &project, &agent(), body).unwrap().replayed);
    cleanup(store, path);
}

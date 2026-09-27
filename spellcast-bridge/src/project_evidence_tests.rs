//! Isolated SQLite fixtures for flow anchors, candidates, trials and adoptions.
use super::*;
use serde_json::{json, Value};
use std::path::PathBuf;

fn fresh_id() -> String { Uuid::new_v4().to_string() }

fn temp_store(label: &str) -> (Store, PathBuf) {
    let path = std::env::temp_dir().join(format!("spellcast-evidence-{label}-{}.sqlite3", Uuid::new_v4()));
    let _ = std::fs::remove_file(&path);
    (Store::open(&path).expect("temporary project store"), path)
}

fn cleanup(store: Store, path: PathBuf) {
    drop(store);
    let _ = std::fs::remove_file(path);
}

fn actor() -> RecordActor {
    RecordActor { kind: "user".into(), source_id: None, thread_id: None, cwd: None, label: "Evidence fixture".into() }
}

fn run(store: &mut Store, project: &str, change: Value) -> Result<RecordMutationResult, String> {
    let mut body = change;
    body["project_id"] = project.into();
    if body.get("request_id").is_none() { body["request_id"] = fresh_id().into(); }
    // Through JSON text like the HTTP route, so numbers are parsed exactly as in production.
    let command: RecordCommand = serde_json::from_str(&serde_json::to_string(&body).unwrap()).map_err(|error| error.to_string())?;
    store.project_mutate(&command, &actor())
}

fn put(store: &mut Store, project: &str, id: &str, revision: u64, kind: &str, planning: Value) -> Result<RecordMutationResult, String> {
    run(store, project, json!({"op":"put_object","id":id,"expected_revision":revision,"name":id,"kind":kind,"archived":false,"planning":planning}))
}

fn object(store: &Store, project: &str, id: &str) -> DevelopmentObject {
    store.project_objects(project).unwrap().into_iter().find(|object| object.id == id).unwrap()
}

fn unlock(store: &mut Store, project: &str, id: &str) {
    let revision = object(store, project, id).revision;
    run(store, project, json!({"op":"set_object_lock","id":id,"expected_revision":revision,"locked":false})).unwrap();
}

fn flow_planning(locked: bool, with_end_choice: bool) -> Value {
    json!({"scopes":["R0"],"locked":locked,"links":[{"target_id":"energy","relation":"uses"}],"flow":{
        "entry":"start","variables":[{"id":"stamina","name":"Stamina","value_type":"number","initial":"","unit":"","parameter_id":"energy"}],
        "steps":[
            {"id":"start","title":"Start","goal":"","action":"","feedback":"","external":false,"terminal":false,"choices":[
                {"id":"go","label":"Spend two","to":"fight","conditions":[{"variable_id":"stamina","op":"gte","operand":{"kind":"literal","value":"2"}}],
                 "effects":[{"variable_id":"stamina","op":"subtract","operand":{"kind":"literal","value":"2"}}]}]},
            {"id":"fight","title":"Fight","goal":"","action":"","feedback":"","external":true,"terminal":false,"choices":
                if with_end_choice { json!([{"id":"finish","label":"Finish","to":"end","conditions":[],"effects":[]}]) } else { json!([]) }},
            {"id":"end","title":"End","goal":"","action":"","feedback":"Reward shown","external":false,"terminal":true,"choices":[]}]}})
}

/// Parameter `energy` (3, bounds 0..10), locked flow `flow`, consumer with a local override.
fn fixture(store: &mut Store) -> String {
    let project = fresh_id();
    run(store, &project, json!({"op":"create_project","name":"Evidence fixture","aliases":[]})).unwrap();
    put(store, &project, "energy", 0, "parameter", json!({"scopes":["R0"],"locked":true,"parameter":{"value":"3","min":"0","max":"10","unit":"points"}})).unwrap();
    put(store, &project, "flow", 0, "flow", flow_planning(true, true)).unwrap();
    put(store, &project, "local-user", 0, "content", json!({"scopes":["R0"],"links":[{"target_id":"energy","relation":"uses","local":{"value":"5","reason":"intro"}}]})).unwrap();
    project
}

fn state(value: f64) -> Value { json!({"stamina": value}) }

/// A model-shaped run through start → fight (manual) → end, using saved snapshots. Like the client,
/// an initial value other than the shared one is a typed override (never labelled shared).
fn trial_run(store: &Store, project: &str, initial: f64, candidate: Option<&Value>) -> Value {
    let flow = serde_json::to_value(object(store, project, "flow")).unwrap();
    let energy = serde_json::to_value(object(store, project, "energy")).unwrap();
    let after = initial - 2.0;
    let shared = energy["planning"]["parameter"]["value"].as_str().unwrap().parse::<f64>().unwrap() == initial;
    let mut value = json!({"version":2,"id":fresh_id(),"started":"2026-09-26T00:00:00.000Z","source":flow,"dependencies":[energy.clone()],
        "inputs":{},"initial":state(initial),"events":[
            {"kind":"choice","from":"start","to":"fight","label":"Spend two","choice_id":"go","before":state(initial),"after":state(after),"at":"2026-09-26T00:00:01.000Z"},
            {"kind":"manual","from":"fight","to":"fight","label":"Manual result","before":state(after),"after":state(after),"at":"2026-09-26T00:00:02.000Z"},
            {"kind":"choice","from":"fight","to":"end","label":"Finish","choice_id":"finish","before":state(after),"after":state(after),"at":"2026-09-26T00:00:03.000Z"}],
        "input_sources":[{"variable_id":"stamina","value":if shared { energy["planning"]["parameter"]["value"].clone() } else { initial.to_string().into() },
            "source":if shared { "shared" } else { "override" },"parameter_id":"energy","parameter_revision":energy["revision"]}]});
    if !shared && candidate.is_none() { value["inputs"] = json!({"stamina": initial.to_string()}); }
    if let Some(candidate) = candidate {
        value["candidates"] = json!([candidate]);
        value["input_sources"] = json!([{"variable_id":"stamina","value":initial.to_string(),"source":"candidate","parameter_id":"energy",
            "parameter_revision":energy["revision"],"candidate_id":candidate["id"],"candidate_revision":candidate["revision"]}]);
    }
    value
}

fn save(store: &mut Store, project: &str, id: &str, run_value: Value) -> Result<RecordMutationResult, String> {
    run(store, project, json!({"op":"save_trial","id":id,"label":"fixture","origin":"walkthrough","run":run_value}))
}

#[test]
fn anchors_keep_locked_flows_unchanged_and_guard_referenced_steps() {
    let (mut store, path) = temp_store("anchors");
    let project = fixture(&mut store);
    let anchors = json!([{"flow_id":"flow","step_id":"start","phase":"cue"},{"flow_id":"flow","step_id":"start","choice_id":"go","phase":"action","note":"spend"},
        {"flow_id":"flow","step_id":"end","phase":"payoff"}]);
    put(&mut store, &project, "hook", 0, "hook", json!({"scopes":["R0"],"hook":{"cue":"Glow","action":"Spend","payoff":"Reward","continuation":""},"anchors":anchors})).unwrap();
    put(&mut store, &project, "rule", 0, "rule", json!({"scopes":["R0"],"rule":{"trigger":"","condition":"","effect":""},"anchors":[{"flow_id":"flow","step_id":"start","choice_id":"go","note":"cost"}]})).unwrap();
    let flow = object(&store, &project, "flow");
    assert_eq!(flow.revision, 1, "attaching designs must not create a flow revision");
    assert!(flow.planning.as_ref().unwrap().locked);
    // Old objects without anchors keep their previous canonical form.
    assert!(serde_json::to_value(object(&store, &project, "local-user")).unwrap()["planning"].get("anchors").is_none());
    for (kind, anchor) in [
        ("hook", json!({"flow_id":"flow","step_id":"missing"})),
        ("hook", json!({"flow_id":"flow","step_id":"fight","choice_id":"go"})),
        ("content", json!({"flow_id":"flow","step_id":"start","phase":"cue"})),
        ("hook", json!({"flow_id":"energy","step_id":"start"})),
        ("hook", json!({"flow_id":"elsewhere","step_id":"start"})),
        ("system", json!({"flow_id":"flow","step_id":"start"})),
    ] {
        let mut planning = json!({"scopes":["R0"],"anchors":[anchor]});
        if kind == "hook" { planning["hook"] = json!({}); }
        assert!(put(&mut store, &project, "invalid", 0, kind, planning).is_err(), "{kind} anchor must be rejected");
    }
    let other = fresh_id();
    run(&mut store, &other, json!({"op":"create_project","name":"Other","aliases":[]})).unwrap();
    assert!(put(&mut store, &other, "foreign", 0, "content", json!({"scopes":["R0"],"anchors":[{"flow_id":"flow","step_id":"start"}]})).is_err());
    // A referenced step or choice cannot disappear, even after an explicit unlock.
    unlock(&mut store, &project, "flow");
    let mut without_end = flow_planning(false, false);
    without_end["flow"]["steps"].as_array_mut().unwrap().pop();
    let error = put(&mut store, &project, "flow", 2, "flow", without_end).unwrap_err();
    assert!(error.contains("hook") && error.contains("解除"), "{error}");
    let mut without_choice = flow_planning(false, true);
    without_choice["flow"]["steps"][0]["choices"] = json!([]);
    assert!(put(&mut store, &project, "flow", 2, "flow", without_choice).unwrap_err().contains("选择"));
    // History restore of an anchor owner is validated against the current flow.
    put(&mut store, &project, "flow", 2, "flow", {
        let mut extra = flow_planning(false, true);
        extra["flow"]["steps"].as_array_mut().unwrap().push(json!({"id":"extra","title":"Extra","goal":"","action":"","feedback":"","external":false,"terminal":true,"choices":[]}));
        extra
    }).unwrap();
    put(&mut store, &project, "note", 0, "content", json!({"scopes":["R0"],"anchors":[{"flow_id":"flow","step_id":"extra"}]})).unwrap();
    put(&mut store, &project, "note", 1, "content", json!({"scopes":["R0"]})).unwrap();
    put(&mut store, &project, "flow", 3, "flow", flow_planning(false, true)).unwrap();
    assert!(run(&mut store, &project, json!({"op":"restore_object","id":"note","expected_revision":2,"restore_revision":1})).unwrap_err().contains("不存在的步骤"));
    let bundle = store.project_export(&project).unwrap();
    assert_eq!(bundle.version, 3);
    let mut downgraded = bundle.clone();
    downgraded.version = 2;
    assert!(run(&mut store, &fresh_id(), json!({"op":"import_project","bundle":downgraded,"name":"bad"})).unwrap_err().contains("v3"));
    let target = fresh_id();
    run(&mut store, &target, json!({"op":"import_project","bundle":bundle,"name":"copy"})).unwrap();
    drop(store);
    let store = Store::open(&path).unwrap();
    assert_eq!(object(&store, &target, "hook").planning.unwrap().anchors.len(), 3);
    cleanup(store, path);
}

#[test]
fn candidates_stay_independent_and_adoption_is_explicit_and_atomic() {
    let (mut store, path) = temp_store("candidates");
    let project = fixture(&mut store);
    let before = object(&store, &project, "energy");
    let create = json!({"op":"put_candidate","id":"low","expected_revision":0,"parameter_id":"energy","label":"Low","value":"1","reason":"harder start","base_revision":before.revision});
    let created = run(&mut store, &project, create.clone()).unwrap().candidate.unwrap();
    assert_eq!((created.revision, created.base.value.as_str(), created.base.revision), (1, "3", before.revision));
    assert_eq!(object(&store, &project, "energy"), before, "saving a candidate must not touch the locked parameter");
    for invalid in [
        json!({"op":"put_candidate","id":"bad","expected_revision":0,"parameter_id":"energy","label":"Stale","value":"2","base_revision":before.revision + 1}),
        json!({"op":"put_candidate","id":"bad","expected_revision":0,"parameter_id":"energy","label":"High","value":"11","base_revision":before.revision}),
        json!({"op":"put_candidate","id":"bad","expected_revision":0,"parameter_id":"energy","label":"NaN","value":"NaN","base_revision":before.revision}),
        json!({"op":"put_candidate","id":"bad","expected_revision":0,"parameter_id":"flow","label":"Flow","value":"1","base_revision":1}),
        json!({"op":"put_candidate","id":"bad","expected_revision":0,"parameter_id":"energy","label":"Variant","value":"1","base_revision":before.revision,"from_variant":"absent"}),
    ] { assert!(run(&mut store, &project, invalid).is_err()); }
    run(&mut store, &project, json!({"op":"put_candidate","id":"low","expected_revision":1,"parameter_id":"energy","label":"Low","value":"2","reason":"retuned","base_revision":before.revision})).unwrap();
    assert_eq!(store.project_history(&project, "candidate", "low").unwrap().len(), 2);
    // A trial with the candidate is evidence for the adoption and freezes candidate revision 2.
    let candidate = serde_json::to_value(store.project_candidates(&project).unwrap().remove(0)).unwrap();
    let with_low = trial_run(&store, &project, 2.0, Some(&candidate));
    let trial = save(&mut store, &project, "with-low", with_low).unwrap().trial.unwrap();
    assert_eq!(trial.candidates[0].revision, 2);
    // Adoption obeys the lock and the latest revision.
    let adopt = |revision: u64| json!({"op":"adopt_candidate","adoption_id":"adopt-1","parameter_id":"energy","expected_revision":revision,
        "candidate_id":"low","candidate_revision":2,"trial_ids":["with-low"],"reason":"Two keeps the first fight reachable","lock_after":true});
    assert!(run(&mut store, &project, adopt(before.revision)).unwrap_err().contains("已锁定"));
    unlock(&mut store, &project, "energy");
    let unlocked = object(&store, &project, "energy").revision;
    assert!(run(&mut store, &project, adopt(unlocked - 1)).unwrap_err().contains("revision"));
    // A changed effective definition blocks silent adoption; the lock revision alone does not.
    run(&mut store, &project, json!({"op":"put_object","id":"energy","expected_revision":unlocked,"name":"energy","kind":"parameter","archived":false,
        "planning":{"scopes":["R0"],"parameter":{"value":"4","min":"0","max":"10","unit":"points"}}})).unwrap();
    let changed = object(&store, &project, "energy").revision;
    assert!(run(&mut store, &project, adopt(changed)).unwrap_err().contains("新基准"));
    run(&mut store, &project, json!({"op":"put_candidate","id":"low","expected_revision":2,"parameter_id":"energy","label":"Low","value":"2","reason":"rebased","base_revision":changed})).unwrap();
    let rebased = |revision: u64| { let mut value = adopt(revision); value["candidate_revision"] = 3.into(); value };
    let mut bad_evidence = rebased(changed); bad_evidence["trial_ids"] = json!(["absent"]);
    assert!(run(&mut store, &project, bad_evidence).is_err());
    // A failed adoption write leaves the parameter, history and receipt untouched.
    store.connection.execute_batch("CREATE TRIGGER reject_adoption BEFORE INSERT ON spellcast_project_adoptions BEGIN SELECT RAISE(ABORT, 'forced'); END;").unwrap();
    let mut failing = rebased(changed); failing["request_id"] = "adopt-fail".into();
    assert!(run(&mut store, &project, failing).is_err());
    assert_eq!(object(&store, &project, "energy").revision, changed);
    let receipts: i64 = store.connection.query_row("SELECT COUNT(*) FROM spellcast_project_request_receipts WHERE request_id='adopt-fail'", [], |row| row.get(0)).unwrap();
    assert_eq!(receipts, 0);
    store.connection.execute_batch("DROP TRIGGER reject_adoption;").unwrap();
    let mut good = rebased(changed); good["request_id"] = "adopt-ok".into();
    let adopted = run(&mut store, &project, good.clone()).unwrap();
    let parameter = adopted.object.unwrap();
    assert_eq!(parameter.planning.as_ref().unwrap().parameter.as_ref().unwrap().value, "2");
    assert!(parameter.planning.as_ref().unwrap().locked);
    let record = adopted.adoption.unwrap();
    assert_eq!((record.candidate.revision, record.value_before.as_str(), record.trial_ids.clone()), (3, "4", vec!["with-low".to_string()]));
    assert!(run(&mut store, &project, good).unwrap().replayed);
    let history = store.project_history(&project, "object", "energy").unwrap();
    assert_eq!(history.last().unwrap().operation, "adopt_candidate");
    // Consumers with a local override keep it.
    let local = object(&store, &project, "local-user");
    assert_eq!(local.planning.unwrap().links[0].local.as_ref().unwrap().value, "5");
    cleanup(store, path);
}

#[test]
fn trials_are_immutable_verified_deduplicated_and_portable() {
    let (mut store, path) = temp_store("trials");
    let project = fixture(&mut store);
    let first = trial_run(&store, &project, 3.0, None);
    let saved = save(&mut store, &project, "first", first.clone()).unwrap().trial.unwrap();
    assert_eq!((saved.event_count, saved.terminal, saved.manual_count), (3, true, 1));
    let duplicate = save(&mut store, &project, "copy-of-first", first.clone()).unwrap();
    assert!(duplicate.deduplicated);
    assert_eq!(duplicate.trial.unwrap().id, "first");
    let mut other = trial_run(&store, &project, 4.0, None);
    assert!(save(&mut store, &project, "first", other.clone()).unwrap_err().contains("不能被覆盖"));
    for (label, tamper) in [
        ("snapshot", Box::new(|run: &mut Value| run["source"]["name"] = "forged".into()) as Box<dyn Fn(&mut Value)>),
        ("continuity", Box::new(|run: &mut Value| run["events"][0]["before"] = state(9.0))),
        ("choice", Box::new(|run: &mut Value| run["events"][0]["choice_id"] = "finish".into())),
        ("manual gate", Box::new(|run: &mut Value| { run["events"].as_array_mut().unwrap().remove(1); })),
        ("type", Box::new(|run: &mut Value| run["initial"]["stamina"] = "3".into())),
        ("version", Box::new(|run: &mut Value| run["version"] = 1.into())),
        ("source", Box::new(|run: &mut Value| run["input_sources"][0]["parameter_revision"] = 99.into())),
        ("size", Box::new(|run: &mut Value| { let event = run["events"][0].clone(); run["events"] = Value::Array(vec![event; 201]); })),
    ] {
        let mut tampered = other.clone();
        tamper(&mut tampered);
        assert!(save(&mut store, &project, &format!("bad-{}", label.replace(' ', "-")), tampered).is_err(), "{label} must be rejected");
    }
    save(&mut store, &project, "second", other.clone()).unwrap();
    // A replay references its base and keeps the reused manual result explicit.
    other["id"] = fresh_id().into();
    other["replay"] = json!({"base_trial_id":"first","base_run_id":first["id"],"status":"complete","cursor":3});
    other["events"][1]["assumption"] = json!({"base_trial_id":"first","base_event_index":1,"context_changed":true});
    assert!(run(&mut store, &project, json!({"op":"save_trial","id":"replay","origin":"walkthrough","run":other.clone()})).is_err());
    let mut missing_base = other.clone(); missing_base["replay"]["base_trial_id"] = "absent".into(); missing_base["events"][1]["assumption"]["base_trial_id"] = "absent".into();
    assert!(run(&mut store, &project, json!({"op":"save_trial","id":"replay","origin":"replay","run":missing_base})).is_err());
    run(&mut store, &project, json!({"op":"save_trial","id":"replay","origin":"replay","run":other})).unwrap();
    // Later edits do not rewrite saved trials.
    unlock(&mut store, &project, "energy");
    let energy = object(&store, &project, "energy");
    run(&mut store, &project, json!({"op":"put_object","id":"energy","expected_revision":energy.revision,"name":"energy","kind":"parameter","archived":false,
        "planning":{"scopes":["R0"],"parameter":{"value":"6","min":"0","max":"10","unit":"points"}}})).unwrap();
    let stored = store.project_trial(&project, "first").unwrap();
    assert_eq!(stored.run.dependencies[0].planning.as_ref().unwrap().parameter.as_ref().unwrap().value, "3");
    let listed = store.project_trials(&project, "flow").unwrap();
    assert_eq!(listed.iter().map(|trial| trial.id.as_str()).collect::<Vec<_>>(), vec!["replay", "second", "first"]);
    assert_eq!(listed[0].base_trial_id.as_deref(), Some("first"));
    // Export/import keeps IDs, digests and immutable content; restart keeps them too.
    let bundle = store.project_export(&project).unwrap();
    assert_eq!((bundle.version, bundle.trials.len()), (3, 3));
    let mut tampered = bundle.clone();
    tampered.trials[0].run.events[0].label = "edited".into();
    assert!(run(&mut store, &fresh_id(), json!({"op":"import_project","bundle":tampered,"name":"bad"})).unwrap_err().contains("摘要"));
    let mut orphan = bundle.clone();
    orphan.trials.retain(|trial| trial.id != "first");
    assert!(run(&mut store, &fresh_id(), json!({"op":"import_project","bundle":orphan,"name":"bad"})).is_err());
    let target = fresh_id();
    run(&mut store, &target, json!({"op":"import_project","bundle":bundle.clone(),"name":"copy"})).unwrap();
    drop(store);
    let store = Store::open(&path).unwrap();
    let copied = store.project_trial(&target, "first").unwrap();
    assert_eq!((copied.digest.as_str(), copied.run.source.project_id.as_str()), (bundle.trials.iter().find(|t| t.id == "first").unwrap().digest.as_str(), target.as_str()));
    assert_eq!(store.project_trials(&target, "").unwrap().len(), 3);
    cleanup(store, path);
}

#[test]
fn schema_three_databases_gain_evidence_tables_without_losing_rows() {
    let (mut store, path) = temp_store("migration-v3");
    let project = fixture(&mut store);
    let before = store.project_export(&project).unwrap();
    drop(store);
    let connection = Connection::open(&path).unwrap();
    connection.execute_batch("DROP TABLE spellcast_project_candidates; DROP TABLE spellcast_project_trials; DROP TABLE spellcast_project_adoptions;
        UPDATE spellcast_project_schema_version SET schema_version = 3;").unwrap();
    drop(connection);
    let mut store = Store::open(&path).unwrap();
    let version: i64 = store.connection.query_row("SELECT schema_version FROM spellcast_project_schema_version", [], |row| row.get(0)).unwrap();
    assert_eq!(version, PROJECT_SCHEMA_VERSION);
    let after = store.project_export(&project).unwrap();
    assert_eq!((before.objects, before.history, after.version), (after.objects, after.history, 2));
    let revision = object(&store, &project, "energy").revision;
    run(&mut store, &project, json!({"op":"put_candidate","id":"after-migration","expected_revision":0,"parameter_id":"energy","label":"A","value":"2","base_revision":revision})).unwrap();
    cleanup(store, path);
}

fn count_rows(store: &Store, sql: &str, value: &str) -> i64 {
    store.connection.query_row(sql, [value], |row| row.get(0)).unwrap()
}

/// One terminal step; a bound number, an unbound number and an unbound flag.
fn provenance_flow(local: Option<&str>) -> Value {
    let mut link = json!({"target_id":"energy","relation":"uses"});
    if let Some(value) = local { link["local"] = json!({"value":value,"reason":"intro"}); }
    json!({"scopes":["R0"],"links":[link],"flow":{"entry":"only","variables":[
        {"id":"stamina","name":"Stamina","value_type":"number","initial":"","unit":"","parameter_id":"energy"},
        {"id":"coins","name":"Coins","value_type":"number","initial":"0","unit":""},
        {"id":"open","name":"Open","value_type":"flag","initial":"false","unit":""}],
        "steps":[{"id":"only","title":"Only","goal":"","action":"","feedback":"","external":false,"terminal":true,"choices":[]}]}})
}

#[test]
fn trial_input_sources_must_be_complete_exact_and_follow_precedence() {
    let (mut store, path) = temp_store("provenance");
    let project = fixture(&mut store);
    put(&mut store, &project, "prov", 0, "flow", provenance_flow(None)).unwrap();
    put(&mut store, &project, "prov-local", 0, "flow", provenance_flow(Some("7"))).unwrap();
    let rev = object(&store, &project, "energy").revision;
    let low = serde_json::to_value(run(&mut store, &project, json!({"op":"put_candidate","id":"low","expected_revision":0,"parameter_id":"energy","label":"Low","value":"1","base_revision":rev})).unwrap().candidate.unwrap()).unwrap();
    let bound = |source: &str, value: &str| json!({"variable_id":"stamina","value":value,"source":source,"parameter_id":"energy","parameter_revision":rev});
    let flow = |variable: &str, value: &str| json!({"variable_id":variable,"value":value,"source":"flow"});
    let typed = |variable: &str, value: &str| json!({"variable_id":variable,"value":value,"source":"override"});
    let candidate = |value: &str| json!({"variable_id":"stamina","value":value,"source":"candidate","parameter_id":"energy","parameter_revision":rev,"candidate_id":"low","candidate_revision":1});
    let (coins, open) = (flow("coins", "0"), flow("open", "false"));
    let initial = |stamina: f64, coins: f64, open: bool| json!({"stamina":stamina,"coins":coins,"open":open});
    let mut stale = bound("shared", "3"); stale["parameter_revision"] = (rev + 1).into();
    let mut wrong_candidate = candidate("1"); wrong_candidate["candidate_revision"] = 2.into();
    let mut unbound_ref = coins.clone(); unbound_ref["source"] = "shared".into(); unbound_ref["parameter_id"] = "energy".into(); unbound_ref["parameter_revision"] = rev.into();
    let legacy: Vec<Value> = [bound("shared", "3"), coins.clone(), open.clone()].into_iter().map(|mut source| { source["note"] = "由旧版试走的来源快照重建".into(); source }).collect();
    let (none, with_low) = (json!([]), json!([low]));
    let cases: Vec<(&str, &str, Value, Vec<Value>, Value, &Value, bool)> = vec![
        ("shared", "prov", json!({}), vec![bound("shared", "3"), coins.clone(), open.clone()], initial(3.0, 0.0, false), &none, true),
        ("legacy-upgrade", "prov", json!({}), legacy, initial(3.0, 0.0, false), &none, true),
        ("missing", "prov", json!({}), vec![bound("shared", "3"), coins.clone()], initial(3.0, 0.0, false), &none, false),
        ("duplicate", "prov", json!({}), vec![bound("shared", "3"), bound("shared", "3"), coins.clone(), open.clone()], initial(3.0, 0.0, false), &none, false),
        ("shared-value", "prov", json!({}), vec![bound("shared", "4"), coins.clone(), open.clone()], initial(4.0, 0.0, false), &none, false),
        ("shared-initial", "prov", json!({}), vec![bound("shared", "3"), coins.clone(), open.clone()], initial(4.0, 0.0, false), &none, false),
        ("shared-revision", "prov", json!({}), vec![stale, coins.clone(), open.clone()], initial(3.0, 0.0, false), &none, false),
        ("override", "prov", json!({"stamina":"4"}), vec![bound("override", "4"), coins.clone(), open.clone()], initial(4.0, 0.0, false), &none, true),
        ("override-bom-whitespace", "prov", json!({"stamina":"\u{feff}4\u{feff}"}), vec![bound("override", "\u{feff}4\u{feff}"), coins.clone(), open.clone()], initial(4.0, 0.0, false), &none, true),
        ("override-next-line", "prov", json!({"stamina":"\u{0085}4"}), vec![bound("override", "\u{0085}4"), coins.clone(), open.clone()], initial(4.0, 0.0, false), &none, false),
        ("override-plain", "prov", json!({"stamina":"4"}), vec![typed("stamina", "4"), coins.clone(), open.clone()], initial(4.0, 0.0, false), &none, true),
        ("typed-as-shared", "prov", json!({"stamina":"3"}), vec![bound("shared", "3"), coins.clone(), open.clone()], initial(3.0, 0.0, false), &none, false),
        ("override-unbound", "prov", json!({"coins":"5"}), vec![bound("shared", "3"), typed("coins", "5"), open.clone()], initial(3.0, 5.0, false), &none, true),
        ("typed-as-flow", "prov", json!({"coins":"5"}), vec![bound("shared", "3"), coins.clone(), open.clone()], initial(3.0, 0.0, false), &none, false),
        ("candidate", "prov", json!({}), vec![candidate("1"), coins.clone(), open.clone()], initial(1.0, 0.0, false), &with_low, true),
        ("candidate-as-shared", "prov", json!({}), vec![bound("shared", "3"), coins.clone(), open.clone()], initial(3.0, 0.0, false), &with_low, false),
        ("candidate-value", "prov", json!({}), vec![candidate("2"), coins.clone(), open.clone()], initial(2.0, 0.0, false), &with_low, false),
        ("candidate-revision", "prov", json!({}), vec![wrong_candidate, coins.clone(), open.clone()], initial(1.0, 0.0, false), &with_low, false),
        ("candidate-masked-by-typed", "prov", json!({"stamina":"4"}), vec![bound("override", "4"), coins.clone(), open.clone()], initial(4.0, 0.0, false), &with_low, false),
        ("candidate-claims-typed", "prov", json!({"stamina":"4"}), vec![candidate("1"), coins.clone(), open.clone()], initial(1.0, 0.0, false), &with_low, false),
        ("local", "prov-local", json!({}), vec![bound("local", "7"), coins.clone(), open.clone()], initial(7.0, 0.0, false), &none, true),
        ("local-as-shared", "prov-local", json!({}), vec![bound("shared", "3"), coins.clone(), open.clone()], initial(3.0, 0.0, false), &none, false),
        ("candidate-masked-by-local", "prov-local", json!({}), vec![bound("local", "7"), coins.clone(), open.clone()], initial(7.0, 0.0, false), &with_low, false),
        ("candidate-claims-local", "prov-local", json!({}), vec![candidate("1"), coins.clone(), open.clone()], initial(1.0, 0.0, false), &with_low, false),
        ("typed-beats-local", "prov-local", json!({"stamina":"2"}), vec![bound("override", "2"), coins.clone(), open.clone()], initial(2.0, 0.0, false), &none, true),
        ("fake-local", "prov", json!({}), vec![bound("local", "7"), coins.clone(), open.clone()], initial(7.0, 0.0, false), &none, false),
        ("bound-as-flow", "prov", json!({}), vec![flow("stamina", "3"), coins.clone(), open.clone()], initial(3.0, 0.0, false), &none, false),
        ("unbound-as-shared", "prov", json!({}), vec![bound("shared", "3"), unbound_ref, open.clone()], initial(3.0, 0.0, false), &none, false),
        ("flag-text", "prov", json!({}), vec![bound("shared", "3"), coins.clone(), flow("open", "0")], initial(3.0, 0.0, false), &none, false),
        ("flag-initial", "prov", json!({}), vec![bound("shared", "3"), coins.clone(), open.clone()], initial(3.0, 0.0, true), &none, false),
    ];
    let mut saved = 0;
    for (label, flow_id, inputs, sources, initial, candidates, ok) in cases {
        let source = serde_json::to_value(object(&store, &project, flow_id)).unwrap();
        let energy = serde_json::to_value(object(&store, &project, "energy")).unwrap();
        let body = json!({"version":2,"id":fresh_id(),"started":"2026-09-26T00:00:00.000Z","source":source,"dependencies":[energy],"inputs":inputs,
            "initial":initial,"events":[],"input_sources":sources,"candidates":candidates});
        let request = format!("prov-{label}");
        let result = run(&mut store, &project, json!({"op":"save_trial","request_id":request,"id":fresh_id(),"origin":"walkthrough","run":body}));
        assert_eq!(result.is_ok(), ok, "{label}: {result:?}");
        if ok { saved += 1; } else {
            assert_eq!(count_rows(&store, "SELECT COUNT(*) FROM spellcast_project_request_receipts WHERE request_id = ?1", &request), 0, "{label} left a receipt");
        }
    }
    assert_eq!(count_rows(&store, "SELECT COUNT(*) FROM spellcast_project_trials WHERE project_id = ?1", &project), saved, "Rejected trials must not be written");
    cleanup(store, path);
}

fn calc_flow() -> Value {
    let lit = |variable: &str, op: &str, value: &str| json!({"variable_id":variable,"op":op,"operand":{"kind":"literal","value":value}});
    let var = |variable: &str, op: &str, other: &str| json!({"variable_id":variable,"op":op,"operand":{"kind":"variable","value":other}});
    let choice = |id: &str, conditions: Value, effects: Value| json!({"id":id,"label":id,"to":"s2","conditions":conditions,"effects":effects});
    json!({"scopes":["R0"],"flow":{"entry":"s1","variables":[
        {"id":"a","name":"A","value_type":"number","initial":"5","unit":""},{"id":"b","name":"B","value_type":"number","initial":"2","unit":""},
        {"id":"f","name":"F","value_type":"flag","initial":"false","unit":""},{"id":"t","name":"T","value_type":"text","initial":"x","unit":""},
        {"id":"z","name":"Z","value_type":"number","initial":"100780.71428571429","unit":""}],
        "steps":[{"id":"s1","title":"S1","goal":"","action":"","feedback":"","external":false,"terminal":false,"choices":[
            choice("c1", json!([lit("a","gte","3"), lit("f","eq","false"), lit("t","neq","y"), var("a","gt","b")]),
                json!([var("a","subtract","b"), var("b","set","a"), lit("a","add","1"), lit("f","set","true"), lit("t","set","done")])),
            choice("c2", json!([lit("a","lt","0")]), json!([])),
            choice("c3", json!([]), json!([lit("a","add","1e308"), lit("a","add","1.7976931348623157e308")])),
            choice("c4", json!([lit("b","lte","2"), lit("b","lt","3"), var("a","neq","b")]), json!([lit("z","add","0.1"), lit("z","add","0.2"), lit("z","subtract","0.1")]))]},
          {"id":"s2","title":"S2","goal":"","action":"","feedback":"","external":false,"terminal":true,"choices":[]}]}})
}

#[test]
fn trial_choices_are_recomputed_from_the_frozen_definition() {
    let (mut store, path) = temp_store("recompute");
    let project = fixture(&mut store);
    put(&mut store, &project, "calc", 0, "flow", calc_flow()).unwrap();
    let z = "100780.71428571429".parse::<f64>().unwrap();
    let start = json!({"a":5.0,"b":2.0,"f":false,"t":"x","z":z});
    let sources = json!([{"variable_id":"a","value":"5","source":"flow"},{"variable_id":"b","value":"2","source":"flow"},{"variable_id":"f","value":"false","source":"flow"},
        {"variable_id":"t","value":"x","source":"flow"},{"variable_id":"z","value":"100780.71428571429","source":"flow"}]);
    let calc = serde_json::to_value(object(&store, &project, "calc")).unwrap();
    let body = |choice: &str, after: Value| json!({"version":2,"id":fresh_id(),"started":"2026-09-26T00:00:00.000Z","source":calc,"dependencies":[],"inputs":{},
        "initial":start,"input_sources":sources,"events":[{"kind":"choice","from":"s1","to":"s2","label":choice,"choice_id":choice,"before":start,"after":after,"at":"2026-09-26T00:00:01.000Z"}]});
    let with = |changes: Value| { let mut after = start.clone(); for (key, value) in changes.as_object().unwrap() { after[key] = value.clone(); } after };
    // Right-hand operands read the pre-choice state; repeated targets accumulate in order.
    let exact = with(json!({"a":4.0,"b":5.0,"f":true,"t":"done"}));
    let accumulated = ((z + 0.1) + 0.2) - 0.1;
    let cases = [
        ("c1", exact.clone(), true),
        ("c1", with(json!({"a":4.0,"b":3.0,"f":true,"t":"done"})), false),   // b read the updated a
        ("c1", with(json!({"a":6.0,"b":5.0,"f":true,"t":"done"})), false),   // a ignored the earlier subtraction
        ("c1", with(json!({"a":4.0,"b":5.0,"f":true,"t":"other"})), false),
        ("c1", with(json!({"a":4.0,"b":5.0,"f":false,"t":"done"})), false),
        ("c2", start.clone(), false),                                         // guard a < 0 is not satisfied
        ("c3", with(json!({"a":f64::MAX})), false),                           // overflow is never a valid result
        ("c4", with(json!({"z":accumulated})), true),
        ("c4", with(json!({"z":f64::from_bits(accumulated.to_bits() + 1)})), false),
    ];
    for (index, (choice, after, ok)) in cases.into_iter().enumerate() {
        let request = format!("calc-{index}");
        let result = run(&mut store, &project, json!({"op":"save_trial","request_id":request,"id":fresh_id(),"origin":"walkthrough","run":body(choice, after)}));
        assert_eq!(result.is_ok(), ok, "case {index} {choice}: {result:?}");
        if !ok { assert_eq!(count_rows(&store, "SELECT COUNT(*) FROM spellcast_project_request_receipts WHERE request_id = ?1", &request), 0); }
    }
    let unsatisfied = run(&mut store, &project, json!({"op":"save_trial","id":fresh_id(),"origin":"walkthrough","run":body("c2", start.clone())})).unwrap_err();
    assert!(unsatisfied.contains("条件未满足") && unsatisfied.contains("A 小于 0"), "{unsatisfied}");
    // Manual results stay explicit inputs; the following choice is recomputed from them.
    let flow = serde_json::to_value(object(&store, &project, "flow")).unwrap();
    let energy = serde_json::to_value(object(&store, &project, "energy")).unwrap();
    let manual = |after_finish: f64| json!({"version":2,"id":fresh_id(),"started":"2026-09-26T00:00:00.000Z","source":flow,"dependencies":[energy],"inputs":{},"initial":state(3.0),
        "input_sources":[{"variable_id":"stamina","value":"3","source":"shared","parameter_id":"energy","parameter_revision":energy["revision"]}],"events":[
        {"kind":"choice","from":"start","to":"fight","label":"Spend two","choice_id":"go","before":state(3.0),"after":state(1.0),"at":"t1"},
        {"kind":"manual","from":"fight","to":"fight","label":"Manual result","before":state(1.0),"after":state(9.0),"at":"t2"},
        {"kind":"choice","from":"fight","to":"end","label":"Finish","choice_id":"finish","before":state(9.0),"after":state(after_finish),"at":"t3"}]});
    save(&mut store, &project, "manual-input", manual(9.0)).unwrap();
    assert!(save(&mut store, &project, "manual-then-wrong", manual(8.0)).unwrap_err().contains("重算"));
    // Import re-verifies even when a tampered bundle carries a matching, recomputed digest.
    let bundle = store.project_export(&project).unwrap();
    let mut forged = bundle.clone();
    let trial = forged.trials.iter_mut().find(|trial| trial.run.events.first().is_some_and(|event| event.choice_id.as_deref() == Some("c1"))).unwrap();
    trial.run.events[0].after.insert("a".into(), json!(6.0));
    trial.digest = crate::project_trials::trial_digest(&trial.run).unwrap();
    let mut mislabeled = bundle.clone();
    let trial = mislabeled.trials.iter_mut().find(|trial| trial.id == "manual-input").unwrap();
    trial.run.input_sources[0].value = "4".into();
    trial.run.initial.insert("stamina".into(), json!(4.0));
    for event in trial.run.events.iter_mut().take(1) { event.before.insert("stamina".into(), json!(4.0)); event.after.insert("stamina".into(), json!(2.0)); }
    trial.run.events[1].before.insert("stamina".into(), json!(2.0));
    trial.digest = crate::project_trials::trial_digest(&trial.run).unwrap();
    for (label, bad) in [("effects", forged), ("provenance", mislabeled)] {
        let target = fresh_id();
        let error = run(&mut store, &target, json!({"op":"import_project","bundle":bad,"name":"forged"})).unwrap_err();
        assert!(!error.contains("摘要"), "{label} must fail semantic verification, not the digest: {error}");
        assert!(store.project_get(&target).is_err(), "{label}: no partial project");
        for table in ["spellcast_project_objects", "spellcast_project_trials", "spellcast_project_history", "spellcast_project_candidates"] {
            assert_eq!(count_rows(&store, &format!("SELECT COUNT(*) FROM {table} WHERE project_id = ?1"), &target), 0, "{label}: {table}");
        }
    }
    let target = fresh_id();
    run(&mut store, &target, json!({"op":"import_project","bundle":bundle,"name":"verified copy"})).unwrap();
    assert_eq!(store.project_trials(&target, "").unwrap().len(), 3);
    cleanup(store, path);
}

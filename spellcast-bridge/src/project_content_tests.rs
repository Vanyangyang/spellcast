//! Isolated project-content contract tests. Each fixture uses its own temporary database.
use crate::project_records::{ProjectExport, RecordActor, RecordChange, RecordCommand};
use crate::store::Store;
use serde_json::{json, Value};
use std::path::PathBuf;
use uuid::Uuid;

struct Fixture {
    store: Option<Store>,
    path: PathBuf,
    project: String,
}

impl Fixture {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!("spellcast-content-{}.sqlite3", Uuid::new_v4()));
        let store = Store::open(&path).expect("open isolated store");
        let project = Uuid::new_v4().to_string();
        let mut fixture = Self { store: Some(store), path, project };
        fixture.change(RecordChange::CreateProject { name: "Content fixture".into(), aliases: vec![] })
            .expect("create project");
        fixture
    }

    fn store(&self) -> &Store { self.store.as_ref().unwrap() }
    fn store_mut(&mut self) -> &mut Store { self.store.as_mut().unwrap() }

    fn change(&mut self, change: RecordChange) -> Result<crate::project_records::RecordMutationResult, String> {
        let command = RecordCommand { request_id: Uuid::new_v4().to_string(), project_id: self.project.clone(), change };
        self.store_mut().project_mutate(&command, &actor())
    }

    fn put(&mut self, revision: u64, planning: Option<Value>) -> Result<crate::project_records::RecordMutationResult, String> {
        self.change(RecordChange::PutObject {
            id: "content".into(), expected_revision: revision, name: "Content".into(),
            kind: "content".into(), archived: false,
            planning: planning.map(|value| serde_json::from_value(value).unwrap()),
        })
    }

    fn export(&self) -> ProjectExport { self.store().project_export(&self.project).unwrap() }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        self.store.take();
        let _ = std::fs::remove_file(&self.path);
    }
}

fn actor() -> RecordActor {
    RecordActor { kind: "user".into(), source_id: None, thread_id: None, cwd: None, label: "Content test".into() }
}

fn sections() -> Value {
    json!({"scopes":["R0"],"sections":[
        {"id":"first","text":"# Opening\nA paragraph.","references":[{"label":"spec","uri":"https://example.test/spec","version":"v1"}]},
        {"id":"question","role":"question","text":"What happens next?"}
    ]})
}

fn import(fixture: &mut Fixture, bundle: ProjectExport) -> Result<(), String> {
    fixture.change(RecordChange::ImportProject { bundle, name: "Imported".into() }).map(|_| ())
}

#[test]
fn content_create_edit_omissions_clear_lock_and_history_restore() {
    let mut fixture = Fixture::new();
    let created = fixture.put(0, Some(sections())).unwrap().object.unwrap();
    let initial = created.planning.unwrap();
    assert_eq!(initial.sections.as_ref().unwrap()[0].role, crate::project_planning::ContentSectionRole::Body);
    assert!(initial.sections.as_ref().unwrap()[1].references.is_empty());
    assert!(initial.body.is_empty());

    // A whole omitted planning payload preserves sections. A partial planning payload cannot erase them.
    let renamed = fixture.put(1, None).unwrap().object.unwrap();
    assert_eq!(renamed.planning.as_ref().unwrap().sections, initial.sections);
    let error = fixture.put(2, Some(json!({"scopes":["R0"],"body":"accidental downgrade"}))).unwrap_err();
    assert!(error.contains("sections"), "{error}");
    assert!(fixture.put(1, Some(sections())).unwrap_err().contains("revision"));
    assert_eq!(fixture.export().history.iter().filter(|entry| entry.kind.as_str() == "object").count(), 2);

    let mut edited = sections();
    edited["sections"][0]["text"] = json!("# Changed\nStill Markdown.");
    let revised = fixture.put(2, Some(edited)).unwrap().object.unwrap();
    assert_eq!(revised.planning.unwrap().sections.unwrap()[0].text, "# Changed\nStill Markdown.");
    let locked = fixture.change(RecordChange::SetObjectLock { id: "content".into(), expected_revision: 3, locked: true }).unwrap().object.unwrap();
    assert!(locked.planning.unwrap().locked);
    assert!(fixture.put(4, Some(json!({"scopes":["R0"],"sections":[]}))).unwrap_err().contains("已锁定"));
    fixture.change(RecordChange::SetObjectLock { id: "content".into(), expected_revision: 4, locked: false }).unwrap();

    let empty = fixture.put(5, Some(json!({"scopes":["R0"],"sections":[]}))).unwrap().object.unwrap();
    assert!(empty.planning.unwrap().sections.unwrap().is_empty());
    assert_eq!(fixture.export().version, 4); // Historical sections still require v4.
    let restored = fixture.change(RecordChange::RestoreObject { id: "content".into(), expected_revision: 6, restore_revision: 1 }).unwrap().object.unwrap();
    assert_eq!(restored.planning.unwrap().sections, initial.sections);
    assert_eq!(fixture.store().project_history(&fixture.project, "object", "content").unwrap().len(), 7);
}

#[test]
fn legacy_body_can_be_explicitly_restored_after_conversion() {
    let mut fixture = Fixture::new();
    let original = "Old Markdown\n\nwith exact spacing  ";
    fixture.put(0, Some(json!({"scopes":["R0"],"body":original}))).unwrap();
    fixture.put(1, Some(json!({"scopes":["R0"],"sections":[{"id":"converted","text":original}]}))).unwrap();
    let restored = fixture.change(RecordChange::RestoreObject { id: "content".into(), expected_revision: 2, restore_revision: 1 }).unwrap().object.unwrap();
    assert_eq!(restored.planning.unwrap().body, original);
    assert_eq!(fixture.export().version, 4);
}

#[test]
fn content_validation_rejects_invalid_shapes_and_references_without_writes() {
    let mut fixture = Fixture::new();
    let mut bad = vec![
        json!({"scopes":["R0"],"body":"duplicate","sections":[]}),
        json!({"scopes":["R0"],"sections":[{"id":" ","text":"ok"}]}),
        json!({"scopes":["R0"],"sections":[{"id":"a","text":"ok"},{"id":"a","text":"again"}]}),
        json!({"scopes":["R0"],"sections":[{"id":"a","role":"question","text":"x","references":[{"label":"bad","uri":"javascript:alert(1)"}]}]}),
        json!({"scopes":["R0"],"sections":[{"id":"a","text":"x".repeat(32 * 1024 + 1)}]}),
    ];
    bad.push(json!({"scopes":["R0"],"sections":(0..5).map(|i| json!({"id":format!("s{i}"),"text":"x".repeat(32 * 1024)})).collect::<Vec<_>>()}));
    bad.push(json!({"scopes":["R0"],"sections":(0..129).map(|i| json!({"id":format!("s{i}"),"text":"ok"})).collect::<Vec<_>>()}));
    for planning in bad { assert!(fixture.put(0, Some(planning)).is_err()); }
    assert!(fixture.export().objects.is_empty());
    assert!(fixture.export().history.iter().all(|entry| entry.kind.as_str() != "object"));

    let command = RecordChange::PutObject { id: "rule".into(), expected_revision: 0, name: "Rule".into(), kind: "rule".into(), archived: false,
        planning: Some(serde_json::from_value(sections()).unwrap()) };
    assert!(fixture.change(command).unwrap_err().contains("只有内容对象"));
}

#[test]
fn export_import_preserve_sections_refs_history_and_versions() {
    let mut source = Fixture::new();
    source.put(0, Some(sections())).unwrap();
    let mut bundle = source.export();
    assert_eq!(bundle.version, 4);
    assert_eq!(bundle.external_files.len(), 1);
    assert_eq!(bundle.external_files[0].uri, "https://example.test/spec");
    let mut current_target = Fixture::new();
    current_target.project = Uuid::new_v4().to_string();
    import(&mut current_target, bundle.clone()).unwrap();
    assert_eq!(current_target.export().objects[0].planning.as_ref().unwrap().sections.as_ref().unwrap()[0].text, "# Opening\nA paragraph.");
    source.put(1, Some(json!({"scopes":["R0"],"sections":[]}))).unwrap();
    source.change(RecordChange::SetObjectLock { id: "content".into(), expected_revision: 2, locked: true }).unwrap();
    bundle = source.export();
    assert_eq!(bundle.version, 4);
    assert_eq!(bundle.external_files.len(), 1); // Reference lives only in history now.

    let mut target = Fixture::new();
    // Imports require a fresh target ID, not the project already created by Fixture.
    target.project = Uuid::new_v4().to_string();
    import(&mut target, bundle.clone()).unwrap();
    let imported = target.export();
    assert_eq!(imported.version, 4);
    assert_eq!(imported.objects[0].planning.as_ref().unwrap().sections, Some(vec![]));
    assert!(imported.objects[0].planning.as_ref().unwrap().locked);
    assert!(target.put(3, None).unwrap_err().contains("已锁定"));
    assert_eq!(imported.history.iter().find(|entry| entry.kind.as_str() == "object" && entry.revision == 1).unwrap().snapshot["planning"]["sections"][0]["text"], "# Opening\nA paragraph.");
    assert_eq!(imported.external_files, bundle.external_files);

    for version in 1..=3 {
        let mut disguised = bundle.clone();
        disguised.version = version;
        let mut rejected = Fixture::new();
        rejected.project = Uuid::new_v4().to_string();
        let error = import(&mut rejected, disguised).unwrap_err();
        assert!(error.contains("v4"), "version {version}: {error}");
        assert!(rejected.store().project_get(&rejected.project).is_err());
    }
}

#[test]
fn content_request_receipt_replays_only_the_same_payload() {
    let mut fixture = Fixture::new();
    let command = RecordCommand {
        request_id: Uuid::new_v4().to_string(), project_id: fixture.project.clone(),
        change: RecordChange::PutObject {
            id: "content".into(), expected_revision: 0, name: "Content".into(),
            kind: "content".into(), archived: false,
            planning: Some(serde_json::from_value(sections()).unwrap()),
        },
    };
    let first = fixture.store_mut().project_mutate(&command, &actor()).unwrap();
    let replay = fixture.store_mut().project_mutate(&command, &actor()).unwrap();
    assert_eq!(first.object, replay.object);
    assert!(replay.replayed);
    let mut changed = command;
    if let RecordChange::PutObject { name, .. } = &mut changed.change { *name = "Other".into(); }
    assert!(fixture.store_mut().project_mutate(&changed, &actor()).is_err());
    assert_eq!(fixture.store().project_history(&fixture.project, "object", "content").unwrap().len(), 1);
}

#[test]
fn legacy_export_versions_remain_importable() {
    let mut v1 = Fixture::new();
    let bundle_v1 = v1.export();
    assert_eq!(bundle_v1.version, 1);
    let mut target = Fixture::new(); target.project = Uuid::new_v4().to_string();
    import(&mut target, bundle_v1).unwrap();

    v1.put(0, Some(json!({"scopes":["R0"],"body":"old"}))).unwrap();
    let bundle_v2 = v1.export();
    assert_eq!(bundle_v2.version, 2);
    for version in [2, 3] {
        let mut bundle = bundle_v2.clone(); bundle.version = version;
        let mut imported = Fixture::new(); imported.project = Uuid::new_v4().to_string();
        import(&mut imported, bundle).unwrap();
        assert_eq!(imported.export().objects[0].planning.as_ref().unwrap().body, "old");
    }
}

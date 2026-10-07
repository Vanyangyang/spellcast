//! Synthetic database/mock-OS tests only. No native grant, credential, service,
//! model, observer, repository scan or external process is used.
use super::*;
use crate::Headless;
use std::{
    path::PathBuf,
    sync::{Arc, Barrier},
};

struct Fixture {
    root: PathBuf,
    bridge: Option<Arc<Bridge>>,
    project: String,
}
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "spellcast-client-synthetic-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir(&root).unwrap();
        let bridge = Arc::new(Bridge::open(Headless, 0, root.join("state.sqlite3")).unwrap());
        let project = uuid::Uuid::new_v4().to_string();
        bridge.project_user_mutate(serde_json::from_value(json!({"op":"create_project","request_id":"fixture-project","project_id":project,"name":"Synthetic","aliases":[]})).unwrap()).unwrap();
        Self {
            root,
            bridge: Some(bridge),
            project,
        }
    }
    fn b(&self) -> &Bridge {
        self.bridge.as_ref().unwrap()
    }
    fn restart(&mut self) {
        drop(self.bridge.take());
        self.bridge = Some(Arc::new(
            Bridge::open(Headless, 0, self.root.join("state.sqlite3")).unwrap(),
        ));
    }
    fn count(&self, table: &str) -> u64 {
        self.b()
            .project_store()
            .unwrap()
            .connection
            .query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r.get(0))
            .unwrap()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        drop(self.bridge.take());
        let _ = std::fs::remove_dir_all(&self.root);
    }
}
fn peer() -> OsClient {
    OsClient::from_verified_os(
        ClientIdentity {
            path: "C:\\Synthetic\\ccgui-next.exe".into(),
            sha256: "a".repeat(64),
            sid: "S-1-5-21-100-200-300-1001".into(),
            file_id: "00000001-00000002-00000003".into(),
        },
        101,
        100_000_000,
    )
    .unwrap()
}
fn scopes() -> ClientScopes {
    ClientScopes {
        records: true,
        sigil_drafts: true,
    }
}
fn session(b: &Bridge, p: &OsClient) -> ClientSession {
    let reply = b.client_handle(p, ClientRequest::Status { protocol: PROTOCOL });
    assert!(reply.ok);
    let v = reply.data.unwrap();
    ClientSession {
        server_epoch: v["server_epoch"].as_str().unwrap().into(),
        process_stamp: v["process_stamp"].as_str().unwrap().into(),
        grant_id: v["grant"]["id"].as_str().unwrap_or("").into(),
        generation: v["grant"]["generation"].as_u64().unwrap_or(0),
    }
}
fn approve(f: &Fixture, p: &OsClient, s: ClientScopes) -> ClientSession {
    f.b().client_approve(p, 0, s).unwrap();
    session(f.b(), p)
}
fn record(f: &Fixture, id: &str, revision: u64, title: &str) -> ClientChange {
    ClientChange::PutRecord {
        project_id: f.project.clone(),
        id: id.into(),
        expected_revision: revision,
        fields: serde_json::from_value(json!({"title":title,"status":"active"})).unwrap(),
    }
}
fn save(
    b: &Bridge,
    p: &OsClient,
    s: &ClientSession,
    id: &str,
    change: ClientChange,
) -> ClientReply {
    b.client_handle(
        p,
        ClientRequest::Save {
            protocol: PROTOCOL,
            session: s.clone(),
            request_id: id.into(),
            change,
        },
    )
}
fn receipt(b: &Bridge, p: &OsClient, s: &ClientSession, id: &str) -> ClientReply {
    b.client_handle(
        p,
        ClientRequest::Receipt {
            protocol: PROTOCOL,
            session: s.clone(),
            request_id: id.into(),
        },
    )
}
fn code(r: ClientReply) -> String {
    assert!(!r.ok);
    r.error.unwrap()["code"].as_str().unwrap().into()
}
fn plan(f: &Fixture) -> SigilPlan {
    serde_json::from_value(json!({"title":"Synthetic draft","goal":"save only","repository":f.root.join("never-created-repository"),
    "steps":[{"id":"one","title":"No execution","inputs":["private-never-read.txt"],"checks":[{"kind":"command","label":"must not launch","argv":["FORBIDDEN_PROCESS_SENTINEL"],"timeout_s":1}]}]})).unwrap()
}

#[test]
fn discovery_and_legacy_access_never_create_application_grants() {
    let f = Fixture::new();
    let p = peer();
    assert!(f.b().client_grants().unwrap().is_empty());
    let r = f
        .b()
        .client_handle(&p, ClientRequest::Status { protocol: PROTOCOL });
    assert_eq!(r.data.unwrap()["granted"], false);
    f.b().project_store().unwrap().connection.execute("INSERT INTO spellcast_project_access(id,project_id,token_hash,value) VALUES('legacy',?1,'synthetic-no-credential','{}')",[&f.project]).unwrap();
    let s = session(f.b(), &p);
    assert_eq!(
        code(save(f.b(), &p, &s, "absent", record(&f, "one", 0, "no"))),
        "grant_required"
    );
    assert_eq!(f.count("spellcast_client_grants"), 0);
    assert_eq!(f.count("spellcast_project_records"), 0);
}
#[test]
fn scopes_are_enforced_at_each_save_and_receipt() {
    let f = Fixture::new();
    let p = peer();
    let s = approve(
        &f,
        &p,
        ClientScopes {
            records: true,
            sigil_drafts: false,
        },
    );
    assert_eq!(
        code(save(
            f.b(),
            &p,
            &s,
            "draft",
            ClientChange::SigilCreate { plan: plan(&f) }
        )),
        "scope_denied"
    );
    assert!(save(f.b(), &p, &s, "record", record(&f, "one", 0, "yes")).ok);
    f.b()
        .client_approve(
            &p,
            1,
            ClientScopes {
                records: false,
                sigil_drafts: true,
            },
        )
        .unwrap();
    let s2 = session(f.b(), &p);
    assert_eq!(code(receipt(f.b(), &p, &s2, "record")), "scope_denied");
    assert_eq!(
        code(save(f.b(), &p, &s2, "record2", record(&f, "two", 0, "no"))),
        "scope_denied"
    );
}
#[test]
fn approval_and_revocation_require_exact_policy_revision() {
    let f = Fixture::new();
    let p = peer();
    assert_eq!(
        f.b()
            .client_approve(&p, 0, ClientScopes::default())
            .unwrap_err(),
        ClientError::ScopeDenied
    );
    let g = f.b().client_approve(&p, 0, scopes()).unwrap();
    assert_eq!(
        f.b().client_approve(&p, 0, scopes()).unwrap_err(),
        ClientError::Conflict
    );
    assert_eq!(
        f.b().client_revoke(&g.id, 0).unwrap_err(),
        ClientError::Conflict
    );
    let revoked = f.b().client_revoke(&g.id, 1).unwrap();
    assert_eq!(revoked.generation, 2);
    assert_eq!(
        f.b().client_revoke(&g.id, 1).unwrap_err(),
        ClientError::Conflict
    );
}
#[test]
fn identity_hash_file_and_sid_changes_fail_closed() {
    let f = Fixture::new();
    let p = peer();
    let s = approve(&f, &p, scopes());
    for (field, value) in [
        ("hash", "b".repeat(64)),
        ("file", "00000004".into()),
        ("sid", "S-1-5-21-100-200-300-1002".into()),
        ("path", "C:\\Other\\ccgui-next.exe".into()),
    ] {
        let mut changed = p.clone();
        match field {
            "hash" => changed.identity.sha256 = value,
            "file" => changed.identity.file_id = value,
            "sid" => changed.identity.sid = value,
            _ => changed.identity.path = value,
        }
        let changed_session = session(f.b(), &changed);
        let r = save(
            f.b(),
            &changed,
            &changed_session,
            "spoof",
            record(&f, "one", 0, "no"),
        );
        assert!(matches!(
            code(r).as_str(),
            "identity_changed" | "grant_required"
        ));
    }
    assert_eq!(
        code(save(
            f.b(),
            &p,
            &ClientSession {
                grant_id: "forged".into(),
                ..s
            },
            "spoof2",
            record(&f, "one", 0, "no")
        )),
        "stale_session"
    );
    assert_eq!(f.count("spellcast_project_records"), 0);
}
#[test]
fn pid_reuse_and_new_process_require_new_status() {
    let f = Fixture::new();
    let p = peer();
    let s = approve(&f, &p, scopes());
    let mut reused = p.clone();
    reused.created_at += 1;
    assert_eq!(
        code(save(
            f.b(),
            &reused,
            &s,
            "old-process",
            record(&f, "one", 0, "no")
        )),
        "stale_session"
    );
    let new_session = session(f.b(), &reused);
    assert!(
        save(
            f.b(),
            &reused,
            &new_session,
            "new-process",
            record(&f, "one", 0, "yes")
        )
        .ok
    );
}
#[test]
fn restart_invalidates_old_epoch_but_preserves_explicit_grant() {
    let mut f = Fixture::new();
    let p = peer();
    let old = approve(&f, &p, scopes());
    assert!(save(f.b(), &p, &old, "saved", record(&f, "one", 0, "yes")).ok);
    f.restart();
    assert_eq!(code(receipt(f.b(), &p, &old, "saved")), "stale_session");
    let fresh = session(f.b(), &p);
    assert_ne!(fresh.server_epoch, old.server_epoch);
    assert_eq!(
        receipt(f.b(), &p, &fresh, "saved").data.unwrap()["state"],
        "committed"
    );
    assert_eq!(f.b().client_grants().unwrap().len(), 1);
}
#[test]
fn generation_rotation_invalidates_sessions_and_old_image() {
    let f = Fixture::new();
    let p = peer();
    let old = approve(&f, &p, scopes());
    f.b().client_approve(&p, 1, scopes()).unwrap();
    assert_eq!(
        code(save(f.b(), &p, &old, "old", record(&f, "one", 0, "no"))),
        "stale_session"
    );
    let mut updated = p.clone();
    updated.identity.sha256 = "b".repeat(64);
    f.b().client_approve(&updated, 2, scopes()).unwrap();
    assert_eq!(
        code(save(
            f.b(),
            &p,
            &session(f.b(), &p),
            "old-image",
            record(&f, "one", 0, "no")
        )),
        "identity_changed"
    );
    assert!(
        save(
            f.b(),
            &updated,
            &session(f.b(), &updated),
            "updated",
            record(&f, "one", 0, "yes")
        )
        .ok
    );
}
#[test]
fn record_cas_and_body_bound_receipts_prevent_replay_mutation() {
    let f = Fixture::new();
    let p = peer();
    let s = approve(&f, &p, scopes());
    let c = record(&f, "one", 0, "first");
    assert!(save(f.b(), &p, &s, "create", c.clone()).ok);
    assert_eq!(
        save(f.b(), &p, &s, "create", c).data.unwrap()["replayed"],
        true
    );
    assert_eq!(
        code(save(
            f.b(),
            &p,
            &s,
            "create",
            record(&f, "one", 0, "different")
        )),
        "idempotency_conflict"
    );
    for rev in [0, 2] {
        assert_eq!(
            code(save(f.b(), &p, &s, "bad-cas", record(&f, "one", rev, "no"))),
            "conflict"
        );
    }
    assert!(save(f.b(), &p, &s, "update", record(&f, "one", 1, "second")).ok);
    assert_eq!(f.count("spellcast_project_records"), 1);
    assert_eq!(f.count("spellcast_client_receipts"), 2);
}
#[test]
fn request_ids_and_receipts_are_isolated_by_client_grant() {
    let f = Fixture::new();
    let p = peer();
    let s = approve(&f, &p, scopes());
    assert!(save(f.b(), &p, &s, "same-id", record(&f, "one", 0, "first")).ok);
    let mut other = p.clone();
    other.identity.path = "C:\\Other\\ccgui-next.exe".into();
    let other_session = approve(&f, &other, scopes());
    assert_eq!(
        receipt(f.b(), &other, &other_session, "same-id")
            .data
            .unwrap()["state"],
        "not_found"
    );
    assert!(
        save(
            f.b(),
            &other,
            &other_session,
            "same-id",
            record(&f, "two", 0, "second")
        )
        .ok
    );
    assert_eq!(f.count("spellcast_client_receipts"), 2);
}
#[test]
fn record_association_cannot_create_objects_or_link_another_project() {
    let f = Fixture::new();
    let p = peer();
    let s = approve(&f, &p, scopes());
    let mut c = record(&f, "one", 0, "bad-association");
    if let ClientChange::PutRecord { fields, .. } = &mut c {
        fields.object_id = Some("absent-object".into());
    }
    assert_eq!(code(save(f.b(), &p, &s, "bad", c)), "invalid_request");
    assert_eq!(f.count("spellcast_project_records"), 0);
    assert_eq!(f.count("spellcast_project_objects"), 0);
}
#[test]
fn sigil_save_is_pure_and_fixed_card_is_atomic_and_idempotent() {
    let f = Fixture::new();
    let p = peer();
    let s = approve(&f, &p, scopes());
    let c = ClientChange::SigilCreate { plan: plan(&f) };
    let r = save(f.b(), &p, &s, "create-draft", c.clone());
    assert!(r.ok, "{r:?}");
    let data = r.data.unwrap();
    let id = data["sigil_id"].as_str().unwrap();
    assert!(data.get("review").is_none());
    assert_eq!(data["sigil"]["owner_source"], "");
    assert_eq!(data["sigil"]["updated_by"]["kind"], "client");
    assert_eq!(f.count("spellcast_sigils"), 1);
    assert_eq!(
        f.b()
            .board()
            .canvas
            .objects
            .iter()
            .filter(|o| o.id == format!("sigil-{id}"))
            .count(),
        1
    );
    assert_eq!(
        save(f.b(), &p, &s, "create-draft", c).data.unwrap()["sigil_id"],
        id
    );
    assert!(!f.root.join("never-created-repository").exists());
    let mut next = plan(&f);
    next.title = "new title".into();
    assert!(
        save(
            f.b(),
            &p,
            &s,
            "update-draft",
            ClientChange::SigilPutPlan {
                id: id.into(),
                expected_revision: 1,
                plan: next
            }
        )
        .ok
    );
    assert_eq!(f.count("spellcast_sigils"), 1);
}
#[test]
fn sigil_material_revision_must_exist_and_match() {
    let f = Fixture::new();
    let p = peer();
    let s = approve(&f, &p, scopes());
    let mut plan = plan(&f);
    plan.materials = vec![crate::sigils::SigilMaterial {
        object_id: "missing".into(),
        content_revision: 1,
    }];
    assert_eq!(
        code(save(
            f.b(),
            &p,
            &s,
            "missing-material",
            ClientChange::SigilCreate { plan }
        )),
        "conflict"
    );
    assert_eq!(f.count("spellcast_sigils"), 0);
    assert_eq!(f.count("spellcast_client_receipts"), 0);
}
#[test]
fn valid_canvas_materials_are_references_and_stale_versions_conflict() {
    let f = Fixture::new();
    let p = peer();
    let s = approve(&f, &p, scopes());
    f.b()
        .update(|state| {
            let request = CanvasBatchRequest {
                request_id: "fixture-material".into(),
                reads: vec![],
                feedback_sequences: vec![],
                operations: vec![CanvasOperation::Create {
                    id: "material".into(),
                    content: CanvasContent::Text {
                        title: "Synthetic".into(),
                        text: "not copied into plan".into(),
                    },
                    origin: None,
                    bindings: vec![],
                    placement: CanvasPlacementFields::default(),
                }],
            };
            state.session.apply_canvas_batch(request, None)?;
            Ok(())
        })
        .unwrap();
    let mut plan = plan(&f);
    plan.materials = vec![crate::sigils::SigilMaterial {
        object_id: "material".into(),
        content_revision: 1,
    }];
    assert!(
        save(
            f.b(),
            &p,
            &s,
            "material-save",
            ClientChange::SigilCreate { plan: plan.clone() }
        )
        .ok
    );
    f.b()
        .update(|state| {
            state
                .session
                .board
                .canvas
                .objects
                .iter_mut()
                .find(|o| o.id == "material")
                .unwrap()
                .content_revision = 2;
            Ok(())
        })
        .unwrap();
    assert_eq!(
        code(save(
            f.b(),
            &p,
            &s,
            "material-stale",
            ClientChange::SigilCreate { plan: plan.clone() }
        )),
        "conflict"
    );
    plan.materials[0].content_revision = 2;
    assert!(
        save(
            f.b(),
            &p,
            &s,
            "material-current",
            ClientChange::SigilCreate { plan }
        )
        .ok
    );
    assert_eq!(f.count("spellcast_sigils"), 2);
}
#[test]
fn delegated_editor_preserves_agent_authorship_and_refuses_frozen_state() {
    let f = Fixture::new();
    let p = peer();
    let s = approve(&f, &p, scopes());
    let data = save(
        f.b(),
        &p,
        &s,
        "draft",
        ClientChange::SigilCreate { plan: plan(&f) },
    )
    .data
    .unwrap();
    let id = data["sigil_id"].as_str().unwrap();
    {
        let db = f.b().project_store().unwrap();
        db.connection.execute("UPDATE spellcast_sigils SET value_json=json_set(value_json,'$.owner_source','agent:original') WHERE id=?1",[id]).unwrap();
    }
    let edit = save(
        f.b(),
        &p,
        &s,
        "edit",
        ClientChange::SigilPutPlan {
            id: id.into(),
            expected_revision: 1,
            plan: plan(&f),
        },
    );
    assert_eq!(
        edit.data.unwrap()["sigil"]["owner_source"],
        "agent:original"
    );
    {
        let db = f.b().project_store().unwrap();
        db.connection.execute("UPDATE spellcast_sigils SET state='frozen',value_json=json_set(value_json,'$.state','frozen') WHERE id=?1",[id]).unwrap();
    }
    assert_eq!(
        code(save(
            f.b(),
            &p,
            &s,
            "frozen-edit",
            ClientChange::SigilPutPlan {
                id: id.into(),
                expected_revision: 2,
                plan: plan(&f)
            }
        )),
        "not_draft"
    );
}
#[test]
fn failed_card_commit_rolls_back_draft_history_receipt_and_memory() {
    let f = Fixture::new();
    let p = peer();
    let s = approve(&f, &p, scopes());
    f.b().project_store().unwrap().connection.execute_batch("CREATE TRIGGER synthetic_card_failure BEFORE INSERT ON spellcast_state BEGIN SELECT RAISE(ABORT,'SECRET_SQL_SENTINEL'); END;").unwrap();
    let reply = save(
        f.b(),
        &p,
        &s,
        "rollback",
        ClientChange::SigilCreate { plan: plan(&f) },
    );
    assert!(!serde_json::to_string(&reply)
        .unwrap()
        .contains("SECRET_SQL_SENTINEL"));
    assert_eq!(code(reply), "storage_unavailable");
    assert_eq!(f.count("spellcast_sigils"), 0);
    assert_eq!(f.count("spellcast_sigil_plan_history"), 0);
    assert_eq!(f.count("spellcast_client_receipts"), 0);
    assert!(f.b().board().canvas.objects.is_empty());
}
#[test]
fn committed_but_lost_reply_is_recovered_by_receipt_without_resend() {
    let mut f = Fixture::new();
    let p = peer();
    let s = approve(&f, &p, scopes());
    drop(save(
        f.b(),
        &p,
        &s,
        "lost-reply",
        record(&f, "one", 0, "once"),
    )); // simulate disconnect after commit
    f.restart();
    let fresh = session(f.b(), &p);
    assert_eq!(
        receipt(f.b(), &p, &fresh, "lost-reply").data.unwrap()["state"],
        "committed"
    );
    assert_eq!(f.count("spellcast_project_records"), 1);
    assert_eq!(f.count("spellcast_client_receipts"), 1);
}
#[test]
fn revoked_client_cannot_write_or_read_previous_receipts() {
    let f = Fixture::new();
    let p = peer();
    let s = approve(&f, &p, scopes());
    assert!(save(f.b(), &p, &s, "committed", record(&f, "one", 0, "keep")).ok);
    f.b().client_revoke(&s.grant_id, 1).unwrap();
    assert_eq!(code(receipt(f.b(), &p, &s, "committed")), "revoked");
    assert_eq!(
        code(save(f.b(), &p, &s, "after", record(&f, "two", 0, "deny"))),
        "revoked"
    );
    assert_eq!(f.count("spellcast_project_records"), 1);
}
#[test]
fn concurrent_revoke_and_save_have_a_single_commit_order() {
    for _ in 0..8 {
        let f = Fixture::new();
        let p = peer();
        let s = approve(&f, &p, scopes());
        let barrier = Arc::new(Barrier::new(3));
        let b = f.bridge.as_ref().unwrap().clone();
        let gate = barrier.clone();
        let c = record(&f, "one", 0, "raced");
        let ps = p.clone();
        let ss = s.clone();
        let writer = std::thread::spawn(move || {
            gate.wait();
            save(&b, &ps, &ss, "race", c)
        });
        let b = f.bridge.as_ref().unwrap().clone();
        let gate = barrier.clone();
        let grant = s.grant_id.clone();
        let revoker = std::thread::spawn(move || {
            gate.wait();
            b.client_revoke(&grant, 1).unwrap()
        });
        barrier.wait();
        let result = writer.join().unwrap();
        revoker.join().unwrap();
        assert_eq!(
            f.count("spellcast_project_records"),
            if result.ok { 1 } else { 0 }
        );
        if result.ok {
            let db = f.b().project_store().unwrap();
            let order:bool=db.connection.query_row("SELECT (SELECT seq FROM spellcast_client_audit WHERE operation='put_record' AND result='committed') < (SELECT seq FROM spellcast_client_audit WHERE operation='revoke')",[],|r|r.get(0)).unwrap();
            assert!(order);
        } else {
            assert_eq!(code(result), "revoked");
        }
    }
}
#[test]
fn audit_contains_only_metadata_and_failure_codes_are_redacted() {
    let f = Fixture::new();
    let p = peer();
    let s = approve(&f, &p, scopes());
    assert!(
        save(
            f.b(),
            &p,
            &s,
            "audit-request",
            record(&f, "one", 0, "PRIVATE_BODY_ENV_SECRET_SENTINEL")
        )
        .ok
    );
    let db = f.b().project_store().unwrap();
    let mut stmt=db.connection.prepare("SELECT at_ms,grant_id,generation,operation,request_hash,result FROM spellcast_client_audit").unwrap();
    let dump = stmt
        .query_map([], |r| {
            Ok(format!(
                "{}:{}:{}:{}:{}:{}",
                r.get::<_, u64>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, u64>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, String>(4)?,
                r.get::<_, String>(5)?
            ))
        })
        .unwrap()
        .map(Result::unwrap)
        .collect::<Vec<_>>()
        .join("\n");
    for absent in [
        "PRIVATE_BODY_ENV_SECRET_SENTINEL",
        "audit-request",
        "C:\\Synthetic",
        "token",
        "environment",
    ] {
        assert!(!dump.contains(absent));
    }
}
#[test]
fn protocol_rejects_anonymous_impersonation_and_out_of_scope_commands() {
    for op in [
        "freeze",
        "start",
        "execute",
        "dispatch",
        "put_object",
        "archive_record",
        "model",
        "observer",
        "invoke",
        "http",
    ] {
        assert!(
            ClientRequest::decode(json!({"op":op,"protocol":1}).to_string().as_bytes()).is_err()
        );
        assert!(ClientRequest::decode(
            json!({"op":"save","protocol":1,"session":{},"request_id":"bad","change":{"op":op}})
                .to_string()
                .as_bytes()
        )
        .is_err());
    }
    for extra in [
        "identity",
        "pid",
        "window_key",
        "access_token",
        "origin",
        "scope",
        "url",
    ] {
        let mut wire = json!({"op":"status","protocol":1});
        wire[extra] = json!("forged");
        assert!(ClientRequest::decode(wire.to_string().as_bytes()).is_err());
    }
    assert!(ClientRequest::decode(&vec![b'x'; MAX_FRAME + 1]).is_err());
}
#[test]
fn protocol_rejects_nested_authority_and_execution_fields() {
    let f = Fixture::new();
    let p = peer();
    let s = approve(&f, &p, scopes());
    let wire = ClientRequest::Save {
        protocol: 1,
        session: s,
        request_id: "wire".into(),
        change: ClientChange::SigilCreate { plan: plan(&f) },
    };
    let value = serde_json::to_value(wire).unwrap();
    assert!(ClientRequest::decode(value.to_string().as_bytes()).is_ok());
    for key in [
        "state",
        "freeze",
        "run",
        "actor",
        "owner_source",
        "approved_commands",
        "grant",
    ] {
        let mut v = value.clone();
        v["change"]["plan"][key] = json!(true);
        assert!(ClientRequest::decode(v.to_string().as_bytes()).is_err());
    }
    let mut v = value.clone();
    v["change"]["plan"]["steps"][0]["checks"][0]["approved"] = json!(true);
    assert!(ClientRequest::decode(v.to_string().as_bytes()).is_err());
    let mut v = value;
    v["session"]["identity"] = json!("ccgui");
    assert!(ClientRequest::decode(v.to_string().as_bytes()).is_err());
}

#[test]
fn importing_data_revokes_delegation_and_preserves_committed_receipts() {
    let f = Fixture::new();
    let p = peer();
    let s = approve(&f, &p, scopes());
    assert!(
        save(
            f.b(),
            &p,
            &s,
            "before-import",
            record(&f, "one", 0, "preserved")
        )
        .ok
    );
    {
        let mut db = f.b().project_store().unwrap();
        revoke_imported_grants(&mut db.connection).unwrap();
    }
    assert_eq!(code(receipt(f.b(), &p, &s, "before-import")), "revoked");
    assert_eq!(f.count("spellcast_project_records"), 1);
    assert_eq!(f.count("spellcast_client_receipts"), 1);
    assert_eq!(f.b().client_grants().unwrap()[0].generation, 2);
    let mut legacy = Connection::open_in_memory().unwrap();
    revoke_imported_grants(&mut legacy).unwrap();
    let tables: u64 = legacy
        .query_row(
            "SELECT count(*) FROM sqlite_master WHERE name='spellcast_client_grants'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(tables, 0);
}
#[test]
fn scope_rotation_keeps_historical_audit_scope_and_identity_fingerprint() {
    let f = Fixture::new();
    let p = peer();
    approve(
        &f,
        &p,
        ClientScopes {
            records: true,
            sigil_drafts: false,
        },
    );
    f.b()
        .client_approve(
            &p,
            1,
            ClientScopes {
                records: false,
                sigil_drafts: true,
            },
        )
        .unwrap();
    let db = f.b().project_store().unwrap();
    let mut stmt=db.connection.prepare("SELECT scopes_json,identity_fingerprint,policy_revision FROM spellcast_client_audit ORDER BY seq").unwrap();
    let rows = stmt
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, u64>(2)?,
            ))
        })
        .unwrap()
        .map(Result::unwrap)
        .collect::<Vec<_>>();
    assert_eq!(
        serde_json::from_str::<ClientScopes>(&rows[0].0).unwrap(),
        ClientScopes { records: true, sigil_drafts: false
        , ..Default::default() }
    );
    assert_eq!(
        serde_json::from_str::<ClientScopes>(&rows[1].0).unwrap(),
        ClientScopes { records: false, sigil_drafts: true
        , ..Default::default() }
    );
    assert_eq!(rows[0].1.len(), 64);
    assert_eq!(rows[0].1, rows[1].1);
    assert_eq!((rows[0].2, rows[1].2), (1, 2));
}

#[test]
fn client_draft_card_refresh_does_not_implicitly_review_repository() {
    let f = Fixture::new();
    let p = peer();
    let s = approve(&f, &p, scopes());
    let data = save(
        f.b(),
        &p,
        &s,
        "card-preview",
        ClientChange::SigilCreate { plan: plan(&f) },
    )
    .data
    .unwrap();
    let id = data["sigil_id"].as_str().unwrap();
    let view = f
        .b()
        .sigil_query(crate::sigil_workspace::SigilQuery {
            view: "sigil".into(),
            sigil_id: id.into(),
            ..Default::default()
        })
        .unwrap();
    assert_eq!(view["review"]["can_freeze"], false);
    assert_eq!(view["review"]["issues"].as_array().unwrap().len(), 1);
    assert_eq!(
        view["review"]["issues"][0]["code"],
        "native_review_required"
    );
    // A real preflight on this nonexistent repository returns repository_invalid.
    assert!(!view["review"].to_string().contains("repository_invalid"));
    assert!(!f.root.join("never-created-repository").exists());
}

#[tokio::test]
async fn explicit_repository_review_still_requires_original_window_key_and_origin() {
    use axum::{
        body::Body,
        http::{Request, StatusCode},
    };
    use tower::ServiceExt;
    let mut f = Fixture::new();
    let bridge = Arc::try_unwrap(f.bridge.take().unwrap())
        .unwrap_or_else(|_| panic!("fixture has one owner"));
    // Public constant synthetic fixture credential, never a real window key.
    f.bridge = Some(Arc::new(
        bridge.with_project_window_key("f".repeat(64)).unwrap(),
    ));
    let p = peer();
    let s = approve(&f, &p, scopes());
    let data = save(
        f.b(),
        &p,
        &s,
        "native-review-fixture",
        ClientChange::SigilCreate { plan: plan(&f) },
    )
    .data
    .unwrap();
    let id = data["sigil_id"].as_str().unwrap();
    // The Sigil router alone starts NO bridge/observer/model/service.
    let app = crate::sigil_api::router().with_state(f.bridge.as_ref().unwrap().clone());
    for (origin, key, expected) in [
        (None, None, StatusCode::FORBIDDEN),
        (
            Some("http://tauri.localhost"),
            Some(s.grant_id.as_str()),
            StatusCode::FORBIDDEN,
        ),
        (
            Some("https://attacker.invalid"),
            Some("ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"),
            StatusCode::FORBIDDEN,
        ),
        (
            None,
            Some("ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"),
            StatusCode::FORBIDDEN,
        ),
        (
            Some("null"),
            Some("ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"),
            StatusCode::FORBIDDEN,
        ),
        (
            Some("http://tauri.localhost"),
            Some("ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"),
            StatusCode::OK,
        ),
    ] {
        let mut request = Request::post(format!("/api/sigils/{id}/review"))
            .header("content-type", "application/json");
        if let Some(origin) = origin {
            request = request.header("origin", origin);
        }
        if let Some(key) = key {
            request = request.header("x-spellcast-window", key);
        }
        let response = app
            .clone()
            .oneshot(
                request
                    .body(Body::from("{\"expected_revision\":1}"))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), expected);
    }
    assert_eq!(f.b().client_grants().unwrap()[0].generation, 1);
}

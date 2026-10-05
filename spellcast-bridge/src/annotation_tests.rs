use super::*;
use serde_json::{json, Value};
use spellcast_core::{CanvasBatchRequest, CanvasBatchStatus};

fn bind_fixture(bridge: &Bridge, source: &str, thread: &str, cwd: &str) {
    bridge.update(|state| {
        state.bindings.push(crate::codex::CodexBinding {
            source_id: source.into(), thread_id: thread.into(), cwd: cwd.into(),
            label: source.into(), executable: Default::default(), protocol_agent: "test".into(), bound_at_ms: 1,
        });
        Ok(())
    }).unwrap();
}

fn revision(id: &str, revision: u64) -> crate::annotations::AnnotationRevision {
    crate::annotations::AnnotationRevision { id: id.into(), revision }
}

#[test]
fn old_annotations_default_pending_and_schema_requires_source() {
    let note: spellcast_core::CanvasAnnotation = serde_json::from_value(json!({
        "id":"old","revision":1,"anchor":{"object_id":"o","content_revision":1},
        "snapshot":{"type":"text"},"text":"old note"
    })).unwrap();
    assert_eq!(note.status, spellcast_core::CanvasAnnotationStatus::Pending);
    let schema = serde_json::to_value(rmcp::schemars::schema_for!(crate::annotations::AnnotationRequest)).unwrap();
    assert!(schema["required"].as_array().unwrap().contains(&json!("source_id")));
    assert!(schema["properties"]["action"].is_object());
}

#[test]
fn pending_pages_are_stable_scoped_and_read_does_not_complete() {
    let bridge = Bridge::new(Headless, 0);
    bind_fixture(&bridge, "task-a", "thread-shared", "G:\\Workspace\\Same\\");
    bind_fixture(&bridge, "task-alias", "thread-shared", "g:/workspace/same");
    bind_fixture(&bridge, "task-other", "thread-other", "G:/Workspace/Same");
    bridge.canvas_batch(batch("seed-pages", json!([text("draft", "原文")])), Some("task-a")).unwrap();
    for start in [0, 64] {
        let operations: Vec<Value> = (start..(start + 64).min(70)).map(|i| json!({
            "op":"annotate","id":format!("note-{i:03}"),"expected_revision":0,
            "anchor":{"object_id":"draft","content_revision":1},"text":format!("注释{i}")
        })).collect();
        let result = bridge.canvas_batch(batch(&format!("notes-{start}"), json!(operations)), None).unwrap();
        assert_eq!(result.result.status, CanvasBatchStatus::Applied);
    }
    let mut seen = Vec::new();
    let mut after = None;
    loop {
        let page = bridge.pending_annotations("task-alias", Some(13), after.as_deref()).unwrap();
        seen.extend(page.annotations.iter().map(|note| note.id.clone()));
        if !page.has_more { assert!(page.next_cursor.is_none()); break; }
        after = page.next_cursor;
    }
    assert_eq!(seen.len(), 70);
    assert_eq!(seen.iter().collect::<std::collections::BTreeSet<_>>().len(), 70);
    assert!(bridge.pending_annotations("task-other", None, None).unwrap().annotations.is_empty());
    assert_eq!(bridge.pending_annotations("task-a", Some(64), None).unwrap().annotations.len(), 64);
    assert_eq!(bridge.board().canvas.annotation("note-000").unwrap().status, spellcast_core::CanvasAnnotationStatus::Pending);
    let first_page = bridge.pending_annotations("task-a", Some(13), None).unwrap();
    let build_generation = bridge.annotation_index_generation().unwrap();
    let entries: Vec<_> = first_page.annotations.iter().map(|note| revision(&note.id, note.revision)).collect();
    assert_eq!(bridge.complete_annotations("task-a", &entries).unwrap().completed, 13);
    assert_eq!(bridge.annotation_index_generation(), Some(build_generation));
    let next_page = bridge.pending_annotations("task-a", Some(13), first_page.next_cursor.as_deref()).unwrap();
    assert_eq!(next_page.annotations.len(), 13);
    assert_eq!(bridge.annotation_index_generation(), Some(build_generation));
}

#[test]
fn complete_is_atomic_idempotent_and_user_edits_reopen() {
    let path = std::env::temp_dir().join(format!("spellcast-annotation-complete-{}.sqlite3", new_id()));
    {
        let bridge = Bridge::open(Headless, 0, &path).unwrap();
        bind_fixture(&bridge, "task-a", "thread-a", "G:/A");
        bind_fixture(&bridge, "task-b", "thread-b", "G:/B");
        bridge.canvas_batch(batch("seed-complete", json!([text("a", "A"), text("b", "B")])), Some("task-a")).unwrap();
        bridge.canvas_batch(batch("note-complete", json!([
            {"op":"annotate","id":"n-a","expected_revision":0,"anchor":{"object_id":"a","content_revision":1},"text":"A note"},
            {"op":"annotate","id":"n-b","expected_revision":0,"anchor":{"object_id":"b","content_revision":1},"text":"B note"}
        ])), None).unwrap();
        assert!(bridge.complete_annotations("task-b", &[revision("n-a", 1)]).is_err());
        let first = bridge.complete_annotations("task-a", &[revision("n-a", 1)]).unwrap();
        assert_eq!(first.completed, 1);
        assert_eq!(bridge.complete_annotations("task-a", &[revision("n-a", 1)]).unwrap().already_handled, 1);
        assert_eq!(bridge.board().canvas.annotation("n-a").unwrap().revision, 1);
        bridge.canvas_batch(batch("edit-a", json!([{"op":"annotate","id":"n-a","expected_revision":1,"anchor":{"object_id":"a","content_revision":1},"text":"A changed"}])), None).unwrap();
        assert_eq!(bridge.board().canvas.annotation("n-a").unwrap().status, spellcast_core::CanvasAnnotationStatus::Pending);
        assert!(bridge.complete_annotations("task-a", &[revision("n-b", 1), revision("n-a", 1)]).is_err());
        assert_eq!(bridge.board().canvas.annotation("n-b").unwrap().status, spellcast_core::CanvasAnnotationStatus::Pending);
        bridge.canvas_batch(batch("delete-b", json!([{"op":"remove_annotation","id":"n-b","expected_revision":1,"removed":true}])), None).unwrap();
        assert!(bridge.complete_annotations("task-a", &[revision("n-b", 2), revision("n-a", 2)]).is_err());
        assert_eq!(bridge.board().canvas.annotation("n-a").unwrap().status, spellcast_core::CanvasAnnotationStatus::Pending);
        bridge.canvas_batch(batch("restore-b", json!([{"op":"remove_annotation","id":"n-b","expected_revision":2,"removed":false}])), None).unwrap();
        assert_eq!(bridge.board().canvas.annotation("n-b").unwrap().status, spellcast_core::CanvasAnnotationStatus::Pending);
        assert_eq!(bridge.complete_annotations("task-a", &[revision("n-a", 2), revision("n-b", 3)]).unwrap().completed, 2);
    }
    {
        let bridge = Bridge::open(Headless, 0, &path).unwrap();
        assert!(bridge.pending_annotations("task-a", None, None).unwrap().annotations.is_empty());
        assert_eq!(bridge.board().canvas.annotation("n-a").unwrap().status, spellcast_core::CanvasAnnotationStatus::Handled);
        assert_eq!(bridge.complete_annotations("task-a", &[revision("n-a", 2)]).unwrap().already_handled, 1);
    }
    std::fs::remove_file(path).unwrap();
}

#[test]
fn late_binding_recovers_target_after_original_object_is_deleted() {
    let bridge = Bridge::new(Headless, 0);
    bridge.canvas_batch(batch("unbound-object", json!([text("gone", "原文")])), Some("task-a")).unwrap();
    bridge.canvas_batch(batch("unbound-note", json!([{
        "op":"annotate","id":"survivor","expected_revision":0,
        "anchor":{"object_id":"gone","content_revision":1},"text":"保留批注"
    }])), None).unwrap();
    let note = bridge.board().canvas.annotation("survivor").unwrap().clone();
    assert!(note.origin.is_none());
    assert!(note.source_id.is_none());
    assert_eq!(note.target_source_id.as_deref(), Some("task-a"));
    bridge.delete_canvas_content("gone", 1, vec![]).unwrap();
    bind_fixture(&bridge, "task-a", "thread-a", "G:/Workspace/A");
    bind_fixture(&bridge, "task-alias", "thread-a", "g:\\workspace\\a\\");
    bind_fixture(&bridge, "task-other", "thread-other", "G:/Workspace/A");
    let pending = bridge.pending_annotations("task-alias", None, None).unwrap();
    assert_eq!(pending.annotations.len(), 1);
    assert_eq!(pending.annotations[0].id, "survivor");
    assert!(bridge.pending_annotations("task-other", None, None).unwrap().annotations.is_empty());
    assert_eq!(bridge.complete_annotations("task-a", &[revision("survivor", 1)]).unwrap().completed, 1);
}

fn batch(id: &str, operations: Value) -> CanvasBatchRequest {
    serde_json::from_value(json!({"request_id": id, "operations": operations})).unwrap()
}

fn text(id: &str, body: &str) -> Value {
    json!({"op":"create","id":id,"content":{"type":"text","title":id,"text":body},"placement":{}})
}

#[test]
fn annotation_snapshot_soft_removal_and_atomic_create_are_durable() {
    let path = std::env::temp_dir().join(format!("spellcast-annotations-{}.sqlite3", new_id()));
    {
        let bridge = Bridge::open(Headless, 0, &path).unwrap();
        let created = bridge
            .canvas_batch(
                batch(
                    "create-and-annotate",
                    json!([
                        text("draft", "保留这句原文"),
                        {"op":"annotate","id":"note","expected_revision":0,
                         "anchor":{"object_id":"draft","content_revision":1,"selection":"原文"},
                         "text":"这里需要更清楚"}
                    ]),
                ),
                None,
            )
            .unwrap();
        assert_eq!(created.result.status, CanvasBatchStatus::Applied);
        let annotation = created.board.canvas.annotation("note").unwrap();
        assert_eq!(annotation.revision, 1);
        assert_eq!(annotation.snapshot["text"], "保留这句原文");
        assert_eq!(annotation.source_id, None);
        assert!(bridge.pending_feedback(None).is_empty());

        bridge
            .canvas_batch(
                batch(
                    "change-source",
                    json!([{"op":"patch_content","id":"draft","expected_revision":1,
                            "fields":{"text":"后来改掉的内容"}}]),
                ),
                None,
            )
            .unwrap();
        let old_anchor = json!({"object_id":"draft","content_revision":1,"selection":"原文"});
        let edited = bridge
            .canvas_batch(
                batch(
                    "edit-note-after-source",
                    json!([{"op":"annotate","id":"note","expected_revision":1,
                            "anchor":old_anchor,"text":"正文可改，快照不变"}]),
                ),
                None,
            )
            .unwrap();
        assert_eq!(edited.result.status, CanvasBatchStatus::Applied);
        assert_eq!(
            edited.board.canvas.annotation("note").unwrap().snapshot["text"],
            "保留这句原文"
        );

        for (request_id, expected, removed, actual) in
            [("remove-note", 2, true, 3), ("restore-note", 3, false, 4)]
        {
            let outcome = bridge
                .canvas_batch(
                    batch(
                        request_id,
                        json!([{"op":"remove_annotation","id":"note",
                                "expected_revision":expected,"removed":removed}]),
                    ),
                    None,
                )
                .unwrap();
            assert_eq!(outcome.result.status, CanvasBatchStatus::Applied);
            assert_eq!(
                outcome.board.canvas.annotation("note").unwrap().revision,
                actual
            );
            assert_eq!(
                outcome.board.canvas.annotation("note").unwrap().removed,
                removed
            );
        }
        assert!(bridge.pending_feedback(None).is_empty());
    }
    {
        let bridge = Bridge::open(Headless, 0, &path).unwrap();
        let annotation = bridge.board().canvas.annotation("note").unwrap().clone();
        assert_eq!(annotation.revision, 4);
        assert_eq!(annotation.snapshot["text"], "保留这句原文");
        assert_eq!(annotation.text, "正文可改，快照不变");
    }
    std::fs::remove_file(path).unwrap();
}

#[test]
fn legacy_reply_binding_and_node_capture_become_durable_annotation_origins() {
    let bridge = Bridge::new(Headless, 0);
    bridge
        .update(|state| {
            state.bindings.push(crate::codex::CodexBinding {
                source_id: "task-a".into(),
                thread_id: "thread-a".into(),
                cwd: "G:/Workspace/A".into(),
                label: "Bound task".into(),
                executable: Default::default(),
                protocol_agent: "test".into(),
                bound_at_ms: 1,
            });
            Ok(())
        })
        .unwrap();
    let reply = bridge
        .write_reply(
            serde_json::from_value(json!({
                "id":"legacy-reply","source_id":"task-a","title":"Reply",
                "blocks":[{"type":"text","id":"body","text":"Reply body"}]
            }))
            .unwrap(),
        )
        .unwrap();
    let reply_object = bridge
        .board()
        .canvas
        .objects
        .into_iter()
        .find(|object| matches!(&object.content, spellcast_core::CanvasContent::Reply { id } if id == &reply.id))
        .unwrap();
    bridge
        .canvas_batch(
            batch(
                "reply-origin-note",
                json!([{"op":"annotate","id":"reply-note","expected_revision":0,
                        "anchor":{"object_id":reply_object.id,"content_revision":reply_object.content_revision,
                                  "block_id":"body"},"text":"绑定来源"}]),
            ),
            None,
        )
        .unwrap();
    let origin = bridge
        .board()
        .canvas
        .annotation("reply-note")
        .unwrap()
        .origin
        .clone()
        .unwrap();
    assert_eq!(origin.cwd, "G:/Workspace/A");
    assert_eq!(origin.thread_id.as_deref(), Some("thread-a"));
    assert_eq!(origin.source_id.as_deref(), Some("task-a"));

    let node_object = bridge
        .update(|state| {
            let node = state.session.add_node_captured(
                spellcast_core::NodeDraft {
                    title: "Captured".into(),
                    body: "Node body".into(),
                    source_id: Some("task-node".into()),
                    ..Default::default()
                },
                Some(spellcast_core::CapturedContext {
                    host_pin: None,
                    project: "Captured project".into(),
                    goal: String::new(),
                    change: String::new(),
                    source_id: "task-node".into(),
                    captured_at_ms: 1,
                    thread_id: Some("thread-node".into()),
                    cwd: Some("G:/Workspace/Node".into()),
                }),
            );
            state.session.sync_canvas();
            Ok(state
                .session
                .board
                .canvas
                .object_for(&spellcast_core::CanvasContent::Node { id: node.id })
                .unwrap()
                .clone())
        })
        .unwrap();
    bridge
        .canvas_batch(
            batch(
                "node-origin-note",
                json!([{"op":"annotate","id":"node-note","expected_revision":0,
                        "anchor":{"object_id":node_object.id,"content_revision":node_object.content_revision,
                                  "block_id":"text"},"text":"捕获来源"}]),
            ),
            None,
        )
        .unwrap();
    let node_origin = bridge
        .board()
        .canvas
        .annotation("node-note")
        .unwrap()
        .origin
        .clone()
        .unwrap();
    assert_eq!(node_origin.cwd, "G:/Workspace/Node");
    assert_eq!(node_origin.thread_id.as_deref(), Some("thread-node"));
    assert_eq!(node_origin.label, "Captured project");
}

#[tokio::test]
async fn only_send_queues_frozen_annotation_context_and_requires_annotation_read() {
    let bridge = Bridge::new(Headless, 0);
    bridge
        .canvas_batch(
            batch("seed", json!([text("draft", "第一版")])),
            Some("task-a"),
        )
        .unwrap();
    bridge
        .canvas_batch(
            batch(
                "note",
                json!([{"op":"annotate","id":"agent-note","expected_revision":0,
                        "anchor":{"object_id":"draft","content_revision":1},"text":"发送时注释"}]),
            ),
            Some("task-a"),
        )
        .unwrap();
    bridge
        .canvas_batch(
            batch(
                "source-after-note",
                json!([{"op":"patch_content","id":"draft","expected_revision":1,
                        "fields":{"text":"第二版"}}]),
            ),
            None,
        )
        .unwrap();
    assert!(bridge.pending_feedback(None).is_empty());

    let event = bridge
        .say(
            serde_json::from_value(json!({
            "source_id":"task-a","text":"按这条注释继续",
            "anchors":[{"object_id":"draft","content_revision":2,
                        "annotations":[{"id":"agent-note","revision":1}]}]
            }))
            .unwrap(),
        )
        .unwrap();
    assert_eq!(event.annotation_context.len(), 1);
    assert_eq!(event.annotation_context[0].text, "发送时注释");
    assert_eq!(event.annotation_context[0].anchor.content_revision, 1);

    bridge
        .canvas_batch(
            batch(
                "edit-note",
                json!([{"op":"annotate","id":"agent-note","expected_revision":1,
                        "anchor":{"object_id":"draft","content_revision":1},"text":"发送后修改"}]),
            ),
            Some("task-a"),
        )
        .unwrap();
    let pending = bridge.pending_feedback(Some("task-a"));
    assert_eq!(pending[0].annotation_context[0].text, "发送时注释");

    let without_annotation_read = batch(
        "answer-without-note-read",
        json!([{"op":"patch_content","id":"draft","expected_revision":2,
                "fields":{"text":"处理结果"}}]),
    );
    assert!(bridge
        .canvas_batch(
            CanvasBatchRequest {
                feedback_sequences: vec![event.seq],
                reads: vec![spellcast_core::CanvasRead {
                    kind: spellcast_core::CanvasTargetKind::Content,
                    id: "draft".into(),
                    revision: 2,
                }],
                ..without_annotation_read
            },
            Some("task-a"),
        )
        .is_err());
}

#[test]
fn annotation_only_send_still_has_context_after_source_deletion() {
    let bridge = Bridge::new(Headless, 0);
    bridge
        .update(|state| {
            state.bindings.push(crate::codex::CodexBinding {
                source_id: "task-a".into(),
                thread_id: "thread-a".into(),
                cwd: "G:/Workspace/A".into(),
                label: "Task A".into(),
                executable: Default::default(),
                protocol_agent: "test".into(),
                bound_at_ms: 1,
            });
            state.bindings.push(crate::codex::CodexBinding {
                source_id: "task-b".into(),
                thread_id: "thread-b".into(),
                cwd: "G:/Workspace/B".into(),
                label: "Task B".into(),
                executable: Default::default(),
                protocol_agent: "test".into(),
                bound_at_ms: 1,
            });
            Ok(())
        })
        .unwrap();
    bridge
        .canvas_batch(
            batch("seed-deleted", json!([text("draft", "会被删除")])),
            Some("task-a"),
        )
        .unwrap();
    bridge
        .canvas_batch(
            batch(
                "note-deleted",
                json!([{"op":"annotate","id":"saved-note","expected_revision":0,
                        "anchor":{"object_id":"draft","content_revision":1},
                        "text":"删除后仍要看懂"}]),
            ),
            Some("task-a"),
        )
        .unwrap();
    bridge.delete_canvas_content("draft", 1, vec![]).unwrap();
    assert!(bridge
        .say(
            serde_json::from_value(json!({
                "source_id":"task-b","text":"不能按注释作者或任意选择改投",
                "anchors":[{"object_id":"draft","content_revision":1,
                            "annotations":[{"id":"saved-note","revision":1}]}]
            }))
            .unwrap(),
        )
        .is_err());
    let event = bridge
        .say(
            serde_json::from_value(json!({
                "source_id":"task-a","text":"继续讨论保存的注释",
                "anchors":[{"object_id":"draft","content_revision":1,
                            "annotations":[{"id":"saved-note","revision":1}]}]
            }))
            .unwrap(),
        )
        .unwrap();
    assert_eq!(event.annotation_context.len(), 1);
    assert_eq!(event.annotation_context[0].snapshot["text"], "会被删除");
}

#[test]
fn recursive_spoofed_and_foreign_annotations_are_rejected_without_partial_writes() {
    let bridge = Bridge::new(Headless, 0);
    bridge
        .canvas_batch(batch("seed", json!([text("owned", "A")])), Some("task-a"))
        .unwrap();
    let before = serde_json::to_value(bridge.board()).unwrap();
    assert!(bridge
        .canvas_batch(
            batch(
                "foreign",
                json!([{"op":"annotate","id":"foreign-note","expected_revision":0,
                        "anchor":{"object_id":"owned","content_revision":1},"text":"越权"}]),
            ),
            Some("task-b"),
        )
        .is_err());
    assert_eq!(serde_json::to_value(bridge.board()).unwrap(), before);

    let proposed = bridge
        .canvas_batch(
            batch(
                "recursive",
                json!([{"op":"annotate","id":"recursive-note","expected_revision":0,
                        "anchor":{"object_id":"owned","content_revision":1,
                                  "annotations":[{"id":"missing","revision":1}]},
                        "text":"递归"}]),
            ),
            None,
        )
        .unwrap();
    assert_eq!(proposed.result.status, CanvasBatchStatus::Proposed);
    assert!(proposed.board.canvas.annotation("recursive-note").is_none());
}

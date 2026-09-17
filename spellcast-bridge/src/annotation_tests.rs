use super::*;
use serde_json::{json, Value};
use spellcast_core::{CanvasBatchRequest, CanvasBatchStatus};

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

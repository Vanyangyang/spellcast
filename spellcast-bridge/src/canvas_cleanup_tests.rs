use super::*;
use crate::canvas::{CanvasOrganizeDelivery, CanvasOrganizeFeedback, CanvasOrganizeRequest};
use crate::feedback::DeliveryPhase;
use serde_json::{json, Value};
use spellcast_core::{CanvasBatchRequest, CanvasBatchStatus, CanvasContent, CanvasRead, CanvasTargetKind};

fn batch(id: &str, operations: Value) -> CanvasBatchRequest {
    serde_json::from_value(json!({"request_id": id, "operations": operations})).unwrap()
}

fn fixture() -> Bridge {
    let bridge = Bridge::new(Headless, 0);
    bridge.canvas_batch(batch("seed", json!([
        {"op":"create","id":"first","content":{"type":"text","text":"first source"}},
        {"op":"create","id":"second","content":{"type":"text","text":"second source"}}
    ])), Some("task")).unwrap();
    bridge
}

fn request(bridge: &Bridge, id: &str, operations: Value) -> CanvasOrganizeRequest {
    let feedback = bridge.feedback_state(None);
    CanvasOrganizeRequest {
        expected_canvas_revision: bridge.board().canvas.revision,
        expected_feedback: CanvasOrganizeFeedback {
            pending: feedback.pending.iter().map(|event| event.seq).collect(),
            deliveries: feedback.deliveries.iter().map(|receipt| CanvasOrganizeDelivery {
                sequence: receipt.event.seq, phase: receipt.phase,
            }).collect(),
        },
        batch: batch(id, operations),
    }
}

fn merge(bridge: &Bridge, id: &str) -> CanvasOrganizeRequest {
    let canvas = bridge.board().canvas;
    request(bridge, id, json!([
        {"op":"create","id":"merged","content":{"type":"text","text":"first source\nsecond source"}},
        {"op":"place","id":"first","expected_revision":canvas.placement("first").unwrap().revision,"fields":{"removed":true}},
        {"op":"place","id":"second","expected_revision":canvas.placement("second").unwrap().revision,"fields":{"removed":true}}
    ]))
}

fn assert_rejected_without_mutation(bridge: &Bridge, request: CanvasOrganizeRequest) {
    let before = serde_json::to_value(bridge.board()).unwrap();
    assert!(bridge.organize_canvas(request).is_err());
    assert_eq!(serde_json::to_value(bridge.board()).unwrap(), before);
}

#[test]
fn organize_merges_softly_preserves_sources_and_restores() {
    let bridge = fixture();
    let first = bridge.board().canvas.object("first").unwrap().clone();
    let second = bridge.board().canvas.object("second").unwrap().clone();
    let outcome = bridge.organize_canvas(merge(&bridge, "merge")).unwrap();
    assert_eq!(outcome.result.status, CanvasBatchStatus::Applied);
    assert_eq!(outcome.board.canvas.object("first"), Some(&first));
    assert_eq!(outcome.board.canvas.object("second"), Some(&second));
    assert!(outcome.board.canvas.placement("first").unwrap().removed);
    assert!(outcome.board.canvas.placement("second").unwrap().removed);
    assert_eq!(outcome.board.canvas.object("merged").unwrap().source_id, None);
    assert!(matches!(&outcome.board.canvas.object("merged").unwrap().content,
        CanvasContent::Text { text, .. } if text == "first source\nsecond source"));
    let restore = request(&bridge, "restore", json!([
        {"op":"place","id":"first","expected_revision":outcome.board.canvas.placement("first").unwrap().revision,"fields":{"removed":false}},
        {"op":"place","id":"second","expected_revision":outcome.board.canvas.placement("second").unwrap().revision,"fields":{"removed":false}},
        {"op":"place","id":"merged","expected_revision":1,"fields":{"removed":true}}
    ]));
    let restored = bridge.organize_canvas(restore).unwrap();
    assert_eq!(restored.result.status, CanvasBatchStatus::Applied);
    assert!(!restored.board.canvas.placement("first").unwrap().removed);
    assert!(!restored.board.canvas.placement("second").unwrap().removed);
    assert!(restored.board.canvas.placement("merged").unwrap().removed);
    assert_eq!(restored.board.canvas.object("first"), Some(&first));
}

#[test]
fn organize_rejects_old_canvas_content_without_recording_a_proposal() {
    let bridge = fixture();
    let organize = merge(&bridge, "stale");
    bridge.canvas_batch(batch("changed", json!([
        {"op":"patch_content","id":"first","expected_revision":1,"fields":{"text":"changed source"}}
    ])), None).unwrap();
    assert_rejected_without_mutation(&bridge, organize);
    assert!(bridge.board().canvas.proposal("stale").is_none());
}

#[test]
fn organize_rejects_new_edited_and_completed_annotations() {
    let bridge = fixture();
    let before_new = merge(&bridge, "before-new-note");
    bridge.canvas_batch(batch("new-note", json!([
        {"op":"annotate","id":"note","expected_revision":0,"anchor":{"object_id":"first","content_revision":1},"text":"new note"}
    ])), None).unwrap();
    assert_rejected_without_mutation(&bridge, before_new);
    let before_edit = merge(&bridge, "before-edited-note");
    bridge.canvas_batch(batch("edit-note", json!([
        {"op":"annotate","id":"note","expected_revision":1,"anchor":{"object_id":"first","content_revision":1},"text":"edited note"}
    ])), None).unwrap();
    assert_rejected_without_mutation(&bridge, before_edit);
    let before_complete = merge(&bridge, "before-completed-note");
    bridge.complete_annotations("task", &[crate::annotations::AnnotationRevision { id: "note".into(), revision: 2 }]).unwrap();
    assert_rejected_without_mutation(&bridge, before_complete);
}

#[test]
fn organize_rejects_new_feedback_sequence_and_receipt_phase() {
    let bridge = fixture();
    let mut before_sequence = merge(&bridge, "before-feedback");
    let event = bridge.say(SayRequest { text: "new feedback".into(), source_id: Some("task".into()), ..Default::default() }).unwrap();
    before_sequence.expected_canvas_revision = bridge.board().canvas.revision;
    assert_rejected_without_mutation(&bridge, before_sequence);
    let before_phase = merge(&bridge, "before-phase");
    bridge.update(|state| {
        state.deliveries.iter_mut().find(|receipt| receipt.event.seq == event.seq).unwrap().phase = DeliveryPhase::Received;
        Ok(())
    }).unwrap();
    assert_rejected_without_mutation(&bridge, before_phase);
    let before_pending_removal = merge(&bridge, "before-pending-removal");
    bridge.update(|state| { state.pending.retain(|pending| pending.seq != event.seq); Ok(()) }).unwrap();
    assert_rejected_without_mutation(&bridge, before_pending_removal);
}

#[test]
fn organize_retry_is_idempotent_and_rejects_changed_batch_fingerprint() {
    let bridge = fixture();
    let organize = merge(&bridge, "retry");
    let applied = bridge.organize_canvas(organize.clone()).unwrap();
    bridge.say(SayRequest { text: "later feedback".into(), source_id: Some("task".into()), ..Default::default() }).unwrap();
    let before_retry = serde_json::to_value(bridge.board()).unwrap();
    let retry = bridge.organize_canvas(organize.clone()).unwrap();
    assert_eq!(retry.result, applied.result);
    assert_eq!(serde_json::to_value(bridge.board()).unwrap(), before_retry);
    let mut changed = organize;
    if let spellcast_core::CanvasOperation::Create { content: CanvasContent::Text { text, .. }, .. } = &mut changed.batch.operations[0] {
        *text = "different merge".into();
    }
    assert_rejected_without_mutation(&bridge, changed);
}

#[test]
fn organize_delete_lock_blocks_entire_batch() {
    let bridge = fixture();
    bridge.set_canvas_delete_lock(vec![CanvasRead {
        kind: CanvasTargetKind::Presentation, id: "first".into(), revision: 1,
    }], true).unwrap();
    let canvas = bridge.board().canvas;
    let result = bridge.organize_canvas(merge(&bridge, "locked-merge")).unwrap();
    assert_eq!(result.result.status, CanvasBatchStatus::Proposed);
    assert_eq!(result.board.canvas.revision, canvas.revision);
    assert!(!result.board.canvas.placement("first").unwrap().removed);
    assert!(!result.board.canvas.placement("second").unwrap().removed);
    assert!(result.board.canvas.object("merged").is_none());
    assert!(result.result.targets.iter().any(|target| target.message.as_deref().is_some_and(|message| message.contains("锁定"))));
}

#[test]
fn organize_only_allows_text_creation_and_removed_placement() {
    let bridge = fixture();
    for (index, operation) in [
        json!({"op":"patch_content","id":"first","expected_revision":1,"fields":{"text":"overwrite"}}),
        json!({"op":"place","id":"first","expected_revision":1,"fields":{"removed":true,"x":42}}),
        json!({"op":"place","id":"first","expected_revision":1,"fields":{"x":42}}),
        json!({"op":"create","id":"image","content":{"type":"image","src":"https://example.com/image.png"}}),
        json!({"op":"remove_annotation","id":"note","expected_revision":1,"removed":true}),
    ].into_iter().enumerate() {
        assert_rejected_without_mutation(&bridge, request(&bridge, &format!("forbidden-{index}"), json!([operation])));
    }
    let mut with_feedback = merge(&bridge, "with-feedback");
    with_feedback.batch.feedback_sequences = vec![1];
    assert_rejected_without_mutation(&bridge, with_feedback);
}

#[test]
fn organize_feedback_normalizes_order_and_rejects_duplicate_sequences() {
    let bridge = fixture();
    for text in ["one", "two"] {
        bridge.say(SayRequest { text: text.into(), source_id: Some("task".into()), ..Default::default() }).unwrap();
    }
    let mut duplicate_pending = merge(&bridge, "duplicate-pending");
    duplicate_pending.expected_feedback.pending.push(duplicate_pending.expected_feedback.pending[0]);
    assert_rejected_without_mutation(&bridge, duplicate_pending);
    let mut duplicate_receipt = merge(&bridge, "duplicate-receipt");
    duplicate_receipt.expected_feedback.deliveries.push(duplicate_receipt.expected_feedback.deliveries[0].clone());
    assert_rejected_without_mutation(&bridge, duplicate_receipt);
    let mut unordered = merge(&bridge, "unordered");
    unordered.expected_feedback.pending.reverse();
    unordered.expected_feedback.deliveries.reverse();
    assert_eq!(bridge.organize_canvas(unordered).unwrap().result.status, CanvasBatchStatus::Applied);
}

#[test]
fn organize_applied_receipt_and_source_content_survive_restart() {
    let path = std::env::temp_dir().join(format!("spellcast-organize-{}.sqlite3", new_id()));
    let organize;
    {
        let bridge = Bridge::open(Headless, 0, &path).unwrap();
        bridge.canvas_batch(batch("persistent-seed", json!([
            {"op":"create","id":"first","content":{"type":"text","text":"first source"}},
            {"op":"create","id":"second","content":{"type":"text","text":"second source"}}
        ])), None).unwrap();
        organize = merge(&bridge, "persistent-merge");
        assert_eq!(bridge.organize_canvas(organize.clone()).unwrap().result.status, CanvasBatchStatus::Applied);
    }
    {
        let bridge = Bridge::open(Headless, 0, &path).unwrap();
        let before = serde_json::to_value(bridge.board()).unwrap();
        assert_eq!(bridge.organize_canvas(organize).unwrap().result.status, CanvasBatchStatus::Applied);
        assert_eq!(serde_json::to_value(bridge.board()).unwrap(), before);
        assert!(bridge.board().canvas.placement("first").unwrap().removed);
        assert!(matches!(&bridge.board().canvas.object("first").unwrap().content,
            CanvasContent::Text { text, .. } if text == "first source"));
    }
    std::fs::remove_file(path).unwrap();
}

#[tokio::test]
async fn organize_http_route_accepts_user_batch() {
    use tower::ServiceExt;
    let bridge = std::sync::Arc::new(fixture());
    let canvas_revision = bridge.board().canvas.revision;
    let response = api::router(bridge.clone()).oneshot(axum::http::Request::builder()
        .method("POST").uri("/api/canvas/organize").header("content-type", "application/json")
        .body(axum::body::Body::from(json!({
            "expected_canvas_revision":canvas_revision,
            "expected_feedback":{"pending":[],"deliveries":[]},
            "batch":{"request_id":"http-organize","operations":[
                {"op":"place","id":"first","expected_revision":1,"fields":{"removed":true}}
            ]}
        }).to_string())).unwrap()).await.unwrap();
    assert_eq!(response.status(), axum::http::StatusCode::OK);
    assert!(bridge.board().canvas.placement("first").unwrap().removed);
}

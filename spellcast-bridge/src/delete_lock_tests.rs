use super::*;
use serde_json::{json, Value};
use spellcast_core::{CanvasBatchRequest, CanvasBatchStatus, CanvasPatch, CanvasRead, CanvasTargetKind};

fn batch(id: &str, operations: Value) -> CanvasBatchRequest {
    serde_json::from_value(json!({"request_id": id, "operations": operations})).unwrap()
}

fn presentation(bridge: &Bridge, id: &str) -> CanvasRead {
    CanvasRead { kind: CanvasTargetKind::Presentation, id: id.into(), revision: bridge.board().canvas.placement(id).unwrap().revision }
}

#[test]
fn delete_lock_survives_restart_and_requires_explicit_unlock() {
    let path = std::env::temp_dir().join(format!("spellcast-delete-lock-{}.sqlite3", new_id()));
    {
        let bridge = Bridge::open(Headless, 0, &path).unwrap();
        bridge.canvas_batch(batch("create", json!([
            {"op":"create","id":"locked","content":{"type":"text","text":"keep"}},
            {"op":"create","id":"free","content":{"type":"text","text":"remove"}}
        ])), None).unwrap();
        bridge.set_canvas_delete_lock(vec![presentation(&bridge, "locked")], true).unwrap();
        let item = bridge.board().canvas.placement("locked").unwrap().clone();
        assert!(bridge.remove_canvas_item("locked", item.revision).is_err());
        assert!(bridge.delete_canvas_content("locked", 1, vec![]).is_err());
        assert!(bridge.clear().is_err());
        assert!(bridge.reset_by_user().is_err());

        // Ordinary layout saves cannot silently unlock, even with a forged field.
        let mut forged = item.clone(); forged.delete_locked = false; forged.x += 20.0;
        bridge.patch_canvas(CanvasPatch { expected_revision: None, items: vec![forged] }).unwrap();
        assert!(bridge.board().canvas.placement("locked").unwrap().delete_locked);
        let rev = presentation(&bridge, "locked").revision;
        let mixed = bridge.canvas_batch(batch("mixed-atomic", json!([
            {"op":"place","id":"free","expected_revision":1,"fields":{"removed":true}},
            {"op":"place","id":"locked","expected_revision":rev,"fields":{"removed":true}}
        ])), None).unwrap();
        assert_eq!(mixed.result.status, CanvasBatchStatus::Proposed);
        assert!(!mixed.board.canvas.placement("free").unwrap().removed);
        assert!(!mixed.board.canvas.placement("locked").unwrap().removed);
        assert!(mixed.result.targets.iter().any(|target| target.message.as_deref().is_some_and(|s| s.contains("锁定"))));
        let applied = bridge.canvas_proposal("mixed-atomic", crate::canvas::CanvasProposalAction {
            action: "apply".into(), current: vec![presentation(&bridge, "free"), presentation(&bridge, "locked")],
        }).unwrap();
        assert_eq!(applied.result.status, CanvasBatchStatus::Proposed);
        assert!(!bridge.board().canvas.placement("locked").unwrap().removed);
        bridge.remove_canvas_item("free", 1).unwrap();
    }
    {
        let bridge = Bridge::open(Headless, 0, &path).unwrap();
        assert!(bridge.board().canvas.placement("locked").unwrap().delete_locked);
        assert!(bridge.remove_canvas_item("locked", presentation(&bridge, "locked").revision).is_err());
        bridge.set_canvas_delete_lock(vec![presentation(&bridge, "locked")], false).unwrap();
        bridge.remove_canvas_item("locked", presentation(&bridge, "locked").revision).unwrap();
        bridge.delete_canvas_content("locked", 1, vec![]).unwrap();
        assert!(bridge.board().canvas.object("locked").is_none());
    }
    let _ = std::fs::remove_file(path);
}

#[test]
fn delete_lock_guards_legacy_node_unkeep_and_full_reply_replacement() {
    let bridge = Bridge::new(Headless, 0);
    let bubble = bridge.bubble_now(BubbleRequest { tease: "keep this".into(), source_id: Some("test".into()), ..Default::default() }).unwrap().bubble;
    let (node, _) = bridge.keep(&bubble).unwrap();
    let object = bridge.board().canvas.object_for(&spellcast_core::CanvasContent::Node { id: node.id.clone() }).unwrap().clone();
    bridge.set_canvas_delete_lock(vec![presentation(&bridge, &object.id)], true).unwrap();
    assert!(bridge.remove_node(&node.id).is_err());
    assert!(bridge.unkeep(&bubble).is_err());
    assert!(bridge.present(serde_json::from_value(json!({"replace":true,"nodes":[{"title":"replacement","body":"new"}]})).unwrap()).is_err());

    let request: ReplyRequest = serde_json::from_value(json!({"id":"reply","source_id":"test","title":"Protected reply","blocks":[
        {"id":"a","type":"text","text":"first"},{"id":"b","type":"text","text":"second"}
    ]})).unwrap();
    let reply = bridge.write_reply(request.clone()).unwrap();
    let object = bridge.board().canvas.object_for(&spellcast_core::CanvasContent::Reply { id: reply.id.clone() }).unwrap().clone();
    bridge.set_canvas_delete_lock(vec![presentation(&bridge, &object.id)], true).unwrap();
    let mut replacement = request;
    replacement.expected_revision = Some(reply.revision); replacement.blocks.pop();
    assert!(bridge.write_reply(replacement).is_err());
    assert_eq!(bridge.board().replies[0].blocks.len(), 2);
    // Content edits retain the object and its lock.
    bridge.patch_node(&node.id, NodePatch { body: Some("edited safely".into()), ..Default::default() }).unwrap();
    assert!(bridge.board().canvas.placement(&object.id).unwrap().delete_locked);
}

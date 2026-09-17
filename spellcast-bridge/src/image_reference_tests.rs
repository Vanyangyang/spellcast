use super::*;
use serde_json::{json, Value};
use spellcast_core::{CanvasBatchRequest, CanvasBatchStatus};

fn batch(id: &str, operations: Value) -> CanvasBatchRequest {
    serde_json::from_value(json!({"request_id":id,"operations":operations})).unwrap()
}
fn image() -> Value { json!({"object_id":"picture","content_revision":1,"title":"周视图","alt":"留白的日历","src":"data:image/png;base64,iVBORw0KGgo="}) }
fn block() -> Value { json!({"type":"comparison","id":"compare","title":"安排","criteria":["感受"],"options":[
    {"id":"open","title":"留白","values":["舒展"],"image":image()}, {"id":"busy","title":"排满","values":["拥挤"]}]}) }
fn seed(bridge: &Bridge) {
    let outcome = bridge.canvas_batch(batch("seed", json!([
        {"op":"create","id":"picture","content":{"type":"image","title":"周视图","alt":"留白的日历","src":image()["src"]}},
        {"op":"create","id":"comparison","content":{"type":"block","block":block()}},
        {"op":"compose","id":"idea","expected_revision":0,"title":"日历","members":["picture","comparison"]}
    ])), Some("test-task")).unwrap();
    assert_eq!(outcome.result.status, CanvasBatchStatus::Applied);
}
fn anchor() -> Value { json!({"object_id":"comparison","content_revision":1,"block_id":"compare","target":{"kind":"option","id":"open"},"image":image(),
    "region":{"resource":image()["src"],"unit":"normalized","x":0.1,"y":0.2,"width":0.4,"height":0.3}}) }

#[test]
fn fixed_picture_target_survives_source_update_and_rejects_spoofed_subitems() {
    let bridge = Bridge::new(Headless, 0); seed(&bridge);
    let updated = bridge.canvas_batch(batch("change-image", json!([{"op":"patch_content","id":"picture","expected_revision":1,"fields":{"title":"新标题","src":"data:image/png;base64,AAAA"}}])), None).unwrap();
    assert_eq!(updated.result.status, CanvasBatchStatus::Applied);
    assert!(bridge.pending_feedback(None).is_empty());
    let good = serde_json::from_value(anchor()).unwrap();
    assert!(crate::canvas::validate_anchors(&bridge.state.lock().unwrap().session, &[good]).is_ok());
    for invalid in [
        { let mut v = anchor(); v["target"]["id"] = json!("missing"); v },
        { let mut v = anchor(); v["target"]["kind"] = json!("step"); v },
        { let mut v = anchor(); v["image"]["src"] = json!("data:image/png;base64,AAAA"); v },
        { let mut v = anchor(); v["region"]["x"] = json!(0.9); v },
        { let mut v = anchor(); v["content_revision"] = json!(0); v },
    ] { assert!(crate::canvas::validate_anchors(&bridge.state.lock().unwrap().session, &[serde_json::from_value(invalid).unwrap()]).is_err()); }
}

#[test]
fn only_final_send_records_the_exact_image_target_and_restart_preserves_it() {
    let path = std::env::temp_dir().join(format!("spellcast-image-target-{}.sqlite3", new_id()));
    let sequence;
    {
        let bridge = Bridge::open(Headless, 0, &path).unwrap(); seed(&bridge);
        let action = serde_json::from_value(json!({"expected_revision":1,"block_id":"compare","action":"select","option_id":"open"})).unwrap();
        bridge.canvas_block_action("comparison", action).unwrap();
        assert!(bridge.pending_feedback(None).is_empty());
        let mut sent = anchor(); sent["content_revision"] = json!(2);
        let request: SayRequest = serde_json::from_value(json!({"source_id":"test-task","text":"保留这里的留白","anchors":[sent]})).unwrap();
        let event = bridge.say(request).unwrap(); sequence = event.seq;
        assert_eq!(bridge.pending_feedback(Some("test-task")).len(), 1);
        assert_eq!(serde_json::to_value(&event.anchors[0]).unwrap()["target"]["id"], "open");
        assert_eq!(serde_json::to_value(&event.anchors[0]).unwrap()["image"], image());
    }
    {
        let bridge = Bridge::open(Headless, 0, &path).unwrap();
        let pending = bridge.pending_feedback(Some("test-task"));
        assert_eq!(pending.len(), 1); assert_eq!(pending[0].seq, sequence);
        assert_eq!(serde_json::to_value(&pending[0].anchors[0]).unwrap()["image"], image());
        assert_eq!(serde_json::to_value(bridge.board()).unwrap()["canvas"]["objects"].as_array().unwrap().len(), 2);
    }
    let _ = std::fs::remove_file(path);
}

#[test]
fn inline_ask_keeps_subitem_identity_without_injecting_title_prefixes() {
    let bridge = Bridge::new(Headless, 0); seed(&bridge);
    let request = serde_json::from_value(json!({"expected_revision":1,"block_id":"compare","action":"ask","text":"这里再宽松一点","anchors":[anchor()]})).unwrap();
    let outcome = bridge.canvas_block_action("comparison", request).unwrap();
    assert_eq!(outcome.event.text.as_deref(), Some("这里再宽松一点"));
    assert_eq!(serde_json::to_value(&outcome.event.anchors[0]).unwrap()["target"]["id"], "open");
}

#[test]
fn new_references_cannot_cross_known_workspaces_even_without_task_owners() {
    let bridge = Bridge::new(Headless, 0);
    let outcome = bridge.canvas_batch(batch("different-workspaces", json!([
        {"op":"create","id":"picture","origin":{"cwd":"G:/project-a"},"content":{"type":"image","title":"周视图","alt":"留白的日历","src":image()["src"]}},
        {"op":"create","id":"comparison","origin":{"cwd":"G:/project-b"},"content":{"type":"block","block":block()}},
        {"op":"compose","id":"idea","expected_revision":0,"title":"混合组合","members":["picture","comparison"]}
    ])), None).unwrap();
    assert_eq!(outcome.result.status, CanvasBatchStatus::Proposed);
    assert!(outcome.board.canvas.objects.is_empty());
}

#[test]
fn direct_reply_patch_checks_same_idea_and_retains_an_existing_snapshot() {
    let bridge = Bridge::new(Headless, 0); seed(&bridge);
    let mut plain = block(); plain["options"][0].as_object_mut().unwrap().remove("image");
    let reply = bridge.write_reply(serde_json::from_value(json!({"id":"legacy","source_id":"test-task","title":"另一种表达","blocks":[plain]})).unwrap()).unwrap();
    let request = |revision| serde_json::from_value(json!({"reply_id":"legacy","expected_revision":revision,"block":block()})).unwrap();
    assert!(bridge.patch_reply(request(reply.revision)).is_err());
    let board = bridge.board();
    let object = board.canvas.objects.iter().find(|object| matches!(&object.content, spellcast_core::CanvasContent::Reply { id } if id == "legacy")).unwrap();
    let composition = board.canvas.composition("idea").unwrap();
    let mut members = composition.members.clone(); members.push(object.id.clone());
    let outcome = bridge.canvas_batch(batch("join", json!([{"op":"compose","id":"idea","expected_revision":composition.revision,"title":"日历","members":members}])), None).unwrap();
    assert_eq!(outcome.result.status, CanvasBatchStatus::Applied);
    let saved = bridge.patch_reply(request(reply.revision)).unwrap();
    bridge.canvas_batch(batch("source-update", json!([{"op":"patch_content","id":"picture","expected_revision":1,"fields":{"src":"data:image/png;base64,AAAA"}}])), None).unwrap();
    let mut renamed = block(); renamed["options"][0]["title"] = json!("保留旧画面");
    let updated = bridge.patch_reply(serde_json::from_value(json!({"reply_id":"legacy","expected_revision":saved.revision,"block":renamed})).unwrap()).unwrap();
    assert_eq!(serde_json::to_value(updated).unwrap()["blocks"][0]["options"][0]["image"], image());
}

//! A frozen user-selected Canvas context for a new conversation. No delivery or acknowledgement.
use crate::{canvas, Bridge};
use serde_json::{json, Value};
use spellcast_core::{inbox::CanvasAnchor, SpellcastError};

impl Bridge {
    pub fn new_chat_context(&self, text: &str, anchors: &[CanvasAnchor]) -> Result<Value, SpellcastError> {
        if text.trim().is_empty() || text.chars().count() > 4_000 {
            return Err(SpellcastError::user("请填写不超过 4000 字的请求。"));
        }
        if anchors.is_empty() { return Err(SpellcastError::user("请先选择要讨论的画布内容。")); }
        let state = self.state.lock().unwrap();
        canvas::validate_anchors(&state.session, anchors)?;
        let mut selected = Vec::new();
        for anchor in anchors {
            self.validate_input_anchor(&state.session, anchor)?;
            let (snapshot, origin) = spellcast_core::capture_anchor_snapshot(&state.session, anchor, true)?;
            selected.push(json!({"anchor":anchor,"snapshot":snapshot,"origin":origin}));
        }
        Ok(json!({"selection":selected,"annotations":canvas::annotation_context(&state.session, anchors)?}))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn unlinked_content_and_exact_annotations_are_captured_without_sending() {
        let bridge = Bridge::new(crate::Headless, 0);
        let batch = |id: &str, operations: Value| serde_json::from_value(json!({"request_id":id,"operations":operations})).unwrap();
        bridge.canvas_batch(batch("new-chat-seed", json!([
            {"op":"create","id":"rule","content":{"type":"text","title":"规则","text":"原始内容"},"placement":{}}
        ])), None).unwrap();
        bridge.canvas_batch(batch("new-chat-note", json!([
            {"op":"annotate","id":"note","expected_revision":0,"anchor":{"object_id":"rule","content_revision":1},"text":"我的批注"}
        ])), None).unwrap();
        let before = serde_json::to_value(bridge.board()).unwrap();
        let events = bridge.events_since(0).1;
        let anchor: CanvasAnchor = serde_json::from_value(json!({"object_id":"rule","content_revision":1,"annotations":[{"id":"note","revision":1}]})).unwrap();
        let context = bridge.new_chat_context("请分析规则", &[anchor.clone()]).unwrap();
        assert_eq!(context["selection"][0]["snapshot"]["text"], "原始内容");
        assert_eq!(context["annotations"][0]["text"], "我的批注");
        assert_eq!(context["annotations"][0]["revision"], 1);
        assert_eq!(serde_json::to_value(bridge.board()).unwrap(), before);
        assert_eq!(bridge.events_since(0).1, events);
        let mut stale=anchor.clone(); stale.content_revision=2;
        assert!(bridge.new_chat_context("request", &[stale]).is_err());
        let mut stale_note=anchor.clone(); stale_note.annotations[0].revision=2;
        assert!(bridge.new_chat_context("request", &[stale_note]).is_err());
        assert!(bridge.new_chat_context("", &[anchor]).is_err());
        assert!(bridge.new_chat_context("request", &[]).is_err());
    }
}

//! User actions on independently stored structured components.
use serde::{Deserialize, Serialize};
use spellcast_core::{AgentEvent, BoardSnapshot, CanvasContent, ReplyAction, ReplyBlock, SpellcastError};
use crate::{feedback, Bridge};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BlockActionRequest {
    pub expected_revision: u64,
    pub block_id: String,
    pub action: ReplyAction,
    #[serde(default)] pub request_id: Option<String>,
    #[serde(default)] pub source_id: Option<String>,
    #[serde(default)] pub option_id: Option<String>,
    #[serde(default)] pub text: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};
    use spellcast_core::{CanvasBatchRequest, CanvasContent};

    fn batch(id: &str, operations: Value) -> CanvasBatchRequest {
        serde_json::from_value(json!({"request_id": id, "operations": operations})).unwrap()
    }
    fn comparison() -> Value {
        json!({"type":"comparison","id":"choices","title":"两个方案","criteria":["成本"],"options":[
            {"id":"a","title":"方案 A","summary":"","values":["低"]},
            {"id":"b","title":"方案 B","summary":"","values":["高"]}
        ]})
    }
    fn request(id: &str, action: &str, revision: u64) -> BlockActionRequest {
        serde_json::from_value(json!({"request_id":id,"expected_revision":revision,"block_id":"choices","action":action,"option_id":"b","text":"请继续完善这个方案。","source_id":"task-a"})).unwrap()
    }
    fn setup() -> Bridge {
        let bridge = Bridge::new(crate::Headless, 0);
        bridge.canvas_batch(batch("create", json!([{"op":"create","id":"atom","content":{"type":"block","block":comparison()}}])), Some("task-a")).unwrap();
        bridge
    }

    #[test]
    fn selection_is_versioned_and_retried_without_duplicate_feedback() {
        let bridge = setup();
        let first = bridge.canvas_block_action("atom", request("select", "select", 1)).unwrap();
        let object = first.board.canvas.object("atom").unwrap();
        assert_eq!(object.content_revision, 2);
        assert!(!object.user_edited, "Selecting an option is not rewriting its content.");
        assert!(matches!(&object.content, CanvasContent::Block { block: ReplyBlock::Comparison { selected_id: Some(id), .. } } if id == "b"));
        assert_eq!(first.event.source_id.as_deref(), Some("task-a"));
        assert_eq!(first.event.object_revision, Some(2));
        assert_eq!(first.event.reply_id, None, "Renderer adapters are never persisted as replies.");
        assert_eq!(first.event.anchors[0].block_id.as_deref(), Some("choices"));
        let repeated = bridge.canvas_block_action("atom", request("select", "select", 1)).unwrap();
        assert_eq!(repeated.event.seq, first.event.seq);
        assert_eq!(first.event.kind, "canvas_state");
        assert!(bridge.pending_feedback(Some("task-a")).is_empty());
        assert!(bridge.feedback_state(None).deliveries.is_empty());
        assert!(bridge.pending_feedback(Some("task-b")).is_empty());
    }

    #[test]
    fn invalid_action_leaves_choice_revision_and_feedback_unchanged() {
        let bridge = setup();
        let before = bridge.board();
        let mut invalid = request("bad", "select", 1); invalid.option_id = Some("missing".into());
        assert!(bridge.canvas_block_action("atom", invalid).is_err());
        assert!(bridge.canvas_block_action("atom", request("stale", "ask", 99)).is_err());
        let mut foreign = request("foreign", "ask", 1); foreign.source_id = Some("task-b".into());
        assert!(bridge.canvas_block_action("atom", foreign).is_err());
        assert_eq!(serde_json::to_value(bridge.board()).unwrap(), serde_json::to_value(before).unwrap());
        assert!(bridge.pending_feedback(None).is_empty());
    }

    #[test]
    fn unassigned_choice_is_local_and_replays_after_restart_without_pending_feedback() {
        let path = std::env::temp_dir().join(format!("spellcast-local-choice-{}.sqlite3", spellcast_core::new_id()));
        let seq;
        {
            let bridge = Bridge::open(crate::Headless, 0, &path).unwrap();
            bridge.canvas_batch(batch("local-create", json!([{"op":"create","id":"atom","content":{"type":"block","block":comparison()}}])), None).unwrap();
            let mut choose = request("local-choice", "select", 1); choose.source_id = None;
            let first = bridge.canvas_block_action("atom", choose.clone()).unwrap(); seq = first.event.seq;
            assert_eq!(first.event.kind, "canvas_state");
            assert_eq!(bridge.canvas_block_action("atom", choose).unwrap().event.seq, seq);
            assert!(bridge.feedback_state(None).pending.is_empty()); assert!(bridge.feedback_state(None).deliveries.is_empty());
        }
        let bridge = Bridge::open(crate::Headless, 0, &path).unwrap();
        let mut choose = request("local-choice", "select", 1); choose.source_id = None;
        assert_eq!(bridge.canvas_block_action("atom", choose).unwrap().event.seq, seq);
        assert_eq!(bridge.board().canvas.object("atom").unwrap().content_revision, 2);
        assert!(bridge.feedback_state(None).pending.is_empty()); assert!(bridge.feedback_state(None).deliveries.is_empty());
        drop(bridge); let _ = std::fs::remove_file(path);
    }

    #[test]
    fn moving_graph_nodes_keeps_content_editable_and_positions_protected() {
        let bridge = Bridge::new(crate::Headless, 0);
        let block = json!({"type":"graph","id":"graph","title":"关系","nodes":[{"id":"n","title":"原节点","detail":"","x":0,"y":0}],"edges":[]});
        bridge.canvas_batch(batch("graph-create", json!([{"op":"create","id":"graph-atom","content":{"type":"block","block":block}}])), Some("task-a")).unwrap();
        let mut moved = block.clone(); moved["nodes"][0]["x"] = json!(80); moved["nodes"][0]["y"] = json!(90);
        bridge.canvas_batch(batch("move", json!([{"op":"patch_block","id":"graph-atom","expected_revision":1,"block":moved}])), None).unwrap();
        assert!(!bridge.board().canvas.object("graph-atom").unwrap().user_edited);
        let mut updated = block; updated["nodes"][0]["title"] = json!("补充后的节点");
        let outcome = bridge.canvas_batch(batch("continue", json!([{"op":"patch_block","id":"graph-atom","expected_revision":2,"block":updated}])), Some("task-a")).unwrap();
        assert_eq!(outcome.result.status, "applied");
        let CanvasContent::Block { block: ReplyBlock::Graph { nodes, .. } } = &outcome.board.canvas.object("graph-atom").unwrap().content else { panic!("graph missing") };
        assert_eq!(nodes[0].title, "补充后的节点"); assert_eq!(nodes[0].x, Some(80.0)); assert_eq!(nodes[0].y, Some(90.0));
    }
}

#[derive(Debug, Serialize)]
pub struct BlockActionOutcome {
    pub board: BoardSnapshot,
    pub event: AgentEvent,
}

impl Bridge {
    pub fn canvas_block_action(&self, id: &str, request: BlockActionRequest) -> Result<BlockActionOutcome, SpellcastError> {
        spellcast_core::reply::validate_id(id)?;
        if let Some(source) = &request.source_id { spellcast_core::reply::validate_id(source)?; }
        let fingerprint = feedback::fingerprint("canvas-block-action", &(id, &request))?;
        let result = self.update(|state| {
            let index = state.session.board.canvas.objects.iter().position(|object| object.id == id)
                .ok_or_else(|| SpellcastError::user("这个组件已经不在画布中。"))?;
            if let Some(event) = self.replay_request(state, request.request_id.as_deref(), &fingerprint)? {
                return Ok(BlockActionOutcome { board: state.session.snapshot(), event });
            }
            let object = &state.session.board.canvas.objects[index];
            if object.content_revision != request.expected_revision { return Err(SpellcastError::user("组件已有新版本；请核对后重试，输入仍保留。")); }
            let CanvasContent::Block { block } = &object.content else { return Err(SpellcastError::user("这个对象不是独立组件。")); };
            if block.id() != request.block_id { return Err(SpellcastError::user("组件身份已经改变。")); }
            if object.source_id.is_some() && request.source_id.is_some() && object.source_id != request.source_id {
                return Err(SpellcastError::user("接收任务已改变；没有发送这次操作。"));
            }
            let source = object.source_id.clone().or(request.source_id.clone());
            if request.action == ReplyAction::Ask && source.is_none() { return Err(SpellcastError::user("请先选择接收这条输入的原任务。")); }
            let mut changed = block.clone();
            let title = block.title().to_string();
            let text = match request.action {
                ReplyAction::Ask => {
                    let text = request.text.as_deref().unwrap_or("").trim();
                    if text.is_empty() || text.chars().count() > 4000 { return Err(SpellcastError::user("请输入 1–4000 字的修改或讨论内容。")); }
                    text.to_string()
                }
                ReplyAction::Select => {
                    let ReplyBlock::Comparison { options, selected_id, .. } = &mut changed else { return Err(SpellcastError::user("只有对比组件可以选择方案。")); };
                    let option = options.iter().find(|option| Some(&option.id) == request.option_id.as_ref())
                        .ok_or_else(|| SpellcastError::user("这个方案已经不存在。"))?;
                    *selected_id = Some(option.id.clone());
                    format!("选择了方案「{}」。", option.title)
                }
            };
            changed.validate()?;
            let object = &mut state.session.board.canvas.objects[index];
            if object.content != (CanvasContent::Block { block: changed.clone() }) || object.source_id != source {
                object.content = CanvasContent::Block { block: changed };
                object.source_id = source.clone();
                object.content_revision += 1;
                state.session.board.canvas.revision += 1;
            }
            let revision = object.content_revision;
            let mut event = AgentEvent::new(if request.action == ReplyAction::Select { "canvas_state" } else { "say" })
                .source(source).title(title).text(text);
            event.object_id = Some(id.to_string()); event.object_revision = Some(revision);
            event.block_id = Some(request.block_id.clone()); event.option_id = request.option_id.clone(); event.request_id = request.request_id.clone();
            event.anchors.push(spellcast_core::inbox::CanvasAnchor { object_id: id.to_string(), content_revision: revision,
                block_id: Some(request.block_id.clone()), selection: None, region: None, artifact: None, inputs: None, compositions: vec![] });
            let event = state.record(event); state.stamp_request(event.seq, fingerprint);
            Ok(BlockActionOutcome { board: state.session.snapshot(), event })
        })?;
        self.notify.notify_waiters(); self.surface.board_changed();
        Ok(result)
    }
}

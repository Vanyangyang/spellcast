//! Canvas transactions use the existing session snapshot and durable feedback queue.

use rmcp::schemars::{self, JsonSchema};
use serde::{Deserialize, Serialize};
use spellcast_core::inbox::{now_ms, CanvasAnchor};
use spellcast_core::{CanvasBatchRequest, CanvasBatchResult, CanvasBatchStatus, CanvasContent, CanvasOperation, CanvasProposal, CanvasRead, CanvasTargetKind, CanvasTargetState, CanvasTargetStatus, ReplyBlock, Session, SpellcastError};

use crate::{feedback::DeliveryPhase, Bridge, PersistedState};

#[derive(Debug, Deserialize, JsonSchema)]
pub struct CanvasSubmission {
    pub source_id: String,
    #[serde(flatten)]
    pub batch: CanvasBatchRequest,
}

#[derive(Debug, Deserialize)]
pub struct CanvasProposalAction {
    pub action: String,
    #[serde(default)]
    pub current: Vec<CanvasRead>,
}

#[derive(Debug, Serialize)]
pub struct CanvasOutcome {
    pub result: CanvasBatchResult,
    pub board: spellcast_core::BoardSnapshot,
}

impl Bridge {
    pub fn canvas_batch(&self, request: CanvasBatchRequest, source_id: Option<&str>) -> Result<CanvasOutcome, SpellcastError> {
        if let Some(source) = source_id { spellcast_core::reply::validate_id(source)?; }
        if source_id.is_none() && !request.feedback_sequences.is_empty() {
            return Err(SpellcastError::user("只有接收反馈的任务可以关联处理结果。"));
        }
        let outcome = self.update(|state| {
            if state.session.board.canvas.proposal(&request.request_id).is_some() {
                let result = state.session.apply_canvas_batch(request, source_id)?;
                return Ok(CanvasOutcome { result, board: state.session.snapshot() });
            }
            if let Some(source) = source_id {
                validate_feedback(state, source, &request)?;
            }
            let mut candidate = state.session.clone();
            let mut result = candidate.apply_canvas_batch(request.clone(), source_id)?;
            let issues = self.canvas_resource_issues(&candidate, &state.session, &request);
            if issues.is_empty() {
                state.session = candidate;
            } else {
                resource_failure(&mut result, issues);
                state.session.board.canvas.proposals.push(CanvasProposal { request: request.clone(), source_id: source_id.map(String::from), result: result.clone() });
            }
            if result.status == "applied" {
                capture_origins(state, &request, source_id);
                if let Some(source) = source_id { mark_response(state, source, &request); }
            }
            state.session.sync_canvas();
            Ok(CanvasOutcome { result, board: state.session.snapshot() })
        })?;
        self.notify.notify_waiters();
        self.surface.board_changed();
        Ok(outcome)
    }

    pub fn canvas_proposal(&self, request_id: &str, action: CanvasProposalAction) -> Result<CanvasOutcome, SpellcastError> {
        let outcome = self.update(|state| {
            let proposal = state.session.board.canvas.proposals.iter().find(|p| p.request.request_id == request_id)
                .cloned().ok_or_else(|| SpellcastError::user("这项提案已经不存在。"))?;
            let result = match action.action.as_str() {
                "dismiss" => state.session.dismiss_canvas_proposal(request_id)?,
                "apply" => {
                    if proposal.result.status == CanvasBatchStatus::Applied {
                        return Ok(CanvasOutcome { result: proposal.result, board: state.session.snapshot() });
                    }
                    if proposal.result.status == CanvasBatchStatus::Dismissed {
                        return Err(SpellcastError::user("提案已经放弃，请重新提出修改。"));
                    }
                    let mut candidate = state.session.clone();
                    let mut result = candidate.apply_canvas_proposal(request_id, action.current)?;
                    let issues = self.canvas_resource_issues(&candidate, &state.session, &proposal.request);
                    if !issues.is_empty() {
                        resource_failure(&mut result, issues);
                        state.session.board.canvas.proposals.iter_mut().find(|p| p.request.request_id == request_id).unwrap().result = result.clone();
                        return Ok(CanvasOutcome { result, board: state.session.snapshot() });
                    }
                    state.session = candidate;
                    if result.status == "applied" && proposal.result.status != "applied" {
                        capture_origins(state, &proposal.request, proposal.source_id.as_deref());
                        if let Some(source) = &proposal.source_id { mark_response(state, source, &proposal.request); }
                    }
                    result
                }
                _ => return Err(SpellcastError::user("未知的提案操作。")),
            };
            state.session.sync_canvas();
            Ok(CanvasOutcome { result, board: state.session.snapshot() })
        })?;
        self.notify.notify_waiters();
        self.surface.board_changed();
        Ok(outcome)
    }

    fn canvas_resource_issues(&self, session: &Session, current: &Session, request: &CanvasBatchRequest) -> Vec<CanvasTargetStatus> {
        request.operations.iter().filter_map(|op| self.validate_canvas_resource(session, op).err().map(|error| {
            let (id, expected) = match op {
                CanvasOperation::Create { id, .. } => (id, 0),
                CanvasOperation::PatchContent { id, expected_revision, .. } | CanvasOperation::PatchReply { id, expected_revision, .. } | CanvasOperation::Bind { id, expected_revision, .. }
                | CanvasOperation::PatchBlock { id, expected_revision, .. }
                | CanvasOperation::Place { id, expected_revision, .. } | CanvasOperation::Compose { id, expected_revision, .. } | CanvasOperation::Ungroup { id, expected_revision } => (id, *expected_revision),
            };
            CanvasTargetStatus { kind: CanvasTargetKind::Content, id: id.clone(), status: CanvasTargetState::Invalid,
                expected_revision: Some(expected), actual_revision: current.board.canvas.object(id).map(|o| o.content_revision), message: Some(error.to_string()) }
        })).collect()
    }

    fn validate_canvas_resource(&self, session: &Session, op: &CanvasOperation) -> Result<(), SpellcastError> {
            match op {
                CanvasOperation::Create { content, bindings, .. } => {
                    for binding in bindings { self.validate_binding_ports(session, content, binding)?; }
                }
                CanvasOperation::Bind { id, bindings, .. } => {
                    let object = session.board.canvas.object(id).ok_or_else(|| SpellcastError::user("连接的目标已经不存在。"))?;
                    for binding in bindings { self.validate_binding_ports(session, &object.content, binding)?; }
                }
                _ => {}
            }
            if let CanvasOperation::PatchReply { id, block, .. } = op {
                if let Some(object) = session.board.canvas.object(id) {
                    if let CanvasContent::Reply { id } = &object.content {
                        if let Some(reply) = session.board.replies.iter().find(|reply| &reply.id == id) {
                            self.validate_artifacts(&reply.source_id, std::slice::from_ref(block))?;
                        }
                    }
                }
            }
            let src = match op {
                CanvasOperation::Create { content: CanvasContent::Image { src, .. }, .. } => Some(src),
                CanvasOperation::PatchContent { fields, .. } => fields.src.as_ref(),
                _ => None,
            };
            if let Some(local) = src.and_then(|src| src.strip_prefix("/artifacts/")) {
                let (bundle, name) = local.split_once('/').ok_or_else(|| SpellcastError::user("图片资源路径缺少文件名。"))?;
                let artifact = self.artifact(bundle)?;
                if !artifact.files.iter().any(|file| file.name == name && file.media_type.starts_with("image/")) {
                    return Err(SpellcastError::user("这个图片资源不存在。"));
                }
            }
        Ok(())
    }
}

fn resource_failure(result: &mut CanvasBatchResult, issues: Vec<CanvasTargetStatus>) {
    result.status = CanvasBatchStatus::Proposed;
    for issue in issues {
        if let Some(target) = result.targets.iter_mut().find(|target| target.kind == issue.kind && target.id == issue.id) { *target = issue; }
        else { result.targets.push(issue); }
    }
}

fn validate_feedback(state: &PersistedState, source: &str, request: &CanvasBatchRequest) -> Result<(), SpellcastError> {
    if request.feedback_sequences.len() > 64 {
        return Err(SpellcastError::user("一次最多关联 64 条反馈。"));
    }
    let mut seen = std::collections::HashSet::new();
    for seq in &request.feedback_sequences {
        if !seen.insert(seq) { return Err(SpellcastError::user("反馈序号不能重复。")); }
        let event = state.pending.iter().find(|e| e.seq == *seq && e.source_id.as_deref() == Some(source))
            .ok_or_else(|| SpellcastError::user("反馈已处理、不存在或属于其他任务。"))?;
        for id in event.anchors.iter().map(|a| &a.object_id).chain(event.object_id.iter())
            .chain(event.anchors.iter().filter_map(|a| a.inputs.as_ref()).flat_map(|inputs| inputs.ports.values())
                .filter(|port| port.status == spellcast_core::inbox::CanvasPortStatus::Available).flat_map(|port| port.sources.iter().map(|source| &source.object_id))) {
            if !request.reads.iter().any(|read| read.kind == CanvasTargetKind::Content && &read.id == id) {
                return Err(SpellcastError::user("请声明所引用反馈对象的内容版本依赖，再提交结果。"));
            }
        }
        for group in event.anchors.iter().flat_map(|anchor| &anchor.compositions) {
            if !request.reads.iter().any(|read| read.kind == CanvasTargetKind::Composition && read.id == group.id) {
                return Err(SpellcastError::user("请声明所引用想法组合的版本依赖，再提交结果。"));
            }
        }
    }
    Ok(())
}

fn capture_origins(state: &mut PersistedState, request: &CanvasBatchRequest, source: Option<&str>) {
    let Some(binding) = source.and_then(|source| state.bindings.iter().find(|binding| binding.source_id == source)) else { return; };
    let cwd = binding.cwd.clone();
    if cwd.is_empty() { return; }
    let origin = spellcast_core::CanvasOrigin { cwd, thread_id: Some(binding.thread_id.clone()), source_id: Some(binding.source_id.clone()), label: binding.label.clone() };
    for operation in &request.operations {
        if let CanvasOperation::Create { id, .. } = operation {
            if let Some(object) = state.session.board.canvas.objects.iter_mut().find(|object| object.id == *id) { object.origin = Some(origin.clone()); }
        }
    }
}

fn mark_response(state: &mut PersistedState, source: &str, request: &CanvasBatchRequest) {
    let ids: Vec<_> = request.operations.iter().map(|op| match op {
        CanvasOperation::Create { id, .. } | CanvasOperation::PatchContent { id, .. }
        | CanvasOperation::PatchReply { id, .. } | CanvasOperation::PatchBlock { id, .. } | CanvasOperation::Bind { id, .. } | CanvasOperation::Place { id, .. }
        | CanvasOperation::Compose { id, .. } | CanvasOperation::Ungroup { id, .. } => id.clone(),
    }).collect();
    for receipt in &mut state.deliveries {
        if request.feedback_sequences.contains(&receipt.event.seq) && receipt.event.source_id.as_deref() == Some(source) {
            receipt.responded_at_ms.get_or_insert_with(now_ms);
            receipt.response_request_id = Some(request.request_id.clone());
            receipt.response_object_ids = ids.clone();
            if receipt.phase != DeliveryPhase::Handled { receipt.phase = DeliveryPhase::Responded; }
            receipt.error = None;
        }
    }
}

/// Validate every reference before recording one request for one receiving task.
pub(crate) fn validate_anchors(session: &Session, anchors: &[CanvasAnchor]) -> Result<(), SpellcastError> {
    if anchors.len() > 64 || serde_json::to_vec(anchors)?.len() > 128 * 1024 {
        return Err(SpellcastError::user("一次最多引用 64 个位置，参数快照不能超过 128 KB。"));
    }
    let mut input_bytes = std::collections::HashMap::<&str, usize>::new();
    for anchor in anchors {
        if anchor.compositions.len() > 64 { return Err(SpellcastError::user("组合引用过多。")); }
        for reference in &anchor.compositions {
            let group = session.board.canvas.composition(&reference.id).ok_or_else(|| SpellcastError::user("想法组合已不存在。"))?;
            if group.revision != reference.revision || !session.board.canvas.composition_reaches(&reference.id, &anchor.object_id) {
                return Err(SpellcastError::user("想法的说明或成员已经改变，请重新查看后再发送。"));
            }
        }
        if let Some(inputs) = &anchor.inputs {
            let bytes = input_bytes.entry(&anchor.object_id).or_default();
            *bytes += serde_json::to_vec(inputs)?.len();
            if *bytes > 64_000 { return Err(SpellcastError::user("每个对象的输入快照不能超过 64 KB。")); }
        }
        let object = session.board.canvas.object(&anchor.object_id)
            .ok_or_else(|| SpellcastError::user("引用的对象已不存在。"))?;
        if object.content_revision != anchor.content_revision {
            return Err(SpellcastError::user("引用内容已经更新；请查看最新内容后重新选择。"));
        }
        let mut text: Option<String> = None;
        let mut block = None;
        match &object.content {
            CanvasContent::Node { id } => {
                if let Some(node) = session.board.nodes.iter().find(|n| &n.id == id) {
                    text = Some(format!("{}\n{}", node.title, node.body));
                }
                if anchor.block_id.as_deref().is_some_and(|id| id != "text") {
                    return Err(SpellcastError::user("想法没有这个子项。"));
                }
            }
            CanvasContent::Reply { id } => {
                let reply = session.board.replies.iter().find(|r| &r.id == id).ok_or_else(|| SpellcastError::user("回复已经不存在。"))?;
                if let Some(id) = &anchor.block_id {
                    block = Some(reply.blocks.iter().find(|b| b.id() == id).ok_or_else(|| SpellcastError::user("引用的子项已经不存在。"))?);
                }
                if let Some(ReplyBlock::Text { title, text: body, .. }) = block { text = Some(format!("{title}\n{body}")); }
            }
            CanvasContent::Block { block: atom } => {
                if anchor.block_id.as_deref().is_some_and(|id| id != atom.id()) { return Err(SpellcastError::user("引用的组件子项已经不存在。")); }
                block = Some(atom);
                if let ReplyBlock::Text { title, text: body, .. } = atom { text = Some(format!("{title}\n{body}")); }
            }
            CanvasContent::Text { title, text: body } | CanvasContent::Shape { title, text: body, .. } => {
                text = Some(format!("{title}\n{body}"));
                if anchor.block_id.is_some() { return Err(SpellcastError::user("这个对象没有独立子项。")); }
            }
            CanvasContent::Image { .. } => {
                if anchor.block_id.is_some() { return Err(SpellcastError::user("图片没有独立子项。")); }
            }
        }
        if let Some(selection) = &anchor.selection {
            if selection.is_empty() || selection.len() > 16_000 || !text.as_ref().is_some_and(|body| body.contains(selection)) {
                return Err(SpellcastError::user("文字选区与引用的内容不一致。"));
            }
        }
        if let Some(region) = &anchor.region {
            let valid_resource = matches!(&object.content, CanvasContent::Image { src, .. } if src == &region.resource);
            let valid_bounds = [region.x, region.y, region.width, region.height].iter().all(|n| n.is_finite())
                && region.x >= 0.0 && region.y >= 0.0 && region.width > 0.0 && region.height > 0.0
                && region.x + region.width <= 1.0000001 && region.y + region.height <= 1.0000001;
            if !valid_resource || region.unit != "normalized" || !valid_bounds {
                return Err(SpellcastError::user("图片选区的资源或坐标不一致。"));
            }
        }
        if let Some(artifact) = &anchor.artifact {
            let valid = matches!(block, Some(ReplyBlock::Artifact { bundle_id, state, state_revision, .. })
                if bundle_id == &artifact.bundle_id && state_revision == &artifact.state_revision
                    && (state == &artifact.state || (state.is_null() && artifact.state.as_object().is_some_and(|state| state.is_empty()))));
            if !valid || serde_json::to_vec(artifact)?.len() > 64 * 1024 {
                return Err(SpellcastError::user("作品版本或参数已经变化；请重新选择。"));
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};
    use spellcast_core::{new_id, SayRequest};

    fn request(id: &str, operations: Value) -> CanvasBatchRequest {
        serde_json::from_value(json!({"request_id":id,"operations":operations})).unwrap()
    }

    fn create(id: &str, text: &str) -> Value {
        json!({"op":"create","id":id,"content":{"type":"text","title":id,"text":text},"placement":{"x":100,"y":100,"width":320,"height":180}})
    }

    #[test]
    fn whole_idea_response_requires_a_current_composition_read() {
        let bridge = Bridge::new(crate::Headless, 0);
        bridge.canvas_batch(request("seed", json!([create("part", "原文"), {"op":"compose","id":"idea","expected_revision":0,"title":"想法","description":"最初说明","members":["part"]}])), Some("task")).unwrap();
        let anchors = serde_json::from_value(json!([{"object_id":"part","content_revision":1,"compositions":[{"id":"idea","revision":1}]}])).unwrap();
        let event = bridge.say(SayRequest { text: "继续这个想法".into(), source_id: Some("task".into()), anchors, ..Default::default() }).unwrap();
        bridge.canvas_batch(request("change-idea", json!([{"op":"compose","id":"idea","expected_revision":1,"title":"新名称","description":"用户整理的说明","members":["part"]}])), None).unwrap();
        let mut answer = request("answer-without-group", json!([{"op":"patch_content","id":"part","expected_revision":1,"fields":{"text":"接着发展"}}]));
        answer.feedback_sequences = vec![event.seq];
        answer.reads = vec![CanvasRead { kind: CanvasTargetKind::Content, id: "part".into(), revision: 1 }];
        assert!(bridge.canvas_batch(answer.clone(), Some("task")).unwrap_err().to_string().contains("组合的版本"));
        answer.request_id = "answer-stale-group".into();
        answer.reads.push(CanvasRead { kind: CanvasTargetKind::Composition, id: "idea".into(), revision: 1 });
        assert_eq!(bridge.canvas_batch(answer.clone(), Some("task")).unwrap().result.status, "proposed");
        answer.request_id = "answer-current-group".into(); answer.reads[1].revision = 2;
        assert_eq!(bridge.canvas_batch(answer, Some("task")).unwrap().result.status, "applied");
        assert_eq!(bridge.board().canvas.composition("idea").unwrap().description, "用户整理的说明");
    }

    #[test]
    fn native_batch_feedback_protection_and_review_survive_restart() {
        let path = std::env::temp_dir().join(format!("spellcast-canvas-batch-{}.sqlite3", new_id()));
        let proposal_id = "merge-directions";
        {
            let bridge = Bridge::open(crate::Headless, 0, &path).unwrap();
            bridge.canvas_batch(request("first", json!([create("harbor", "雾港每夜失去一个名字。"), create("tower", "灯塔为失踪者发出信号。")])), Some("story-task")).unwrap();
            bridge.canvas_batch(request("reference", json!([create("palette", "深蓝与琥珀色。") ])), Some("visual-task")).unwrap();
            let anchors = serde_json::from_value(json!([
                {"object_id":"harbor","content_revision":1,"selection":"雾港"},
                {"object_id":"palette","content_revision":1}
            ])).unwrap();
            let event = bridge.say(SayRequest { text: "合并雾港与灯塔方向，参考这个配色。".into(), source_id: Some("story-task".into()), anchors, request_id: Some("merge-ask".into()), ..Default::default() }).unwrap();
            assert_eq!(event.anchors.len(), 2);
            assert_eq!(bridge.pending_feedback(Some("story-task")).len(), 1);
            assert!(bridge.pending_feedback(Some("visual-task")).is_empty());
            let mut answer = request("answer", json!([
                {"op":"patch_content","id":"harbor","expected_revision":1,"fields":{"text":"灯塔的每次闪光，都召回雾港遗失的一个名字。"}},
                {"op":"compose","id":"story-group","expected_revision":0,"title":"归名之夜","members":["harbor","tower"]}
            ]));
            answer.reads = vec![CanvasRead { kind: CanvasTargetKind::Content, id: "harbor".into(), revision: 1 }, CanvasRead { kind: CanvasTargetKind::Content, id: "palette".into(), revision: 1 }];
            answer.feedback_sequences = vec![event.seq];
            assert_eq!(bridge.canvas_batch(answer.clone(), Some("story-task")).unwrap().result.status, "applied");
            let receipt = &bridge.feedback_state(Some("story-task")).deliveries[0];
            assert_eq!(receipt.phase, DeliveryPhase::Responded);
            assert_eq!(receipt.response_request_id.as_deref(), Some("answer"));
            assert!(receipt.response_object_ids.contains(&"harbor".into()));
            bridge.acknowledge_feedback("story-task", &[event.seq]).unwrap();
            assert_eq!(bridge.canvas_batch(answer.clone(), Some("story-task")).unwrap().result.status, "applied");
            answer.feedback_sequences.clear();
            assert!(bridge.canvas_batch(answer, Some("story-task")).is_err());

            bridge.canvas_batch(request("user-title", json!([{"op":"patch_content","id":"harbor","expected_revision":2,"fields":{"title":"留名之港"}}])), None).unwrap();
            let before = bridge.board();
            let move_revision = before.canvas.items.iter().find(|p| p.item_id == "tower").unwrap().revision;
            let proposed = bridge.canvas_batch(request(proposal_id, json!([
                {"op":"patch_content","id":"harbor","expected_revision":3,"fields":{"text":"以丢失名字的孩子作为主角。"}},
                {"op":"place","id":"tower","expected_revision":move_revision,"fields":{"x":720}}
            ])), Some("story-task")).unwrap();
            assert_eq!(proposed.result.status, "proposed");
            assert!(proposed.result.targets.iter().any(|t| t.status == "protected"));
            assert!(proposed.result.targets.iter().any(|t| t.status == "ready"));
            assert_eq!(before.canvas.items, proposed.board.canvas.items);
            assert_eq!(before.canvas.objects, proposed.board.canvas.objects);
        }
        {
            let bridge = Bridge::open(crate::Headless, 0, &path).unwrap();
            let before = bridge.board();
            assert_eq!(before.canvas.compositions[0].members, ["harbor", "tower"]);
            let current = vec![
                CanvasRead { kind: CanvasTargetKind::Content, id: "harbor".into(), revision: before.canvas.object("harbor").unwrap().content_revision },
                CanvasRead { kind: CanvasTargetKind::Presentation, id: "tower".into(), revision: before.canvas.items.iter().find(|p| p.item_id == "tower").unwrap().revision },
            ];
            let outcome = bridge.canvas_proposal(proposal_id, CanvasProposalAction { action: "apply".into(), current }).unwrap();
            assert_eq!(outcome.result.status, "applied");
            assert!(matches!(&outcome.board.canvas.object("harbor").unwrap().content, CanvasContent::Text { title, text } if title == "留名之港" && text == "以丢失名字的孩子作为主角。"));
            assert_eq!(outcome.board.canvas.items.iter().find(|p| p.item_id == "tower").unwrap().x, 720.0);
            assert!(bridge.pending_feedback(Some("visual-task")).is_empty());
        }
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn resource_failures_keep_atomic_proposals_and_exact_retries_survive_acknowledgement() {
        let bridge = Bridge::new(crate::Headless, 0);
        bridge.canvas_batch(request("seed", json!([create("brief", "夜航的故事") ])), Some("story-task")).unwrap();
        let event = bridge.say(SayRequest { text: "配一张图。".into(), source_id: Some("story-task".into()),
            anchors: serde_json::from_value(json!([{"object_id":"brief","content_revision":1}])).unwrap(), ..Default::default() }).unwrap();
        let mut candidate = request("missing-resource", json!([create("new-heading", "候选标题"),
            {"op":"create","id":"new-image","content":{"type":"image","title":"封面","src":"/artifacts/missing/cover.png","alt":"灯塔"},"placement":{}}
        ]));
        candidate.feedback_sequences = vec![event.seq];
        candidate.reads = vec![CanvasRead { kind: CanvasTargetKind::Content, id: "brief".into(), revision: 1 }];
        let first = bridge.canvas_batch(candidate.clone(), Some("story-task")).unwrap();
        assert_eq!(first.result.status, CanvasBatchStatus::Proposed);
        assert!(first.result.targets.iter().any(|target| target.id == "new-heading" && target.status == CanvasTargetState::Ready));
        assert!(first.result.targets.iter().any(|target| target.id == "new-image" && target.status == CanvasTargetState::Invalid));
        assert_eq!(bridge.board().canvas.objects.len(), 1);
        bridge.acknowledge_feedback("story-task", &[event.seq]).unwrap();
        assert_eq!(bridge.canvas_batch(candidate.clone(), Some("story-task")).unwrap().result, first.result);
        bridge.canvas_proposal("missing-resource", CanvasProposalAction { action: "dismiss".into(), current: vec![] }).unwrap();
        assert_eq!(bridge.canvas_batch(candidate, Some("story-task")).unwrap().result.status, CanvasBatchStatus::Dismissed);
        assert!(bridge.canvas_proposal("missing-resource", CanvasProposalAction { action: "apply".into(), current: vec![] }).is_err());
    }

    #[test]
    fn feedback_rejects_stale_content_and_wrong_image_regions_without_queueing() {
        let bridge = Bridge::new(crate::Headless, 0);
        bridge.canvas_batch(request("image", json!([{"op":"create","id":"cover","content":{"type":"image","title":"封面","src":"https://example.test/cover.png","alt":"雾中的灯塔"},"placement":{}}])), Some("visual-task")).unwrap();
        let valid = json!({"object_id":"cover","content_revision":1,"region":{"resource":"https://example.test/cover.png","unit":"normalized","x":0.2,"y":0.1,"width":0.3,"height":0.4}});
        let mut stale = valid.clone(); stale["content_revision"] = json!(0);
        assert!(bridge.say(SayRequest { text: "调整这里的光。".into(), source_id: Some("visual-task".into()), anchors: vec![serde_json::from_value(stale).unwrap()], ..Default::default() }).is_err());
        let mut wrong = valid.clone(); wrong["region"]["resource"] = json!("https://example.test/other.png");
        assert!(bridge.say(SayRequest { text: "修改这里。".into(), source_id: Some("visual-task".into()), anchors: vec![serde_json::from_value(wrong).unwrap()], ..Default::default() }).is_err());
        let mut outside = valid.clone(); outside["region"]["width"] = json!(1.2);
        assert!(bridge.say(SayRequest { text: "修改这里。".into(), source_id: Some("visual-task".into()), anchors: vec![serde_json::from_value(outside).unwrap()], ..Default::default() }).is_err());
        assert!(bridge.pending_feedback(None).is_empty());
        bridge.say(SayRequest { text: "调整这里的光。".into(), source_id: Some("visual-task".into()), anchors: vec![serde_json::from_value(valid).unwrap()], ..Default::default() }).unwrap();
        assert_eq!(bridge.pending_feedback(Some("visual-task")).len(), 1);
    }
}

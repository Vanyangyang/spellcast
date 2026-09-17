//! Declared data connections and input evidence; executable work stays in its sandbox.
use std::collections::{BTreeMap, HashSet};

use spellcast_core::inbox::{CanvasAnchor, CanvasDataSource, CanvasPortStatus};
use spellcast_core::{CanvasBinding, CanvasContent, ReplyBlock, Session, SpellcastError};

use crate::artifacts::ArtifactPortType;
use crate::Bridge;

fn error(message: &str) -> SpellcastError { SpellcastError::user(message) }

fn work<'a>(session: &'a Session, object_id: &str, block_id: &str) -> Result<&'a ReplyBlock, SpellcastError> {
    let object = session.board.canvas.object(object_id).ok_or_else(|| error("连接的对象已经不存在。"))?;
    let CanvasContent::Reply { id } = &object.content else { return Err(error("输出必须来自声明接口的作品。")); };
    session.board.replies.iter().find(|reply| &reply.id == id)
        .and_then(|reply| reply.blocks.iter().find(|block| block.id() == block_id))
        .filter(|block| matches!(block, ReplyBlock::Artifact { .. }))
        .ok_or_else(|| error("连接的作品子项已经不存在。"))
}

impl Bridge {
    pub(crate) fn validate_binding_ports(&self, session: &Session, target: &CanvasContent, binding: &CanvasBinding) -> Result<(), SpellcastError> {
        let ReplyBlock::Artifact { bundle_id, .. } = work(session, &binding.from.object_id, &binding.from.block_id)? else { unreachable!() };
        let source = self.artifact(bundle_id)?;
        let output = source.io.outputs.get(&binding.from.port).ok_or_else(|| error("上游没有声明这个输出。"))?;
        if matches!(target, CanvasContent::Text { .. }) && binding.to.block_id.is_none() && binding.to.port == "text" { return Ok(()); }
        let block_id = binding.to.block_id.as_deref().ok_or_else(|| error("作品输入需要明确的子项。"))?;
        let CanvasContent::Reply { id } = target else { return Err(error("目标需要是文字对象或作品输入。")); };
        let Some(ReplyBlock::Artifact { bundle_id, .. }) = session.board.replies.iter().find(|reply| &reply.id == id).and_then(|reply| reply.blocks.iter().find(|block| block.id() == block_id)) else { return Err(error("目标作品子项已经不存在。")); };
        let bundle = self.artifact(bundle_id)?;
        let input = bundle.io.inputs.get(&binding.to.port).ok_or_else(|| error("目标作品没有声明这个输入。"))?;
        if input != output { return Err(error("连接两端的数据类型不一致。")); }
        Ok(())
    }

    fn input_ports(&self, session: &Session, anchor: &CanvasAnchor) -> Result<BTreeMap<String, Option<ArtifactPortType>>, SpellcastError> {
        let object = session.board.canvas.object(&anchor.object_id).ok_or_else(|| error("引用的对象已经不存在。"))?;
        if matches!(object.content, CanvasContent::Text { .. }) {
            return Ok(object.bindings.iter().map(|b| (b.to.port.clone(), None)).collect());
        }
        if let Some(block_id) = &anchor.block_id {
            if let Ok(ReplyBlock::Artifact { bundle_id, .. }) = work(session, &object.id, block_id) {
                return Ok(self.artifact(bundle_id)?.io.inputs.into_iter().map(|(key, kind)| (key, Some(kind))).collect());
            }
        }
        Ok(BTreeMap::new())
    }

    /// The host validates declarations and version provenance, not an iframe's computation.
    pub(crate) fn validate_input_anchor(&self, session: &Session, anchor: &CanvasAnchor) -> Result<(), SpellcastError> {
        if session.board.canvas.object(&anchor.object_id).is_none()
            && anchor.inputs.is_none()
            && !anchor.annotations.is_empty()
        {
            return Ok(());
        }
        let ports = self.input_ports(session, anchor)?;
        let Some(snapshot) = &anchor.inputs else {
            return if ports.is_empty() { Ok(()) } else { Err(error("反馈需要携带当前连接输入；请重新选择对象。")) };
        };
        if snapshot.ports.len() > 32 || serde_json::to_vec(snapshot)?.len() > 64_000 || snapshot.ports.keys().ne(ports.keys()) {
            return Err(error("输入快照的接口或大小不符合当前作品声明。"));
        }
        let object = session.board.canvas.object(&anchor.object_id).unwrap();
        for (port, value) in &snapshot.ports {
            if value.sources.len() > 256 || value.reason.as_ref().is_some_and(|s| s.len() > 2000) { return Err(error("输入来源或说明过长。")); }
            if value.status == CanvasPortStatus::Unavailable {
                if !value.value.is_null() { return Err(error("不可用的输入不能携带有效值。")); }
                continue;
            }
            let valid = match ports[port] {
                Some(kind) => kind.accepts(&value.value),
                None => [ArtifactPortType::Number, ArtifactPortType::String, ArtifactPortType::Boolean, ArtifactPortType::Null].iter().any(|kind| kind.accepts(&value.value)),
            };
            if !valid { return Err(error("输入值不符合声明的数据类型。")); }
            let binding = object.bindings.iter().find(|b| b.to.block_id == anchor.block_id && &b.to.port == port)
                .ok_or_else(|| error("有效输入缺少对应的连接。"))?;
            self.validate_binding_ports(session, &object.content, binding)?;
            let mut expected = HashSet::new();
            self.input_sources(session, binding, &mut HashSet::new(), &mut expected)?;
            let actual: HashSet<_> = value.sources.iter().cloned().collect();
            if actual.len() != value.sources.len() || actual != expected { return Err(error("上游版本或参数已经变化；请等待联动更新后重新发送。")); }
        }
        Ok(())
    }

    fn input_sources(&self, session: &Session, binding: &CanvasBinding, visiting: &mut HashSet<(String, String)>, sources: &mut HashSet<CanvasDataSource>) -> Result<(), SpellcastError> {
        let from = &binding.from;
        let key = (from.object_id.clone(), from.block_id.clone());
        if !visiting.insert(key.clone()) || visiting.len() > 256 { return Err(error("连接包含循环或过多来源。")); }
        let object = session.board.canvas.object(&from.object_id).ok_or_else(|| error("上游已经不存在。"))?;
        if !session.board.canvas.items.iter().any(|item| item.item_id == object.id && !item.removed) { return Err(error("上游已移除，输入现在不可用。")); }
        let ReplyBlock::Artifact { bundle_id, state_revision, .. } = work(session, &from.object_id, &from.block_id)? else { unreachable!() };
        let bundle = self.artifact(bundle_id)?;
        if !bundle.io.outputs.contains_key(&from.port) { return Err(error("上游输出接口已经变化。")); }
        if !sources.insert(CanvasDataSource { object_id: object.id.clone(), content_revision: object.content_revision, block_id: from.block_id.clone(), bundle_id: bundle_id.clone(), state_revision: *state_revision }) {
            visiting.remove(&key); return Ok(());
        }
        for input in bundle.io.inputs.keys() {
            let upstream = object.bindings.iter().find(|b| b.to.block_id.as_ref() == Some(&from.block_id) && &b.to.port == input)
                .ok_or_else(|| error("上游仍有未连接的输入，当前值不可用。"))?;
            self.validate_binding_ports(session, &object.content, upstream)?;
            self.input_sources(session, upstream, visiting, sources)?;
        }
        visiting.remove(&key);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};
    use crate::artifacts::PublishArtifact;
    use spellcast_core::{CanvasBatchRequest, SayRequest};

    #[test]
    fn declared_connections_are_atomic_and_feedback_rejects_stale_inputs() {
        let root = std::env::temp_dir().join(format!("spellcast-data-test-{}", spellcast_core::new_id()));
        std::fs::create_dir_all(root.join("work")).unwrap();
        std::fs::write(root.join("work/index.html"), "<!doctype html><title>Tide</title>").unwrap();
        let database = root.join("state.sqlite3");
        {
            let bridge = Bridge::open(crate::Headless, 0, &database).unwrap();
            let publish = |id: &str, inputs: Value, outputs: Value| {
                let request: PublishArtifact = serde_json::from_value(json!({"source_id":"mechanism","reply_id":id,"block_id":"work","title":id,"directory":root.join("work"),"io":{"inputs":inputs,"outputs":outputs}})).unwrap();
                bridge.publish_artifact(request).unwrap();
                bridge.board().canvas.objects.into_iter().find(|o| matches!(&o.content, CanvasContent::Reply { id: reply } if reply == id)).unwrap()
            };
            let source = publish("parameter", json!({}), json!({"tide":"number"}));
            let chart = publish("chart", json!({"tide":"number"}), json!({}));
            let wrong = publish("wrong", json!({"tide":"string"}), json!({}));
            let binding = |block: Option<&str>| json!({"from":{"object_id":source.id,"block_id":"work","port":"tide"},"to":{"block_id":block,"port":if block.is_some(){"tide"}else{"text"}}});
            let batch = |id: &str, ops: Value| -> CanvasBatchRequest { serde_json::from_value(json!({"request_id":id,"reads":[{"kind":"content","id":source.id,"revision":source.content_revision}],"operations":ops})).unwrap() };
            let creation = json!({"op":"create","id":"value","content":{"type":"text","title":"潮位","text":"保留的说明"},"placement":{},"bindings":[binding(None)]});
            let failed = batch("bad-type", json!([creation, {"op":"bind","id":wrong.id,"expected_revision":wrong.content_revision,"bindings":[binding(Some("work"))]}]));
            let before = serde_json::to_value(bridge.board()).unwrap();
            let result = bridge.canvas_batch(failed, Some("mechanism")).unwrap();
            assert_eq!(result.result.status, "proposed");
            assert!(result.result.targets.iter().any(|t| t.id == wrong.id && t.status == "invalid"));
            assert!(bridge.board().canvas.object("value").is_none());
            assert_eq!(serde_json::to_value(&bridge.board().replies).unwrap(), before["replies"]);
            let good = batch("good", json!([creation, {"op":"bind","id":chart.id,"expected_revision":chart.content_revision,"bindings":[binding(Some("work"))]}]));
            assert_eq!(bridge.canvas_batch(good.clone(), Some("mechanism")).unwrap().result.status, "applied");
            assert_eq!(bridge.canvas_batch(good, Some("mechanism")).unwrap().result.status, "applied");
            let board = bridge.board();
            let ReplyBlock::Artifact { bundle_id, state_revision, .. } = &board.replies.iter().find(|r| r.id == "parameter").unwrap().blocks[0] else { unreachable!() };
            let source_evidence = json!({"object_id":source.id,"content_revision":source.content_revision,"block_id":"work","bundle_id":bundle_id,"state_revision":state_revision});
            let anchor: CanvasAnchor = serde_json::from_value(json!({"object_id":"value","content_revision":1,"inputs":{"revision":1,"ports":{"text":{"status":"available","value":7,"sources":[source_evidence]}}}})).unwrap();
            let event = bridge.say(SayRequest { text:"用这个潮位继续探索".into(), source_id:Some("mechanism".into()), anchors:vec![anchor.clone()], ..Default::default() }).unwrap();
            assert_eq!(event.anchors[0].inputs.as_ref().unwrap().ports["text"].value, json!(7));
            let inline = serde_json::from_value(json!({"object_id":chart.id,"reply_id":"chart","block_id":"work","action":"ask","text":"这个港口还可以怎样探索？","artifact_context":{"bundle_id":board.replies.iter().find(|r| r.id == "chart").unwrap().blocks.iter().find_map(|b| if let ReplyBlock::Artifact { bundle_id,.. } = b { Some(bundle_id) } else {None}).unwrap(),"state":{},"state_revision":0,"inputs":{"revision":1,"ports":{"tide":{"status":"available","value":7,"sources":[source_evidence]}}}}})).unwrap();
            let (_, inline_event) = bridge.reply_action(inline).unwrap();
            assert_eq!(inline_event.anchors.len(), 1);
            assert_eq!(inline_event.anchors[0].content_revision, chart.content_revision + 1);
            assert_eq!(inline_event.anchors[0].inputs.as_ref().unwrap().ports["tide"].value, json!(7));
            let update = serde_json::from_value(json!({"object_id":source.id,"reply_id":"parameter","block_id":"work","bundle_id":bundle_id,"expected_state_revision":state_revision,"state":{"tide":8}})).unwrap();
            bridge.save_artifact_state(update).unwrap();
            assert!(bridge.say(SayRequest { text:"旧值不能伪装为当前".into(), source_id:Some("mechanism".into()), anchors:vec![anchor.clone()], ..Default::default() }).is_err());
            let mut unavailable = anchor.clone();
            let value = unavailable.inputs.as_mut().unwrap().ports.get_mut("text").unwrap();
            value.status = CanvasPortStatus::Unavailable; value.value = Value::Null; value.sources.clear();
            assert!(bridge.say(SayRequest { text:"当前输入不可用".into(), source_id:Some("mechanism".into()), anchors:vec![unavailable], ..Default::default() }).is_ok());
            let mut invalid = anchor;
            invalid.inputs.as_mut().unwrap().ports.get_mut("text").unwrap().value = json!({"code":"ignored"});
            assert!(bridge.say(SayRequest { text:"拒绝复合值".into(), source_id:Some("mechanism".into()), anchors:vec![invalid], ..Default::default() }).is_err());
        }
        {
            let bridge = Bridge::open(crate::Headless, 0, &database).unwrap();
            let board = bridge.board();
            assert_eq!(board.canvas.object("value").unwrap().bindings.len(), 1);
            let ReplyBlock::Artifact { state, .. } = &board.replies.iter().find(|r| r.id == "parameter").unwrap().blocks[0] else { unreachable!() };
            assert_eq!(state, &json!({"tide":8}));
            assert!(!serde_json::to_value(board).unwrap().to_string().contains("\"ports\""), "input snapshots are not a second board state authority");
        }
        let resolved = root.canonicalize().unwrap();
        assert!(resolved.starts_with(std::env::temp_dir().canonicalize().unwrap()) && root.file_name().unwrap().to_string_lossy().starts_with("spellcast-data-test-"));
        std::fs::remove_dir_all(resolved).unwrap();
    }
}

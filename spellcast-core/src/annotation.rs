//! Durable Canvas annotations and exact anchor snapshot capture.

use crate::inbox::{CanvasAnchor, CanvasSubtarget};
use crate::{
    artifact_states_equal, CanvasContent, CanvasOrigin, ReplyArtifactReference, ReplyBlock,
    Session, SpellcastError,
};

fn error(message: impl Into<String>) -> SpellcastError {
    SpellcastError::user(message.into())
}

/// Validate a current anchor and capture only the exact object, block, or stable subitem it names.
/// Annotation IDs are allowed only on feedback anchors; saved annotation anchors must stay flat.
pub fn capture_anchor_snapshot(
    session: &Session,
    anchor: &CanvasAnchor,
    allow_annotation_refs: bool,
) -> Result<(serde_json::Value, Option<CanvasOrigin>), SpellcastError> {
    if !allow_annotation_refs && !anchor.annotations.is_empty() {
        return Err(error("注释不能再引用其他注释；请直接锚定原对象。"));
    }
    if anchor.annotations.len() > 64 {
        return Err(error("一个位置最多引用 64 条注释。"));
    }
    let mut annotation_ids = std::collections::HashSet::new();
    let mut referenced_annotations = Vec::new();
    for reference in &anchor.annotations {
        crate::reply::validate_id(&reference.id)?;
        if !annotation_ids.insert(reference.id.as_str()) {
            return Err(error("同一位置不能重复引用一条注释。"));
        }
        let annotation = session
            .board
            .canvas
            .annotation(&reference.id)
            .ok_or_else(|| error("引用的注释已经不存在。"))?;
        if annotation.removed
            || annotation.revision != reference.revision
            || annotation.anchor.object_id != anchor.object_id
        {
            return Err(error("注释已更新、移除或不属于这个对象；请重新选择。"));
        }
        referenced_annotations.push(annotation);
    }
    for reference in &anchor.compositions {
        let composition = session
            .board
            .canvas
            .composition(&reference.id)
            .ok_or_else(|| error("想法组合已不存在。"))?;
        if composition.revision != reference.revision
            || !session
                .board
                .canvas
                .composition_reaches(&reference.id, &anchor.object_id)
        {
            return Err(error("想法的说明或成员已经改变，请重新查看后再发送。"));
        }
    }
    let Some(object) = session.board.canvas.object(&anchor.object_id) else {
        let annotation_only = allow_annotation_refs
            && !referenced_annotations.is_empty()
            && anchor.target.is_none()
            && anchor.image.is_none()
            && anchor.artifact_reference.is_none()
            && anchor.compositions.is_empty()
            && anchor.block_id.is_none()
            && anchor.selection.is_none()
            && anchor.region.is_none()
            && anchor.artifact.is_none()
            && anchor.inputs.is_none();
        if annotation_only {
            let snapshot = serde_json::Value::Array(
                referenced_annotations
                    .iter()
                    .map(|annotation| annotation.snapshot.clone())
                    .collect(),
            );
            return Ok((
                snapshot,
                referenced_annotations
                    .first()
                    .and_then(|annotation| annotation.origin.clone()),
            ));
        }
        return Err(error("引用的对象已不存在。"));
    };
    if object.content_revision != anchor.content_revision {
        return Err(error("引用内容已经更新；请查看最新内容后重新选择。"));
    }

    let mut searchable_text = None;
    let mut block = None;
    let whole = match &object.content {
        CanvasContent::Node { id } => {
            let node = session
                .board
                .nodes
                .iter()
                .find(|node| &node.id == id)
                .ok_or_else(|| error("想法已经不存在。"))?;
            if anchor.block_id.as_deref().is_some_and(|id| id != "text") {
                return Err(error("想法没有这个子项。"));
            }
            searchable_text = Some(format!("{}\n{}", node.title, node.body));
            serde_json::json!({"type":"text","title":node.title,"text":node.body})
        }
        CanvasContent::Reply { id } => {
            let reply = session
                .board
                .replies
                .iter()
                .find(|reply| &reply.id == id)
                .ok_or_else(|| error("回复已经不存在。"))?;
            if let Some(block_id) = &anchor.block_id {
                let selected = reply
                    .blocks
                    .iter()
                    .find(|item| item.id() == block_id)
                    .ok_or_else(|| error("引用的子项已经不存在。"))?;
                block = Some(selected);
                if let ReplyBlock::Text { title, text, .. } = selected {
                    searchable_text = Some(format!("{title}\n{text}"));
                }
                serde_json::to_value(selected)?
            } else {
                serde_json::to_value(reply)?
            }
        }
        CanvasContent::Block { block: selected } => {
            if anchor
                .block_id
                .as_deref()
                .is_some_and(|id| id != selected.id())
            {
                return Err(error("引用的组件子项已经不存在。"));
            }
            block = Some(selected);
            if let ReplyBlock::Text { title, text, .. } = selected {
                searchable_text = Some(format!("{title}\n{text}"));
            }
            serde_json::to_value(selected)?
        }
        CanvasContent::Text { title, text } | CanvasContent::Shape { title, text, .. } => {
            if anchor.block_id.is_some() {
                return Err(error("这个对象没有独立子项。"));
            }
            searchable_text = Some(format!("{title}\n{text}"));
            serde_json::to_value(&object.content)?
        }
        CanvasContent::Image { .. } => {
            if anchor.block_id.is_some() {
                return Err(error("图片没有独立子项。"));
            }
            serde_json::to_value(&object.content)?
        }
    };

    let mut target_snapshot = None;
    let (target_image, target_artifact): (
        Option<&crate::ReplyImageReference>,
        Option<&ReplyArtifactReference>,
    ) = if let Some(target) = &anchor.target {
        match (block, target) {
            (Some(ReplyBlock::Comparison { options, .. }), CanvasSubtarget::Option { id }) => {
                let item = options
                    .iter()
                    .find(|item| &item.id == id)
                    .ok_or_else(|| error("所选方案已不存在，请重新选择。"))?;
                target_snapshot = Some(serde_json::to_value(item)?);
                (item.image.as_ref(), item.artifact.as_ref())
            }
            (Some(ReplyBlock::Sequence { steps, .. }), CanvasSubtarget::Step { id }) => {
                let item = steps
                    .iter()
                    .find(|item| &item.id == id)
                    .ok_or_else(|| error("所选步骤已不存在，请重新选择。"))?;
                target_snapshot = Some(serde_json::to_value(item)?);
                (item.image.as_ref(), item.artifact.as_ref())
            }
            (Some(ReplyBlock::Graph { nodes, .. }), CanvasSubtarget::GraphNode { id }) => {
                let item = nodes
                    .iter()
                    .find(|item| &item.id == id)
                    .ok_or_else(|| error("所选关系节点已不存在，请重新选择。"))?;
                target_snapshot = Some(serde_json::to_value(item)?);
                (None, None)
            }
            (Some(ReplyBlock::Graph { edges, .. }), CanvasSubtarget::GraphEdge { id }) => {
                let item = edges
                    .iter()
                    .find(|item| &item.id == id)
                    .ok_or_else(|| error("所选关系已不存在，请重新选择。"))?;
                target_snapshot = Some(serde_json::to_value(item)?);
                (None, None)
            }
            _ => return Err(error("所选方案、步骤或关系与引用子项不一致。")),
        }
    } else {
        (None, None)
    };
    if anchor.image.as_ref() != target_image {
        return Err(error("所选画面的固定引用不一致，请重新选择后发送。"));
    }
    if anchor.artifact_reference.as_ref() != target_artifact {
        return Err(error("所选作品的固定状态引用不一致，请重新选择后发送。"));
    }
    if let Some(selection) = &anchor.selection {
        if selection.is_empty()
            || selection.len() > 16_000
            || !searchable_text
                .as_ref()
                .is_some_and(|text| text.contains(selection))
        {
            return Err(error("文字选区与引用的内容不一致。"));
        }
    }
    if let Some(region) = &anchor.region {
        let valid_resource = matches!(&object.content, CanvasContent::Image { src, .. } if src == &region.resource)
            || target_image.is_some_and(|image| image.src == region.resource)
            || target_artifact
                .and_then(|artifact| artifact.preview.as_ref())
                .is_some_and(|preview| preview.src == region.resource);
        let valid_bounds = [region.x, region.y, region.width, region.height]
            .iter()
            .all(|value| value.is_finite())
            && region.x >= 0.0
            && region.y >= 0.0
            && region.width > 0.0
            && region.height > 0.0
            && region.x + region.width <= 1.0000001
            && region.y + region.height <= 1.0000001;
        if !valid_resource || region.unit != "normalized" || !valid_bounds {
            return Err(error("图片选区的资源或坐标不一致。"));
        }
    }
    if let Some(artifact) = &anchor.artifact {
        let valid = matches!(block, Some(ReplyBlock::Artifact { bundle_id, state, state_revision, .. })
            if bundle_id == &artifact.bundle_id
                && state_revision == &artifact.state_revision
                && artifact_states_equal(state, &artifact.state));
        if !valid || serde_json::to_vec(artifact)?.len() > 64 * 1024 {
            return Err(error("作品版本或参数已经变化；请重新选择。"));
        }
    }
    Ok((target_snapshot.unwrap_or(whole), object.origin.clone()))
}

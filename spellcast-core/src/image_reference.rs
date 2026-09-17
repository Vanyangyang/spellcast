//! Contextual validation for fixed image snapshots embedded in reply subitems.

use std::collections::HashSet;

use crate::{
    validate_id, validate_image_src, CanvasContent, CanvasLayout, CanvasObject,
    ReplyImageReference, Session, SpellcastError,
};

struct ReferenceLocation<'a> {
    owner: &'a CanvasObject,
    block_id: &'a str,
    subitem_id: &'a str,
    reference: &'a ReplyImageReference,
}

/// Reference snapshots may only point at content which Spellcast can preserve locally.
/// Ordinary image objects can still use http(s), but a reply snapshot must not depend on a
/// remote URL changing underneath it.
pub fn validate_immutable_image_reference_src(src: &str) -> Result<(), SpellcastError> {
    validate_image_src(src)?;
    if src.starts_with("data:") || src.starts_with("/artifacts/") {
        Ok(())
    } else {
        Err(SpellcastError::user(
            "图片引用只能固定 PNG/JPEG/WebP data URL 或 /artifacts/{bundleId}/… 本地资源；不能引用 http(s) 地址。",
        ))
    }
}

/// Validates only references introduced or changed between two session snapshots.
///
/// This deliberately does not revisit snapshots with the same owner object, block ID, subitem
/// ID, and reference value. A source image can therefore be changed, deleted, or removed from a
/// composition without silently changing or invalidating an already-saved reply reference.
pub fn validate_image_references(before: &Session, after: &Session) -> Result<(), SpellcastError> {
    let previous = references_in(before);
    for current in references_in(after) {
        let unchanged = reference_is_unchanged(before, &previous, &current);
        if !unchanged {
            validate_new_or_changed_reference(after, &current)?;
        }
    }
    Ok(())
}

fn reference_is_unchanged(
    before: &Session,
    previous: &[ReferenceLocation<'_>],
    current: &ReferenceLocation<'_>,
) -> bool {
    if previous.iter().any(|old| {
        old.owner.id == current.owner.id
            && old.block_id == current.block_id
            && old.subitem_id == current.subitem_id
            && old.reference == current.reference
    }) {
        return true;
    }
    // Direct-reply callers may validate after they first synchronize the proposed clone. If the
    // saved snapshot predated that synchronization, use the reply's stable ID to recognize its
    // unchanged subitem rather than mistaking it for a fresh reference.
    let CanvasContent::Reply { id } = &current.owner.content else {
        return false;
    };
    before
        .board
        .replies
        .iter()
        .find(|reply| reply.id == *id)
        .and_then(|reply| {
            reply
                .blocks
                .iter()
                .find(|block| block.id() == current.block_id)
        })
        .and_then(|block| {
            block
                .image_references()
                .find(|(subitem_id, _)| *subitem_id == current.subitem_id)
                .map(|(_, reference)| reference)
        })
        == Some(current.reference)
}

fn references_in(session: &Session) -> Vec<ReferenceLocation<'_>> {
    let mut references = Vec::new();
    for owner in &session.board.canvas.objects {
        match &owner.content {
            CanvasContent::Block { block } => {
                push_block_references(&mut references, owner, block);
            }
            CanvasContent::Reply { id } => {
                if let Some(reply) = session.board.replies.iter().find(|reply| reply.id == *id) {
                    for block in &reply.blocks {
                        push_block_references(&mut references, owner, block);
                    }
                }
            }
            CanvasContent::Node { .. }
            | CanvasContent::Text { .. }
            | CanvasContent::Image { .. }
            | CanvasContent::Shape { .. } => {}
        }
    }
    references
}

fn push_block_references<'a>(
    references: &mut Vec<ReferenceLocation<'a>>,
    owner: &'a CanvasObject,
    block: &'a crate::ReplyBlock,
) {
    for (subitem_id, reference) in block.image_references() {
        references.push(ReferenceLocation {
            owner,
            block_id: block.id(),
            subitem_id,
            reference,
        });
    }
}

fn validate_new_or_changed_reference(
    session: &Session,
    location: &ReferenceLocation<'_>,
) -> Result<(), SpellcastError> {
    let reference = location.reference;
    validate_id(&reference.object_id)?;
    validate_immutable_image_reference_src(&reference.src)?;
    let target = session
        .board
        .canvas
        .object(&reference.object_id)
        .ok_or_else(|| SpellcastError::user("图片引用的对象已经不在画布上。"))?;
    let CanvasContent::Image { title, src, alt } = &target.content else {
        return Err(SpellcastError::user("图片引用只能指向 image 画布对象。"));
    };
    if target.content_revision != reference.content_revision
        || title != &reference.title
        || alt != &reference.alt
        || src != &reference.src
    {
        return Err(SpellcastError::user(
            "图片引用必须精确匹配当前图片对象的版本、标题、说明和资源地址。",
        ));
    }
    if location.owner.source_id.is_some()
        && target.source_id.is_some()
        && location.owner.source_id != target.source_id
    {
        return Err(SpellcastError::user(
            "回复内容和图片对象属于不同来源，不能建立图片引用。",
        ));
    }
    if let (Some(owner_origin), Some(target_origin)) = (&location.owner.origin, &target.origin) {
        let normalize = |cwd: &str| {
            let path = cwd.trim().replace('\\', "/").trim_end_matches('/').to_string();
            if path.as_bytes().get(1) == Some(&b':') || path.starts_with("//") { path.to_lowercase() } else { path }
        };
        if !owner_origin.cwd.is_empty() && !target_origin.cwd.is_empty() && normalize(&owner_origin.cwd) != normalize(&target_origin.cwd) {
            return Err(SpellcastError::user("图片引用不能跨越不同工作区。"));
        }
    }
    if !share_composition(&session.board.canvas, &location.owner.id, &target.id) {
        return Err(SpellcastError::user(
            "回复内容和图片对象需要在同一个组合里，才能建立图片引用。",
        ));
    }
    Ok(())
}

fn share_composition(canvas: &CanvasLayout, left: &str, right: &str) -> bool {
    let left = composition_ancestors(canvas, left);
    let right = composition_ancestors(canvas, right);
    left.iter().any(|id| right.contains(id))
}

fn composition_ancestors(canvas: &CanvasLayout, object_id: &str) -> HashSet<String> {
    let mut result = HashSet::new();
    let mut member = object_id.to_string();
    while let Some(parent) = canvas.parent_of(&member) {
        if !result.insert(parent.id.clone()) {
            break;
        }
        member = parent.id.clone();
    }
    result
}

#[cfg(test)]
mod tests {
    use super::{validate_image_references, validate_immutable_image_reference_src};
    use crate::{ReplyBlock, ReplyRequest, Session};

    #[test]
    fn fixed_reference_sources_are_local_or_embedded() {
        assert!(
            validate_immutable_image_reference_src("/artifacts/bundle-one/images/first.png")
                .is_ok()
        );
        assert!(validate_immutable_image_reference_src("data:image/webp;base64,AAAA").is_ok());
        assert!(validate_immutable_image_reference_src("https://example.test/image.png").is_err());
    }

    #[test]
    fn unsynchronized_previous_reply_still_recognizes_an_unchanged_snapshot() {
        let block: ReplyBlock = serde_json::from_value(serde_json::json!({
            "type": "comparison",
            "id": "choices",
            "criteria": ["criterion"],
            "options": [
                {
                    "id": "first",
                    "title": "First",
                    "values": ["value"],
                    "image": {
                        "object_id": "deleted-image",
                        "content_revision": 1,
                        "src": "/artifacts/bundle-one/first.png"
                    }
                },
                {"id": "second", "title": "Second", "values": ["value"]}
            ]
        }))
        .unwrap();
        let mut before = Session::default();
        before
            .write_reply(ReplyRequest {
                id: Some("reply-one".into()),
                source_id: "codex:one".into(),
                source_label: None,
                origin_node_id: None,
                title: "Reply".into(),
                blocks: vec![block],
                expected_revision: None,
            })
            .unwrap();
        let mut after = before.clone();
        after.sync_canvas();
        assert!(validate_image_references(&before, &after).is_ok());
    }
}

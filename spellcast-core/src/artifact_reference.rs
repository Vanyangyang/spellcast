//! Contextual validation for fixed artifact-state snapshots embedded in reply subitems.

use std::collections::HashSet;

use crate::{
    artifact_states_equal, CanvasContent, CanvasLayout, CanvasObject, ReplyArtifactReference,
    ReplyBlock, Session, SpellcastError,
};

struct ReferenceLocation<'a> {
    owner: &'a CanvasObject,
    block_id: &'a str,
    subitem_id: &'a str,
    reference: &'a ReplyArtifactReference,
}

/// Validate only references introduced or changed between two snapshots. Unchanged snapshots
/// remain valid after their source work changes, is deleted, or leaves the idea composition.
pub fn validate_artifact_references(
    before: &Session,
    after: &Session,
) -> Result<(), SpellcastError> {
    let previous = references_in(before);
    for current in references_in(after) {
        if !reference_is_unchanged(before, &previous, &current) {
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
                .artifact_references()
                .find(|(subitem_id, _)| *subitem_id == current.subitem_id)
                .map(|(_, reference)| reference)
        })
        == Some(current.reference)
}

fn references_in(session: &Session) -> Vec<ReferenceLocation<'_>> {
    let mut references = Vec::new();
    for owner in &session.board.canvas.objects {
        match &owner.content {
            CanvasContent::Block { block } => push_block_references(&mut references, owner, block),
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
    block: &'a ReplyBlock,
) {
    for (subitem_id, reference) in block.artifact_references() {
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
    let target = session
        .board
        .canvas
        .object(&reference.object_id)
        .ok_or_else(|| SpellcastError::user("作品引用的对象已经不在画布上。"))?;
    let CanvasContent::Reply { id } = &target.content else {
        return Err(SpellcastError::user(
            "作品引用只能指向回复中的 artifact 块。",
        ));
    };
    let block = session
        .board
        .replies
        .iter()
        .find(|reply| reply.id == *id)
        .and_then(|reply| {
            reply
                .blocks
                .iter()
                .find(|block| block.id() == reference.block_id)
        })
        .ok_or_else(|| SpellcastError::user("作品引用的子项已经不存在。"))?;
    let ReplyBlock::Artifact {
        title,
        bundle_id,
        state,
        state_revision,
        state_preview,
        ..
    } = block
    else {
        return Err(SpellcastError::user("作品引用只能指向 artifact 块。"));
    };
    if target.content_revision != reference.content_revision
        || bundle_id != &reference.bundle_id
        || state_revision != &reference.state_revision
        || title != &reference.title
        || !artifact_states_equal(state, &reference.state)
        || state_preview != &reference.preview
    {
        return Err(SpellcastError::user(
            "作品引用必须精确匹配当前作品的内容、bundle、状态版本、标题、状态和预览。",
        ));
    }
    if location.owner.source_id.is_some()
        && target.source_id.is_some()
        && location.owner.source_id != target.source_id
    {
        return Err(SpellcastError::user(
            "回复内容和作品对象属于不同来源，不能建立作品引用。",
        ));
    }
    if let (Some(owner_origin), Some(target_origin)) = (&location.owner.origin, &target.origin) {
        if !owner_origin.cwd.is_empty()
            && !target_origin.cwd.is_empty()
            && normalize_workspace(&owner_origin.cwd) != normalize_workspace(&target_origin.cwd)
        {
            return Err(SpellcastError::user("作品引用不能跨越不同工作区。"));
        }
    }
    if !share_composition(&session.board.canvas, &location.owner.id, &target.id) {
        return Err(SpellcastError::user(
            "回复内容和作品对象需要在同一个想法组合里，才能建立作品引用。",
        ));
    }
    Ok(())
}

fn normalize_workspace(cwd: &str) -> String {
    let path = cwd
        .trim()
        .replace('\\', "/")
        .trim_end_matches('/')
        .to_string();
    if path.as_bytes().get(1) == Some(&b':') || path.starts_with("//") {
        path.to_lowercase()
    } else {
        path
    }
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

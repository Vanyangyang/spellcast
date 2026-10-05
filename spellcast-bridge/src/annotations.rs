//! Source-scoped annotation handling. The index is derived from the persisted Canvas and
//! discarded after every successful state update, including imports and binding changes.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::ops::Bound;
#[cfg(test)]
use std::sync::atomic::{AtomicU64, Ordering};

use rmcp::schemars;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use spellcast_core::{CanvasAnnotation, CanvasAnnotationStatus, CanvasContent, CanvasOrigin, SpellcastError};

use crate::{Bridge, PersistedState};

#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct AnnotationRequest {
    pub source_id: String,
    #[serde(default)]
    pub action: AnnotationAction,
    #[serde(default)]
    pub limit: Option<usize>,
    #[serde(default)]
    pub after: Option<String>,
    #[serde(default)]
    pub annotations: Vec<AnnotationRevision>,
}

#[derive(Debug, Clone, Copy, Default, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum AnnotationAction {
    #[default]
    Pending,
    Complete,
}

#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct AnnotationRevision {
    pub id: String,
    pub revision: u64,
}

#[derive(Debug, Serialize)]
pub struct PendingAnnotations {
    pub annotations: Vec<CanvasAnnotation>,
    pub next_cursor: Option<String>,
    pub has_more: bool,
    pub handling: &'static str,
}

#[derive(Debug, Serialize)]
pub struct CompletedAnnotations {
    pub completed: usize,
    pub already_handled: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
enum Scope {
    Thread { thread_id: String, cwd: String },
    Source(String),
}

#[derive(Default)]
pub(crate) struct AnnotationIndex {
    by_id: HashMap<String, usize>,
    scopes_by_id: HashMap<String, Vec<Scope>>,
    pending: BTreeMap<Scope, BTreeSet<String>>,
    source_scopes: HashMap<String, Scope>,
    #[cfg(test)]
    generation: u64,
}

#[cfg(test)]
static INDEX_GENERATION: AtomicU64 = AtomicU64::new(1);

impl AnnotationIndex {
    fn build(state: &PersistedState) -> Self {
        let bindings: HashMap<&str, &crate::codex::CodexBinding> = state.bindings.iter()
            .map(|binding| (binding.source_id.as_str(), binding)).collect();
        let nodes: HashMap<&str, &spellcast_core::BoardNode> = state.session.board.nodes.iter()
            .map(|node| (node.id.as_str(), node)).collect();
        let objects: HashMap<&str, &spellcast_core::CanvasObject> = state.session.board.canvas.objects.iter()
            .map(|object| (object.id.as_str(), object)).collect();
        let mut index = Self::default();
        #[cfg(test)]
        { index.generation = INDEX_GENERATION.fetch_add(1, Ordering::Relaxed); }
        for binding in &state.bindings {
            if !binding.cwd.is_empty() {
                index.source_scopes.insert(binding.source_id.clone(), Scope::Thread {
                    thread_id: binding.thread_id.clone(), cwd: normalize_cwd(&binding.cwd),
                });
            }
        }
        for (position, annotation) in state.session.board.canvas.annotations.iter().enumerate() {
            index.by_id.insert(annotation.id.clone(), position);
            let object = objects.get(annotation.anchor.object_id.as_str()).copied();
            let origin = annotation.origin.as_ref().or_else(|| object.and_then(|object| object.origin.as_ref()));
            let source = origin.and_then(|origin| origin.source_id.as_deref())
                .or_else(|| object.and_then(|object| {
                    if let CanvasContent::Node { id } = &object.content {
                        nodes.get(id.as_str()).and_then(|node| node.captured_context.as_ref())
                            .map(|context| context.source_id.as_str())
                    } else { None }
                }))
                .or(annotation.target_source_id.as_deref())
                .or_else(|| if origin.is_some_and(|origin| origin.thread_id.is_some() && !origin.cwd.is_empty()) {
                    None
                } else {
                    object.and_then(|object| object.source_id.as_deref())
                });
            let thread = origin.and_then(|origin| thread_scope(origin))
                .or_else(|| object.and_then(|object| {
                    if let CanvasContent::Node { id } = &object.content {
                        nodes.get(id.as_str()).and_then(|node| node.captured_context.as_ref())
                            .and_then(|context| match (&context.thread_id, &context.cwd) {
                                (Some(thread_id), Some(cwd)) if !cwd.is_empty() => Some(Scope::Thread { thread_id: thread_id.clone(), cwd: normalize_cwd(cwd) }),
                                _ => None,
                            })
                    } else { None }
                }))
                .or_else(|| source.and_then(|source| bindings.get(source))
                    .filter(|binding| !binding.cwd.is_empty())
                    .map(|binding| Scope::Thread { thread_id: binding.thread_id.clone(), cwd: normalize_cwd(&binding.cwd) }));
            let scopes = [thread, source.map(|source| Scope::Source(source.into()))];
            for scope in scopes.into_iter().flatten() {
                if !annotation.removed && annotation.status == CanvasAnnotationStatus::Pending {
                    index.pending.entry(scope.clone()).or_default().insert(annotation.id.clone());
                }
                index.scopes_by_id.entry(annotation.id.clone()).or_default().push(scope);
            }
        }
        index
    }

    fn scope_for_source(&self, source_id: &str) -> Scope {
        self.source_scopes.get(source_id).cloned()
            .unwrap_or_else(|| Scope::Source(source_id.into()))
    }

    fn includes(&self, scope: &Scope, id: &str) -> bool {
        self.pending.get(scope).is_some_and(|ids| ids.contains(id))
    }

    fn belongs_to(&self, scope: &Scope, id: &str) -> bool {
        self.scopes_by_id.get(id).is_some_and(|scopes| scopes.contains(scope))
    }

    pub(crate) fn remove_completed(&mut self, ids: &[String]) {
        for id in ids {
            if let Some(scopes) = self.scopes_by_id.get(id) {
                for scope in scopes {
                    if let Some(pending) = self.pending.get_mut(scope) { pending.remove(id); }
                }
            }
        }
    }
}

fn thread_scope(origin: &CanvasOrigin) -> Option<Scope> {
    match (&origin.thread_id, origin.cwd.as_str()) {
        (Some(thread_id), cwd) if !cwd.is_empty() => Some(Scope::Thread { thread_id: thread_id.clone(), cwd: normalize_cwd(cwd) }),
        _ => None,
    }
}

fn normalize_cwd(cwd: &str) -> String {
    let displayed = crate::game_config::display_path(std::path::Path::new(cwd));
    let trimmed = displayed.trim_end_matches('/');
    if trimmed.len() >= 2 && trimmed.as_bytes()[1] == b':' && trimmed.len() == 2 {
        format!("{}/", trimmed.to_lowercase())
    } else {
        trimmed.to_lowercase()
    }
}

impl Bridge {
    pub fn pending_annotations(&self, source_id: &str, limit: Option<usize>, after: Option<&str>) -> Result<PendingAnnotations, SpellcastError> {
        spellcast_core::reply::validate_id(source_id)?;
        let limit = limit.unwrap_or(32);
        if !(1..=64).contains(&limit) { return Err(SpellcastError::user("limit 必须在 1 到 64 之间。")); }
        if let Some(after) = after { spellcast_core::reply::validate_id(after)?; }
        let state = self.state.lock().unwrap();
        let mut cache = self.annotation_index.lock().unwrap();
        let index = cache.get_or_insert_with(|| AnnotationIndex::build(&state));
        let scope = index.scope_for_source(source_id);
        let mut ids = index.pending.get(&scope).into_iter().flat_map(|set| {
            let start = after.map(|id| Bound::Excluded(id.to_string())).unwrap_or(Bound::Unbounded);
            set.range((start, Bound::Unbounded))
        });
        let selected: Vec<&String> = ids.by_ref().take(limit + 1).collect();
        let has_more = selected.len() > limit;
        let annotations = selected.iter().take(limit).filter_map(|id| index.by_id.get(id.as_str())
            .map(|position| state.session.board.canvas.annotations[*position].clone())).collect();
        let next_cursor = if has_more { selected.get(limit - 1).map(|id| (*id).clone()) } else { None };
        Ok(PendingAnnotations { annotations, next_cursor, has_more,
            handling: "An explicit request to process annotations covers all pending pages for this chat, including unselected content; pass next_cursor as after until has_more is false. UI questions or instructions not to process do not trigger handling. Complete only successfully handled exact id/revision pairs; leave blocked or unapplied notes pending." })
    }

    pub fn complete_annotations(&self, source_id: &str, entries: &[AnnotationRevision]) -> Result<CompletedAnnotations, SpellcastError> {
        spellcast_core::reply::validate_id(source_id)?;
        if entries.is_empty() || entries.len() > 64 { return Err(SpellcastError::user("一次必须提交 1 到 64 条注释。")); }
        let mut seen = BTreeSet::new();
        for entry in entries {
            spellcast_core::reply::validate_id(&entry.id)?;
            if !seen.insert(&entry.id) { return Err(SpellcastError::user("注释 ID 不能重复。")); }
        }
        let completed_ids: Vec<String> = entries.iter().map(|entry| entry.id.clone()).collect();
        let result = self.update_with_annotation_cache(|state| {
            let mut cache = self.annotation_index.lock().unwrap();
            let index = cache.get_or_insert_with(|| AnnotationIndex::build(state));
            let scope = index.scope_for_source(source_id);
            let mut positions = Vec::with_capacity(entries.len());
            let mut already_handled = 0;
            for entry in entries {
                let position = *index.by_id.get(&entry.id).ok_or_else(|| SpellcastError::user("注释不存在或不属于当前聊天。"))?;
                let annotation = &state.session.board.canvas.annotations[position];
                if annotation.removed || annotation.revision != entry.revision {
                    return Err(SpellcastError::user("注释已更新或删除；请重新读取后再处理。"));
                }
                if annotation.status == CanvasAnnotationStatus::Handled {
                    if !index.belongs_to(&scope, &entry.id) {
                        return Err(SpellcastError::user("注释不属于当前聊天。"));
                    }
                    already_handled += 1;
                } else if index.includes(&scope, &entry.id) {
                    positions.push(position);
                } else {
                    return Err(SpellcastError::user("注释不属于当前聊天。"));
                }
            }
            drop(cache);
            for position in &positions {
                state.session.board.canvas.annotations[*position].status = CanvasAnnotationStatus::Handled;
            }
            if !positions.is_empty() { state.session.board.canvas.revision += 1; }
            Ok(CompletedAnnotations { completed: positions.len(), already_handled })
        }, Some(&completed_ids))?;
        if result.completed > 0 { self.surface.board_changed(); }
        Ok(result)
    }

    #[cfg(test)]
    pub(crate) fn annotation_index_generation(&self) -> Option<u64> {
        let _state = self.state.lock().unwrap();
        self.annotation_index.lock().unwrap().as_ref().map(|index| index.generation)
    }

}

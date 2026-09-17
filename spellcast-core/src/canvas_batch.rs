//! Atomic canvas batches: declared read dependencies, per-target status, and proposals kept
//! in the session snapshot. Feedback semantics live in the bridge; `feedback_sequences` is
//! only part of the request fingerprint here.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashSet};

use crate::inbox::now_ms;
use crate::reply::validate_id;
use crate::{
    capture_anchor_snapshot, validate_artifact_references, validate_image_references,
    CanvasAnnotation, CanvasAppearance, CanvasArrangement, CanvasBinding, CanvasComposition,
    CanvasContent, CanvasLayout, CanvasObject, CanvasPlacement, NodePatch, ReplyBlock,
    ReplyPatchRequest, Session, SpellcastError,
};

pub const MAX_BATCH_OPERATIONS: usize = 64;
pub const MAX_BATCH_READS: usize = 128;
pub const MAX_COMPOSITION_MEMBERS: usize = 64;
pub const MAX_BINDINGS_PER_OBJECT: usize = 32;
pub const MAX_CANVAS_BINDINGS: usize = 256;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum CanvasTargetKind {
    Content,
    Presentation,
    Composition,
    Annotation,
}

/// A version the caller relied on without writing it.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, JsonSchema)]
pub struct CanvasRead {
    pub kind: CanvasTargetKind,
    pub id: String,
    pub revision: u64,
}

/// Only the given fields change. Fields the content type does not have are rejected.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq, JsonSchema)]
pub struct CanvasContentFields {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub src: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub alt: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fill: Option<String>,
}

impl CanvasContentFields {
    fn given(&self) -> Vec<&'static str> {
        let mut names = Vec::new();
        if self.title.is_some() {
            names.push("title");
        }
        if self.text.is_some() {
            names.push("text");
        }
        if self.src.is_some() {
            names.push("src");
        }
        if self.alt.is_some() {
            names.push("alt");
        }
        if self.fill.is_some() {
            names.push("fill");
        }
        names
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, JsonSchema)]
pub struct CanvasPlacementFields {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub x: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub y: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub width: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub height: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content_scale: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub z: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub appearance: Option<CanvasAppearance>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub removed: Option<bool>,
}

impl CanvasPlacementFields {
    fn is_empty(&self) -> bool {
        self.x.is_none()
            && self.y.is_none()
            && self.width.is_none()
            && self.height.is_none()
            && self.content_scale.is_none()
            && self.z.is_none()
            && self.appearance.is_none()
            && self.removed.is_none()
    }

    fn apply_to(&self, item: &mut CanvasPlacement) {
        if let Some(x) = self.x {
            item.x = x;
        }
        if let Some(y) = self.y {
            item.y = y;
        }
        if let Some(width) = self.width {
            item.width = width;
        }
        if let Some(height) = self.height {
            item.height = height;
        }
        if let Some(content_scale) = self.content_scale {
            item.content_scale = content_scale;
        }
        if let Some(z) = self.z {
            item.z = z;
        }
        if let Some(appearance) = self.appearance {
            item.appearance = appearance;
        }
        if let Some(removed) = self.removed {
            item.removed = removed;
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, JsonSchema)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum CanvasOperation {
    /// Native content only, with a caller-chosen stable opaque id.
    Create {
        id: String,
        content: CanvasContent,
        #[serde(default)]
        origin: Option<crate::canvas::CanvasOrigin>,
        #[serde(default)]
        placement: CanvasPlacementFields,
        #[serde(default)]
        bindings: Vec<CanvasBinding>,
    },
    PatchContent {
        id: String,
        expected_revision: u64,
        fields: CanvasContentFields,
    },
    /// One block of a legacy reply; never a whole-reply replacement.
    PatchReply {
        id: String,
        expected_revision: u64,
        block: ReplyBlock,
    },
    /// Replace the atomic form of a native `block` object. The block id and kind stay.
    PatchBlock {
        id: String,
        expected_revision: u64,
        block: ReplyBlock,
    },
    Place {
        id: String,
        expected_revision: u64,
        fields: CanvasPlacementFields,
    },
    /// Replace this object's finite input configuration. An empty list disconnects it.
    Bind {
        id: String,
        expected_revision: u64,
        bindings: Vec<CanvasBinding>,
    },
    /// `expected_revision` 0 creates the composition.
    Compose {
        id: String,
        expected_revision: u64,
        #[serde(default)]
        title: String,
        /// Omission preserves the existing idea description.
        #[serde(default)]
        description: Option<String>,
        /// Omission preserves an existing arrangement; new compositions default to `free`.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        arrangement: Option<CanvasArrangement>,
        members: Vec<String>,
    },
    /// Reposition all direct object members using the composition's saved arrangement intent.
    Arrange {
        id: String,
        expected_revision: u64,
        /// Exact current presentation revisions for every direct object member.
        expected_presentations: BTreeMap<String, u64>,
    },
    /// `expected_revision` 0 creates a durable annotation.
    Annotate {
        id: String,
        expected_revision: u64,
        anchor: crate::inbox::CanvasAnchor,
        text: String,
    },
    /// Soft-remove or restore an annotation without losing its captured snapshot.
    RemoveAnnotation {
        id: String,
        expected_revision: u64,
        removed: bool,
    },
    Ungroup {
        id: String,
        expected_revision: u64,
    },
}

impl CanvasOperation {
    fn write_targets(&self) -> Vec<(CanvasTargetKind, &str)> {
        match self {
            Self::Create { id, .. } => vec![
                (CanvasTargetKind::Content, id),
                (CanvasTargetKind::Presentation, id),
            ],
            Self::PatchContent { id, .. }
            | Self::PatchReply { id, .. }
            | Self::PatchBlock { id, .. }
            | Self::Bind { id, .. } => {
                vec![(CanvasTargetKind::Content, id)]
            }
            Self::Place { id, .. } => vec![(CanvasTargetKind::Presentation, id)],
            Self::Compose { id, .. } | Self::Ungroup { id, .. } => {
                vec![(CanvasTargetKind::Composition, id)]
            }
            // Arrange writes member presentations discovered from live composition state. It
            // deliberately has no static target here so create -> compose -> arrange can use
            // the just-created presentation revisions in one atomic batch.
            Self::Arrange { .. } => vec![],
            Self::Annotate { id, .. } | Self::RemoveAnnotation { id, .. } => {
                vec![(CanvasTargetKind::Annotation, id)]
            }
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, JsonSchema)]
pub struct CanvasBatchRequest {
    pub request_id: String,
    #[serde(default)]
    pub reads: Vec<CanvasRead>,
    pub operations: Vec<CanvasOperation>,
    /// Part of the request fingerprint only; the bridge interprets feedback.
    #[serde(default)]
    pub feedback_sequences: Vec<u64>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum CanvasTargetState {
    Ready,
    Conflict,
    Invalid,
    Protected,
}

impl CanvasTargetState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Ready => "ready",
            Self::Conflict => "conflict",
            Self::Invalid => "invalid",
            Self::Protected => "protected",
        }
    }
}

impl PartialEq<str> for CanvasTargetState {
    fn eq(&self, other: &str) -> bool {
        self.as_str() == other
    }
}

impl PartialEq<&str> for CanvasTargetState {
    fn eq(&self, other: &&str) -> bool {
        self.as_str() == *other
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, JsonSchema)]
pub struct CanvasTargetStatus {
    pub kind: CanvasTargetKind,
    pub id: String,
    pub status: CanvasTargetState,
    #[serde(default)]
    pub expected_revision: Option<u64>,
    #[serde(default)]
    pub actual_revision: Option<u64>,
    #[serde(default)]
    pub message: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum CanvasBatchStatus {
    Applied,
    Proposed,
    Dismissed,
}

impl CanvasBatchStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Applied => "applied",
            Self::Proposed => "proposed",
            Self::Dismissed => "dismissed",
        }
    }
}

impl PartialEq<str> for CanvasBatchStatus {
    fn eq(&self, other: &str) -> bool {
        self.as_str() == other
    }
}

impl PartialEq<&str> for CanvasBatchStatus {
    fn eq(&self, other: &&str) -> bool {
        self.as_str() == *other
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, JsonSchema)]
pub struct CanvasBatchResult {
    pub request_id: String,
    pub status: CanvasBatchStatus,
    pub targets: Vec<CanvasTargetStatus>,
}

impl CanvasBatchResult {
    pub fn is_applied(&self) -> bool {
        self.status == CanvasBatchStatus::Applied
    }
}

/// The unified pending-change record; also kept as a receipt after apply/dismiss.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, JsonSchema)]
pub struct CanvasProposal {
    pub request: CanvasBatchRequest,
    #[serde(default)]
    pub source_id: Option<String>,
    pub result: CanvasBatchResult,
}

#[derive(Clone)]
struct Fail {
    status: CanvasTargetState,
    actual: Option<u64>,
    message: String,
}

impl Fail {
    fn conflict(actual: Option<u64>, message: &str) -> Self {
        Self {
            status: CanvasTargetState::Conflict,
            actual,
            message: message.into(),
        }
    }

    fn invalid(message: impl Into<String>) -> Self {
        Self {
            status: CanvasTargetState::Invalid,
            actual: None,
            message: message.into(),
        }
    }

    fn protected(actual: u64, message: &str) -> Self {
        Self {
            status: CanvasTargetState::Protected,
            actual: Some(actual),
            message: message.into(),
        }
    }
}

impl From<SpellcastError> for Fail {
    fn from(error: SpellcastError) -> Self {
        Self::invalid(error.to_string())
    }
}

fn status(
    kind: CanvasTargetKind,
    id: &str,
    expected: Option<u64>,
    outcome: Result<Option<u64>, Fail>,
) -> CanvasTargetStatus {
    match outcome {
        Ok(actual) => CanvasTargetStatus {
            kind,
            id: id.into(),
            status: CanvasTargetState::Ready,
            expected_revision: expected,
            actual_revision: actual,
            message: None,
        },
        Err(fail) => CanvasTargetStatus {
            kind,
            id: id.into(),
            status: fail.status,
            expected_revision: expected,
            actual_revision: fail.actual,
            message: Some(fail.message),
        },
    }
}

#[derive(Default)]
struct Targets(Vec<CanvasTargetStatus>);

impl Targets {
    /// One entry per (kind, id); a failure is never hidden by a later ready entry.
    fn push(&mut self, next: CanvasTargetStatus) {
        match self
            .0
            .iter_mut()
            .find(|t| t.kind == next.kind && t.id == next.id)
        {
            Some(existing)
                if existing.status != CanvasTargetState::Ready
                    && next.status == CanvasTargetState::Ready => {}
            Some(existing) => *existing = next,
            None => self.0.push(next),
        }
    }
}

/// Who is writing. `agent` enforces ownership and user protection; `mark_user` records user edits.
struct Mode<'a> {
    owner: Option<&'a str>,
    agent: bool,
    mark_user: bool,
}

struct Outcome {
    next: Session,
    targets: Vec<CanvasTargetStatus>,
}

impl Outcome {
    fn all_ready(&self) -> bool {
        self.targets
            .iter()
            .all(|t| t.status == CanvasTargetState::Ready)
    }
}

fn check(condition: bool, message: &str) -> Result<(), SpellcastError> {
    if condition {
        Ok(())
    } else {
        Err(SpellcastError::user(message))
    }
}

fn validate_new_id(id: &str) -> Result<(), Fail> {
    validate_id(id)?;
    if id.starts_with("node:") || id.starts_with("reply:") {
        return Err(Fail::invalid(
            "新对象或组合的 ID 不能使用 node:/reply: 前缀。",
        ));
    }
    Ok(())
}

fn validate_request(request: &CanvasBatchRequest) -> Result<(), SpellcastError> {
    validate_id(&request.request_id)?;
    check(
        (1..=MAX_BATCH_OPERATIONS).contains(&request.operations.len()),
        "一批画布修改需要 1–64 个操作。",
    )?;
    check(
        request.reads.len() <= MAX_BATCH_READS,
        "一批画布修改最多声明 128 个读依赖。",
    )?;
    let mut seen = HashSet::new();
    for op in &request.operations {
        for target in op.write_targets() {
            check(seen.insert(target), "同一批里对同一目标只能写一次。")?;
        }
    }
    Ok(())
}

/// Agents write only what they own. Checked against live state before anything is cloned.
fn check_ownership(
    session: &Session,
    request: &CanvasBatchRequest,
    owner: &str,
) -> Result<(), SpellcastError> {
    let canvas = &session.board.canvas;
    // Unassigned user content may receive a proposal, but the operation itself stays protected.
    let owned = |source: &Option<String>| source.as_deref().is_none_or(|source| source == owner);
    for op in &request.operations {
        let ok = match op {
            CanvasOperation::Create { .. } => true,
            CanvasOperation::PatchContent { id, .. }
            | CanvasOperation::PatchReply { id, .. }
            | CanvasOperation::PatchBlock { id, .. }
            | CanvasOperation::Place { id, .. }
            | CanvasOperation::Bind { id, .. } => canvas
                .object(id)
                .is_none_or(|object| owned(&object.source_id)),
            CanvasOperation::Compose { id, members, .. } => {
                canvas
                    .composition(id)
                    .is_none_or(|composition| owned(&composition.source_id))
                    && members.iter().all(|member| {
                        canvas
                            .object(member)
                            .map(|o| &o.source_id)
                            .or_else(|| canvas.composition(member).map(|c| &c.source_id))
                            .is_none_or(&owned)
                    })
            }
            CanvasOperation::Arrange { id, .. } => canvas
                .composition(id)
                .is_none_or(|composition| {
                    owned(&composition.source_id)
                        && composition.members.iter().all(|member| {
                            canvas
                                .object(member)
                                .map(|object| &object.source_id)
                                .or_else(|| canvas.composition(member).map(|group| &group.source_id))
                                .is_none_or(&owned)
                        })
                }),
            CanvasOperation::Annotate { id, anchor, .. } => {
                let existing = canvas.annotation(id);
                existing.is_none_or(|annotation| owned(&annotation.source_id))
                    && (existing.is_some_and(|annotation| annotation.anchor == *anchor)
                        || canvas
                            .object(&anchor.object_id)
                            .is_none_or(|object| owned(&object.source_id)))
            }
            CanvasOperation::RemoveAnnotation { id, .. } => canvas
                .annotation(id)
                .is_none_or(|annotation| owned(&annotation.source_id)),
            CanvasOperation::Ungroup { id, .. } => {
                canvas
                    .composition(id)
                    .is_none_or(|composition| owned(&composition.source_id))
                    && canvas
                        .parent_of(id)
                        .is_none_or(|parent| owned(&parent.source_id))
            }
        };
        check(
            ok,
            "Agent 只能修改自己来源的对象、组合和注释；其他来源的内容只能读取。",
        )?;
    }
    Ok(())
}

fn find_object(session: &Session, id: &str) -> Result<CanvasObject, Fail> {
    session
        .board
        .canvas
        .object(id)
        .cloned()
        .ok_or_else(|| Fail::conflict(None, "画布内容对象不存在。"))
}

fn expect_revision(actual: u64, expected: u64, message: &str) -> Result<(), Fail> {
    if actual == expected {
        Ok(())
    } else {
        Err(Fail::conflict(Some(actual), message))
    }
}

fn artifact_block_exists(session: &Session, object_id: &str, block_id: &str) -> bool {
    let Some(CanvasObject {
        content: CanvasContent::Reply { id },
        ..
    }) = session.board.canvas.object(object_id)
    else {
        return false;
    };
    session
        .board
        .replies
        .iter()
        .find(|reply| reply.id == *id)
        .and_then(|reply| reply.blocks.iter().find(|block| block.id() == block_id))
        .is_some_and(|block| matches!(block, ReplyBlock::Artifact { .. }))
}

fn validate_binding_list(
    base: &Session,
    next: &Session,
    request: &CanvasBatchRequest,
    target_id: &str,
    target_content: &CanvasContent,
    current: &[CanvasBinding],
    bindings: &[CanvasBinding],
    created: &HashSet<String>,
) -> Result<(), Fail> {
    if bindings.len() > MAX_BINDINGS_PER_OBJECT {
        return Err(Fail::invalid("一个对象最多连接 32 个输入。"));
    }
    let mut targets = HashSet::new();
    for binding in bindings {
        validate_id(&binding.from.object_id)?;
        validate_id(&binding.from.block_id)?;
        validate_id(&binding.from.port)?;
        if let Some(block_id) = &binding.to.block_id {
            validate_id(block_id)?;
        }
        validate_id(&binding.to.port)?;
        if !targets.insert(&binding.to) {
            return Err(Fail::invalid("同一个目标输入端口只能连接一次。"));
        }
        if current.contains(binding) {
            continue;
        }
        if binding.from.object_id == target_id {
            return Err(Fail::invalid("对象不能连接自己的输出。"));
        }
        match target_content {
            CanvasContent::Text { .. }
                if binding.to.block_id.is_none() && binding.to.port == "text" => {}
            CanvasContent::Reply { id } => {
                let Some(block_id) = binding.to.block_id.as_deref() else {
                    return Err(Fail::invalid("回复作品输入需要指定作品块。"));
                };
                let valid = next
                    .board
                    .replies
                    .iter()
                    .find(|reply| reply.id == *id)
                    .and_then(|reply| reply.blocks.iter().find(|block| block.id() == block_id))
                    .is_some_and(|block| matches!(block, ReplyBlock::Artifact { .. }));
                if !valid {
                    return Err(Fail::invalid("目标输入必须属于仍存在的作品块。"));
                }
            }
            _ => {
                return Err(Fail::invalid(
                    "目标只能是原生文字的 text 输入或回复中的作品输入。",
                ))
            }
        }
        if !artifact_block_exists(next, &binding.from.object_id, &binding.from.block_id) {
            return Err(Fail::invalid("上游输出必须来自仍存在的回复作品块。"));
        }
        if created.contains(&binding.from.object_id) {
            continue;
        }
        let upstream = base
            .board
            .canvas
            .object(&binding.from.object_id)
            .ok_or_else(|| Fail::invalid("上游对象不存在。"))?;
        let reads: Vec<_> = request
            .reads
            .iter()
            .filter(|read| {
                read.kind == CanvasTargetKind::Content && read.id == binding.from.object_id
            })
            .collect();
        if reads.is_empty() {
            return Err(Fail::invalid("新增连接需要声明上游对象的当前内容版本。"));
        }
        if !reads
            .iter()
            .any(|read| read.revision == upstream.content_revision)
        {
            return Err(Fail::conflict(
                Some(upstream.content_revision),
                "上游对象已经更新，请按当前内容版本重新连接。",
            ));
        }
    }
    Ok(())
}

fn binding_reaches(canvas: &CanvasLayout, from: &str, target: &str) -> bool {
    let mut stack = vec![from];
    let mut seen = HashSet::new();
    while let Some(id) = stack.pop() {
        if id == target {
            return true;
        }
        if !seen.insert(id) {
            continue;
        }
        for object in &canvas.objects {
            if object
                .bindings
                .iter()
                .any(|binding| binding.from.object_id == id)
            {
                stack.push(object.id.as_str());
            }
        }
    }
    false
}

fn validate_binding_graph(canvas: &CanvasLayout) -> Result<(), Fail> {
    if canvas
        .objects
        .iter()
        .map(|object| object.bindings.len())
        .sum::<usize>()
        > MAX_CANVAS_BINDINGS
    {
        return Err(Fail::invalid("画布最多保存 256 条对象连接。"));
    }
    for object in &canvas.objects {
        for binding in &object.bindings {
            if binding.from.object_id == object.id
                || binding_reaches(canvas, &object.id, &binding.from.object_id)
            {
                return Err(Fail::invalid("对象连接必须保持无环。"));
            }
        }
    }
    Ok(())
}

fn create(
    base: &Session,
    next: &mut Session,
    request: &CanvasBatchRequest,
    mode: &Mode,
    created: &HashSet<String>,
    id: &str,
    content: &CanvasContent,
    origin: &Option<crate::canvas::CanvasOrigin>,
    placement: &CanvasPlacementFields,
    bindings: &[CanvasBinding],
) -> Result<(), (CanvasTargetKind, Fail)> {
    use CanvasTargetKind::{Content, Presentation};
    validate_new_id(id).map_err(|f| (Content, f))?;
    if content.is_legacy() {
        return Err((
            Content,
            Fail::invalid("不能通过创建 node/reply 引用绕过旧正文存储；只能创建原生内容。"),
        ));
    }
    let canvas = &next.board.canvas;
    if let Some(existing) = canvas.object(id) {
        return Err((
            Content,
            Fail::conflict(Some(existing.content_revision), "同 ID 的对象已经存在。"),
        ));
    }
    if canvas.composition(id).is_some() {
        return Err((Content, Fail::invalid("这个 ID 已被一个组合使用。")));
    }
    if canvas.annotation(id).is_some() {
        return Err((Content, Fail::invalid("这个 ID 已被一条注释使用。")));
    }
    content.validate().map_err(|e| (Content, e.into()))?;
    if let Some(origin) = origin {
        let path = origin.cwd.replace('\\', "/");
        let absolute = path.starts_with('/')
            || (path.len() >= 3
                && path.as_bytes()[0].is_ascii_alphabetic()
                && path.as_bytes()[1..3] == *b":/");
        if !absolute
            || origin.cwd.len() > 4096
            || origin.cwd.chars().any(char::is_control)
            || origin.label.chars().count() > 4000
        {
            return Err((Content, Fail::invalid("工作区来源需要有效的绝对路径。")));
        }
        for id in [origin.thread_id.as_deref(), origin.source_id.as_deref()]
            .into_iter()
            .flatten()
        {
            validate_id(id).map_err(|error| (Content, error.into()))?;
        }
    }
    validate_binding_list(base, next, request, id, content, &[], bindings, created)
        .map_err(|fail| (Content, fail))?;
    let (width, height) = content.default_size();
    let mut item = CanvasPlacement {
        item_id: id.into(),
        revision: 1,
        z: placement.z.unwrap_or_else(|| canvas.next_z()),
        removed: placement.removed.unwrap_or(false),
        appearance: placement.appearance.unwrap_or(CanvasAppearance::Plain),
        x: placement.x.unwrap_or(48.0),
        y: placement.y.unwrap_or(48.0),
        width: placement.width.unwrap_or(width),
        height: placement.height.unwrap_or(height),
        content_scale: placement.content_scale.unwrap_or(1.0),
        user_modified: mode.mark_user,
    };
    item.validate().map_err(|e| (Presentation, e.into()))?;
    if placement.x.is_none() && placement.y.is_none() {
        canvas.place_free(&mut item);
    }
    next.board.canvas.objects.push(CanvasObject {
        id: id.into(),
        content: content.clone(),
        content_revision: 1,
        origin: origin.clone(),
        bindings: bindings.to_vec(),
        source_id: mode.owner.map(String::from),
        user_edited: mode.mark_user,
    });
    next.board.canvas.items.push(item);
    Ok(())
}

fn require_title(title: &str) -> Result<String, Fail> {
    let title = title.trim();
    if title.is_empty() {
        return Err(Fail::invalid("标题不能为空。"));
    }
    if title.chars().count() > 160 {
        return Err(Fail::invalid("标题最多 160 字。"));
    }
    Ok(title.to_string())
}

fn patch_content(
    next: &mut Session,
    mode: &Mode,
    id: &str,
    expected: u64,
    fields: &CanvasContentFields,
) -> Result<u64, Fail> {
    let object = find_object(next, id)?;
    expect_revision(
        object.content_revision,
        expected,
        "对象内容已经更新，请重新读取后再修改。",
    )?;
    if mode.agent && (object.user_edited || object.source_id.is_none()) {
        return Err(Fail::protected(
            object.content_revision,
            "用户已经编辑过这段内容；保留为可应用的提案。",
        ));
    }
    let given = fields.given();
    if given.is_empty() {
        return Err(Fail::invalid("没有要修改的字段。"));
    }
    let allowed: &[&str] = match &object.content {
        CanvasContent::Node { .. } | CanvasContent::Text { .. } => &["title", "text"],
        CanvasContent::Reply { .. } => &["title"],
        CanvasContent::Image { .. } => &["title", "src", "alt"],
        CanvasContent::Shape { .. } => &["title", "fill", "text"],
        // Block objects change only as a whole form through `PatchBlock`.
        CanvasContent::Block { .. } => &[],
    };
    if let Some(name) = given.iter().find(|name| !allowed.contains(name)) {
        return Err(Fail::invalid(format!(
            "{} 内容不支持字段 {name}。",
            object.content.kind_name()
        )));
    }
    let revision = match &object.content {
        CanvasContent::Node { id: node_id } => {
            let title = fields.title.as_deref().map(require_title).transpose()?;
            let node = next.patch_node(
                node_id,
                NodePatch {
                    expected_revision: Some(object.content_revision),
                    title,
                    body: fields.text.clone(),
                    ..Default::default()
                },
            )?;
            node.revision
        }
        CanvasContent::Reply { id: reply_id } => {
            let title = require_title(fields.title.as_deref().unwrap_or_default())?;
            let reply = next
                .board
                .replies
                .iter_mut()
                .find(|reply| &reply.id == reply_id)
                .ok_or_else(|| Fail::conflict(None, "这块回复已经不在板上。"))?;
            if reply.title != title {
                reply.title = title;
                reply.revision += 1;
                reply.updated_at_ms = now_ms();
            }
            reply.revision
        }
        _ => {
            let mut content = object.content.clone();
            match &mut content {
                CanvasContent::Text { title, text } => {
                    if let Some(v) = &fields.title {
                        *title = v.clone();
                    }
                    if let Some(v) = &fields.text {
                        *text = v.clone();
                    }
                }
                CanvasContent::Image { title, src, alt } => {
                    if let Some(v) = &fields.title {
                        *title = v.clone();
                    }
                    if let Some(v) = &fields.src {
                        *src = v.clone();
                    }
                    if let Some(v) = &fields.alt {
                        *alt = v.clone();
                    }
                }
                CanvasContent::Shape {
                    title, fill, text, ..
                } => {
                    if let Some(v) = &fields.title {
                        *title = v.clone();
                    }
                    if let Some(v) = &fields.fill {
                        *fill = v.clone();
                    }
                    if let Some(v) = &fields.text {
                        *text = v.clone();
                    }
                }
                CanvasContent::Node { .. }
                | CanvasContent::Reply { .. }
                | CanvasContent::Block { .. } => unreachable!(),
            }
            content.validate()?;
            let target = next
                .board
                .canvas
                .objects
                .iter_mut()
                .find(|o| o.id == id)
                .expect("checked above");
            if target.content != content {
                target.content = content;
                target.content_revision + 1
            } else {
                target.content_revision
            }
        }
    };
    let target = next
        .board
        .canvas
        .objects
        .iter_mut()
        .find(|o| o.id == id)
        .expect("checked above");
    target.content_revision = revision;
    if mode.mark_user {
        target.user_edited = true;
    }
    Ok(revision)
}

fn patch_reply(
    next: &mut Session,
    mode: &Mode,
    id: &str,
    expected: u64,
    block: &ReplyBlock,
) -> Result<u64, Fail> {
    let object = find_object(next, id)?;
    expect_revision(
        object.content_revision,
        expected,
        "回复内容已经更新，请重新读取后再修改。",
    )?;
    if mode.agent && (object.user_edited || object.source_id.is_none()) {
        return Err(Fail::protected(
            object.content_revision,
            "用户已经编辑过这块回复；保留为可应用的提案。",
        ));
    }
    let CanvasContent::Reply { id: reply_id } = &object.content else {
        return Err(Fail::invalid("只有回复对象可以按内容块修改。"));
    };
    let reply = next
        .board
        .replies
        .iter()
        .find(|reply| &reply.id == reply_id)
        .ok_or_else(|| Fail::conflict(None, "这块回复已经不在板上。"))?;
    let mut block = block.clone();
    if !mode.mark_user {
        if let Some(previous) = reply.blocks.iter().find(|old| old.id() == block.id()) {
            block.preserve_user_state_from(previous);
        }
    }
    let updated = next.patch_reply(ReplyPatchRequest {
        object_id: None,
        reply_id: reply_id.clone(),
        request_id: None,
        expected_revision: reply.revision,
        block,
        layout_only: false,
    })?;
    let target = next
        .board
        .canvas
        .objects
        .iter_mut()
        .find(|o| o.id == id)
        .expect("checked above");
    target.content_revision = updated.revision;
    if mode.mark_user {
        target.user_edited = true;
    }
    Ok(updated.revision)
}

/// Whole-form replacement of a native block object. Identity (object id, block id, block
/// kind) never changes here; a different form is a new object.
fn patch_block(
    next: &mut Session,
    mode: &Mode,
    id: &str,
    expected: u64,
    block: &ReplyBlock,
) -> Result<u64, Fail> {
    let object = find_object(next, id)?;
    expect_revision(
        object.content_revision,
        expected,
        "内容块已经更新，请重新读取后再修改。",
    )?;
    if mode.agent && (object.user_edited || object.source_id.is_none()) {
        return Err(Fail::protected(
            object.content_revision,
            "用户已经编辑过这个内容块；保留为可应用的提案。",
        ));
    }
    let CanvasContent::Block { block: current } = &object.content else {
        return Err(Fail::invalid(format!(
            "{} 内容不支持整块替换；只有内容块对象可以。",
            object.content.kind_name()
        )));
    };
    CanvasContent::validate_block(block)?;
    if block.id() != current.id() {
        return Err(Fail::invalid("内容块的 ID 不能改变。"));
    }
    if std::mem::discriminant(block) != std::mem::discriminant(current) {
        return Err(Fail::invalid("内容块的形式不能改变；请新建一个对象。"));
    }
    let content_changed = !current.same_content(block);
    let mut block = block.clone();
    if !mode.mark_user {
        block.preserve_user_state_from(current);
    }
    let content = CanvasContent::Block { block };
    let target = next
        .board
        .canvas
        .objects
        .iter_mut()
        .find(|o| o.id == id)
        .expect("checked above");
    if target.content != content {
        target.content = content;
        target.content_revision += 1;
    }
    if mode.mark_user && content_changed {
        target.user_edited = true;
    }
    Ok(target.content_revision)
}

fn bind(
    base: &Session,
    next: &mut Session,
    request: &CanvasBatchRequest,
    mode: &Mode,
    created: &HashSet<String>,
    id: &str,
    expected: u64,
    bindings: &[CanvasBinding],
) -> Result<u64, Fail> {
    let object = find_object(next, id)?;
    expect_revision(
        object.content_revision,
        expected,
        "对象内容已经更新，请重新读取后再连接。",
    )?;
    if mode.agent && (object.user_edited || object.source_id.is_none()) {
        return Err(Fail::protected(
            object.content_revision,
            "用户已经编辑过这个对象；保留为可应用的提案。",
        ));
    }
    validate_binding_list(
        base,
        next,
        request,
        id,
        &object.content,
        &object.bindings,
        bindings,
        created,
    )?;
    let revision = if let CanvasContent::Reply { id: reply_id } = &object.content {
        let reply = next
            .board
            .replies
            .iter_mut()
            .find(|reply| &reply.id == reply_id)
            .ok_or_else(|| Fail::conflict(None, "这块回复已经不在板上。"))?;
        reply.revision += 1;
        reply.updated_at_ms = now_ms();
        reply.revision
    } else {
        object.content_revision + 1
    };
    let target = next
        .board
        .canvas
        .objects
        .iter_mut()
        .find(|object| object.id == id)
        .expect("checked above");
    target.bindings = bindings.to_vec();
    target.content_revision = revision;
    if mode.mark_user {
        target.user_edited = true;
    }
    Ok(revision)
}

fn place(
    next: &mut Session,
    mode: &Mode,
    id: &str,
    expected: u64,
    fields: &CanvasPlacementFields,
) -> Result<u64, Fail> {
    let object = find_object(next, id)?;
    let current = next
        .board
        .canvas
        .placement(&object.id)
        .cloned()
        .ok_or_else(|| Fail::conflict(None, "画布呈现不存在。"))?;
    expect_revision(
        current.revision,
        expected,
        "对象呈现已经更新，请查看最新位置后重试。",
    )?;
    if mode.agent && (current.user_modified || object.source_id.is_none()) {
        return Err(Fail::protected(
            current.revision,
            "用户已经调整过这个呈现；保留为可应用的提案。",
        ));
    }
    if fields.is_empty() {
        return Err(Fail::invalid("没有要修改的呈现字段。"));
    }
    let mut item = current.clone();
    fields.apply_to(&mut item);
    item.validate()?;
    if item != current {
        item.revision += 1;
        if mode.mark_user {
            item.user_modified = true;
        }
        let slot = next
            .board
            .canvas
            .items
            .iter_mut()
            .find(|p| p.item_id == object.id)
            .expect("checked above");
        *slot = item.clone();
    }
    Ok(item.revision)
}

fn compose(
    next: &mut Session,
    mode: &Mode,
    id: &str,
    expected: u64,
    title: &str,
    description: Option<&str>,
    arrangement: Option<CanvasArrangement>,
    members: &[String],
) -> Result<u64, Fail> {
    validate_new_id(id)?;
    let canvas = &next.board.canvas;
    let existing = canvas.composition(id).cloned();
    match (&existing, expected) {
        (None, 0) => {
            if canvas.object(id).is_some() || canvas.annotation(id).is_some() {
                return Err(Fail::invalid("这个 ID 已被一个对象或注释使用。"));
            }
        }
        (None, _) => return Err(Fail::conflict(None, "组合不存在。")),
        (Some(current), expected) => {
            expect_revision(
                current.revision,
                expected,
                "组合已经更新，请重新读取后再修改。",
            )?;
        }
    }
    if mode.agent
        && (existing
            .as_ref()
            .is_some_and(|group| group.source_id.is_none() || group.user_modified)
            || members.iter().any(|member| {
                canvas
                    .object(member)
                    .map(|o| &o.source_id)
                    .or_else(|| canvas.composition(member).map(|c| &c.source_id))
                    .is_some_and(Option::is_none)
            }))
    {
        return Err(Fail::protected(
            existing.as_ref().map_or(0, |group| group.revision),
            "这个组合包含用户自己的内容；保留为可应用的提案。",
        ));
    }
    if title.chars().count() > 160 {
        return Err(Fail::invalid("组合标题最多 160 字。"));
    }
    if description.is_some_and(|text| text.chars().count() > 4000) {
        return Err(Fail::invalid("想法说明最多 4000 字。"));
    }
    if !(1..=MAX_COMPOSITION_MEMBERS).contains(&members.len()) {
        return Err(Fail::invalid("一个组合需要 1–64 个成员。"));
    }
    let mut seen = HashSet::new();
    for member in members {
        validate_id(member)?;
        if member == id {
            return Err(Fail::invalid("组合不能包含自己。"));
        }
        if !seen.insert(member.as_str()) {
            return Err(Fail::invalid(format!("成员 {member} 重复。")));
        }
        let is_composition = canvas.composition(member).is_some();
        if !is_composition && canvas.object(member).is_none() {
            return Err(Fail::invalid(format!("成员 {member} 不存在。")));
        }
        if canvas
            .parent_of(member)
            .is_some_and(|parent| parent.id != id)
        {
            return Err(Fail::invalid(format!("成员 {member} 已经属于另一个组合。")));
        }
        if is_composition && canvas.composition_reaches(member, id) {
            return Err(Fail::invalid(format!("成员 {member} 会让组合形成环。")));
        }
    }
    let compositions = &mut next.board.canvas.compositions;
    if let Some(current) = compositions.iter_mut().find(|c| c.id == id) {
        let description = description.unwrap_or(&current.description).to_string();
        let arrangement = arrangement.unwrap_or(current.arrangement);
        if current.title == title
            && current.description == description
            && current.arrangement == arrangement
            && current.members == members
        {
            return Ok(current.revision);
        }
        current.title = title.to_string();
        current.description = description;
        current.arrangement = arrangement;
        current.members = members.to_vec();
        if mode.mark_user {
            current.user_modified = true;
        }
        current.revision += 1;
        Ok(current.revision)
    } else {
        compositions.push(CanvasComposition {
            id: id.into(),
            revision: 1,
            title: title.to_string(),
            description: description.unwrap_or_default().to_string(),
            arrangement: arrangement.unwrap_or_default(),
            members: members.to_vec(),
            source_id: mode.owner.map(String::from),
            user_modified: mode.mark_user,
        });
        Ok(1)
    }
}

fn composition_revision_after_compose(
    canvas: &CanvasLayout,
    id: &str,
    title: &str,
    description: Option<&str>,
    arrangement: Option<CanvasArrangement>,
    members: &[String],
) -> u64 {
    let Some(current) = canvas.composition(id) else {
        return 1;
    };
    let description = description.unwrap_or(&current.description);
    let arrangement = arrangement.unwrap_or(current.arrangement);
    if current.title == title
        && current.description == description
        && current.arrangement == arrangement
        && current.members == members
    {
        current.revision
    } else {
        current.revision + 1
    }
}

struct ArrangementPlacement {
    id: String,
    expected_revision: u64,
    fields: CanvasPlacementFields,
}

/// Build a placement-only plan from the saved composition intent. This does not mutate the
/// composition or any member; callers use `place` for the actual guarded writes.
fn arrangement_plan(
    next: &Session,
    mode: &Mode,
    id: &str,
    expected: u64,
    expected_presentations: &BTreeMap<String, u64>,
) -> Result<(u64, Vec<ArrangementPlacement>), Fail> {
    let canvas = &next.board.canvas;
    let composition = canvas
        .composition(id)
        .cloned()
        .ok_or_else(|| Fail::conflict(None, "组合不存在。"))?;
    expect_revision(
        composition.revision,
        expected,
        "组合已经更新，请重新读取后再编排。",
    )?;
    if mode.agent && (composition.source_id.is_none() || composition.user_modified) {
        return Err(Fail::protected(
            composition.revision,
            "用户自己的组合需要先确认提案再编排。",
        ));
    }
    if composition.arrangement == CanvasArrangement::Free {
        return Err(Fail::invalid(
            "组合的 arrangement 为 free；请先保存一个明确的编排意图。",
        ));
    }

    let mut items = Vec::with_capacity(composition.members.len());
    for member in &composition.members {
        if canvas.composition(member).is_some() {
            return Err(Fail::invalid(
                "首版编排只支持直接对象成员；嵌套组合不能自动展平。",
            ));
        }
        let object = canvas
            .object(member)
            .ok_or_else(|| Fail::invalid(format!("成员 {member} 不存在。")))?;
        let item = canvas
            .placement(&object.id)
            .cloned()
            .ok_or_else(|| Fail::conflict(None, "画布呈现不存在。"))?;
        item.validate()?;
        if item.removed {
            return Err(Fail::invalid(
                "隐藏的成员不能参与编排；不会自动恢复隐藏内容。",
            ));
        }
        items.push(item);
    }

    if expected_presentations.len() != items.len()
        || items
            .iter()
            .any(|item| !expected_presentations.contains_key(&item.item_id))
    {
        return Err(Fail::invalid(
            "编排必须且只能声明每个直接对象成员的当前呈现版本。",
        ));
    }

    let left = items
        .iter()
        .map(|item| item.x)
        .fold(f64::INFINITY, f64::min);
    let top = items
        .iter()
        .map(|item| item.y)
        .fold(f64::INFINITY, f64::min);
    let max_width = items.iter().map(|item| item.width).fold(0.0, f64::max);
    let mut placements = Vec::with_capacity(items.len());

    match composition.arrangement {
        CanvasArrangement::Free => unreachable!("free is rejected above"),
        CanvasArrangement::SideBySide => {
            let mut x = left;
            for item in items {
                placements.push(ArrangementPlacement {
                    expected_revision: expected_presentations[&item.item_id],
                    id: item.item_id.clone(),
                    fields: CanvasPlacementFields {
                        x: Some(x),
                        y: Some(top),
                        ..Default::default()
                    },
                });
                x += item.width + 32.0;
            }
        }
        CanvasArrangement::FigureCaption => {
            let mut y = top;
            for item in items {
                placements.push(ArrangementPlacement {
                    expected_revision: expected_presentations[&item.item_id],
                    id: item.item_id.clone(),
                    fields: CanvasPlacementFields {
                        x: Some(left + (max_width - item.width) / 2.0),
                        y: Some(y),
                        ..Default::default()
                    },
                });
                y += item.height + 16.0;
            }
        }
        CanvasArrangement::Sequence => {
            let mut y = top;
            for item in items {
                placements.push(ArrangementPlacement {
                    expected_revision: expected_presentations[&item.item_id],
                    id: item.item_id.clone(),
                    fields: CanvasPlacementFields {
                        x: Some(left),
                        y: Some(y),
                        ..Default::default()
                    },
                });
                y += item.height + 48.0;
            }
        }
    }

    Ok((composition.revision, placements))
}

fn add_arrangement_error_targets(
    targets: &mut Targets,
    next: &Session,
    id: &str,
    expected_presentations: &BTreeMap<String, u64>,
    fail: &Fail,
) {
    let Some(composition) = next.board.canvas.composition(id) else {
        return;
    };
    for member in &composition.members {
        if next.board.canvas.object(member).is_some() {
            targets.push(status(
                CanvasTargetKind::Presentation,
                member,
                expected_presentations.get(member).copied(),
                Err(fail.clone()),
            ));
        }
    }
}

fn annotate(
    next: &mut Session,
    mode: &Mode<'_>,
    id: &str,
    expected: u64,
    anchor: &crate::inbox::CanvasAnchor,
    text: &str,
) -> Result<u64, Fail> {
    validate_new_id(id)?;
    if text.chars().count() > 8_000 {
        return Err(Fail::invalid("注释正文最多 8000 字；请拆成几条注释。"));
    }
    if text.trim().is_empty() {
        return Err(Fail::invalid("注释正文不能为空。"));
    }
    let existing = next.board.canvas.annotation(id).cloned();
    match (&existing, expected) {
        (None, 0) => {
            if next.board.canvas.object(id).is_some()
                || next.board.canvas.composition(id).is_some()
            {
                return Err(Fail::invalid("这个 ID 已被画布对象或组合使用。"));
            }
        }
        (None, _) => return Err(Fail::conflict(None, "注释不存在。")),
        (Some(annotation), revision) => {
            expect_revision(
                annotation.revision,
                revision,
                "注释已经更新，请重新读取后再修改。",
            )?;
            if mode.agent && annotation.source_id.as_deref() != mode.owner {
                return Err(Fail::protected(
                    annotation.revision,
                    "用户或其他任务写的注释不能由当前 Agent 直接修改。",
                ));
            }
        }
    }

    let (snapshot, origin) = if let Some(current) = &existing {
        if current.anchor == *anchor {
            (current.snapshot.clone(), current.origin.clone())
        } else {
            capture_anchor_snapshot(next, anchor, false)?
        }
    } else {
        capture_anchor_snapshot(next, anchor, false)?
    };
    let source_id = mode.owner.map(String::from);
    let mut candidate = CanvasAnnotation {
        id: id.to_string(),
        revision: existing.as_ref().map_or(1, |annotation| annotation.revision),
        anchor: anchor.clone(),
        snapshot,
        text: text.to_string(),
        origin,
        source_id,
        removed: existing.as_ref().is_some_and(|annotation| annotation.removed),
    };
    if serde_json::to_vec(&candidate)
        .map_err(|error| Fail::invalid(error.to_string()))?
        .len()
        > 3 * 1024 * 1024
    {
        return Err(Fail::invalid(
            "单条注释超过 3 MiB；请把图片保存为 immutable /artifacts 资源后重试。",
        ));
    }
    if let Some(current) = existing {
        if current == candidate {
            return Ok(current.revision);
        }
        candidate.revision += 1;
        *next
            .board
            .canvas
            .annotations
            .iter_mut()
            .find(|annotation| annotation.id == id)
            .expect("checked above") = candidate.clone();
    } else {
        next.board.canvas.annotations.push(candidate.clone());
    }
    Ok(candidate.revision)
}

fn remove_annotation(
    next: &mut Session,
    mode: &Mode<'_>,
    id: &str,
    expected: u64,
    removed: bool,
) -> Result<u64, Fail> {
    let annotation = next
        .board
        .canvas
        .annotation(id)
        .cloned()
        .ok_or_else(|| Fail::conflict(None, "注释不存在。"))?;
    expect_revision(
        annotation.revision,
        expected,
        "注释已经更新，请重新读取后再修改。",
    )?;
    if mode.agent && annotation.source_id.as_deref() != mode.owner {
        return Err(Fail::protected(
            annotation.revision,
            "用户或其他任务写的注释不能由当前 Agent 直接移除。",
        ));
    }
    let target = next
        .board
        .canvas
        .annotations
        .iter_mut()
        .find(|annotation| annotation.id == id)
        .expect("checked above");
    if target.removed != removed {
        target.removed = removed;
        target.revision += 1;
        if mode.mark_user {
            target.source_id = None;
        }
    }
    Ok(target.revision)
}

fn ungroup(next: &mut Session, mode: &Mode, id: &str, expected: u64) -> Result<(), Fail> {
    let canvas = &mut next.board.canvas;
    let position = canvas
        .compositions
        .iter()
        .position(|c| c.id == id)
        .ok_or_else(|| Fail::conflict(None, "组合不存在。"))?;
    expect_revision(
        canvas.compositions[position].revision,
        expected,
        "组合已经更新，请重新读取后再解组。",
    )?;
    if mode.agent
        && (canvas.compositions[position].source_id.is_none()
            || canvas.compositions[position].user_modified
            || canvas
                .parent_of(id)
                .is_some_and(|parent| parent.source_id.is_none() || parent.user_modified))
    {
        return Err(Fail::protected(
            canvas.compositions[position].revision,
            "用户自己的组合需要先确认提案再解组。",
        ));
    }
    let removed = canvas.compositions.remove(position);
    if let Some(parent) = canvas
        .compositions
        .iter_mut()
        .find(|c| c.members.iter().any(|m| m == id))
    {
        let index = parent
            .members
            .iter()
            .position(|m| m == id)
            .expect("found above");
        parent
            .members
            .splice(index..=index, removed.members.iter().cloned());
        parent.revision += 1;
        if mode.mark_user {
            parent.user_modified = true;
        }
    }
    Ok(())
}

fn content_has_image_references(content: &CanvasContent) -> bool {
    matches!(content, CanvasContent::Block { block } if block.image_references().next().is_some())
}

fn content_has_artifact_references(content: &CanvasContent) -> bool {
    matches!(content, CanvasContent::Block { block } if block.artifact_references().next().is_some())
}

/// Validate and apply every operation on a copy. The copy is only committed when every
/// read and write target is ready; the caller decides.
fn simulate(base: &Session, request: &CanvasBatchRequest, mode: &Mode) -> Outcome {
    use CanvasTargetKind::{Annotation, Composition, Content, Presentation};
    let mut next = base.clone();
    let mut targets = Targets::default();
    let mut created = HashSet::new();
    let mut binding_writes = Vec::new();
    let mut image_reference_writes = Vec::new();
    let mut artifact_reference_writes = Vec::new();
    for read in &request.reads {
        let actual = next.board.canvas.revision_of(read.kind, &read.id);
        let outcome = if actual == Some(read.revision) {
            Ok(actual)
        } else {
            Err(Fail::conflict(actual, "依赖的版本已经变化，请重新读取。"))
        };
        targets.push(status(read.kind, &read.id, Some(read.revision), outcome));
    }
    for op in &request.operations {
        match op {
            CanvasOperation::Create {
                id,
                content,
                origin,
                placement,
                bindings,
            } => {
                if content_has_image_references(content) {
                    image_reference_writes.push((id.clone(), 0));
                }
                if content_has_artifact_references(content) {
                    artifact_reference_writes.push((id.clone(), 0));
                }
                match create(
                    base, &mut next, request, mode, &created, id, content, origin, placement,
                    bindings,
                ) {
                    Ok(()) => {
                        created.insert(id.clone());
                        if !bindings.is_empty() {
                            binding_writes.push((id.clone(), 0, true));
                        }
                        targets.push(status(Content, id, Some(0), Ok(Some(1))));
                        targets.push(status(Presentation, id, Some(0), Ok(Some(1))));
                    }
                    Err((kind, fail)) => {
                        targets.push(status(kind, id, Some(0), Err(fail)));
                        if kind == Presentation {
                            targets.push(status(Content, id, Some(0), Ok(None)));
                        } else {
                            targets.push(status(
                                Presentation,
                                id,
                                Some(0),
                                Err(Fail::invalid("内容创建未通过，呈现也不会写入。")),
                            ));
                        }
                    }
                }
            }
            CanvasOperation::PatchContent {
                id,
                expected_revision,
                fields,
            } => targets.push(status(
                Content,
                id,
                Some(*expected_revision),
                patch_content(&mut next, mode, id, *expected_revision, fields).map(Some),
            )),
            CanvasOperation::PatchReply {
                id,
                expected_revision,
                block,
            } => {
                if block.image_references().next().is_some() {
                    image_reference_writes.push((id.clone(), *expected_revision));
                }
                if block.artifact_references().next().is_some() {
                    artifact_reference_writes.push((id.clone(), *expected_revision));
                }
                targets.push(status(
                    Content,
                    id,
                    Some(*expected_revision),
                    patch_reply(&mut next, mode, id, *expected_revision, block).map(Some),
                ));
            }
            CanvasOperation::PatchBlock {
                id,
                expected_revision,
                block,
            } => {
                if block.image_references().next().is_some() {
                    image_reference_writes.push((id.clone(), *expected_revision));
                }
                if block.artifact_references().next().is_some() {
                    artifact_reference_writes.push((id.clone(), *expected_revision));
                }
                targets.push(status(
                    Content,
                    id,
                    Some(*expected_revision),
                    patch_block(&mut next, mode, id, *expected_revision, block).map(Some),
                ));
            }
            CanvasOperation::Place {
                id,
                expected_revision,
                fields,
            } => targets.push(status(
                Presentation,
                id,
                Some(*expected_revision),
                place(&mut next, mode, id, *expected_revision, fields).map(Some),
            )),
            CanvasOperation::Bind {
                id,
                expected_revision,
                bindings,
            } => {
                let outcome = bind(
                    base,
                    &mut next,
                    request,
                    mode,
                    &created,
                    id,
                    *expected_revision,
                    bindings,
                )
                .map(Some);
                if outcome.is_ok() {
                    binding_writes.push((id.clone(), *expected_revision, false));
                }
                targets.push(status(Content, id, Some(*expected_revision), outcome));
            }
            CanvasOperation::Compose {
                id,
                expected_revision,
                title,
                description,
                arrangement,
                members,
            } => targets.push(status(
                Composition,
                id,
                Some(*expected_revision),
                compose(
                    &mut next,
                    mode,
                    id,
                    *expected_revision,
                    title,
                    description.as_deref(),
                    *arrangement,
                    members,
                )
                .map(Some),
            )),
            CanvasOperation::Arrange {
                id,
                expected_revision,
                expected_presentations,
            } => match arrangement_plan(
                &next,
                mode,
                id,
                *expected_revision,
                expected_presentations,
            ) {
                Ok((revision, placements)) => {
                    targets.push(status(
                        Composition,
                        id,
                        Some(*expected_revision),
                        Ok(Some(revision)),
                    ));
                    for placement in placements {
                        targets.push(status(
                            Presentation,
                            &placement.id,
                            Some(placement.expected_revision),
                            place(
                                &mut next,
                                mode,
                                &placement.id,
                                placement.expected_revision,
                                &placement.fields,
                            )
                            .map(Some),
                        ));
                    }
                }
                Err(fail) => {
                    targets.push(status(
                        Composition,
                        id,
                        Some(*expected_revision),
                        Err(fail.clone()),
                    ));
                    add_arrangement_error_targets(
                        &mut targets,
                        &next,
                        id,
                        expected_presentations,
                        &fail,
                    );
                }
            },
            CanvasOperation::Annotate {
                id,
                expected_revision,
                anchor,
                text,
            } => targets.push(status(
                Annotation,
                id,
                Some(*expected_revision),
                annotate(
                    &mut next,
                    mode,
                    id,
                    *expected_revision,
                    anchor,
                    text,
                )
                .map(Some),
            )),
            CanvasOperation::RemoveAnnotation {
                id,
                expected_revision,
                removed,
            } => targets.push(status(
                Annotation,
                id,
                Some(*expected_revision),
                remove_annotation(&mut next, mode, id, *expected_revision, *removed).map(Some),
            )),
            CanvasOperation::Ungroup {
                id,
                expected_revision,
            } => {
                if let Some(parent) = next.board.canvas.parent_of(id) {
                    let declared = request
                        .reads
                        .iter()
                        .find(|read| read.kind == Composition && read.id == parent.id);
                    let guard = if declared.is_some_and(|read| read.revision == parent.revision) {
                        Ok(Some(parent.revision))
                    } else {
                        Err(Fail::conflict(
                            Some(parent.revision),
                            "解组也会更新父组，请声明父组的当前版本依赖。",
                        ))
                    };
                    targets.push(status(
                        Composition,
                        &parent.id,
                        declared.map(|read| read.revision),
                        guard,
                    ));
                }
                targets.push(status(
                    Composition,
                    id,
                    Some(*expected_revision),
                    ungroup(&mut next, mode, id, *expected_revision).map(|()| None),
                ));
            }
        }
    }
    if !binding_writes.is_empty() {
        if let Err(fail) = validate_binding_graph(&next.board.canvas) {
            for (id, expected, created) in binding_writes {
                targets.push(status(Content, &id, Some(expected), Err(fail.clone())));
                if created {
                    targets.push(status(
                        Presentation,
                        &id,
                        Some(0),
                        Err(Fail::invalid("内容创建未通过，呈现也不会写入。")),
                    ));
                }
            }
        }
    }
    if let Err(error) = validate_image_references(base, &next) {
        let message = error.to_string();
        for (id, expected) in image_reference_writes {
            targets.push(status(
                Content,
                &id,
                Some(expected),
                Err(Fail::invalid(message.clone())),
            ));
        }
    }
    if let Err(error) = validate_artifact_references(base, &next) {
        let message = error.to_string();
        for (id, expected) in artifact_reference_writes {
            targets.push(status(
                Content,
                &id,
                Some(expected),
                Err(Fail::invalid(message.clone())),
            ));
        }
    }
    Outcome {
        next,
        targets: targets.0,
    }
}

impl crate::CanvasLayout {
    pub(crate) fn record_proposal(&mut self, proposal: CanvasProposal) {
        if let Some(existing) = self
            .proposals
            .iter_mut()
            .find(|p| p.request.request_id == proposal.request.request_id)
        {
            *existing = proposal;
        } else {
            self.proposals.push(proposal);
        }
        // ponytail: keep session receipts for stable retries; compact terminal payloads if storage becomes material.
    }
}

impl Session {
    /// `source_id`: `None` is the user, `Some` an agent that may only write what it owns.
    /// Nothing is written unless every read dependency and write target is ready; the request
    /// and its per-target result are kept as a proposal either way. Repeating the exact same
    /// request under the same source returns the stored result.
    pub fn apply_canvas_batch(
        &mut self,
        request: CanvasBatchRequest,
        source_id: Option<&str>,
    ) -> Result<CanvasBatchResult, SpellcastError> {
        validate_request(&request)?;
        if let Some(existing) = self.board.canvas.proposal(&request.request_id) {
            if existing.source_id.as_deref() == source_id && existing.request == request {
                return Ok(existing.result.clone());
            }
            return Err(SpellcastError::user(
                "这个 request_id 已用于另一个不同的请求；请换一个 request_id。",
            ));
        }
        self.sync_canvas();
        if let Some(owner) = source_id {
            check_ownership(self, &request, owner)?;
        }
        let mode = Mode {
            owner: source_id,
            agent: source_id.is_some(),
            mark_user: source_id.is_none(),
        };
        let outcome = simulate(self, &request, &mode);
        Ok(self.settle(request, source_id.map(String::from), outcome))
    }

    fn settle(
        &mut self,
        request: CanvasBatchRequest,
        source_id: Option<String>,
        outcome: Outcome,
    ) -> CanvasBatchResult {
        let applied = outcome.all_ready();
        let result = CanvasBatchResult {
            request_id: request.request_id.clone(),
            status: if applied {
                CanvasBatchStatus::Applied
            } else {
                CanvasBatchStatus::Proposed
            },
            targets: outcome.targets,
        };
        if applied {
            let mut next = outcome.next;
            next.board.canvas.revision += 1;
            self.board = next.board;
        }
        self.board.canvas.record_proposal(CanvasProposal {
            request,
            source_id,
            result: result.clone(),
        });
        result
    }

    pub fn dismiss_canvas_proposal(
        &mut self,
        request_id: &str,
    ) -> Result<CanvasBatchResult, SpellcastError> {
        let proposal = self
            .board
            .canvas
            .proposals
            .iter_mut()
            .find(|p| p.request.request_id == request_id)
            .ok_or_else(|| SpellcastError::user("提案不存在。"))?;
        match proposal.result.status {
            CanvasBatchStatus::Applied => Err(SpellcastError::user("已经应用的请求不能放弃。")),
            CanvasBatchStatus::Proposed | CanvasBatchStatus::Dismissed => {
                proposal.result.status = CanvasBatchStatus::Dismissed;
                Ok(proposal.result.clone())
            }
        }
    }

    /// User-only. `current` must name the live version of every read dependency and every
    /// existing write target; any missing or changed entry refuses to write. Protection marks
    /// are overridden but kept. A create whose id now exists never becomes an overwrite.
    pub fn apply_canvas_proposal(
        &mut self,
        request_id: &str,
        current: Vec<CanvasRead>,
    ) -> Result<CanvasBatchResult, SpellcastError> {
        let proposal = self
            .board
            .canvas
            .proposal(request_id)
            .cloned()
            .ok_or_else(|| SpellcastError::user("提案不存在。"))?;
        match proposal.result.status {
            CanvasBatchStatus::Applied => return Ok(proposal.result),
            CanvasBatchStatus::Dismissed => {
                return Err(SpellcastError::user("提案已经放弃，请让 Agent 重新提出。"))
            }
            CanvasBatchStatus::Proposed => {}
        }
        self.sync_canvas();
        let canvas = &self.board.canvas;
        let mut request = proposal.request.clone();
        let mut required: Vec<(CanvasTargetKind, String)> = Vec::new();
        let mut parent_reads = Vec::new();
        let mut composed_revisions = BTreeMap::new();
        for read in &mut request.reads {
            if let Some(live) = canvas.revision_of(read.kind, &read.id) {
                read.revision = live;
                required.push((read.kind, read.id.clone()));
            }
        }
        for op in &mut request.operations {
            if let CanvasOperation::Ungroup { id, .. } = op {
                if let Some(parent) = canvas.parent_of(id) {
                    required.push((CanvasTargetKind::Composition, parent.id.clone()));
                    if !request.reads.iter().any(|read| {
                        read.kind == CanvasTargetKind::Composition && read.id == parent.id
                    }) {
                        parent_reads.push(CanvasRead {
                            kind: CanvasTargetKind::Composition,
                            id: parent.id.clone(),
                            revision: parent.revision,
                        });
                    }
                }
            }
            let (kind, id, expected, keep_zero) = match op {
                CanvasOperation::Create { id, .. } => {
                    check(
                        canvas.object(id).is_none()
                            && canvas.composition(id).is_none()
                            && canvas.annotation(id).is_none(),
                        "提案要创建的对象已经存在，不能改为覆盖。",
                    )?;
                    continue;
                }
                CanvasOperation::Annotate {
                    id,
                    expected_revision,
                    ..
                } => {
                    if *expected_revision == 0 {
                        check(
                            canvas.annotation(id).is_none(),
                            "提案要创建的注释已经存在，不能改为覆盖。",
                        )?;
                    } else if let Some(live) = canvas.revision_of(CanvasTargetKind::Annotation, id) {
                        required.push((CanvasTargetKind::Annotation, id.clone()));
                        *expected_revision = live;
                    } else {
                        return Err(SpellcastError::user("提案要修改的注释已经不存在。"));
                    }
                    continue;
                }
                CanvasOperation::Compose {
                    id,
                    expected_revision,
                    title,
                    description,
                    arrangement,
                    members,
                } => {
                    if let Some(live) = canvas.revision_of(CanvasTargetKind::Composition, id) {
                        required.push((CanvasTargetKind::Composition, id.clone()));
                        if *expected_revision != 0 {
                            *expected_revision = live;
                        }
                    }
                    composed_revisions.insert(
                        id.clone(),
                        composition_revision_after_compose(
                            canvas,
                            id,
                            title,
                            description.as_deref(),
                            *arrangement,
                            members,
                        ),
                    );
                    continue;
                }
                CanvasOperation::Arrange {
                    id,
                    expected_revision,
                    expected_presentations,
                } => {
                    if let Some(post_compose_revision) = composed_revisions.get(id) {
                        *expected_revision = *post_compose_revision;
                    } else if let Some(live) =
                        canvas.revision_of(CanvasTargetKind::Composition, id)
                    {
                        required.push((CanvasTargetKind::Composition, id.clone()));
                        *expected_revision = live;
                    }
                    for (member_id, expected_presentation) in expected_presentations {
                        if let Some(live) =
                            canvas.revision_of(CanvasTargetKind::Presentation, member_id)
                        {
                            required.push((CanvasTargetKind::Presentation, member_id.clone()));
                            *expected_presentation = live;
                        }
                    }
                    continue;
                }
                CanvasOperation::PatchContent {
                    id,
                    expected_revision,
                    ..
                }
                | CanvasOperation::PatchReply {
                    id,
                    expected_revision,
                    ..
                }
                | CanvasOperation::PatchBlock {
                    id,
                    expected_revision,
                    ..
                }
                | CanvasOperation::Bind {
                    id,
                    expected_revision,
                    ..
                } => (CanvasTargetKind::Content, id, expected_revision, false),
                CanvasOperation::Place {
                    id,
                    expected_revision,
                    ..
                } => (CanvasTargetKind::Presentation, id, expected_revision, false),
                CanvasOperation::RemoveAnnotation {
                    id,
                    expected_revision,
                    ..
                } => (CanvasTargetKind::Annotation, id, expected_revision, false),
                CanvasOperation::Ungroup {
                    id,
                    expected_revision,
                } => (CanvasTargetKind::Composition, id, expected_revision, false),
            };
            if let Some(live) = canvas.revision_of(kind, id) {
                required.push((kind, id.clone()));
                if !(keep_zero && *expected == 0) {
                    *expected = live;
                }
            }
        }
        request.reads.extend(parent_reads);
        for (kind, id) in &required {
            let live = canvas.revision_of(*kind, id);
            let declared: Vec<u64> = current
                .iter()
                .filter(|c| c.kind == *kind && &c.id == id)
                .map(|c| c.revision)
                .collect();
            match declared.as_slice() {
                [revision] if Some(*revision) == live => {}
                [] => {
                    return Err(SpellcastError::user(format!(
                        "缺少 {id} 的当前版本声明，无法应用提案。"
                    )))
                }
                _ => {
                    return Err(SpellcastError::user(format!(
                        "{id} 的版本已经变化，请重新读取后再应用。"
                    )))
                }
            }
        }
        let mode = Mode {
            owner: proposal.source_id.as_deref(),
            agent: false,
            mark_user: false,
        };
        let outcome = simulate(self, &request, &mode);
        let applied = outcome.all_ready();
        let result = CanvasBatchResult {
            request_id: request_id.to_string(),
            status: if applied {
                CanvasBatchStatus::Applied
            } else {
                CanvasBatchStatus::Proposed
            },
            targets: outcome.targets,
        };
        if applied {
            let mut next = outcome.next;
            next.board.canvas.revision += 1;
            self.board = next.board;
        }
        // The original request stays as the idempotency key; only the result moves on.
        self.board.canvas.record_proposal(CanvasProposal {
            request: proposal.request,
            source_id: proposal.source_id,
            result: result.clone(),
        });
        Ok(result)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        validate_fill, validate_image_src, CanvasPatch, CanvasShape, NodeDraft, ReplyGraphEdge,
        ReplyGraphNode, ReplyImageReference, ReplyOption, ReplyRequest, ReplyStep,
        MAX_IMAGE_DATA_BYTES,
    };

    const AGENT: Option<&str> = Some("codex:one");

    #[test]
    fn idea_metadata_order_and_user_edits_survive_restart_and_agent_conflicts() {
        let mut session = Session::default();
        let setup = batch(
            "idea-setup",
            vec![
                text("one", "original one"),
                text("two", "original two"),
                compose("idea", 0, &["one", "two"]),
            ],
        );
        assert_eq!(
            session.apply_canvas_batch(setup, AGENT).unwrap().status,
            CanvasBatchStatus::Applied
        );
        let edit: CanvasOperation = serde_json::from_value(serde_json::json!({"op":"compose","id":"idea","expected_revision":1,"title":"一个完整想法","description":"两个组件表达同一个决定","members":["two","one"]})).unwrap();
        assert_eq!(
            session
                .apply_canvas_batch(batch("idea-user", vec![edit]), None)
                .unwrap()
                .status,
            CanvasBatchStatus::Applied
        );
        let saved = serde_json::to_string(&session).unwrap();
        let mut restored: Session = serde_json::from_str(&saved).unwrap();
        let group = restored.board.canvas.composition("idea").unwrap();
        assert_eq!(group.description, "两个组件表达同一个决定");
        assert_eq!(group.members, ["two", "one"]);
        assert!(group.user_modified);
        let before = restored.board.canvas.compositions.clone();
        let result = restored
            .apply_canvas_batch(
                batch(
                    "idea-agent-overwrite",
                    vec![
                        compose("idea", 2, &["one", "two"]),
                        patch_text("one", 1, "must not leak"),
                    ],
                ),
                AGENT,
            )
            .unwrap();
        assert_eq!(result.status, CanvasBatchStatus::Proposed);
        assert_eq!(restored.board.canvas.compositions, before);
        assert_eq!(
            restored.board.canvas.object("one").unwrap().content,
            CanvasContent::Text {
                title: String::new(),
                text: "original one".into()
            }
        );
        let omit_description = compose("idea", 2, &["two", "one"]);
        assert_eq!(
            restored
                .apply_canvas_batch(batch("idea-old-client", vec![omit_description]), None)
                .unwrap()
                .status,
            CanvasBatchStatus::Applied
        );
        assert_eq!(
            restored
                .board
                .canvas
                .composition("idea")
                .unwrap()
                .description,
            "两个组件表达同一个决定"
        );
    }

    fn text(id: &str, body: &str) -> CanvasOperation {
        CanvasOperation::Create {
            origin: None,
            id: id.into(),
            content: CanvasContent::Text {
                title: String::new(),
                text: body.into(),
            },
            placement: CanvasPlacementFields::default(),
            bindings: vec![],
        }
    }

    fn text_at(
        id: &str,
        body: &str,
        x: f64,
        y: f64,
        width: f64,
        height: f64,
        z: i32,
        appearance: CanvasAppearance,
    ) -> CanvasOperation {
        CanvasOperation::Create {
            origin: None,
            id: id.into(),
            content: CanvasContent::Text {
                title: String::new(),
                text: body.into(),
            },
            placement: CanvasPlacementFields {
                x: Some(x),
                y: Some(y),
                width: Some(width),
                height: Some(height),
                z: Some(z),
                appearance: Some(appearance),
                ..Default::default()
            },
            bindings: vec![],
        }
    }

    fn batch(request_id: &str, operations: Vec<CanvasOperation>) -> CanvasBatchRequest {
        CanvasBatchRequest {
            request_id: request_id.into(),
            reads: vec![],
            operations,
            feedback_sequences: vec![],
        }
    }

    fn read(kind: CanvasTargetKind, id: &str, revision: u64) -> CanvasRead {
        CanvasRead {
            kind,
            id: id.into(),
            revision,
        }
    }

    fn place(id: &str, expected: u64, x: f64) -> CanvasOperation {
        CanvasOperation::Place {
            id: id.into(),
            expected_revision: expected,
            fields: CanvasPlacementFields {
                x: Some(x),
                ..Default::default()
            },
        }
    }

    fn patch_text(id: &str, expected: u64, body: &str) -> CanvasOperation {
        CanvasOperation::PatchContent {
            id: id.into(),
            expected_revision: expected,
            fields: CanvasContentFields {
                text: Some(body.into()),
                ..Default::default()
            },
        }
    }

    fn compose(id: &str, expected: u64, members: &[&str]) -> CanvasOperation {
        compose_with_arrangement(id, expected, members, None)
    }

    fn compose_with_arrangement(
        id: &str,
        expected: u64,
        members: &[&str],
        arrangement: Option<CanvasArrangement>,
    ) -> CanvasOperation {
        CanvasOperation::Compose {
            id: id.into(),
            expected_revision: expected,
            title: String::new(),
            description: None,
            arrangement,
            members: members.iter().map(|m| m.to_string()).collect(),
        }
    }

    fn arrange(
        id: &str,
        expected_revision: u64,
        expected_presentations: &[(&str, u64)],
    ) -> CanvasOperation {
        CanvasOperation::Arrange {
            id: id.into(),
            expected_revision,
            expected_presentations: expected_presentations
                .iter()
                .map(|(id, revision)| ((*id).to_string(), *revision))
                .collect(),
        }
    }

    fn binding(
        from: &str,
        from_block: &str,
        from_port: &str,
        to_block: Option<&str>,
        to_port: &str,
    ) -> CanvasBinding {
        CanvasBinding {
            from: crate::CanvasOutputRef {
                object_id: from.into(),
                block_id: from_block.into(),
                port: from_port.into(),
            },
            to: crate::CanvasInputRef {
                block_id: to_block.map(String::from),
                port: to_port.into(),
            },
        }
    }

    fn bind(id: &str, expected_revision: u64, bindings: Vec<CanvasBinding>) -> CanvasOperation {
        CanvasOperation::Bind {
            id: id.into(),
            expected_revision,
            bindings,
        }
    }

    fn artifact_reply(
        session: &mut Session,
        reply_id: &str,
        owner: &str,
        block_id: &str,
    ) -> String {
        session
            .write_reply(ReplyRequest {
                id: Some(reply_id.into()),
                source_id: owner.into(),
                source_label: None,
                origin_node_id: None,
                title: reply_id.into(),
                blocks: vec![ReplyBlock::Artifact {
                    id: block_id.into(),
                    title: String::new(),
                    bundle_id: format!("bundle-{reply_id}"),
                    description: String::new(),
                    state: serde_json::json!({}),
                    state_revision: 0,
                    state_preview: None,
                }],
                expected_revision: None,
            })
            .unwrap();
        session.sync_canvas();
        session
            .board
            .canvas
            .object_for(&CanvasContent::Reply {
                id: reply_id.into(),
            })
            .unwrap()
            .id
            .clone()
    }

    fn statuses(result: &CanvasBatchResult) -> Vec<(CanvasTargetKind, &str, CanvasTargetState)> {
        result
            .targets
            .iter()
            .map(|t| (t.kind, t.id.as_str(), t.status))
            .collect()
    }

    #[test]
    fn user_content_accepts_proposals_and_old_receipts_never_resurrect_deleted_objects() {
        let mut session = Session::default();
        let initial = batch("user-created", vec![text("user-note", "用户自己的想法")]);
        session.apply_canvas_batch(initial.clone(), None).unwrap();
        let proposed = session
            .apply_canvas_batch(
                batch(
                    "agent-suggestion",
                    vec![patch_text("user-note", 1, "经用户审阅的建议")],
                ),
                AGENT,
            )
            .unwrap();
        assert!(proposed
            .targets
            .iter()
            .any(|target| target.status == CanvasTargetState::Protected));
        assert!(session
            .apply_canvas_proposal(
                "agent-suggestion",
                vec![read(CanvasTargetKind::Content, "user-note", 1)]
            )
            .unwrap()
            .is_applied());
        assert_eq!(
            session.board.canvas.object("user-note").unwrap().source_id,
            None
        );
        for index in 0..260 {
            let revision = session
                .board
                .canvas
                .placement("user-note")
                .unwrap()
                .revision;
            session
                .apply_canvas_batch(
                    batch(
                        &format!("move-{index}"),
                        vec![place("user-note", revision, 20.0)],
                    ),
                    None,
                )
                .unwrap();
        }
        assert!(session.board.canvas.proposals.len() > 256);
        session.delete_canvas_content("user-note", 2, &[]).unwrap();
        assert!(session
            .apply_canvas_batch(initial, None)
            .unwrap()
            .is_applied());
        assert!(session.board.canvas.object("user-note").is_none());
        let boundary = format!(
            "data:image/png;base64,{}AAA=",
            "A".repeat(MAX_IMAGE_DATA_BYTES / 3 * 4)
        );
        assert!(validate_image_src(&boundary).is_ok());
        for invalid in [
            "data:image/png;base64,A===",
            "data:image/png;base64,AA=A",
            "data:image/png;base64,AA",
        ] {
            assert!(validate_image_src(invalid).is_err());
        }
    }

    #[test]
    fn legacy_wire_form_is_unchanged_and_native_objects_persist_through_sync() {
        let legacy: CanvasContent =
            serde_json::from_value(serde_json::json!({"type": "node", "id": "n1"})).unwrap();
        assert_eq!(legacy, CanvasContent::Node { id: "n1".into() });
        assert_eq!(
            serde_json::to_value(&legacy).unwrap(),
            serde_json::json!({"type": "node", "id": "n1"})
        );

        let mut session = Session::default();
        let node = session.add_node(NodeDraft {
            title: "旧想法".into(),
            ..Default::default()
        });
        session.sync_canvas();
        let result = session
            .apply_canvas_batch(
                batch(
                    "r1",
                    vec![
                        text("t1", "原生文字"),
                        CanvasOperation::Create {
                            origin: None,
                            id: "s1".into(),
                            content: CanvasContent::Shape {
                                title: String::new(),
                                shape: CanvasShape::Ellipse,
                                fill: "#ABC".into(),
                                text: String::new(),
                            },
                            placement: CanvasPlacementFields {
                                x: Some(400.0),
                                y: Some(20.0),
                                ..Default::default()
                            },
                            bindings: vec![],
                        },
                        CanvasOperation::Create {
                            origin: None,
                            id: "i1".into(),
                            content: CanvasContent::Image {
                                title: String::new(),
                                src: "/artifacts/bundle-1/assets/a.png".into(),
                                alt: String::new(),
                            },
                            placement: CanvasPlacementFields::default(),
                            bindings: vec![],
                        },
                    ],
                ),
                AGENT,
            )
            .unwrap();
        assert!(result.is_applied());
        let object = session.board.canvas.object("t1").unwrap().clone();
        assert_eq!(object.source_id.as_deref(), AGENT);
        assert_eq!(
            serde_json::to_value(&object.content).unwrap(),
            serde_json::json!({"type": "text", "title": "", "text": "原生文字"})
        );
        let placement = session.board.canvas.placement("t1").unwrap();
        assert_eq!(placement.appearance, CanvasAppearance::Plain);
        assert!(!placement.overlaps(session.board.canvas.placement("i1").unwrap()));

        let mut reloaded: Session =
            serde_json::from_str(&serde_json::to_string(&session).unwrap()).unwrap();
        assert!(!reloaded.sync_canvas());
        assert_eq!(reloaded.board.canvas, session.board.canvas);
        reloaded.remove_node(&node.id).unwrap();
        assert!(reloaded.sync_canvas());
        assert_eq!(reloaded.board.canvas.objects.len(), 3);
        assert!(reloaded.board.canvas.object("t1").is_some());
        assert_eq!(reloaded.board.canvas.proposals[0].result, result);
    }

    #[test]
    fn create_rejects_legacy_references_and_unsafe_sources() {
        let mut session = Session::default();
        let bad_sources = [
            "javascript:alert(1)",
            "file:///etc/passwd",
            "data:text/html;base64,PGI+",
            "/artifacts/b/../../secret.png",
            "/artifacts/../x.png",
            "ftp://host/a.png",
        ];
        for (i, src) in bad_sources.iter().enumerate() {
            let result = session
                .apply_canvas_batch(
                    batch(
                        &format!("bad-{i}"),
                        vec![CanvasOperation::Create {
                            origin: None,
                            id: format!("img-{i}"),
                            content: CanvasContent::Image {
                                title: String::new(),
                                src: (*src).into(),
                                alt: String::new(),
                            },
                            placement: CanvasPlacementFields::default(),
                            bindings: vec![],
                        }],
                    ),
                    AGENT,
                )
                .unwrap();
            assert_eq!(result.status, CanvasBatchStatus::Proposed, "{src}");
            assert_eq!(
                result.targets[0].status,
                CanvasTargetState::Invalid,
                "{src}"
            );
        }
        let result = session
            .apply_canvas_batch(
                batch(
                    "legacy",
                    vec![CanvasOperation::Create {
                        origin: None,
                        id: "x".into(),
                        content: CanvasContent::Node { id: "n1".into() },
                        placement: CanvasPlacementFields::default(),
                        bindings: vec![],
                    }],
                ),
                AGENT,
            )
            .unwrap();
        assert_eq!(result.targets[0].status, CanvasTargetState::Invalid);
        assert!(session.board.canvas.objects.is_empty());
        assert!(validate_image_src("data:image/png;base64,iVBORw0KGgo=").is_ok());
        assert!(validate_image_src(&format!(
            "data:image/png;base64,{}",
            "A".repeat(MAX_IMAGE_DATA_BYTES / 3 * 4 + 4)
        ))
        .is_err());
        assert!(validate_fill("#12345g").is_err());
    }

    #[test]
    fn mixed_batch_is_atomic_and_reports_each_target() {
        let mut session = Session::default();
        session
            .apply_canvas_batch(batch("seed", vec![text("a", "A"), text("b", "B")]), AGENT)
            .unwrap();
        let before = session.board.canvas.clone();
        let result = session
            .apply_canvas_batch(
                batch(
                    "mixed",
                    vec![
                        text("c", "C"),
                        place("a", 1, 500.0),
                        patch_text("b", 7, "改"),
                    ],
                ),
                AGENT,
            )
            .unwrap();
        assert_eq!(result.status, CanvasBatchStatus::Proposed);
        assert_eq!(
            statuses(&result),
            vec![
                (CanvasTargetKind::Content, "c", CanvasTargetState::Ready),
                (
                    CanvasTargetKind::Presentation,
                    "c",
                    CanvasTargetState::Ready
                ),
                (
                    CanvasTargetKind::Presentation,
                    "a",
                    CanvasTargetState::Ready
                ),
                (CanvasTargetKind::Content, "b", CanvasTargetState::Conflict),
            ]
        );
        assert_eq!(
            (
                result.targets[3].expected_revision,
                result.targets[3].actual_revision
            ),
            (Some(7), Some(1))
        );
        let mut expected_layout = before.clone();
        expected_layout.proposals = session.board.canvas.proposals.clone();
        assert_eq!(session.board.canvas, expected_layout);
        assert!(session.board.canvas.object("c").is_none());
        assert_eq!(session.board.canvas.placement("a").unwrap().x, 48.0);
    }

    #[test]
    fn stale_reads_block_and_content_presentation_versions_stay_independent() {
        let mut session = Session::default();
        session
            .apply_canvas_batch(batch("seed", vec![text("a", "A"), text("b", "B")]), AGENT)
            .unwrap();
        session
            .apply_canvas_batch(batch("edit", vec![patch_text("a", 1, "A2")]), AGENT)
            .unwrap();
        assert_eq!(
            session.board.canvas.object("a").unwrap().content_revision,
            2
        );
        assert_eq!(session.board.canvas.placement("a").unwrap().revision, 1);
        let b_before = session.board.canvas.placement("b").unwrap().clone();

        let mut stale = batch("stale", vec![place("b", 1, 600.0)]);
        stale.reads = vec![read(CanvasTargetKind::Content, "a", 1)];
        let result = session.apply_canvas_batch(stale, AGENT).unwrap();
        assert_eq!(result.status, CanvasBatchStatus::Proposed);
        assert_eq!(result.targets[0].status, CanvasTargetState::Conflict);
        assert_eq!(result.targets[0].actual_revision, Some(2));
        assert_eq!(result.targets[1].status, CanvasTargetState::Ready);
        assert_eq!(session.board.canvas.placement("b").unwrap(), &b_before);

        let mut fresh = batch("fresh", vec![place("a", 1, 600.0)]);
        fresh.reads = vec![read(CanvasTargetKind::Content, "a", 2)];
        assert!(session
            .apply_canvas_batch(fresh, AGENT)
            .unwrap()
            .is_applied());
        assert_eq!(session.board.canvas.placement("a").unwrap().revision, 2);
        assert_eq!(
            session.board.canvas.object("a").unwrap().content_revision,
            2
        );
    }

    #[test]
    fn batch_place_can_set_content_scale_and_rejects_out_of_range_values_atomically() {
        let mut session = Session::default();
        let created = session
            .apply_canvas_batch(
                batch(
                    "scaled-create",
                    vec![CanvasOperation::Create {
                        id: "scaled".into(),
                        content: CanvasContent::Text {
                            title: String::new(),
                            text: "Scaled".into(),
                        },
                        origin: None,
                        placement: CanvasPlacementFields {
                            content_scale: Some(1.5),
                            ..Default::default()
                        },
                        bindings: vec![],
                    }],
                ),
                AGENT,
            )
            .unwrap();
        assert!(created.is_applied(), "{:?}", created.targets);
        assert_eq!(
            session.board.canvas.placement("scaled").unwrap().content_scale,
            1.5
        );

        let moved = session
            .apply_canvas_batch(batch("scaled-move", vec![place("scaled", 1, 600.0)]), AGENT)
            .unwrap();
        assert!(moved.is_applied(), "{:?}", moved.targets);
        let placement = session.board.canvas.placement("scaled").unwrap();
        assert_eq!((placement.x, placement.content_scale), (600.0, 1.5));

        let resized = session
            .apply_canvas_batch(
                batch(
                    "scaled-update",
                    vec![CanvasOperation::Place {
                        id: "scaled".into(),
                        expected_revision: 2,
                        fields: CanvasPlacementFields {
                            content_scale: Some(2.25),
                            ..Default::default()
                        },
                    }],
                ),
                AGENT,
            )
            .unwrap();
        assert!(resized.is_applied(), "{:?}", resized.targets);
        assert_eq!(
            session.board.canvas.placement("scaled").unwrap().content_scale,
            2.25
        );

        for (request_id, invalid) in [
            ("scale-zero", 0.0),
            ("scale-small", 0.009),
            ("scale-large", 100.01),
        ] {
            let before = session.board.canvas.placement("scaled").unwrap().clone();
            let rejected = session
                .apply_canvas_batch(
                    batch(
                        request_id,
                        vec![CanvasOperation::Place {
                            id: "scaled".into(),
                            expected_revision: before.revision,
                            fields: CanvasPlacementFields {
                                content_scale: Some(invalid),
                                ..Default::default()
                            },
                        }],
                    ),
                    AGENT,
                )
                .unwrap();
            assert_eq!(rejected.status, CanvasBatchStatus::Proposed);
            assert!(rejected.targets.iter().any(|target| {
                target.kind == CanvasTargetKind::Presentation
                    && target.status == CanvasTargetState::Invalid
            }));
            assert_eq!(session.board.canvas.placement("scaled").unwrap(), &before);
        }
    }

    #[test]
    fn user_edits_protect_against_agents_until_the_user_applies_the_proposal() {
        let mut session = Session::default();
        session
            .apply_canvas_batch(batch("seed", vec![text("a", "A")]), AGENT)
            .unwrap();
        assert!(session
            .apply_canvas_batch(batch("user-edit", vec![patch_text("a", 1, "用户改")]), None)
            .unwrap()
            .is_applied());
        let object = session.board.canvas.object("a").unwrap().clone();
        assert!(object.user_edited && object.content_revision == 2);
        let mut item = session.board.canvas.placement("a").unwrap().clone();
        item.x = 300.0;
        session
            .patch_canvas(CanvasPatch {
                expected_revision: None,
                items: vec![item],
            })
            .unwrap();
        let item = session.board.canvas.placement("a").unwrap().clone();
        assert!(item.user_modified && item.revision == 2);

        let result = session
            .apply_canvas_batch(
                batch(
                    "agent",
                    vec![patch_text("a", 2, "Agent 改"), place("a", 2, 900.0)],
                ),
                AGENT,
            )
            .unwrap();
        assert_eq!(result.status, CanvasBatchStatus::Proposed);
        assert!(result
            .targets
            .iter()
            .all(|t| t.status == CanvasTargetState::Protected));
        assert_eq!(
            session.board.canvas.object("a").unwrap().content,
            CanvasContent::Text {
                title: String::new(),
                text: "用户改".into()
            }
        );

        assert!(session
            .apply_canvas_proposal("agent", vec![read(CanvasTargetKind::Content, "a", 2)])
            .is_err());
        let applied = session
            .apply_canvas_proposal(
                "agent",
                vec![
                    read(CanvasTargetKind::Content, "a", 2),
                    read(CanvasTargetKind::Presentation, "a", 2),
                ],
            )
            .unwrap();
        assert!(applied.is_applied());
        let object = session.board.canvas.object("a").unwrap();
        assert_eq!(
            object.content,
            CanvasContent::Text {
                title: String::new(),
                text: "Agent 改".into()
            }
        );
        assert!(object.user_edited && object.content_revision == 3);
        let item = session.board.canvas.placement("a").unwrap();
        assert!(item.user_modified && item.x == 900.0 && item.revision == 3);
        assert_eq!(
            session
                .board
                .canvas
                .proposal("agent")
                .unwrap()
                .result
                .status,
            CanvasBatchStatus::Applied
        );
        assert!(session
            .apply_canvas_proposal("agent", vec![])
            .unwrap()
            .is_applied());

        // The agent still holds the versions it saw before the user applied; it may not race past.
        let racing = session
            .apply_canvas_batch(batch("race", vec![patch_text("a", 2, "再改")]), AGENT)
            .unwrap();
        assert_eq!(racing.targets[0].status, CanvasTargetState::Conflict);
        let stale = session
            .apply_canvas_batch(batch("late", vec![patch_text("a", 3, "再改")]), AGENT)
            .unwrap();
        assert_eq!(stale.targets[0].status, CanvasTargetState::Protected);
    }

    #[test]
    fn repeated_requests_are_idempotent_and_changed_payloads_are_rejected() {
        let mut session = Session::default();
        let request = batch("same", vec![text("a", "A")]);
        let first = session.apply_canvas_batch(request.clone(), AGENT).unwrap();
        let second = session.apply_canvas_batch(request.clone(), AGENT).unwrap();
        assert_eq!(first, second);
        assert_eq!(session.board.canvas.objects.len(), 1);
        assert_eq!(session.board.canvas.proposals.len(), 1);
        let mut changed = request.clone();
        changed.feedback_sequences = vec![3];
        assert!(session.apply_canvas_batch(changed, AGENT).is_err());
        assert!(session
            .apply_canvas_batch(request.clone(), Some("cursor:two"))
            .is_err());
        assert!(session
            .apply_canvas_batch(
                batch("dup", vec![place("a", 1, 1.0), place("a", 1, 2.0)]),
                AGENT
            )
            .is_err());
        assert!(session.board.canvas.proposal("dup").is_none());
        assert!(session
            .apply_canvas_batch(batch("empty", vec![]), AGENT)
            .is_err());
        assert!(session
            .apply_canvas_batch(
                batch("foreign", vec![place("a", 1, 1.0)]),
                Some("cursor:two")
            )
            .is_err());
        assert!(session
            .apply_canvas_batch(batch("foreign", vec![place("a", 1, 1.0)]), None)
            .unwrap()
            .is_applied());
        assert!(session
            .apply_canvas_batch(batch("foreign", vec![place("a", 1, 1.0)]), AGENT)
            .is_err());
    }

    #[test]
    fn compositions_reject_cycles_ungroup_lifts_members_and_deletion_purges_them() {
        let mut session = Session::default();
        session
            .apply_canvas_batch(
                batch("seed", vec![text("a", "A"), text("b", "B"), text("c", "C")]),
                AGENT,
            )
            .unwrap();
        let result = session
            .apply_canvas_batch(
                batch(
                    "groups",
                    vec![
                        compose("inner", 0, &["a", "b"]),
                        compose("outer", 0, &["inner", "c"]),
                    ],
                ),
                AGENT,
            )
            .unwrap();
        assert!(result.is_applied(), "{:?}", result.targets);
        for (label, ops) in [
            ("cycle", vec![compose("inner", 1, &["a", "outer"])]),
            ("self", vec![compose("inner", 1, &["inner"])]),
            ("two-parents", vec![compose("other", 0, &["a"])]),
            ("unknown", vec![compose("other", 0, &["zzz"])]),
            ("dup", vec![compose("other", 0, &["c", "c"])]),
        ] {
            let result = session
                .apply_canvas_batch(batch(label, ops), AGENT)
                .unwrap();
            assert_eq!(result.status, CanvasBatchStatus::Proposed, "{label}");
            assert_eq!(
                result.targets[0].status,
                CanvasTargetState::Invalid,
                "{label}"
            );
        }
        assert_eq!(session.board.canvas.compositions.len(), 2);

        // Hiding keeps membership; deleting the content removes it from its composition.
        session.set_canvas_removed("a", 1, true).unwrap();
        assert_eq!(
            session.board.canvas.composition("inner").unwrap().members,
            vec!["a", "b"]
        );
        assert!(session.delete_canvas_content("a", 1, &[]).is_err());
        session
            .delete_canvas_content(
                "a",
                1,
                &[
                    read(CanvasTargetKind::Composition, "inner", 1),
                    read(CanvasTargetKind::Composition, "outer", 1),
                ],
            )
            .unwrap();
        let inner = session.board.canvas.composition("inner").unwrap().clone();
        assert_eq!(
            (inner.members.clone(), inner.revision),
            (vec!["b".to_string()], 2)
        );
        assert_eq!(
            session.board.canvas.composition("outer").unwrap().revision,
            1
        );

        let before = session.board.canvas.compositions.clone();
        let missing_parent = session
            .apply_canvas_batch(
                batch(
                    "ungroup-missing-parent",
                    vec![CanvasOperation::Ungroup {
                        id: "inner".into(),
                        expected_revision: 2,
                    }],
                ),
                AGENT,
            )
            .unwrap();
        assert_eq!(missing_parent.status, CanvasBatchStatus::Proposed);
        assert_eq!(session.board.canvas.compositions, before);
        let mut ungroup_request = batch(
            "ungroup",
            vec![CanvasOperation::Ungroup {
                id: "inner".into(),
                expected_revision: 2,
            }],
        );
        ungroup_request
            .reads
            .push(read(CanvasTargetKind::Composition, "outer", 1));
        let result = session.apply_canvas_batch(ungroup_request, AGENT).unwrap();
        assert!(result.is_applied());
        let outer = session.board.canvas.composition("outer").unwrap();
        assert_eq!(
            (outer.members.clone(), outer.revision),
            (vec!["b".to_string(), "c".to_string()], 2)
        );
        assert!(session.board.canvas.composition("inner").is_none());
        assert_eq!(session.board.canvas.parent_of("b").unwrap().id, "outer");
        let outer_revision = session.board.canvas.composition("outer").unwrap().revision;
        session
            .delete_canvas_content(
                "b",
                1,
                &[read(CanvasTargetKind::Composition, "outer", outer_revision)],
            )
            .unwrap();
        let outer_revision = session.board.canvas.composition("outer").unwrap().revision;
        session
            .delete_canvas_content(
                "c",
                1,
                &[read(CanvasTargetKind::Composition, "outer", outer_revision)],
            )
            .unwrap();
        assert!(session.board.canvas.compositions.is_empty());
    }

    #[test]
    fn proposals_cannot_turn_creates_into_overwrites_and_dismissal_is_a_receipt() {
        let mut session = Session::default();
        let result = session
            .apply_canvas_batch(
                batch("p", vec![text("a", "A"), patch_text("missing", 1, "x")]),
                AGENT,
            )
            .unwrap();
        assert_eq!(result.status, CanvasBatchStatus::Proposed);
        session
            .apply_canvas_batch(batch("other", vec![text("a", "别人的 A")]), None)
            .unwrap();
        assert!(session.apply_canvas_proposal("p", vec![]).is_err());
        assert_eq!(
            session.board.canvas.object("a").unwrap().content,
            CanvasContent::Text {
                title: String::new(),
                text: "别人的 A".into()
            }
        );
        let dismissed = session.dismiss_canvas_proposal("p").unwrap();
        assert_eq!(dismissed.status, CanvasBatchStatus::Dismissed);
        assert!(session.apply_canvas_proposal("p", vec![]).is_err());
        assert!(session.dismiss_canvas_proposal("other").is_err());
        assert_eq!(
            session
                .apply_canvas_batch(
                    batch("p", vec![text("a", "A"), patch_text("missing", 1, "x")]),
                    AGENT
                )
                .unwrap(),
            dismissed
        );
        assert!(session.dismiss_canvas_proposal("nope").is_err());
    }

    #[test]
    fn legacy_content_takes_field_patches_and_block_patches_only() {
        let mut session = Session::default();
        let node = session.add_node(NodeDraft {
            title: "想法".into(),
            source_id: AGENT.map(String::from),
            ..Default::default()
        });
        let reply = session
            .write_reply(ReplyRequest {
                id: Some("reply-1".into()),
                source_id: "codex:one".into(),
                source_label: None,
                origin_node_id: None,
                title: "回复".into(),
                blocks: vec![ReplyBlock::Comparison {
                    id: "cmp".into(),
                    title: String::new(),
                    criteria: vec!["成本".into()],
                    options: vec![
                        ReplyOption {
                            id: "x".into(),
                            title: "X".into(),
                            summary: String::new(),
                            values: vec!["低".into()],
                            image: None,
                            artifact: None,
                        },
                        ReplyOption {
                            id: "y".into(),
                            title: "Y".into(),
                            summary: String::new(),
                            values: vec!["高".into()],
                            image: None,
                            artifact: None,
                        },
                    ],
                    selected_id: Some("y".into()),
                }],
                expected_revision: None,
            })
            .unwrap();
        session.sync_canvas();
        let node_object = session
            .board
            .canvas
            .object_for(&CanvasContent::Node {
                id: node.id.clone(),
            })
            .unwrap()
            .clone();
        let reply_object = session
            .board
            .canvas
            .object_for(&CanvasContent::Reply {
                id: reply.id.clone(),
            })
            .unwrap()
            .clone();
        assert_eq!(reply_object.source_id.as_deref(), AGENT);

        let result = session
            .apply_canvas_batch(
                batch(
                    "fields",
                    vec![
                        CanvasOperation::PatchContent {
                            id: node_object.id.clone(),
                            expected_revision: node_object.content_revision,
                            fields: CanvasContentFields {
                                title: Some("新标题".into()),
                                text: Some("正文".into()),
                                ..Default::default()
                            },
                        },
                        CanvasOperation::PatchContent {
                            id: reply_object.id.clone(),
                            expected_revision: reply_object.content_revision,
                            fields: CanvasContentFields {
                                text: Some("整段替换".into()),
                                ..Default::default()
                            },
                        },
                    ],
                ),
                AGENT,
            )
            .unwrap();
        assert_eq!(result.status, CanvasBatchStatus::Proposed);
        assert_eq!(result.targets[1].status, CanvasTargetState::Invalid);
        assert_eq!(session.board.nodes[0].title, "想法");

        let mut block = reply.blocks[0].clone();
        if let ReplyBlock::Comparison {
            options,
            selected_id,
            ..
        } = &mut block
        {
            options[0].title = "X 改".into();
            *selected_id = None;
        }
        let result = session
            .apply_canvas_batch(
                batch(
                    "blocks",
                    vec![
                        CanvasOperation::PatchContent {
                            id: node_object.id.clone(),
                            expected_revision: node_object.content_revision,
                            fields: CanvasContentFields {
                                title: Some("新标题".into()),
                                text: Some("正文".into()),
                                ..Default::default()
                            },
                        },
                        CanvasOperation::PatchContent {
                            id: reply_object.id.clone(),
                            expected_revision: reply_object.content_revision,
                            fields: CanvasContentFields {
                                title: Some("新回复标题".into()),
                                ..Default::default()
                            },
                        },
                    ],
                ),
                AGENT,
            )
            .unwrap();
        assert!(result.is_applied(), "{:?}", result.targets);
        assert_eq!(
            (
                session.board.nodes[0].title.as_str(),
                session.board.nodes[0].body.as_str()
            ),
            ("新标题", "正文")
        );
        assert_eq!(
            session
                .board
                .canvas
                .object(&node_object.id)
                .unwrap()
                .content_revision,
            session.board.nodes[0].revision
        );
        let reply_revision = session.board.replies[0].revision;
        assert_eq!(
            session
                .board
                .canvas
                .object(&reply_object.id)
                .unwrap()
                .content_revision,
            reply_revision
        );

        let result = session
            .apply_canvas_batch(
                batch(
                    "block",
                    vec![CanvasOperation::PatchReply {
                        id: reply_object.id.clone(),
                        expected_revision: reply_revision,
                        block,
                    }],
                ),
                AGENT,
            )
            .unwrap();
        assert!(result.is_applied(), "{:?}", result.targets);
        let ReplyBlock::Comparison {
            options,
            selected_id,
            ..
        } = &session.board.replies[0].blocks[0]
        else {
            panic!()
        };
        assert_eq!(
            (options[0].title.as_str(), selected_id.as_deref()),
            ("X 改", Some("y"))
        );
        assert_eq!(
            session
                .board
                .canvas
                .object(&reply_object.id)
                .unwrap()
                .content_revision,
            reply_revision + 1
        );
    }

    #[test]
    fn native_and_reply_bindings_persist_without_runtime_values_and_retry_idempotently() {
        let mut session = Session::default();
        let source = artifact_reply(&mut session, "source-reply", "codex:one", "source-artifact");
        let target = artifact_reply(&mut session, "target-reply", "codex:one", "target-artifact");
        let native_binding = binding(&source, "source-artifact", "value", None, "text");
        let mut create = batch(
            "bind-native",
            vec![CanvasOperation::Create {
                origin: None,
                id: "native-text".into(),
                content: CanvasContent::Text {
                    title: String::new(),
                    text: "0".into(),
                },
                placement: CanvasPlacementFields::default(),
                bindings: vec![native_binding.clone()],
            }],
        );
        create
            .reads
            .push(read(CanvasTargetKind::Content, &source, 1));
        assert!(session
            .apply_canvas_batch(create, AGENT)
            .unwrap()
            .is_applied());
        assert_eq!(
            session.board.canvas.object("native-text").unwrap().bindings,
            vec![native_binding]
        );
        let json =
            serde_json::to_value(session.board.canvas.object("native-text").unwrap()).unwrap();
        assert!(
            json.get("bindings").is_some()
                && json.get("value").is_none()
                && json.get("inputs").is_none()
        );

        let reply_binding = binding(
            &source,
            "source-artifact",
            "series",
            Some("target-artifact"),
            "series",
        );
        let mut request = batch(
            "bind-reply",
            vec![bind(&target, 1, vec![reply_binding.clone()])],
        );
        request
            .reads
            .push(read(CanvasTargetKind::Content, &source, 1));
        let first = session.apply_canvas_batch(request.clone(), AGENT).unwrap();
        assert!(first.is_applied());
        assert_eq!(
            session
                .board
                .canvas
                .object(&target)
                .unwrap()
                .content_revision,
            2
        );
        assert_eq!(
            session
                .board
                .replies
                .iter()
                .find(|reply| reply.id == "target-reply")
                .unwrap()
                .revision,
            2
        );
        assert_eq!(session.apply_canvas_batch(request, AGENT).unwrap(), first);
        assert_eq!(
            session
                .board
                .canvas
                .object(&target)
                .unwrap()
                .content_revision,
            2
        );
    }

    #[test]
    fn bind_conflicts_and_user_protection_leave_the_whole_batch_unchanged() {
        let mut session = Session::default();
        let source = artifact_reply(&mut session, "source", "codex:one", "artifact");
        let target = artifact_reply(&mut session, "target", "codex:one", "artifact");
        session
            .apply_canvas_batch(batch("note", vec![text("note", "keep")]), AGENT)
            .unwrap();
        let edge = binding(&source, "artifact", "value", Some("artifact"), "value");
        let mut user_request = batch("user-bind", vec![bind(&target, 1, vec![edge.clone()])]);
        user_request
            .reads
            .push(read(CanvasTargetKind::Content, &source, 1));
        assert!(session
            .apply_canvas_batch(user_request, None)
            .unwrap()
            .is_applied());
        assert!(session.board.canvas.object(&target).unwrap().user_edited);

        let before = session.board.canvas.clone();
        let mut protected = batch(
            "protected-bind",
            vec![place("note", 1, 800.0), bind(&target, 2, vec![edge])],
        );
        protected
            .reads
            .push(read(CanvasTargetKind::Content, &source, 1));
        let result = session.apply_canvas_batch(protected, AGENT).unwrap();
        assert_eq!(result.status, CanvasBatchStatus::Proposed);
        assert!(result
            .targets
            .iter()
            .any(|target| target.status == CanvasTargetState::Protected));
        let mut expected = before.clone();
        expected.proposals = session.board.canvas.proposals.clone();
        assert_eq!(session.board.canvas, expected);
        assert_eq!(session.board.canvas.placement("note").unwrap().x, 48.0);

        let stale = session
            .apply_canvas_batch(batch("stale-bind", vec![bind(&target, 1, vec![])]), None)
            .unwrap();
        assert_eq!(stale.targets[0].status, CanvasTargetState::Conflict);
        assert_eq!(
            session
                .board
                .canvas
                .object(&target)
                .unwrap()
                .content_revision,
            2
        );
    }

    #[test]
    fn binding_graph_rejects_self_and_cross_object_cycles() {
        let mut session = Session::default();
        let a = artifact_reply(&mut session, "a", "codex:one", "artifact");
        let b = artifact_reply(&mut session, "b", "codex:one", "artifact");
        let self_edge = binding(&a, "artifact", "out", Some("artifact"), "in");
        let mut self_request = batch("self-bind", vec![bind(&a, 1, vec![self_edge])]);
        self_request
            .reads
            .push(read(CanvasTargetKind::Content, &a, 1));
        assert_eq!(
            session
                .apply_canvas_batch(self_request, AGENT)
                .unwrap()
                .targets[0]
                .status,
            CanvasTargetState::Invalid
        );

        let mut first = batch(
            "a-to-b",
            vec![bind(
                &b,
                1,
                vec![binding(&a, "artifact", "out", Some("artifact"), "in")],
            )],
        );
        first.reads.push(read(CanvasTargetKind::Content, &a, 1));
        assert!(session
            .apply_canvas_batch(first, AGENT)
            .unwrap()
            .is_applied());
        let mut cycle = batch(
            "b-to-a",
            vec![bind(
                &a,
                1,
                vec![binding(&b, "artifact", "out", Some("artifact"), "in")],
            )],
        );
        cycle.reads.push(read(CanvasTargetKind::Content, &b, 2));
        let result = session.apply_canvas_batch(cycle, AGENT).unwrap();
        assert_eq!(
            result
                .targets
                .iter()
                .find(|target| target.id == a)
                .unwrap()
                .status,
            CanvasTargetState::Invalid
        );
        assert!(session.board.canvas.object(&a).unwrap().bindings.is_empty());
    }

    #[test]
    fn new_bindings_require_declared_foreign_reads_and_unique_compatible_targets() {
        let mut session = Session::default();
        let source = artifact_reply(&mut session, "foreign", "cursor:two", "artifact");
        let target = artifact_reply(&mut session, "owned", "codex:one", "artifact");
        let edge = binding(&source, "artifact", "value", Some("artifact"), "value");
        let missing = session
            .apply_canvas_batch(
                batch("missing-read", vec![bind(&target, 1, vec![edge.clone()])]),
                AGENT,
            )
            .unwrap();
        assert_eq!(missing.targets[0].status, CanvasTargetState::Invalid);

        let mut stale = batch("stale-read", vec![bind(&target, 1, vec![edge.clone()])]);
        stale
            .reads
            .push(read(CanvasTargetKind::Content, &source, 0));
        assert_eq!(
            session.apply_canvas_batch(stale, AGENT).unwrap().status,
            CanvasBatchStatus::Proposed
        );
        let mut valid = batch("foreign-read", vec![bind(&target, 1, vec![edge.clone()])]);
        valid
            .reads
            .push(read(CanvasTargetKind::Content, &source, 1));
        assert!(session
            .apply_canvas_batch(valid, AGENT)
            .unwrap()
            .is_applied());

        let duplicate = vec![
            edge.clone(),
            binding(&source, "artifact", "other", Some("artifact"), "value"),
        ];
        let result = session
            .apply_canvas_batch(
                batch("duplicate-target", vec![bind(&target, 2, duplicate)]),
                AGENT,
            )
            .unwrap();
        assert_eq!(result.targets[0].status, CanvasTargetState::Invalid);
        let bad_target = binding(&source, "artifact", "value", None, "wrong");
        let mut create = batch(
            "bad-native-target",
            vec![CanvasOperation::Create {
                origin: None,
                id: "text-target".into(),
                content: CanvasContent::Text {
                    title: String::new(),
                    text: "x".into(),
                },
                placement: CanvasPlacementFields::default(),
                bindings: vec![bad_target],
            }],
        );
        create
            .reads
            .push(read(CanvasTargetKind::Content, &source, 1));
        let result = session.apply_canvas_batch(create, AGENT).unwrap();
        assert_eq!(
            result
                .targets
                .iter()
                .find(|target| target.id == "text-target")
                .unwrap()
                .status,
            CanvasTargetState::Invalid
        );
    }

    #[test]
    fn binding_limits_apply_per_object_and_across_the_live_canvas() {
        let mut session = Session::default();
        let source = artifact_reply(&mut session, "source", "codex:one", "artifact");
        let targets: Vec<_> = (0..9)
            .map(|index| {
                artifact_reply(
                    &mut session,
                    &format!("target-{index}"),
                    "codex:one",
                    "artifact",
                )
            })
            .collect();
        let edges = |count| {
            (0..count)
                .map(|index| {
                    binding(
                        &source,
                        "artifact",
                        "out",
                        Some("artifact"),
                        &format!("in-{index}"),
                    )
                })
                .collect::<Vec<_>>()
        };
        let mut too_many = batch("too-many-on-one", vec![bind(&targets[0], 1, edges(33))]);
        too_many
            .reads
            .push(read(CanvasTargetKind::Content, &source, 1));
        assert_eq!(
            session.apply_canvas_batch(too_many, AGENT).unwrap().targets[1].status,
            CanvasTargetState::Invalid
        );

        let mut fill = batch(
            "fill-bindings",
            targets[..8]
                .iter()
                .map(|target| bind(target, 1, edges(32)))
                .collect(),
        );
        fill.reads.push(read(CanvasTargetKind::Content, &source, 1));
        assert!(session
            .apply_canvas_batch(fill, AGENT)
            .unwrap()
            .is_applied());
        assert_eq!(
            session
                .board
                .canvas
                .objects
                .iter()
                .map(|object| object.bindings.len())
                .sum::<usize>(),
            256
        );

        let mut overflow = batch("overflow-bindings", vec![bind(&targets[8], 1, edges(1))]);
        overflow
            .reads
            .push(read(CanvasTargetKind::Content, &source, 1));
        let result = session.apply_canvas_batch(overflow, AGENT).unwrap();
        assert_eq!(
            result
                .targets
                .iter()
                .find(|target| target.id == targets[8])
                .unwrap()
                .status,
            CanvasTargetState::Invalid
        );
        assert!(session
            .board
            .canvas
            .object(&targets[8])
            .unwrap()
            .bindings
            .is_empty());
    }

    #[test]
    fn hard_delete_keeps_dangling_bindings_until_explicit_disconnect() {
        let mut session = Session::default();
        let source = artifact_reply(&mut session, "source", "codex:one", "artifact");
        let target = artifact_reply(&mut session, "target", "codex:one", "artifact");
        let mut request = batch(
            "connect",
            vec![bind(
                &target,
                1,
                vec![binding(
                    &source,
                    "artifact",
                    "value",
                    Some("artifact"),
                    "value",
                )],
            )],
        );
        request
            .reads
            .push(read(CanvasTargetKind::Content, &source, 1));
        assert!(session
            .apply_canvas_batch(request, AGENT)
            .unwrap()
            .is_applied());
        session.delete_canvas_content(&source, 1, &[]).unwrap();
        assert!(session.board.canvas.object(&source).is_none());
        assert_eq!(
            session.board.canvas.object(&target).unwrap().bindings[0]
                .from
                .object_id,
            source
        );

        assert!(session
            .apply_canvas_batch(batch("disconnect", vec![bind(&target, 2, vec![])]), AGENT)
            .unwrap()
            .is_applied());
        let target = session.board.canvas.object(&target).unwrap();
        assert!(target.bindings.is_empty());
        assert_eq!(target.content_revision, 3);
    }

    fn text_block(id: &str, body: &str) -> ReplyBlock {
        ReplyBlock::Text {
            id: id.into(),
            title: String::new(),
            text: body.into(),
        }
    }

    fn comparison_block(id: &str, first: &str, selected: Option<&str>) -> ReplyBlock {
        ReplyBlock::Comparison {
            id: id.into(),
            title: String::new(),
            criteria: vec!["成本".into()],
            options: vec![
                ReplyOption {
                    id: "x".into(),
                    title: first.into(),
                    summary: String::new(),
                    values: vec!["低".into()],
                    image: None,
                    artifact: None,
                },
                ReplyOption {
                    id: "y".into(),
                    title: "Y".into(),
                    summary: String::new(),
                    values: vec!["高".into()],
                    image: None,
                    artifact: None,
                },
            ],
            selected_id: selected.map(String::from),
        }
    }

    fn graph_block(id: &str, node_ids: &[&str], edge_to: Option<&str>) -> ReplyBlock {
        ReplyBlock::Graph {
            id: id.into(),
            title: String::new(),
            nodes: node_ids
                .iter()
                .map(|node| ReplyGraphNode {
                    id: (*node).into(),
                    title: node.to_uppercase(),
                    detail: String::new(),
                    x: None,
                    y: None,
                })
                .collect(),
            edges: edge_to
                .map(|to| {
                    vec![ReplyGraphEdge {
                        id: "e".into(),
                        from: node_ids[0].into(),
                        to: to.into(),
                        label: "导致".into(),
                    }]
                })
                .unwrap_or_default(),
        }
    }

    fn sequence_block(id: &str, action: &str) -> ReplyBlock {
        ReplyBlock::Sequence {
            id: id.into(),
            title: String::new(),
            steps: vec![ReplyStep {
                id: "s1".into(),
                title: "第一步".into(),
                action: action.into(),
                feedback: String::new(),
                note: String::new(),
                image: None,
                artifact: None,
            }],
        }
    }

    fn image_reference(
        object_id: &str,
        content_revision: u64,
        title: &str,
        alt: &str,
        src: &str,
    ) -> ReplyImageReference {
        serde_json::from_value(serde_json::json!({
            "object_id": object_id,
            "content_revision": content_revision,
            "title": title,
            "alt": alt,
            "src": src,
        }))
        .unwrap()
    }

    fn option_image_block(id: &str, image: Option<ReplyImageReference>) -> ReplyBlock {
        let mut block = comparison_block(id, "方案", None);
        let ReplyBlock::Comparison { options, .. } = &mut block else {
            unreachable!()
        };
        options[0].image = image;
        block
    }

    fn image_object(id: &str, title: &str, alt: &str, src: &str) -> CanvasOperation {
        CanvasOperation::Create {
            origin: None,
            id: id.into(),
            content: CanvasContent::Image {
                title: title.into(),
                alt: alt.into(),
                src: src.into(),
            },
            placement: CanvasPlacementFields::default(),
            bindings: vec![],
        }
    }

    fn option_image(session: &Session, owner_id: &str) -> ReplyImageReference {
        let CanvasContent::Block {
            block: ReplyBlock::Comparison { options, .. },
        } = &session.board.canvas.object(owner_id).unwrap().content
        else {
            panic!("{owner_id} is not a comparison block object")
        };
        options[0].image.clone().expect("option image")
    }

    fn seed_fixed_option_image(session: &mut Session) -> ReplyImageReference {
        let src = "/artifacts/bundle-one/first.png";
        let snapshot = image_reference("image", 1, "初稿", "初始说明", src);
        let result = session
            .apply_canvas_batch(
                batch(
                    "seed-fixed-image",
                    vec![
                        image_object("image", "初稿", "初始说明", src),
                        create_block(
                            "owner",
                            option_image_block("choice", Some(snapshot.clone())),
                        ),
                        compose("idea", 0, &["owner", "image"]),
                    ],
                ),
                AGENT,
            )
            .unwrap();
        assert!(result.is_applied(), "{:?}", result.targets);
        snapshot
    }

    #[test]
    fn fixed_image_reference_accepts_same_idea_in_one_atomic_batch() {
        let mut session = Session::default();
        let snapshot = seed_fixed_option_image(&mut session);
        assert_eq!(option_image(&session, "owner"), snapshot);
        assert_eq!(
            session.board.canvas.composition("idea").unwrap().members,
            ["owner", "image"]
        );
    }

    #[test]
    fn image_reference_cross_group_and_cross_source_fail_atomically() {
        let mut separate = Session::default();
        let src = "/artifacts/bundle-one/first.png";
        let snapshot = image_reference("image", 1, "初稿", "初始说明", src);
        let result = separate
            .apply_canvas_batch(
                batch(
                    "separate-ideas",
                    vec![
                        image_object("image", "初稿", "初始说明", src),
                        create_block("owner", option_image_block("choice", Some(snapshot))),
                        compose("image-idea", 0, &["image"]),
                        compose("reply-idea", 0, &["owner"]),
                    ],
                ),
                AGENT,
            )
            .unwrap();
        assert_eq!(result.status, CanvasBatchStatus::Proposed);
        assert_eq!(
            result
                .targets
                .iter()
                .find(|target| target.id == "owner" && target.kind == CanvasTargetKind::Content)
                .unwrap()
                .status,
            CanvasTargetState::Invalid
        );
        assert!(separate.board.canvas.objects.is_empty());
        assert!(separate.board.canvas.compositions.is_empty());

        let mut sources = Session::default();
        sources
            .apply_canvas_batch(
                batch(
                    "foreign-image",
                    vec![image_object("foreign-image", "外来", "外来说明", src)],
                ),
                Some("cursor:two"),
            )
            .unwrap();
        sources
            .apply_canvas_batch(
                batch(
                    "owned-block",
                    vec![create_block("owner", option_image_block("choice", None))],
                ),
                AGENT,
            )
            .unwrap();
        sources
            .apply_canvas_batch(
                batch(
                    "mixed-owner-idea",
                    vec![compose("idea", 0, &["owner", "foreign-image"])],
                ),
                None,
            )
            .unwrap();
        let result = sources
            .apply_canvas_batch(
                batch(
                    "foreign-reference",
                    vec![patch_block(
                        "owner",
                        1,
                        option_image_block(
                            "choice",
                            Some(image_reference("foreign-image", 1, "外来", "外来说明", src)),
                        ),
                    )],
                ),
                AGENT,
            )
            .unwrap();
        assert_eq!(result.status, CanvasBatchStatus::Proposed);
        assert_eq!(result.targets[0].status, CanvasTargetState::Invalid);
        let CanvasContent::Block {
            block: ReplyBlock::Comparison { options, .. },
        } = &sources.board.canvas.object("owner").unwrap().content
        else {
            panic!()
        };
        assert!(options[0].image.is_none());
    }

    #[test]
    fn new_image_reference_requires_an_exact_immutable_bytes_snapshot() {
        let mut session = Session::default();
        let target = "data:image/png;base64,AAAA";
        let different_bytes = "data:image/png;base64,AAAB";
        let result = session
            .apply_canvas_batch(
                batch(
                    "different-bytes",
                    vec![
                        image_object("image", "像素", "像素说明", target),
                        create_block(
                            "owner",
                            option_image_block(
                                "choice",
                                Some(image_reference(
                                    "image",
                                    1,
                                    "像素",
                                    "像素说明",
                                    different_bytes,
                                )),
                            ),
                        ),
                        compose("idea", 0, &["owner", "image"]),
                    ],
                ),
                AGENT,
            )
            .unwrap();
        assert_eq!(result.status, CanvasBatchStatus::Proposed);
        assert!(result.targets.iter().any(|target| {
            target.id == "owner"
                && target.status == CanvasTargetState::Invalid
                && target
                    .message
                    .as_deref()
                    .is_some_and(|message| message.contains("精确匹配"))
        }));
        assert!(session.board.canvas.objects.is_empty());
    }

    #[test]
    fn invalid_new_stale_image_reference_leaves_the_batch_uncommitted() {
        let mut session = Session::default();
        let src = "/artifacts/bundle-one/first.png";
        let result = session
            .apply_canvas_batch(
                batch(
                    "stale-reference",
                    vec![
                        image_object("image", "初稿", "初始说明", src),
                        create_block(
                            "owner",
                            option_image_block(
                                "choice",
                                Some(image_reference("image", 0, "初稿", "初始说明", src)),
                            ),
                        ),
                        compose("idea", 0, &["owner", "image"]),
                    ],
                ),
                AGENT,
            )
            .unwrap();
        assert_eq!(result.status, CanvasBatchStatus::Proposed);
        assert_eq!(result.targets[0].status, CanvasTargetState::Ready);
        assert!(result
            .targets
            .iter()
            .any(|target| { target.id == "owner" && target.status == CanvasTargetState::Invalid }));
        assert!(session.board.canvas.objects.is_empty());
        assert!(session.board.canvas.compositions.is_empty());
    }

    #[test]
    fn source_updates_and_idea_rename_reorder_preserve_existing_image_snapshot() {
        let mut session = Session::default();
        let snapshot = seed_fixed_option_image(&mut session);
        let result = session
            .apply_canvas_batch(
                batch(
                    "rename-reorder-after-source-update",
                    vec![
                        CanvasOperation::PatchContent {
                            id: "image".into(),
                            expected_revision: 1,
                            fields: CanvasContentFields {
                                title: Some("改名后的图片".into()),
                                src: Some("/artifacts/bundle-one/second.png".into()),
                                ..Default::default()
                            },
                        },
                        CanvasOperation::Compose {
                            id: "idea".into(),
                            expected_revision: 1,
                            title: "重新命名的想法".into(),
                            description: None,
                            arrangement: None,
                            members: vec!["image".into(), "owner".into()],
                        },
                    ],
                ),
                AGENT,
            )
            .unwrap();
        assert!(result.is_applied(), "{:?}", result.targets);
        assert_eq!(option_image(&session, "owner"), snapshot);
        let CanvasContent::Image { title, src, .. } =
            &session.board.canvas.object("image").unwrap().content
        else {
            panic!()
        };
        assert_eq!(title, "改名后的图片");
        assert_eq!(src, "/artifacts/bundle-one/second.png");
        let idea = session.board.canvas.composition("idea").unwrap();
        assert_eq!(idea.title, "重新命名的想法");
        assert_eq!(idea.members, ["image", "owner"]);
    }

    #[test]
    fn deleted_source_and_removed_group_keep_the_existing_snapshot() {
        let mut session = Session::default();
        let snapshot = seed_fixed_option_image(&mut session);
        session
            .delete_canvas_content(
                "image",
                1,
                &[read(CanvasTargetKind::Composition, "idea", 1)],
            )
            .unwrap();
        assert_eq!(option_image(&session, "owner"), snapshot);
        assert_eq!(
            session.board.canvas.composition("idea").unwrap().members,
            ["owner"]
        );
        assert!(session
            .apply_canvas_batch(
                batch(
                    "remove-idea-after-image-delete",
                    vec![CanvasOperation::Ungroup {
                        id: "idea".into(),
                        expected_revision: 2,
                    }],
                ),
                AGENT,
            )
            .unwrap()
            .is_applied());
        assert!(session.board.canvas.composition("idea").is_none());
        assert!(session
            .apply_canvas_batch(
                batch("unrelated-owner-move", vec![place("owner", 1, 720.0)]),
                AGENT
            )
            .unwrap()
            .is_applied());
        assert_eq!(option_image(&session, "owner"), snapshot);
    }

    fn create_block(id: &str, block: ReplyBlock) -> CanvasOperation {
        CanvasOperation::Create {
            origin: None,
            id: id.into(),
            content: CanvasContent::Block { block },
            placement: CanvasPlacementFields::default(),
            bindings: vec![],
        }
    }

    fn patch_block(id: &str, expected: u64, block: ReplyBlock) -> CanvasOperation {
        CanvasOperation::PatchBlock {
            id: id.into(),
            expected_revision: expected,
            block,
        }
    }

    fn block_of(session: &Session, id: &str) -> ReplyBlock {
        let CanvasContent::Block { block } = &session.board.canvas.object(id).unwrap().content
        else {
            panic!("{id} is not a block object")
        };
        block.clone()
    }

    fn revisions(session: &Session, ids: &[&str]) -> Vec<(u64, u64)> {
        ids.iter()
            .map(|id| {
                (
                    session.board.canvas.object(id).unwrap().content_revision,
                    session.board.canvas.placement(id).unwrap().revision,
                )
            })
            .collect()
    }

    #[test]
    fn block_objects_hold_each_atomic_form_and_version_independently() {
        let mut session = Session::default();
        let result = session
            .apply_canvas_batch(
                batch(
                    "forms",
                    vec![
                        create_block("t", text_block("t-body", "文字")),
                        create_block("c", comparison_block("c-body", "X", None)),
                        create_block("g", graph_block("g-body", &["a", "b"], Some("b"))),
                        create_block("s", sequence_block("s-body", "打开门")),
                    ],
                ),
                AGENT,
            )
            .unwrap();
        assert!(result.is_applied(), "{:?}", result.targets);
        let object = session.board.canvas.object("t").unwrap();
        assert_eq!(object.content.kind_name(), "block");
        assert!(!object.content.is_legacy() && object.content.legacy_id().is_none());
        assert_eq!(object.source_id.as_deref(), AGENT);
        assert_eq!(
            serde_json::to_value(&object.content).unwrap(),
            serde_json::json!({
                "type": "block",
                "block": {"type": "text", "id": "t-body", "title": "", "text": "文字"}
            })
        );
        let sizes: Vec<_> = ["t", "c", "g", "s"]
            .iter()
            .map(|id| {
                let item = session.board.canvas.placement(id).unwrap();
                (item.width, item.height)
            })
            .collect();
        assert_eq!(
            sizes,
            vec![
                (380.0, 300.0),
                (640.0, 400.0),
                (640.0, 480.0),
                (480.0, 420.0)
            ]
        );
        assert_eq!(revisions(&session, &["t", "c", "g", "s"]), vec![(1, 1); 4]);

        let result = session
            .apply_canvas_batch(
                batch(
                    "edit-text",
                    vec![patch_block("t", 1, text_block("t-body", "改"))],
                ),
                AGENT,
            )
            .unwrap();
        assert!(result.is_applied(), "{:?}", result.targets);
        assert_eq!(result.targets[0].actual_revision, Some(2));
        assert_eq!(
            revisions(&session, &["t", "c", "g", "s"]),
            vec![(2, 1), (1, 1), (1, 1), (1, 1)]
        );
        assert_eq!(block_of(&session, "t"), text_block("t-body", "改"));

        let result = session
            .apply_canvas_batch(
                batch(
                    "edit-rest",
                    vec![
                        patch_block("c", 1, comparison_block("c-body", "X 改", Some("y"))),
                        patch_block("g", 1, graph_block("g-body", &["a", "b", "c"], None)),
                        patch_block("s", 1, sequence_block("s-body", "关上门")),
                    ],
                ),
                AGENT,
            )
            .unwrap();
        assert!(result.is_applied(), "{:?}", result.targets);
        assert_eq!(
            revisions(&session, &["t", "c", "g", "s"]),
            vec![(2, 1), (2, 1), (2, 1), (2, 1)]
        );
        assert_eq!(
            block_of(&session, "c"),
            comparison_block("c-body", "X 改", Some("y"))
        );
        assert_eq!(
            block_of(&session, "g"),
            graph_block("g-body", &["a", "b", "c"], None)
        );
        assert_eq!(block_of(&session, "s"), sequence_block("s-body", "关上门"));

        // Replacing with the identical form is ready but does not mint a new version.
        let result = session
            .apply_canvas_batch(
                batch(
                    "same",
                    vec![patch_block("s", 2, sequence_block("s-body", "关上门"))],
                ),
                AGENT,
            )
            .unwrap();
        assert!(result.is_applied());
        assert_eq!(result.targets[0].actual_revision, Some(2));

        let mut reloaded: Session =
            serde_json::from_str(&serde_json::to_string(&session).unwrap()).unwrap();
        assert!(!reloaded.sync_canvas());
        assert_eq!(reloaded.board.canvas, session.board.canvas);
    }

    #[test]
    fn block_patches_reject_bad_forms_identity_changes_and_artifacts_atomically() {
        let mut session = Session::default();
        session
            .apply_canvas_batch(
                batch(
                    "seed",
                    vec![
                        create_block("g", graph_block("g-body", &["a", "b"], None)),
                        create_block("t", text_block("t-body", "文字")),
                        text("plain", "原生文字"),
                    ],
                ),
                AGENT,
            )
            .unwrap();
        let artifact = ReplyBlock::Artifact {
            id: "art".into(),
            title: String::new(),
            bundle_id: "bundle".into(),
            description: String::new(),
            state: serde_json::json!({}),
            state_revision: 0,
            state_preview: None,
        };
        let cases: Vec<(&str, CanvasOperation)> = vec![
            (
                "dangling-edge",
                patch_block("g", 1, graph_block("g-body", &["a", "b"], Some("zzz"))),
            ),
            (
                "duplicate-node-ids",
                patch_block("g", 1, graph_block("g-body", &["a", "a"], None)),
            ),
            (
                "changed-block-id",
                patch_block("g", 1, graph_block("other", &["a", "b"], None)),
            ),
            (
                "changed-form",
                patch_block("g", 1, sequence_block("g-body", "变成分镜")),
            ),
            ("artifact-replace", patch_block("t", 1, artifact.clone())),
            ("artifact-create", create_block("art", artifact)),
            (
                "duplicate-option-ids",
                create_block("dup", {
                    let mut block = comparison_block("dup-body", "X", None);
                    if let ReplyBlock::Comparison { options, .. } = &mut block {
                        options[1].id = "x".into();
                    }
                    block
                }),
            ),
            ("field-patch-on-block", patch_text("t", 1, "字段修改")),
            (
                "block-patch-on-text",
                patch_block("plain", 1, text_block("plain", "整块替换")),
            ),
        ];
        let before = session.board.canvas.clone();
        for (label, op) in cases {
            let result = session
                .apply_canvas_batch(batch(label, vec![op]), AGENT)
                .unwrap();
            assert_eq!(result.status, CanvasBatchStatus::Proposed, "{label}");
            assert_eq!(
                result.targets[0].status,
                CanvasTargetState::Invalid,
                "{label}: {:?}",
                result.targets
            );
        }
        let mut expected = before.clone();
        expected.proposals = session.board.canvas.proposals.clone();
        assert_eq!(session.board.canvas, expected);

        // One bad form in a batch keeps the good ones from landing too.
        let result = session
            .apply_canvas_batch(
                batch(
                    "mixed",
                    vec![
                        patch_block("t", 1, text_block("t-body", "好的修改")),
                        patch_block("g", 1, graph_block("g-body", &["a"], Some("b"))),
                    ],
                ),
                AGENT,
            )
            .unwrap();
        assert_eq!(result.status, CanvasBatchStatus::Proposed);
        assert_eq!(
            statuses(&result),
            vec![
                (CanvasTargetKind::Content, "t", CanvasTargetState::Ready),
                (CanvasTargetKind::Content, "g", CanvasTargetState::Invalid),
            ]
        );
        assert_eq!(block_of(&session, "t"), text_block("t-body", "文字"));
        assert_eq!(revisions(&session, &["t", "g"]), vec![(1, 1), (1, 1)]);
    }

    #[test]
    fn composition_arrangement_is_saved_without_moving_presentations() {
        let mut session = Session::default();
        let result = session
            .apply_canvas_batch(
                batch(
                    "arrangement-intent-seed",
                    vec![
                        text_at("a", "A", 640.0, 320.0, 200.0, 100.0, 7, CanvasAppearance::Card),
                        text_at("b", "B", 80.0, 40.0, 120.0, 80.0, 8, CanvasAppearance::Plain),
                        compose_with_arrangement(
                            "idea",
                            0,
                            &["a", "b"],
                            Some(CanvasArrangement::SideBySide),
                        ),
                    ],
                ),
                AGENT,
            )
            .unwrap();
        assert!(result.is_applied(), "{:?}", result.targets);
        let positions = session.board.canvas.items.clone();
        assert_eq!(
            session.board.canvas.composition("idea").unwrap().arrangement,
            CanvasArrangement::SideBySide
        );

        // Omitting arrangement keeps it, and changing only composition metadata does not move
        // any presentation.
        let result = session
            .apply_canvas_batch(
                batch(
                    "arrangement-intent-omit",
                    vec![CanvasOperation::Compose {
                        id: "idea".into(),
                        expected_revision: 1,
                        title: "已保存的编排意图".into(),
                        description: None,
                        arrangement: None,
                        members: vec!["a".into(), "b".into()],
                    }],
                ),
                AGENT,
            )
            .unwrap();
        assert!(result.is_applied(), "{:?}", result.targets);
        let group = session.board.canvas.composition("idea").unwrap();
        assert_eq!(group.revision, 2);
        assert_eq!(group.arrangement, CanvasArrangement::SideBySide);
        assert_eq!(session.board.canvas.items, positions);

        let legacy: crate::CanvasComposition = serde_json::from_value(serde_json::json!({
            "id": "old-idea",
            "members": ["a"]
        }))
        .unwrap();
        assert_eq!(legacy.arrangement, CanvasArrangement::Free);

        let mut free = Session::default();
        free.apply_canvas_batch(
            batch(
                "free-arrangement-seed",
                vec![text("only", "Only"), compose("free-idea", 0, &["only"])],
            ),
            AGENT,
        )
        .unwrap();
        let rejected = free
            .apply_canvas_batch(
                batch(
                    "free-arrangement-reject",
                    vec![arrange("free-idea", 1, &[("only", 1)])],
                ),
                AGENT,
            )
            .unwrap();
        assert_eq!(rejected.status, CanvasBatchStatus::Proposed);
        assert!(rejected.targets.iter().any(|target| {
            target.kind == CanvasTargetKind::Composition
                && target.status == CanvasTargetState::Invalid
        }));
    }

    #[test]
    fn arrange_uses_each_saved_intent_and_preserves_nonposition_state() {
        let cases = [
            (
                "side",
                CanvasArrangement::SideBySide,
                [("a", 20.0, 10.0), ("b", 252.0, 10.0), ("c", 384.0, 10.0)],
            ),
            (
                "figure",
                CanvasArrangement::FigureCaption,
                [("a", 70.0, 10.0), ("b", 120.0, 126.0), ("c", 20.0, 192.0)],
            ),
            (
                "sequence",
                CanvasArrangement::Sequence,
                [("a", 20.0, 10.0), ("b", 20.0, 158.0), ("c", 20.0, 256.0)],
            ),
        ];
        for (name, arrangement, expected) in cases {
            let mut session = Session::default();
            let seeded = session
                .apply_canvas_batch(
                    batch(
                        &format!("arrange-{name}-seed"),
                        vec![
                            text_at("a", "A", 100.0, 300.0, 200.0, 100.0, 17, CanvasAppearance::Card),
                            text_at("b", "B", 20.0, 70.0, 100.0, 50.0, 18, CanvasAppearance::Plain),
                            text_at("c", "C", 500.0, 10.0, 300.0, 80.0, 19, CanvasAppearance::Card),
                            compose_with_arrangement(
                                "idea",
                                0,
                                &["a", "b", "c"],
                                Some(arrangement),
                            ),
                        ],
                    ),
                    AGENT,
                )
                .unwrap();
            assert!(seeded.is_applied(), "{name}: {:?}", seeded.targets);
            let before_objects = session.board.canvas.objects.clone();
            let before_items = session.board.canvas.items.clone();
            let before_group = session.board.canvas.composition("idea").unwrap().clone();

            let result = session
                .apply_canvas_batch(
                    batch(
                        &format!("arrange-{name}"),
                        vec![arrange("idea", 1, &[("a", 1), ("b", 1), ("c", 1)])],
                    ),
                    AGENT,
                )
                .unwrap();
            assert!(result.is_applied(), "{name}: {:?}", result.targets);
            assert_eq!(session.board.canvas.objects, before_objects, "{name}");
            assert_eq!(
                session.board.canvas.composition("idea").unwrap(),
                &before_group,
                "{name}"
            );
            for (id, x, y) in expected {
                let after = session.board.canvas.placement(id).unwrap();
                let before = before_items.iter().find(|item| item.item_id == id).unwrap();
                assert_eq!((after.x, after.y), (x, y), "{name}/{id}");
                assert_eq!(
                    (after.width, after.height, after.z, after.appearance, after.removed),
                    (
                        before.width,
                        before.height,
                        before.z,
                        before.appearance,
                        before.removed
                    ),
                    "{name}/{id}"
                );
            }
        }
    }

    #[test]
    fn create_compose_and_arrange_can_land_atomically() {
        let mut session = Session::default();
        let result = session
            .apply_canvas_batch(
                batch(
                    "create-compose-arrange",
                    vec![
                        text_at("a", "A", 200.0, 160.0, 200.0, 100.0, 1, CanvasAppearance::Card),
                        text_at("b", "B", 40.0, 60.0, 120.0, 80.0, 2, CanvasAppearance::Plain),
                        compose_with_arrangement(
                            "idea",
                            0,
                            &["a", "b"],
                            Some(CanvasArrangement::SideBySide),
                        ),
                        arrange("idea", 1, &[("a", 1), ("b", 1)]),
                    ],
                ),
                AGENT,
            )
            .unwrap();
        assert!(result.is_applied(), "{:?}", result.targets);
        assert_eq!(
            (
                session.board.canvas.placement("a").unwrap().x,
                session.board.canvas.placement("a").unwrap().y
            ),
            (40.0, 60.0)
        );
        assert_eq!(
            (
                session.board.canvas.placement("b").unwrap().x,
                session.board.canvas.placement("b").unwrap().y
            ),
            (272.0, 60.0)
        );
        assert!(result.targets.iter().all(|target| {
            target.kind != CanvasTargetKind::Presentation
                || !matches!(target.id.as_str(), "a" | "b")
                || target.expected_revision == Some(1)
        }));
    }

    #[test]
    fn arrange_requires_exact_fresh_presentations_without_partial_writes() {
        let mut session = Session::default();
        session
            .apply_canvas_batch(
                batch(
                    "arrange-fresh-seed",
                    vec![
                        text_at("a", "A", 400.0, 100.0, 200.0, 100.0, 1, CanvasAppearance::Card),
                        text_at("b", "B", 20.0, 20.0, 120.0, 80.0, 2, CanvasAppearance::Plain),
                        compose_with_arrangement(
                            "idea",
                            0,
                            &["a", "b"],
                            Some(CanvasArrangement::SideBySide),
                        ),
                    ],
                ),
                AGENT,
            )
            .unwrap();
        let before_items = session.board.canvas.items.clone();
        let before_objects = session.board.canvas.objects.clone();
        let before_group = session.board.canvas.composition("idea").unwrap().clone();

        let stale = session
            .apply_canvas_batch(
                batch(
                    "arrange-stale",
                    vec![arrange("idea", 1, &[("a", 1), ("b", 0)])],
                ),
                AGENT,
            )
            .unwrap();
        assert_eq!(stale.status, CanvasBatchStatus::Proposed);
        assert!(stale.targets.iter().any(|target| {
            target.kind == CanvasTargetKind::Presentation
                && target.id == "b"
                && target.status == CanvasTargetState::Conflict
                && target.actual_revision == Some(1)
        }));
        assert_eq!(session.board.canvas.items, before_items);
        assert_eq!(session.board.canvas.objects, before_objects);
        assert_eq!(session.board.canvas.composition("idea"), Some(&before_group));

        for (request_id, versions) in [
            ("arrange-missing", vec![("a", 1)]),
            ("arrange-extra", vec![("a", 1), ("b", 1), ("extra", 1)]),
        ] {
            let result = session
                .apply_canvas_batch(
                    batch(request_id, vec![arrange("idea", 1, &versions)]),
                    AGENT,
                )
                .unwrap();
            assert_eq!(result.status, CanvasBatchStatus::Proposed, "{request_id}");
            assert!(result.targets.iter().any(|target| {
                target.kind == CanvasTargetKind::Composition
                    && target.id == "idea"
                    && target.status == CanvasTargetState::Invalid
            }));
            assert_eq!(session.board.canvas.items, before_items, "{request_id}");
        }
    }

    #[test]
    fn arrange_proposals_guard_user_moves_and_refresh_compose_then_arrange_versions() {
        let mut session = Session::default();
        session
            .apply_canvas_batch(
                batch(
                    "arrange-proposal-seed",
                    vec![
                        text_at("a", "A", 360.0, 160.0, 200.0, 100.0, 1, CanvasAppearance::Card),
                        text_at("b", "B", 100.0, 20.0, 100.0, 80.0, 2, CanvasAppearance::Plain),
                        compose_with_arrangement(
                            "idea",
                            0,
                            &["a", "b"],
                            Some(CanvasArrangement::SideBySide),
                        ),
                    ],
                ),
                AGENT,
            )
            .unwrap();
        session
            .apply_canvas_batch(batch("user-move", vec![place("a", 1, 900.0)]), None)
            .unwrap();
        assert!(session.board.canvas.placement("a").unwrap().user_modified);
        let before_agent_attempt = session.board.canvas.items.clone();

        // The proposal first changes the saved intent, so Arrange must use revision 2 even
        // though the live composition is still at revision 1.
        let proposed = session
            .apply_canvas_batch(
                batch(
                    "agent-compose-arrange",
                    vec![
                        compose_with_arrangement(
                            "idea",
                            1,
                            &["a", "b"],
                            Some(CanvasArrangement::Sequence),
                        ),
                        arrange("idea", 2, &[("a", 2), ("b", 1)]),
                    ],
                ),
                AGENT,
            )
            .unwrap();
        assert_eq!(proposed.status, CanvasBatchStatus::Proposed);
        assert!(proposed.targets.iter().any(|target| {
            target.kind == CanvasTargetKind::Presentation
                && target.id == "a"
                && target.status == CanvasTargetState::Protected
        }));
        assert_eq!(session.board.canvas.items, before_agent_attempt);
        assert_eq!(
            session.board.canvas.composition("idea").unwrap().arrangement,
            CanvasArrangement::SideBySide
        );

        // Applying a proposal must demand every Arrange presentation version, then preserve the
        // post-Compose expected composition revision rather than replacing it with live revision 1.
        assert!(session
            .apply_canvas_proposal(
                "agent-compose-arrange",
                vec![
                    read(CanvasTargetKind::Composition, "idea", 1),
                    read(CanvasTargetKind::Presentation, "a", 2),
                ],
            )
            .is_err());
        let accepted = session
            .apply_canvas_proposal(
                "agent-compose-arrange",
                vec![
                    read(CanvasTargetKind::Composition, "idea", 1),
                    read(CanvasTargetKind::Presentation, "a", 2),
                    read(CanvasTargetKind::Presentation, "b", 1),
                ],
            )
            .unwrap();
        assert!(accepted.is_applied(), "{:?}", accepted.targets);
        assert_eq!(
            session.board.canvas.composition("idea").unwrap().arrangement,
            CanvasArrangement::Sequence
        );
        assert_eq!(
            (
                session.board.canvas.placement("a").unwrap().x,
                session.board.canvas.placement("a").unwrap().y,
                session.board.canvas.placement("b").unwrap().x,
                session.board.canvas.placement("b").unwrap().y,
            ),
            (100.0, 20.0, 100.0, 168.0)
        );

        // A direct user arrange may change a presentation they previously moved.
        session
            .apply_canvas_batch(
                batch(
                    "user-save-figure",
                    vec![compose_with_arrangement(
                        "idea",
                        2,
                        &["a", "b"],
                        Some(CanvasArrangement::FigureCaption),
                    )],
                ),
                None,
            )
            .unwrap();
        let direct = session
            .apply_canvas_batch(
                batch(
                    "user-arrange",
                    vec![arrange("idea", 3, &[("a", 3), ("b", 2)])],
                ),
                None,
            )
            .unwrap();
        assert!(direct.is_applied(), "{:?}", direct.targets);
        assert_eq!(
            (
                session.board.canvas.placement("a").unwrap().x,
                session.board.canvas.placement("a").unwrap().y,
                session.board.canvas.placement("b").unwrap().x,
                session.board.canvas.placement("b").unwrap().y,
            ),
            (100.0, 20.0, 150.0, 136.0)
        );
        assert!(session.board.canvas.placement("b").unwrap().user_modified);
    }

    #[test]
    fn arrange_rejects_hidden_nested_and_foreign_members_without_writes() {
        let mut hidden = Session::default();
        hidden
            .apply_canvas_batch(
                batch(
                    "arrange-hidden-seed",
                    vec![
                        text("a", "A"),
                        text("b", "B"),
                        compose_with_arrangement(
                            "idea",
                            0,
                            &["a", "b"],
                            Some(CanvasArrangement::Sequence),
                        ),
                    ],
                ),
                AGENT,
            )
            .unwrap();
        hidden.set_canvas_removed("b", 1, true).unwrap();
        let hidden_before = hidden.board.canvas.items.clone();
        let hidden_result = hidden
            .apply_canvas_batch(
                batch(
                    "arrange-hidden",
                    vec![arrange("idea", 1, &[("a", 1), ("b", 2)])],
                ),
                AGENT,
            )
            .unwrap();
        assert_eq!(hidden_result.status, CanvasBatchStatus::Proposed);
        assert!(hidden_result.targets.iter().any(|target| {
            target.kind == CanvasTargetKind::Composition
                && target.status == CanvasTargetState::Invalid
        }));
        assert_eq!(hidden.board.canvas.items, hidden_before);
        assert!(hidden.board.canvas.placement("b").unwrap().removed);

        let mut nested = Session::default();
        nested
            .apply_canvas_batch(
                batch(
                    "arrange-nested-seed",
                    vec![
                        text("a", "A"),
                        text("b", "B"),
                        text("c", "C"),
                        compose_with_arrangement(
                            "inner",
                            0,
                            &["a", "b"],
                            Some(CanvasArrangement::SideBySide),
                        ),
                        compose_with_arrangement(
                            "outer",
                            0,
                            &["inner", "c"],
                            Some(CanvasArrangement::Sequence),
                        ),
                    ],
                ),
                AGENT,
            )
            .unwrap();
        let nested_before = nested.board.canvas.items.clone();
        let nested_result = nested
            .apply_canvas_batch(
                batch("arrange-nested", vec![arrange("outer", 1, &[("c", 1)])]),
                AGENT,
            )
            .unwrap();
        assert_eq!(nested_result.status, CanvasBatchStatus::Proposed);
        assert!(nested_result.targets.iter().any(|target| {
            target.kind == CanvasTargetKind::Composition
                && target.id == "outer"
                && target.status == CanvasTargetState::Invalid
        }));
        assert_eq!(nested.board.canvas.items, nested_before);
        assert_eq!(nested.board.canvas.composition("outer").unwrap().members, ["inner", "c"]);

        let mut foreign = Session::default();
        foreign
            .apply_canvas_batch(batch("foreign-a", vec![text("a", "A")]), AGENT)
            .unwrap();
        foreign
            .apply_canvas_batch(
                batch("foreign-b", vec![text("b", "B")]),
                Some("codex:two"),
            )
            .unwrap();
        foreign
            .apply_canvas_batch(
                batch(
                    "foreign-compose",
                    vec![compose_with_arrangement(
                        "idea",
                        0,
                        &["a", "b"],
                        Some(CanvasArrangement::Sequence),
                    )],
                ),
                None,
            )
            .unwrap();
        let foreign_before = foreign.board.canvas.items.clone();
        assert!(foreign
            .apply_canvas_batch(
                batch(
                    "foreign-arrange",
                    vec![arrange("idea", 1, &[("a", 1), ("b", 1)])],
                ),
                AGENT,
            )
            .is_err());
        assert_eq!(foreign.board.canvas.items, foreign_before);
    }

    #[test]
    fn block_edits_follow_ownership_user_protection_and_replay_rules() {
        let mut session = Session::default();
        session
            .apply_canvas_batch(
                batch(
                    "seed",
                    vec![create_block("c", comparison_block("c-body", "X", None))],
                ),
                AGENT,
            )
            .unwrap();
        assert!(session
            .apply_canvas_batch(
                batch(
                    "foreign",
                    vec![patch_block(
                        "c",
                        1,
                        comparison_block("c-body", "别人改", None)
                    )]
                ),
                Some("cursor:two"),
            )
            .is_err());

        assert!(session
            .apply_canvas_batch(
                batch(
                    "user-select",
                    vec![patch_block(
                        "c",
                        1,
                        comparison_block("c-body", "X", Some("y"))
                    )]
                ),
                None,
            )
            .unwrap()
            .is_applied());
        let object = session.board.canvas.object("c").unwrap().clone();
        assert!(object.user_edited && object.content_revision == 2);
        assert_eq!(object.source_id.as_deref(), AGENT);

        let suggestion = batch(
            "agent-suggestion",
            vec![patch_block(
                "c",
                2,
                comparison_block("c-body", "X 改", None),
            )],
        );
        let first = session
            .apply_canvas_batch(suggestion.clone(), AGENT)
            .unwrap();
        assert_eq!(first.status, CanvasBatchStatus::Proposed);
        assert_eq!(first.targets[0].status, CanvasTargetState::Protected);
        assert_eq!(first.targets[0].actual_revision, Some(2));
        assert_eq!(
            block_of(&session, "c"),
            comparison_block("c-body", "X", Some("y"))
        );
        let replay = session.apply_canvas_batch(suggestion, AGENT).unwrap();
        assert_eq!(replay, first);
        assert_eq!(session.board.canvas.proposals.len(), 3);
        let stale = session
            .apply_canvas_batch(
                batch(
                    "stale",
                    vec![patch_block(
                        "c",
                        1,
                        comparison_block("c-body", "旧版本", None),
                    )],
                ),
                AGENT,
            )
            .unwrap();
        assert_eq!(stale.targets[0].status, CanvasTargetState::Conflict);

        // The user applies the agent's proposal; their own selection survives the model's text.
        assert!(session
            .apply_canvas_proposal("agent-suggestion", vec![])
            .is_err());
        let applied = session
            .apply_canvas_proposal(
                "agent-suggestion",
                vec![read(CanvasTargetKind::Content, "c", 2)],
            )
            .unwrap();
        assert!(applied.is_applied(), "{:?}", applied.targets);
        let object = session.board.canvas.object("c").unwrap();
        assert!(object.user_edited && object.content_revision == 3);
        assert_eq!(
            block_of(&session, "c"),
            comparison_block("c-body", "X 改", Some("y"))
        );
        assert_eq!(
            session
                .board
                .canvas
                .proposal("agent-suggestion")
                .unwrap()
                .result
                .status,
            CanvasBatchStatus::Applied
        );
    }
}

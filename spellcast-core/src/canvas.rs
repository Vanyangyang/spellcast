//! Stable canvas identities and independently versioned presentations of existing content.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;

use crate::canvas_batch::{CanvasProposal, CanvasRead, CanvasTargetKind};
use crate::reply::validate_id;
use crate::{new_id, BoardNode, BoardReply, ReplyBlock, Session, SpellcastError};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum CanvasShape {
    Rect,
    Ellipse,
}

/// Legacy `node`/`reply` variants keep their body in the board; native variants carry it here.
/// The wire form of legacy variants is unchanged: `{"type":"node","id":"…"}`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, JsonSchema)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum CanvasContent {
    Node {
        id: String,
    },
    Reply {
        id: String,
    },
    Text {
        #[serde(default)]
        title: String,
        text: String,
    },
    Image {
        #[serde(default)]
        title: String,
        src: String,
        #[serde(default)]
        alt: String,
    },
    Shape {
        #[serde(default)]
        title: String,
        shape: CanvasShape,
        fill: String,
        #[serde(default)]
        text: String,
    },
    /// One atomic form (text, comparison, graph or sequence) owned by the canvas object
    /// itself. Complete interactive works stay on the artifact path and its reply object.
    Block {
        block: ReplyBlock,
    },
}

/// Decoded size cap for inline `data:` images.
pub const MAX_IMAGE_DATA_BYTES: usize = 2 * 1024 * 1024;

fn check(condition: bool, message: &str) -> Result<(), SpellcastError> {
    if condition {
        Ok(())
    } else {
        Err(SpellcastError::user(message))
    }
}

fn chars_at_most(text: &str, limit: usize, message: &str) -> Result<(), SpellcastError> {
    check(text.chars().count() <= limit, message)
}

pub fn validate_fill(fill: &str) -> Result<(), SpellcastError> {
    let hex = fill.strip_prefix('#').unwrap_or("");
    check(
        (hex.len() == 3 || hex.len() == 6) && hex.bytes().all(|b| b.is_ascii_hexdigit()),
        "填充色只支持 #RGB 或 #RRGGBB。",
    )
}

pub fn validate_image_src(src: &str) -> Result<(), SpellcastError> {
    const UNSUPPORTED: &str = "图片地址只支持 http(s)、/artifacts/{bundleId}/… 本地资源，或 PNG/JPEG/WebP 的 base64 data URL。";
    check(
        !src.is_empty() && !src.chars().any(|c| c.is_control() || c.is_whitespace()),
        UNSUPPORTED,
    )?;
    if let Some(rest) = src.strip_prefix("data:") {
        let (mime, payload) = rest
            .split_once(";base64,")
            .ok_or_else(|| SpellcastError::user(UNSUPPORTED))?;
        check(
            matches!(mime, "image/png" | "image/jpeg" | "image/webp"),
            UNSUPPORTED,
        )?;
        let padding = payload.len() - payload.trim_end_matches('=').len();
        check(
            !payload.is_empty()
                && payload.len().is_multiple_of(4)
                && padding <= 2
                && payload[..payload.len() - padding]
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"+/".contains(&b)),
            UNSUPPORTED,
        )?;
        return check(
            payload.len() / 4 * 3 - padding <= MAX_IMAGE_DATA_BYTES,
            "内嵌图片不能超过 2 MB；请保存为资源文件。",
        );
    }
    check(src.len() <= 2048, "图片地址太长。")?;
    if let Some(rest) = src
        .strip_prefix("http://")
        .or_else(|| src.strip_prefix("https://"))
    {
        return check(
            rest.split('/').next().is_some_and(|host| !host.is_empty()),
            UNSUPPORTED,
        );
    }
    if let Some(rest) = src.strip_prefix("/artifacts/") {
        let mut parts = rest.split('/');
        let bundle = parts.next().unwrap_or("");
        check(bundle != "." && bundle != "..", UNSUPPORTED)?;
        validate_id(bundle)?;
        let tail: Vec<&str> = parts.collect();
        return check(
            !tail.is_empty()
                && tail.iter().all(|s| {
                    !s.is_empty() && *s != "." && *s != ".." && !s.contains(['\\', '%', '?', '#'])
                }),
            "本地资源路径不能为空、包含 .. 或转义片段。",
        );
    }
    Err(SpellcastError::user(UNSUPPORTED))
}

impl CanvasContent {
    /// Compatibility key for legacy placements; native content has none.
    pub fn legacy_id(&self) -> Option<String> {
        match self {
            Self::Node { id } => Some(format!("node:{id}")),
            Self::Reply { id } => Some(format!("reply:{id}")),
            _ => None,
        }
    }

    pub fn is_legacy(&self) -> bool {
        matches!(self, Self::Node { .. } | Self::Reply { .. })
    }

    pub fn kind_name(&self) -> &'static str {
        match self {
            Self::Node { .. } => "node",
            Self::Reply { .. } => "reply",
            Self::Text { .. } => "text",
            Self::Image { .. } => "image",
            Self::Shape { .. } => "shape",
            Self::Block { .. } => "block",
        }
    }

    /// Artifact blocks keep their bundle/state lifecycle on the reply path; a block object
    /// only carries the four atomic forms.
    pub fn validate_block(block: &ReplyBlock) -> Result<(), SpellcastError> {
        check(
            !matches!(block, ReplyBlock::Artifact { .. }),
            "完整作品请继续使用 artifact 工具及其回复对象；内容块对象只承载文字、对照、关系图和分镜。",
        )?;
        block.validate()
    }

    /// Native bodies are validated here; legacy bodies keep their own validation.
    pub fn validate(&self) -> Result<(), SpellcastError> {
        const TITLE: &str = "标题最多 160 字。";
        match self {
            Self::Node { id } | Self::Reply { id } => validate_id(id),
            Self::Text { title, text } => {
                chars_at_most(title, 160, TITLE)?;
                check(!text.trim().is_empty(), "文字对象需要有正文。")?;
                chars_at_most(text, 64_000, "文字对象最多 64000 字；请拆成几个对象。")
            }
            Self::Image { title, src, alt } => {
                chars_at_most(title, 160, TITLE)?;
                chars_at_most(alt, 4_000, "图片说明最多 4000 字。")?;
                validate_image_src(src)
            }
            Self::Shape {
                title, fill, text, ..
            } => {
                chars_at_most(title, 160, TITLE)?;
                chars_at_most(text, 4_000, "图形文字最多 4000 字。")?;
                validate_fill(fill)
            }
            Self::Block { block } => Self::validate_block(block),
        }
    }

    pub(crate) fn default_size(&self) -> (f64, f64) {
        match self {
            Self::Reply { .. } => (640.0, 560.0),
            Self::Image { .. } => (480.0, 360.0),
            Self::Shape { .. } => (240.0, 160.0),
            Self::Node { .. } | Self::Text { .. } => (380.0, 300.0),
            Self::Block { block } => match block {
                ReplyBlock::Text { .. } => (380.0, 300.0),
                ReplyBlock::Comparison { .. } => (640.0, 400.0),
                ReplyBlock::Graph { .. } => (640.0, 480.0),
                ReplyBlock::Sequence { .. } => (480.0, 420.0),
                ReplyBlock::Artifact { .. } => (640.0, 560.0),
            },
        }
    }
}

/// One declared output on an artifact-backed reply block.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash, JsonSchema)]
pub struct CanvasOutputRef {
    pub object_id: String,
    pub block_id: String,
    pub port: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash, JsonSchema)]
pub struct CanvasInputRef {
    #[serde(default)]
    pub block_id: Option<String>,
    pub port: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash, JsonSchema)]
pub struct CanvasBinding {
    pub from: CanvasOutputRef,
    pub to: CanvasInputRef,
}

/// The content reference adapts legacy storage; it is not the object's identity.
/// Recorded organization context, separate from content ownership and delivery authority.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, JsonSchema)]
pub struct CanvasOrigin {
    pub cwd: String,
    #[serde(default)]
    pub thread_id: Option<String>,
    #[serde(default)]
    pub source_id: Option<String>,
    #[serde(default)]
    pub label: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, JsonSchema)]
pub struct CanvasObject {
    pub id: String,
    pub content: CanvasContent,
    pub content_revision: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub origin: Option<CanvasOrigin>,
    /// Declarative connections only; current runtime values are never persisted here.
    #[serde(default)]
    pub bindings: Vec<CanvasBinding>,
    /// Owning task for native content; mirrored from the node/reply for legacy content.
    #[serde(default)]
    pub source_id: Option<String>,
    /// Set when the user edited the body; agents then only get a protected proposal.
    #[serde(default)]
    pub user_edited: bool,
}

/// A stable group of objects or nested compositions. Each member has at most one parent.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, JsonSchema)]
pub struct CanvasComposition {
    pub id: String,
    #[serde(default)]
    pub revision: u64,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub description: String,
    pub members: Vec<String>,
    #[serde(default)]
    pub source_id: Option<String>,
    #[serde(default)]
    pub user_modified: bool,
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum CanvasAppearance {
    Plain,
    #[default]
    Card,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, JsonSchema)]
pub struct CanvasPlacement {
    /// A stable canvas object ID. Legacy node:/reply: keys are accepted at the boundary.
    pub item_id: String,
    #[serde(default)]
    pub revision: u64,
    #[serde(default)]
    pub z: i32,
    #[serde(default)]
    pub removed: bool,
    #[serde(default)]
    pub appearance: CanvasAppearance,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    /// Set when the user moved, resized, restyled or hid this presentation.
    #[serde(default)]
    pub user_modified: bool,
}

impl CanvasPlacement {
    pub(crate) fn validate(&self) -> Result<(), SpellcastError> {
        crate::reply::validate_id(&self.item_id)?;
        if !self.x.is_finite()
            || !self.y.is_finite()
            || self.x.abs() > 1_000_000.0
            || self.y.abs() > 1_000_000.0
            || !self.width.is_finite()
            || !self.height.is_finite()
            || !(48.0..=2400.0).contains(&self.width)
            || !(48.0..=2400.0).contains(&self.height)
            || self.z.abs_diff(0) > 1_000_000
        {
            return Err(SpellcastError::user("画布位置或尺寸超出可用范围。"));
        }
        Ok(())
    }

    pub(crate) fn overlaps(&self, other: &Self) -> bool {
        self.x < other.x + other.width + 48.0
            && self.x + self.width + 48.0 > other.x
            && self.y < other.y + other.height + 48.0
            && self.y + self.height + 48.0 > other.y
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
pub struct CanvasLayout {
    #[serde(default)]
    pub revision: u64,
    #[serde(default)]
    pub objects: Vec<CanvasObject>,
    #[serde(default)]
    pub items: Vec<CanvasPlacement>,
    #[serde(default)]
    pub compositions: Vec<CanvasComposition>,
    /// Pending proposals plus applied/dismissed receipts, located by request_id.
    #[serde(default)]
    pub proposals: Vec<CanvasProposal>,
}

#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct CanvasPatch {
    /// Compatibility lock for old clients. New clients use each placement's revision.
    #[serde(default)]
    pub expected_revision: Option<u64>,
    pub items: Vec<CanvasPlacement>,
}

impl CanvasLayout {
    pub fn object(&self, id: &str) -> Option<&CanvasObject> {
        self.objects.iter().find(|object| object.id == id)
    }

    pub fn object_for(&self, content: &CanvasContent) -> Option<&CanvasObject> {
        self.objects
            .iter()
            .find(|object| &object.content == content)
    }

    fn resolve(&self, id: &str) -> Option<&CanvasObject> {
        self.object(id).or_else(|| {
            self.objects
                .iter()
                .find(|object| object.content.legacy_id().as_deref() == Some(id))
        })
    }

    pub fn placement(&self, object_id: &str) -> Option<&CanvasPlacement> {
        self.items.iter().find(|item| item.item_id == object_id)
    }

    pub fn composition(&self, id: &str) -> Option<&CanvasComposition> {
        self.compositions
            .iter()
            .find(|composition| composition.id == id)
    }

    /// The single composition that lists `member_id`, if any.
    pub fn parent_of(&self, member_id: &str) -> Option<&CanvasComposition> {
        self.compositions
            .iter()
            .find(|composition| composition.members.iter().any(|m| m == member_id))
    }

    /// Whether `target` is reachable from `from` through nested composition members.
    pub fn composition_reaches(&self, from: &str, target: &str) -> bool {
        let mut stack = vec![from.to_string()];
        let mut seen = HashSet::new();
        while let Some(id) = stack.pop() {
            if id == target {
                return true;
            }
            if !seen.insert(id.clone()) {
                continue;
            }
            if let Some(composition) = self.composition(&id) {
                stack.extend(composition.members.iter().cloned());
            }
        }
        false
    }

    pub fn revision_of(&self, kind: CanvasTargetKind, id: &str) -> Option<u64> {
        match kind {
            CanvasTargetKind::Content => self.object(id).map(|object| object.content_revision),
            CanvasTargetKind::Presentation => self
                .object(id)
                .and_then(|object| self.placement(&object.id))
                .map(|item| item.revision),
            CanvasTargetKind::Composition => {
                self.composition(id).map(|composition| composition.revision)
            }
        }
    }

    pub fn proposal(&self, request_id: &str) -> Option<&CanvasProposal> {
        self.proposals
            .iter()
            .find(|proposal| proposal.request.request_id == request_id)
    }

    pub(crate) fn next_z(&self) -> i32 {
        self.items
            .iter()
            .map(|item| item.z)
            .max()
            .unwrap_or(-1)
            .saturating_add(1)
    }

    /// Scan three columns from the item's own start without moving existing cards.
    pub(crate) fn place_free(&self, item: &mut CanvasPlacement) {
        let (start_x, start_y) = (item.x, item.y);
        let mut slot = 0;
        // ponytail: add a spatial index only if large boards make initial placement slow.
        while self
            .items
            .iter()
            .any(|p| !p.removed && p.item_id != item.item_id && item.overlaps(p))
        {
            slot += 1;
            item.x = start_x + (slot % 3) as f64 * (item.width + 80.0);
            item.y = start_y + (slot / 3) as f64 * (item.height + 80.0);
        }
    }

    /// Drop members whose object or composition is gone; compositions left empty are removed too.
    /// Affected compositions get a new revision. Hiding a presentation never reaches here.
    pub(crate) fn purge_dangling_members(&mut self) -> bool {
        let mut changed = false;
        loop {
            let ids: HashSet<String> = self
                .objects
                .iter()
                .map(|object| object.id.clone())
                .chain(
                    self.compositions
                        .iter()
                        .map(|composition| composition.id.clone()),
                )
                .collect();
            for composition in &mut self.compositions {
                let before = composition.members.len();
                composition.members.retain(|member| ids.contains(member));
                if composition.members.len() != before {
                    composition.revision += 1;
                    changed = true;
                }
            }
            let before = self.compositions.len();
            self.compositions
                .retain(|composition| !composition.members.is_empty());
            if self.compositions.len() == before {
                break;
            }
            changed = true;
        }
        changed
    }

    /// Native objects are kept as they are; legacy objects follow their node/reply.
    pub fn sync(&mut self, nodes: &[BoardNode], replies: &[BoardReply]) -> bool {
        let keys: Vec<_> = nodes
            .iter()
            .map(|n| {
                (
                    CanvasContent::Node { id: n.id.clone() },
                    n.revision,
                    None,
                    n.source_id.clone(),
                )
            })
            .chain(replies.iter().map(|r| {
                (
                    CanvasContent::Reply { id: r.id.clone() },
                    r.revision,
                    r.origin_node_id
                        .as_ref()
                        .map(|id| CanvasContent::Node { id: id.clone() }),
                    Some(r.source_id.clone()),
                )
            }))
            .collect();
        let before = self.objects.len();
        self.objects.retain(|object| {
            !object.content.is_legacy()
                || keys
                    .iter()
                    .any(|(content, _, _, _)| content == &object.content)
        });
        let mut changed = self.objects.len() != before;
        for (content, content_revision, origin, source_id) in keys {
            let id = if let Some(object) = self
                .objects
                .iter_mut()
                .find(|object| object.content == content)
            {
                if object.content_revision != content_revision {
                    object.content_revision = content_revision;
                    changed = true;
                }
                if object.source_id != source_id {
                    object.source_id = source_id;
                    changed = true;
                }
                object.id.clone()
            } else {
                let id = new_id();
                self.objects.push(CanvasObject {
                    id: id.clone(),
                    content: content.clone(),
                    content_revision,
                    origin: None,
                    bindings: vec![],
                    source_id,
                    user_edited: false,
                });
                changed = true;
                id
            };
            let legacy_id = content.legacy_id();
            if let Some((index, item)) = self
                .items
                .iter_mut()
                .enumerate()
                .find(|(_, p)| Some(&p.item_id) == legacy_id.as_ref())
            {
                item.item_id = id.clone();
                item.revision = 1;
                item.z = index as i32;
                changed = true;
            }
            if self.items.iter().any(|p| p.item_id == id) {
                continue;
            }
            let (width, height) = content.default_size();
            let mut item = CanvasPlacement {
                item_id: id,
                revision: 1,
                z: self.next_z(),
                removed: false,
                appearance: CanvasAppearance::Plain,
                x: 48.0,
                y: 48.0,
                width,
                height,
                user_modified: false,
            };
            if let Some(parent) = origin
                .and_then(|content| self.object_for(&content))
                .and_then(|object| {
                    self.items
                        .iter()
                        .find(|p| p.item_id == object.id && !p.removed)
                })
            {
                item.x = parent.x + parent.width + 80.0;
                item.y = parent.y;
            }
            self.place_free(&mut item);
            self.items.push(item);
            changed = true;
        }
        let before = self.items.len();
        self.items
            .retain(|item| self.objects.iter().any(|object| object.id == item.item_id));
        changed |= self.items.len() != before;
        changed |= self.purge_dangling_members();
        if changed {
            self.revision += 1;
        }
        changed
    }
}

impl Session {
    /// Resolve a canonical object target and reject contradictory compatibility aliases.
    pub fn canvas_target(
        &self,
        object_id: &str,
        reply_id: Option<&str>,
        node_id: Option<&str>,
    ) -> Result<CanvasContent, SpellcastError> {
        let object = self
            .board
            .canvas
            .object(object_id)
            .ok_or_else(|| SpellcastError::user("画布内容对象不存在，请重新读取画布。"))?;
        let agrees = match &object.content {
            CanvasContent::Reply { id } => {
                node_id.is_none() && reply_id.is_none_or(|alias| alias.is_empty() || alias == id)
            }
            CanvasContent::Node { id } => {
                reply_id.is_none() && node_id.is_none_or(|alias| alias.is_empty() || alias == id)
            }
            _ => reply_id.is_none_or(str::is_empty) && node_id.is_none_or(str::is_empty),
        };
        if !agrees {
            return Err(SpellcastError::user("对象身份与旧内容引用不一致。"));
        }
        Ok(object.content.clone())
    }

    pub fn canvas_reply_id(
        &self,
        object_id: Option<&str>,
        reply_id: &str,
    ) -> Result<String, SpellcastError> {
        let Some(object_id) = object_id else {
            return Ok(reply_id.to_string());
        };
        match self.canvas_target(object_id, (!reply_id.is_empty()).then_some(reply_id), None)? {
            CanvasContent::Reply { id } => Ok(id),
            CanvasContent::Node { .. } => {
                Err(SpellcastError::user("这个对象是想法，请使用想法编辑入口。"))
            }
            _ => Err(SpellcastError::user(
                "这个对象不是回复，请使用画布批量修改入口。",
            )),
        }
    }

    pub fn remove_canvas_item(
        &mut self,
        item_id: &str,
        expected_revision: u64,
    ) -> Result<(), SpellcastError> {
        self.set_canvas_removed(item_id, expected_revision, true)
    }

    pub fn set_canvas_removed(
        &mut self,
        item_id: &str,
        expected_revision: u64,
        removed: bool,
    ) -> Result<(), SpellcastError> {
        let object = self
            .board
            .canvas
            .resolve(item_id)
            .ok_or_else(|| SpellcastError::user("画布对象不存在。"))?
            .clone();
        let item = self
            .board
            .canvas
            .items
            .iter_mut()
            .find(|item| item.item_id == object.id)
            .ok_or_else(|| SpellcastError::user("画布呈现不存在。"))?;
        // Existing node:/reply: callers retain their old content-version guard.
        let actual_revision = if item_id == object.id {
            item.revision
        } else {
            object.content_revision
        };
        if actual_revision != expected_revision {
            return Err(SpellcastError::user(
                "对象呈现已经更新，请查看最新位置后重试。",
            ));
        }
        if item.removed != removed {
            item.removed = removed;
            item.revision += 1;
            item.user_modified = true;
            self.board.canvas.revision += 1;
        }
        Ok(())
    }

    /// Explicit content deletion is separate from hiding a presentation. The object leaves
    /// every composition it belonged to; those compositions get a new revision.
    pub fn delete_canvas_content(
        &mut self,
        object_id: &str,
        expected_revision: u64,
        current: &[CanvasRead],
    ) -> Result<(), SpellcastError> {
        let object = self
            .board
            .canvas
            .object(object_id)
            .ok_or_else(|| SpellcastError::user("画布内容对象不存在。"))?
            .clone();
        if object.content_revision != expected_revision {
            return Err(SpellcastError::user(
                "对象内容已经更新，请重新读取后再删除。",
            ));
        }
        check(current.len() <= 128, "删除内容最多声明 128 个组合版本。")?;
        let mut declared = HashSet::new();
        for read in current {
            check(
                read.kind == CanvasTargetKind::Composition
                    && declared.insert(read.id.as_str())
                    && self.board.canvas.revision_of(read.kind, &read.id) == Some(read.revision),
                "组合已经变化，请重新查看后再彻底删除内容。",
            )?;
        }
        let mut member = object_id;
        let mut parents = HashSet::new();
        while let Some(parent) = self.board.canvas.parent_of(member) {
            check(
                parents.insert(parent.id.as_str()) && declared.contains(parent.id.as_str()),
                "彻底删除会改变所属组合，请一并声明这些组合的当前版本。",
            )?;
            member = &parent.id;
        }
        match object.content {
            CanvasContent::Node { id } => {
                self.remove_node(&id)?;
            }
            CanvasContent::Reply { id } => self.board.replies.retain(|reply| reply.id != id),
            _ => {
                let canvas = &mut self.board.canvas;
                canvas.objects.retain(|o| o.id != object.id);
                canvas.items.retain(|item| item.item_id != object.id);
                canvas.revision += 1;
            }
        }
        self.sync_canvas();
        Ok(())
    }

    pub fn sync_canvas(&mut self) -> bool {
        self.board
            .canvas
            .sync(&self.board.nodes, &self.board.replies)
    }

    pub fn patch_canvas(&mut self, patch: CanvasPatch) -> Result<CanvasLayout, SpellcastError> {
        if patch
            .expected_revision
            .is_some_and(|revision| revision != self.board.canvas.revision)
        {
            return Err(SpellcastError::user(
                "画布布局已经更新，请保留当前位置并重新读取布局。",
            ));
        }
        if patch.items.is_empty() || patch.items.len() > 64 {
            return Err(SpellcastError::user("一次可保存 1–64 个画布对象的位置。"));
        }
        let mut seen = HashSet::new();
        let mut changes = Vec::new();
        for mut item in patch.items {
            item.validate()?;
            let object = self
                .board
                .canvas
                .resolve(&item.item_id)
                .ok_or_else(|| SpellcastError::user("画布对象不存在。"))?;
            let current = self
                .board
                .canvas
                .items
                .iter()
                .find(|p| p.item_id == object.id)
                .ok_or_else(|| SpellcastError::user("画布呈现不存在。"))?;
            if !seen.insert(object.id.clone()) {
                return Err(SpellcastError::user("画布对象不存在或重复。"));
            }
            if item.item_id != object.id && patch.expected_revision.is_some() {
                // Old layout patches only carried geometry; preserve new presentation fields.
                item.revision = current.revision;
                item.z = current.z;
                item.removed = current.removed;
                item.appearance = current.appearance;
            }
            if item.revision != current.revision || item.removed != current.removed {
                return Err(SpellcastError::user(
                    "对象呈现已经更新，请保留本地修改并重新读取。",
                ));
            }
            item.item_id = object.id.clone();
            // This entry point is the user's; a real change marks the presentation as theirs.
            item.user_modified = current.user_modified;
            if &item != current {
                item.revision += 1;
                item.user_modified = true;
                changes.push(item);
            }
        }
        if !changes.is_empty() {
            self.board.canvas.revision += 1;
        }
        for item in changes {
            let current = self
                .board
                .canvas
                .items
                .iter_mut()
                .find(|p| p.item_id == item.item_id)
                .unwrap();
            *current = item;
        }
        Ok(self.board.canvas.clone())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::NodeDraft;

    #[test]
    fn successive_replies_fill_columns_instead_of_a_long_strip() {
        let mut layout = CanvasLayout::default();
        let mut replies = Vec::new();
        for i in 0..9 {
            let before = layout.items.clone();
            replies.push(BoardReply {
                id: format!("reply-{i}"),
                source_id: "source".into(),
                source_label: String::new(),
                origin_node_id: None,
                title: format!("Card {i}"),
                blocks: vec![],
                revision: 1,
                created_at_ms: 0,
                updated_at_ms: 0,
            });
            layout.sync(&[], &replies);
            assert_eq!(&layout.items[..before.len()], before.as_slice());
        }
        assert_eq!(layout.items[2].y, layout.items[0].y);
        assert!(layout.items[2].x > layout.items[0].x);
        assert_eq!(layout.items[3].x, layout.items[0].x);
        assert_eq!(layout.items[8].y, 1328.0);
        for (i, item) in layout.items.iter().enumerate() {
            assert!(!layout.items[i + 1..]
                .iter()
                .any(|other| item.overlaps(other)));
        }
    }

    #[test]
    fn new_content_does_not_rearrange_user_placements_and_invalid_patches_are_atomic() {
        let mut session = Session::default();
        session.add_node(NodeDraft {
            title: "保留位置".into(),
            ..Default::default()
        });
        session.sync_canvas();
        let mut item = session.board.canvas.items[0].clone();
        item.x = 720.0;
        item.y = -40.0;
        session
            .patch_canvas(CanvasPatch {
                expected_revision: Some(1),
                items: vec![item.clone()],
            })
            .unwrap();
        item.revision += 1;
        item.user_modified = true;
        session.add_node(NodeDraft {
            title: "新增内容".into(),
            ..Default::default()
        });
        session.sync_canvas();
        assert_eq!(session.board.canvas.items[0], item);
        let before = session.board.canvas.clone();
        let mut invalid = item.clone();
        invalid.height = f64::NAN;
        assert!(session
            .patch_canvas(CanvasPatch {
                expected_revision: Some(before.revision),
                items: vec![item.clone(), invalid]
            })
            .is_err());
        assert_eq!(session.board.canvas, before);
        assert!(session
            .patch_canvas(CanvasPatch {
                expected_revision: Some(1),
                items: vec![item]
            })
            .is_err());
    }

    #[test]
    fn legacy_identity_migrates_once_and_removed_content_restores_in_place() {
        let mut session = Session::default();
        let node = session.add_node(NodeDraft {
            title: "旧内容".into(),
            ..Default::default()
        });
        session.board.canvas = serde_json::from_value(serde_json::json!({
            "revision": 7,
            "items": [{"item_id": format!("node:{}", node.id), "x": -60.0, "y": 90.0, "width": 310.0, "height": 270.0}]
        })).unwrap();
        assert!(session.sync_canvas());
        let object = session.board.canvas.objects[0].clone();
        let initial = session.board.canvas.items[0].clone();
        assert_ne!(object.id, format!("node:{}", node.id));
        assert_eq!(initial.item_id, object.id);
        assert_eq!(
            (initial.x, initial.y, initial.width, initial.height),
            (-60.0, 90.0, 310.0, 270.0)
        );
        assert_eq!(initial.appearance, CanvasAppearance::Card);
        assert!(!session.sync_canvas());
        session
            .remove_canvas_item(&object.id, initial.revision)
            .unwrap();
        assert_eq!(session.board.nodes.len(), 1);
        let mut reloaded: Session =
            serde_json::from_str(&serde_json::to_string(&session).unwrap()).unwrap();
        assert!(!reloaded.sync_canvas());
        assert!(reloaded.board.canvas.items[0].removed);
        assert_eq!(reloaded.board.canvas.objects[0], object);
        assert!(reloaded
            .set_canvas_removed(&object.id, initial.revision, false)
            .is_err());
        reloaded
            .set_canvas_removed(&object.id, initial.revision + 1, false)
            .unwrap();
        let restored = &reloaded.board.canvas.items[0];
        assert!(!restored.removed);
        assert_eq!(
            (
                restored.x,
                restored.y,
                restored.width,
                restored.height,
                restored.z
            ),
            (
                initial.x,
                initial.y,
                initial.width,
                initial.height,
                initial.z
            )
        );
        assert_eq!(restored.revision, initial.revision + 2);
        assert!(reloaded
            .canvas_target(&object.id, Some("wrong-reply"), None)
            .is_err());
        reloaded
            .delete_canvas_content(&object.id, object.content_revision, &[])
            .unwrap();
        assert!(reloaded.board.nodes.is_empty());
        assert!(reloaded.board.canvas.items.is_empty());
        assert!(reloaded.board.canvas.objects.is_empty());
    }

    #[test]
    fn persisted_objects_without_bindings_keep_their_identity_and_content_state() {
        let object: CanvasObject = serde_json::from_value(serde_json::json!({
            "id": "stable-object",
            "content": {"type": "text", "title": "Title", "text": "Body"},
            "content_revision": 7,
            "source_id": "codex:one",
            "user_edited": true
        }))
        .unwrap();
        assert_eq!(object.id, "stable-object");
        assert_eq!(object.content_revision, 7);
        assert_eq!(
            object.content,
            CanvasContent::Text {
                title: "Title".into(),
                text: "Body".into()
            }
        );
        assert!(object.bindings.is_empty() && object.user_edited);
    }

    #[test]
    fn presentation_versions_are_independent_of_content_and_conflicts_are_atomic() {
        let mut session = Session::default();
        for title in ["A", "B"] {
            session.add_node(NodeDraft {
                title: title.into(),
                ..Default::default()
            });
        }
        session.sync_canvas();
        let mut items = session.board.canvas.items.clone();
        session.board.nodes[1].body = "外部内容编辑".into();
        session.board.nodes[1].revision += 1;
        session.sync_canvas();
        items[0].width = 80.0;
        session
            .patch_canvas(CanvasPatch {
                expected_revision: None,
                items: vec![items[0].clone()],
            })
            .unwrap();
        assert_eq!(session.board.canvas.items[0].width, 80.0);
        let before = session.board.canvas.clone();
        items[1].x = 999.0;
        assert!(session
            .patch_canvas(CanvasPatch {
                expected_revision: None,
                items
            })
            .is_err());
        assert_eq!(session.board.canvas, before);
    }
}

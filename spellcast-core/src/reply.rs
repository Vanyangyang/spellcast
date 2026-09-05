//! A board reply is a versioned document. Its blocks keep their meaning across layouts.

use std::collections::HashSet;

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::inbox::now_ms;
use crate::{new_id, Session, SpellcastError};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, JsonSchema)]
pub struct ReplyOption {
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub summary: String,
    pub values: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, JsonSchema)]
pub struct ReplyGraphNode {
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub detail: String,
    #[serde(default)]
    pub x: Option<f64>,
    #[serde(default)]
    pub y: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, JsonSchema)]
pub struct ReplyGraphEdge {
    pub id: String,
    pub from: String,
    pub to: String,
    pub label: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, JsonSchema)]
pub struct ReplyStep {
    pub id: String,
    pub title: String,
    pub action: String,
    #[serde(default)]
    pub feedback: String,
    #[serde(default)]
    pub note: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, JsonSchema)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ReplyBlock {
    Text {
        id: String,
        #[serde(default)]
        title: String,
        text: String,
    },
    Comparison {
        id: String,
        #[serde(default)]
        title: String,
        criteria: Vec<String>,
        options: Vec<ReplyOption>,
        #[serde(default)]
        selected_id: Option<String>,
    },
    Graph {
        id: String,
        #[serde(default)]
        title: String,
        nodes: Vec<ReplyGraphNode>,
        edges: Vec<ReplyGraphEdge>,
    },
    Sequence {
        id: String,
        #[serde(default)]
        title: String,
        steps: Vec<ReplyStep>,
    },
}

fn check(condition: bool, message: &str) -> Result<(), SpellcastError> {
    if condition {
        Ok(())
    } else {
        Err(SpellcastError::user(message))
    }
}

pub fn validate_id(value: &str) -> Result<(), SpellcastError> {
    check(
        !value.is_empty()
            && value.len() <= 160
            && value
                .chars()
                .all(|ch| ch.is_ascii_alphanumeric() || "-_:.".contains(ch)),
        "标识需要是 1–160 个字母、数字、短横线、下划线、冒号或点。",
    )
}

fn unique_ids<'a>(
    ids: impl IntoIterator<Item = &'a str>,
) -> Result<HashSet<&'a str>, SpellcastError> {
    let mut seen = HashSet::new();
    for id in ids {
        validate_id(id)?;
        check(seen.insert(id), "同一区域内不能有重复的标识。")?;
    }
    Ok(seen)
}

fn text_limit(text: &str, limit: usize) -> Result<(), SpellcastError> {
    check(
        text.chars().count() <= limit,
        "内容太长，请拆成几个独立的回复块。",
    )
}

impl ReplyBlock {
    pub fn id(&self) -> &str {
        match self {
            Self::Text { id, .. }
            | Self::Comparison { id, .. }
            | Self::Graph { id, .. }
            | Self::Sequence { id, .. } => id,
        }
    }

    pub fn title(&self) -> &str {
        match self {
            Self::Text { title, .. }
            | Self::Comparison { title, .. }
            | Self::Graph { title, .. }
            | Self::Sequence { title, .. } => title,
        }
    }

    pub fn validate(&self) -> Result<(), SpellcastError> {
        validate_id(self.id())?;
        text_limit(self.title(), 160)?;
        match self {
            Self::Text { text, .. } => {
                check(!text.trim().is_empty(), "文字块需要有正文。")?;
                text_limit(text, 64_000)?;
            }
            Self::Comparison {
                criteria,
                options,
                selected_id,
                ..
            } => {
                check(
                    (1..=8).contains(&criteria.len()),
                    "对照需要 1–8 个共同维度。",
                )?;
                check((2..=8).contains(&options.len()), "对照需要 2–8 个方案。")?;
                for criterion in criteria {
                    check(!criterion.trim().is_empty(), "对照维度不能为空。")?;
                    text_limit(criterion, 120)?;
                }
                let ids = unique_ids(options.iter().map(|item| item.id.as_str()))?;
                for option in options {
                    check(!option.title.trim().is_empty(), "每个方案需要一个名称。")?;
                    check(
                        option.values.len() == criteria.len(),
                        "每个方案需要对应同一组比较维度。",
                    )?;
                    text_limit(&option.title, 160)?;
                    text_limit(&option.summary, 4_000)?;
                    for value in &option.values {
                        text_limit(value, 4_000)?;
                    }
                }
                if let Some(selected) = selected_id {
                    check(
                        ids.contains(selected.as_str()),
                        "选中的方案不在这个对照块里。",
                    )?;
                }
            }
            Self::Graph { nodes, edges, .. } => {
                check(
                    (1..=40).contains(&nodes.len()) && edges.len() <= 80,
                    "一个关系图支持 1–40 个节点和最多 80 条关系；请把大图拆开。",
                )?;
                let ids = unique_ids(nodes.iter().map(|node| node.id.as_str()))?;
                unique_ids(edges.iter().map(|edge| edge.id.as_str()))?;
                for node in nodes {
                    check(!node.title.trim().is_empty(), "图节点需要一个名称。")?;
                    text_limit(&node.title, 160)?;
                    text_limit(&node.detail, 8_000)?;
                    check(
                        node.x.is_some() == node.y.is_some(),
                        "图节点的位置需要同时包含横纵坐标。",
                    )?;
                    for coordinate in [node.x, node.y].into_iter().flatten() {
                        check(
                            coordinate.is_finite() && coordinate.abs() <= 100_000.0,
                            "图节点坐标超出可用范围。",
                        )?;
                    }
                }
                for edge in edges {
                    check(
                        ids.contains(edge.from.as_str()) && ids.contains(edge.to.as_str()),
                        "关系必须连接本图内存在的节点。",
                    )?;
                    check(!edge.label.trim().is_empty(), "请说明每条关系的含义。")?;
                    text_limit(&edge.label, 160)?;
                }
            }
            Self::Sequence { steps, .. } => {
                check(
                    (1..=40).contains(&steps.len()),
                    "一组分镜支持 1–40 个步骤。",
                )?;
                unique_ids(steps.iter().map(|step| step.id.as_str()))?;
                for step in steps {
                    check(
                        !step.title.trim().is_empty() && !step.action.trim().is_empty(),
                        "每一步需要标题和动作或内容。",
                    )?;
                    text_limit(&step.title, 160)?;
                    for text in [&step.action, &step.feedback, &step.note] {
                        text_limit(text, 8_000)?;
                    }
                }
            }
        }
        Ok(())
    }

    pub fn same_content(&self, other: &Self) -> bool {
        let mut left = self.clone();
        let mut right = other.clone();
        for block in [&mut left, &mut right] {
            if let Self::Graph { nodes, .. } = block {
                for node in nodes {
                    node.x = None;
                    node.y = None;
                }
            }
        }
        left == right
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, JsonSchema)]
pub struct BoardReply {
    pub id: String,
    pub source_id: String,
    pub source_label: String,
    #[serde(default)]
    pub origin_node_id: Option<String>,
    pub title: String,
    pub blocks: Vec<ReplyBlock>,
    pub revision: u64,
    pub created_at_ms: u64,
    pub updated_at_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ReplyRequest {
    /// Omit for a new reply. Reuse the returned id to revise this same document.
    #[serde(default)]
    pub id: Option<String>,
    /// Stable source task id, e.g. codex:thread-123; reuse it for bubbles and listening.
    pub source_id: String,
    #[serde(default)]
    pub source_label: Option<String>,
    /// The adopted fragment this reply develops.
    #[serde(default)]
    pub origin_node_id: Option<String>,
    pub title: String,
    pub blocks: Vec<ReplyBlock>,
    /// Required for existing replies; read the latest board before editing.
    #[serde(default)]
    pub expected_revision: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ReplyPatchRequest {
    pub reply_id: String,
    pub expected_revision: u64,
    pub block: ReplyBlock,
    #[serde(default)]
    pub layout_only: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ReplyAction {
    Select,
    Ask,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ReplyActionInput {
    pub reply_id: String,
    pub block_id: String,
    pub action: ReplyAction,
    #[serde(default)]
    pub option_id: Option<String>,
    #[serde(default)]
    pub text: Option<String>,
}

fn validate_blocks(blocks: &[ReplyBlock]) -> Result<(), SpellcastError> {
    check(
        (1..=32).contains(&blocks.len()),
        "一块回复需要 1–32 个内容块。",
    )?;
    unique_ids(blocks.iter().map(ReplyBlock::id))?;
    for block in blocks {
        block.validate()?;
    }
    let bytes = serde_json::to_vec(blocks)?;
    check(bytes.len() <= 512_000, "这块回复太大了，请拆成几个区域。")
}

fn revision_matches(actual: u64, expected: Option<u64>) -> Result<(), SpellcastError> {
    check(
        expected == Some(actual),
        "这块回复已经更新。请保留你的草稿，读取最新内容后再修改。",
    )
}

impl Session {
    pub fn write_reply(&mut self, req: ReplyRequest) -> Result<BoardReply, SpellcastError> {
        validate_id(&req.source_id)?;
        check(!req.title.trim().is_empty(), "回复需要一个标题。")?;
        text_limit(&req.title, 160)?;
        validate_blocks(&req.blocks)?;
        if let Some(origin) = &req.origin_node_id {
            check(
                self.board.nodes.iter().any(|node| &node.id == origin),
                "来源碎片已经不在板上。",
            )?;
        }
        let id = req.id.unwrap_or_else(new_id);
        validate_id(&id)?;
        let label = req
            .source_label
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| req.source_id.clone());
        text_limit(&label, 160)?;
        let now = now_ms();
        if let Some(existing) = self.board.replies.iter_mut().find(|reply| reply.id == id) {
            check(
                existing.source_id == req.source_id,
                "这块回复属于另一个任务。",
            )?;
            revision_matches(existing.revision, req.expected_revision)?;
            existing.title = req.title;
            existing.blocks = req.blocks;
            existing.source_label = label;
            if req.origin_node_id.is_some() {
                existing.origin_node_id = req.origin_node_id;
            }
            existing.revision += 1;
            existing.updated_at_ms = now;
            return Ok(existing.clone());
        }
        check(
            req.expected_revision.is_none() || req.expected_revision == Some(0),
            "要修改的回复已经不存在。",
        )?;
        let reply = BoardReply {
            id,
            source_id: req.source_id,
            source_label: label,
            origin_node_id: req.origin_node_id,
            title: req.title,
            blocks: req.blocks,
            revision: 1,
            created_at_ms: now,
            updated_at_ms: now,
        };
        self.board.replies.push(reply.clone());
        Ok(reply)
    }

    pub fn patch_reply(&mut self, req: ReplyPatchRequest) -> Result<BoardReply, SpellcastError> {
        req.block.validate()?;
        let reply = self
            .board
            .replies
            .iter_mut()
            .find(|reply| reply.id == req.reply_id)
            .ok_or_else(|| SpellcastError::user("这块回复已经不在板上。"))?;
        revision_matches(reply.revision, Some(req.expected_revision))?;
        let position = reply
            .blocks
            .iter()
            .position(|block| block.id() == req.block.id())
            .ok_or_else(|| SpellcastError::user("这段内容已经不在回复里。"))?;
        if req.layout_only {
            check(
                matches!(req.block, ReplyBlock::Graph { .. })
                    && reply.blocks[position].same_content(&req.block),
                "只有移动图节点可以作为布局更新。",
            )?;
        }
        let mut next = reply.blocks.clone();
        next[position] = req.block;
        validate_blocks(&next)?;
        reply.blocks = next;
        reply.revision += 1;
        reply.updated_at_ms = now_ms();
        Ok(reply.clone())
    }

    pub fn act_on_reply(
        &mut self,
        req: &ReplyActionInput,
    ) -> Result<(BoardReply, String), SpellcastError> {
        let reply = self
            .board
            .replies
            .iter_mut()
            .find(|reply| reply.id == req.reply_id)
            .ok_or_else(|| SpellcastError::user("这块回复已经不在板上。"))?;
        let block = reply
            .blocks
            .iter_mut()
            .find(|block| block.id() == req.block_id)
            .ok_or_else(|| SpellcastError::user("这段内容已经不在回复里。"))?;
        let text = match req.action {
            ReplyAction::Ask => {
                let text = req.text.as_deref().unwrap_or("").trim();
                check(!text.is_empty(), "先写下你想继续说的话。")?;
                text_limit(text, 4_000)?;
                text.to_string()
            }
            ReplyAction::Select => {
                let ReplyBlock::Comparison {
                    options,
                    selected_id,
                    ..
                } = block
                else {
                    return Err(SpellcastError::user("只有方案对照可以选择一个方案。"));
                };
                let option = options
                    .iter()
                    .find(|option| Some(&option.id) == req.option_id.as_ref())
                    .ok_or_else(|| SpellcastError::user("这个方案已经不存在。"))?;
                *selected_id = Some(option.id.clone());
                reply.revision += 1;
                reply.updated_at_ms = now_ms();
                format!("选择了方案「{}」。", option.title)
            }
        };
        Ok((reply.clone(), text))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request() -> ReplyRequest {
        ReplyRequest {
            id: Some("reply-1".into()),
            source_id: "codex:one".into(),
            source_label: Some("Astra".into()),
            origin_node_id: None,
            title: "完整的想法".into(),
            blocks: vec![ReplyBlock::Text {
                id: "body".into(),
                title: String::new(),
                text: "长内容".repeat(300),
            }],
            expected_revision: None,
        }
    }

    #[test]
    fn complete_text_survives_and_stale_updates_do_not_overwrite_user_edits() {
        let mut session = Session::default();
        let original = session.write_reply(request()).unwrap();
        let patch = ReplyPatchRequest {
            reply_id: original.id.clone(),
            expected_revision: 1,
            block: ReplyBlock::Text {
                id: "body".into(),
                title: String::new(),
                text: "用户的修改".into(),
            },
            layout_only: false,
        };
        let edited = session.patch_reply(patch).unwrap();
        assert_eq!(edited.revision, 2);
        let mut stale = request();
        stale.expected_revision = Some(1);
        assert!(session.write_reply(stale).is_err());
        assert_eq!(session.board.replies[0], edited);
        let ReplyBlock::Text { text, .. } = &original.blocks[0] else {
            panic!()
        };
        assert_eq!(text.chars().count(), 900);
    }

    #[test]
    fn graph_relations_and_layout_edits_are_validated() {
        let graph = ReplyBlock::Graph {
            id: "graph".into(),
            title: String::new(),
            nodes: vec![ReplyGraphNode {
                id: "a".into(),
                title: "A".into(),
                detail: String::new(),
                x: None,
                y: None,
            }],
            edges: vec![ReplyGraphEdge {
                id: "edge".into(),
                from: "a".into(),
                to: "missing".into(),
                label: "导致".into(),
            }],
        };
        assert!(graph.validate().is_err());
        let mut valid = graph.clone();
        if let ReplyBlock::Graph { edges, .. } = &mut valid {
            edges.clear();
        }
        let mut req = request();
        req.blocks = vec![valid.clone()];
        let mut session = Session::default();
        session.write_reply(req).unwrap();
        let mut moved = valid;
        if let ReplyBlock::Graph { nodes, .. } = &mut moved {
            nodes[0].x = Some(90.0);
            nodes[0].y = Some(20.0);
        }
        let patch = ReplyPatchRequest {
            reply_id: "reply-1".into(),
            expected_revision: 1,
            block: moved.clone(),
            layout_only: true,
        };
        session.patch_reply(patch).unwrap();
        if let ReplyBlock::Graph { nodes, .. } = &mut moved {
            nodes[0].title = "偷偷修改".into();
        }
        assert!(session
            .patch_reply(ReplyPatchRequest {
                reply_id: "reply-1".into(),
                expected_revision: 2,
                block: moved,
                layout_only: true
            })
            .is_err());
    }

    #[test]
    fn another_task_cannot_replace_a_reply_and_duplicate_block_ids_fail() {
        let mut session = Session::default();
        session.write_reply(request()).unwrap();
        let mut foreign = request();
        foreign.source_id = "cursor:two".into();
        foreign.expected_revision = Some(1);
        assert!(session.write_reply(foreign).is_err());
        let mut duplicate = request();
        duplicate.id = Some("reply-2".into());
        duplicate.blocks.push(duplicate.blocks[0].clone());
        assert!(session.write_reply(duplicate).is_err());
    }
}

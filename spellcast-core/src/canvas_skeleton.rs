//! Read-only, versioned game-skeleton source carried by a Canvas object.

use schemars::JsonSchema;
use serde::{Deserialize, Deserializer, Serialize};
use std::collections::{BTreeMap, HashMap, HashSet};

use crate::{reply::validate_id, SpellcastError};

const MAX_TEXT: usize = 4 * 1024 * 1024;

fn present<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where D: Deserializer<'de>, T: Deserialize<'de> {
    T::deserialize(deserializer).map(Some)
}

fn invalid(message: &str) -> SpellcastError { SpellcastError::user(message) }
fn text(value: &str, max: usize, total: &mut usize) -> Result<(), SpellcastError> {
    if value.trim().is_empty() || value.len() > max { return Err(invalid("骨架文本为空或过长。")); }
    *total = total.saturating_add(value.len());
    if *total > MAX_TEXT { return Err(invalid("骨架文本总量超过 4 MiB。")); }
    Ok(())
}
fn stable_id(value: &str, total: &mut usize) -> Result<(), SpellcastError> {
    text(value, 120, total)?;
    if !value.bytes().all(|c| c.is_ascii_alphanumeric() || matches!(c, b'_' | b'-' | b'.')) {
        return Err(invalid("骨架节点或阶段 ID 无效。"));
    }
    Ok(())
}
fn hash(value: &str) -> Result<(), SpellcastError> {
    if value.len() != 64 || !value.bytes().all(|c| c.is_ascii_hexdigit()) { return Err(invalid("骨架来源哈希无效。")); }
    Ok(())
}
fn relative_path(value: &str, document: bool) -> bool {
    (!document || (value.starts_with("Assets/Documents/") && value.ends_with(".md")))
        && !value.is_empty() && value.len() <= 2048 && !value.starts_with('/')
        && !value.chars().any(|c| c.is_control() || matches!(c, '\\' | ':' | '<' | '>' | '"' | '|' | '?' | '*'))
        && value.split('/').all(|part| !part.is_empty() && part != "." && part != "..")
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct SkeletonDocument { pub path: String, pub hash: String, #[serde(default, deserialize_with = "present", skip_serializing_if = "Option::is_none")] pub error: Option<String> }

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct SkeletonStep { pub title: String, pub text: String }

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct SkeletonProvenance {
    pub path: String, pub hash: String, pub start_line: u32, pub end_line: u32,
    pub quote: String, #[serde(default, deserialize_with = "present", skip_serializing_if = "Option::is_none")] pub archived: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct SkeletonNode {
    pub id: String, pub kind: String, pub title: String, pub summary: String,
    #[serde(default, deserialize_with = "present", skip_serializing_if = "Option::is_none")] pub parent_id: Option<String>,
    pub state: String,
    #[serde(default, deserialize_with = "present", skip_serializing_if = "Option::is_none")] pub notes: Option<Vec<String>>,
    #[serde(default, deserialize_with = "present", skip_serializing_if = "Option::is_none")] pub steps: Option<Vec<SkeletonStep>>,
    #[serde(default, deserialize_with = "present", skip_serializing_if = "Option::is_none")] pub rule: Option<BTreeMap<String, Vec<String>>>,
    #[serde(default, deserialize_with = "present", skip_serializing_if = "Option::is_none")] pub provenance: Option<Vec<SkeletonProvenance>>,
    pub sources: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct SkeletonRelation { pub from: String, pub to: String, pub label: String }

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct SkeletonLoopStage { pub id: String, pub title: String, pub summary: String, pub node_ids: Vec<String> }

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct GameSkeletonModel {
    pub schema_version: u8, pub title: String, pub description: String,
    pub entry_ids: Vec<String>, #[serde(rename = "loop")] pub loop_stages: Vec<SkeletonLoopStage>,
    pub nodes: Vec<SkeletonNode>, pub relations: Vec<SkeletonRelation>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct CanvasSourceSkeleton {
    pub title: String, pub project_id: String, pub root: String, pub path: String, pub hash: String,
    pub model: GameSkeletonModel, pub documents: Vec<SkeletonDocument>,
}

impl CanvasSourceSkeleton {
    pub fn same_source(&self, other: &Self) -> bool {
        fn normalized_root(root: &str) -> String {
            let slash = root.replace('\\', "/");
            let trimmed = slash.trim_end_matches('/');
            if trimmed.len() >= 3 && trimmed.as_bytes()[0].is_ascii_alphabetic()
                && &trimmed.as_bytes()[1..3] == b":/" { trimmed.to_ascii_lowercase() }
            else { trimmed.to_string() }
        }
        self.project_id == other.project_id
            && normalized_root(&self.root) == normalized_root(&other.root)
            && self.path == other.path
    }

    pub fn validate(&self) -> Result<(), SpellcastError> {
        validate_id(&self.project_id)?;
        let root = self.root.replace('\\', "/");
        let absolute = root.starts_with('/') || (root.len() >= 3 && root.as_bytes()[0].is_ascii_alphabetic()
            && &root.as_bytes()[1..3] == b":/");
        if !absolute || self.root.len() > 2048 || self.root.chars().any(char::is_control)
            || !relative_path(&self.path, false) { return Err(invalid("骨架来源身份无效。")); }
        hash(&self.hash)?;
        let mut total = 0;
        text(&self.title, 160, &mut total)?;
        if self.documents.len() > 3000 { return Err(invalid("骨架文档索引过大。")); }
        let mut docs = HashMap::new();
        for doc in &self.documents {
            if !relative_path(&doc.path, true) || doc.path.len() > 512 || docs.insert(doc.path.as_str(), doc).is_some() {
                return Err(invalid("骨架文档索引路径无效或重复。"));
            }
            hash(&doc.hash)?;
            if let Some(error) = &doc.error { text(error, 1024, &mut total)?; }
        }
        let model = &self.model;
        if model.schema_version != 1 || model.nodes.is_empty() || model.nodes.len() > 4096
            || model.loop_stages.is_empty() || model.loop_stages.len() > 32
            || model.relations.len() > 8192 || model.entry_ids.is_empty() || model.entry_ids.len() > 64 {
            return Err(invalid("骨架模型数量或版本无效。"));
        }
        // The project projection reads at most 8 MiB of encoded Skeleton.json.
        if serde_json::to_vec(model)?.len() > 8 * 1024 * 1024 {
            return Err(invalid("骨架模型超过来源文件 8 MiB 上限。"));
        }
        text(&model.title, 160, &mut total)?;
        text(&model.description, 4000, &mut total)?;
        let mut ids = HashSet::new();
        let mut kinds = HashMap::new();
        let mut parents = HashMap::new();
        for node in &model.nodes {
            stable_id(&node.id, &mut total)?;
            if !ids.insert(node.id.as_str()) { return Err(invalid("骨架节点 ID 重复。")); }
            text(&node.kind, 32, &mut total)?;
            if !matches!(node.kind.as_str(), "system" | "region" | "structure" | "rule" | "world" | "reference") { return Err(invalid("骨架节点类别无效。")); }
            kinds.insert(node.id.as_str(), node.kind.as_str());
            text(&node.state, 32, &mut total)?;
            if !matches!(node.state.as_str(), "rules_preserved" | "structure_only" | "world_basis" | "supporting_reference" | "needs_reconciliation") { return Err(invalid("骨架节点状态无效。")); }
            text(&node.title, 160, &mut total)?;
            text(&node.summary, 2000, &mut total)?;
            if let Some(parent) = &node.parent_id { stable_id(parent, &mut total)?; parents.insert(node.id.as_str(), parent.as_str()); }
            if let Some(notes) = &node.notes { validate_strings(notes, 32, 4000, &mut total)?; }
            if let Some(steps) = &node.steps {
                if steps.len() > 32 { return Err(invalid("骨架步骤过多。")); }
                for step in steps { text(&step.title, 160, &mut total)?; text(&step.text, 4000, &mut total)?; }
            }
            if let Some(rule) = &node.rule {
                for (key, values) in rule {
                    if !matches!(key.as_str(), "trigger" | "conditions" | "effects" | "exceptions" | "formulas" | "conflicts") { return Err(invalid("骨架规则字段无效。")); }
                    total = total.saturating_add(key.len());
                    if total > MAX_TEXT { return Err(invalid("骨架文本总量超过 4 MiB。")); }
                    validate_strings(values, 64, 8000, &mut total)?;
                }
            }
            validate_strings(&node.sources, 96, 512, &mut total)?;
            for source in &node.sources {
                if !relative_path(source, true) || !docs.get(source.as_str()).is_some_and(|doc| doc.error.is_none()) { return Err(invalid("骨架引用的文档不在有效索引中。")); }
            }
            if let Some(records) = &node.provenance {
                if records.len() > 128 { return Err(invalid("骨架来源证据过多。")); }
                for record in records {
                    if !relative_path(&record.path, true) || record.path.len() > 512 { return Err(invalid("骨架证据路径无效。")); }
                    text(&record.path, 512, &mut total)?;
                    hash(&record.hash)?;
                    total = total.saturating_add(record.hash.len());
                    if total > MAX_TEXT { return Err(invalid("骨架文本总量超过 4 MiB。")); }
                    if record.start_line == 0 || record.end_line < record.start_line { return Err(invalid("骨架证据行号无效。")); }
                    text(&record.quote, 8000, &mut total)?;
                    if record.archived != Some(true) && (!node.sources.contains(&record.path) || !docs.get(record.path.as_str()).is_some_and(|doc| doc.error.is_none())) { return Err(invalid("当前骨架证据不在节点文档索引中。")); }
                }
            }
        }
        for (id, parent) in &parents {
            if !ids.contains(parent) { return Err(invalid("骨架父节点不存在。")); }
            let mut visited = HashSet::new();
            let mut cursor = *id;
            while let Some(next) = parents.get(cursor) {
                if !visited.insert(cursor) { return Err(invalid("骨架父节点形成环。")); }
                cursor = next;
            }
        }
        let mut entries = HashSet::new();
        for entry in &model.entry_ids {
            text(entry, 120, &mut total)?;
            if !entries.insert(entry.as_str()) || kinds.get(entry.as_str()) != Some(&"system") { return Err(invalid("骨架入口必须引用唯一的 system 节点。")); }
        }
        let mut stages = HashSet::new();
        for stage in &model.loop_stages {
            stable_id(&stage.id, &mut total)?;
            if ids.contains(stage.id.as_str()) || !stages.insert(stage.id.as_str()) { return Err(invalid("骨架阶段 ID 重复。")); }
            text(&stage.title, 160, &mut total)?; text(&stage.summary, 2000, &mut total)?;
            validate_strings(&stage.node_ids, 128, 120, &mut total)?;
            if stage.node_ids.iter().any(|id| !ids.contains(id.as_str())) { return Err(invalid("骨架阶段引用不存在的节点。")); }
        }
        for relation in &model.relations {
            stable_id(&relation.from, &mut total)?; stable_id(&relation.to, &mut total)?;
            if !ids.contains(relation.from.as_str()) || !ids.contains(relation.to.as_str()) { return Err(invalid("骨架关系引用不存在的节点。")); }
            text(&relation.label, 160, &mut total)?;
        }
        Ok(())
    }
}

fn validate_strings(values: &[String], max_items: usize, max_bytes: usize, total: &mut usize) -> Result<(), SpellcastError> {
    if values.len() > max_items { return Err(invalid("骨架数组过长。")); }
    for value in values { text(value, max_bytes, total)?; }
    Ok(())
}

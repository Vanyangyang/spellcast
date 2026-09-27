//! Planning content is canonical project data; repository configurations are optional sources.
use crate::project_records::{DevelopmentObject, SourceReference};
use rmcp::schemars::{self, JsonSchema};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, Default)]
#[serde(deny_unknown_fields)]
pub struct PlanningFields {
    pub scopes: Vec<String>,
    /// Persistent accidental-edit protection, independent of design confirmation.
    #[serde(default, skip_serializing_if = "is_false")]
    pub locked: bool,
    #[serde(default)]
    pub confirmed: bool,
    #[serde(default)]
    pub body: String,
    /// Present even when empty after an explicit clear. Absence keeps the legacy body format.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sections: Option<Vec<ContentSection>>,
    #[serde(default)]
    pub links: Vec<PlanningLink>,
    #[serde(default)]
    pub references: Vec<SourceReference>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rule: Option<RuleDefinition>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hook: Option<HookDefinition>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parameter: Option<ParameterDefinition>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub flow: Option<crate::project_flow::FlowDefinition>,
    /// Positions in existing player flows. Owned by content/rule/hook objects, so a locked flow
    /// skeleton never changes when designs are attached to it. Omitted when empty.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub anchors: Vec<FlowAnchor>,
}

/// A structured reference to one step, or one choice of that step, in a same-project flow.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct FlowAnchor {
    pub flow_id: String,
    pub step_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub choice_id: Option<String>,
    /// Hooks only: cue | action | payoff | continuation. Empty means unspecified.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub phase: String,
    /// What this design does at the position. Descriptive only.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub note: String,
}

pub(crate) const ANCHOR_KINDS: [&str; 3] = ["content", "rule", "hook"];
pub(crate) const HOOK_PHASES: [&str; 4] = ["cue", "action", "payoff", "continuation"];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, Default)]
#[serde(rename_all = "snake_case")]
pub enum ContentSectionRole {
    #[default]
    Body,
    Reason,
    Alternative,
    Question,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ContentSection {
    pub id: String,
    #[serde(default)]
    pub role: ContentSectionRole,
    pub text: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub references: Vec<SourceReference>,
}

fn is_false(value: &bool) -> bool { !*value }

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct PlanningLink {
    pub target_id: String,
    pub relation: String,
    #[serde(default)]
    pub note: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub local: Option<LocalParameterValue>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct LocalParameterValue {
    pub value: String,
    pub reason: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, Default)]
#[serde(deny_unknown_fields)]
pub struct RuleDefinition {
    #[serde(default)]
    pub trigger: String,
    #[serde(default)]
    pub condition: String,
    #[serde(default)]
    pub effect: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, Default)]
#[serde(deny_unknown_fields)]
pub struct HookDefinition {
    #[serde(default)]
    pub cue: String,
    #[serde(default)]
    pub action: String,
    #[serde(default)]
    pub payoff: String,
    #[serde(default)]
    pub continuation: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, Default)]
#[serde(deny_unknown_fields)]
pub struct ParameterDefinition {
    /// Decimal text preserves the user's representation. Empty means undecided, not zero.
    #[serde(default)]
    pub value: String,
    #[serde(default)]
    pub unit: String,
    #[serde(default)]
    pub min: String,
    #[serde(default)]
    pub max: String,
    /// A design note; never evaluated as code.
    #[serde(default)]
    pub formula: String,
    #[serde(default)]
    pub variants: Vec<ParameterVariant>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ParameterVariant {
    pub label: String,
    pub value: String,
    #[serde(default)]
    pub reason: String,
}

pub(crate) fn text(label: &str, value: &str, limit: usize) -> Result<(), String> {
    if value.len() > limit || value.contains('\0') {
        return Err(format!("{label}过长或包含非法字符。"));
    }
    Ok(())
}

pub(crate) fn number(label: &str, value: &str) -> Result<Option<f64>, String> {
    if value.trim().is_empty() {
        return Ok(None);
    }
    if value.len() > 100 {
        return Err(format!("{label}过长。"));
    }
    let n = value
        .trim()
        .parse::<f64>()
        .map_err(|_| format!("{label}需要数字，单位请单独填写。"))?;
    if !n.is_finite() {
        return Err(format!("{label}必须是有限数值。"));
    }
    Ok(Some(n))
}

fn parameter_value(
    parameter: &ParameterDefinition,
    value: &str,
    required: bool,
) -> Result<(), String> {
    let n = number("参数值", value)?;
    if required && n.is_none() {
        return Err("局部值和候选方案需要填写数值。".into());
    }
    let min = number("下限", &parameter.min)?;
    let max = number("上限", &parameter.max)?;
    if min.zip(max).is_some_and(|(a, b)| a > b) {
        return Err("参数下限不能大于上限。".into());
    }
    if n.is_some_and(|n| min.is_some_and(|min| n < min) || max.is_some_and(|max| n > max)) {
        return Err("参数值超出当前声明的上下限。".into());
    }
    Ok(())
}

pub(crate) fn validate_fields(kind: &str, fields: &PlanningFields) -> Result<(), String> {
    if !matches!(
        kind,
        "system" | "rule" | "hook" | "parameter" | "content" | "flow"
    ) {
        return Err("规划对象类型应为系统、规则、钩子、数值、内容或流程。".into());
    }
    let scopes: BTreeSet<_> = fields.scopes.iter().collect();
    if scopes.is_empty()
        || scopes.len() != fields.scopes.len()
        || scopes
            .iter()
            .any(|s| !matches!(s.as_str(), "R0" | "R1" | "R2"))
    {
        return Err("请选择 R0、R1、R2 中的至少一个范围，且不要重复。".into());
    }
    text("内容正文", &fields.body, 32 * 1024)?;
    if let Some(sections) = &fields.sections {
        if kind != "content" {
            return Err("只有内容对象可以填写片段。".into());
        }
        if !fields.body.is_empty() {
            return Err("使用片段时旧正文必须为空，避免两份可编辑正文。".into());
        }
        if sections.len() > 128 {
            return Err("一个内容对象最多保留 128 个片段。".into());
        }
        let mut ids = BTreeSet::new();
        let mut total_bytes = 0usize;
        for section in sections {
            text("片段 ID", &section.id, 128)?;
            if section.id.trim().is_empty() || !ids.insert(section.id.as_str()) {
                return Err("片段 ID 不能为空或重复。".into());
            }
            text("片段正文", &section.text, 32 * 1024)?;
            total_bytes += section.text.len();
            if total_bytes > 128 * 1024 {
                return Err("片段正文合计不能超过 128 KiB。".into());
            }
        }
    }
    if fields.links.len() > 64 || fields.references.len() > 128 {
        return Err("单个规划对象的关联数量过多。".into());
    }
    for link in &fields.links {
        text("关联对象 ID", &link.target_id, 256)?;
        text("关联说明", &link.note, 4096)?;
        if link.target_id.trim().is_empty()
            || !matches!(
                link.relation.as_str(),
                "belongs_to" | "uses" | "depends_on" | "follows"
            )
        {
            return Err("关联对象或关系类型无效。".into());
        }
        if let Some(local) = &link.local {
            number("局部值", &local.value)?.ok_or("局部值不能为空。")?;
            text("局部配置原因", &local.reason, 4096)?;
            if link.relation != "uses" || local.reason.trim().is_empty() {
                return Err("局部数值只能用于使用关系，并需要说明原因。".into());
            }
        }
    }
    if let Some(rule) = &fields.rule {
        if kind != "rule" {
            return Err("只有规则对象可以填写规则字段。".into());
        }
        for value in [&rule.trigger, &rule.condition, &rule.effect] {
            text("规则说明", value, 8192)?;
        }
    }
    if let Some(hook) = &fields.hook {
        if kind != "hook" {
            return Err("只有钩子对象可以填写体验钩子字段。".into());
        }
        for value in [&hook.cue, &hook.action, &hook.payoff, &hook.continuation] {
            text("钩子说明", value, 8192)?;
        }
    }
    if let Some(parameter) = &fields.parameter {
        if kind != "parameter" {
            return Err("只有数值对象可以填写参数字段。".into());
        }
        text("单位", &parameter.unit, 128)?;
        text("公式说明", &parameter.formula, 8192)?;
        parameter_value(parameter, &parameter.value, false)?;
        if parameter.variants.len() > 8 {
            return Err("一个参数最多保留 8 个候选方案。".into());
        }
        for variant in &parameter.variants {
            text("方案名称", &variant.label, 512)?;
            text("方案理由", &variant.reason, 4096)?;
            if variant.label.trim().is_empty() {
                return Err("候选方案需要名称。".into());
            }
            parameter_value(parameter, &variant.value, true)?;
        }
    }
    if let Some(flow) = &fields.flow {
        if kind != "flow" { return Err("只有流程对象可以填写步骤与分支。".into()); }
        crate::project_flow::validate(flow)?;
    }
    if !fields.anchors.is_empty() && !ANCHOR_KINDS.contains(&kind) {
        return Err("只有内容、规则和体验钩子可以关联流程步骤。".into());
    }
    if fields.anchors.len() > 32 {
        return Err("单个对象最多关联 32 个流程位置。".into());
    }
    let mut anchors = BTreeSet::new();
    for anchor in &fields.anchors {
        for (label, value) in [("关联流程 ID", &anchor.flow_id), ("关联步骤 ID", &anchor.step_id)] {
            text(label, value, 256)?;
            if value.trim().is_empty() { return Err(format!("{label}不能为空。")); }
        }
        if let Some(choice) = &anchor.choice_id {
            text("关联选择 ID", choice, 256)?;
            if choice.trim().is_empty() { return Err("关联选择 ID 不能为空。".into()); }
        }
        text("关联用途", &anchor.note, 4096)?;
        if !anchor.phase.is_empty() && (kind != "hook" || !HOOK_PHASES.contains(&anchor.phase.as_str())) {
            return Err("只有体验钩子可以标注线索、动作、回报或继续动机。".into());
        }
        if !anchors.insert((&anchor.flow_id, &anchor.step_id, &anchor.choice_id, &anchor.phase)) {
            return Err("同一流程位置与阶段不能重复关联。".into());
        }
    }
    Ok(())
}

/// Checks one anchor against the current project graph and explains the owning object.
fn validate_anchor(owner: &DevelopmentObject, anchor: &FlowAnchor, by_id: &BTreeMap<&str, &DevelopmentObject>) -> Result<(), String> {
    let flow = by_id.get(anchor.flow_id.as_str())
        .ok_or_else(|| format!("{} 关联的流程 {} 不存在于本项目。", owner.name, anchor.flow_id))?;
    let definition = flow.planning.as_ref().and_then(|planning| planning.flow.as_ref())
        .filter(|_| flow.kind == "flow")
        .ok_or_else(|| format!("{} 关联的目标「{}」不是已定义步骤的玩家流程。", owner.name, flow.name))?;
    let step = definition.steps.iter().find(|step| step.id == anchor.step_id).ok_or_else(|| format!(
        "「{}」关联了流程「{}」中不存在的步骤 {}。被关联的步骤不能删除；请先在「{}」中解除这个流程位置。",
        owner.name, flow.name, anchor.step_id, owner.name))?;
    if let Some(choice) = &anchor.choice_id {
        if !step.choices.iter().any(|item| &item.id == choice) {
            return Err(format!(
                "「{}」关联了流程「{}」步骤「{}」中不存在的选择 {choice}。被关联的选择不能删除；请先在「{}」中解除这个流程位置。",
                owner.name, flow.name, step.title, owner.name));
        }
    }
    Ok(())
}

/// Validate against the whole current project before committing any object revision.
/// Archived targets remain addressable; references never disappear silently.
pub(crate) fn validate_graph(objects: &[DevelopmentObject]) -> Result<(), String> {
    let by_id: BTreeMap<_, _> = objects
        .iter()
        .map(|object| (object.id.as_str(), object))
        .collect();
    for object in objects {
        let Some(fields) = &object.planning else {
            continue;
        };
        validate_fields(&object.kind, fields)?;
        if let Some(flow) = &fields.flow {
            for variable in &flow.variables {
                if let Some(id) = &variable.parameter_id {
                    let target = by_id.get(id.as_str()).ok_or("流程变量引用的数值对象不存在。")?;
                    if target.kind != "parameter" || target.planning.as_ref().and_then(|p| p.parameter.as_ref()).is_none()
                        || !fields.links.iter().any(|l| l.target_id == *id && l.relation == "uses") {
                        return Err("流程变量需要通过使用关系引用本项目的数值对象。".into());
                    }
                }
            }
        }
        for anchor in &fields.anchors {
            validate_anchor(object, anchor, &by_id)?;
        }
        let mut links = BTreeSet::new();
        for link in &fields.links {
            if link.target_id == object.id {
                return Err("对象不能引用自己。".into());
            }
            if !links.insert((&link.target_id, &link.relation)) {
                return Err("同一对象的同一种关联不能重复。".into());
            }
            let target = by_id.get(link.target_id.as_str()).ok_or_else(|| {
                format!(
                    "{} 引用了不存在于本项目的对象：{}",
                    object.name, link.target_id
                )
            })?;
            let target_fields = target
                .planning
                .as_ref()
                .ok_or("关联目标尚未加入规划，请先编辑它或改用来源引用。")?;
            if link.relation == "belongs_to" && !matches!(target.kind.as_str(), "system" | "flow") {
                return Err("归属目标应为系统或流程。".into());
            }
            if let Some(local) = &link.local {
                let parameter = target_fields
                    .parameter
                    .as_ref()
                    .filter(|_| target.kind == "parameter")
                    .ok_or("局部数值的目标需要是一个已定义的参数。")?;
                parameter_value(parameter, &local.value, true)
                    .map_err(|e| format!("{} 的局部配置：{e}", object.name))?;
            }
        }
    }
    fn visit<'a>(
        id: &'a str,
        by_id: &BTreeMap<&'a str, &'a DevelopmentObject>,
        path: &mut BTreeSet<&'a str>,
        done: &mut BTreeSet<&'a str>,
    ) -> Result<(), String> {
        if done.contains(id) {
            return Ok(());
        }
        if !path.insert(id) {
            return Err("系统／流程的归属关系不能形成循环。".into());
        }
        if path.len() > 256 {
            return Err("规划归属层级过深。".into());
        }
        if let Some(fields) = by_id.get(id).and_then(|object| object.planning.as_ref()) {
            for link in fields
                .links
                .iter()
                .filter(|link| link.relation == "belongs_to")
            {
                visit(link.target_id.as_str(), by_id, path, done)?;
            }
        }
        path.remove(id);
        done.insert(id);
        Ok(())
    }
    let mut done = BTreeSet::new();
    for id in by_id.keys() {
        visit(id, &by_id, &mut BTreeSet::new(), &mut done)?;
    }
    Ok(())
}

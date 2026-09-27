//! Bounded declarative player flows. This schema does not execute game code.
use crate::project_planning::{number, text};
use rmcp::schemars::{self, JsonSchema};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, Default)]
#[serde(deny_unknown_fields)]
pub struct FlowDefinition {
    pub entry: String,
    pub variables: Vec<FlowVariable>,
    pub steps: Vec<FlowStep>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct FlowVariable {
    pub id: String,
    pub name: String,
    pub value_type: String,
    pub initial: String,
    pub unit: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parameter_id: Option<String>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct FlowStep {
    pub id: String,
    pub title: String,
    pub goal: String,
    pub action: String,
    pub feedback: String,
    pub external: bool,
    pub terminal: bool,
    pub choices: Vec<FlowChoice>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct FlowChoice {
    pub id: String,
    pub label: String,
    pub to: String,
    pub conditions: Vec<FlowCondition>,
    pub effects: Vec<FlowEffect>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct FlowOperand { pub kind: String, pub value: String }
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct FlowCondition { pub variable_id: String, pub op: String, pub operand: FlowOperand }
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct FlowEffect { pub variable_id: String, pub op: String, pub operand: FlowOperand }

fn id(value: &str) -> Result<(), String> {
    text("流程 ID", value, 128)?;
    if value.trim().is_empty() { return Err("流程 ID 不能为空。".into()); }
    Ok(())
}
fn literal(kind: &str, value: &str, required: bool) -> Result<(), String> {
    text("流程值", value, 2048)?;
    match kind {
        "number" => { if number("流程值", value)?.is_none() && required { return Err("条件和结果需要填写数值。".into()); } }
        "flag" if !matches!(value, "true" | "false") && (required || !value.is_empty()) => return Err("开关值需要 true 或 false。".into()),
        _ => {}
    }
    Ok(())
}
fn operand(vars: &BTreeMap<&str, &FlowVariable>, variable_id: &str, op: &str, value: &FlowOperand, effect: bool) -> Result<(), String> {
    let variable = vars.get(variable_id).ok_or("分支引用的变量不存在。")?;
    let numeric = if effect {
        if !matches!(op, "set" | "add" | "subtract") { return Err("流程结果操作无效。".into()); }
        op != "set"
    } else {
        if !matches!(op, "eq" | "neq" | "lt" | "lte" | "gt" | "gte") { return Err("流程条件操作无效。".into()); }
        !matches!(op, "eq" | "neq")
    };
    if numeric && variable.value_type != "number" { return Err("大小比较和加减只支持数字变量。".into()); }
    match value.kind.as_str() {
        "literal" => literal(&variable.value_type, &value.value, true)?,
        "variable" => {
            let other = vars.get(value.value.as_str()).ok_or("操作数引用的变量不存在。")?;
            if other.value_type != variable.value_type { return Err("流程运算两侧的变量类型需要一致。".into()); }
        }
        _ => return Err("操作数应为固定值或变量。".into()),
    }
    Ok(())
}

pub(crate) fn validate(flow: &FlowDefinition) -> Result<(), String> {
    if flow.variables.len() > 32 || flow.steps.len() > 64 || serde_json::to_vec(flow).map_err(|e| e.to_string())?.len() > 128 * 1024 {
        return Err("单个流程最多 32 个变量、64 个步骤和 128 KiB 内容。".into());
    }
    let mut vars = BTreeMap::new();
    for variable in &flow.variables {
        id(&variable.id)?; text("变量名称", &variable.name, 512)?; text("变量单位", &variable.unit, 128)?;
        if variable.name.trim().is_empty() || vars.insert(variable.id.as_str(), variable).is_some() { return Err("变量需要名称，ID 不能重复。".into()); }
        if !matches!(variable.value_type.as_str(), "number" | "flag" | "text") { return Err("变量类型需要数字、开关或文字。".into()); }
        literal(&variable.value_type, &variable.initial, false)?;
        if let Some(parameter) = &variable.parameter_id {
            id(parameter)?;
            if variable.value_type != "number" { return Err("只有数字变量可以引用数值对象。".into()); }
        }
    }
    let mut steps = BTreeSet::new();
    for step in &flow.steps {
        id(&step.id)?; text("步骤名称", &step.title, 512)?;
        if step.title.trim().is_empty() || !steps.insert(step.id.as_str()) { return Err("步骤需要名称，ID 不能重复。".into()); }
        for value in [&step.goal, &step.action, &step.feedback] { text("步骤说明", value, 2048)?; }
    }
    if (!steps.is_empty() && !steps.contains(flow.entry.as_str())) || (steps.is_empty() && !flow.entry.is_empty()) { return Err("流程入口需要指向一个存在的步骤。".into()); }
    let mut choices = BTreeSet::new();
    for step in &flow.steps {
        if step.choices.len() > 8 || (step.terminal && !step.choices.is_empty()) { return Err("每个步骤最多 8 个选择，结束步骤不能再连接后续步骤。".into()); }
        for choice in &step.choices {
            id(&choice.id)?; text("选择名称", &choice.label, 512)?;
            if choice.label.trim().is_empty() || !choices.insert(choice.id.as_str()) { return Err("选择需要名称，ID 不能重复。".into()); }
            if !steps.contains(choice.to.as_str()) { return Err("分支指向的步骤不存在。".into()); }
            if choice.conditions.len() > 16 || choice.effects.len() > 16 { return Err("每个选择最多 16 个条件和 16 个结果。".into()); }
            for condition in &choice.conditions { operand(&vars, &condition.variable_id, &condition.op, &condition.operand, false)?; }
            for effect in &choice.effects { operand(&vars, &effect.variable_id, &effect.op, &effect.operand, true)?; }
        }
    }
    Ok(())
}

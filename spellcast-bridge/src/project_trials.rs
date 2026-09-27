//! Independent parameter candidates, saved walkthrough trials and candidate adoptions.
//!
//! A trial is an immutable model preview of a saved flow revision. It records the saved design
//! revisions it read and the preview inputs typed for it. It is never Unity or player evidence.
use crate::project_flow::{FlowChoice, FlowOperand, FlowStep, FlowVariable};
use crate::project_planning::{number, text, ParameterDefinition, ANCHOR_KINDS, HOOK_PHASES};
use crate::project_records::{DevelopmentObject, RecordActor};
use rmcp::schemars::{self, JsonSchema};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};

pub(crate) const MAX_TRIAL_EVENTS: usize = 200;
pub(crate) const MAX_TRIAL_BYTES: usize = 1024 * 1024;
pub(crate) const MAX_TRIAL_EVIDENCE: usize = 16;
pub(crate) const TRIAL_ORIGINS: [&str; 3] = ["walkthrough", "replay", "legacy_local"];

/// The execution-relevant parameter definition a candidate is compared against.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct CandidateBase {
    pub revision: u64,
    pub value: String,
    #[serde(default)]
    pub unit: String,
    #[serde(default)]
    pub min: String,
    #[serde(default)]
    pub max: String,
}

impl CandidateBase {
    pub(crate) fn of(parameter: &DevelopmentObject) -> Result<Self, String> {
        let definition = parameter_definition(parameter)?;
        Ok(Self { revision: parameter.revision, value: definition.value.clone(), unit: definition.unit.clone(),
            min: definition.min.clone(), max: definition.max.clone() })
    }

    /// Value, unit and bounds. Revisions, locks, notes and candidate lists are editing metadata.
    pub(crate) fn same_definition(&self, other: &Self) -> bool {
        same_number(&self.value, &other.value) && self.unit == other.unit
            && same_number(&self.min, &other.min) && same_number(&self.max, &other.max)
    }

    pub(crate) fn describe(&self) -> String {
        format!("值 {} {} · 范围 {} … {}", or_dash(&self.value), self.unit, or_dash(&self.min), or_dash(&self.max))
    }
}

fn or_dash(value: &str) -> &str { if value.trim().is_empty() { "—" } else { value } }

fn same_number(a: &str, b: &str) -> bool {
    match (number("数值", a), number("数值", b)) { (Ok(x), Ok(y)) => x == y, _ => a == b }
}

/// A project-level numeric proposal for one shared parameter. Saving it never edits the parameter.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ParameterCandidate {
    pub id: String,
    pub project_id: String,
    pub parameter_id: String,
    pub label: String,
    pub value: String,
    #[serde(default)]
    pub reason: String,
    pub base: CandidateBase,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub from_variant: Option<String>,
    pub revision: u64,
    pub archived: bool,
    pub created_at_ms: u64,
    pub updated_at_ms: u64,
    pub updated_by: RecordActor,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct TrialInputSource {
    pub variable_id: String,
    pub value: String,
    /// flow | shared | local | candidate | override
    pub source: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parameter_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parameter_revision: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub candidate_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub candidate_revision: Option<u64>,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub note: String,
}

/// Which saved design pointed at the flow when the trial started.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct TrialAnchor {
    pub object_id: String,
    pub name: String,
    pub kind: String,
    pub revision: u64,
    pub step_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub choice_id: Option<String>,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub phase: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub note: String,
}

/// A reused earlier manual result. It is a stated assumption, not a new run result.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct TrialAssumption {
    pub base_trial_id: String,
    pub base_event_index: u64,
    /// The state before this step differed from the base trial when the result was reused.
    pub context_changed: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct TrialEvent {
    /// choice | manual
    pub kind: String,
    pub from: String,
    pub to: String,
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub choice_id: Option<String>,
    pub before: BTreeMap<String, Value>,
    pub after: BTreeMap<String, Value>,
    pub at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub assumption: Option<TrialAssumption>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct TrialDivergence {
    /// Index into the base trial's events.
    pub index: u64,
    pub kind: String,
    pub detail: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct TrialReplay {
    pub base_trial_id: String,
    pub base_run_id: String,
    /// paused | diverged | complete
    pub status: String,
    /// Number of base events reproduced or explicitly handled.
    pub cursor: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub divergence: Option<TrialDivergence>,
}

/// The complete walkthrough payload, including frozen source revisions.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct TrialRun {
    pub version: u64,
    pub id: String,
    pub started: String,
    pub source: DevelopmentObject,
    pub dependencies: Vec<DevelopmentObject>,
    #[serde(default)]
    pub inputs: BTreeMap<String, String>,
    pub initial: BTreeMap<String, Value>,
    pub events: Vec<TrialEvent>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub input_sources: Vec<TrialInputSource>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub candidates: Vec<ParameterCandidate>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub anchors: Vec<TrialAnchor>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub replay: Option<TrialReplay>,
}

/// One immutable saved trial.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct FlowTrial {
    pub id: String,
    pub project_id: String,
    pub flow_id: String,
    pub flow_revision: u64,
    #[serde(default)]
    pub label: String,
    pub origin: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_trial_id: Option<String>,
    /// SHA-256 of the run with project IDs normalized; stable across export/import.
    pub digest: String,
    pub created_at_ms: u64,
    pub created_by: RecordActor,
    pub run: TrialRun,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct TrialCandidateRef {
    pub id: String,
    pub revision: u64,
    pub parameter_id: String,
    pub label: String,
    pub value: String,
}

/// A compact list entry. Read the full trial by ID.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct TrialSummary {
    pub id: String,
    pub project_id: String,
    pub flow_id: String,
    pub flow_revision: u64,
    pub flow_name: String,
    pub label: String,
    pub origin: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_trial_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_trial_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub replay_status: Option<String>,
    pub digest: String,
    pub created_at_ms: u64,
    pub created_by: String,
    pub event_count: u64,
    pub manual_count: u64,
    pub assumption_count: u64,
    pub end_step_id: String,
    pub end_step_title: String,
    pub terminal: bool,
    pub parameter_ids: Vec<String>,
    pub candidates: Vec<TrialCandidateRef>,
}

/// The durable basis of one candidate adoption, written with the parameter revision it created.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct CandidateAdoption {
    pub id: String,
    pub project_id: String,
    pub parameter_id: String,
    pub parameter_revision_before: u64,
    pub parameter_revision_after: u64,
    pub value_before: String,
    pub value_after: String,
    pub candidate: ParameterCandidate,
    #[serde(default)]
    pub trial_ids: Vec<String>,
    pub reason: String,
    pub at_ms: u64,
    pub actor: RecordActor,
    pub request_id: String,
}

pub(crate) fn parameter_definition(object: &DevelopmentObject) -> Result<&ParameterDefinition, String> {
    object.planning.as_ref().and_then(|planning| planning.parameter.as_ref()).filter(|_| object.kind == "parameter")
        .ok_or_else(|| format!("「{}」不是已定义的数值参数。", object.name))
}

fn id_text(label: &str, value: &str) -> Result<(), String> {
    line(label, value, 256)?;
    if value.trim().is_empty() { return Err(format!("{label}不能为空。")); }
    Ok(())
}

fn line(label: &str, value: &str, limit: usize) -> Result<(), String> {
    text(label, value, limit)?;
    if value.chars().any(char::is_control) { return Err(format!("{label}不能包含换行或控制字符。")); }
    Ok(())
}

pub(crate) fn validate_candidate(candidate: &ParameterCandidate) -> Result<(), String> {
    id_text("候选 ID", &candidate.id)?;
    id_text("候选参数 ID", &candidate.parameter_id)?;
    line("候选名称", &candidate.label, 512)?;
    if candidate.label.trim().is_empty() { return Err("候选需要名称。".into()); }
    text("候选理由", &candidate.reason, 4096)?;
    line("基准单位", &candidate.base.unit, 128)?;
    if let Some(variant) = &candidate.from_variant { line("来源方案名称", variant, 512)?; }
    let value = number("候选值", &candidate.value)?.ok_or("候选需要填写数值。")?;
    number("基准值", &candidate.base.value)?;
    let min = number("基准下限", &candidate.base.min)?;
    let max = number("基准上限", &candidate.base.max)?;
    if min.zip(max).is_some_and(|(a, b)| a > b) { return Err("候选基准的下限大于上限。".into()); }
    if min.is_some_and(|min| value < min) || max.is_some_and(|max| value > max) {
        return Err("候选值超出基准参数声明的上下限。".into());
    }
    if candidate.revision == 0 || candidate.base.revision == 0 { return Err("候选与基准 revision 必须从 1 开始。".into()); }
    if candidate.created_at_ms > candidate.updated_at_ms { return Err("候选的创建时间不能晚于更新时间。".into()); }
    Ok(())
}

/// A flow value exactly as the client model holds it. Numbers compare as IEEE doubles.
#[derive(Debug, Clone, PartialEq)]
enum Typed { Number(f64), Flag(bool), Text(String) }

fn shown(value: &Typed) -> String {
    match value { Typed::Number(number) => number.to_string(), Typed::Flag(flag) => flag.to_string(), Typed::Text(text) => format!("“{text}”") }
}

/// The client model's accepted decimal grammar: `[+-]?(\d+(\.\d*)?|\.\d+)(e[+-]?\d+)?`, case-insensitive.
fn decimal(text: &str) -> bool {
    let bytes = text.as_bytes();
    let mut index = usize::from(matches!(bytes.first(), Some(b'+' | b'-')));
    let digits = |index: &mut usize| { let start = *index; while bytes.get(*index).is_some_and(u8::is_ascii_digit) { *index += 1; } *index - start };
    let whole = digits(&mut index);
    let fraction = if bytes.get(index) == Some(&b'.') { index += 1; digits(&mut index) } else { 0 };
    if whole == 0 && fraction == 0 { return false; }
    if matches!(bytes.get(index), Some(b'e' | b'E')) {
        index += 1;
        if matches!(bytes.get(index), Some(b'+' | b'-')) { index += 1; }
        if digits(&mut index) == 0 { return false; }
    }
    index == bytes.len()
}

/// Mirrors the client model's literal parsing for a variable's type.
fn literal_value(variable: &FlowVariable, text: &str) -> Result<Typed, String> {
    match variable.value_type.as_str() {
        "text" => Ok(Typed::Text(text.to_string())),
        "flag" => match text { "true" => Ok(Typed::Flag(true)), "false" => Ok(Typed::Flag(false)), _ => Err(format!("「{}」需要开或关。", variable.name)) },
        _ => {
            // JavaScript trim includes BOM, but excludes Unicode NEXT LINE.
            let trimmed = text.trim_matches(|c: char| (c.is_whitespace() && c != '\u{0085}') || c == '\u{feff}');
            let number = trimmed.parse::<f64>().ok().filter(|number| decimal(trimmed) && number.is_finite())
                .ok_or_else(|| format!("「{}」需要有限数字。", variable.name))?;
            Ok(Typed::Number(number))
        }
    }
}

fn typed_state(vars: &BTreeMap<&str, &FlowVariable>, state: &BTreeMap<String, Value>) -> BTreeMap<String, Typed> {
    // Types were checked by `check_state`.
    state.iter().map(|(key, value)| (key.clone(), match vars[key.as_str()].value_type.as_str() {
        "number" => Typed::Number(value.as_f64().unwrap_or(f64::NAN)),
        "flag" => Typed::Flag(value.as_bool().unwrap_or_default()),
        _ => Typed::Text(value.as_str().unwrap_or_default().to_string()),
    })).collect()
}

fn operand_value(vars: &BTreeMap<&str, &FlowVariable>, target: &FlowVariable, operand: &FlowOperand, before: &BTreeMap<String, Typed>) -> Result<Typed, String> {
    match operand.kind.as_str() {
        "literal" => literal_value(target, &operand.value),
        "variable" => {
            let other = vars.get(operand.value.as_str()).filter(|other| other.value_type == target.value_type).ok_or("操作数变量不存在或类型不一致。")?;
            before.get(other.id.as_str()).cloned().ok_or_else(|| "操作数变量缺少当前值。".into())
        }
        _ => Err("操作数类型无效。".into()),
    }
}

/// Recomputes one choice from the frozen definition: all AND guards on the pre-choice state, then
/// effects in order. Right-hand operands read the pre-choice state; repeated targets accumulate.
fn apply_choice(vars: &BTreeMap<&str, &FlowVariable>, choice: &FlowChoice, before: &BTreeMap<String, Typed>) -> Result<BTreeMap<String, Typed>, String> {
    for condition in &choice.conditions {
        let variable = vars.get(condition.variable_id.as_str()).ok_or("条件引用的变量不存在。")?;
        let left = before.get(variable.id.as_str()).ok_or("条件变量缺少当前值。")?;
        let right = operand_value(vars, variable, &condition.operand, before)?;
        let passed = match (condition.op.as_str(), left, &right) {
            ("eq", _, _) => left == &right,
            ("neq", _, _) => left != &right,
            (op, Typed::Number(left), Typed::Number(right)) => match op { "lt" => left < right, "lte" => left <= right, "gt" => left > right, "gte" => left >= right, _ => false },
            _ => return Err("大小比较只支持数字。".into()),
        };
        if !passed {
            let op = match condition.op.as_str() { "eq" => "等于", "neq" => "不等于", "lt" => "小于", "lte" => "小于等于", "gt" => "大于", "gte" => "大于等于", other => other };
            return Err(format!("选择「{}」的条件未满足：{} {op} {}（当前 {}）。", choice.label, variable.name, shown(&right), shown(left)));
        }
    }
    let mut after = before.clone();
    for effect in &choice.effects {
        let variable = vars.get(effect.variable_id.as_str()).ok_or("结果引用的变量不存在。")?;
        let value = operand_value(vars, variable, &effect.operand, before)?;
        let next = match (effect.op.as_str(), after.get(variable.id.as_str()), &value) {
            ("set", _, _) => value,
            ("add", Some(Typed::Number(current)), Typed::Number(amount)) => Typed::Number(current + amount),
            ("subtract", Some(Typed::Number(current)), Typed::Number(amount)) => Typed::Number(current - amount),
            _ => return Err("加减只支持数字。".into()),
        };
        if matches!(next, Typed::Number(number) if !number.is_finite()) { return Err(format!("选择「{}」的结果超出有限数字范围。", choice.label)); }
        after.insert(variable.id.clone(), next);
    }
    Ok(after)
}

const SOURCE_NAMES: [(&str, &str); 5] = [("override", "本次手动初值"), ("local", "流程局部值"), ("candidate", "候选"), ("shared", "共用值"), ("flow", "流程初值")];
fn source_name(kind: &str) -> &str { SOURCE_NAMES.iter().find(|(key, _)| *key == kind).map_or(kind, |(_, name)| *name) }

/// Every variable has exactly one source, and it is the one the client model's precedence picks:
/// typed for this run > the flow's `uses` local override > a listed candidate > shared > flow initial.
/// The recorded text must equal that source's text and parse to the recorded initial value.
fn validate_input_sources(run: &TrialRun, vars: &BTreeMap<&str, &FlowVariable>, dependencies: &BTreeMap<&str, &DevelopmentObject>,
    candidates: &BTreeMap<&str, &ParameterCandidate>) -> Result<(), String> {
    let mut sources = BTreeMap::new();
    for input in &run.input_sources {
        if !vars.contains_key(input.variable_id.as_str()) || sources.insert(input.variable_id.as_str(), input).is_some() {
            return Err("初值来源引用了不存在或重复的变量。".into());
        }
        text("初值", &input.value, 2048)?;
        text("初值来源说明", &input.note, 4096)?;
    }
    if sources.len() != vars.len() { return Err("每个变量都需要一条初值来源。".into()); }
    let planning = run.source.planning.as_ref().ok_or("试走来源缺少规划内容。")?;
    let initial = typed_state(vars, &run.initial);
    let mut effective = BTreeSet::new();
    for variable in vars.values() {
        let input = sources[variable.id.as_str()];
        let binding = variable.parameter_id.as_deref().map(|id| -> Result<_, String> {
            let dependency = *dependencies.get(id).ok_or("流程变量引用的数值不在试走快照中。")?;
            let link = planning.links.iter().find(|link| link.target_id == id && link.relation == "uses").ok_or("流程变量缺少对数值的使用关系。")?;
            Ok((id, dependency, link))
        }).transpose()?;
        let (kind, expected) = if let Some(typed) = run.inputs.get(&variable.id) { ("override", typed.as_str()) }
            else if let Some((id, dependency, link)) = binding {
                if let Some(local) = &link.local { ("local", local.value.as_str()) }
                else if let Some(candidate) = candidates.get(id) { ("candidate", candidate.value.as_str()) }
                else { ("shared", parameter_definition(dependency)?.value.as_str()) }
            } else { ("flow", variable.initial.as_str()) };
        if input.source != kind {
            return Err(format!("「{}」的初值来源应为{}，记录为{}。", variable.name, source_name(kind), source_name(&input.source)));
        }
        if input.value != expected { return Err(format!("「{}」记录的初值 {} 与其{} {} 不一致。", variable.name, input.value, source_name(kind), expected)); }
        let references = match (kind, binding) {
            ("flow", _) | ("override", None) => input.parameter_id.is_none() && input.parameter_revision.is_none(),
            ("override", Some((id, dependency, _))) => (input.parameter_id.is_none() && input.parameter_revision.is_none())
                || (input.parameter_id.as_deref() == Some(id) && input.parameter_revision == Some(dependency.revision)),
            (_, Some((id, dependency, _))) => input.parameter_id.as_deref() == Some(id) && input.parameter_revision == Some(dependency.revision),
            _ => false,
        };
        let candidate_ref = if kind == "candidate" {
            let candidate = binding.and_then(|(id, _, _)| candidates.get(id)).ok_or("候选来源缺少候选快照。")?;
            effective.insert(candidate.id.as_str());
            input.candidate_id.as_deref() == Some(candidate.id.as_str()) && input.candidate_revision == Some(candidate.revision)
        } else { input.candidate_id.is_none() && input.candidate_revision.is_none() };
        if !references || !candidate_ref { return Err(format!("「{}」的初值来源与试走中的数值或候选快照不一致。", variable.name)); }
        if literal_value(variable, &input.value)? != initial[variable.id.as_str()] {
            return Err(format!("「{}」的初值与来源 {} 不一致。", variable.name, input.value));
        }
    }
    // A candidate masked by a local or typed value was not used and must not be recorded as used.
    if let Some(unused) = candidates.values().find(|candidate| !effective.contains(candidate.id.as_str())) {
        return Err(format!("候选「{}」没有成为任何初值的实际来源，不能记为本次试走所用。", unused.label));
    }
    Ok(())
}

fn check_state(vars: &BTreeMap<&str, &FlowVariable>, state: &BTreeMap<String, Value>, label: &str) -> Result<(), String> {
    if state.len() != vars.len() || state.keys().any(|key| !vars.contains_key(key.as_str())) {
        return Err(format!("{label}需要且只能包含流程声明的变量。"));
    }
    for (key, value) in state {
        let variable = vars[key.as_str()];
        let valid = match variable.value_type.as_str() {
            "number" => value.as_f64().is_some_and(f64::is_finite),
            "flag" => value.is_boolean(),
            "text" => value.as_str().is_some_and(|text| text.len() <= 2048 && !text.contains('\0')),
            _ => false,
        };
        if !valid { return Err(format!("{label}中「{}」的值类型不正确。", variable.name)); }
    }
    Ok(())
}

/// Structure, continuity, input provenance and every choice recomputed from the frozen definition
/// with the current model (typed guards; set/add/subtract). Manual results stay explicit inputs.
pub(crate) fn validate_trial_run(run: &TrialRun) -> Result<(), String> {
    if run.version != 2 { return Err("试走记录格式需要是版本 2；旧格式请在应用中校验后恢复。".into()); }
    id_text("试走运行 ID", &run.id)?;
    line("试走开始时间", &run.started, 64)?;
    let source = &run.source;
    let flow = source.planning.as_ref().and_then(|planning| planning.flow.as_ref()).filter(|_| source.kind == "flow")
        .ok_or("试走来源必须是已定义步骤的玩家流程。")?;
    crate::project_flow::validate(flow)?;
    if flow.steps.is_empty() { return Err("试走来源流程没有步骤。".into()); }
    if run.dependencies.len() > 32 || run.candidates.len() > 32 || run.anchors.len() > 512 || run.input_sources.len() > 64 {
        return Err("试走引用的数值、候选或关联设计过多。".into());
    }
    let vars: BTreeMap<&str, &FlowVariable> = flow.variables.iter().map(|variable| (variable.id.as_str(), variable)).collect();
    let bound: BTreeSet<&str> = flow.variables.iter().filter_map(|variable| variable.parameter_id.as_deref()).collect();
    let mut dependencies = BTreeMap::new();
    for dependency in &run.dependencies {
        parameter_definition(dependency)?;
        if dependency.project_id != source.project_id || dependencies.insert(dependency.id.as_str(), dependency).is_some() {
            return Err("试走的数值快照重复或不属于来源项目。".into());
        }
    }
    if dependencies.keys().copied().collect::<BTreeSet<_>>() != bound {
        return Err("试走的数值快照与流程变量引用不一致。".into());
    }
    let mut candidates = BTreeMap::new();
    for candidate in &run.candidates {
        validate_candidate(candidate)?;
        if candidate.project_id != source.project_id || !bound.contains(candidate.parameter_id.as_str()) {
            return Err("试走选用的候选不属于流程引用的数值。".into());
        }
        if candidates.insert(candidate.parameter_id.as_str(), candidate).is_some() {
            return Err("同一数值在一次试走中只能选用一个候选。".into());
        }
    }
    for (key, value) in &run.inputs {
        if !vars.contains_key(key.as_str()) { return Err("试走手动初值引用了不存在的变量。".into()); }
        text("试走手动初值", value, 2048)?;
    }
    check_state(&vars, &run.initial, "试走初值")?;
    validate_input_sources(run, &vars, &dependencies, &candidates)?;
    let steps: BTreeMap<&str, &FlowStep> = flow.steps.iter().map(|step| (step.id.as_str(), step)).collect();
    for anchor in &run.anchors {
        id_text("关联对象 ID", &anchor.object_id)?;
        line("关联对象名称", &anchor.name, 512)?;
        text("关联用途", &anchor.note, 4096)?;
        let step = steps.get(anchor.step_id.as_str()).ok_or("关联快照引用了来源流程中不存在的步骤。")?;
        if !ANCHOR_KINDS.contains(&anchor.kind.as_str()) || anchor.revision == 0
            || anchor.choice_id.as_ref().is_some_and(|choice| !step.choices.iter().any(|item| &item.id == choice))
            || (!anchor.phase.is_empty() && (anchor.kind != "hook" || !HOOK_PHASES.contains(&anchor.phase.as_str()))) {
            return Err("关联设计快照与来源流程不一致。".into());
        }
    }
    if run.events.len() > MAX_TRIAL_EVENTS { return Err(format!("一次试走最多记录 {MAX_TRIAL_EVENTS} 个动作。")); }
    let replay = run.replay.as_ref();
    let (mut position, mut state, mut manual_done) = (flow.entry.as_str(), &run.initial, false);
    let mut values = typed_state(&vars, &run.initial);
    for (index, event) in run.events.iter().enumerate() {
        let n = index + 1;
        text("动作名称", &event.label, 512)?;
        line("动作时间", &event.at, 64)?;
        if event.from != position { return Err(format!("第 {n} 个动作的起点与上一动作的终点不一致。")); }
        if &event.before != state { return Err(format!("第 {n} 个动作记录的前状态与上一状态不一致。")); }
        check_state(&vars, &event.after, &format!("第 {n} 个动作的结果"))?;
        let recorded = typed_state(&vars, &event.after);
        let step = steps[position];
        match event.kind.as_str() {
            "choice" => {
                if step.external && !manual_done { return Err(format!("第 {n} 个动作之前缺少这一步需要的手动结果。")); }
                let choice = event.choice_id.as_deref().and_then(|id| step.choices.iter().find(|choice| choice.id == id))
                    .ok_or_else(|| format!("第 {n} 个动作的选择不属于步骤「{}」。", step.title))?;
                if choice.to != event.to || event.assumption.is_some() {
                    return Err(format!("第 {n} 个动作的目标或标记与流程定义不一致。"));
                }
                // Persisted evidence: recompute guards and effects from the frozen definition.
                let computed = apply_choice(&vars, choice, &values).map_err(|error| format!("第 {n} 个动作无法由流程定义得到：{error}"))?;
                if let Some(variable) = flow.variables.iter().find(|variable| computed.get(&variable.id) != recorded.get(&variable.id)) {
                    return Err(format!("第 {n} 个动作记录的「{}」为 {}，按流程定义重算应为 {}。", variable.name,
                        recorded.get(&variable.id).map(shown).unwrap_or_default(), computed.get(&variable.id).map(shown).unwrap_or_default()));
                }
                position = choice.to.as_str();
                manual_done = false;
            }
            "manual" => {
                if !step.external || manual_done || event.to != event.from || event.choice_id.is_some() {
                    return Err(format!("第 {n} 个动作不是这一步允许的手动结果。"));
                }
                if let Some(assumption) = &event.assumption {
                    if replay.is_none_or(|replay| replay.base_trial_id != assumption.base_trial_id) || assumption.base_event_index >= MAX_TRIAL_EVENTS as u64 {
                        return Err(format!("第 {n} 个动作的手动假设没有对应的基准试走。"));
                    }
                }
                // Explicit external input: accepted as entered, never treated as computed evidence.
                manual_done = true;
            }
            _ => return Err(format!("第 {n} 个动作的类型无效。")),
        }
        state = &event.after;
        values = recorded;
    }
    if let Some(replay) = replay {
        id_text("基准试走 ID", &replay.base_trial_id)?;
        id_text("基准运行 ID", &replay.base_run_id)?;
        if !matches!(replay.status.as_str(), "paused" | "diverged" | "complete") || replay.cursor > MAX_TRIAL_EVENTS as u64
            || (replay.status == "diverged") != replay.divergence.is_some() {
            return Err("重放状态无效。".into());
        }
        if let Some(divergence) = &replay.divergence {
            line("分歧类型", &divergence.kind, 64)?;
            text("分歧说明", &divergence.detail, 4096)?;
            if divergence.index > MAX_TRIAL_EVENTS as u64 { return Err("分歧位置无效。".into()); }
        }
    }
    Ok(())
}

/// Content identity for deduplication. Project IDs are cleared so imports keep the digest.
pub(crate) fn trial_digest(run: &TrialRun) -> Result<String, String> {
    let mut normalized = run.clone();
    normalized.source.project_id.clear();
    for dependency in &mut normalized.dependencies { dependency.project_id.clear(); }
    for candidate in &mut normalized.candidates { candidate.project_id.clear(); }
    let bytes = serde_json::to_vec(&normalized).map_err(|error| format!("计算试走摘要失败：{error}"))?;
    Ok(format!("{:x}", Sha256::digest(bytes)))
}

pub(crate) fn validate_trial(trial: &FlowTrial) -> Result<(), String> {
    id_text("试走 ID", &trial.id)?;
    line("试走名称", &trial.label, 512)?;
    if !TRIAL_ORIGINS.contains(&trial.origin.as_str()) { return Err("试走来源类型无效。".into()); }
    if let Some(parent) = &trial.parent_trial_id { id_text("上级试走 ID", parent)?; }
    validate_trial_run(&trial.run)?;
    if trial.flow_id != trial.run.source.id || trial.flow_revision != trial.run.source.revision || trial.project_id != trial.run.source.project_id {
        return Err("试走的流程身份与来源快照不一致。".into());
    }
    if (trial.origin == "replay") != trial.run.replay.is_some() { return Err("只有重放试走记录重放基准。".into()); }
    if trial.digest != trial_digest(&trial.run)? { return Err("试走内容摘要不一致，记录可能已损坏。".into()); }
    let bytes = serde_json::to_vec(trial).map_err(|error| error.to_string())?.len();
    if bytes > MAX_TRIAL_BYTES { return Err(format!("单条试走超过 {MAX_TRIAL_BYTES} 字节上限。")); }
    Ok(())
}

pub(crate) fn trial_summary(trial: &FlowTrial) -> TrialSummary {
    let run = &trial.run;
    let flow = run.source.planning.as_ref().and_then(|planning| planning.flow.as_ref());
    let end = run.events.last().map(|event| event.to.clone()).or_else(|| flow.map(|flow| flow.entry.clone())).unwrap_or_default();
    let step = flow.and_then(|flow| flow.steps.iter().find(|step| step.id == end));
    let manual_here = run.events.last().is_some_and(|event| event.kind == "manual" && event.to == end);
    TrialSummary {
        id: trial.id.clone(), project_id: trial.project_id.clone(), flow_id: trial.flow_id.clone(), flow_revision: trial.flow_revision,
        flow_name: run.source.name.clone(), label: trial.label.clone(), origin: trial.origin.clone(),
        parent_trial_id: trial.parent_trial_id.clone(), base_trial_id: run.replay.as_ref().map(|replay| replay.base_trial_id.clone()),
        replay_status: run.replay.as_ref().map(|replay| replay.status.clone()), digest: trial.digest.clone(),
        created_at_ms: trial.created_at_ms, created_by: trial.created_by.label.clone(), event_count: run.events.len() as u64,
        manual_count: run.events.iter().filter(|event| event.kind == "manual").count() as u64,
        assumption_count: run.events.iter().filter(|event| event.assumption.is_some()).count() as u64,
        end_step_title: step.map(|step| step.title.clone()).unwrap_or_else(|| end.clone()), end_step_id: end,
        terminal: step.is_some_and(|step| step.terminal && (!step.external || manual_here)),
        parameter_ids: run.dependencies.iter().map(|dependency| dependency.id.clone()).collect(),
        candidates: run.candidates.iter().map(|candidate| TrialCandidateRef { id: candidate.id.clone(), revision: candidate.revision,
            parameter_id: candidate.parameter_id.clone(), label: candidate.label.clone(), value: candidate.value.clone() }).collect(),
    }
}

pub(crate) fn validate_adoption(adoption: &CandidateAdoption) -> Result<(), String> {
    id_text("采用记录 ID", &adoption.id)?;
    id_text("采用参数 ID", &adoption.parameter_id)?;
    validate_candidate(&adoption.candidate)?;
    if adoption.candidate.parameter_id != adoption.parameter_id || adoption.candidate.project_id != adoption.project_id {
        return Err("采用记录的候选不属于该参数。".into());
    }
    if adoption.parameter_revision_after != adoption.parameter_revision_before + 1 || adoption.parameter_revision_before == 0 {
        return Err("采用记录的参数版本不连续。".into());
    }
    if adoption.value_after != adoption.candidate.value { return Err("采用后的值与候选值不一致。".into()); }
    text("采用前的值", &adoption.value_before, 100)?;
    text("采用理由", &adoption.reason, 4096)?;
    if adoption.reason.trim().is_empty() { return Err("采用需要填写理由。".into()); }
    if adoption.trial_ids.len() > MAX_TRIAL_EVIDENCE || adoption.trial_ids.iter().collect::<BTreeSet<_>>().len() != adoption.trial_ids.len() {
        return Err(format!("采用依据最多 {MAX_TRIAL_EVIDENCE} 条且不能重复。"));
    }
    for trial in &adoption.trial_ids { id_text("采用依据试走 ID", trial)?; }
    line("采用请求 ID", &adoption.request_id, 256)
}

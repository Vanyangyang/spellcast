//! Amendments: the agent changes the running plan with a one-line reason. A change applies at
//! once as a new plan revision and marks the steps it touched; commands it adds or changes wait
//! for the user's approval. The user can revert an amendment, restoring the earlier plan fields
//! without touching files, and reopen a skipped step. Contract: docs/sigil-phase1-contract.md,
//! Amendments.

use std::collections::BTreeSet;
use std::path::PathBuf;

use rmcp::schemars::{self, JsonSchema};
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::sigil_store::Events;
use crate::sigil_verify::{queue_checks, stop_checks};
use crate::sigils::{amendment_error, consented_commands, file_sha256, pending_commands, step_finished, validate_plan, AmendmentChange, CheckStatus,
    Sigil, SigilActor, SigilAmendment, SigilCheck, SigilCommand, SigilStep, StepMarker, StepProgress, StepStatus};

const MAX_CHANGES: usize = 16;

/// One change of an amendment.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SigilAmendChange {
    /// A new step, placed after the step named in `after`, or at the end.
    AddStep {
        step: SigilStep,
        #[serde(default)]
        after: String,
    },
    /// New values for fields of a step that has not finished; omitted fields stay as they are.
    UpdateStep {
        step_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        title: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        instructions: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        inputs: Option<Vec<String>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        scope: Option<Vec<String>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        checks: Option<Vec<SigilCheck>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        depends_on: Option<Vec<String>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        stop_when: Option<Vec<String>>,
    },
    /// Skip a step that has not finished; it then counts as done for the steps depending on it.
    SkipStep { step_id: String },
}

fn marker(kind: &str, now: u64, detail: String) -> StepMarker {
    StepMarker { kind: kind.into(), at_ms: now, detail }
}

fn set<T: Clone + PartialEq>(field: &mut T, value: &Option<T>, name: &str, fields: &mut Vec<String>) {
    if let Some(value) = value.as_ref().filter(|value| *value != field) {
        *field = value.clone();
        fields.push(name.into());
    }
}

/// A reported step whose checks changed starts its verification over from the new definition.
fn requeue_if_checks_changed(step: &SigilStep, fields: &[String], progress: &mut StepProgress, consented: &[SigilCommand]) {
    if progress.status == StepStatus::Reported && fields.iter().any(|field| field == "checks") {
        progress.checks = queue_checks(step, progress.attempt, consented);
    }
}

/// Applies the executor's amendment to a running plan as a new revision.
pub(crate) fn apply_amend(sigil: &mut Sigil, source: &str, label: &str, reason: &str, changes: &[SigilAmendChange], now: u64, events: &mut Events)
    -> Result<(), String> {
    let reason = reason.trim();
    if reason.is_empty() || reason.chars().count() > 500 || reason.contains(['\n', '\r']) {
        return Err("修订需要一行理由，最多 500 字。".into());
    }
    if changes.is_empty() || changes.len() > MAX_CHANGES {
        return Err(format!("一次修订需要 1–{MAX_CHANGES} 项改动。"));
    }
    let run = sigil.run.as_ref().ok_or("法阵还没开始执行。")?;
    let finished = |step_id: &str| sigil.plan.steps.iter().find(|step| step.id == step_id).is_some_and(|step| step_finished(step, Some(run)));
    let mut plan = sigil.plan.clone();
    let mut recorded = Vec::new();
    for change in changes {
        match change {
            SigilAmendChange::AddStep { step, after } => {
                if plan.steps.iter().any(|existing| existing.id == step.id) {
                    return Err(format!("步骤 id {} 已存在。", step.id));
                }
                let position = if after.is_empty() {
                    plan.steps.len()
                } else {
                    plan.steps.iter().position(|existing| &existing.id == after).ok_or_else(|| format!("步骤 {after} 不存在。"))? + 1
                };
                plan.steps.insert(position, step.clone());
                recorded.push(AmendmentChange { kind: "add_step".into(), step_id: step.id.clone(), before: None, status_before: None, fields: vec![] });
            }
            SigilAmendChange::UpdateStep { step_id, title, instructions, inputs, scope, checks, depends_on, stop_when } => {
                let index = plan.steps.iter().position(|step| &step.id == step_id).ok_or_else(|| format!("步骤 {step_id} 不存在。"))?;
                if finished(step_id) {
                    return Err(format!("步骤 {step_id} 已经完成或跳过，不能再改；请新增一个步骤。"));
                }
                let before = plan.steps[index].clone();
                let step = &mut plan.steps[index];
                let mut fields = vec![];
                set(&mut step.title, title, "title", &mut fields);
                set(&mut step.instructions, instructions, "instructions", &mut fields);
                set(&mut step.inputs, inputs, "inputs", &mut fields);
                set(&mut step.scope, scope, "scope", &mut fields);
                set(&mut step.checks, checks, "checks", &mut fields);
                set(&mut step.depends_on, depends_on, "depends_on", &mut fields);
                set(&mut step.stop_when, stop_when, "stop_when", &mut fields);
                if fields.is_empty() {
                    return Err(format!("对步骤 {step_id} 的修改没有改变任何内容。"));
                }
                recorded.push(AmendmentChange { kind: "update_step".into(), step_id: step_id.clone(), before: Some(before), status_before: None, fields });
            }
            SigilAmendChange::SkipStep { step_id } => {
                if !plan.steps.iter().any(|step| &step.id == step_id) {
                    return Err(format!("步骤 {step_id} 不存在。"));
                }
                if finished(step_id) || recorded.iter().any(|change: &AmendmentChange| change.kind == "skip_step" && &change.step_id == step_id) {
                    return Err(format!("步骤 {step_id} 已经完成或跳过。"));
                }
                let status = run.steps.get(step_id).map(|progress| progress.status).unwrap_or_default();
                recorded.push(AmendmentChange { kind: "skip_step".into(), step_id: step_id.clone(), before: None, status_before: Some(status), fields: vec![] });
            }
        }
    }
    validate_plan(&plan)?;
    if let Some(error) = amendment_error(&plan) {
        return Err(format!("修订后的方案无法执行：{error}"));
    }
    // Inputs first declared here are hashed now; later changes are measured from this point.
    let declared: BTreeSet<&String> = sigil.plan.steps.iter().flat_map(|step| step.inputs.iter()).collect();
    let work = PathBuf::from(&run.execution_directory);
    let new_inputs: Vec<String> = plan.steps.iter().flat_map(|step| step.inputs.iter()).filter(|input| !declared.contains(input)).cloned().collect();
    let consented = consented_commands(sigil);
    let revision = sigil.revision + 1;
    sigil.plan = plan;
    sigil.revision = revision;
    sigil.updated_at_ms = now;
    sigil.updated_by = SigilActor { kind: "agent".into(), source_id: Some(source.into()), label: label.into() };
    let run = sigil.run.as_mut().expect("run checked above");
    for input in new_inputs {
        if !run.amended_inputs.contains_key(&input) {
            let hash = file_sha256(&work.join(&input)).ok();
            run.amended_inputs.insert(input, hash);
        }
    }
    let detail = format!("#{revision} {reason}");
    for change in &recorded {
        let progress = run.steps.entry(change.step_id.clone()).or_default();
        if !progress.markers.iter().any(|existing| existing.kind == "amended" && existing.detail == detail) {
            progress.markers.push(marker("amended", now, detail.clone()));
        }
        match change.kind.as_str() {
            "update_step" => {
                let step = sigil.plan.steps.iter().find(|step| step.id == change.step_id).expect("updated step present");
                requeue_if_checks_changed(step, &change.fields, progress, &consented);
            }
            "skip_step" => {
                stop_checks(progress, "步骤被跳过。", now);
                progress.status = StepStatus::Skipped;
            }
            _ => {}
        }
    }
    run.amendments.push(SigilAmendment { revision, at_ms: now, source_id: source.into(), reason: reason.into(), changes: recorded.clone(), reverted_at_ms: None });
    events.push(("amended".into(), json!({"revision": revision, "reason": reason,
        "changes": recorded.iter().map(|change| json!({"kind": change.kind, "step_id": change.step_id, "fields": change.fields})).collect::<Vec<_>>()})));
    let touched: BTreeSet<&str> = recorded.iter().map(|change| change.step_id.as_str()).collect();
    let waiting: Vec<_> = pending_commands(sigil).into_iter().filter(|(step_id, _, _)| touched.contains(step_id.as_str()))
        .map(|(step_id, index, command)| json!({"step_id": step_id, "index": index, "label": command.label, "argv": command.argv, "timeout_s": command.timeout_s}))
        .collect();
    if !waiting.is_empty() {
        events.push(("commands_need_approval".into(), json!({"revision": revision, "commands": waiting})));
    }
    Ok(())
}

/// The user approves a command an amendment added or changed. Checks waiting for it are queued.
pub(crate) fn approve_command(sigil: &mut Sigil, step_id: &str, index: usize, events: &mut Events) -> Result<(), String> {
    let step = sigil.plan.steps.iter().find(|step| step.id == step_id).ok_or_else(|| format!("步骤 {step_id} 不存在。"))?;
    let Some(SigilCheck::Command { label, argv, timeout_s }) = step.checks.get(index).cloned() else {
        return Err(format!("步骤 {step_id} 的第 {} 项验证不是命令。", index + 1));
    };
    let command = SigilCommand { step_id: step_id.into(), label: label.clone(), argv: argv.clone(), timeout_s };
    if consented_commands(sigil).iter().any(|existing| existing.step_id == command.step_id && existing.argv == command.argv && existing.timeout_s == command.timeout_s) {
        return Err("这条命令已经批准过了。".into());
    }
    let run = sigil.run.as_mut().ok_or("法阵还没开始执行。")?;
    run.approved_commands.push(command);
    if let Some(progress) = run.steps.get_mut(step_id) {
        let attempt = progress.attempt;
        for check in progress.checks.iter_mut().filter(|check| check.attempt == attempt && check.index == index && check.status == CheckStatus::NeedsApproval) {
            check.status = CheckStatus::Queued;
        }
    }
    events.push(("command_approved".into(), json!({"step_id": step_id, "index": index, "label": label, "argv": argv, "timeout_s": timeout_s})));
    Ok(())
}

/// The user reverts an amendment: the steps it touched get their earlier fields back, added steps
/// leave the plan and skipped steps reopen. Files are not touched. A later amendment that changed
/// the same steps has to be reverted first.
pub(crate) fn revert_amendment(sigil: &mut Sigil, revision: u64, now: u64, events: &mut Events) -> Result<(), String> {
    let run = sigil.run.as_ref().ok_or("法阵还没开始执行。")?;
    let position = run.amendments.iter().position(|amendment| amendment.revision == revision).ok_or_else(|| format!("没有修订 #{revision}。"))?;
    let amendment = run.amendments[position].clone();
    if amendment.reverted_at_ms.is_some() {
        return Err(format!("修订 #{revision} 已经撤销过了。"));
    }
    let touched: BTreeSet<&str> = amendment.changes.iter().map(|change| change.step_id.as_str()).collect();
    if let Some(later) = run.amendments[position + 1..].iter().filter(|later| later.reverted_at_ms.is_none())
        .find(|later| later.changes.iter().any(|change| touched.contains(change.step_id.as_str()))) {
        return Err(format!("之后的修订 #{} 也改了这些步骤；请先撤销它。", later.revision));
    }
    let added: BTreeSet<&str> = amendment.changes.iter().filter(|change| change.kind == "add_step").map(|change| change.step_id.as_str()).collect();
    let mut plan = sigil.plan.clone();
    for change in amendment.changes.iter().rev() {
        match (change.kind.as_str(), &change.before) {
            ("add_step", _) => plan.steps.retain(|step| step.id != change.step_id),
            ("update_step", Some(before)) => {
                if let Some(step) = plan.steps.iter_mut().find(|step| step.id == change.step_id) {
                    *step = before.clone();
                }
            }
            _ => {}
        }
    }
    if let Some(step) = plan.steps.iter().find(|step| step.depends_on.iter().any(|dependency| added.contains(dependency.as_str()))) {
        return Err(format!("步骤 {} 依赖这次修订新增的步骤；请先撤销或修改相关修订。", step.id));
    }
    if let Some(error) = amendment_error(&plan) {
        return Err(format!("撤销后的方案无法执行：{error}"));
    }
    let consented = consented_commands(sigil);
    let new_revision = sigil.revision + 1;
    sigil.plan = plan;
    sigil.revision = new_revision;
    sigil.updated_at_ms = now;
    sigil.updated_by = SigilActor::user();
    let run = sigil.run.as_mut().expect("run checked above");
    let detail = format!("#{revision}");
    for change in &amendment.changes {
        if change.kind == "add_step" {
            run.steps.remove(&change.step_id);
            continue;
        }
        let Some(progress) = run.steps.get_mut(&change.step_id) else { continue };
        progress.markers.push(marker("amendment_reverted", now, detail.clone()));
        match change.kind.as_str() {
            "update_step" => {
                let step = sigil.plan.steps.iter().find(|step| step.id == change.step_id).expect("restored step present");
                requeue_if_checks_changed(step, &change.fields, progress, &consented);
            }
            "skip_step" if progress.status == StepStatus::Skipped => {
                // A step that was reported before the skip keeps its report; anything else starts again.
                progress.status = if change.status_before == Some(StepStatus::Reported) { StepStatus::Reported } else { StepStatus::Pending };
            }
            _ => {}
        }
    }
    run.amendments[position].reverted_at_ms = Some(now);
    events.push(("amendment_reverted".into(), json!({"revision": new_revision, "reverted": revision,
        "steps": amendment.changes.iter().map(|change| change.step_id.clone()).collect::<Vec<_>>()})));
    Ok(())
}

/// The user reopens a skipped step; the agent then starts it like any pending step.
pub(crate) fn reopen_step(sigil: &mut Sigil, step_id: &str, now: u64, events: &mut Events) -> Result<(), String> {
    if !sigil.plan.steps.iter().any(|step| step.id == step_id) {
        return Err(format!("步骤 {step_id} 不存在。"));
    }
    let run = sigil.run.as_mut().ok_or("法阵还没开始执行。")?;
    let progress = run.steps.get_mut(step_id).filter(|progress| progress.status == StepStatus::Skipped)
        .ok_or("只有已跳过的步骤可以重新打开。")?;
    progress.status = StepStatus::Pending;
    progress.markers.push(marker("reopened", now, String::new()));
    events.push(("step_reopened".into(), json!({"step_id": step_id})));
    Ok(())
}

/// Commands waiting for approval, for the views.
pub(crate) fn waiting_commands(sigil: &Sigil) -> Vec<serde_json::Value> {
    pending_commands(sigil).into_iter()
        .map(|(step_id, index, command)| json!({"step_id": step_id, "index": index, "label": command.label, "argv": command.argv, "timeout_s": command.timeout_s}))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sigil_run::RunControl;
    use crate::sigil_workspace::{SigilAgentOp, SigilQuery, SigilUpdate};
    use crate::sigils::{SigilLocation, SigilPlan};
    use crate::{Bridge, Headless};
    use serde_json::Value;
    use spellcast_core::SpellcastError;
    use std::path::Path;

    struct Fixture {
        root: PathBuf,
        repo: PathBuf,
        bridge: Option<Bridge>,
    }

    impl Fixture {
        fn b(&self) -> &Bridge {
            self.bridge.as_ref().expect("bridge open")
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            drop(self.bridge.take());
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    fn sh(dir: &Path, args: &[&str]) {
        let output = std::process::Command::new("git")
            .args(["-c", "user.name=Sigil Test", "-c", "user.email=sigil@test.invalid", "-c", "commit.gpgsign=false"])
            .args(args).current_dir(dir).output().unwrap();
        assert!(output.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&output.stderr));
    }

    fn fixture() -> Fixture {
        let root = std::env::temp_dir().join(format!("sigil-amend-{}", uuid::Uuid::new_v4().simple()));
        let repo = root.join("repo");
        std::fs::create_dir_all(repo.join("src")).unwrap();
        std::fs::create_dir_all(repo.join("docs")).unwrap();
        std::fs::write(repo.join("src/lib.rs"), "pub fn answer() -> u8 { 42 }\n").unwrap();
        std::fs::write(repo.join("docs/spec.md"), "# Spec\n").unwrap();
        sh(&repo, &["init", "-q", "-b", "main"]);
        sh(&repo, &["add", "-A"]);
        sh(&repo, &["commit", "-q", "-m", "init"]);
        let bridge = Bridge::open(Headless, 0, &root.join("state.sqlite3")).unwrap();
        Fixture { root, repo, bridge: Some(bridge) }
    }

    fn command(label: &str, argv: &[&str]) -> SigilCheck {
        SigilCheck::Command { label: label.into(), argv: argv.iter().map(|arg| arg.to_string()).collect(), timeout_s: 120 }
    }

    fn step(id: &str, depends_on: &[&str], checks: Vec<SigilCheck>) -> SigilStep {
        SigilStep { id: id.into(), title: format!("Step {id}"), instructions: format!("Do {id}."), inputs: vec![], scope: vec!["src/**".into()], checks,
            depends_on: depends_on.iter().map(|id| id.to_string()).collect(), stop_when: vec![] }
    }

    async fn agent(b: &Bridge, request: &str, sigil: &str, source: &str, op: SigilAgentOp) -> Result<Value, SpellcastError> {
        b.sigil_agent_update(SigilUpdate { request_id: request.into(), sigil_id: sigil.into(), source_id: source.into(), label: "Runner".into(), op }).await
    }

    async fn amend(b: &Bridge, request: &str, sigil: &str, reason: &str, changes: Vec<SigilAmendChange>) -> Result<Value, SpellcastError> {
        agent(b, request, sigil, "claude:runner", SigilAgentOp::Amend { reason: reason.into(), changes }).await
    }

    async fn started(f: &Fixture, id: &str, steps: Vec<SigilStep>) {
        let plan = SigilPlan { title: format!("Amend {id}"), repository: f.repo.to_string_lossy().into(), location: SigilLocation::InPlace, steps, ..Default::default() };
        agent(f.b(), &format!("{id}-plan"), id, "claude:runner", SigilAgentOp::PutPlan { expected_revision: 0, plan }).await.unwrap();
        f.b().sigil_freeze(id, &format!("{id}-freeze"), 1).unwrap();
        f.b().sigil_start(id, &format!("{id}-start"), 2).await.unwrap();
        agent(f.b(), &format!("{id}-claim"), id, "claude:runner", SigilAgentOp::Claim).await.unwrap();
    }

    async fn start_and_report(b: &Bridge, sigil: &str, step: &str) {
        agent(b, &format!("{sigil}-{step}-start"), sigil, "claude:runner", SigilAgentOp::StartStep { step_id: step.into() }).await.unwrap();
        agent(b, &format!("{sigil}-{step}-report"), sigil, "claude:runner", SigilAgentOp::ReportStep { step_id: step.into(), summary: "done".into(), evidence: vec![] }).await.unwrap();
    }

    fn view(b: &Bridge, id: &str) -> Value {
        b.sigil_query(SigilQuery { view: "sigil".into(), sigil_id: id.into(), ..Default::default() }).unwrap()
    }

    fn step_ids(view: &Value) -> Vec<String> {
        view["sigil"]["steps"].as_array().unwrap().iter().map(|step| step["id"].as_str().unwrap().to_string()).collect()
    }

    fn marker_kinds(view: &Value, step: &str) -> Vec<String> {
        view["sigil"]["run"]["steps"][step]["markers"].as_array().cloned().unwrap_or_default().iter().map(|marker| marker["kind"].as_str().unwrap().to_string()).collect()
    }

    fn kinds(events: &Value) -> Vec<String> {
        events.as_array().unwrap().iter().map(|event| event["kind"].as_str().unwrap().to_string()).collect()
    }

    fn history(b: &Bridge, id: &str, operation: &str) -> i64 {
        b.sigil_store().unwrap().connection.query_row("SELECT COUNT(*) FROM spellcast_sigil_plan_history WHERE sigil_id = ?1 AND operation = ?2",
            rusqlite::params![id, operation], |row| row.get(0)).unwrap()
    }

    /// The fields an update sets; the rest stay as they are.
    #[derive(Default)]
    struct Fields {
        title: Option<String>,
        instructions: Option<String>,
        scope: Option<Vec<String>>,
        checks: Option<Vec<SigilCheck>>,
        depends_on: Option<Vec<String>>,
    }

    fn update(step_id: &str, fields: Fields) -> SigilAmendChange {
        SigilAmendChange::UpdateStep { step_id: step_id.into(), title: fields.title, instructions: fields.instructions, inputs: None, scope: fields.scope,
            checks: fields.checks, depends_on: fields.depends_on, stop_when: None }
    }

    #[tokio::test]
    async fn amendments_apply_at_once_and_refuse_what_could_not_run() {
        let f = fixture();
        let b = f.b();
        started(&f, "plan", vec![step("a", &[], vec![]), step("b", &["a"], vec![]), step("c", &["b"], vec![]), step("d", &["c"], vec![])]).await;
        start_and_report(b, "plan", "a").await;
        let revision = view(b, "plan")["sigil"]["revision"].as_u64().unwrap();
        let changed = amend(b, "amend-1", "plan", "Split the store work", vec![
            SigilAmendChange::AddStep { step: step("x", &["a"], vec![]), after: "a".into() },
            update("b", Fields { instructions: Some("Do b with the new store.".into()), scope: Some(vec!["src/store/**".into()]), ..Default::default() }),
            SigilAmendChange::SkipStep { step_id: "c".into() },
        ]).await.unwrap();
        assert_eq!(changed["next"]["id"], "x", "{changed}");
        let current = view(b, "plan");
        assert_eq!(current["sigil"]["revision"].as_u64().unwrap(), revision + 1, "an amendment is a new plan revision");
        assert_eq!(step_ids(&current), ["a", "x", "b", "c", "d"]);
        assert_eq!(current["sigil"]["steps"][2]["instructions"], "Do b with the new store.");
        assert_eq!(current["lights"]["c"], "skipped");
        assert_eq!(current["lights"]["d"], "ready", "a skipped step counts as done for its dependents");
        for touched in ["x", "b", "c"] {
            assert_eq!(marker_kinds(&current, touched), ["amended"], "{touched}");
        }
        assert_eq!(current["sigil"]["run"]["steps"]["b"]["markers"][0]["detail"], format!("#{} Split the store work", revision + 1));
        let amendment = &current["sigil"]["run"]["amendments"][0];
        assert_eq!(amendment["changes"][1]["fields"], json!(["instructions", "scope"]));
        assert_eq!(amendment["changes"][1]["before"]["instructions"], "Do b.");
        assert_eq!(history(b, "plan", "amend"), 1);
        let events = b.sigil_query(SigilQuery { view: "events".into(), sigil_id: "plan".into(), ..Default::default() }).unwrap();
        assert!(kinds(&events["events"]).contains(&"amended".to_string()));

        let refused = |result: Result<Value, SpellcastError>| result.unwrap_err().to_string();
        assert!(refused(amend(b, "amend-done", "plan", "Rename", vec![update("a", Fields { title: Some("A2".into()), ..Default::default() })]).await).contains("已经完成"));
        assert!(refused(amend(b, "amend-dup", "plan", "Again", vec![SigilAmendChange::AddStep { step: step("x", &[], vec![]), after: String::new() }]).await).contains("已存在"));
        assert!(refused(amend(b, "amend-cycle", "plan", "Loop", vec![update("b", Fields { depends_on: Some(vec!["d".into()]), ..Default::default() })]).await).contains("环"));
        assert!(refused(amend(b, "amend-reason", "plan", "two\nlines", vec![SigilAmendChange::SkipStep { step_id: "d".into() }]).await).contains("理由"));
        assert!(refused(amend(b, "amend-same", "plan", "Same", vec![update("x", Fields { title: Some("Step x".into()), ..Default::default() })]).await).contains("没有改变"));
        assert!(refused(amend(b, "amend-skip-again", "plan", "Skip", vec![SigilAmendChange::SkipStep { step_id: "c".into() }]).await).contains("已经完成或跳过"));
        assert!(refused(agent(b, "amend-other", "plan", "codex:other", SigilAgentOp::Amend { reason: "Mine".into(), changes: vec![SigilAmendChange::SkipStep { step_id: "d".into() }] }).await)
            .contains("claim"));
        assert_eq!(view(b, "plan")["sigil"]["revision"].as_u64().unwrap(), revision + 1, "refused amendments change nothing");
    }

    #[tokio::test]
    async fn commands_an_amendment_adds_wait_for_approval() {
        let f = fixture();
        let b = f.b();
        started(&f, "approve", vec![step("a", &[], vec![command("version", &["git", "--version"])])]).await;
        start_and_report(b, "approve", "a").await;
        let changed = amend(b, "amend-checks", "approve", "Also check the git directory", vec![update("a", Fields {
            checks: Some(vec![command("version", &["git", "--version"]), command("git dir", &["git", "rev-parse", "--git-dir"])]), ..Default::default() })]).await.unwrap();
        assert_eq!(changed["commands_waiting_approval"][0]["argv"], json!(["git", "rev-parse", "--git-dir"]), "{changed}");
        let current = view(b, "approve");
        assert_eq!(current["pending_commands"][0]["index"], 1);
        let statuses = |b: &Bridge| view(b, "approve")["sigil"]["run"]["steps"]["a"]["checks"].as_array().unwrap().iter()
            .map(|check| check["status"].as_str().unwrap().to_string()).collect::<Vec<_>>();
        assert_eq!(statuses(b), ["queued", "needs_approval"], "a reported step's checks start over from the new definition");
        b.sigil_run_checks("approve").await.unwrap();
        assert_eq!(statuses(b), ["passed", "needs_approval"], "an unapproved command never runs");
        assert_eq!(view(b, "approve")["lights"]["a"], "needs_you");

        assert!(b.sigil_approve_command("approve", "approve-manual", "a", 5).unwrap_err().to_string().contains("不是命令"));
        b.sigil_approve_command("approve", "approve-dir", "a", 1).unwrap();
        assert!(b.sigil_approve_command("approve", "approve-again", "a", 1).unwrap_err().to_string().contains("已经批准"));
        assert_eq!(statuses(b), ["passed", "queued"]);
        assert!(view(b, "approve")["pending_commands"].as_array().unwrap().is_empty());
        let noted = agent(b, "note", "approve", "claude:runner", SigilAgentOp::Note { text: "ok".into() }).await.unwrap();
        assert!(kinds(&noted["notices"]).contains(&"command_approved".to_string()), "{noted}");
        b.sigil_run_checks("approve").await.unwrap();
        assert_eq!(statuses(b), ["passed", "passed"]);
        assert_eq!(view(b, "approve")["sigil"]["state"], "completed");
    }

    #[tokio::test]
    async fn reverting_restores_earlier_fields_and_reopening_unskips() {
        let f = fixture();
        let b = f.b();
        started(&f, "undo", vec![step("a", &[], vec![]), step("b", &["a"], vec![]), step("c", &["b"], vec![])]).await;
        let rev = |value: &Value| value["sigil"]["revision"].as_u64().unwrap();
        amend(b, "amend-b", "undo", "Narrow b", vec![update("b", Fields { instructions: Some("B2".into()), ..Default::default() })]).await.unwrap();
        let first = rev(&view(b, "undo"));
        amend(b, "amend-y", "undo", "Add y", vec![SigilAmendChange::AddStep { step: step("y", &["b"], vec![]), after: "b".into() }]).await.unwrap();
        let second = rev(&view(b, "undo"));
        amend(b, "amend-c", "undo", "Skip c", vec![SigilAmendChange::SkipStep { step_id: "c".into() }]).await.unwrap();
        let third = rev(&view(b, "undo"));
        amend(b, "amend-y2", "undo", "Rename y", vec![update("y", Fields { title: Some("Y2".into()), ..Default::default() })]).await.unwrap();
        let fourth = rev(&view(b, "undo"));

        b.sigil_revert_amendment("undo", "revert-b", first).unwrap();
        let current = view(b, "undo");
        assert_eq!(current["sigil"]["steps"][1]["instructions"], "Do b.");
        assert_eq!(marker_kinds(&current, "b"), ["amended", "amendment_reverted"]);
        assert!(current["sigil"]["run"]["amendments"][0]["reverted_at_ms"].is_u64());
        assert_eq!(history(b, "undo", "revert_amendment"), 1);
        assert!(b.sigil_revert_amendment("undo", "revert-b-again", first).unwrap_err().to_string().contains("已经撤销"));
        assert!(b.sigil_revert_amendment("undo", "revert-ghost", 999).unwrap_err().to_string().contains("没有修订"));
        assert!(b.sigil_revert_amendment("undo", "revert-y-early", second).unwrap_err().to_string().contains(&format!("#{fourth}")), "a later amendment changed y");
        b.sigil_revert_amendment("undo", "revert-y2", fourth).unwrap();
        b.sigil_revert_amendment("undo", "revert-y", second).unwrap();
        assert_eq!(step_ids(&view(b, "undo")), ["a", "b", "c"]);
        assert!(view(b, "undo")["sigil"]["run"]["steps"]["y"].is_null(), "the added step leaves the run too");
        b.sigil_revert_amendment("undo", "revert-c", third).unwrap();
        assert_eq!(view(b, "undo")["lights"]["c"], "pending", "a reverted skip reopens the step");

        let again = amend(b, "amend-c-again", "undo", "Skip c after all", vec![SigilAmendChange::SkipStep { step_id: "c".into() }]).await.unwrap();
        assert_eq!(kinds(&again["notices"]).iter().filter(|kind| *kind == "amendment_reverted").count(), 4, "the agent hears each revert once");
        assert!(b.sigil_reopen_step("undo", "reopen-b", "b").unwrap_err().to_string().contains("已跳过"));
        b.sigil_reopen_step("undo", "reopen-c", "c").unwrap();
        let current = view(b, "undo");
        assert_eq!(current["lights"]["c"], "pending");
        assert!(marker_kinds(&current, "c").contains(&"reopened".to_string()));
        let noted = agent(b, "note", "undo", "claude:runner", SigilAgentOp::Note { text: "ok".into() }).await.unwrap();
        assert_eq!(kinds(&noted["notices"]), ["step_reopened"]);
        b.sigil_control("undo", "abort", RunControl::Abort).unwrap();
        assert!(b.sigil_reopen_step("undo", "reopen-late", "c").unwrap_err().to_string().contains("没有在执行"));
    }

    #[tokio::test]
    async fn inputs_an_amendment_declares_are_measured_from_the_amendment() {
        let f = fixture();
        let b = f.b();
        started(&f, "inputs", vec![SigilStep { inputs: vec!["docs/spec.md".into()], ..step("a", &[], vec![]) }]).await;
        std::fs::write(f.repo.join("docs/new.md"), "# New\n").unwrap();
        amend(b, "amend-inputs", "inputs", "Steps for the docs", vec![
            SigilAmendChange::AddStep { step: SigilStep { inputs: vec!["docs/new.md".into()], ..step("z", &[], vec![]) }, after: String::new() },
            SigilAmendChange::AddStep { step: SigilStep { inputs: vec!["docs/spec.md".into()], ..step("w", &[], vec![]) }, after: String::new() },
        ]).await.unwrap();
        assert!(view(b, "inputs")["sigil"]["run"]["amended_inputs"]["docs/new.md"].is_string());
        assert!(view(b, "inputs")["sigil"]["run"]["amended_inputs"]["docs/spec.md"].is_null(), "docs/spec.md was hashed at freeze");
        agent(b, "z-start", "inputs", "claude:runner", SigilAgentOp::StartStep { step_id: "z".into() }).await.unwrap();
        assert!(!marker_kinds(&view(b, "inputs"), "z").contains(&"input_changed".to_string()), "unchanged since the amendment");
        std::fs::write(f.repo.join("docs/spec.md"), "# Spec, changed by someone else\n").unwrap();
        agent(b, "w-start", "inputs", "claude:runner", SigilAgentOp::StartStep { step_id: "w".into() }).await.unwrap();
        assert!(marker_kinds(&view(b, "inputs"), "w").contains(&"input_changed".to_string()));
    }
}

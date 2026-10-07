//! Sigil runs: the user starts a frozen plan, one executor claims it and reports steps. Every
//! change appends events; the step projection lives in the sigil row. Only the plan and
//! lifecycle move the revision, so the user's controls do not race the agent's reports.

use std::path::Path;
use std::sync::LazyLock;
use std::time::Duration;

use serde_json::{json, Value};
use spellcast_core::{inbox::now_ms, SpellcastError};

use crate::sigil_amend::{apply_amend, approve_command, reopen_step, revert_amendment, waiting_commands, SigilAmendChange};
use crate::sigil_observe::{apply_agent_at, baseline};
use crate::sigil_snapshot::git;
use crate::sigil_store::{actor_json, check_revision, Applied, Events, SigilMutation};
use crate::sigil_verify::{decide_check, queue_checks_with_automation, rerun_checks, stop_checks, verified_event};
use crate::sigils::{all_finished, current_checks, dependencies_finished, is_notice, next_step, step_light, validate_sigil_id, verification, CheckStatus, Sigil, SigilCheck,
    SigilActor, SigilAutomation, SigilClaim, SigilCommand, SigilExecutor, SigilLocation, SigilObservation, SigilRun, SigilState, SigilStep, StepMarker, StepProgress,
    StepStatus};
use crate::Bridge;

/// Wakes `wait` calls and the observation loop after any sigil change. Waiters re-check their
/// own sigil.
pub(crate) static SIGIL_CHANGED: LazyLock<tokio::sync::Notify> = LazyLock::new(tokio::sync::Notify::new);
// Serialize preparation so concurrent retries cannot create or roll back each other's worktree.
static START_GATE: LazyLock<tokio::sync::Mutex<()>> = LazyLock::new(|| tokio::sync::Mutex::new(()));

struct PreparedWorktree {
    directory: String,
    branch: String,
    base_ref: String,
    base_commit: String,
    created: bool,
}

pub const MAX_WAIT_S: u32 = 55;

fn fail(error: impl ToString) -> SpellcastError {
    SpellcastError::user(error.to_string())
}

/// Window-only run controls.
#[derive(Debug, Clone, Copy)]
pub enum RunControl {
    Pause,
    Resume,
    Abort,
}

/// Agent run operations, already validated for shape.
pub(crate) enum AgentRunOp<'a> {
    Claim,
    StartStep { step_id: &'a str },
    ReportStep { step_id: &'a str, summary: &'a str, evidence: &'a [String] },
    BlockStep { step_id: &'a str, reason: &'a str },
    RerunChecks { step_id: &'a str },
    Amend { reason: &'a str, changes: &'a [SigilAmendChange] },
    Note { text: &'a str },
}

fn executor_error(run: &SigilRun, source: &str) -> String {
    if run.replaced.iter().any(|item| item == source) {
        "replaced：用户已把执行交给另一个会话；这个会话不再推进法阵。".into()
    } else if run.revoked.iter().any(|item| item == source) {
        "revoked：用户撤销了这个会话的执行权；需要用户批准才能再次认领。".into()
    } else {
        "你不是当前执行者；请先用 op=claim 认领。".into()
    }
}

fn ensure_running(sigil: &Sigil) -> Result<(), String> {
    match sigil.state {
        SigilState::Running => Ok(()),
        SigilState::Paused => Err("paused：用户暂停了执行；用 wait 等待继续。".into()),
        SigilState::Completed | SigilState::Aborted | SigilState::Archived => Err("法阵已经结束。".into()),
        SigilState::Draft | SigilState::Frozen => Err("法阵还没开始执行；用户已明确授权执行时可用 op=execute，或在 Spellcast 窗口开始。".into()),
    }
}

/// The user's verification decisions apply while the run is running or paused.
fn ensure_open(sigil: &Sigil) -> Result<(), String> {
    if matches!(sigil.state, SigilState::Running | SigilState::Paused) {
        Ok(())
    } else {
        Err("法阵没有在执行中。".into())
    }
}

fn plan_step<'a>(sigil: &'a Sigil, step_id: &str) -> Result<&'a SigilStep, String> {
    sigil.plan.steps.iter().find(|step| step.id == step_id).ok_or_else(|| format!("步骤 {step_id} 不存在。"))
}

fn marker(kind: &str, now: u64, detail: impl Into<String>) -> StepMarker {
    StepMarker { kind: kind.into(), at_ms: now, detail: detail.into() }
}

fn bounded(label: &str, value: &str, max: usize) -> Result<(), SpellcastError> {
    if value.chars().count() > max {
        return Err(fail(format!("{label}最多 {max} 字。")));
    }
    Ok(())
}

fn consented(sigil: &Sigil) -> Vec<SigilCommand> {
    crate::sigils::consented_commands(sigil)
}

/// A report closes the step and queues its checks.
fn mark_reported(step: &SigilStep, progress: &mut StepProgress, consented: &[SigilCommand], automation: SigilAutomation, now: u64) {
    progress.status = StepStatus::Reported;
    progress.reported_at_ms = Some(now);
    progress.checks = queue_checks_with_automation(step, progress.attempt, consented, automation);
}

/// Finishing the last step completes the run; that is a lifecycle change.
pub(crate) fn complete_if_finished(sigil: &mut Sigil, now: u64, events: &mut Events) -> Option<&'static str> {
    let run = sigil.run.as_ref()?;
    if sigil.state != SigilState::Running || !all_finished(&sigil.plan, run) {
        return None;
    }
    sigil.state = SigilState::Completed;
    sigil.revision += 1;
    sigil.updated_at_ms = now;
    events.push(("completed".into(), json!({"revision": sigil.revision})));
    Some("complete")
}

/// The agent-facing rules. Pure apart from the clock; the store supplies the transaction.
pub(crate) fn apply_agent(op: &AgentRunOp<'_>, source: &str, label: &str, current: Option<Sigil>, now: u64, events: &mut Events) -> Result<Applied, String> {
    let mut sigil = current.ok_or("法阵不存在。")?;
    if sigil.run.is_none() {
        ensure_running(&sigil)?;
    }
    let state = sigil.state;
    let run = sigil.run.as_mut().ok_or("法阵还没开始执行。")?;
    if let AgentRunOp::Claim = op {
        if matches!(state, SigilState::Completed | SigilState::Aborted | SigilState::Archived) {
            return Err("法阵已经结束。".into());
        }
        let blocked = run.revoked.iter().chain(run.replaced.iter()).any(|item| item == source);
        match &mut run.executor {
            Some(executor) if executor.source_id == source => executor.label = label.into(),
            None if !blocked => {
                run.executor = Some(SigilExecutor { source_id: source.into(), label: label.into(), since_ms: now });
                events.push(("claimed".into(), json!({"source_id": source, "label": label})));
            }
            _ => {
                if let Some(claim) = run.pending_claims.iter_mut().find(|claim| claim.source_id == source) {
                    claim.label = label.into();
                } else {
                    run.pending_claims.push(SigilClaim { source_id: source.into(), label: label.into(), at_ms: now });
                    events.push(("handover_requested".into(), json!({"source_id": source, "label": label})));
                }
            }
        }
        return Ok(Applied::Write { sigil: Box::new(sigil), history: None, created: false });
    }
    if run.executor.as_ref().is_none_or(|executor| executor.source_id != source) {
        return Err(executor_error(run, source));
    }
    match op {
        AgentRunOp::Claim => unreachable!(),
        AgentRunOp::Note { text } => events.push(("agent_note".into(), json!({"text": text}))),
        AgentRunOp::BlockStep { step_id, reason } => {
            if matches!(state, SigilState::Completed | SigilState::Aborted | SigilState::Archived) {
                return Err("法阵已经结束。".into());
            }
            plan_step(&sigil, step_id)?;
            let run = sigil.run.as_mut().expect("run checked above");
            let progress = run.steps.entry(step_id.to_string()).or_default();
            if progress.status == StepStatus::Skipped {
                return Err(format!("步骤 {step_id} 已跳过。"));
            }
            progress.status = StepStatus::Blocked;
            progress.block_reason = reason.to_string();
            events.push(("step_blocked".into(), json!({"step_id": step_id, "reason": reason})));
        }
        AgentRunOp::StartStep { step_id } => {
            ensure_running(&sigil)?;
            let step = plan_step(&sigil, step_id)?.clone();
            let run_view = sigil.run.as_ref().expect("run checked above");
            let status = run_view.steps.get(*step_id).map(|progress| progress.status).unwrap_or_default();
            match status {
                StepStatus::Skipped => return Err(format!("步骤 {step_id} 已跳过。")),
                StepStatus::Active => return Ok(Applied::Write { sigil: Box::new(sigil), history: None, created: false }),
                StepStatus::Pending if !dependencies_finished(&sigil.plan, Some(run_view), &step) => {
                    let waiting: Vec<&str> = step.depends_on.iter().map(String::as_str)
                        .filter(|dependency| sigil.plan.steps.iter().find(|candidate| candidate.id == *dependency)
                            .is_none_or(|candidate| !crate::sigils::step_finished(candidate, Some(run_view))))
                        .collect();
                    return Err(format!("依赖还没完成：{}。", waiting.join("、")));
                }
                _ => {}
            }
            let consented = consented(&sigil);
            let active: Vec<SigilStep> = sigil.plan.steps.iter()
                .filter(|candidate| candidate.id != *step_id && run_view.steps.get(&candidate.id).is_some_and(|progress| progress.status == StepStatus::Active))
                .cloned().collect();
            let run = sigil.run.as_mut().expect("run checked above");
            for previous_step in active {
                let previous = run.steps.get_mut(&previous_step.id).expect("active step present");
                mark_reported(&previous_step, previous, &consented, run.automation, now);
                previous.markers.push(marker("reported_automatically", now, format!("开始 {step_id} 时自动结束")));
                events.push(("step_reported".into(), json!({"step_id": previous_step.id, "automatic": true, "checks": previous.checks.len()})));
            }
            let progress = run.steps.entry(step_id.to_string()).or_default();
            if status != StepStatus::Blocked {
                // A new attempt: checks of the previous report that have not finished stop.
                stop_checks(progress, "步骤开始了新的尝试。", now);
                progress.attempt += 1;
            }
            progress.status = StepStatus::Active;
            progress.block_reason.clear();
            progress.started_at_ms = Some(now);
            events.push(("step_started".into(), json!({"step_id": step_id, "attempt": progress.attempt})));
        }
        AgentRunOp::ReportStep { step_id, summary, evidence } => {
            ensure_running(&sigil)?;
            let step = plan_step(&sigil, step_id)?.clone();
            let dependencies_done = dependencies_finished(&sigil.plan, sigil.run.as_ref(), &step);
            let consented = consented(&sigil);
            let run = sigil.run.as_mut().expect("run checked above");
            let progress = run.steps.entry(step_id.to_string()).or_default();
            match progress.status {
                StepStatus::Skipped => return Err(format!("步骤 {step_id} 已跳过。")),
                StepStatus::Pending => {
                    progress.attempt += 1;
                    progress.markers.push(marker("reported_without_start", now, ""));
                    if !dependencies_done {
                        progress.markers.push(marker("dependencies_unfinished", now, ""));
                    }
                }
                StepStatus::Active | StepStatus::Blocked | StepStatus::Reported => {}
            }
            mark_reported(&step, progress, &consented, run.automation, now);
            progress.summary = summary.to_string();
            progress.evidence = evidence.to_vec();
            progress.block_reason.clear();
            events.push(("step_reported".into(), json!({"step_id": step_id, "attempt": progress.attempt, "summary": summary,
                "checks": progress.checks.len()})));
            let history = complete_if_finished(&mut sigil, now, events);
            return Ok(Applied::Write { sigil: Box::new(sigil), history, created: false });
        }
        AgentRunOp::RerunChecks { step_id } => {
            ensure_running(&sigil)?;
            let step = plan_step(&sigil, step_id)?.clone();
            let consented = consented(&sigil);
            let run = sigil.run.as_mut().expect("run checked above");
            let progress = run.steps.entry(step_id.to_string()).or_default();
            let checks = rerun_checks(&step, progress, &consented)?;
            events.push(("checks_rerun".into(), json!({"step_id": step_id, "attempt": progress.attempt, "checks": checks, "by": "agent"})));
        }
        AgentRunOp::Amend { reason, changes } => {
            ensure_running(&sigil)?;
            apply_amend(&mut sigil, source, label, reason, changes, now, events)?;
            // Skipping the last unfinished step completes the run.
            let history = complete_if_finished(&mut sigil, now, events).or(Some("amend"));
            return Ok(Applied::Write { sigil: Box::new(sigil), history, created: false });
        }
    }
    Ok(Applied::Write { sigil: Box::new(sigil), history: None, created: false })
}

/// Window-side run changes.
pub(crate) enum UserRunOp<'a> {
    Control(RunControl),
    Automation { expected_revision: u64 },
    Handover { source_id: &'a str, approve: bool },
    Revoke,
    Note { text: &'a str },
    DecideCheck { step_id: &'a str, index: usize, passed: bool, note: &'a str },
    RerunChecks { step_id: &'a str },
    ApproveCommand { step_id: &'a str, index: usize },
    RevertAmendment { revision: u64 },
    ReopenStep { step_id: &'a str },
}

pub(crate) fn apply_user(op: &UserRunOp<'_>, current: Option<Sigil>, now: u64, events: &mut Events) -> Result<Applied, String> {
    let mut sigil = current.ok_or("法阵不存在。")?;
    let user = SigilActor::user();
    if sigil.run.is_none() {
        return Err("法阵还没开始执行。".into());
    }
    let mut history = None;
    match op {
        UserRunOp::Automation { expected_revision } => {
            ensure_open(&sigil)?;
            check_revision(&sigil, *expected_revision)?;
            let run = sigil.run.as_mut().expect("run checked above");
            // A fresh request at the current revision is harmless after the upgrade. Receipt
            // replay is handled before this operation, including after a later lifecycle change.
            if run.automation == SigilAutomation::Autonomous {
                return Ok(Applied::Write { sigil: Box::new(sigil), history: None, created: false });
            }
            run.automation = SigilAutomation::Autonomous;
            let (mut queued, mut deferred) = (0, 0);
            for step in &sigil.plan.steps {
                let Some(progress) = run.steps.get_mut(&step.id).filter(|progress| progress.status == StepStatus::Reported) else { continue };
                let before = verification(step, progress);
                for check in progress.checks.iter_mut().filter(|check| check.attempt == progress.attempt) {
                    match (step.checks.get(check.index), check.kind.as_str(), check.status) {
                        (Some(SigilCheck::Command { .. }), "command", CheckStatus::NeedsApproval) => {
                            check.status = CheckStatus::Queued;
                            queued += 1;
                        }
                        (Some(SigilCheck::Manual { blocking: false, .. }), "manual", CheckStatus::Waiting) => {
                            check.status = CheckStatus::Deferred;
                            deferred += 1;
                        }
                        _ => {}
                    }
                }
                verified_event(step, before, progress, events);
            }
            sigil.revision += 1;
            sigil.updated_at_ms = now;
            sigil.updated_by = user.clone();
            events.push(("automation_changed".into(), json!({"revision": sigil.revision, "from": "supervised", "to": "autonomous",
                "queued_commands": queued, "deferred_reviews": deferred, "actor": actor_json(&user)})));
            history = Some("automation_changed");
            complete_if_finished(&mut sigil, now, events);
        }
        UserRunOp::Control(control) => {
            let (from_ok, to, kind) = match control {
                RunControl::Pause => (sigil.state == SigilState::Running, SigilState::Paused, "paused"),
                RunControl::Resume => (sigil.state == SigilState::Paused, SigilState::Running, "resumed"),
                RunControl::Abort => (matches!(sigil.state, SigilState::Running | SigilState::Paused), SigilState::Aborted, "aborted"),
            };
            if !from_ok {
                return Err(format!("当前状态不能{}。", match control { RunControl::Pause => "暂停", RunControl::Resume => "继续", RunControl::Abort => "中止" }));
            }
            sigil.state = to;
            sigil.revision += 1;
            sigil.updated_at_ms = now;
            sigil.updated_by = user.clone();
            events.push((kind.into(), json!({"revision": sigil.revision})));
            history = Some(kind);
            match control {
                // Aborting ends the running command and drops the queue; finished results stay.
                RunControl::Abort => {
                    for progress in sigil.run.as_mut().expect("run checked above").steps.values_mut() {
                        stop_checks(progress, "执行已中止。", now);
                    }
                }
                // Checks may have finished the last step while the run was paused.
                RunControl::Resume => history = complete_if_finished(&mut sigil, now, events).or(history),
                RunControl::Pause => {}
            }
        }
        UserRunOp::DecideCheck { step_id, index, passed, note } => {
            let step = plan_step(&sigil, step_id)?.clone();
            // Autonomous completion can leave explicitly unperformed, non-blocking reviews.
            // They remain reviewable after execution without reopening or inventing a pass.
            let completed_review = sigil.state == SigilState::Completed
                && sigil.run.as_ref().is_some_and(|run| run.automation == SigilAutomation::Autonomous)
                && matches!(step.checks.get(*index), Some(crate::sigils::SigilCheck::Manual { blocking: false, .. }));
            if !completed_review { ensure_open(&sigil)?; }
            let progress = sigil.run.as_mut().expect("run checked above").steps.get_mut(*step_id).ok_or_else(|| format!("步骤 {step_id} 还没报告完成。"))?;
            let before = verification(&step, progress);
            let decided = decide_check(&step, progress, *index, *passed, note, now)?;
            events.push(("check_decided".into(), json!({"step_id": step_id, "attempt": decided.attempt, "index": index, "label": decided.label,
                "passed": passed, "note": note})));
            verified_event(&step, before, progress, events);
            history = complete_if_finished(&mut sigil, now, events);
        }
        UserRunOp::RerunChecks { step_id } => {
            ensure_open(&sigil)?;
            let step = plan_step(&sigil, step_id)?.clone();
            let consented = consented(&sigil);
            let progress = sigil.run.as_mut().expect("run checked above").steps.get_mut(*step_id).ok_or_else(|| format!("步骤 {step_id} 还没报告完成。"))?;
            let checks = rerun_checks(&step, progress, &consented)?;
            events.push(("checks_rerun".into(), json!({"step_id": step_id, "attempt": progress.attempt, "checks": checks, "by": "user"})));
        }
        UserRunOp::ApproveCommand { step_id, index } => {
            ensure_open(&sigil)?;
            approve_command(&mut sigil, step_id, *index, events)?;
        }
        UserRunOp::RevertAmendment { revision } => {
            ensure_open(&sigil)?;
            revert_amendment(&mut sigil, *revision, now, events)?;
            history = Some("revert_amendment");
        }
        UserRunOp::ReopenStep { step_id } => {
            ensure_open(&sigil)?;
            reopen_step(&mut sigil, step_id, now, events)?;
        }
        UserRunOp::Handover { source_id, approve } => {
            let run = sigil.run.as_mut().expect("run checked above");
            let index = run.pending_claims.iter().position(|claim| claim.source_id == *source_id)
                .ok_or("这个来源没有等待批准的认领。")?;
            let claim = run.pending_claims.remove(index);
            if *approve {
                if let Some(previous) = run.executor.take() {
                    run.replaced.retain(|item| item != &previous.source_id);
                    run.replaced.push(previous.source_id.clone());
                    events.push(("handover_approved".into(), json!({"from": previous.source_id, "to": claim.source_id})));
                } else {
                    events.push(("handover_approved".into(), json!({"from": null, "to": claim.source_id})));
                }
                run.revoked.retain(|item| item != &claim.source_id);
                run.replaced.retain(|item| item != &claim.source_id);
                run.executor = Some(SigilExecutor { source_id: claim.source_id, label: claim.label, since_ms: now });
            } else {
                events.push(("handover_rejected".into(), json!({"source_id": claim.source_id})));
            }
        }
        UserRunOp::Revoke => {
            let run = sigil.run.as_mut().expect("run checked above");
            let executor = run.executor.take().ok_or("当前没有执行者。")?;
            run.revoked.retain(|item| item != &executor.source_id);
            run.revoked.push(executor.source_id.clone());
            events.push(("executor_revoked".into(), json!({"source_id": executor.source_id})));
        }
        UserRunOp::Note { text } => events.push(("user_note".into(), json!({"text": text, "actor": actor_json(&user)}))),
    }
    Ok(Applied::Write { sigil: Box::new(sigil), history, created: false })
}

fn compact_step(sigil: &Sigil, step: &SigilStep) -> Value {
    let run = sigil.run.as_ref();
    let progress = run.and_then(|run| run.steps.get(&step.id)).cloned().unwrap_or_default();
    let mut value = json!({
        "id": step.id, "title": step.title, "instructions": step.instructions, "inputs": step.inputs, "scope": step.scope,
        "checks": step.checks, "depends_on": step.depends_on, "stop_when": step.stop_when,
        "light": step_light(&sigil.plan, run, step), "status": progress.status, "attempt": progress.attempt,
    });
    // A step whose verification failed comes back as next: show why.
    if progress.status == StepStatus::Reported && !progress.checks.is_empty() {
        value["verification"] = json!(verification(step, &progress));
        value["check_results"] = json!(current_checks(&progress).collect::<Vec<_>>());
    }
    value
}

/// What an executor needs after each call: where it stands, what to do next and what changed.
fn agent_view(sigil: &Sigil, mutation: &SigilMutation, step_id: Option<&str>) -> Value {
    let run = sigil.run.as_ref();
    let remaining = if sigil.state == SigilState::Completed { 0 } else {
        run.map(|run| sigil.plan.steps.iter().filter(|step| !crate::sigils::step_finished(step, Some(run))).count()).unwrap_or(0)
    };
    let executable = matches!(sigil.state, SigilState::Running | SigilState::Paused);
    let mut value = json!({
        "sigil_id": sigil.id, "state": sigil.state, "replayed": mutation.replayed,
        "executor": run.and_then(|run| run.executor.clone()),
        "next": run.filter(|_| executable).and_then(|run| next_step(&sigil.plan, run)).map(|step| compact_step(sigil, step)),
        "remaining": remaining, "notices": mutation.notices, "cursor": mutation.cursor,
    });
    // Commands an amendment added or changed run only after the user approves them.
    let waiting = waiting_commands(sigil);
    if !waiting.is_empty() {
        value["commands_waiting_approval"] = json!(waiting);
    }
    if let Some(step) = step_id.and_then(|id| sigil.plan.steps.iter().find(|step| step.id == id)) {
        let progress = run.and_then(|run| run.steps.get(&step.id)).cloned().unwrap_or_default();
        value["step"] = json!({"id": step.id, "light": step_light(&sigil.plan, run, step), "status": progress.status,
            "attempt": progress.attempt, "markers": progress.markers, "changed_files": progress.changed_files,
            "outside_scope": progress.outside_scope, "verification": verification(step, &progress),
            "check_results": current_checks(&progress).collect::<Vec<_>>()});
    }
    value
}

impl Bridge {
    /// Wakes waiters and the observation loop, ends a command whose check no longer runs and
    /// refreshes the sigil's card. Callers must not hold the store.
    pub(crate) fn sigil_changed(&self, sigil_id: &str) {
        self.cancel_stale_check(sigil_id);
        SIGIL_CHANGED.notify_waiters();
        self.surface.sigil_changed(sigil_id);
    }

    pub(crate) async fn sigil_agent_run(&self, request_id: &str, hash: &str, sigil_id: &str, source: &str, label: &str, op: AgentRunOp<'_>) -> Result<Value, SpellcastError> {
        if let AgentRunOp::ReportStep { summary, evidence, .. } = &op {
            bounded("summary", summary, 4_000)?;
            if evidence.len() > 16 || evidence.iter().any(|item| item.chars().count() > 1_000) {
                return Err(fail("evidence 最多 16 条，每条最多 1000 字。"));
            }
        }
        if let AgentRunOp::BlockStep { reason, .. } = &op {
            bounded("reason", reason, 2_000)?;
        }
        if let AgentRunOp::Note { text } = &op {
            bounded("note", text, 4_000)?;
        }
        let step_id = match &op {
            AgentRunOp::StartStep { step_id } | AgentRunOp::ReportStep { step_id, .. } | AgentRunOp::BlockStep { step_id, .. }
            | AgentRunOp::RerunChecks { step_id } => Some(step_id.to_string()),
            _ => None,
        };
        let claim = matches!(op, AgentRunOp::Claim);
        // A step start or report snapshots the directory first. Replays and refusals answer
        // without one; the transaction applies the same rules again.
        let mut boundary = None;
        if matches!(op, AgentRunOp::StartStep { .. } | AgentRunOp::ReportStep { .. }) {
            let (replay, current) = {
                let store = self.sigil_store()?;
                (store.sigil_receipt(request_id, hash).map_err(fail)?, store.sigil_get(sigil_id).ok())
            };
            if replay.is_none() {
                apply_agent(&op, source, label, current, now_ms(), &mut Events::new()).map_err(fail)?;
                boundary = self.sigil_boundary(sigil_id, &op).await?;
            }
        }
        let mutation = self.sigil_store()?
            .sigil_apply(request_id, hash, sigil_id, now_ms(), Some(source), |current, events| {
                apply_agent_at(&op, source, label, current, now_ms(), events, boundary.as_ref())
            })
            .map_err(fail)?;
        drop(boundary);
        if !mutation.replayed {
            self.sigil_changed(sigil_id);
        }
        // Answer from the current state so a replay still shows what to do now.
        let sigil = self.sigil_store()?.sigil_get(sigil_id).map_err(fail)?;
        let mut value = agent_view(&sigil, &mutation, step_id.as_deref());
        if claim {
            let executor = sigil.run.as_ref().and_then(|run| run.executor.as_ref()).map(|executor| executor.source_id.as_str());
            value["status"] = json!(if executor == Some(source) { "accepted" } else { "waiting_handover" });
            value["guidance"] = json!("这是唯一的计划：你自己的计划或待办列表只用来拆分当前步骤内部的小任务。按 next 逐步执行：先 start_step，再只改 scope 内的文件，完成后 report_step；需要用户决定时 block_step。验证由 Spellcast 运行，你报告的测试结果不算验证。");
        }
        Ok(value)
    }

    fn user_run(&self, sigil_id: &str, request_id: &str, hash: &str, op: UserRunOp<'_>) -> Result<Value, SpellcastError> {
        let guard = self.sigil_dispatch_gate.lock().map_err(|_| fail("法阵投递协调不可用。"))?;
        let mutation = self.sigil_store()?
            .sigil_apply(request_id, hash, sigil_id, now_ms(), None, |current, events| apply_user(&op, current, now_ms(), events))
            .map_err(fail)?;
        drop(guard);
        if !mutation.replayed {
            self.sigil_changed(sigil_id);
        }
        Ok(json!({"sigil_id": sigil_id, "sigil": mutation.sigil, "replayed": mutation.replayed, "cursor": mutation.cursor}))
    }

    pub fn sigil_control(&self, sigil_id: &str, request_id: &str, control: RunControl) -> Result<Value, SpellcastError> {
        validate_sigil_id(sigil_id).map_err(fail)?;
        let hash = crate::sigil_workspace::request_hash(&json!({"op": format!("{control:?}").to_lowercase(), "sigil_id": sigil_id}));
        self.user_run(sigil_id, request_id, &hash, UserRunOp::Control(control))
    }

    /// Window-only: consent to automatic verification for an existing, open run.
    pub fn sigil_set_automation(&self, sigil_id: &str, request_id: &str, expected_revision: u64, automation: SigilAutomation) -> Result<Value, SpellcastError> {
        validate_sigil_id(sigil_id).map_err(fail)?;
        crate::sigil_workspace::validate_request_id(request_id)?;
        if automation != SigilAutomation::Autonomous {
            return Err(fail("执行中的法阵只能切换为自主执行。"));
        }
        let hash = crate::sigil_workspace::request_hash(&json!({"op": "automation", "sigil_id": sigil_id,
            "expected_revision": expected_revision, "automation": automation}));
        self.user_run(sigil_id, request_id, &hash, UserRunOp::Automation { expected_revision })
    }

    pub fn sigil_handover(&self, sigil_id: &str, request_id: &str, source_id: &str, approve: bool) -> Result<Value, SpellcastError> {
        validate_sigil_id(sigil_id).map_err(fail)?;
        let hash = crate::sigil_workspace::request_hash(&json!({"op": "handover", "sigil_id": sigil_id, "source_id": source_id, "approve": approve}));
        self.user_run(sigil_id, request_id, &hash, UserRunOp::Handover { source_id, approve })
    }

    pub fn sigil_revoke(&self, sigil_id: &str, request_id: &str) -> Result<Value, SpellcastError> {
        validate_sigil_id(sigil_id).map_err(fail)?;
        let hash = crate::sigil_workspace::request_hash(&json!({"op": "revoke", "sigil_id": sigil_id}));
        self.user_run(sigil_id, request_id, &hash, UserRunOp::Revoke)
    }

    /// Window-only: the user passes or fails a manual check, with an optional note.
    pub fn sigil_decide_check(&self, sigil_id: &str, request_id: &str, step_id: &str, index: usize, passed: bool, note: &str) -> Result<Value, SpellcastError> {
        validate_sigil_id(sigil_id).map_err(fail)?;
        bounded("备注", note, 2_000)?;
        let hash = crate::sigil_workspace::request_hash(&json!({"op": "decide_check", "sigil_id": sigil_id, "step_id": step_id, "index": index,
            "passed": passed, "note": note}));
        self.user_run(sigil_id, request_id, &hash, UserRunOp::DecideCheck { step_id, index, passed, note })
    }

    /// Window-only: queues a reported step's finished commands again.
    pub fn sigil_rerun_checks(&self, sigil_id: &str, request_id: &str, step_id: &str) -> Result<Value, SpellcastError> {
        validate_sigil_id(sigil_id).map_err(fail)?;
        let hash = crate::sigil_workspace::request_hash(&json!({"op": "rerun_checks", "sigil_id": sigil_id, "step_id": step_id}));
        self.user_run(sigil_id, request_id, &hash, UserRunOp::RerunChecks { step_id })
    }

    /// Window-only: the user approves a command an amendment added or changed.
    pub fn sigil_approve_command(&self, sigil_id: &str, request_id: &str, step_id: &str, index: usize) -> Result<Value, SpellcastError> {
        validate_sigil_id(sigil_id).map_err(fail)?;
        let hash = crate::sigil_workspace::request_hash(&json!({"op": "approve_command", "sigil_id": sigil_id, "step_id": step_id, "index": index}));
        self.user_run(sigil_id, request_id, &hash, UserRunOp::ApproveCommand { step_id, index })
    }

    /// Window-only: the user reverts an amendment, named by the plan revision it produced.
    pub fn sigil_revert_amendment(&self, sigil_id: &str, request_id: &str, revision: u64) -> Result<Value, SpellcastError> {
        validate_sigil_id(sigil_id).map_err(fail)?;
        let hash = crate::sigil_workspace::request_hash(&json!({"op": "revert_amendment", "sigil_id": sigil_id, "revision": revision}));
        self.user_run(sigil_id, request_id, &hash, UserRunOp::RevertAmendment { revision })
    }

    /// Window-only: the user reopens a skipped step.
    pub fn sigil_reopen_step(&self, sigil_id: &str, request_id: &str, step_id: &str) -> Result<Value, SpellcastError> {
        validate_sigil_id(sigil_id).map_err(fail)?;
        let hash = crate::sigil_workspace::request_hash(&json!({"op": "reopen_step", "sigil_id": sigil_id, "step_id": step_id}));
        self.user_run(sigil_id, request_id, &hash, UserRunOp::ReopenStep { step_id })
    }

    pub fn sigil_user_note(&self, sigil_id: &str, request_id: &str, text: &str) -> Result<Value, SpellcastError> {
        validate_sigil_id(sigil_id).map_err(fail)?;
        if text.trim().is_empty() {
            return Err(fail("留言不能为空。"));
        }
        bounded("留言", text, 4_000)?;
        let hash = crate::sigil_workspace::request_hash(&json!({"op": "note", "sigil_id": sigil_id, "text": text}));
        self.user_run(sigil_id, request_id, &hash, UserRunOp::Note { text })
    }

    /// Window-only. Prepares the execution location for a frozen sigil, then records the run.
    /// Persist preparation before creating Git artifacts. A restart may reuse only this
    /// request's registered worktree, with the exact repository, branch and base commit.
    async fn sigil_prepare_worktree(&self, sigil: &Sigil, request_id: &str, start_hash: &str,
        directory: &str, base_ref: &str, base_commit: &str) -> Result<PreparedWorktree, SpellcastError> {
        let repository = Path::new(&sigil.plan.repository);
        let branch = format!("sigil/{}", sigil.id);
        let prep_id = format!("start-preparation-{}", crate::sigil_workspace::request_hash(&json!(request_id)));
        let prep_hash = crate::sigil_workspace::request_hash(&json!({"op": "start_preparation", "start_hash": start_hash}));
        let prior = self.sigil_store()?.sigil_receipt(&prep_id, &prep_hash).map_err(fail)?;
        let mut prepared = PreparedWorktree { directory: directory.into(), branch: branch.clone(),
            base_ref: base_ref.into(), base_commit: base_commit.into(), created: false };
        if let Some(receipt) = prior {
            let event = self.sigil_store()?.sigil_events(&sigil.id, receipt.cursor.saturating_sub(1), 1).map_err(fail)?
                .into_iter().next().filter(|event| event.seq == receipt.cursor && event.kind == "preparation_started")
                .ok_or_else(|| fail("启动准备记录缺失；没有复用现有目录。"))?;
            if event.value["directory"] != directory || event.value["branch"] != branch {
                return Err(fail("启动准备位置已变化；没有复用现有目录。"));
            }
            prepared.base_ref = event.value["base_ref"].as_str().ok_or_else(|| fail("启动准备记录缺少基线。"))?.into();
            prepared.base_commit = event.value["base_commit"].as_str().ok_or_else(|| fail("启动准备记录缺少提交。"))?.into();
            if Path::new(directory).exists() {
                let canonical = |path: &str| std::fs::canonicalize(path).map_err(fail);
                let actual_root = git(Path::new(directory), &["rev-parse", "--show-toplevel"]).await.map_err(fail)?;
                let actual_common = git(Path::new(directory), &["rev-parse", "--path-format=absolute", "--git-common-dir"]).await.map_err(fail)?;
                let expected_common = git(repository, &["rev-parse", "--path-format=absolute", "--git-common-dir"]).await.map_err(fail)?;
                let actual_branch = git(Path::new(directory), &["symbolic-ref", "--quiet", "--short", "HEAD"]).await.map_err(fail)?;
                let actual_commit = git(Path::new(directory), &["rev-parse", "--verify", "HEAD"]).await.map_err(fail)?;
                if canonical(&actual_root)? != canonical(directory)? || canonical(&actual_common)? != canonical(&expected_common)?
                    || actual_branch != branch || actual_commit != prepared.base_commit {
                    return Err(fail("启动准备目录的仓库、分支或提交不匹配；没有更改它。"));
                }
                let registry = git(repository, &["worktree", "list", "--porcelain"]).await.map_err(fail)?;
                let expected_path = canonical(directory)?;
                let entry = registry.split("\n\n").find(|entry| entry.lines().find_map(|line| line.strip_prefix("worktree "))
                    .is_some_and(|path| std::fs::canonicalize(path).is_ok_and(|path| path == expected_path)))
                    .ok_or_else(|| fail("启动准备目录没有登记为原仓库的 worktree。"))?;
                if !entry.lines().any(|line| line == format!("branch refs/heads/{branch}")) {
                    return Err(fail("启动准备 worktree 登记的分支不匹配。"));
                }
                match entry.lines().find(|line| line.starts_with("locked")) {
                    Some(line) if line == format!("locked sigil:{}", sigil.id) => {},
                    Some(_) => return Err(fail("启动准备 worktree 被其他原因锁定；没有更改它。")),
                    None => { git(repository, &["worktree", "lock", "--reason", &format!("sigil:{}", sigil.id), directory]).await.map_err(fail)?; }
                }
                return Ok(prepared);
            }
        } else {
            if Path::new(directory).exists() { return Err(fail(format!("worktree 路径已存在：{directory}"))); }
            if git(repository, &["rev-parse", "--verify", "--quiet", &format!("refs/heads/{branch}")]).await.is_ok() {
                return Err(fail(format!("分支 {branch} 已存在。")));
            }
            self.sigil_store()?.sigil_apply(&prep_id, &prep_hash, &sigil.id, now_ms(), None, |current, events| {
                let current = current.ok_or("法阵不存在。")?;
                check_revision(&current, sigil.revision)?;
                if current.state != SigilState::Frozen { return Err("启动准备时方案已变化。".into()); }
                events.push(("preparation_started".into(), json!({"directory": directory, "branch": branch,
                    "base_ref": base_ref, "base_commit": base_commit})));
                Ok(Applied::Write { sigil: Box::new(current), history: None, created: false })
            }).map_err(fail)?;
        }
        // No pre-existing directory is removed. An incomplete branch-only creation is left
        // intact for diagnosis rather than being mistaken for a clean, reusable worktree.
        if git(repository, &["rev-parse", "--verify", "--quiet", &format!("refs/heads/{branch}")]).await.is_ok() {
            return Err(fail("上次启动留下了分支，但缺少完整 worktree；已保留分支，请检查启动记录。"));
        }
        git(repository, &["worktree", "add", "-b", &branch, directory, &prepared.base_commit]).await.map_err(fail)?;
        if let Err(error) = git(repository, &["worktree", "lock", "--reason", &format!("sigil:{}", sigil.id), directory]).await {
            rollback_worktree(repository, directory, &branch).await;
            return Err(fail(error));
        }
        prepared.created = true;
        Ok(prepared)
    }

    /// A retried start replays its receipt without touching git again.
    pub async fn sigil_start(&self, sigil_id: &str, request_id: &str, expected_revision: u64) -> Result<Value, SpellcastError> {
        self.sigil_start_with_automation(sigil_id, request_id, expected_revision, SigilAutomation::Supervised, &SigilActor::user()).await
    }

    pub(crate) async fn sigil_start_with_automation(&self, sigil_id: &str, request_id: &str, expected_revision: u64,
        automation: SigilAutomation, actor: &SigilActor) -> Result<Value, SpellcastError> {
        let _preparation = START_GATE.lock().await;
        validate_sigil_id(sigil_id).map_err(fail)?;
        // Preserve the exact receipt hash of existing supervised starts.
        let mut request = json!({"op": "start", "sigil_id": sigil_id, "expected_revision": expected_revision});
        if automation != SigilAutomation::Supervised || actor.kind != "user" {
            request["automation"] = json!(automation);
            request["actor"] = json!(actor);
        }
        let hash = crate::sigil_workspace::request_hash(&request);
        let (replay, sigil) = {
            let store = self.sigil_store()?;
            (store.sigil_receipt(request_id, &hash).map_err(fail)?, store.sigil_get(sigil_id).map_err(fail)?)
        };
        if let Some(mutation) = replay {
            return Ok(json!({"sigil_id": sigil_id, "sigil": mutation.sigil, "replayed": true}));
        }
        check_revision(&sigil, expected_revision).map_err(fail)?;
        if sigil.state != SigilState::Frozen {
            return Err(fail("只有已冻结、还没开始的法阵可以开始执行。"));
        }
        let freeze = sigil.freeze.clone().ok_or_else(|| fail("法阵缺少冻结记录。"))?;
        let repository = Path::new(&sigil.plan.repository).to_path_buf();
        let target = if sigil.plan.base_ref.is_empty() { "HEAD".to_string() } else { sigil.plan.base_ref.clone() };
        let mut base_commit = git(&repository, &["rev-parse", "--verify", "--quiet", &format!("{target}^{{commit}}")]).await
            .map_err(|_| fail(format!("找不到基线 {target}。")))?;
        let mut base_ref = if sigil.plan.base_ref.is_empty() {
            git(&repository, &["symbolic-ref", "--quiet", "--short", "HEAD"]).await.unwrap_or_else(|_| base_commit.clone())
        } else {
            sigil.plan.base_ref.clone()
        };
        let (directory, branch, created_worktree) = match sigil.plan.location {
            SigilLocation::InPlace => (sigil.plan.repository.clone(), String::new(), false),
            SigilLocation::Worktree => {
                let directory = freeze.execution_directory.clone();
                let prepared = self.sigil_prepare_worktree(&sigil, request_id, &hash, &directory, &base_ref, &base_commit).await?;
                base_ref = prepared.base_ref;
                base_commit = prepared.base_commit;
                (prepared.directory, prepared.branch, prepared.created)
            }
        };
        // The baseline snapshot: changes already present, such as uncommitted work in place,
        // are not attributed to the run.
        let dir = self.sigil_dir(sigil_id);
        let observation = match &dir {
            Ok(dir) => baseline(dir, Path::new(&directory), &sigil).await,
            Err(error) => SigilObservation { stopped: "unavailable".into(), stopped_detail: error.to_string(), ..Default::default() },
        };
        let now = now_ms();
        let run = SigilRun {
            automation, started_at_ms: now, execution_directory: directory.clone(), location: sigil.plan.location, branch: branch.clone(),
            base_ref, base_commit, executor: None, delivery: None, pending_claims: vec![], revoked: vec![], replaced: vec![],
            steps: Default::default(), notice_cursor: Default::default(), observation: Some(observation), check_runs: 0,
            amendments: vec![], approved_commands: vec![], amended_inputs: Default::default(),
        };
        let started = self.sigil_store().and_then(|mut store| store.sigil_apply(request_id, &hash, sigil_id, now, None, |current, events| {
            let mut sigil = current.ok_or("法阵不存在。")?;
            check_revision(&sigil, expected_revision)?;
            if sigil.state != SigilState::Frozen {
                return Err("只有已冻结、还没开始的法阵可以开始执行。".to_string());
            }
            sigil.state = SigilState::Running;
            sigil.revision += 1;
            sigil.updated_at_ms = now;
            sigil.updated_by = actor.clone();
            let observation = run.observation.as_ref().expect("observation set above");
            events.push(("started".into(), json!({"execution_directory": run.execution_directory, "location": run.location,
                "branch": run.branch, "base_ref": run.base_ref, "base_commit": run.base_commit, "baseline_tree": observation.baseline_tree,
                "inputs_differ_at_start": observation.inputs_differ_at_start, "automation": automation, "actor": actor})));
            if !observation.stopped.is_empty() {
                events.push(("observation_stopped".into(), json!({"reason": observation.stopped, "detail": observation.stopped_detail})));
            }
            sigil.run = Some(run);
            Ok(Applied::Write { sigil: Box::new(sigil), history: Some("start"), created: false })
        }).map_err(fail));
        match started {
            Ok(mutation) => {
                self.sigil_changed(sigil_id);
                Ok(json!({"sigil_id": sigil_id, "sigil": mutation.sigil, "replayed": mutation.replayed}))
            }
            Err(error) => {
                if created_worktree {
                    rollback_worktree(&repository, &directory, &branch).await;
                }
                if created_worktree { if let Ok(dir) = &dir {
                    let _ = std::fs::remove_dir_all(dir);
                } }
                Err(error)
            }
        }
    }

    /// Read-only: where the run stands and what the executor should do next.
    pub fn sigil_next(&self, sigil_id: &str) -> Result<Value, SpellcastError> {
        validate_sigil_id(sigil_id).map_err(fail)?;
        let store = self.sigil_store()?;
        let sigil = store.sigil_get(sigil_id).map_err(fail)?;
        let cursor = store.sigil_last_seq(sigil_id).map_err(fail)?;
        drop(store);
        let mutation = SigilMutation { sigil_id: sigil_id.into(), sigil: None, created: false, deleted: false, replayed: false, notices: vec![], cursor };
        Ok(agent_view(&sigil, &mutation, None))
    }

    /// Long-poll for notices after `since`, at most 55 s so hosts that need a first byte within
    /// 60 s keep the call. Returns `pending` with the latest cursor when nothing arrived.
    pub async fn sigil_wait(&self, sigil_id: &str, source_id: &str, since: u64, wait_s: u32) -> Result<Value, SpellcastError> {
        validate_sigil_id(sigil_id).map_err(fail)?;
        let deadline = tokio::time::Instant::now() + Duration::from_secs(u64::from(wait_s.min(MAX_WAIT_S)));
        loop {
            let notified = SIGIL_CHANGED.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            let (events, cursor, state) = {
                let store = self.sigil_store()?;
                let sigil = store.sigil_get(sigil_id).map_err(fail)?;
                let events: Vec<_> = store.sigil_events(sigil_id, since, 200).map_err(fail)?.into_iter().filter(|event| is_notice(&event.kind)).collect();
                (events, store.sigil_last_seq(sigil_id).map_err(fail)?, sigil.state)
            };
            let ended = matches!(state, SigilState::Completed | SigilState::Aborted | SigilState::Archived);
            if !events.is_empty() || ended || tokio::time::Instant::now() >= deadline {
                if !events.is_empty() && !source_id.is_empty() {
                    let _ = self.sigil_store().and_then(|mut store| store.sigil_advance_cursor(sigil_id, source_id, cursor).map_err(fail));
                }
                let status = if events.is_empty() { if ended { "ended" } else { "pending" } } else { "events" };
                return Ok(json!({"sigil_id": sigil_id, "status": status, "state": state, "events": events, "cursor": cursor}));
            }
            tokio::select! {
                _ = &mut notified => {}
                _ = tokio::time::sleep_until(deadline) => {}
            }
        }
    }
}

/// Undo a worktree this start just created. The directory is fresh, so forcing is safe.
async fn rollback_worktree(repository: &Path, directory: &str, branch: &str) {
    let _ = git(repository, &["worktree", "unlock", directory]).await;
    let _ = git(repository, &["worktree", "remove", "--force", directory]).await;
    let _ = git(repository, &["branch", "-D", branch]).await;
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sigil_workspace::{SigilAgentOp, SigilQuery, SigilUpdate};
    use crate::sigils::{SigilCheck, SigilPlan, StepLight};
    use crate::Headless;
    use std::path::PathBuf;

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
            // Release the exclusive database before removing the fixture directory.
            drop(self.bridge.take());
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    fn sh(dir: &Path, args: &[&str]) -> String {
        let output = std::process::Command::new("git")
            .args(["-c", "user.name=Sigil Test", "-c", "user.email=sigil@test.invalid", "-c", "commit.gpgsign=false"])
            .args(args).current_dir(dir).output().unwrap();
        assert!(output.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&output.stderr));
        String::from_utf8_lossy(&output.stdout).trim().to_string()
    }

    fn fixture() -> Fixture {
        let root = std::env::temp_dir().join(format!("sigil-run-{}", uuid::Uuid::new_v4().simple()));
        let repo = root.join("repo");
        std::fs::create_dir_all(repo.join("src")).unwrap();
        sh(&repo, &["init", "-q", "-b", "main"]);
        std::fs::write(repo.join("src/lib.rs"), "pub fn answer() -> u8 { 42 }\n").unwrap();
        sh(&repo, &["add", "-A"]);
        sh(&repo, &["commit", "-q", "-m", "init"]);
        let bridge = Bridge::open(Headless, 0, &root.join("state.sqlite3")).unwrap();
        Fixture { root, repo, bridge: Some(bridge) }
    }

    fn step(id: &str, depends_on: &[&str], checked: bool) -> SigilStep {
        SigilStep {
            id: id.into(), title: format!("Step {id}"), instructions: format!("Do {id}."), inputs: vec![], scope: vec!["src/**".into()],
            checks: if checked { vec![SigilCheck::Command { label: "build".into(), argv: vec!["cargo".into(), "build".into()], timeout_s: 600 }] } else { vec![] },
            depends_on: depends_on.iter().map(|id| id.to_string()).collect(), stop_when: vec![],
        }
    }

    async fn agent(b: &Bridge, request: &str, sigil: &str, source: &str, op: SigilAgentOp) -> Result<Value, SpellcastError> {
        b.sigil_agent_update(SigilUpdate { request_id: request.into(), sigil_id: sigil.into(), source_id: source.into(), label: format!("{source} label"), op }).await
    }

    async fn start_step(b: &Bridge, request: &str, sigil: &str, source: &str, step: &str) -> Result<Value, SpellcastError> {
        agent(b, request, sigil, source, SigilAgentOp::StartStep { step_id: step.into() }).await
    }

    async fn report(b: &Bridge, request: &str, sigil: &str, source: &str, step: &str) -> Result<Value, SpellcastError> {
        agent(b, request, sigil, source, SigilAgentOp::ReportStep { step_id: step.into(), summary: format!("{step} done"), evidence: vec![] }).await
    }

    async fn claim(b: &Bridge, request: &str, sigil: &str, source: &str) -> Value {
        agent(b, request, sigil, source, SigilAgentOp::Claim).await.unwrap()
    }

    fn read(b: &Bridge, id: &str) -> Value {
        b.sigil_query(SigilQuery { view: "sigil".into(), sigil_id: id.into(), ..Default::default() }).unwrap()
    }

    async fn started(f: &Fixture, id: &str, location: SigilLocation, steps: Vec<SigilStep>) -> Value {
        let plan = SigilPlan { title: format!("Run {id}"), goal: "Exercise the run".into(), repository: f.repo.to_string_lossy().into(),
            location, steps, ..Default::default() };
        agent(f.b(), &format!("{id}-plan"), id, "claude:author", SigilAgentOp::PutPlan { expected_revision: 0, plan }).await.unwrap();
        f.b().sigil_freeze(id, &format!("{id}-freeze"), 1).unwrap();
        f.b().sigil_start(id, &format!("{id}-start"), 2).await.unwrap()
    }

    fn light(value: &Value) -> StepLight {
        serde_json::from_value(value["step"]["light"].clone()).unwrap()
    }

    fn markers(value: &Value) -> Vec<String> {
        value["step"]["markers"].as_array().unwrap().iter().map(|marker| marker["kind"].as_str().unwrap().to_string()).collect()
    }

    fn event_kinds(b: &Bridge, id: &str) -> Vec<String> {
        b.sigil_query(SigilQuery { view: "events".into(), sigil_id: id.into(), ..Default::default() }).unwrap()["events"]
            .as_array().unwrap().iter().map(|event| event["kind"].as_str().unwrap().to_string()).collect()
    }

    fn manual(blocking: bool) -> SigilCheck {
        SigilCheck::Manual { label: "review".into(), description: "Review later".into(), blocking }
    }

    fn command(argv: &[&str]) -> SigilCheck {
        SigilCheck::Command { label: "git check".into(), argv: argv.iter().map(|arg| arg.to_string()).collect(), timeout_s: 30 }
    }

    fn with_checks(id: &str, depends_on: &[&str], checks: Vec<SigilCheck>) -> SigilStep {
        SigilStep { checks, ..step(id, depends_on, false) }
    }

    async fn amend_checks(b: &Bridge, request: &str, id: &str, step_id: &str, checks: Vec<SigilCheck>) {
        let change = serde_json::from_value(json!({"kind": "update_step", "step_id": step_id, "checks": checks})).unwrap();
        agent(b, request, id, "claude:runner", SigilAgentOp::Amend { reason: "Update verification".into(), changes: vec![change] }).await.unwrap();
    }

    #[tokio::test]
    async fn automation_upgrade_runs_pending_commands_and_future_amendments_with_one_receipt() {
        let mut f = fixture();
        let b = f.b();
        started(&f, "upgrade", SigilLocation::InPlace, vec![
            with_checks("a", &[], vec![command(&["git", "--version"]), manual(false)]),
            with_checks("b", &["a"], vec![command(&["git", "--version"]), manual(false)]),
        ]).await;
        claim(b, "upgrade-claim", "upgrade", "claude:runner").await;
        report(b, "upgrade-report-a", "upgrade", "claude:runner", "a").await.unwrap();
        amend_checks(b, "upgrade-amend-a", "upgrade", "a", vec![command(&["git", "rev-parse", "--git-dir"]), manual(false)]).await;
        let before = b.sigil_store().unwrap().sigil_get("upgrade").unwrap();
        assert_eq!(before.run.as_ref().unwrap().steps["a"].checks[0].status, CheckStatus::NeedsApproval);
        assert!(!waiting_commands(&before).is_empty());
        let revision = before.revision;
        let upgraded = b.sigil_set_automation("upgrade", "upgrade-mode", revision, SigilAutomation::Autonomous).unwrap();
        assert_eq!(upgraded["sigil"]["revision"], revision + 1);
        let current = b.sigil_store().unwrap().sigil_get("upgrade").unwrap();
        assert!(waiting_commands(&current).is_empty());
        assert_eq!(current.run.as_ref().unwrap().steps["a"].checks.iter().map(|check| check.status).collect::<Vec<_>>(),
            [CheckStatus::Queued, CheckStatus::Deferred]);
        let events_before = event_kinds(b, "upgrade");
        assert!(b.sigil_set_automation("upgrade", "upgrade-stale", revision, SigilAutomation::Autonomous).is_err());
        assert!(b.sigil_set_automation("upgrade", "upgrade-mode", revision + 1, SigilAutomation::Autonomous).is_err(), "same id with altered consent is refused");
        assert_eq!(b.sigil_set_automation("upgrade", "upgrade-mode", revision, SigilAutomation::Autonomous).unwrap()["replayed"], true);
        let noop = b.sigil_set_automation("upgrade", "upgrade-already", revision + 1, SigilAutomation::Autonomous).unwrap();
        assert_eq!(noop["sigil"]["revision"], revision + 1);
        assert_eq!(event_kinds(b, "upgrade"), events_before);
        let audit = b.sigil_store().unwrap().sigil_events("upgrade", 0, 200).unwrap().into_iter().find(|event| event.kind == "automation_changed").unwrap();
        assert_eq!(audit.value["actor"]["kind"], "user");
        assert_eq!(audit.value["queued_commands"], 1);
        assert_eq!(audit.value["deferred_reviews"], 1);

        b.sigil_run_checks("upgrade").await.unwrap();
        let checked = read(b, "upgrade");
        assert_eq!(checked["lights"]["a"], "review_pending");
        assert_eq!(checked["sigil"]["run"]["steps"]["a"]["checks"][0]["exit_code"], 0, "formerly unapproved command really executes");
        amend_checks(b, "upgrade-amend-b", "upgrade", "b", vec![command(&["git", "branch", "--show-current"]), manual(false)]).await;
        start_step(b, "upgrade-start-b", "upgrade", "claude:runner", "b").await.unwrap();
        report(b, "upgrade-report-b", "upgrade", "claude:runner", "b").await.unwrap();
        b.sigil_run_checks("upgrade").await.unwrap();
        let finished = read(b, "upgrade");
        assert_eq!(finished["sigil"]["state"], "completed");
        assert_eq!(finished["sigil"]["run"]["steps"]["b"]["checks"][0]["status"], "passed");
        assert_eq!(finished["sigil"]["run"]["steps"]["b"]["checks"][1]["status"], "deferred");
        let kinds = event_kinds(b, "upgrade");
        assert_eq!(b.sigil_set_automation("upgrade", "upgrade-mode", revision, SigilAutomation::Autonomous).unwrap()["replayed"], true,
            "original receipt replays after completion");
        assert_eq!(event_kinds(b, "upgrade"), kinds);
        assert_eq!(read(b, "upgrade")["sigil"]["revision"], finished["sigil"]["revision"]);
        assert_eq!(kinds.iter().filter(|kind| kind.as_str() == "automation_changed").count(), 1);
        drop(f.bridge.take());
        let connection = rusqlite::Connection::open(f.root.join("state.sqlite3")).unwrap();
        let histories: i64 = connection.query_row("SELECT COUNT(*) FROM spellcast_sigil_plan_history WHERE sigil_id = 'upgrade' AND operation = 'automation_changed'", [], |row| row.get(0)).unwrap();
        assert_eq!(histories, 1, "receipt replay and a current-revision no-op do not duplicate history");
    }

    #[tokio::test]
    async fn automation_upgrade_defers_manual_review_truthfully_and_preserves_pause() {
        let f = fixture();
        let b = f.b();
        for (id, paused) in [("review-upgrade", false), ("paused-upgrade", true)] {
            started(&f, id, SigilLocation::InPlace, vec![with_checks("a", &[], vec![manual(false)])]).await;
            claim(b, &format!("{id}-claim"), id, "claude:runner").await;
            report(b, &format!("{id}-report"), id, "claude:runner", "a").await.unwrap();
            if paused { b.sigil_control(id, &format!("{id}-pause"), RunControl::Pause).unwrap(); }
            let before = b.sigil_store().unwrap().sigil_get(id).unwrap();
            let upgraded = b.sigil_set_automation(id, &format!("{id}-mode"), before.revision, SigilAutomation::Autonomous).unwrap();
            assert_eq!(upgraded["sigil"]["state"], if paused { "paused" } else { "completed" });
            assert_eq!(upgraded["sigil"]["revision"], before.revision + if paused { 1 } else { 2 });
            let check = &upgraded["sigil"]["run"]["steps"]["a"]["checks"][0];
            assert_eq!(check["status"], "deferred");
            assert!(check["finished_at_ms"].is_null() && check["exit_code"].is_null(), "review was not performed or passed");
            assert_eq!(upgraded["sigil"]["run"]["started_at_ms"], before.run.as_ref().unwrap().started_at_ms);
            if paused {
                b.sigil_run_checks(id).await.unwrap();
                assert_eq!(read(b, id)["sigil"]["state"], "paused");
                b.sigil_control(id, &format!("{id}-resume"), RunControl::Resume).unwrap();
                assert_eq!(read(b, id)["sigil"]["state"], "completed");
            }
        }
    }

    #[tokio::test]
    async fn automation_upgrade_still_waits_for_explicitly_blocking_manual_review() {
        let f = fixture();
        let b = f.b();
        started(&f, "blocking-upgrade", SigilLocation::InPlace, vec![
            with_checks("a", &[], vec![manual(false), manual(true)]), step("b", &["a"], false),
        ]).await;
        claim(b, "blocking-claim", "blocking-upgrade", "claude:runner").await;
        report(b, "blocking-report", "blocking-upgrade", "claude:runner", "a").await.unwrap();
        let before = b.sigil_store().unwrap().sigil_get("blocking-upgrade").unwrap();
        let upgraded = b.sigil_set_automation("blocking-upgrade", "blocking-mode", before.revision, SigilAutomation::Autonomous).unwrap();
        assert_eq!(upgraded["sigil"]["state"], "running");
        assert_eq!(upgraded["sigil"]["run"]["steps"]["a"]["checks"][0]["status"], "deferred");
        assert_eq!(upgraded["sigil"]["run"]["steps"]["a"]["checks"][1]["status"], "waiting");
        assert!(start_step(b, "blocking-start-b-refused", "blocking-upgrade", "claude:runner", "b").await.is_err(), "explicit review still blocks dependencies");
        b.sigil_decide_check("blocking-upgrade", "blocking-decision", "a", 1, true, "Reviewed").unwrap();
        start_step(b, "blocking-start-b", "blocking-upgrade", "claude:runner", "b").await.unwrap();
        report(b, "blocking-report-b", "blocking-upgrade", "claude:runner", "b").await.unwrap();
        b.sigil_run_checks("blocking-upgrade").await.unwrap();
        assert_eq!(read(b, "blocking-upgrade")["sigil"]["state"], "completed");
    }

    #[tokio::test]
    async fn automation_upgrade_preserves_results_attempts_and_all_run_context() {
        let f = fixture();
        started(&f, "preserve-upgrade", SigilLocation::Worktree, vec![
            with_checks("a", &[], vec![command(&["git", "--version"]); 5].into_iter().chain([manual(false), manual(true), manual(false)]).collect()),
            with_checks("active", &[], vec![command(&["git", "--version"]), manual(false)]),
            with_checks("pending", &[], vec![command(&["git", "--version"]), manual(false)]),
        ]).await;
        claim(f.b(), "preserve-claim", "preserve-upgrade", "claude:runner").await;
        claim(f.b(), "preserve-other-claim", "preserve-upgrade", "codex:other").await;
        agent(f.b(), "preserve-amend", "preserve-upgrade", "claude:runner", SigilAgentOp::Amend {
            reason: "Clarify instructions".into(), changes: vec![serde_json::from_value(json!({
                "kind": "update_step", "step_id": "a", "instructions": "Preserve this amendment"
            })).unwrap()],
        }).await.unwrap();
        let mut before = f.b().sigil_store().unwrap().sigil_get("preserve-upgrade").unwrap();
        assert_eq!(before.run.as_ref().unwrap().amendments.len(), 1);
        let statuses = [CheckStatus::Passed, CheckStatus::Failed, CheckStatus::Running, CheckStatus::Stopped, CheckStatus::NeedsApproval,
            CheckStatus::Waiting, CheckStatus::Waiting, CheckStatus::Failed];
        let mut checks: Vec<crate::sigils::CheckResult> = statuses.into_iter().enumerate().map(|(index, status)| crate::sigils::CheckResult {
            index, kind: if index < 5 { "command" } else { "manual" }.into(), label: format!("kept {index}"), attempt: 2, status,
            run: index as u64 + 1, started_at_ms: Some(101), finished_at_ms: Some(102), exit_code: Some(7), error: "existing error".into(),
            tail: "existing output".into(), note: "existing decision".into(), ..Default::default()
        }).collect();
        checks.push(crate::sigils::CheckResult { index: 4, kind: "command".into(), attempt: 1, status: CheckStatus::NeedsApproval, ..Default::default() });
        checks.push(crate::sigils::CheckResult { index: 5, kind: "manual".into(), attempt: 1, status: CheckStatus::Waiting, ..Default::default() });
        let run = before.run.as_mut().unwrap();
        run.steps.insert("a".into(), StepProgress { status: StepStatus::Reported, attempt: 2, checks: checks.clone(),
            markers: vec![marker("kept", 99, "original marker")], summary: "original summary".into(), evidence: vec!["original evidence".into()], ..Default::default() });
        for (id, status) in [("active", StepStatus::Active), ("pending", StepStatus::Pending)] {
            run.steps.insert(id.into(), StepProgress { status, attempt: 2, checks: checks.clone(), ..Default::default() });
        }
        run.revoked.push("revoked-source".into());
        run.replaced.push("replaced-source".into());
        run.amended_inputs.insert("src/input".into(), Some("frozen-hash".into()));
        run.approved_commands.push(SigilCommand { step_id: "a".into(), label: "earlier approval".into(), argv: vec!["git".into(), "status".into()], timeout_s: 30 });
        let mut expected = before.clone();
        let expected_run = expected.run.as_mut().unwrap();
        expected_run.automation = SigilAutomation::Autonomous;
        expected_run.steps.get_mut("a").unwrap().checks[4].status = CheckStatus::Queued;
        expected_run.steps.get_mut("a").unwrap().checks[5].status = CheckStatus::Deferred;
        expected.revision += 1;
        expected.updated_at_ms = 1234;
        expected.updated_by = SigilActor::user();
        let mut events = Events::new();
        let Applied::Write { sigil, history, .. } = apply_user(&UserRunOp::Automation { expected_revision: before.revision }, Some(before), 1234, &mut events).unwrap() else { panic!("expected write") };
        assert_eq!(*sigil, expected, "only two waiting current-attempt checks and automation metadata change; all context stays exact");
        assert_eq!(history, Some("automation_changed"));
        assert_eq!(sigil.state, SigilState::Running, "failed and blocking manual checks still prevent completion");
        assert_eq!(events.iter().filter(|(kind, _)| kind == "completed").count(), 0);
    }

    #[tokio::test]
    async fn automation_upgrade_rejects_closed_runs_and_reverse_mode_without_changes() {
        let f = fixture();
        started(&f, "reject-upgrade", SigilLocation::InPlace, vec![with_checks("a", &[], vec![manual(false)])]).await;
        let before = f.b().sigil_store().unwrap().sigil_get("reject-upgrade").unwrap();
        for state in [SigilState::Draft, SigilState::Frozen, SigilState::Completed, SigilState::Aborted, SigilState::Archived] {
            let mut current = before.clone();
            current.state = state;
            let mut events = Events::new();
            assert!(apply_user(&UserRunOp::Automation { expected_revision: current.revision }, Some(current), 1234, &mut events).is_err(), "{state:?}");
            assert!(events.is_empty());
        }
        assert!(f.b().sigil_set_automation("reject-upgrade", "reverse", before.revision, SigilAutomation::Supervised).is_err());
        assert_eq!(f.b().sigil_store().unwrap().sigil_get("reject-upgrade").unwrap(), before);
    }

    #[tokio::test]
    async fn worktree_start_creates_a_locked_branch_and_replays_without_git() {
        let f = fixture();
        let started = started(&f, "wt", SigilLocation::Worktree, vec![step("a", &[], false)]).await;
        let run = &started["sigil"]["run"];
        assert_eq!(started["sigil"]["state"], "running");
        assert_eq!(run["branch"], "sigil/wt");
        assert_eq!(run["base_ref"], "main");
        assert_eq!(run["base_commit"], sh(&f.repo, &["rev-parse", "HEAD"]));
        let directory = PathBuf::from(run["execution_directory"].as_str().unwrap());
        assert!(directory.join("src/lib.rs").is_file());
        assert!(sh(&f.repo, &["worktree", "list", "--porcelain"]).contains("locked sigil:wt"));
        sh(&f.repo, &["rev-parse", "--verify", "refs/heads/sigil/wt"]);
        assert_eq!(f.b().sigil_start("wt", "wt-start", 2).await.unwrap()["replayed"], true);
        assert!(f.b().sigil_start("wt", "wt-start-again", 3).await.unwrap_err().to_string().contains("只有已冻结"));

        sh(&f.repo, &["branch", "sigil/clash"]);
        let plan = SigilPlan { title: "Clash".into(), repository: f.repo.to_string_lossy().into(), steps: vec![step("a", &[], false)], ..Default::default() };
        agent(f.b(), "clash-plan", "clash", "claude:author", SigilAgentOp::PutPlan { expected_revision: 0, plan }).await.unwrap();
        f.b().sigil_freeze("clash", "clash-freeze", 1).unwrap();
        assert!(f.b().sigil_start("clash", "clash-start", 2).await.unwrap_err().to_string().contains("已存在"));
        assert!(!f.root.join("repo.sigils").join("clash").exists());
        assert_eq!(read(f.b(), "clash")["sigil"]["state"], "frozen");
    }

    #[tokio::test]
    async fn prepared_worktree_survives_restart_before_start_receipt_without_losing_changes() {
        let mut f = fixture();
        let id = "recover-preparation";
        let plan = SigilPlan { title: "Recover preparation".into(), repository: f.repo.to_string_lossy().into(),
            location: SigilLocation::Worktree, steps: vec![step("a", &[], false)], ..Default::default() };
        agent(f.b(), "recover-plan", id, "claude:author", SigilAgentOp::PutPlan { expected_revision: 0, plan }).await.unwrap();
        f.b().sigil_freeze(id, "recover-freeze", 1).unwrap();
        let sigil = f.b().sigil_store().unwrap().sigil_get(id).unwrap();
        let directory = sigil.freeze.as_ref().unwrap().execution_directory.clone();
        let commit = sh(&f.repo, &["rev-parse", "HEAD"]);
        let hash = crate::sigil_workspace::request_hash(&json!({"op":"start", "sigil_id":id, "expected_revision":2}));
        let prepared = f.b().sigil_prepare_worktree(&sigil, "recover-start", &hash, &directory, "main", &commit).await.unwrap();
        assert!(prepared.created);
        std::fs::write(Path::new(&directory).join("preserved.txt"), "prepared content").unwrap();
        // Reopen the database before a start receipt exists, as after a process exit.
        drop(f.bridge.take());
        f.bridge = Some(Bridge::open(Headless, 0, &f.root.join("state.sqlite3")).unwrap());
        // Advancing the original branch does not change the recorded preparation baseline.
        std::fs::write(f.repo.join("advanced.txt"), "new baseline").unwrap();
        sh(&f.repo, &["add", "-A"]); sh(&f.repo, &["commit", "-q", "-m", "advance"]);
        let started = f.b().sigil_start(id, "recover-start", 2).await.unwrap();
        assert_eq!(started["sigil"]["state"], "running");
        assert_eq!(started["sigil"]["run"]["base_commit"], commit);
        assert_eq!(std::fs::read_to_string(Path::new(&directory).join("preserved.txt")).unwrap(), "prepared content");
        assert_eq!(sh(&f.repo, &["worktree", "list", "--porcelain"]).lines().filter(|line| line.starts_with("worktree ")).count(), 2);
    }

    #[tokio::test]
    async fn in_place_runs_use_the_repository_and_current_branch() {
        let f = fixture();
        let started = started(&f, "here", SigilLocation::InPlace, vec![step("a", &[], false)]).await;
        let run = &started["sigil"]["run"];
        assert_eq!(run["execution_directory"], f.repo.to_string_lossy().as_ref());
        assert_eq!(run["branch"], "");
        assert_eq!(run["base_ref"], "main");
        let worktrees = sh(&f.repo, &["worktree", "list", "--porcelain"]);
        assert_eq!(worktrees.lines().filter(|line| line.starts_with("worktree ")).count(), 1, "{worktrees}");
        assert!(!worktrees.contains("locked"));
    }

    #[tokio::test]
    async fn claims_hand_over_only_with_the_users_approval() {
        let f = fixture();
        started(&f, "own", SigilLocation::InPlace, vec![step("a", &[], false)]).await;
        let b = f.b();
        assert!(start_step(b, "early", "own", "claude:one", "a").await.unwrap_err().to_string().contains("claim"));
        let first = claim(b, "c1", "own", "claude:one").await;
        assert_eq!(first["status"], "accepted");
        assert!(first["guidance"].as_str().unwrap().contains("唯一的计划"));
        assert_eq!(first["next"]["id"], "a");
        let events = event_kinds(b, "own").len();
        assert_eq!(claim(b, "c2", "own", "claude:one").await["status"], "accepted");
        assert_eq!(event_kinds(b, "own").len(), events, "renewing a claim adds no event");

        assert_eq!(claim(b, "c3", "own", "codex:two").await["status"], "waiting_handover");
        assert!(start_step(b, "s-two", "own", "codex:two", "a").await.unwrap_err().to_string().contains("不是当前执行者"));
        b.sigil_handover("own", "approve-two", "codex:two", true).unwrap();
        assert!(start_step(b, "s-one", "own", "claude:one", "a").await.unwrap_err().to_string().contains("replaced"));
        assert_eq!(claim(b, "c4", "own", "claude:one").await["status"], "waiting_handover");
        b.sigil_handover("own", "reject-one", "claude:one", false).unwrap();
        start_step(b, "s-two-ok", "own", "codex:two", "a").await.unwrap();

        b.sigil_revoke("own", "revoke-two").unwrap();
        assert!(report(b, "r-two", "own", "codex:two", "a").await.unwrap_err().to_string().contains("revoked"));
        assert_eq!(claim(b, "c5", "own", "codex:two").await["status"], "waiting_handover");
        b.sigil_handover("own", "approve-two-again", "codex:two", true).unwrap();
        assert_eq!(report(b, "r-two-ok", "own", "codex:two", "a").await.unwrap()["state"], "completed");
        assert!(b.sigil_handover("own", "approve-ghost", "claude:ghost", true).is_err());
    }

    #[tokio::test]
    async fn steps_follow_dependencies_and_checks_hold_dependents() {
        let f = fixture();
        started(&f, "deps", SigilLocation::InPlace, vec![step("a", &[], false), step("b", &["a"], false), step("c", &["b"], true), step("d", &["c"], false)]).await;
        let b = f.b();
        claim(b, "claim", "deps", "claude:one").await;
        assert!(start_step(b, "b-early", "deps", "claude:one", "b").await.unwrap_err().to_string().contains("a"));
        let a = start_step(b, "a-start", "deps", "claude:one", "a").await.unwrap();
        assert_eq!(light(&a), StepLight::Running);
        assert_eq!(a["next"]["id"], "a");
        let a = report(b, "a-report", "deps", "claude:one", "a").await.unwrap();
        assert_eq!(light(&a), StepLight::DoneUnverified);
        assert_eq!(a["next"]["id"], "b");
        assert_eq!(a["next"]["light"], "ready");
        start_step(b, "b-start", "deps", "claude:one", "b").await.unwrap();
        report(b, "b-report", "deps", "claude:one", "b").await.unwrap();
        start_step(b, "c-start", "deps", "claude:one", "c").await.unwrap();
        let c = report(b, "c-report", "deps", "claude:one", "c").await.unwrap();
        assert_eq!(light(&c), StepLight::Verifying);
        assert!(c["next"].is_null(), "d waits for c's verification");
        assert_eq!(c["remaining"], 2);
        assert!(start_step(b, "d-early", "deps", "claude:one", "d").await.unwrap_err().to_string().contains("c"));
        let d = report(b, "d-report", "deps", "claude:one", "d").await.unwrap();
        assert_eq!(markers(&d), ["reported_without_start", "dependencies_unfinished", "reported_without_changes"]);
        assert_eq!(d["state"], "running");
        assert_eq!(report(b, "d-report", "deps", "claude:one", "d").await.unwrap()["replayed"], true);
    }

    #[tokio::test]
    async fn starting_another_step_reports_the_running_one_and_blocked_steps_resume() {
        let f = fixture();
        started(&f, "flow", SigilLocation::InPlace, vec![step("x", &[], false), step("y", &[], false), step("z", &[], false)]).await;
        let b = f.b();
        claim(b, "claim", "flow", "claude:one").await;
        start_step(b, "x", "flow", "claude:one", "x").await.unwrap();
        start_step(b, "y", "flow", "claude:one", "y").await.unwrap();
        let x = &read(b, "flow")["sigil"]["run"]["steps"]["x"];
        assert_eq!(x["status"], "reported");
        assert_eq!(x["markers"][0]["kind"], "reported_automatically");

        let blocked = agent(b, "y-block", "flow", "claude:one", SigilAgentOp::BlockStep { step_id: "y".into(), reason: "Which API?".into() }).await.unwrap();
        assert_eq!(light(&blocked), StepLight::NeedsYou);
        let resumed = start_step(b, "y-resume", "flow", "claude:one", "y").await.unwrap();
        assert_eq!(light(&resumed), StepLight::Running);
        assert_eq!(resumed["step"]["attempt"], 1);
        report(b, "y-report", "flow", "claude:one", "y").await.unwrap();
        let revision = read(b, "flow")["sigil"]["revision"].as_u64().unwrap();
        let done = report(b, "z-report", "flow", "claude:one", "z").await.unwrap();
        assert_eq!(done["state"], "completed");
        assert!(done["next"].is_null());
        assert_eq!(read(b, "flow")["sigil"]["revision"].as_u64().unwrap(), revision + 1, "completion is a lifecycle change");
        assert!(event_kinds(b, "flow").contains(&"completed".to_string()));
        assert!(agent(b, "late-claim", "flow", "claude:one", SigilAgentOp::Claim).await.unwrap_err().to_string().contains("结束"));
    }

    #[tokio::test]
    async fn notices_arrive_once_and_wait_wakes_pauses_and_ends() {
        let f = fixture();
        started(&f, "talk", SigilLocation::InPlace, vec![step("a", &[], false), step("b", &[], false)]).await;
        let b = f.b();
        let claimed = claim(b, "claim", "talk", "claude:one").await;
        b.sigil_user_note("talk", "note-1", "Use the new API.").unwrap();
        let noted = agent(b, "n1", "talk", "claude:one", SigilAgentOp::Note { text: "ok".into() }).await.unwrap();
        assert_eq!(noted["notices"].as_array().unwrap().len(), 1);
        assert_eq!(noted["notices"][0]["kind"], "user_note");
        assert_eq!(noted["notices"][0]["value"]["text"], "Use the new API.");
        assert!(agent(b, "n2", "talk", "claude:one", SigilAgentOp::Note { text: "again".into() }).await.unwrap()["notices"].as_array().unwrap().is_empty());

        let cursor = claimed["cursor"].as_u64().unwrap();
        let instant = b.sigil_wait("talk", "claude:one", cursor, 0).await.unwrap();
        assert_eq!(instant["status"], "events");
        let latest = instant["cursor"].as_u64().unwrap();
        let quiet = b.sigil_wait("talk", "claude:one", latest, 1).await.unwrap();
        assert_eq!(quiet["status"], "pending");
        assert_eq!(quiet["cursor"].as_u64().unwrap(), latest);

        let began = std::time::Instant::now();
        let (woken, _) = tokio::join!(b.sigil_wait("talk", "claude:one", latest, 20), async {
            tokio::time::sleep(Duration::from_millis(200)).await;
            b.sigil_control("talk", "pause", RunControl::Pause).unwrap();
        });
        let woken = woken.unwrap();
        assert_eq!(woken["status"], "events");
        assert_eq!(woken["events"][0]["kind"], "paused");
        assert!(began.elapsed() < Duration::from_secs(10));
        assert!(start_step(b, "paused-start", "talk", "claude:one", "a").await.unwrap_err().to_string().contains("paused"));
        b.sigil_control("talk", "resume", RunControl::Resume).unwrap();
        start_step(b, "resumed-start", "talk", "claude:one", "a").await.unwrap();
        b.sigil_control("talk", "abort", RunControl::Abort).unwrap();
        assert_eq!(b.sigil_wait("talk", "claude:one", 1_000_000, 20).await.unwrap()["status"], "ended");
        assert!(b.sigil_control("talk", "resume-after-abort", RunControl::Resume).is_err());
    }
}

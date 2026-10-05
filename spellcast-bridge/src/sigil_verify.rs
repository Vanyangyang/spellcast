//! Verification of a running sigil. A step's report queues its checks: Spellcast runs the
//! approved commands one at a time in the execution directory, and manual checks wait for the
//! user. A file change while a command runs marks its result, and the agent or the user can
//! rerun it. Contract: docs/sigil-phase1-contract.md, Verification.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::Duration;

use serde_json::{json, Value};
use spellcast_core::{inbox::now_ms, SpellcastError};

use crate::sigil_observe::{paths_detail, upsert_marker};
use crate::sigil_process::{self, Outcome, Tail};
use crate::sigil_run::complete_if_finished;
use crate::sigil_snapshot::Session;
use crate::sigil_store::{CheckOutput, Events};
use crate::sigils::{current_checks, verification, CheckResult, CheckStatus, Sigil, SigilCheck, SigilCommand, SigilState, SigilStep,
    StepProgress, StepStatus, Verification};
use crate::Bridge;

/// How often the card sees new output of a running command.
const LIVE_REFRESH: Duration = Duration::from_secs(2);
/// Output shown live, and kept in the sigil for a failed command; the rest is in its own table.
const LIVE_TAIL_BYTES: usize = 2 * 1024;
const TAIL_LINES: usize = 20;
const MAX_DISTURBED: usize = 12;

fn fail(error: impl ToString) -> SpellcastError {
    SpellcastError::user(error.to_string())
}

/// The command running for a sigil, keyed by the sigil's private directory so bridges that share
/// a process (as tests do) never mix.
struct LiveCheck {
    run: u64,
    step_id: String,
    index: usize,
    label: String,
    started_at_ms: u64,
    cancel: Arc<AtomicBool>,
    tail: Arc<Mutex<Tail>>,
}

static LIVE: LazyLock<Mutex<HashMap<PathBuf, LiveCheck>>> = LazyLock::new(Default::default);
/// Sigils with a task running their checks; at most one each.
static RUNNERS: LazyLock<Mutex<HashSet<PathBuf>>> = LazyLock::new(Default::default);

/// Removes its key from a registry when dropped, however the task ends.
struct Registered(&'static LazyLock<Mutex<HashSet<PathBuf>>>, PathBuf);

impl Drop for Registered {
    fn drop(&mut self) {
        self.0.lock().unwrap().remove(&self.1);
    }
}

struct LiveGuard(PathBuf);

impl Drop for LiveGuard {
    fn drop(&mut self) {
        LIVE.lock().unwrap().remove(&self.0);
    }
}

/// Whether the user consented to this command: frozen with the plan.
pub(crate) fn approved(consented: &[SigilCommand], step_id: &str, argv: &[String], timeout_s: u32) -> bool {
    consented.iter().any(|command| command.step_id == step_id && command.argv == argv && command.timeout_s == timeout_s)
}

fn queued(index: usize, check: &SigilCheck, attempt: u32, step_id: &str, consented: &[SigilCommand]) -> CheckResult {
    match check {
        SigilCheck::Command { label, argv, timeout_s } => CheckResult {
            index, kind: "command".into(), label: label.clone(), attempt,
            status: if approved(consented, step_id, argv, *timeout_s) { CheckStatus::Queued } else { CheckStatus::NeedsApproval },
            ..Default::default()
        },
        SigilCheck::Manual { label, .. } => CheckResult { index, kind: "manual".into(), label: label.clone(), attempt, status: CheckStatus::Waiting, ..Default::default() },
    }
}

/// The checks a report queues: approved commands in declared order, manual checks for the user.
pub(crate) fn queue_checks(step: &SigilStep, attempt: u32, consented: &[SigilCommand]) -> Vec<CheckResult> {
    step.checks.iter().enumerate().map(|(index, check)| queued(index, check, attempt, &step.id, consented)).collect()
}

/// Stops queued and running commands, as an abort or a new attempt of the step does.
pub(crate) fn stop_checks(progress: &mut StepProgress, reason: &str, now: u64) {
    for check in progress.checks.iter_mut().filter(|check| matches!(check.status, CheckStatus::Queued | CheckStatus::Running)) {
        check.status = CheckStatus::Stopped;
        check.error = reason.into();
        check.finished_at_ms = Some(now);
    }
}

/// Queues a reported step's finished commands again. Queued and running ones stay as they are.
pub(crate) fn rerun_checks(step: &SigilStep, progress: &mut StepProgress, consented: &[SigilCommand]) -> Result<Vec<usize>, String> {
    if progress.status != StepStatus::Reported {
        return Err(format!("步骤 {} 还没报告完成；报告后 Spellcast 会运行它的验证。", step.id));
    }
    let attempt = progress.attempt;
    let mut rerun = vec![];
    for result in progress.checks.iter_mut().filter(|check| check.attempt == attempt && check.kind == "command") {
        let Some(check @ SigilCheck::Command { .. }) = step.checks.get(result.index) else { continue };
        if matches!(result.status, CheckStatus::Passed | CheckStatus::Failed | CheckStatus::Stopped) {
            *result = queued(result.index, check, attempt, &step.id, consented);
            rerun.push(result.index);
        }
    }
    if rerun.is_empty() {
        return Err("没有可以重跑的命令验证：排队中或运行中的不会重复排队。".into());
    }
    Ok(rerun)
}

/// Records the user's decision on a manual check of the step's latest report. A decision can be
/// changed until the run ends.
pub(crate) fn decide_check(step: &SigilStep, progress: &mut StepProgress, index: usize, passed: bool, note: &str, now: u64) -> Result<CheckResult, String> {
    if progress.status != StepStatus::Reported {
        return Err(format!("步骤 {} 还没报告完成。", step.id));
    }
    let attempt = progress.attempt;
    let check = progress.checks.iter_mut().find(|check| check.index == index && check.attempt == attempt && check.kind == "manual")
        .ok_or_else(|| format!("步骤 {} 没有这项人工检查。", step.id))?;
    check.status = if passed { CheckStatus::Passed } else { CheckStatus::Failed };
    check.note = note.into();
    check.finished_at_ms = Some(now);
    Ok(check.clone())
}

/// Appends `step_verified` when a step's verification became final.
pub(crate) fn verified_event(step: &SigilStep, before: Verification, progress: &StepProgress, events: &mut Events) {
    let after = verification(step, progress);
    if after != before && matches!(after, Verification::Passed | Verification::Failed) {
        events.push(("step_verified".into(), json!({"step_id": step.id, "attempt": progress.attempt, "result": after})));
    }
}

/// The next command to run: the first queued check of the earliest reported step.
pub(crate) fn next_check(sigil: &Sigil) -> Option<(String, usize)> {
    let run = sigil.run.as_ref()?;
    sigil.plan.steps.iter().enumerate()
        .filter_map(|(order, step)| {
            let progress = run.steps.get(&step.id).filter(|progress| progress.status == StepStatus::Reported)?;
            let check = current_checks(progress).find(|check| check.status == CheckStatus::Queued)?;
            Some((progress.reported_at_ms.unwrap_or(0), order, step.id.clone(), check.index))
        })
        .min()
        .map(|(_, _, step_id, index)| (step_id, index))
}

fn interrupted(sigil: &Sigil) -> bool {
    sigil.run.as_ref().is_some_and(|run| run.steps.values().any(|progress| current_checks(progress).any(|check| check.status == CheckStatus::Running)))
}

/// Commands recorded as running while no task runs them were cut off by a restart; they run again.
fn requeue_interrupted(sigil: &mut Sigil, events: &mut Events) -> bool {
    let Some(run) = sigil.run.as_mut() else { return false };
    let mut requeued = false;
    for (step_id, progress) in &mut run.steps {
        let attempt = progress.attempt;
        for check in progress.checks.iter_mut().filter(|check| check.attempt == attempt && check.status == CheckStatus::Running) {
            events.push(("check_interrupted".into(), json!({"step_id": step_id, "index": check.index, "label": check.label, "run": check.run})));
            *check = CheckResult { index: check.index, kind: check.kind.clone(), label: check.label.clone(), attempt, status: CheckStatus::Queued, ..Default::default() };
            requeued = true;
        }
    }
    requeued
}

/// A command that has started: what to run and where.
struct Started {
    step_id: String,
    index: usize,
    attempt: u32,
    run: u64,
    label: String,
    argv: Vec<String>,
    timeout_s: u32,
    /// The latest observed tree: what the command verifies.
    tree: String,
    directory: PathBuf,
    started_at_ms: u64,
}

/// Marks the next approved command running. A queued command that is not approved waits for the
/// user instead, so an amendment can never run a command the user has not seen.
fn begin(sigil: &mut Sigil, now: u64, events: &mut Events) -> (Option<Started>, bool) {
    let consented = crate::sigils::consented_commands(sigil);
    let mut changed = false;
    while sigil.state == SigilState::Running {
        let Some((step_id, index)) = next_check(sigil) else { break };
        let Some(SigilCheck::Command { label, argv, timeout_s }) = sigil.plan.steps.iter().find(|step| step.id == step_id).and_then(|step| step.checks.get(index)).cloned() else { break };
        let Some(run) = sigil.run.as_mut() else { break };
        let tree = run.observation.as_ref().filter(|observation| observation.stopped.is_empty()).map(|observation| observation.tree.clone()).unwrap_or_default();
        let directory = PathBuf::from(&run.execution_directory);
        let number = run.check_runs + 1;
        let Some(progress) = run.steps.get_mut(&step_id) else { break };
        let attempt = progress.attempt;
        let Some(check) = progress.checks.iter_mut().find(|check| check.index == index && check.attempt == attempt) else { break };
        changed = true;
        if !approved(&consented, &step_id, &argv, timeout_s) {
            check.status = CheckStatus::NeedsApproval;
            events.push(("check_needs_approval".into(), json!({"step_id": step_id, "index": index, "label": label})));
            continue;
        }
        check.status = CheckStatus::Running;
        check.run = number;
        check.started_at_ms = Some(now);
        check.tree = tree.clone();
        run.check_runs = number;
        events.push(("check_started".into(), json!({"step_id": step_id, "attempt": attempt, "index": index, "label": label, "run": number, "argv": argv})));
        return (Some(Started { step_id, index, attempt, run: number, label, argv, timeout_s, tree, directory, started_at_ms: now }), true);
    }
    (None, changed)
}

/// The last lines of a failed command, for the card and the agent's notices.
fn tail_lines(output: &str) -> String {
    let lines: Vec<&str> = output.trim_end().lines().collect();
    let mut tail = lines[lines.len().saturating_sub(TAIL_LINES)..].join("\n");
    if tail.len() > LIVE_TAIL_BYTES {
        let mut cut = tail.len() - LIVE_TAIL_BYTES;
        while !tail.is_char_boundary(cut) {
            cut += 1;
        }
        tail = tail[cut..].to_string();
    }
    tail
}

/// Records a finished command unless its check moved on (aborted, or a newer report).
fn finish(sigil: &mut Sigil, started: &Started, outcome: &Outcome, disturbed: &[String], disturbed_files: usize, now: u64, events: &mut Events)
    -> Option<Option<&'static str>> {
    let step = sigil.plan.steps.iter().find(|step| step.id == started.step_id)?.clone();
    let progress = sigil.run.as_mut()?.steps.get_mut(&started.step_id)?;
    let before = verification(&step, progress);
    let check = progress.checks.iter_mut().find(|check| check.run == started.run && check.status == CheckStatus::Running)?;
    let passed = outcome.passed();
    check.status = if passed { CheckStatus::Passed } else if outcome.stopped { CheckStatus::Stopped } else { CheckStatus::Failed };
    check.exit_code = outcome.exit_code;
    check.timed_out = outcome.timed_out;
    check.error = if outcome.timed_out {
        format!("超过 {} 秒仍未结束，已结束它的整个进程树。", started.timeout_s)
    } else if outcome.stopped {
        "Spellcast 停止了这条命令。".into()
    } else {
        outcome.error.clone()
    };
    check.finished_at_ms = Some(now);
    check.output_bytes = outcome.output_bytes;
    check.tail = if passed { String::new() } else { tail_lines(&outcome.output) };
    check.disturbed = disturbed.iter().take(MAX_DISTURBED).cloned().collect();
    check.disturbed_files = disturbed_files;
    let result = check.clone();
    if !disturbed.is_empty() {
        upsert_marker(progress, "check_disturbed", now, format!("{}：{}", started.label, paths_detail(disturbed)));
    }
    events.push(("check_finished".into(), json!({"step_id": started.step_id, "attempt": started.attempt, "index": started.index,
        "label": started.label, "run": started.run, "status": result.status, "exit_code": result.exit_code, "timed_out": result.timed_out,
        "error": result.error, "duration_ms": outcome.duration_ms, "output_bytes": result.output_bytes, "disturbed": result.disturbed,
        "tail": result.tail})));
    verified_event(&step, before, progress, events);
    Some(complete_if_finished(sigil, now, events))
}

impl Bridge {
    /// Runs the sigil's queued commands one at a time until none is left or the run is not
    /// running (paused runs keep their queue). At most one task does this per sigil.
    pub(crate) async fn sigil_run_checks(&self, sigil_id: &str) -> Result<(), SpellcastError> {
        let dir = self.sigil_dir(sigil_id)?;
        if !RUNNERS.lock().unwrap().insert(dir.clone()) {
            return Ok(());
        }
        let _runner = Registered(&RUNNERS, dir.clone());
        if self.sigil_store()?.sigil_record(sigil_id, None, |sigil, events| requeue_interrupted(sigil, events).then_some(None)).map_err(fail)? {
            self.sigil_changed(sigil_id);
        }
        loop {
            let sigil = self.sigil_store()?.sigil_get(sigil_id).map_err(fail)?;
            if sigil.state != SigilState::Running || next_check(&sigil).is_none() {
                return Ok(());
            }
            // Record edits made so far, so the command's result belongs to the tree it saw.
            let _ = self.sigil_observe_now(sigil_id).await;
            let now = now_ms();
            let mut started = None;
            self.sigil_store()?.sigil_record(sigil_id, None, |sigil, events| {
                let (begun, changed) = begin(sigil, now, events);
                started = begun;
                changed.then_some(None)
            }).map_err(fail)?;
            let Some(started) = started else {
                self.sigil_changed(sigil_id);
                return Ok(());
            };
            self.sigil_changed(sigil_id);
            self.run_check(sigil_id, &dir, started).await?;
        }
    }

    async fn run_check(&self, sigil_id: &str, dir: &Path, started: Started) -> Result<(), SpellcastError> {
        let cancel = Arc::new(AtomicBool::new(false));
        let tail = Arc::new(Mutex::new(Tail::default()));
        LIVE.lock().unwrap().insert(dir.to_path_buf(), LiveCheck { run: started.run, step_id: started.step_id.clone(), index: started.index,
            label: started.label.clone(), started_at_ms: started.started_at_ms, cancel: Arc::clone(&cancel), tail: Arc::clone(&tail) });
        let _live = LiveGuard(dir.to_path_buf());
        // An abort or a new report may have landed between starting the check and registering it.
        self.cancel_stale_check(sigil_id);
        let task = tokio::task::spawn_blocking({
            let (argv, directory, timeout) = (started.argv.clone(), started.directory.clone(), Duration::from_secs(u64::from(started.timeout_s)));
            let (cancel, tail) = (Arc::clone(&cancel), Arc::clone(&tail));
            move || sigil_process::run(&argv, &directory, timeout, &cancel, &tail)
        });
        tokio::pin!(task);
        let mut shown = 0;
        let outcome = loop {
            tokio::select! {
                joined = &mut task => break joined.map_err(|error| fail(format!("验证线程失败：{error}")))?,
                _ = tokio::time::sleep(LIVE_REFRESH) => {
                    let total = tail.lock().unwrap().total();
                    if total != shown {
                        shown = total;
                        self.surface.sigil_changed(sigil_id);
                    }
                }
            }
        };
        // The snapshot after the command shows whether files changed while it ran.
        let _ = self.sigil_observe_now(sigil_id).await;
        let after = self.sigil_store()?.sigil_get(sigil_id).map_err(fail)?.run
            .and_then(|run| run.observation).filter(|observation| observation.stopped.is_empty()).map(|observation| observation.tree).unwrap_or_default();
        let (mut disturbed, mut disturbed_files) = (vec![], 0);
        if !started.tree.is_empty() && !after.is_empty() && after != started.tree {
            if let Ok(changes) = async { Session::open(dir)?.diff(&started.tree, &after, false).await }.await {
                disturbed_files = changes.len();
                disturbed = changes.into_iter().map(|change| change.path).collect();
            }
        }
        let now = now_ms();
        let output = CheckOutput { run: started.run, step_id: &started.step_id, attempt: started.attempt, index: started.index, output: &outcome.output };
        let recorded = self.sigil_store()?
            .sigil_record(sigil_id, Some(&output), |sigil, events| finish(sigil, &started, &outcome, &disturbed, disturbed_files, now, events))
            .map_err(fail)?;
        if recorded {
            self.sigil_changed(sigil_id);
        }
        Ok(())
    }

    /// Ends a running command whose check no longer runs: the run was aborted, or the step was
    /// reported again or started a new attempt.
    pub(crate) fn cancel_stale_check(&self, sigil_id: &str) {
        let Ok(dir) = self.sigil_dir(sigil_id) else { return };
        let Some((number, cancel)) = LIVE.lock().unwrap().get(&dir).map(|live| (live.run, Arc::clone(&live.cancel))) else { return };
        let Ok(sigil) = self.sigil_store().and_then(|store| store.sigil_get(sigil_id).map_err(fail)) else { return };
        let current = matches!(sigil.state, SigilState::Running | SigilState::Paused)
            && sigil.run.as_ref().is_some_and(|run| run.steps.values().any(|progress| {
                progress.checks.iter().any(|check| check.run == number && check.status == CheckStatus::Running)
            }));
        if !current {
            cancel.store(true, Ordering::Relaxed);
        }
    }

    /// Starts a task for each running sigil with queued commands, or with commands cut off by a
    /// restart. Called by the observation loop.
    pub(crate) fn schedule_checks(self: &Arc<Self>, root: &Path, active: &[Sigil]) {
        for sigil in active.iter().filter(|sigil| sigil.state == SigilState::Running) {
            if RUNNERS.lock().unwrap().contains(&root.join(&sigil.id)) || (next_check(sigil).is_none() && !interrupted(sigil)) {
                continue;
            }
            let bridge = Arc::clone(self);
            let id = sigil.id.clone();
            tokio::spawn(async move {
                if let Err(error) = bridge.sigil_run_checks(&id).await {
                    tracing::warn!("sigil {id} checks: {error}");
                }
            });
        }
    }

    /// The running command and its newest output, for the panel. Null when none runs.
    pub(crate) fn sigil_check_live(&self, sigil_id: &str) -> Value {
        let Ok(dir) = self.sigil_dir(sigil_id) else { return Value::Null };
        let live = LIVE.lock().unwrap();
        live.get(&dir).map_or(Value::Null, |live| {
            let tail = live.tail.lock().unwrap();
            json!({"step_id": live.step_id, "index": live.index, "run": live.run, "label": live.label, "started_at_ms": live.started_at_ms,
                "output_tail": tail.text(LIVE_TAIL_BYTES), "output_bytes": tail.total()})
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sigil_run::RunControl;
    use crate::sigil_workspace::{SigilAgentOp, SigilQuery, SigilUpdate};
    use crate::sigils::{SigilLocation, SigilPlan};
    use crate::Headless;
    use std::time::Instant;

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

    /// `tools/<name>`: a batch file on Windows, an executable shell script elsewhere.
    fn script(repo: &Path, name: &str, windows: &str, unix: &str) {
        if cfg!(windows) {
            std::fs::write(repo.join("tools").join(format!("{name}.cmd")), format!("@echo off\r\n{}", windows.replace('\n', "\r\n"))).unwrap();
        } else {
            let path = repo.join("tools").join(name);
            std::fs::write(&path, format!("#!/bin/sh\n{unix}")).unwrap();
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
            }
        }
    }

    fn fixture() -> Fixture {
        let root = std::env::temp_dir().join(format!("sigil-verify-{}", uuid::Uuid::new_v4().simple()));
        let repo = root.join("repo");
        std::fs::create_dir_all(repo.join("src")).unwrap();
        std::fs::create_dir_all(repo.join("tools")).unwrap();
        std::fs::write(repo.join("src/lib.rs"), "pub fn answer() -> u8 { 42 }\n").unwrap();
        script(&repo, "slow", "echo slow start\nping -n 3 127.0.0.1 >nul\necho slow end\n", "echo slow start\nsleep 2\necho slow end\n");
        script(&repo, "hang", "echo hanging\nping -n 60 127.0.0.1 >nul\n", "echo hanging\nsleep 60\n");
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
        SigilStep { id: id.into(), title: format!("Step {id}"), instructions: String::new(), inputs: vec![], scope: vec!["src/**".into()], checks,
            depends_on: depends_on.iter().map(|id| id.to_string()).collect(), stop_when: vec![] }
    }

    async fn agent(b: &Bridge, request: &str, sigil: &str, op: SigilAgentOp) -> Result<Value, SpellcastError> {
        b.sigil_agent_update(SigilUpdate { request_id: request.into(), sigil_id: sigil.into(), source_id: "claude:runner".into(), label: "Runner".into(), op }).await
    }

    async fn started(f: &Fixture, id: &str, steps: Vec<SigilStep>) {
        let plan = SigilPlan { title: format!("Verify {id}"), repository: f.repo.to_string_lossy().into(), location: SigilLocation::InPlace, steps, ..Default::default() };
        agent(f.b(), &format!("{id}-plan"), id, SigilAgentOp::PutPlan { expected_revision: 0, plan }).await.unwrap();
        f.b().sigil_freeze(id, &format!("{id}-freeze"), 1).unwrap();
        f.b().sigil_start(id, &format!("{id}-start"), 2).await.unwrap();
        agent(f.b(), &format!("{id}-claim"), id, SigilAgentOp::Claim).await.unwrap();
    }

    async fn start_and_report(b: &Bridge, sigil: &str, step: &str, round: &str) -> Value {
        agent(b, &format!("{step}-{round}-start"), sigil, SigilAgentOp::StartStep { step_id: step.into() }).await.unwrap();
        agent(b, &format!("{step}-{round}-report"), sigil, SigilAgentOp::ReportStep { step_id: step.into(), summary: "done".into(), evidence: vec![] }).await.unwrap()
    }

    fn view(b: &Bridge, id: &str) -> Value {
        b.sigil_query(SigilQuery { view: "sigil".into(), sigil_id: id.into(), ..Default::default() }).unwrap()
    }

    fn checks(b: &Bridge, id: &str, step: &str) -> Vec<Value> {
        view(b, id)["sigil"]["run"]["steps"][step]["checks"].as_array().cloned().unwrap_or_default()
    }

    fn statuses(b: &Bridge, id: &str, step: &str) -> Vec<String> {
        checks(b, id, step).iter().map(|check| check["status"].as_str().unwrap().to_string()).collect()
    }

    fn kinds(events: &Value) -> Vec<String> {
        events.as_array().unwrap().iter().map(|event| event["kind"].as_str().unwrap().to_string()).collect()
    }

    async fn until_running(b: &Bridge, id: &str, step: &str) {
        let began = Instant::now();
        while !statuses(b, id, step).iter().any(|status| status == "running") {
            assert!(began.elapsed() < Duration::from_secs(30), "the command never started");
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        // The live entry follows the start; wait for the process too.
        while b.sigil_check_live(id).is_null() {
            assert!(began.elapsed() < Duration::from_secs(30), "the command never registered");
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }

    #[test]
    fn unapproved_commands_wait_for_the_user_and_manual_checks_wait_too() {
        let step = step("a", &[], vec![command("build", &["cargo", "build"]), command("test", &["cargo", "test"]),
            SigilCheck::Manual { label: "look".into(), description: String::new() }]);
        let consented = vec![SigilCommand { step_id: "a".into(), label: "build".into(), argv: vec!["cargo".into(), "build".into()], timeout_s: 120 }];
        let queued = queue_checks(&step, 1, &consented);
        let statuses: Vec<CheckStatus> = queued.iter().map(|check| check.status).collect();
        assert_eq!(statuses, [CheckStatus::Queued, CheckStatus::NeedsApproval, CheckStatus::Waiting]);
        let progress = StepProgress { status: StepStatus::Reported, attempt: 1, checks: queued, ..Default::default() };
        assert_eq!(verification(&step, &progress), Verification::NeedsYou);
        let other = SigilCommand { step_id: "b".into(), ..consented[0].clone() };
        assert!(!approved(&[other], "a", &consented[0].argv, 120), "consent is per step");
        assert!(!approved(&consented, "a", &consented[0].argv, 60), "and per timeout");
    }

    #[tokio::test]
    async fn commands_and_manual_checks_drive_lights_next_and_completion() {
        let f = fixture();
        let b = f.b();
        started(&f, "lights", vec![
            step("a", &[], vec![command("version", &["git", "--version"]), SigilCheck::Manual { label: "look".into(), description: "Open it".into() }]),
            step("b", &["a"], vec![command("fixed branch", &["git", "rev-parse", "--verify", "refs/heads/fixed"])]),
        ]).await;
        let reported = start_and_report(b, "lights", "a", "1").await;
        assert_eq!(reported["step"]["light"], "needs_you", "a manual check waits for the user: {reported}");
        assert_eq!(statuses(b, "lights", "a"), ["queued", "waiting"]);
        assert!(reported["next"].is_null(), "b waits for a's verification");

        b.sigil_run_checks("lights").await.unwrap();
        assert_eq!(statuses(b, "lights", "a"), ["passed", "waiting"]);
        assert_eq!(view(b, "lights")["lights"]["a"], "needs_you");
        assert!(b.sigil_decide_check("lights", "decide-ghost", "a", 0, true, "").unwrap_err().to_string().contains("人工检查"));
        let decided = b.sigil_decide_check("lights", "decide-look", "a", 1, true, "Looks right").unwrap();
        assert_eq!(decided["sigil"]["run"]["steps"]["a"]["checks"][1]["note"], "Looks right");
        assert_eq!(view(b, "lights")["lights"]["a"], "passed");
        assert_eq!(view(b, "lights")["next"], "b");

        // The agent hears about results without polling.
        let noted = agent(b, "note-1", "lights", SigilAgentOp::Note { text: "next".into() }).await.unwrap();
        assert_eq!(kinds(&noted["notices"]), ["check_finished", "check_decided", "step_verified"], "{noted}");
        assert_eq!(noted["notices"][2]["value"]["result"], "passed");

        start_and_report(b, "lights", "b", "1").await;
        b.sigil_run_checks("lights").await.unwrap();
        let failed = &checks(b, "lights", "b")[0];
        assert_eq!(failed["status"], "failed");
        assert_ne!(failed["exit_code"], 0);
        assert!(failed["tail"].as_str().unwrap().contains("fatal"), "{failed}");
        let next = b.sigil_next("lights").unwrap();
        assert_eq!(next["next"]["id"], "b", "a failed step comes back to the agent");
        assert_eq!(next["next"]["light"], "failed");
        assert_eq!(next["next"]["check_results"][0]["status"], "failed");
        let waited = b.sigil_wait("lights", "claude:runner", noted["cursor"].as_u64().unwrap(), 0).await.unwrap();
        assert!(kinds(&waited["events"]).contains(&"step_verified".to_string()), "{waited}");

        // A new attempt keeps the failed result visible until its own report, then passes.
        let again = agent(b, "b-2-start", "lights", SigilAgentOp::StartStep { step_id: "b".into() }).await.unwrap();
        assert_eq!(again["step"]["light"], "running");
        assert_eq!(again["step"]["attempt"], 2);
        assert_eq!(statuses(b, "lights", "b"), ["failed"]);
        sh(&f.repo, &["branch", "fixed"]);
        agent(b, "b-2-report", "lights", SigilAgentOp::ReportStep { step_id: "b".into(), summary: "fixed".into(), evidence: vec![] }).await.unwrap();
        assert_eq!(checks(b, "lights", "b")[0]["attempt"], 2);
        b.sigil_run_checks("lights").await.unwrap();
        let done = view(b, "lights");
        assert_eq!(done["lights"]["b"], "passed");
        assert_eq!(done["sigil"]["state"], "completed");
        let step = b.sigil_query(SigilQuery { view: "step".into(), sigil_id: "lights".into(), step_id: "a".into(), ..Default::default() }).unwrap();
        let run = step["progress"]["checks"][0]["run"].as_u64().unwrap();
        assert!(step["outputs"][run.to_string()].as_str().unwrap().contains("git version"), "{step}");
        assert_eq!(step["verification"], "passed");
    }

    #[tokio::test]
    async fn changes_while_a_command_runs_mark_it_and_reruns_run_it_again() {
        let f = fixture();
        let b = f.b();
        started(&f, "busy", vec![step("a", &[], vec![command("slow", &["tools/slow"])])]).await;
        start_and_report(b, "busy", "a", "1").await;
        assert!(agent(b, "rerun-early", "busy", SigilAgentOp::RerunChecks { step_id: "a".into() }).await.unwrap_err().to_string().contains("重跑"));
        let (ran, _) = tokio::join!(b.sigil_run_checks("busy"), async {
            until_running(b, "busy", "a").await;
            let live = b.sigil_check_live("busy");
            assert_eq!(live["label"], "slow");
            std::fs::write(f.repo.join("src/during.rs"), "pub fn during() {}\n").unwrap();
        });
        ran.unwrap();
        let check = &checks(b, "busy", "a")[0];
        assert_eq!(check["status"], "passed", "{check}");
        assert_eq!(check["disturbed"], json!(["src/during.rs"]));
        let markers = &view(b, "busy")["sigil"]["run"]["steps"]["a"]["markers"];
        assert!(markers.as_array().unwrap().iter().any(|marker| marker["kind"] == "check_disturbed" && marker["detail"].as_str().unwrap().contains("src/during.rs")), "{markers}");
        assert_eq!(view(b, "busy")["sigil"]["state"], "completed", "a marked result still passes; markers never block");
        assert!(b.sigil_check_live("busy").is_null());

        // Reruns need an open run: here it already completed.
        assert!(b.sigil_rerun_checks("busy", "rerun-late", "a").unwrap_err().to_string().contains("没有在执行"));
    }

    #[tokio::test]
    async fn reruns_queue_finished_commands_again() {
        let f = fixture();
        let b = f.b();
        started(&f, "again", vec![step("a", &[], vec![command("fixed branch", &["git", "rev-parse", "--verify", "refs/heads/fixed"])]),
            step("b", &["a"], vec![])]).await;
        start_and_report(b, "again", "a", "1").await;
        b.sigil_run_checks("again").await.unwrap();
        assert_eq!(statuses(b, "again", "a"), ["failed"]);
        sh(&f.repo, &["branch", "fixed"]);
        let rerun = b.sigil_rerun_checks("again", "rerun-user", "a").unwrap();
        assert_eq!(rerun["sigil"]["run"]["steps"]["a"]["checks"][0]["status"], "queued");
        assert!(b.sigil_rerun_checks("again", "rerun-twice", "a").unwrap_err().to_string().contains("重跑"), "queued commands are not queued twice");
        b.sigil_run_checks("again").await.unwrap();
        assert_eq!(statuses(b, "again", "a"), ["passed"]);
        let by_agent = agent(b, "rerun-agent", "again", SigilAgentOp::RerunChecks { step_id: "a".into() }).await.unwrap();
        assert_eq!(by_agent["step"]["light"], "verifying");
        b.sigil_run_checks("again").await.unwrap();
        assert_eq!(view(b, "again")["lights"]["a"], "passed");
        let events = b.sigil_query(SigilQuery { view: "events".into(), sigil_id: "again".into(), ..Default::default() }).unwrap();
        let reruns: Vec<&Value> = events["events"].as_array().unwrap().iter().filter(|event| event["kind"] == "checks_rerun").collect();
        assert_eq!(reruns.iter().map(|event| event["value"]["by"].as_str().unwrap()).collect::<Vec<_>>(), ["user", "agent"]);
    }

    #[tokio::test]
    async fn pausing_holds_the_queue_and_aborting_ends_the_running_command() {
        let f = fixture();
        let b = f.b();
        started(&f, "halt", vec![step("a", &[], vec![command("first", &["git", "--version"]), command("second", &["git", "--version"])]),
            step("b", &["a"], vec![command("hang", &["tools/hang"])])]).await;
        start_and_report(b, "halt", "a", "1").await;
        b.sigil_control("halt", "pause", RunControl::Pause).unwrap();
        b.sigil_run_checks("halt").await.unwrap();
        assert_eq!(statuses(b, "halt", "a"), ["queued", "queued"], "a paused run keeps its queue");
        b.sigil_control("halt", "resume", RunControl::Resume).unwrap();
        b.sigil_run_checks("halt").await.unwrap();
        assert_eq!(statuses(b, "halt", "a"), ["passed", "passed"]);

        start_and_report(b, "halt", "b", "1").await;
        let began = Instant::now();
        let (ran, _) = tokio::join!(b.sigil_run_checks("halt"), async {
            until_running(b, "halt", "b").await;
            b.sigil_control("halt", "abort", RunControl::Abort).unwrap();
        });
        ran.unwrap();
        assert!(began.elapsed() < Duration::from_secs(20), "the hanging command was ended: {:?}", began.elapsed());
        let stopped = &checks(b, "halt", "b")[0];
        assert_eq!(stopped["status"], "stopped", "{stopped}");
        assert_eq!(stopped["error"], "执行已中止。");
        assert_eq!(view(b, "halt")["sigil"]["state"], "aborted");
        assert!(b.sigil_check_live("halt").is_null());
    }

    #[tokio::test]
    async fn commands_cut_off_by_a_restart_run_again() {
        let mut f = fixture();
        started(&f, "restart", vec![step("a", &[], vec![command("version", &["git", "--version"])])]).await;
        start_and_report(f.b(), "restart", "a", "1").await;
        // As if Spellcast quit while the command ran.
        f.b().sigil_store().unwrap().sigil_record("restart", None, |sigil, _| {
            let run = sigil.run.as_mut().unwrap();
            run.check_runs = 1;
            let check = &mut run.steps.get_mut("a").unwrap().checks[0];
            check.status = CheckStatus::Running;
            check.run = 1;
            Some(None)
        }).unwrap();
        drop(f.bridge.take());
        f.bridge = Some(Bridge::open(Headless, 0, &f.root.join("state.sqlite3")).unwrap());
        let b = f.b();
        b.sigil_run_checks("restart").await.unwrap();
        let check = &checks(b, "restart", "a")[0];
        assert_eq!(check["status"], "passed");
        assert_eq!(check["run"], 2, "run numbers are never reused");
        let events = b.sigil_query(SigilQuery { view: "events".into(), sigil_id: "restart".into(), ..Default::default() }).unwrap();
        assert!(kinds(&events["events"]).contains(&"check_interrupted".to_string()));
        assert_eq!(view(b, "restart")["sigil"]["state"], "completed");
    }
}

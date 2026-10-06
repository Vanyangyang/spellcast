//! Sigil (法阵) plans: a build plan the user freezes and one MCP-connected agent executes while
//! Spellcast observes. This module holds the plan types, write-time bounds and the freeze review.
//! Contract: docs/sigil-phase1-contract.md.

use std::collections::{BTreeMap, BTreeSet};
use std::io::Read;
use std::path::{Path, PathBuf};

use rmcp::schemars::{self, JsonSchema};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

pub const MAX_STEPS: usize = 64;
pub const DEFAULT_TIMEOUT_S: u32 = 600;
pub const MAX_TIMEOUT_S: u32 = 3600;
const MAX_SHORT_ID: usize = 40;

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum SigilLocation {
    /// A new worktree and `sigil/<id>` branch beside the repository.
    #[default]
    Worktree,
    /// The repository's current work tree; recommended for projects bound to one path.
    InPlace,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum SigilState {
    Draft,
    Frozen,
    Running,
    Paused,
    Completed,
    Aborted,
    Archived,
}

impl SigilState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Draft => "draft",
            Self::Frozen => "frozen",
            Self::Running => "running",
            Self::Paused => "paused",
            Self::Completed => "completed",
            Self::Aborted => "aborted",
            Self::Archived => "archived",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SigilCheck {
    /// Run by Spellcast without a shell in the execution directory; exit code 0 passes.
    Command {
        label: String,
        argv: Vec<String>,
        #[serde(default = "default_timeout")]
        timeout_s: u32,
    },
    /// Waits for the user's pass or fail.
    Manual {
        label: String,
        #[serde(default)]
        description: String,
    },
}

fn default_timeout() -> u32 {
    DEFAULT_TIMEOUT_S
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, JsonSchema)]
pub struct SigilStep {
    /// Stable within the plan: lowercase letters, digits and dashes.
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub instructions: String,
    /// Repository-relative files this step relies on, hashed at freeze.
    #[serde(default)]
    pub inputs: Vec<String>,
    /// Repository-relative globs this step expects to change: `*`, `?` and `[...]` within a
    /// segment, `**` as a whole segment. A pattern naming a directory covers everything in it.
    #[serde(default)]
    pub scope: Vec<String>,
    #[serde(default)]
    pub checks: Vec<SigilCheck>,
    #[serde(default)]
    pub depends_on: Vec<String>,
    /// Conditions under which the agent should block the step and ask the user.
    #[serde(default)]
    pub stop_when: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, JsonSchema)]
pub struct SigilMaterial {
    pub object_id: String,
    pub content_revision: u64,
}

/// Everything an author writes on a draft.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq, JsonSchema)]
pub struct SigilPlan {
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub goal: String,
    /// Absolute path of the git work tree root.
    #[serde(default)]
    pub repository: String,
    /// Branch the run starts from; empty means the repository's current branch at start.
    #[serde(default)]
    pub base_ref: String,
    #[serde(default)]
    pub location: SigilLocation,
    /// Empty uses `<repository parent>/<repository name>.sigils/<id>`.
    #[serde(default)]
    pub worktree_path: String,
    #[serde(default)]
    pub materials: Vec<SigilMaterial>,
    #[serde(default)]
    pub open_questions: Vec<String>,
    #[serde(default)]
    pub steps: Vec<SigilStep>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, JsonSchema)]
pub struct SigilActor {
    /// `user`, `agent`, or a native-authorized draft-only `client`.
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_id: Option<String>,
    pub label: String,
}

impl SigilActor {
    pub fn user() -> Self {
        Self { kind: "user".into(), source_id: None, label: "用户".into() }
    }

    pub fn is_user(&self) -> bool {
        self.kind == "user"
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, JsonSchema)]
pub struct SigilCommand {
    pub step_id: String,
    pub label: String,
    pub argv: Vec<String>,
    pub timeout_s: u32,
}

/// What the user froze: the revision, input hashes and exactly the commands they consented to.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, JsonSchema)]
pub struct SigilFreeze {
    pub at_ms: u64,
    pub revision: u64,
    pub input_hashes: BTreeMap<String, String>,
    pub commands: Vec<SigilCommand>,
    pub execution_directory: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, JsonSchema)]
pub struct Sigil {
    pub id: String,
    #[serde(flatten)]
    pub plan: SigilPlan,
    pub state: SigilState,
    /// Changes with the plan and lifecycle (freeze, start, pause, finish), not with step reports.
    pub revision: u64,
    /// The source that authors the draft; empty until an agent writes a user-created draft.
    #[serde(default)]
    pub owner_source: String,
    pub created_at_ms: u64,
    pub updated_at_ms: u64,
    pub updated_by: SigilActor,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub freeze: Option<SigilFreeze>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub run: Option<SigilRun>,
}

/// Progress as the agent reports it. Verification is a separate dimension owned by Spellcast.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum StepStatus {
    #[default]
    Pending,
    Active,
    Reported,
    Blocked,
    Skipped,
}

/// Something to review later. Markers never stop the run.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, JsonSchema)]
pub struct StepMarker {
    pub kind: String,
    pub at_ms: u64,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub detail: String,
}

fn is_false(value: &bool) -> bool {
    !*value
}

fn is_zero(value: &usize) -> bool {
    *value == 0
}

fn is_zero_u64(value: &u64) -> bool {
    *value == 0
}

/// Where one check of a step's latest report stands.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum CheckStatus {
    /// A command waiting for its turn; one check runs at a time.
    #[default]
    Queued,
    Running,
    Passed,
    Failed,
    /// A manual check waiting for the user's decision.
    Waiting,
    /// A command the user has not approved, as after an amendment.
    NeedsApproval,
    /// Ended by an abort, or by a new attempt of the step.
    Stopped,
}

/// One check of one report of a step. Command output beyond `tail` is kept in its own table
/// and returned by the `step` view.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq, JsonSchema)]
pub struct CheckResult {
    /// Position in the step's checks.
    pub index: usize,
    /// `command` or `manual`.
    pub kind: String,
    pub label: String,
    pub attempt: u32,
    pub status: CheckStatus,
    /// This command's run, unique within the sigil; 0 until it starts.
    #[serde(default, skip_serializing_if = "is_zero_u64")]
    pub run: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub started_at_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub finished_at_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
    #[serde(default, skip_serializing_if = "is_false")]
    pub timed_out: bool,
    /// Why the command could not run, or why it stopped.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub error: String,
    /// The last lines of a failed command's output.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub tail: String,
    #[serde(default, skip_serializing_if = "is_zero_u64")]
    pub output_bytes: u64,
    /// The snapshot of the directory when the command started: what it verified.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub tree: String,
    /// Files that changed while the command ran, so its result may not match them.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub disturbed: Vec<String>,
    #[serde(default, skip_serializing_if = "is_zero")]
    pub disturbed_files: usize,
    /// The user's note on a manual decision.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub note: String,
}

/// The verification dimension of a step, owned by Spellcast and the user.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum Verification {
    /// No checks, or the step has not been reported.
    None,
    Running,
    Passed,
    Failed,
    /// A manual check or a command waiting for the user.
    NeedsYou,
}

/// An untracked file over the size limit: listed by size, never stored in a snapshot.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq, JsonSchema)]
pub struct LargeFile {
    pub size: u64,
    pub modified_ms: u64,
}

/// One file in a change list, against the start of its window.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq, JsonSchema)]
pub struct ChangedPath {
    pub path: String,
    /// `A` added, `M` modified, `D` deleted or `T` type changed.
    pub status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub added: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deleted: Option<u64>,
    #[serde(default, skip_serializing_if = "is_false")]
    pub binary: bool,
    /// Set for large untracked files, which are listed but not stored.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub size: Option<u64>,
    #[serde(default, skip_serializing_if = "is_false")]
    pub out_of_scope: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq, JsonSchema)]
pub struct StepProgress {
    #[serde(default)]
    pub status: StepStatus,
    #[serde(default)]
    pub attempt: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub started_at_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reported_at_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub summary: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub evidence: Vec<String>,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub block_reason: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub markers: Vec<StepMarker>,
    /// Snapshot tree where the current attempt's change window opened.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub start_tree: String,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub start_large: BTreeMap<String, LargeFile>,
    /// Snapshot tree when the step was reported.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub end_tree: String,
    /// Files changed in the current attempt, at most 500 of `changed_files`.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub changes: Vec<ChangedPath>,
    #[serde(default, skip_serializing_if = "is_zero")]
    pub changed_files: usize,
    /// Paths outside the declared scope seen in any attempt.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub outside_scope: Vec<String>,
    /// Checks of the latest report. While a new attempt runs they still show the previous one.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub checks: Vec<CheckResult>,
}

/// Changes seen while no step was running, from one step boundary to the latest snapshot.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq, JsonSchema)]
pub struct OutsideChanges {
    pub from_tree: String,
    pub to_tree: String,
    pub first_at_ms: u64,
    pub last_at_ms: u64,
    #[serde(default)]
    pub files: Vec<ChangedPath>,
    #[serde(default)]
    pub changed_files: usize,
}

/// What Spellcast has observed of the execution directory. Trees live in the run's private
/// object directory, never in the repository.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq, JsonSchema)]
pub struct SigilObservation {
    pub baseline_tree: String,
    /// The latest snapshot that changed something.
    pub tree: String,
    pub observed_at_ms: u64,
    /// The snapshot at the latest step start or report.
    pub boundary_tree: String,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub large: BTreeMap<String, LargeFile>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub boundary_large: BTreeMap<String, LargeFile>,
    /// Files other programs kept from being read in the latest snapshot.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub partial: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub outside: Vec<OutsideChanges>,
    /// Inputs that already differed from the frozen version when the run started.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub inputs_differ_at_start: Vec<String>,
    /// Steps whose in-scope changes touched an input, which explains a later input change.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub input_writers: BTreeMap<String, Vec<String>>,
    #[serde(default)]
    pub private_bytes: u64,
    /// Why observation stopped: `size_cap` or `unavailable`. Steps continue without change lists.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub stopped: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub stopped_detail: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, JsonSchema)]
pub struct SigilExecutor {
    pub source_id: String,
    pub label: String,
    pub since_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, JsonSchema)]
pub struct SigilClaim {
    pub source_id: String,
    pub label: String,
    pub at_ms: u64,
}

/// The one native user request reserved for this run. Transport progress remains in the
/// existing feedback receipt; this only pins its identity and original target.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, JsonSchema)]
pub struct SigilDelivery {
    pub started_at_ms: u64,
    pub request_id: String,
    pub source_id: String,
    pub thread_id: String,
    pub cwd: String,
    pub target_label: String,
    pub instruction: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sequence: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, JsonSchema)]
pub struct SigilRun {
    pub started_at_ms: u64,
    pub execution_directory: String,
    pub location: SigilLocation,
    /// `sigil/<id>` for a worktree run; empty in place.
    #[serde(default)]
    pub branch: String,
    pub base_ref: String,
    pub base_commit: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub executor: Option<SigilExecutor>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub delivery: Option<SigilDelivery>,
    /// Claims from other sources waiting for the user's handover approval.
    #[serde(default)]
    pub pending_claims: Vec<SigilClaim>,
    /// Sources the user revoked; they need approval to claim again.
    #[serde(default)]
    pub revoked: Vec<String>,
    /// Earlier executors ended by an approved handover.
    #[serde(default)]
    pub replaced: Vec<String>,
    #[serde(default)]
    pub steps: BTreeMap<String, StepProgress>,
    /// Last event each executor has been told about, so notices survive the agent's compaction.
    #[serde(default)]
    pub notice_cursor: BTreeMap<String, u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub observation: Option<SigilObservation>,
    /// Command runs started so far; numbers each run.
    #[serde(default)]
    pub check_runs: u64,
    /// The agent's plan changes, in order, with what they replaced.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub amendments: Vec<SigilAmendment>,
    /// Commands the user approved after freezing, as amendments added or changed them.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub approved_commands: Vec<SigilCommand>,
    /// Inputs first declared by an amendment, hashed then (`None` for a missing file). Input
    /// changes are measured against these instead of the freeze.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub amended_inputs: BTreeMap<String, Option<String>>,
}

/// One change of an amendment, with what it replaced, so the user can revert it.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, JsonSchema)]
pub struct AmendmentChange {
    /// `add_step`, `update_step` or `skip_step`.
    pub kind: String,
    pub step_id: String,
    /// The step before an update.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub before: Option<SigilStep>,
    /// A skipped step's status before the skip.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status_before: Option<StepStatus>,
    /// The fields an update changed.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub fields: Vec<String>,
}

/// An agent's change to the running plan. It applies at once as a new plan revision.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, JsonSchema)]
pub struct SigilAmendment {
    /// The plan revision it produced, which also names it.
    pub revision: u64,
    pub at_ms: u64,
    pub source_id: String,
    pub reason: String,
    pub changes: Vec<AmendmentChange>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reverted_at_ms: Option<u64>,
}

/// Every command the user consented to: those frozen with the plan and those approved since.
pub fn consented_commands(sigil: &Sigil) -> Vec<SigilCommand> {
    let mut commands = sigil.freeze.as_ref().map(|freeze| freeze.commands.clone()).unwrap_or_default();
    if let Some(run) = &sigil.run {
        commands.extend(run.approved_commands.iter().cloned());
    }
    commands
}

/// Command checks in the current plan that the user has not consented to, as
/// `(step id, check index, command)`.
pub fn pending_commands(sigil: &Sigil) -> Vec<(String, usize, SigilCommand)> {
    let consented = consented_commands(sigil);
    sigil.plan.steps.iter().flat_map(|step| {
        let consented = &consented;
        step.checks.iter().enumerate().filter_map(move |(index, check)| match check {
            SigilCheck::Command { label, argv, timeout_s } if !consented.iter().any(|command| command.step_id == step.id
                && &command.argv == argv && command.timeout_s == *timeout_s) => Some((step.id.clone(), index,
                SigilCommand { step_id: step.id.clone(), label: label.clone(), argv: argv.clone(), timeout_s: *timeout_s })),
            _ => None,
        })
    }).collect()
}

/// The combined light shown for a step.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum StepLight {
    Pending,
    Ready,
    Running,
    Verifying,
    Passed,
    DoneUnverified,
    Failed,
    NeedsYou,
    Skipped,
}

fn progress<'a>(run: Option<&'a SigilRun>, step: &SigilStep) -> Option<&'a StepProgress> {
    run.and_then(|run| run.steps.get(&step.id))
}

/// The checks of the step's latest report, unless a newer attempt has started since.
pub fn current_checks(progress: &StepProgress) -> impl Iterator<Item = &CheckResult> {
    progress.checks.iter().filter(move |check| check.attempt == progress.attempt)
}

/// Verification of a reported step: a failure wins, then anything waiting for the user; the
/// step passes when every check of its latest attempt passed.
pub fn verification(step: &SigilStep, progress: &StepProgress) -> Verification {
    if step.checks.is_empty() || progress.status != StepStatus::Reported {
        return Verification::None;
    }
    let checks: Vec<&CheckResult> = current_checks(progress).collect();
    if checks.iter().any(|check| check.status == CheckStatus::Failed) {
        Verification::Failed
    } else if checks.iter().any(|check| matches!(check.status, CheckStatus::Waiting | CheckStatus::NeedsApproval)) {
        Verification::NeedsYou
    } else if checks.len() == step.checks.len() && checks.iter().all(|check| check.status == CheckStatus::Passed) {
        Verification::Passed
    } else {
        Verification::Running
    }
}

/// Finished steps satisfy their dependents. A step with checks finishes only when verified.
pub fn step_finished(step: &SigilStep, run: Option<&SigilRun>) -> bool {
    match progress(run, step) {
        Some(progress) if progress.status == StepStatus::Skipped => true,
        Some(progress) if progress.status == StepStatus::Reported => {
            step.checks.is_empty() || verification(step, progress) == Verification::Passed
        }
        _ => false,
    }
}

pub fn dependencies_finished(plan: &SigilPlan, run: Option<&SigilRun>, step: &SigilStep) -> bool {
    step.depends_on.iter().all(|dependency| {
        plan.steps.iter().find(|candidate| &candidate.id == dependency).is_some_and(|candidate| step_finished(candidate, run))
    })
}

pub fn step_light(plan: &SigilPlan, run: Option<&SigilRun>, step: &SigilStep) -> StepLight {
    let unstarted = StepProgress::default();
    let progress = progress(run, step).unwrap_or(&unstarted);
    match progress.status {
        StepStatus::Active => StepLight::Running,
        StepStatus::Blocked => StepLight::NeedsYou,
        StepStatus::Skipped => StepLight::Skipped,
        StepStatus::Reported if step.checks.is_empty() => StepLight::DoneUnverified,
        StepStatus::Reported => match verification(step, progress) {
            Verification::Passed => StepLight::Passed,
            Verification::Failed => StepLight::Failed,
            Verification::NeedsYou => StepLight::NeedsYou,
            Verification::Running | Verification::None => StepLight::Verifying,
        },
        StepStatus::Pending if dependencies_finished(plan, run, step) => StepLight::Ready,
        StepStatus::Pending => StepLight::Pending,
    }
}

/// What the executor should do now: the active step, else the first step whose verification
/// failed (to fix it in a new attempt), else the first ready step, in plan order.
pub fn next_step<'a>(plan: &'a SigilPlan, run: &SigilRun) -> Option<&'a SigilStep> {
    let status = |step: &SigilStep| run.steps.get(&step.id).map(|progress| progress.status).unwrap_or_default();
    plan.steps.iter().find(|step| status(step) == StepStatus::Active)
        .or_else(|| plan.steps.iter().find(|step| run.steps.get(&step.id).is_some_and(|progress| verification(step, progress) == Verification::Failed)))
        .or_else(|| plan.steps.iter().find(|step| status(step) == StepStatus::Pending && dependencies_finished(plan, Some(run), step)))
}

/// The step whose change window is open: the active one, else the most recently started blocked
/// one. Observed edits belong to it; with none open they happened outside any step.
pub fn open_step(run: &SigilRun) -> Option<&str> {
    let open = |status: StepStatus| run.steps.iter().filter(move |(_, progress)| progress.status == status && !progress.start_tree.is_empty());
    open(StepStatus::Active).map(|(id, _)| id.as_str()).next()
        .or_else(|| open(StepStatus::Blocked).max_by_key(|(_, progress)| progress.started_at_ms).map(|(id, _)| id.as_str()))
}

pub fn all_finished(plan: &SigilPlan, run: &SigilRun) -> bool {
    plan.steps.iter().all(|step| step_finished(step, Some(run)))
}

/// Event kinds an executor learns about through `notices` and `wait`.
pub fn is_notice(kind: &str) -> bool {
    matches!(kind, "handover_approved" | "executor_revoked" | "paused" | "resumed" | "aborted" | "completed" | "user_note"
        | "check_finished" | "check_decided" | "step_verified" | "command_approved" | "amendment_reverted" | "step_reopened")
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, JsonSchema)]
pub struct SigilSummary {
    pub id: String,
    pub title: String,
    pub state: SigilState,
    pub revision: u64,
    pub steps: usize,
    pub owner_source: String,
    pub updated_at_ms: u64,
}

impl From<&Sigil> for SigilSummary {
    fn from(sigil: &Sigil) -> Self {
        Self {
            id: sigil.id.clone(),
            title: sigil.plan.title.clone(),
            state: sigil.state,
            revision: sigil.revision,
            steps: sigil.plan.steps.len(),
            owner_source: sigil.owner_source.clone(),
            updated_at_ms: sigil.updated_at_ms,
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum IssueLevel {
    /// Blocks freezing.
    Error,
    /// Shown in the freeze dialog; does not block.
    Warning,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, JsonSchema)]
pub struct SigilIssue {
    pub level: IssueLevel,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub step_id: Option<String>,
    pub code: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, JsonSchema)]
pub struct SigilReview {
    pub can_freeze: bool,
    pub issues: Vec<SigilIssue>,
    /// Every command Spellcast would run, in plan order.
    pub commands: Vec<SigilCommand>,
    pub location: SigilLocation,
    pub execution_directory: String,
}

fn short_id(label: &str, id: &str) -> Result<(), String> {
    let valid = !id.is_empty()
        && id.len() <= MAX_SHORT_ID
        && id.bytes().all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
        && !id.starts_with('-')
        && !id.ends_with('-');
    if valid {
        Ok(())
    } else {
        Err(format!("{label}需要是 1–40 个小写字母、数字或短横线，且不以短横线开头或结尾：{id}"))
    }
}

pub fn validate_sigil_id(id: &str) -> Result<(), String> {
    short_id("法阵 id", id)
}

fn text(label: &str, value: &str, max_chars: usize) -> Result<(), String> {
    if value.chars().count() > max_chars {
        return Err(format!("{label}最多 {max_chars} 字。"));
    }
    if value.chars().any(|ch| ch.is_control() && !matches!(ch, '\n' | '\r' | '\t')) {
        return Err(format!("{label}不能包含控制字符。"));
    }
    Ok(())
}

fn line(label: &str, value: &str, max_chars: usize) -> Result<(), String> {
    if value.chars().count() > max_chars || value.chars().any(char::is_control) {
        return Err(format!("{label}需要是一行，最多 {max_chars} 字。"));
    }
    Ok(())
}

fn at_most(label: &str, len: usize, max: usize) -> Result<(), String> {
    if len > max {
        Err(format!("{label}最多 {max} 项。"))
    } else {
        Ok(())
    }
}

fn has_drive(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() >= 2 && bytes[1] == b':' && bytes[0].is_ascii_alphabetic()
}

pub(crate) fn relative_path(label: &str, value: &str) -> Result<(), String> {
    let valid = !value.is_empty()
        && value.chars().count() <= 512
        && !value.chars().any(char::is_control)
        && !value.contains('\\')
        && !value.starts_with('/')
        && !has_drive(value)
        && value.split('/').all(|part| !part.is_empty() && part != "." && part != "..");
    if valid {
        Ok(())
    } else {
        Err(format!("{label}需要是仓库内的相对路径，用 / 分隔，不含 . 或 ..：{value}"))
    }
}

/// Write-time bounds. Gaps that only matter for running are reported by [`review`] instead,
/// so an incomplete draft can still be saved.
pub fn validate_plan(plan: &SigilPlan) -> Result<(), String> {
    line("标题", &plan.title, 160)?;
    text("目标", &plan.goal, 8_000)?;
    line("仓库路径", &plan.repository, 1_024)?;
    line("基线分支", &plan.base_ref, 200)?;
    if plan.base_ref.chars().any(char::is_whitespace) {
        return Err("基线分支不能包含空白。".into());
    }
    line("worktree 路径", &plan.worktree_path, 1_024)?;
    at_most("素材", plan.materials.len(), 64)?;
    for material in &plan.materials {
        spellcast_core::reply::validate_id(&material.object_id).map_err(|error| error.to_string())?;
    }
    at_most("待定问题", plan.open_questions.len(), 32)?;
    for question in &plan.open_questions {
        text("待定问题", question, 1_000)?;
    }
    at_most("步骤", plan.steps.len(), MAX_STEPS)?;
    let mut ids = BTreeSet::new();
    for step in &plan.steps {
        short_id("步骤 id", &step.id)?;
        if !ids.insert(step.id.as_str()) {
            return Err(format!("步骤 id {} 重复。", step.id));
        }
        if step.title.trim().is_empty() {
            return Err(format!("步骤 {} 需要标题。", step.id));
        }
        line("步骤标题", &step.title, 160)?;
        text("步骤说明", &step.instructions, 16_000)?;
        at_most("依据文件", step.inputs.len(), 64)?;
        for input in &step.inputs {
            relative_path("依据文件", input)?;
        }
        at_most("改动范围", step.scope.len(), 32)?;
        for glob in &step.scope {
            line("改动范围", glob, 512)?;
        }
        at_most("验证", step.checks.len(), 16)?;
        for check in &step.checks {
            match check {
                SigilCheck::Command { label, argv, .. } => {
                    line("验证名称", label, 160)?;
                    at_most("命令参数", argv.len(), 64)?;
                    if argv.iter().any(|arg| arg.chars().count() > 2_000 || arg.contains('\0')) {
                        return Err("命令参数最多 2000 字，且不能包含空字符。".into());
                    }
                }
                SigilCheck::Manual { label, description } => {
                    line("验证名称", label, 160)?;
                    text("人工检查说明", description, 4_000)?;
                }
            }
        }
        at_most("依赖", step.depends_on.len(), MAX_STEPS)?;
        for dependency in &step.depends_on {
            short_id("依赖步骤 id", dependency)?;
        }
        at_most("停下条件", step.stop_when.len(), 16)?;
        for condition in &step.stop_when {
            text("停下条件", condition, 500)?;
        }
    }
    Ok(())
}

/// `*` and `?` stay within a path segment, `**` is a whole segment and `[...]` is a character
/// class (`[!...]` negates). Brace alternation is not supported.
pub fn validate_glob(pattern: &str) -> Result<(), String> {
    let invalid = |reason: &str| Err(format!("改动范围 {pattern} 无效：{reason}"));
    if pattern.is_empty() || pattern.contains('\\') || pattern.starts_with('/') || has_drive(pattern) {
        return invalid("需要是仓库内的相对路径，用 / 分隔");
    }
    if pattern.contains(['{', '}']) {
        return invalid("暂不支持 {a,b}，请拆成多条");
    }
    for segment in pattern.split('/') {
        if segment.is_empty() || segment == "." || segment == ".." {
            return invalid("不能有空段、. 或 ..");
        }
        if segment.contains("**") && segment != "**" {
            return invalid("** 必须单独占一段");
        }
        let mut chars = segment.chars().peekable();
        while let Some(ch) = chars.next() {
            if ch == ']' {
                return invalid("多余的 ]");
            }
            if ch == '[' {
                if chars.peek() == Some(&'!') {
                    chars.next();
                }
                let mut members = 0;
                loop {
                    match chars.next() {
                        Some(']') if members > 0 => break,
                        Some(_) => members += 1,
                        None => return invalid("[ 没有闭合"),
                    }
                }
            }
        }
    }
    Ok(())
}

/// Whether a scope pattern accepted by [`validate_glob`] covers a repository path. A pattern
/// matching one of the path's directories covers everything inside it. Case-insensitive on
/// Windows, as Git is there.
pub fn glob_matches(pattern: &str, path: &str) -> bool {
    let (pattern, path) = if cfg!(windows) { (pattern.to_lowercase(), path.to_lowercase()) } else { (pattern.to_string(), path.to_string()) };
    let pattern: Vec<&str> = pattern.split('/').collect();
    let path: Vec<&str> = path.split('/').collect();
    (1..=path.len()).any(|end| segments_match(&pattern, &path[..end]))
}

fn segments_match(pattern: &[&str], path: &[&str]) -> bool {
    match pattern.split_first() {
        None => path.is_empty(),
        Some((&"**", rest)) => (0..=path.len()).any(|skip| segments_match(rest, &path[skip..])),
        Some((segment, rest)) => path.split_first().is_some_and(|(first, tail)| {
            let (segment, first): (Vec<char>, Vec<char>) = (segment.chars().collect(), first.chars().collect());
            chars_match(&segment, &first) && segments_match(rest, tail)
        }),
    }
}

fn chars_match(pattern: &[char], text: &[char]) -> bool {
    match pattern.first() {
        None => text.is_empty(),
        Some('*') => (0..=text.len()).any(|skip| chars_match(&pattern[1..], &text[skip..])),
        Some('?') => !text.is_empty() && chars_match(&pattern[1..], &text[1..]),
        Some('[') => {
            let Some((&ch, rest)) = text.split_first() else { return false };
            let negate = pattern.get(1) == Some(&'!');
            let mut index = if negate { 2 } else { 1 };
            let (mut matched, mut first) = (false, true);
            loop {
                let Some(&member) = pattern.get(index) else { return false };
                if member == ']' && !first {
                    break;
                }
                first = false;
                match (pattern.get(index + 1), pattern.get(index + 2)) {
                    (Some('-'), Some(&end)) if end != ']' => {
                        matched |= member <= ch && ch <= end;
                        index += 3;
                    }
                    _ => {
                        matched |= member == ch;
                        index += 1;
                    }
                }
            }
            matched != negate && chars_match(&pattern[index + 1..], rest)
        }
        Some(&literal) => text.first() == Some(&literal) && chars_match(&pattern[1..], &text[1..]),
    }
}

/// Whether a path lies in a step's declared scope. A step without scope gets no scope markers.
pub fn in_scope(step: &SigilStep, path: &str) -> bool {
    step.scope.is_empty() || step.scope.iter().any(|pattern| glob_matches(pattern, path))
}

fn path_key(path: &Path) -> String {
    let value = path.to_string_lossy().replace('\\', "/");
    let value = value.trim_end_matches('/').to_string();
    if cfg!(windows) {
        value.to_lowercase()
    } else {
        value
    }
}

fn same_or_inside(path: &Path, base: &Path) -> bool {
    let (path, base) = (path_key(path), path_key(base));
    path == base || path.starts_with(&format!("{base}/"))
}

/// The directory the run uses: the worktree path, or the repository when running in place.
pub fn execution_directory(id: &str, plan: &SigilPlan) -> String {
    match plan.location {
        SigilLocation::InPlace => plan.repository.clone(),
        SigilLocation::Worktree if !plan.worktree_path.trim().is_empty() => plan.worktree_path.clone(),
        SigilLocation::Worktree => {
            let repository = Path::new(&plan.repository);
            let name = repository.file_name().map(|name| name.to_string_lossy().to_string()).unwrap_or_else(|| "repository".into());
            let parent = repository.parent().map(Path::to_path_buf).unwrap_or_else(|| PathBuf::from(&plan.repository));
            parent.join(format!("{name}.sigils")).join(id).to_string_lossy().to_string()
        }
    }
}

pub fn commands(plan: &SigilPlan) -> Vec<SigilCommand> {
    plan.steps
        .iter()
        .flat_map(|step| {
            step.checks.iter().filter_map(move |check| match check {
                SigilCheck::Command { label, argv, timeout_s } => Some(SigilCommand {
                    step_id: step.id.clone(),
                    label: label.clone(),
                    argv: argv.clone(),
                    timeout_s: *timeout_s,
                }),
                SigilCheck::Manual { .. } => None,
            })
        })
        .collect()
}

fn issue(level: IssueLevel, step_id: Option<&str>, code: &str, message: impl Into<String>) -> SigilIssue {
    SigilIssue { level, step_id: step_id.map(str::to_string), code: code.into(), message: message.into() }
}

fn has_lfs(repository: &Path) -> bool {
    let path = repository.join(".gitattributes");
    std::fs::metadata(&path).is_ok_and(|meta| meta.len() <= 1024 * 1024)
        && std::fs::read_to_string(path).is_ok_and(|text| text.contains("filter=lfs"))
}

fn first_cycle(plan: &SigilPlan) -> Option<String> {
    let known: BTreeSet<&str> = plan.steps.iter().map(|step| step.id.as_str()).collect();
    let mut done = BTreeSet::new();
    for start in &plan.steps {
        let mut visiting = BTreeSet::new();
        if visit(plan, &known, start.id.as_str(), &mut visiting, &mut done) {
            return Some(start.id.clone());
        }
    }
    None
}

fn visit<'a>(plan: &'a SigilPlan, known: &BTreeSet<&'a str>, id: &'a str, visiting: &mut BTreeSet<&'a str>, done: &mut BTreeSet<&'a str>) -> bool {
    if done.contains(id) {
        return false;
    }
    if !visiting.insert(id) {
        return true;
    }
    let Some(step) = plan.steps.iter().find(|step| step.id == id) else { return false };
    for dependency in &step.depends_on {
        if known.contains(dependency.as_str()) && visit(plan, known, dependency, visiting, done) {
            return true;
        }
    }
    visiting.remove(id);
    done.insert(id);
    false
}

/// What makes steps impossible to run: freezing and amendments both refuse these.
fn step_errors(plan: &SigilPlan, issues: &mut Vec<SigilIssue>) {
    use IssueLevel::Error;
    if plan.steps.is_empty() {
        issues.push(issue(Error, None, "no_steps", "至少需要一个步骤。"));
    }
    if plan.steps.len() > MAX_STEPS {
        issues.push(issue(Error, None, "too_many_steps", format!("最多 {MAX_STEPS} 个步骤。")));
    }
    let mut seen = BTreeSet::new();
    for step in &plan.steps {
        if !seen.insert(step.id.as_str()) {
            issues.push(issue(Error, Some(&step.id), "duplicate_step", format!("步骤 id {} 重复。", step.id)));
        }
    }
    for step in &plan.steps {
        let at = Some(step.id.as_str());
        for dependency in &step.depends_on {
            if dependency == &step.id {
                issues.push(issue(Error, at, "self_dependency", "步骤不能依赖自己。"));
            } else if !seen.contains(dependency.as_str()) {
                issues.push(issue(Error, at, "missing_dependency", format!("依赖的步骤 {dependency} 不存在。")));
            }
        }
        for check in &step.checks {
            if let SigilCheck::Command { label, argv, timeout_s } = check {
                if argv.first().is_none_or(|program| program.trim().is_empty()) {
                    issues.push(issue(Error, at, "command_empty", format!("验证「{label}」没有要运行的程序。")));
                }
                if *timeout_s == 0 || *timeout_s > MAX_TIMEOUT_S {
                    issues.push(issue(Error, at, "timeout_range", format!("验证「{label}」的超时需要在 1–{MAX_TIMEOUT_S} 秒之间。")));
                }
            }
        }
        for glob in &step.scope {
            if let Err(message) = validate_glob(glob) {
                issues.push(issue(Error, at, "scope_invalid", message));
            }
        }
    }
    if let Some(step) = first_cycle(plan) {
        issues.push(issue(Error, Some(&step), "dependency_cycle", "步骤依赖形成了环。"));
    }
}

/// Why amended steps could not run, as one message; none when they can.
pub fn amendment_error(plan: &SigilPlan) -> Option<String> {
    let mut issues = Vec::new();
    step_errors(plan, &mut issues);
    let messages: Vec<String> = issues.into_iter()
        .map(|issue| issue.step_id.map_or(issue.message.clone(), |step| format!("{step}：{}", issue.message))).collect();
    (!messages.is_empty()).then(|| messages.join(" "))
}

/// Freeze review. Errors are what Spellcast cannot run safely or correctly; everything else is a
/// warning the user may accept.
pub fn review(id: &str, plan: &SigilPlan) -> SigilReview {
    use IssueLevel::{Error, Warning};
    let mut issues = Vec::new();
    let repository = Path::new(&plan.repository);
    let repository_ok = repository.is_absolute() && repository.is_dir() && repository.join(".git").exists();
    if plan.title.trim().is_empty() {
        issues.push(issue(Error, None, "title_empty", "需要标题。"));
    }
    if !repository_ok {
        issues.push(issue(Error, None, "repository_invalid", "仓库需要是已存在的 git 工作区根目录（含 .git）。"));
    }
    step_errors(plan, &mut issues);
    let directory = execution_directory(id, plan);
    if plan.location == SigilLocation::Worktree {
        let path = Path::new(&directory);
        if !path.is_absolute() {
            issues.push(issue(Error, None, "worktree_path_invalid", "worktree 路径需要是绝对路径。"));
        } else if repository_ok && same_or_inside(path, repository) {
            issues.push(issue(Error, None, "worktree_inside_repository", "worktree 不能放在仓库目录里面。"));
        } else if path.exists() {
            issues.push(issue(Error, None, "worktree_exists", format!("worktree 路径已存在：{directory}")));
        }
    }
    if plan.goal.trim().is_empty() {
        issues.push(issue(Warning, None, "goal_empty", "没有写目标。"));
    }
    if !plan.open_questions.is_empty() {
        issues.push(issue(Warning, None, "open_questions", format!("还有 {} 个待定问题。", plan.open_questions.len())));
    }
    if plan.steps.len() == 1 {
        issues.push(issue(Warning, None, "single_step", "只有一个步骤；通常 3–10 步更容易跟踪。"));
    }
    for step in &plan.steps {
        let at = Some(step.id.as_str());
        if step.checks.is_empty() {
            issues.push(issue(Warning, at, "no_checks", "没有验证；报告完成后会显示为“已完成（未验证）”。"));
        }
        if step.scope.is_empty() {
            issues.push(issue(Warning, at, "no_scope", "没有声明改动范围；不会出现范围外改动提醒。"));
        }
        if repository_ok {
            for input in &step.inputs {
                if !repository.join(input).is_file() {
                    issues.push(issue(Warning, at, "input_missing", format!("依据文件不存在：{input}")));
                }
            }
        }
    }
    if plan.location == SigilLocation::Worktree && repository_ok {
        if has_lfs(repository) {
            issues.push(issue(Warning, None, "lfs_worktree", "仓库使用 Git LFS；新建 worktree 会重新写出所有 LFS 文件，建议原地执行。"));
        }
        if repository.join("ProjectSettings").join("ProjectVersion.txt").is_file() {
            issues.push(issue(Warning, None, "unity_worktree", "这是 Unity 项目；新 worktree 需要重新导入全部资源并单独打开编辑器，建议原地执行。"));
        }
    }
    let can_freeze = !issues.iter().any(|issue| issue.level == Error);
    SigilReview { can_freeze, issues, commands: commands(plan), location: plan.location, execution_directory: directory }
}

pub(crate) fn file_sha256(path: &Path) -> std::io::Result<String> {
    let mut file = std::fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0_u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

/// The record kept at freeze. Missing inputs are omitted; the review already warned about them.
pub fn freeze_record(id: &str, plan: &SigilPlan, revision: u64, at_ms: u64) -> SigilFreeze {
    let repository = Path::new(&plan.repository);
    let mut input_hashes = BTreeMap::new();
    for input in plan.steps.iter().flat_map(|step| step.inputs.iter()) {
        if let Ok(hash) = file_sha256(&repository.join(input)) {
            input_hashes.insert(input.clone(), hash);
        }
    }
    SigilFreeze { at_ms, revision, input_hashes, commands: commands(plan), execution_directory: execution_directory(id, plan) }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn step(id: &str, depends_on: &[&str]) -> SigilStep {
        SigilStep {
            id: id.into(),
            title: format!("Step {id}"),
            instructions: String::new(),
            inputs: vec![],
            scope: vec!["src/**".into()],
            checks: vec![SigilCheck::Command { label: "test".into(), argv: vec!["cargo".into(), "test".into()], timeout_s: 600 }],
            depends_on: depends_on.iter().map(|id| id.to_string()).collect(),
            stop_when: vec![],
        }
    }

    fn repository() -> PathBuf {
        let root = std::env::temp_dir().join(format!("spellcast-sigil-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(root.join(".git")).unwrap();
        std::fs::create_dir_all(root.join("src")).unwrap();
        std::fs::write(root.join("src/lib.rs"), "fn main() {}\n").unwrap();
        root
    }

    fn plan(root: &Path, steps: Vec<SigilStep>) -> SigilPlan {
        SigilPlan { title: "Build".into(), goal: "Ship".into(), repository: root.to_string_lossy().into(), steps, ..Default::default() }
    }

    fn codes(review: &SigilReview, level: IssueLevel) -> Vec<String> {
        review.issues.iter().filter(|issue| issue.level == level).map(|issue| issue.code.clone()).collect()
    }

    #[test]
    fn globs_accept_segment_wildcards_and_reject_escapes() {
        for good in ["src/**", "**/*.rs", "docs/sigil-*.md", "a/[!x]?/b", "a/[]]"] {
            assert!(validate_glob(good).is_ok(), "{good}");
        }
        for bad in ["", "/abs", "C:/x", "a\\b", "a/../b", "a//b", "a**/b", "x/{a,b}", "a/[b", "a/b]"] {
            assert!(validate_glob(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn scope_globs_cover_matching_paths_and_their_directories() {
        let covers = |pattern: &str, path: &str| glob_matches(pattern, path);
        assert!(covers("src/**", "src/a/b.rs") && covers("src/**", "src/lib.rs"));
        assert!(covers("src", "src/lib.rs"), "a directory pattern covers its contents");
        assert!(covers("**/*.rs", "lib.rs") && covers("**/*.rs", "a/b/c.rs"));
        assert!(covers("docs/sigil-*.md", "docs/sigil-phase1.md") && !covers("docs/sigil-*.md", "docs/other.md"));
        assert!(covers("a/?.txt", "a/x.txt") && !covers("a/?.txt", "a/xy.txt"));
        assert!(covers("v[0-9]/x", "v7/x") && !covers("v[0-9]/x", "vx/x") && covers("v[!0-9]/x", "vx/x"));
        assert!(covers("a/[]]", "a/]"));
        assert!(!covers("*.rs", "src/lib.rs"), "* stays within one segment");
        assert!(!covers("src/**", "srcx/lib.rs") && !covers("src/a.rs", "src/a.rsx"));
        assert_eq!(covers("SRC/**", "src/lib.rs"), cfg!(windows));
        let step = SigilStep { scope: vec![], ..step("a", &[]) };
        assert!(in_scope(&step, "anything/at/all"), "no declared scope means no scope markers");
    }

    #[test]
    fn write_bounds_reject_bad_ids_and_paths_but_keep_incomplete_drafts() {
        assert!(validate_plan(&SigilPlan::default()).is_ok());
        assert!(validate_sigil_id("build-1").is_ok());
        let long = "x".repeat(41);
        for bad in ["", "Build", "-a", "a-", "a_b", long.as_str()] {
            assert!(validate_sigil_id(bad).is_err(), "{bad}");
        }
        let mut duplicate = SigilPlan { steps: vec![step("a", &[]), step("a", &[])], ..Default::default() };
        assert!(validate_plan(&duplicate).unwrap_err().contains("重复"));
        duplicate.steps.pop();
        duplicate.steps[0].inputs = vec!["../secret".into()];
        assert!(validate_plan(&duplicate).is_err());
        duplicate.steps[0].inputs = vec!["src/lib.rs".into()];
        assert!(validate_plan(&duplicate).is_ok());
    }

    #[test]
    fn review_blocks_only_what_cannot_run_and_warns_about_the_rest() {
        let root = repository();
        let clean = review("build", &plan(&root, vec![step("a", &[]), step("b", &["a"]), step("c", &["b"])]));
        assert!(clean.can_freeze, "{:?}", clean.issues);
        assert_eq!(clean.commands.len(), 3);
        assert!(clean.execution_directory.ends_with("build"));

        let mut light = plan(&root, vec![step("a", &[])]);
        light.goal.clear();
        light.open_questions = vec!["Which API?".into()];
        light.steps[0].checks.clear();
        light.steps[0].scope.clear();
        light.steps[0].inputs = vec!["missing.txt".into()];
        let warned = review("light", &light);
        assert!(warned.can_freeze);
        assert_eq!(codes(&warned, IssueLevel::Warning), ["goal_empty", "open_questions", "single_step", "no_checks", "no_scope", "input_missing"]);

        let mut broken = plan(&root, vec![step("a", &["c"]), step("b", &["a", "zz"]), step("c", &["b"])]);
        broken.title.clear();
        broken.steps[0].checks = vec![SigilCheck::Command { label: "empty".into(), argv: vec![" ".into()], timeout_s: 0 }];
        broken.steps[1].scope = vec!["../outside".into()];
        let blocked = review("broken", &broken);
        assert!(!blocked.can_freeze);
        for code in ["title_empty", "missing_dependency", "command_empty", "timeout_range", "scope_invalid", "dependency_cycle"] {
            assert!(codes(&blocked, IssueLevel::Error).iter().any(|found| found == code), "{code}: {:?}", blocked.issues);
        }
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn review_checks_repository_and_worktree_location() {
        let root = repository();
        let mut inside = plan(&root, vec![step("a", &[])]);
        inside.worktree_path = root.join("nested").to_string_lossy().into();
        assert_eq!(codes(&review("x", &inside), IssueLevel::Error), ["worktree_inside_repository"]);
        inside.location = SigilLocation::InPlace;
        assert!(review("x", &inside).can_freeze);
        assert_eq!(review("x", &inside).execution_directory, inside.repository);

        std::fs::write(root.join(".gitattributes"), "*.png filter=lfs diff=lfs merge=lfs -text\n").unwrap();
        std::fs::create_dir_all(root.join("ProjectSettings")).unwrap();
        std::fs::write(root.join("ProjectSettings/ProjectVersion.txt"), "m_EditorVersion: 6000.0.0f1\n").unwrap();
        let unity = review("y", &plan(&root, vec![step("a", &[])]));
        assert!(unity.can_freeze);
        assert!(codes(&unity, IssueLevel::Warning).iter().any(|code| code == "lfs_worktree"));
        assert!(codes(&unity, IssueLevel::Warning).iter().any(|code| code == "unity_worktree"));

        let missing = SigilPlan { repository: root.join("absent").to_string_lossy().into(), ..plan(&root, vec![step("a", &[])]) };
        assert!(codes(&review("z", &missing), IssueLevel::Error).iter().any(|code| code == "repository_invalid"));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn freeze_records_existing_input_hashes_and_consented_commands() {
        let root = repository();
        let mut frozen = plan(&root, vec![step("a", &[])]);
        frozen.steps[0].inputs = vec!["src/lib.rs".into(), "missing.txt".into()];
        let record = freeze_record("build", &frozen, 3, 42);
        assert_eq!(record.revision, 3);
        assert_eq!(record.input_hashes.len(), 1);
        assert_eq!(record.input_hashes["src/lib.rs"].len(), 64);
        assert_eq!(record.commands[0].argv, ["cargo", "test"]);
        let _ = std::fs::remove_dir_all(root);
    }
}

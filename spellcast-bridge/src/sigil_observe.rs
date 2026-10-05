//! Live observation of a running sigil. Spellcast snapshots the execution directory when the run
//! starts, at every step start and report, and on an interval in between (2 s while a step runs,
//! else 10 s). Changes go to the step whose window is open, or are listed as outside any step.
//! Deviations become markers, which never stop the run. Contract: docs/sigil-phase1-contract.md,
//! Observation.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::Duration;

use serde_json::{json, Value};
use spellcast_core::{inbox::now_ms, SpellcastError};

use crate::sigil_run::{apply_agent, AgentRunOp, SIGIL_CHANGED};
use crate::sigil_snapshot::{Session, Snapshot, MAX_NEW_FILE_BYTES, MAX_PATCH_BYTES, MAX_PRIVATE_BYTES};
use crate::sigil_store::{Applied, Events};
use crate::sigils::{file_sha256, in_scope, open_step, relative_path, validate_sigil_id, ChangedPath, LargeFile, OutsideChanges, Sigil,
    SigilObservation, SigilState, SigilStep, StepMarker, StepProgress, StepStatus};
use crate::Bridge;

pub const STEP_INTERVAL: Duration = Duration::from_secs(2);
pub const IDLE_INTERVAL: Duration = Duration::from_secs(10);
/// How often the interval loop looks again while a slow snapshot is still running.
const BUSY_POLL: Duration = Duration::from_millis(500);
const MAX_LISTED: usize = 500;
const MAX_DELTA: usize = 50;
const MAX_OUTSIDE: usize = 50;
const MAX_DETAIL: usize = 12;

fn fail(error: impl ToString) -> SpellcastError {
    SpellcastError::user(error.to_string())
}

/// Interval bookkeeping for one observed run, keyed by its private directory so bridges that
/// share a process (as tests do) never mix.
#[derive(Default)]
struct Slot {
    /// Held for the whole of every snapshot of the run, so snapshots never overlap.
    lock: Arc<tokio::sync::Mutex<()>>,
    next_at: Option<tokio::time::Instant>,
    busy: bool,
    last_at_ms: u64,
    duration_ms: u64,
    interval_ms: u64,
    error: String,
}

static SLOTS: LazyLock<Mutex<HashMap<PathBuf, Slot>>> = LazyLock::new(Default::default);
/// Sigil roots that have an interval loop: one per database.
static LOOPS: LazyLock<Mutex<HashSet<PathBuf>>> = LazyLock::new(Default::default);

fn slot_lock(dir: &Path) -> Arc<tokio::sync::Mutex<()>> {
    SLOTS.lock().unwrap().entry(dir.to_path_buf()).or_default().lock.clone()
}

/// Records a snapshot's timing. Returns whether `error` differs from the previous one.
fn touch_slot(dir: &Path, duration: Duration, error: Option<&String>) -> bool {
    let mut slots = SLOTS.lock().unwrap();
    let slot = slots.entry(dir.to_path_buf()).or_default();
    slot.last_at_ms = now_ms();
    slot.duration_ms = duration.as_millis() as u64;
    let error = error.cloned().unwrap_or_default();
    let new = !error.is_empty() && slot.error != error;
    slot.error = error;
    new
}

/// One snapshot and the changes it shows, computed before the transaction that records them.
pub(crate) struct Observed {
    pub snapshot: Snapshot,
    /// The step whose window was open, or none for edits outside any step.
    pub owner: Option<String>,
    /// Where the window diff starts: the owner's start, else the latest step boundary.
    pub from_tree: String,
    pub window: Vec<ChangedPath>,
    /// Paths changed since the previous snapshot.
    pub delta: Vec<ChangedPath>,
    pub private_bytes: u64,
}

fn unchanged(observation: &SigilObservation, snapshot: &Snapshot) -> bool {
    snapshot.tree == observation.tree && snapshot.large == observation.large && snapshot.partial == observation.partial
}

/// Takes a snapshot and diffs it against the open window; diffs are skipped when nothing
/// changed. `None` when the run has no observation or it stopped.
async fn observe(dir: &Path, sigil: &Sigil) -> Result<Option<Observed>, String> {
    let Some(run) = sigil.run.as_ref() else { return Ok(None) };
    let Some(observation) = run.observation.as_ref().filter(|observation| observation.stopped.is_empty()) else { return Ok(None) };
    let session = Session::open(dir)?;
    let snapshot = session.take(MAX_NEW_FILE_BYTES).await?;
    let owner = open_step(run).map(str::to_string);
    let from_tree = owner.as_ref().and_then(|id| run.steps.get(id))
        .map_or_else(|| observation.boundary_tree.clone(), |progress| progress.start_tree.clone());
    let mut observed = Observed { snapshot, owner, from_tree, window: vec![], delta: vec![], private_bytes: observation.private_bytes };
    if !unchanged(observation, &observed.snapshot) {
        observed.window = session.diff(&observed.from_tree, &observed.snapshot.tree, true).await?;
        observed.delta = session.diff(&observation.tree, &observed.snapshot.tree, false).await?;
        observed.private_bytes = session.private_bytes();
    }
    Ok(Some(observed))
}

/// A window's change list: git's changes plus large untracked files (listed by size), flagged
/// against the step's declared scope.
struct Window {
    files: Vec<ChangedPath>,
    total: usize,
    out_of_scope: Vec<String>,
    added: u64,
    deleted: u64,
}

fn window(step: Option<&SigilStep>, changes: &[ChangedPath], start_large: &BTreeMap<String, LargeFile>, large: &BTreeMap<String, LargeFile>) -> Window {
    let mut files = changes.to_vec();
    for (path, file) in large {
        let before = start_large.get(path);
        if before != Some(file) {
            files.push(ChangedPath { path: path.clone(), status: if before.is_some() { "M" } else { "A" }.into(), size: Some(file.size), ..Default::default() });
        }
    }
    for (path, file) in start_large {
        if !large.contains_key(path) {
            files.push(ChangedPath { path: path.clone(), status: "D".into(), size: Some(file.size), ..Default::default() });
        }
    }
    let mut out_of_scope = vec![];
    if let Some(step) = step.filter(|step| !step.scope.is_empty()) {
        for file in &mut files {
            file.out_of_scope = !in_scope(step, &file.path);
            if file.out_of_scope {
                out_of_scope.push(file.path.clone());
            }
        }
    }
    files.sort_by(|a, b| a.path.cmp(&b.path));
    let (added, deleted) = files.iter().fold((0, 0), |(added, deleted), file| (added + file.added.unwrap_or(0), deleted + file.deleted.unwrap_or(0)));
    let total = files.len();
    files.truncate(MAX_LISTED);
    Window { files, total, out_of_scope, added, deleted }
}

pub(crate) fn paths_detail(paths: &[String]) -> String {
    let mut detail = paths.iter().take(MAX_DETAIL).cloned().collect::<Vec<_>>().join(", ");
    if paths.len() > MAX_DETAIL {
        detail.push_str(&format!(" +{}", paths.len() - MAX_DETAIL));
    }
    detail
}

/// Adds a marker once per kind; later observations only refresh its detail.
pub(crate) fn upsert_marker(progress: &mut StepProgress, kind: &str, now: u64, detail: String) {
    match progress.markers.iter_mut().find(|marker| marker.kind == kind) {
        Some(marker) => marker.detail = detail,
        None => progress.markers.push(StepMarker { kind: kind.into(), at_ms: now, detail }),
    }
}

/// Stores a step's change list and marks paths outside its scope. Returns paths newly outside.
fn record_window(progress: &mut StepProgress, window: Window, now: u64) -> Vec<String> {
    progress.changes = window.files;
    progress.changed_files = window.total;
    let mut newly = vec![];
    for path in window.out_of_scope {
        if !progress.outside_scope.contains(&path) && progress.outside_scope.len() < MAX_LISTED {
            progress.outside_scope.push(path.clone());
            newly.push(path);
        }
    }
    if !progress.outside_scope.is_empty() {
        upsert_marker(progress, "out_of_scope", now, paths_detail(&progress.outside_scope));
    }
    newly
}

/// Records one snapshot into the run. Returns false when it changed nothing, so an idle
/// interval writes nothing. A window that moved since the diff was computed is left for the
/// next snapshot.
pub(crate) fn apply_observed(sigil: &mut Sigil, observed: &Observed, now: u64, events: &mut Events, cap: u64) -> bool {
    let inputs: HashSet<&str> = sigil.plan.steps.iter().flat_map(|step| step.inputs.iter().map(String::as_str)).collect();
    let Some(run) = sigil.run.as_mut() else { return false };
    let open = open_step(run).map(str::to_string);
    let Some(observation) = run.observation.as_mut() else { return false };
    let snapshot = &observed.snapshot;
    if !observation.stopped.is_empty() || unchanged(observation, snapshot) {
        return false;
    }
    let delta: Vec<&str> = observed.delta.iter().take(MAX_DELTA).map(|change| change.path.as_str()).collect();
    if open == observed.owner {
        if let Some(owner) = &observed.owner {
            let step = sigil.plan.steps.iter().find(|step| &step.id == owner);
            if let (Some(step), Some(progress)) = (step, run.steps.get_mut(owner)) {
                if progress.start_tree == observed.from_tree {
                    let window = window(Some(step), &observed.window, &progress.start_large, &snapshot.large);
                    let (files, added, deleted) = (window.total, window.added, window.deleted);
                    let newly = record_window(progress, window, now);
                    for change in observed.window.iter().filter(|change| inputs.contains(change.path.as_str()) && in_scope(step, &change.path)) {
                        let writers = observation.input_writers.entry(change.path.clone()).or_default();
                        if !writers.contains(owner) {
                            writers.push(owner.clone());
                        }
                    }
                    if !snapshot.partial.is_empty() {
                        upsert_marker(progress, "partial_snapshot", now, paths_detail(&snapshot.partial));
                    }
                    events.push(("changes_observed".into(), json!({"step_id": owner, "tree": snapshot.tree, "files": files, "added": added,
                        "deleted": deleted, "delta": delta, "out_of_scope": newly})));
                }
            }
        } else if observation.boundary_tree == observed.from_tree {
            let window = window(None, &observed.window, &observation.boundary_large, &snapshot.large);
            let open_window = observation.outside.last().is_some_and(|last| last.from_tree == observed.from_tree);
            let files = window.total;
            if files == 0 {
                if open_window {
                    observation.outside.pop();
                }
            } else {
                if !open_window {
                    observation.outside.push(OutsideChanges { from_tree: observed.from_tree.clone(), first_at_ms: now, ..Default::default() });
                }
                let last = observation.outside.last_mut().expect("window present");
                last.to_tree = snapshot.tree.clone();
                last.last_at_ms = now;
                last.files = window.files;
                last.changed_files = files;
                if observation.outside.len() > MAX_OUTSIDE {
                    observation.outside.remove(0);
                }
            }
            events.push(("changes_outside_step".into(), json!({"tree": snapshot.tree, "files": files, "delta": delta})));
        }
    }
    if !snapshot.partial.is_empty() && snapshot.partial != observation.partial {
        events.push(("snapshot_partial".into(), json!({"step_id": observed.owner, "paths": snapshot.partial})));
    }
    observation.tree = snapshot.tree.clone();
    observation.large = snapshot.large.clone();
    observation.partial = snapshot.partial.clone();
    observation.observed_at_ms = now;
    observation.private_bytes = observed.private_bytes;
    if observed.private_bytes > cap {
        observation.stopped = "size_cap".into();
        events.push(("observation_stopped".into(), json!({"reason": "size_cap", "bytes": observed.private_bytes, "limit": cap})));
    }
    true
}

/// What a step start or report observed, gathered before its transaction while the run's
/// snapshot lock is held, so no interval snapshot lands in between.
pub(crate) struct Boundary {
    _guard: tokio::sync::OwnedMutexGuard<()>,
    observed: Option<Observed>,
    error: String,
    /// For a report of a step that never started: its window from the previous boundary.
    report_window: Vec<ChangedPath>,
    /// For a start: the step's inputs as they are now, `None` for a missing file.
    inputs: Option<BTreeMap<String, Option<String>>>,
}

fn hash_inputs(work: &Path, inputs: &[String]) -> BTreeMap<String, Option<String>> {
    inputs.iter().map(|input| (input.clone(), file_sha256(&work.join(input)).ok())).collect()
}

/// A step operation with what its boundary observed: changes since the previous snapshot go to
/// the window that was open, then the operation applies, then windows close and open here.
pub(crate) fn apply_agent_at(op: &AgentRunOp<'_>, source: &str, label: &str, current: Option<Sigil>, now: u64, events: &mut Events,
    boundary: Option<&Boundary>) -> Result<Applied, String> {
    let Some(boundary) = boundary else { return apply_agent(op, source, label, current, now, events) };
    let mut sigil = current.ok_or("法阵不存在。")?;
    if let Some(observed) = &boundary.observed {
        apply_observed(&mut sigil, observed, now, events, MAX_PRIVATE_BYTES);
    }
    if !boundary.error.is_empty() {
        events.push(("observation_failed".into(), json!({"error": boundary.error})));
    }
    let before: BTreeMap<String, (StepStatus, u32)> = sigil.run.as_ref()
        .map(|run| run.steps.iter().map(|(id, progress)| (id.clone(), (progress.status, progress.attempt))).collect())
        .unwrap_or_default();
    let Applied::Write { mut sigil, history, created } = apply_agent(op, source, label, Some(sigil), now, events)? else {
        return Err("法阵不存在。".into());
    };
    step_boundary(&mut sigil, op, &before, boundary, now, events);
    Ok(Applied::Write { sigil, history, created })
}

/// Closes the windows this operation ended and opens the one it started, at the boundary
/// snapshot. When the snapshot failed, the latest observed tree stands in for it.
fn step_boundary(sigil: &mut Sigil, op: &AgentRunOp<'_>, before: &BTreeMap<String, (StepStatus, u32)>, boundary: &Boundary, now: u64, events: &mut Events) {
    let frozen = sigil.freeze.as_ref().map(|freeze| freeze.input_hashes.clone()).unwrap_or_default();
    let Some(run) = sigil.run.as_mut() else { return };
    // Inputs an amendment declared are measured from when it was made, not from the freeze.
    let amended = run.amended_inputs.clone();
    let Some(observation) = run.observation.as_mut() else { return };
    let (tree, large) = match &boundary.observed {
        Some(observed) => (observed.snapshot.tree.clone(), observed.snapshot.large.clone()),
        None => (observation.tree.clone(), observation.large.clone()),
    };
    let usable = observation.stopped.is_empty() && !tree.is_empty();
    let seen = boundary.observed.is_some();
    let (previous, previous_large) = (observation.boundary_tree.clone(), observation.boundary_large.clone());
    let (started, reported) = match op {
        AgentRunOp::StartStep { step_id } => (Some(*step_id), None),
        AgentRunOp::ReportStep { step_id, .. } => (None, Some(*step_id)),
        _ => (None, None),
    };
    for step in &sigil.plan.steps {
        let Some(progress) = run.steps.get_mut(&step.id) else { continue };
        let (was, attempt) = before.get(&step.id).copied().unwrap_or_default();
        if usable && progress.status == StepStatus::Reported && was != StepStatus::Reported {
            if progress.start_tree.is_empty() && seen && !previous.is_empty() {
                // Reported without a start: the window runs from the previous step boundary, and
                // edits listed outside any step since then belong to this step.
                progress.start_tree = previous.clone();
                progress.start_large = previous_large.clone();
                record_window(progress, window(Some(step), &boundary.report_window, &previous_large, &large), now);
                if observation.outside.last().is_some_and(|last| last.from_tree == previous) {
                    observation.outside.pop();
                }
            }
            progress.end_tree = tree.clone();
            if seen && reported == Some(step.id.as_str()) && !step.scope.is_empty() && progress.changed_files == 0 {
                upsert_marker(progress, "reported_without_changes", now, String::new());
            }
        }
        if usable && progress.status == StepStatus::Active && progress.attempt != attempt {
            progress.start_tree = tree.clone();
            progress.start_large = large.clone();
            progress.end_tree.clear();
            progress.changes.clear();
            progress.changed_files = 0;
        }
        if started == Some(step.id.as_str()) && was != StepStatus::Active && progress.status == StepStatus::Active {
            if let Some(inputs) = &boundary.inputs {
                // An input may change when an earlier step edits it within its scope; anything
                // else is marked for review.
                let changed: Vec<String> = step.inputs.iter().filter(|input| {
                    let baseline = amended.get(*input).cloned().unwrap_or_else(|| frozen.get(*input).cloned());
                    inputs.get(*input).cloned().flatten() != baseline
                        && observation.input_writers.get(*input).is_none_or(|writers| writers.is_empty())
                }).cloned().collect();
                if !changed.is_empty() {
                    upsert_marker(progress, "input_changed", now, paths_detail(&changed));
                    events.push(("input_changed".into(), json!({"step_id": step.id, "paths": changed})));
                }
            }
        }
    }
    if usable {
        observation.boundary_tree = tree;
        observation.boundary_large = large;
    }
}

/// The first snapshot of a run, taken when it starts. A failure stops observation, not the run.
pub(crate) async fn baseline(dir: &Path, work: &Path, sigil: &Sigil) -> SigilObservation {
    let frozen = sigil.freeze.as_ref().map(|freeze| freeze.input_hashes.clone()).unwrap_or_default();
    let mut inputs: Vec<String> = sigil.plan.steps.iter().flat_map(|step| step.inputs.iter().cloned()).collect();
    inputs.sort();
    inputs.dedup();
    let owned = work.to_path_buf();
    let current = tokio::task::spawn_blocking(move || hash_inputs(&owned, &inputs)).await.unwrap_or_default();
    let inputs_differ_at_start = current.into_iter().filter(|(path, hash)| hash.as_ref() != frozen.get(path)).map(|(path, _)| path).collect();
    let taken = async {
        let session = Session::create(dir, work).await?;
        let snapshot = session.take(MAX_NEW_FILE_BYTES).await?;
        Ok::<_, String>((session.private_bytes(), snapshot))
    }.await;
    let now = now_ms();
    match taken {
        Ok((private_bytes, snapshot)) => SigilObservation {
            baseline_tree: snapshot.tree.clone(), tree: snapshot.tree.clone(), boundary_tree: snapshot.tree, observed_at_ms: now,
            boundary_large: snapshot.large.clone(), large: snapshot.large, partial: snapshot.partial, inputs_differ_at_start, private_bytes,
            ..Default::default()
        },
        Err(error) => SigilObservation { observed_at_ms: now, stopped: "unavailable".into(), stopped_detail: error, inputs_differ_at_start, ..Default::default() },
    }
}

impl Bridge {
    /// `<database directory>/sigils`, where each run keeps its private snapshot directory.
    pub(crate) fn sigils_root(&self) -> Result<PathBuf, SpellcastError> {
        let store = self.sigil_store()?;
        let path = store.connection.path().filter(|path| !path.is_empty()).ok_or_else(|| fail("法阵观察需要保存在磁盘上的状态库。"))?;
        Ok(Path::new(path).parent().map_or_else(PathBuf::new, Path::to_path_buf).join("sigils"))
    }

    pub(crate) fn sigil_dir(&self, sigil_id: &str) -> Result<PathBuf, SpellcastError> {
        validate_sigil_id(sigil_id).map_err(fail)?;
        Ok(self.sigils_root()?.join(sigil_id))
    }

    /// Snapshots for a step start or report, taken under the run's snapshot lock. `None` for
    /// other operations and for runs without observation.
    pub(crate) async fn sigil_boundary(&self, sigil_id: &str, op: &AgentRunOp<'_>) -> Result<Option<Boundary>, SpellcastError> {
        let (step_id, report) = match op {
            AgentRunOp::StartStep { step_id } => (*step_id, false),
            AgentRunOp::ReportStep { step_id, .. } => (*step_id, true),
            _ => return Ok(None),
        };
        let dir = self.sigil_dir(sigil_id)?;
        let guard = slot_lock(&dir).lock_owned().await;
        // Read after taking the lock: an interval snapshot may just have been recorded.
        let sigil = self.sigil_store()?.sigil_get(sigil_id).map_err(fail)?;
        let Some(run) = sigil.run.as_ref() else { return Ok(None) };
        let Some(observation) = run.observation.as_ref() else { return Ok(None) };
        let inputs = if report {
            None
        } else {
            let work = PathBuf::from(&run.execution_directory);
            let inputs = sigil.plan.steps.iter().find(|step| step.id == step_id).map(|step| step.inputs.clone()).unwrap_or_default();
            Some(tokio::task::spawn_blocking(move || hash_inputs(&work, &inputs)).await.unwrap_or_default())
        };
        let mut boundary = Boundary { _guard: guard, observed: None, error: String::new(), report_window: vec![], inputs };
        let began = std::time::Instant::now();
        match observe(&dir, &sigil).await {
            Ok(observed) => boundary.observed = observed,
            Err(error) => boundary.error = error,
        }
        touch_slot(&dir, began.elapsed(), (!boundary.error.is_empty()).then_some(&boundary.error));
        // The boundary snapshot counts as the interval's: the next one is due a full step interval later.
        if let Some(slot) = SLOTS.lock().unwrap().get_mut(&dir) {
            slot.next_at = Some(tokio::time::Instant::now() + STEP_INTERVAL);
        }
        let never_started = report && run.steps.get(step_id).is_none_or(|progress| progress.start_tree.is_empty());
        if let Some(observed) = boundary.observed.as_ref().filter(|_| never_started && !observation.boundary_tree.is_empty()) {
            let window = match Session::open(&dir) {
                Ok(session) => session.diff(&observation.boundary_tree, &observed.snapshot.tree, true).await,
                Err(error) => Err(error),
            };
            match window {
                Ok(changes) => boundary.report_window = changes,
                Err(error) => boundary.error = error,
            }
        }
        Ok(Some(boundary))
    }

    /// Takes an interval snapshot now and records what changed. Returns whether anything did.
    pub(crate) async fn sigil_observe_now(&self, sigil_id: &str) -> Result<bool, SpellcastError> {
        let dir = self.sigil_dir(sigil_id)?;
        let lock = slot_lock(&dir);
        let guard = lock.lock().await;
        let result = self.observe_locked(sigil_id, &dir).await;
        drop(guard);
        if let Some(slot) = SLOTS.lock().unwrap().get_mut(&dir) {
            slot.busy = false;
        }
        result
    }

    async fn observe_locked(&self, sigil_id: &str, dir: &Path) -> Result<bool, SpellcastError> {
        let sigil = self.sigil_store()?.sigil_get(sigil_id).map_err(fail)?;
        if !matches!(sigil.state, SigilState::Running | SigilState::Paused) {
            SLOTS.lock().unwrap().remove(dir);
            return Ok(false);
        }
        let began = std::time::Instant::now();
        let observed = observe(dir, &sigil).await;
        let new_error = touch_slot(dir, began.elapsed(), observed.as_ref().err());
        let observed = match observed {
            Ok(Some(observed)) => observed,
            Ok(None) => return Ok(false),
            Err(error) => {
                // Repeated failures are recorded once, not on every interval.
                if new_error {
                    self.sigil_store()?.sigil_observe(sigil_id, |_, events| {
                        events.push(("observation_failed".into(), json!({"error": error})));
                        true
                    }).map_err(fail)?;
                    self.sigil_changed(sigil_id);
                }
                return Err(fail(error));
            }
        };
        let now = now_ms();
        let changed = self.sigil_store()?
            .sigil_observe(sigil_id, |sigil, events| apply_observed(sigil, &observed, now, events, MAX_PRIVATE_BYTES))
            .map_err(fail)?;
        if changed {
            self.sigil_changed(sigil_id);
        }
        Ok(changed)
    }

    /// Starts interval snapshots for running sigils, including those running before a restart.
    /// One loop per database; it ends when the bridge is dropped.
    pub fn start_sigil_observer(self: &Arc<Self>) {
        let Ok(root) = self.sigils_root() else { return };
        if !LOOPS.lock().unwrap().insert(root.clone()) {
            return;
        }
        let bridge = Arc::downgrade(self);
        tokio::spawn(async move {
            loop {
                let notified = SIGIL_CHANGED.notified();
                tokio::pin!(notified);
                notified.as_mut().enable();
                let Some(strong) = bridge.upgrade() else { break };
                let wait = strong.schedule_observations(&root);
                drop(strong);
                tokio::select! {
                    _ = &mut notified => {}
                    _ = tokio::time::sleep(wait) => {}
                }
            }
            LOOPS.lock().unwrap().remove(&root);
        });
    }

    /// Starts the snapshots that are due and any queued checks, and returns how long until the
    /// next snapshot.
    fn schedule_observations(self: &Arc<Self>, root: &Path) -> Duration {
        let active = match self.sigil_store() {
            Ok(store) => store.sigil_active(),
            Err(error) => Err(error.to_string()),
        };
        let Ok(active) = active else { return IDLE_INTERVAL };
        self.schedule_checks(root, &active);
        let now = tokio::time::Instant::now();
        let mut wait = IDLE_INTERVAL;
        let mut slots = SLOTS.lock().unwrap();
        for sigil in active {
            let Some(run) = sigil.run.as_ref() else { continue };
            if run.observation.as_ref().is_none_or(|observation| !observation.stopped.is_empty()) {
                continue;
            }
            let interval = if sigil.state == SigilState::Running && open_step(run).is_some() { STEP_INTERVAL } else { IDLE_INTERVAL };
            let slot = slots.entry(root.join(&sigil.id)).or_default();
            slot.interval_ms = interval.as_millis() as u64;
            if slot.busy {
                wait = wait.min(BUSY_POLL);
                continue;
            }
            // A shorter interval, as when a step starts, applies at once.
            let due = slot.next_at.map_or(now, |next| next.min(now + interval));
            if due > now {
                wait = wait.min(due - now);
                continue;
            }
            slot.busy = true;
            slot.next_at = Some(now + interval);
            wait = wait.min(interval);
            let bridge = Arc::clone(self);
            let id = sigil.id.clone();
            tokio::spawn(async move {
                let _ = bridge.sigil_observe_now(&id).await;
            });
        }
        wait
    }

    /// The interval and the latest snapshot's timing, for the panel. Null before the first one.
    pub(crate) fn sigil_observation_live(&self, sigil_id: &str) -> Value {
        let Ok(dir) = self.sigil_dir(sigil_id) else { return Value::Null };
        let slots = SLOTS.lock().unwrap();
        slots.get(&dir).filter(|slot| slot.last_at_ms > 0).map_or(Value::Null, |slot| {
            json!({"last_at_ms": slot.last_at_ms, "duration_ms": slot.duration_ms, "interval_ms": slot.interval_ms, "error": slot.error})
        })
    }

    /// Read-only: the patch for a step's current window, or for one window of edits outside any
    /// step, optionally for one path. At most 256 KiB.
    pub async fn sigil_diff(&self, sigil_id: &str, step_id: &str, outside: Option<usize>, path: &str) -> Result<Value, SpellcastError> {
        let dir = self.sigil_dir(sigil_id)?;
        if !path.is_empty() {
            relative_path("path", path).map_err(fail)?;
        }
        let sigil = self.sigil_store()?.sigil_get(sigil_id).map_err(fail)?;
        let run = sigil.run.as_ref().ok_or_else(|| fail("法阵还没开始执行。"))?;
        let observation = run.observation.as_ref().ok_or_else(|| fail("这次执行没有改动记录。"))?;
        let (from, to) = match outside {
            Some(index) => {
                let window = observation.outside.get(index).ok_or_else(|| fail("没有这段步骤之外的改动。"))?;
                (window.from_tree.clone(), window.to_tree.clone())
            }
            None => {
                if !sigil.plan.steps.iter().any(|step| step.id == step_id) {
                    return Err(fail(format!("步骤 {step_id} 不存在。")));
                }
                let progress = run.steps.get(step_id).cloned().unwrap_or_default();
                let to = if progress.end_tree.is_empty() { observation.tree.clone() } else { progress.end_tree };
                (progress.start_tree, to)
            }
        };
        let (patch, truncated) = if from.is_empty() || from == to {
            (String::new(), false)
        } else {
            Session::open(&dir).map_err(fail)?.patch(&from, &to, (!path.is_empty()).then_some(path), MAX_PATCH_BYTES).await.map_err(fail)?
        };
        Ok(json!({"sigil_id": sigil_id, "step_id": step_id, "outside": outside, "path": path, "from_tree": from, "to_tree": to,
            "patch": patch, "truncated": truncated, "max_bytes": MAX_PATCH_BYTES}))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sigil_workspace::{SigilAgentOp, SigilQuery, SigilUpdate};
    use crate::sigils::{SigilLocation, SigilPlan};
    use crate::Headless;

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

    fn write(path: &Path, text: &str) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, text).unwrap();
    }

    fn repository(root: &Path) -> PathBuf {
        let repo = root.join("repo");
        write(&repo.join("src/lib.rs"), "pub fn answer() -> u8 { 42 }\n");
        write(&repo.join("notes.md"), "notes\n");
        write(&repo.join(".gitignore"), "*.log\n");
        sh(&repo, &["init", "-q", "-b", "main"]);
        sh(&repo, &["add", "-A"]);
        sh(&repo, &["commit", "-q", "-m", "init"]);
        repo
    }

    fn fixture() -> Fixture {
        let root = std::env::temp_dir().join(format!("sigil-observe-{}", uuid::Uuid::new_v4().simple()));
        let repo = repository(&root);
        let bridge = Bridge::open(Headless, 0, &root.join("state.sqlite3")).unwrap();
        Fixture { root, repo, bridge: Some(bridge) }
    }

    fn step(id: &str, scope: &[&str], inputs: &[&str], depends_on: &[&str]) -> SigilStep {
        let list = |items: &[&str]| items.iter().map(|item| item.to_string()).collect();
        SigilStep { id: id.into(), title: format!("Step {id}"), instructions: String::new(), inputs: list(inputs), scope: list(scope),
            checks: vec![], depends_on: list(depends_on), stop_when: vec![] }
    }

    async fn agent(b: &Bridge, request: &str, sigil: &str, op: SigilAgentOp) -> Value {
        b.sigil_agent_update(SigilUpdate { request_id: request.into(), sigil_id: sigil.into(), source_id: "claude:runner".into(), label: "Runner".into(), op })
            .await.unwrap()
    }

    fn start_step(id: &str) -> SigilAgentOp {
        SigilAgentOp::StartStep { step_id: id.into() }
    }

    fn report(id: &str) -> SigilAgentOp {
        SigilAgentOp::ReportStep { step_id: id.into(), summary: format!("{id} done"), evidence: vec![] }
    }

    async fn started(b: &Bridge, repo: &Path, id: &str, location: SigilLocation, steps: Vec<SigilStep>) -> Value {
        let plan = SigilPlan { title: format!("Watch {id}"), goal: "Observe".into(), repository: repo.to_string_lossy().into(), location, steps, ..Default::default() };
        agent(b, &format!("{id}-plan"), id, SigilAgentOp::PutPlan { expected_revision: 0, plan }).await;
        b.sigil_freeze(id, &format!("{id}-freeze"), 1).unwrap();
        let started = b.sigil_start(id, &format!("{id}-start"), 2).await.unwrap();
        agent(b, &format!("{id}-claim"), id, SigilAgentOp::Claim).await;
        started
    }

    fn read(b: &Bridge, id: &str) -> Value {
        b.sigil_query(SigilQuery { view: "sigil".into(), sigil_id: id.into(), ..Default::default() }).unwrap()
    }

    fn progress(b: &Bridge, id: &str, step: &str) -> Value {
        read(b, id)["sigil"]["run"]["steps"][step].clone()
    }

    fn paths(list: &Value) -> Vec<String> {
        list.as_array().map(|items| items.iter().map(|item| item["path"].as_str().unwrap().to_string()).collect()).unwrap_or_default()
    }

    fn kinds(markers: &Value) -> Vec<String> {
        markers.as_array().map(|items| items.iter().map(|item| item["kind"].as_str().unwrap().to_string()).collect()).unwrap_or_default()
    }

    #[tokio::test]
    async fn changes_go_to_the_open_step_and_deviations_are_marked() {
        let f = fixture();
        let b = f.b();
        started(b, &f.repo, "watch", SigilLocation::InPlace, vec![
            step("a", &["src/**"], &[], &[]),
            step("b", &["docs/**"], &["src/lib.rs", "notes.md"], &["a"]),
            step("c", &["src/**"], &[], &["b"]),
        ]).await;
        agent(b, "a-start", "watch", start_step("a")).await;
        write(&f.repo.join("src/new.rs"), "pub fn new() {}\n");
        write(&f.repo.join("docs/guide.md"), "# Guide\n");
        write(&f.repo.join("build.log"), "ignored\n");
        assert!(b.sigil_observe_now("watch").await.unwrap());
        assert!(!b.sigil_observe_now("watch").await.unwrap(), "an unchanged directory records nothing");
        let a = progress(b, "watch", "a");
        assert_eq!(paths(&a["changes"]), ["docs/guide.md", "src/new.rs"]);
        assert_eq!((a["changes"][0]["out_of_scope"].clone(), a["changes"][1].get("out_of_scope")), (json!(true), None));
        assert_eq!(a["outside_scope"], json!(["docs/guide.md"]));
        assert_eq!(kinds(&a["markers"]), ["out_of_scope"]);
        let mut expected = 3;
        #[cfg(windows)]
        {
            use std::os::windows::fs::OpenOptionsExt;
            write(&f.repo.join("src/held.txt"), "held\n");
            let held = std::fs::OpenOptions::new().read(true).share_mode(0).open(f.repo.join("src/held.txt")).unwrap();
            assert!(b.sigil_observe_now("watch").await.unwrap());
            let a = progress(b, "watch", "a");
            assert_eq!(kinds(&a["markers"]), ["out_of_scope", "partial_snapshot"]);
            assert_eq!(a["markers"][1]["detail"], "src/held.txt");
            drop(held);
            expected += 1;
        }
        write(&f.repo.join("src/lib.rs"), "pub fn answer() -> u8 { 43 }\n");
        let reported = agent(b, "a-report", "watch", report("a")).await;
        assert_eq!(reported["step"]["changed_files"], expected, "the report snapshot closes the window");
        assert!(!progress(b, "watch", "a")["end_tree"].as_str().unwrap().is_empty());

        // Edits while no step runs are listed outside any step.
        write(&f.repo.join("notes.md"), "changed by someone\n");
        assert!(b.sigil_observe_now("watch").await.unwrap());
        assert_eq!(paths(&read(b, "watch")["sigil"]["run"]["observation"]["outside"][0]["files"]), ["notes.md"]);

        // src/lib.rs changed within a's scope; notes.md changed outside any step.
        let b_started = agent(b, "b-start", "watch", start_step("b")).await;
        assert_eq!(kinds(&b_started["step"]["markers"]), ["input_changed"]);
        assert_eq!(b_started["step"]["markers"][0]["detail"], "notes.md");
        let b_reported = agent(b, "b-report", "watch", report("b")).await;
        assert_eq!(kinds(&b_reported["step"]["markers"]), ["input_changed", "reported_without_changes"]);
        assert_eq!(b_reported["state"], "running", "markers never stop the run");

        // c reports without a start: its window runs from b's report and takes the edits since.
        write(&f.repo.join("src/late.rs"), "pub fn late() {}\n");
        let c = agent(b, "c-report", "watch", report("c")).await;
        assert_eq!(c["state"], "completed");
        assert_eq!(kinds(&c["step"]["markers"]), ["reported_without_start"]);
        assert_eq!(paths(&progress(b, "watch", "c")["changes"]), ["src/late.rs"]);
        assert_eq!(read(b, "watch")["sigil"]["run"]["observation"]["outside"].as_array().unwrap().len(), 1, "c claimed the later edit");

        let diff = b.sigil_diff("watch", "a", None, "src/new.rs").await.unwrap();
        assert!(diff["patch"].as_str().unwrap().contains("+pub fn new() {}"), "{diff}");
        assert!(!diff["patch"].as_str().unwrap().contains("docs/guide.md"));
        let outside = b.sigil_diff("watch", "", Some(0), "").await.unwrap();
        assert!(outside["patch"].as_str().unwrap().contains("+changed by someone"), "{outside}");
        assert!(b.sigil_diff("watch", "a", None, "../escape").await.is_err());
        let events = b.sigil_query(SigilQuery { view: "events".into(), sigil_id: "watch".into(), ..Default::default() }).unwrap();
        let events: Vec<&str> = events["events"].as_array().unwrap().iter().map(|event| event["kind"].as_str().unwrap()).collect();
        for kind in ["changes_observed", "changes_outside_step", "input_changed"] {
            assert!(events.contains(&kind), "{kind}: {events:?}");
        }
    }

    #[tokio::test]
    async fn observation_continues_after_a_restart_in_a_worktree() {
        let mut f = fixture();
        let started = started(f.b(), &f.repo, "wt", SigilLocation::Worktree, vec![step("a", &["src/**"], &[], &[])]).await;
        let run = &started["sigil"]["run"];
        assert_eq!(run["observation"]["baseline_tree"], sh(&f.repo, &["rev-parse", "main^{tree}"]), "a fresh worktree snapshots as its base");
        let directory = PathBuf::from(run["execution_directory"].as_str().unwrap());
        let index = std::fs::read(f.repo.join(".git/index")).unwrap();
        agent(f.b(), "start", "wt", start_step("a")).await;
        write(&directory.join("src/lib.rs"), "pub fn answer() -> u8 { 7 }\n");
        // Restart: release the database and open it again, as the app does.
        drop(f.bridge.take());
        f.bridge = Some(Bridge::open(Headless, 0, &f.root.join("state.sqlite3")).unwrap());
        assert!(f.b().sigil_observe_now("wt").await.unwrap());
        let a = progress(f.b(), "wt", "a");
        assert_eq!(paths(&a["changes"]), ["src/lib.rs"]);
        assert_eq!((a["changes"][0]["added"].clone(), a["changes"][0]["deleted"].clone()), (json!(1), json!(1)));
        assert_eq!(std::fs::read(f.repo.join(".git/index")).unwrap(), index, "the repository's index is untouched");
        assert!(read(f.b(), "wt")["observation_live"]["last_at_ms"].as_u64().unwrap() > 0);
    }

    #[test]
    fn the_size_cap_stops_observation_but_not_the_run() {
        let mut sigil: Sigil = serde_json::from_value(json!({
            "id": "cap", "title": "Cap", "steps": [{"id": "a", "title": "A", "scope": ["src/**"]}], "state": "running", "revision": 3,
            "created_at_ms": 1, "updated_at_ms": 1, "updated_by": {"kind": "user", "label": "用户"},
            "run": {"started_at_ms": 1, "execution_directory": "x", "location": "in_place", "base_ref": "main", "base_commit": "c",
                "steps": {"a": {"status": "active", "attempt": 1, "start_tree": "t0"}},
                "observation": {"baseline_tree": "t0", "tree": "t0", "observed_at_ms": 1, "boundary_tree": "t0"}},
        })).unwrap();
        let change = ChangedPath { path: "src/x.rs".into(), status: "A".into(), added: Some(1), deleted: Some(0), ..Default::default() };
        let observed = |tree: &str| Observed {
            snapshot: Snapshot { tree: tree.into(), large: BTreeMap::new(), partial: vec![], duration_ms: 5 },
            owner: Some("a".into()), from_tree: "t0".into(), window: vec![change.clone()], delta: vec![change.clone()], private_bytes: 2048,
        };
        let mut events = Events::new();
        assert!(apply_observed(&mut sigil, &observed("t1"), 10, &mut events, 1024));
        let kinds: Vec<&str> = events.iter().map(|(kind, _)| kind.as_str()).collect();
        assert_eq!(kinds, ["changes_observed", "observation_stopped"]);
        let observation = sigil.run.as_ref().unwrap().observation.as_ref().unwrap();
        assert_eq!(observation.stopped, "size_cap");
        assert_eq!(sigil.state, SigilState::Running);
        assert!(!apply_observed(&mut sigil, &observed("t2"), 11, &mut events, 1024), "a stopped observation records nothing");
    }

    /// Runs on its own runtime: the loop's snapshot tasks hold the bridge until it shuts down.
    #[test]
    fn the_interval_loop_records_edits_while_a_step_runs() {
        let root = std::env::temp_dir().join(format!("sigil-loop-{}", uuid::Uuid::new_v4().simple()));
        let repo = repository(&root);
        let runtime = tokio::runtime::Builder::new_multi_thread().enable_all().build().unwrap();
        let seen = runtime.block_on(async {
            let bridge = Arc::new(Bridge::open(Headless, 0, &root.join("state.sqlite3")).unwrap());
            bridge.start_sigil_observer();
            started(&bridge, &repo, "loop", SigilLocation::InPlace, vec![step("a", &["src/**"], &[], &[])]).await;
            agent(&bridge, "start", "loop", start_step("a")).await;
            write(&repo.join("src/added.rs"), "pub fn added() {}\n");
            let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
            loop {
                let a = progress(&bridge, "loop", "a");
                if a["changed_files"] == 1 || tokio::time::Instant::now() > deadline {
                    break paths(&a["changes"]);
                }
                tokio::time::sleep(Duration::from_millis(200)).await;
            }
        });
        drop(runtime);
        let _ = std::fs::remove_dir_all(&root);
        assert_eq!(seen, ["src/added.rs"]);
    }
}

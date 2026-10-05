//! Application-owned Claude observations. No host Agent or completion notification is involved.
//! The desktop supplies trusted runtime paths; MCP callers cannot choose a program or arguments.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{mpsc, Arc, Mutex, Weak};
use std::time::{Duration, Instant};

use serde::Deserialize;

use crate::observer::{ObserverBrief, ObserverCompletion, ObserverThought};
use crate::process_tree::ProcessTree;
use crate::Bridge;

const MAX_INPUT: usize = 64 * 1024;
const MAX_OUTPUT: usize = 128 * 1024;
const POLL: Duration = Duration::from_millis(25);
const DRAIN: Duration = Duration::from_secs(2);

/// Configured by the application, never by a tool request. Execution uses no shell.
#[derive(Clone)]
pub struct ClaudeObserverRunner {
    node: PathBuf,
    script: PathBuf,
}

impl ClaudeObserverRunner {
    pub fn new(node: PathBuf, script: PathBuf) -> Result<Self, String> {
        fn file(path: &Path) -> Result<PathBuf, String> {
            if !path.is_absolute() || !path.is_file() {
                return Err(
                    "Claude observer runtime requires existing absolute file paths.".into(),
                );
            }
            path.canonicalize()
                .map(node_path)
                .map_err(|_| "Claude observer runtime path is unavailable.".into())
        }
        Ok(Self {
            node: file(&node)?,
            script: file(&script)?,
        })
    }
}

/// Node's module loader rejects Windows verbatim paths (EISDIR at the drive).
/// Strip only the canonical filesystem prefix, after the desktop has checked containment.
#[cfg(windows)]
fn node_path(path: PathBuf) -> PathBuf {
    use std::os::windows::ffi::{OsStrExt, OsStringExt};
    let wide: Vec<u16> = path.as_os_str().encode_wide().collect();
    let prefix: Vec<u16> = r"\\?\".encode_utf16().collect();
    if wide.starts_with(&prefix) {
        let unc: Vec<u16> = r"UNC\".encode_utf16().collect();
        let tail = &wide[prefix.len()..];
        if tail.starts_with(&unc) {
            let mut normal: Vec<u16> = r"\\".encode_utf16().collect();
            normal.extend_from_slice(&tail[unc.len()..]);
            return PathBuf::from(std::ffi::OsString::from_wide(&normal));
        }
        if tail.len() >= 3 && tail[1] == b':' as u16 && tail[2] == b'\\' as u16 {
            return PathBuf::from(std::ffi::OsString::from_wide(tail));
        }
    }
    path
}

#[cfg(not(windows))]
fn node_path(path: PathBuf) -> PathBuf {
    path
}

/// Only the ticket owns the cancellation handle; workers observe its shared flag.
/// Removing/replacing the ticket, dropping the bridge, or disabling asides stops the process tree.
#[derive(Default)]
struct JobState {
    cancelled: AtomicBool,
}

pub(crate) struct ObserverJob(Arc<JobState>);

impl Drop for ObserverJob {
    fn drop(&mut self) {
        self.0.cancelled.store(true, Ordering::Release);
    }
}

pub(crate) struct ObserverDispatcher {
    runner: ClaudeObserverRunner,
    bridge: Weak<Bridge>,
    active: Arc<AtomicUsize>,
    gates: Mutex<HashMap<String, Weak<Mutex<()>>>>,
    spawn_gate: Arc<Mutex<()>>,
}

impl ObserverDispatcher {
    pub(crate) fn new(runner: ClaudeObserverRunner, bridge: Weak<Bridge>) -> Self {
        Self {
            runner,
            bridge,
            active: Arc::new(AtomicUsize::new(0)),
            gates: Mutex::new(HashMap::new()),
            spawn_gate: Arc::new(Mutex::new(())),
        }
    }

    pub(crate) fn set_runner(&mut self, runner: ClaudeObserverRunner) {
        self.runner = runner;
    }

    /// After cancelling all tickets, cross the creation/assignment critical section before exit.
    /// Every created child then belongs to its kill-on-close Job or has already been reaped.
    pub(crate) fn synchronize_spawns(&self) {
        drop(
            self.spawn_gate
                .lock()
                .unwrap_or_else(|error| error.into_inner()),
        );
    }

    /// Returns after a worker has been accepted, without waiting for Claude or keeping the
    /// originating host turn alive. The worker only upgrades the bridge after the process exits.
    pub(crate) fn schedule(&self, brief: ObserverBrief) -> Result<ObserverJob, String> {
        let state = Arc::new(JobState::default());
        let job_state = state.clone();
        let gate = {
            let mut gates = self.gates.lock().unwrap();
            gates.retain(|_, gate| gate.strong_count() > 0);
            let slot = gates.entry(brief.source_id.clone()).or_default();
            match slot.upgrade() {
                Some(gate) => gate,
                None => {
                    let gate = Arc::new(Mutex::new(()));
                    *slot = Arc::downgrade(&gate);
                    gate
                }
            }
        };
        let runner = self.runner.clone();
        let bridge = self.bridge.clone();
        let active = self.active.clone();
        let spawn_gate = self.spawn_gate.clone();
        active.fetch_add(1, Ordering::AcqRel);
        let spawned = std::thread::Builder::new()
            .name("spellcast-observer".into())
            .spawn(move || {
                struct Active(Arc<AtomicUsize>);
                impl Drop for Active {
                    fn drop(&mut self) {
                        self.0.fetch_sub(1, Ordering::AcqRel);
                    }
                }
                let _active = Active(active);
                let flag = &job_state.cancelled;
                // The gate belongs to the source, not just the direct predecessor. Cancelling
                // B while it waits for A must not let a third replacement C bypass A's cleanup.
                let _serial = loop {
                    if flag.load(Ordering::Acquire)
                        || spellcast_core::inbox::now_ms() >= brief.expires_at_ms
                    {
                        return;
                    }
                    match gate.try_lock() {
                        Ok(guard) => break guard,
                        Err(std::sync::TryLockError::Poisoned(error)) => break error.into_inner(),
                        Err(std::sync::TryLockError::WouldBlock) => std::thread::sleep(POLL),
                    }
                };
                let result = run_with_spawn_gate(&runner, &brief, flag, &spawn_gate);
                // No result, including silence, may consume a newer or cancelled ticket.
                if flag.load(Ordering::Acquire) {
                    return;
                }
                let thought = match result {
                    Ok(thought) => thought,
                    Err(reason) => {
                        // Static diagnostics only: never log the brief, model output, or stderr.
                        tracing::warn!(reason, "Claude aside ended without a decision");
                        None
                    }
                };
                if let Some(bridge) = bridge.upgrade() {
                    if bridge
                        .complete_observation(ObserverCompletion {
                            observer_id: brief.observer_id,
                            provider: Some("claude".into()),
                            thought,
                        })
                        .is_err()
                    {
                        tracing::warn!("Claude aside completion was rejected");
                    }
                }
            });
        if spawned.is_err() {
            state.cancelled.store(true, Ordering::Release);
            self.active.fetch_sub(1, Ordering::AcqRel);
            return Err("Claude observer worker could not start.".into());
        }
        Ok(ObserverJob(state))
    }

    #[cfg(test)]
    pub(crate) fn active(&self) -> usize {
        self.active.load(Ordering::Acquire)
    }
}

/// Ensure unwinding or an early I/O failure also ends every descendant.
struct OwnedProcess {
    child: std::process::Child,
    tree: ProcessTree,
}

impl Drop for OwnedProcess {
    fn drop(&mut self) {
        self.tree.end(&mut self.child);
        // Assignment can fail while the Windows child is still suspended and outside the job.
        // Ending an empty job is then insufficient; always kill the owned child handle as well.
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

type ReaderResult = Result<Vec<u8>, &'static str>;

fn read_bounded(
    mut pipe: impl Read + Send + 'static,
    failed: Arc<AtomicBool>,
) -> mpsc::Receiver<ReaderResult> {
    let (tx, rx) = mpsc::sync_channel(1);
    std::thread::spawn(move || {
        let mut bytes = Vec::new();
        let result = loop {
            let mut buffer = [0u8; 4096];
            match pipe.read(&mut buffer) {
                Ok(0) => break Ok(bytes),
                Ok(n) if bytes.len() + n <= MAX_OUTPUT => bytes.extend_from_slice(&buffer[..n]),
                Ok(_) => break Err("output_limit"),
                Err(_) => break Err("output_read"),
            }
        };
        if result.is_err() {
            failed.store(true, Ordering::Release);
        }
        let _ = tx.send(result);
    });
    rx
}

fn run_with_spawn_gate(
    runner: &ClaudeObserverRunner,
    brief: &ObserverBrief,
    cancelled: &AtomicBool,
    spawn_gate: &Mutex<()>,
) -> Result<Option<ObserverThought>, &'static str> {
    if brief.provider != "claude" {
        return Err("provider_mismatch");
    }
    let remaining = brief
        .expires_at_ms
        .saturating_sub(spellcast_core::inbox::now_ms());
    if remaining == 0 || cancelled.load(Ordering::Acquire) {
        return Err("cancelled_or_expired");
    }
    let deadline = Instant::now() + Duration::from_millis(remaining);
    let input = serde_json::to_vec(brief).map_err(|_| "brief_invalid")?;
    if input.len() > MAX_INPUT {
        return Err("brief_limit");
    }

    let mut command = Command::new(&runner.node);
    command
        .arg(&runner.script)
        .current_dir(runner.script.parent().ok_or("runtime_path")?)
        .env_remove("NODE_OPTIONS")
        .env_remove("NODE_PATH")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    // Creation/assignment only: never hold this gate during model work or UI calls.
    let startup = spawn_gate.lock().unwrap_or_else(|error| error.into_inner());
    if cancelled.load(Ordering::Acquire) || Instant::now() >= deadline {
        return Err("cancelled_or_expired");
    }
    let tree = ProcessTree::prepare(&mut command).map_err(|_| "process_tree")?;
    let child = command.spawn().map_err(|_| "runner_spawn")?;
    drop(command);
    let mut owned = OwnedProcess { child, tree };
    // Windows starts suspended, so no Claude descendant can escape before assignment.
    owned.tree.adopt(&owned.child).map_err(|_| "process_tree")?;
    // On failure, owned drops before startup, killing even an unassigned suspended child.
    drop(startup);
    let mut stdin = owned.child.stdin.take().ok_or("stdin_missing")?;
    let stdout = owned.child.stdout.take().ok_or("stdout_missing")?;
    let stderr = owned.child.stderr.take().ok_or("stderr_missing")?;
    let io_failed = Arc::new(AtomicBool::new(false));
    let out = read_bounded(stdout, io_failed.clone());
    let err = read_bounded(stderr, io_failed.clone());
    let (input_tx, input_rx) = mpsc::sync_channel(1);
    let write_failed = io_failed.clone();
    std::thread::spawn(move || {
        let result = stdin.write_all(&input).map_err(|_| "input_write");
        drop(stdin);
        if result.is_err() {
            write_failed.store(true, Ordering::Release);
        }
        let _ = input_tx.send(result);
    });

    let status = loop {
        if cancelled.load(Ordering::Acquire) {
            break Err("cancelled");
        }
        if Instant::now() >= deadline {
            break Err("expired");
        }
        if io_failed.load(Ordering::Acquire) {
            break Err("runner_io");
        }
        match owned.child.try_wait() {
            Ok(Some(status)) => break Ok(status),
            Ok(None) => std::thread::sleep(POLL),
            Err(_) => break Err("runner_wait"),
        }
    };
    // A normal runner exit must not leave descendants or inherited pipe handles behind either.
    drop(owned);
    let stdout = out.recv_timeout(DRAIN).map_err(|_| "output_drain")?;
    let stderr = err.recv_timeout(DRAIN).map_err(|_| "output_drain")?;
    let written = input_rx.recv_timeout(DRAIN).map_err(|_| "input_drain")?;
    let status = status?;
    written?;
    stderr?;
    let stdout = stdout?;
    if cancelled.load(Ordering::Acquire) || spellcast_core::inbox::now_ms() >= brief.expires_at_ms {
        return Err("cancelled_or_expired");
    }
    if !status.success() {
        return Err("runner_failed");
    }
    parse_decision(&stdout, &brief.observer_id)
}

#[cfg(test)]
fn run(
    runner: &ClaudeObserverRunner,
    brief: &ObserverBrief,
    cancelled: &AtomicBool,
) -> Result<Option<ObserverThought>, &'static str> {
    run_with_spawn_gate(runner, brief, cancelled, &Mutex::new(()))
}

fn parse_decision(
    bytes: &[u8],
    observer_id: &str,
) -> Result<Option<ObserverThought>, &'static str> {
    #[derive(Deserialize)]
    struct Decision {
        status: String,
        observer_id: Option<String>,
        thought: Option<ObserverThought>,
    }
    let decision: Decision = serde_json::from_slice(bytes).map_err(|_| "decision_invalid")?;
    match decision.status.as_str() {
        "ready"
            if decision.observer_id.as_deref() == Some(observer_id)
                && decision.thought.is_some() =>
        {
            let thought = decision.thought.unwrap();
            if thought.tease.trim().is_empty()
                || thought.tease.chars().count() > 120
                || thought.body.chars().count() > 2000
            {
                return Err("thought_invalid");
            }
            Ok(Some(thought))
        }
        "silent"
            if decision.observer_id.as_deref() == Some(observer_id)
                && decision.thought.is_none() =>
        {
            Ok(None)
        }
        "unavailable" if decision.thought.is_none() => Err("runner_unavailable"),
        _ => Err("decision_invalid"),
    }
}

#[cfg(test)]
pub(crate) mod test_support;
#[cfg(test)]
mod tests;

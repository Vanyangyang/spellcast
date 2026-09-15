//! Bounded local helper diagnostics. Never logs prompts, transcripts, cwd, or raw source text.
//! Failures here must not change hook stdout or exit code.

use std::fs::{self, OpenOptions};
use std::io::{Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use fs2::FileExt;
use sha2::{Digest, Sha256};

use crate::cache::SaveOutcome;
use crate::event::{ChildSkip, HookEvent};
use crate::http::StatusError;
use crate::policy::Action;
use crate::BOOTSTRAP;

pub const DIAG_LIMIT: u64 = 256 * 1024;
pub const DIAG_WRITE_WAIT: Duration = Duration::from_millis(25);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ParseOutcome {
    EmptyStdin,
    Fail,
    Unsupported,
    Ok,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HttpOutcome {
    NotAttempted,
    Ok,
    RejectedUrl,
    Transport,
    InvalidBody,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StdoutOutcome {
    Skipped,
    Written,
    WriteFailed,
}

#[derive(Debug, Clone)]
pub struct DiagRecord {
    pub parse: ParseOutcome,
    pub missing_session: bool,
    pub child_skip: Option<ChildSkip>,
    pub http: HttpOutcome,
    pub save: Option<SaveOutcome>,
    pub action: Option<Action>,
    pub stdout: StdoutOutcome,
    pub event_name: Option<String>,
    pub session_hash: Option<String>,
    pub source: Option<&'static str>,
}

impl DiagRecord {
    pub fn new() -> Self {
        Self {
            parse: ParseOutcome::Fail,
            missing_session: false,
            child_skip: None,
            http: HttpOutcome::NotAttempted,
            save: None,
            action: None,
            stdout: StdoutOutcome::Skipped,
            event_name: None,
            session_hash: None,
            source: None,
        }
    }
}

pub fn session_hash(session_id: &str) -> String {
    let digest = Sha256::digest(session_id.as_bytes());
    digest.iter().take(8).map(|b| format!("{b:02x}")).collect()
}

pub fn bootstrap_digest() -> String {
    let digest = Sha256::digest(BOOTSTRAP.as_bytes());
    digest.iter().take(8).map(|b| format!("{b:02x}")).collect()
}

pub fn helper_version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

pub fn http_from_err(err: &StatusError) -> HttpOutcome {
    match err {
        StatusError::RejectedUrl => HttpOutcome::RejectedUrl,
        StatusError::Transport => HttpOutcome::Transport,
        StatusError::InvalidBody => HttpOutcome::InvalidBody,
    }
}

fn source_label(event: &HookEvent) -> &'static str {
    match event.source.as_ref() {
        Some(crate::event::SessionSource::Startup) => "startup",
        Some(crate::event::SessionSource::Resume) => "resume",
        Some(crate::event::SessionSource::Clear) => "clear",
        Some(crate::event::SessionSource::Compact) => "compact",
        Some(crate::event::SessionSource::Other(_)) => "other",
        None => "none",
    }
}

pub fn fill_event(record: &mut DiagRecord, event: &HookEvent) {
    record.event_name = Some(event.hook_event_name.clone());
    record.session_hash = Some(session_hash(&event.session_id));
    record.source = Some(source_label(event));
    record.child_skip = event.child_skip;
}

fn diag_file(state_dir: Option<&Path>) -> PathBuf {
    if let Some(dir) = state_dir {
        if !dir.exists() || dir.is_dir() {
            return dir.join("diag.jsonl");
        }
    }
    std::env::temp_dir()
        .join("spellcast-hook-diag")
        .join("diag.jsonl")
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn skip_name(skip: ChildSkip) -> &'static str {
    match skip {
        ChildSkip::Flag => "flag",
        ChildSkip::NativeAgentId => "native_agent_id",
        ChildSkip::CompatAgentType => "compat_agent_type",
        ChildSkip::SubagentId => "subagent_id",
    }
}

fn parse_name(v: ParseOutcome) -> &'static str {
    match v {
        ParseOutcome::EmptyStdin => "empty_stdin",
        ParseOutcome::Fail => "fail",
        ParseOutcome::Unsupported => "unsupported_event",
        ParseOutcome::Ok => "ok",
    }
}

fn http_name(v: HttpOutcome) -> &'static str {
    match v {
        HttpOutcome::NotAttempted => "not_attempted",
        HttpOutcome::Ok => "ok",
        HttpOutcome::RejectedUrl => "rejected_url",
        HttpOutcome::Transport => "transport",
        HttpOutcome::InvalidBody => "invalid_body",
    }
}

fn save_name(v: SaveOutcome) -> &'static str {
    match v {
        SaveOutcome::Saved => "saved",
        SaveOutcome::Unusable => "unusable",
        SaveOutcome::SaveFailed => "save_failed",
        SaveOutcome::Busy => "busy",
    }
}

fn action_name(v: Action) -> &'static str {
    match v {
        Action::Empty => "empty",
        Action::Bootstrap => "bootstrap",
        Action::Stop => "stop",
    }
}

fn stdout_name(v: StdoutOutcome) -> &'static str {
    match v {
        StdoutOutcome::Skipped => "skipped",
        StdoutOutcome::Written => "written",
        StdoutOutcome::WriteFailed => "write_failed",
    }
}

fn stall_if_requested() {
    let Ok(raw) = std::env::var("SPELLCAST_HOOK_DIAG_STALL_MS") else {
        return;
    };
    let Ok(ms) = raw.parse::<u64>() else {
        return;
    };
    if ms > 0 && ms <= 10_000 {
        thread::sleep(Duration::from_millis(ms));
    }
}

fn encode_line(record: &DiagRecord) -> Option<Vec<u8>> {
    let line = serde_json::json!({
        "ts_ms": now_ms(),
        "helper_version": helper_version(),
        "bootstrap_digest": bootstrap_digest(),
        "parse": parse_name(record.parse),
        "missing_session": record.missing_session,
        "child_skip": record.child_skip.map(skip_name),
        "http": http_name(record.http),
        "save": record.save.map(save_name),
        "action": record.action.map(action_name),
        "stdout_write": stdout_name(record.stdout),
        "event": record.event_name,
        "session_hash": record.session_hash,
        "source": record.source,
    });
    let mut payload = serde_json::to_vec(&line).ok()?;
    payload.push(b'\n');
    Some(payload)
}

fn write_record_fs(path: &Path, payload: &[u8]) {
    if payload.is_empty() || payload.len() as u64 > DIAG_LIMIT {
        return;
    }
    if let Some(parent) = path.parent() {
        if fs::create_dir_all(parent).is_err() {
            return;
        }
    }
    let Ok(mut file) = OpenOptions::new()
        .create(true)
        .read(true)
        .write(true)
        .open(path)
    else {
        return;
    };
    if file.try_lock_exclusive().is_err() {
        return;
    }
    let Ok(existing) = file.metadata().map(|m| m.len()) else {
        return;
    };
    if existing + payload.len() as u64 > DIAG_LIMIT {
        if file.set_len(0).is_err() {
            return;
        }
        if file.seek(SeekFrom::Start(0)).is_err() {
            return;
        }
    } else if file.seek(SeekFrom::End(0)).is_err() {
        return;
    }
    if file.write_all(payload).is_err() {
        return;
    }
    let _ = file.flush();
    let _ = FileExt::unlock(&file);
}

/// Best-effort append. Waits at most `DIAG_WRITE_WAIT` for the isolated writer.
/// A stalled worker is not joined; the hook keeps its stdout and exit 0.
/// Path selection (`exists` / `is_dir` / temp fallback) runs inside the worker.
pub fn write_record(state_dir: Option<&Path>, record: &DiagRecord) {
    let state_dir = state_dir.map(Path::to_path_buf);
    let Some(payload) = encode_line(record) else {
        return;
    };
    let (tx, rx) = mpsc::channel();
    if thread::Builder::new()
        .name("spellcast-hook-diag".into())
        .spawn(move || {
            stall_if_requested();
            let path = diag_file(state_dir.as_deref());
            write_record_fs(&path, &payload);
            let _ = tx.send(());
        })
        .is_err()
    {
        return;
    }
    let _ = rx.recv_timeout(DIAG_WRITE_WAIT);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::event::{HookEvent, SessionSource};
    use std::fs::OpenOptions as StdOpen;

    fn sample_event() -> HookEvent {
        HookEvent {
            hook_event_name: "SessionStart".into(),
            session_id: "sess-secret".into(),
            source: Some(SessionSource::Startup),
            is_subagent: false,
            child_skip: None,
        }
    }

    fn ok_record() -> DiagRecord {
        let mut rec = DiagRecord::new();
        rec.parse = ParseOutcome::Ok;
        rec.http = HttpOutcome::NotAttempted;
        rec.missing_session = true;
        fill_event(&mut rec, &sample_event());
        rec
    }

    #[test]
    fn session_hash_is_not_raw_id() {
        let h = session_hash("session/中文-secret");
        assert_eq!(h.len(), 16);
        assert!(!h.contains("session"));
        assert!(!h.contains("secret"));
        assert!(!h.contains("中文"));
    }

    #[test]
    fn http_not_attempted_is_distinct_from_transport() {
        assert_ne!(HttpOutcome::NotAttempted, HttpOutcome::Transport);
    }

    #[test]
    fn unsupported_parse_name_is_not_fail() {
        assert_eq!(parse_name(ParseOutcome::Unsupported), "unsupported_event");
        assert_eq!(parse_name(ParseOutcome::Fail), "fail");
    }

    #[test]
    fn write_record_caps_file_and_survives_bad_dir() {
        let dir = std::env::temp_dir().join(format!(
            "spellcast-hook-diag-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let rec = ok_record();
        for _ in 0..8 {
            write_record(Some(&dir), &rec);
        }
        let raw = fs::read_to_string(dir.join("diag.jsonl")).unwrap();
        assert!(raw.contains("\"http\":\"not_attempted\""));
        assert!(raw.contains("\"missing_session\":true"));
        assert!(!raw.contains("sess-secret"));
        assert!(!raw.contains("BOOTSTRAP"));
        let file_as_dir = dir.join("not-a-dir");
        fs::write(&file_as_dir, b"x").unwrap();
        write_record(Some(&file_as_dir), &rec);
        let huge = dir.join("diag.jsonl");
        fs::write(&huge, vec![b'x'; (DIAG_LIMIT as usize) + 10]).unwrap();
        write_record(Some(&dir), &rec);
        assert!(fs::metadata(&huge).unwrap().len() < DIAG_LIMIT);
        for line in fs::read_to_string(&huge).unwrap().lines() {
            if line.is_empty() {
                continue;
            }
            let v: serde_json::Value = serde_json::from_str(line).unwrap();
            assert!(v.get("prompt").is_none());
            assert!(v.get("transcript").is_none());
            assert!(v.get("cwd").is_none());
        }
    }

    #[test]
    fn write_record_skips_when_lock_held() {
        let dir = std::env::temp_dir().join(format!(
            "spellcast-hook-diag-lock-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("diag.jsonl");
        fs::write(&path, b"keep\n").unwrap();
        let file = StdOpen::new()
            .read(true)
            .write(true)
            .open(&path)
            .unwrap();
        fs2::FileExt::lock_exclusive(&file).unwrap();
        write_record(Some(&dir), &ok_record());
        drop(file);
        assert_eq!(fs::read_to_string(&path).unwrap(), "keep\n");
    }
}

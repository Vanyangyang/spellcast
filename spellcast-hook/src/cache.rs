use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::thread;
use std::time::{Duration, Instant};

use fs2::FileExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::event::HookEvent;
use crate::http::ObserverStatus;
use crate::policy::{decide, Action, CacheView, Decision};

pub const CACHE_READ_LIMIT: usize = 8 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CacheState {
    pub injected: bool,
    pub last_on: bool,
    pub last_available: bool,
    pub last_revision: u64,
    #[serde(default)]
    pub last_emit: Option<String>,
}

impl Default for CacheState {
    fn default() -> Self {
        Self {
            injected: false,
            last_on: false,
            last_available: false,
            last_revision: 0,
            last_emit: None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SaveOutcome {
    Saved,
    Unusable,
    SaveFailed,
    Busy,
}

pub fn cache_path(state_dir: &Path, endpoint: &str, session_id: &str) -> PathBuf {
    let mut hasher = Sha256::new();
    hasher.update(endpoint.as_bytes());
    hasher.update([0]);
    hasher.update(session_id.as_bytes());
    let digest = hasher.finalize();
    let name = digest.iter().map(|byte| format!("{byte:02x}")).collect::<String>();
    state_dir.join(format!("{name}.json"))
}

pub fn transact(
    state_dir: Option<&Path>,
    endpoint: &str,
    event: &HookEvent,
    status: Option<&ObserverStatus>,
    lock_wait: Duration,
) -> (Decision, SaveOutcome) {
    let Some(dir) = state_dir else {
        return (
            decide(event, status, CacheView::Unusable),
            SaveOutcome::Unusable,
        );
    };
    if dir.is_file() || (dir.exists() && !dir.is_dir()) {
        return (
            decide(event, status, CacheView::Unusable),
            SaveOutcome::Unusable,
        );
    }
    if let Err(_) = fs::create_dir_all(dir) {
        return (
            decide(event, status, CacheView::Unusable),
            SaveOutcome::Unusable,
        );
    }
    let path = cache_path(dir, endpoint, &event.session_id);
    let lock_path = path.with_extension("lock");
    let Ok(lock_file) = OpenOptions::new()
        .create(true)
        .read(true)
        .write(true)
        .open(&lock_path)
    else {
        return (
            decide(event, status, CacheView::Unusable),
            SaveOutcome::Unusable,
        );
    };
    if wait_lock(&lock_file, lock_wait).is_err() {
        return (
            decide(event, status, CacheView::Busy),
            SaveOutcome::Busy,
        );
    }
    let view = load_view(&path);
    let mut decision = decide(event, status, view.clone());
    if let Some(status) = status {
        if let CacheView::Present(existing) = &view {
            if status.policy_revision < existing.last_revision {
                decision.action = Action::Empty;
                decision.next_cache = Some(existing.clone());
            }
        }
    }
    if let Some(next) = decision.next_cache.as_mut() {
        if let CacheView::Present(existing) = &view {
            if existing.last_revision > next.last_revision {
                *next = existing.clone();
                decision.action = Action::Empty;
            }
        }
        match write_atomic(&path, next) {
            Ok(()) => (decision, SaveOutcome::Saved),
            Err(()) => {
                if event.hook_event_name == "UserPromptSubmit" {
                    decision.action = Action::Empty;
                }
                (decision, SaveOutcome::SaveFailed)
            }
        }
    } else {
        (decision, SaveOutcome::Saved)
    }
}

fn wait_lock(file: &File, budget: Duration) -> Result<(), ()> {
    let deadline = Instant::now() + budget;
    loop {
        match file.try_lock_exclusive() {
            Ok(()) => return Ok(()),
            Err(_) if Instant::now() < deadline => thread::sleep(Duration::from_millis(10)),
            Err(_) => return Err(()),
        }
    }
}

fn load_view(path: &Path) -> CacheView {
    if !path.exists() {
        return CacheView::Missing;
    }
    let Ok(mut file) = File::open(path) else {
        return CacheView::Corrupt;
    };
    let mut buf = Vec::new();
    let mut chunk = [0u8; 1024];
    loop {
        let Ok(n) = file.read(&mut chunk) else {
            return CacheView::Corrupt;
        };
        if n == 0 {
            break;
        }
        if buf.len() + n > CACHE_READ_LIMIT {
            return CacheView::Corrupt;
        }
        buf.extend_from_slice(&chunk[..n]);
    }
    match serde_json::from_slice::<CacheState>(&buf) {
        Ok(state) => CacheView::Present(state),
        Err(_) => CacheView::Corrupt,
    }
}

fn write_atomic(path: &Path, state: &CacheState) -> Result<(), ()> {
    let tmp = path.with_extension("tmp");
    {
        let mut file = File::create(&tmp).map_err(|_| ())?;
        let payload = serde_json::to_vec(state).map_err(|_| ())?;
        file.write_all(&payload).map_err(|_| ())?;
        file.sync_all().map_err(|_| ())?;
    }
    fs::rename(&tmp, path).map_err(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::event::{HookEvent, SessionSource};
    use crate::http::ObserverStatus;

    fn on(rev: u64) -> ObserverStatus {
        ObserverStatus {
            enabled: true,
            paused: false,
            allowed: true,
            reason: "ok".into(),
            policy_revision: rev,
        }
    }

    fn startup() -> HookEvent {
        HookEvent {
            hook_event_name: "SessionStart".into(),
            session_id: "s1".into(),
            source: Some(SessionSource::Startup),
            is_subagent: false,
            child_skip: None,
        }
    }

    fn prompt() -> HookEvent {
        HookEvent {
            hook_event_name: "UserPromptSubmit".into(),
            session_id: "s1".into(),
            source: None,
            is_subagent: false,
            child_skip: None,
        }
    }

    #[test]
    fn cache_name_is_hashed_not_raw_id() {
        let path = cache_path(Path::new("/tmp"), "http://127.0.0.1:47194/api/observer/status", "session/中文");
        let name = path.file_name().unwrap().to_string_lossy();
        assert!(!name.contains("session"));
        assert!(!name.contains("中文"));
        assert!(name.ends_with(".json"));
    }

    #[test]
    fn concurrent_transactions_emit_at_most_one_bootstrap() {
        let dir = std::env::temp_dir().join(format!("spellcast-hook-tx-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let status = on(1);
        let start = startup();
        let first_prompt = prompt();
        let results = std::thread::scope(|scope| {
            let a = scope.spawn(|| transact(Some(&dir), "http://127.0.0.1:9/api", &start, Some(&status), Duration::from_millis(400)));
            let b = scope.spawn(|| transact(Some(&dir), "http://127.0.0.1:9/api", &first_prompt, Some(&status), Duration::from_millis(400)));
            vec![a.join().unwrap(), b.join().unwrap()]
        });
        let bootstraps = results
            .iter()
            .filter(|(d, _)| d.action == Action::Bootstrap)
            .count();
        assert_eq!(bootstraps, 1, "{results:?}");
        assert!(results.iter().all(|(_, o)| *o == SaveOutcome::Saved));
    }

    #[test]
    fn file_as_state_dir_is_unusable() {
        let path = std::env::temp_dir().join(format!("spellcast-hook-file-{}", std::process::id()));
        fs::write(&path, b"not-a-dir").unwrap();
        let (d, o) = transact(Some(&path), "http://127.0.0.1:9/api", &prompt(), Some(&on(1)), Duration::from_millis(50));
        assert_eq!(d.action, Action::Empty);
        assert_eq!(o, SaveOutcome::Unusable);
    }

    fn off(rev: u64) -> ObserverStatus {
        ObserverStatus {
            enabled: false,
            paused: false,
            allowed: false,
            reason: "disabled".into(),
            policy_revision: rev,
        }
    }

    #[test]
    fn stale_http_does_not_emit_or_downgrade_cache() {
        let dir = std::env::temp_dir().join(format!("spellcast-hook-stale-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let ep = "http://127.0.0.1:9/api";
        let (first, _) = transact(Some(&dir), ep, &startup(), Some(&on(6)), Duration::from_millis(200));
        assert_eq!(first.action, Action::Bootstrap);
        let (late_off, _) = transact(Some(&dir), ep, &prompt(), Some(&off(5)), Duration::from_millis(200));
        assert_eq!(late_off.action, Action::Empty);
        assert!(late_off.next_cache.as_ref().unwrap().injected);
        assert_eq!(late_off.next_cache.as_ref().unwrap().last_revision, 6);
        let (off_now, _) = transact(Some(&dir), ep, &prompt(), Some(&off(7)), Duration::from_millis(200));
        assert_eq!(off_now.action, Action::Stop);
        let (late_on, _) = transact(Some(&dir), ep, &startup(), Some(&on(5)), Duration::from_millis(200));
        assert_eq!(late_on.action, Action::Empty);
        assert!(!late_on.next_cache.as_ref().unwrap().injected);
        assert_eq!(late_on.next_cache.as_ref().unwrap().last_revision, 7);
    }

    #[test]
    fn write_atomic_failure_keeps_prompts_empty() {
        let dir = std::env::temp_dir().join(format!("spellcast-hook-tmpfail-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let ep = "http://127.0.0.1:9/api";
        let path = cache_path(&dir, ep, "s1");
        fs::create_dir_all(path.with_extension("tmp")).unwrap();
        let first = transact(Some(&dir), ep, &prompt(), Some(&on(1)), Duration::from_millis(200));
        let second = transact(Some(&dir), ep, &prompt(), Some(&on(1)), Duration::from_millis(200));
        assert_eq!(first.0.action, Action::Empty);
        assert_eq!(first.1, SaveOutcome::SaveFailed);
        assert_eq!(second.0.action, Action::Empty);
        assert_eq!(second.1, SaveOutcome::SaveFailed);
    }
}

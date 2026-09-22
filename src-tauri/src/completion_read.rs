//! Read Codex's persisted unread state without changing any Codex files.
//! Reconcile read transitions and fresh post-completion snapshots without trusting stale absence.
use std::{collections::{HashMap, HashSet}, fs::{self, File}, io::Read,
    path::{Path, PathBuf}, time::{Duration, Instant, SystemTime, UNIX_EPOCH}};
use rusqlite::params;
use serde::Deserialize;
use crate::completion_hook::{self, Completion};

#[derive(Deserialize)]
struct GlobalState {
    #[serde(rename = "electron-thread-read-state-v1")]
    read: ReadState,
}

#[derive(Deserialize)]
struct ReadState {
    version: u32,
    #[serde(rename = "unreadByIdentity")]
    identities: HashMap<String, HashMap<String, HashSet<String>>>,
}

const MAX_STATE_BYTES: u64 = 16 * 1024 * 1024;
const RECHECK_AFTER: Duration = Duration::from_secs(30);
// The notify hook can run before Codex publishes the turn's unread state.
const READ_STATE_SETTLE_MS: u64 = 3_000;

fn unix_ms(time: SystemTime) -> Option<u64> {
    time.duration_since(UNIX_EPOCH).ok().map(|value| value.as_millis() as u64)
}

#[derive(PartialEq)]
struct FileStamp { bytes: u64, modified: SystemTime }
impl FileStamp {
    fn read(path: &Path) -> Option<Self> {
        let metadata = fs::metadata(path).ok()?;
        Some(Self { bytes: metadata.len(), modified: metadata.modified().ok()? })
    }
}

struct Checked {
    root: PathBuf,
    home: PathBuf,
    stamp: FileStamp,
    turns: Vec<(String, String)>,
    at: Instant,
    recheck_after: Duration,
}

/// Owned by the notification worker. Retains only file metadata and turn IDs.
#[derive(Default)]
pub struct ReadSync { checked: Option<Checked> }
impl ReadSync {
    pub fn synchronize(&mut self, root: &Path, home: &Path, items: &[Completion]) -> Result<bool, String> {
        if items.is_empty() { self.checked = None; return Ok(false); }
        let path = home.join(".codex-global-state.json");
        let stamp = FileStamp::read(&path);
        if let (Some(stamp), Some(previous)) = (&stamp, &self.checked) {
            if previous.root == root && previous.home == home && previous.stamp == *stamp
                && previous.at.elapsed() < previous.recheck_after && previous.turns.len() == items.len()
                && previous.turns.iter().zip(items).all(|((thread, turn), item)|
                    *thread == item.thread_id && *turn == item.turn_id) {
                // Unchanged: no JSON read/parse, inbox connection, or SQL transaction.
                return Ok(false);
            }
        }
        let Some(state) = snapshot(home) else { self.checked = None; return Ok(false); };
        let after = FileStamp::read(&path);
        let stable = matches!((&stamp, &after), (Some(before), Some(after)) if before == after);
        let saved_at_ms = stable.then(|| stamp.as_ref().and_then(|stamp| unix_ms(stamp.modified))).flatten();
        let now_ms = unix_ms(SystemTime::now()).unwrap_or(0);
        let dismissed = synchronize_state(root, &state, items, saved_at_ms, now_ms)?;
        // Do not cache a read that overlapped a file replacement. Periodically
        // recheck even identical metadata for filesystems with coarse timestamps.
        self.checked = match (stamp, after) {
            (Some(before), Some(after)) if before == after => Some(Checked {
                root: root.into(), home: home.into(), stamp: after,
                turns: items.iter().map(|i| (i.thread_id.clone(), i.turn_id.clone())).collect(),
                at: Instant::now(),
                recheck_after: items.iter().filter_map(|item| {
                    let due = item.completed_at_ms.saturating_add(READ_STATE_SETTLE_MS);
                    (due > now_ms).then(|| Duration::from_millis(due - now_ms))
                }).min().unwrap_or(RECHECK_AFTER).min(RECHECK_AFTER),
            }),
            _ => None,
        };
        Ok(dismissed)
    }
}

fn snapshot(home: &Path) -> Option<ReadState> {
    // Codex replaces this file atomically. Missing, partial, or future formats
    // must not turn an unavailable signal into an empty (all-read) list.
    let file = File::open(home.join(".codex-global-state.json")).ok()?;
    if file.metadata().ok()?.len() > MAX_STATE_BYTES { return None; }
    let mut bytes = Vec::new();
    file.take(MAX_STATE_BYTES + 1).read_to_end(&mut bytes).ok()?;
    if bytes.len() as u64 > MAX_STATE_BYTES { return None; }
    let state: GlobalState = serde_json::from_slice(&bytes).ok()?;
    (state.read.version == 1).then_some(state.read)
}

fn synchronize_state(root: &Path, state: &ReadState, items: &[Completion], saved_at_ms: Option<u64>, now_ms: u64) -> Result<bool, String> {
    let mut db = completion_hook::inbox(root)?;
    db.execute_batch("CREATE TABLE IF NOT EXISTS completion_unread_observations (
        thread_id TEXT NOT NULL, turn_id TEXT NOT NULL,
        identity_key TEXT NOT NULL, host_key TEXT NOT NULL, seen_unread INTEGER NOT NULL DEFAULT 1,
        PRIMARY KEY(thread_id, turn_id, identity_key, host_key));")
        .map_err(|e| e.to_string())?;
    // Existing observations all came from an actual unread state.
    let has_seen_unread: bool = db.query_row(
        "SELECT COUNT(*) > 0 FROM pragma_table_info('completion_unread_observations') WHERE name='seen_unread'",
        [], |row| row.get(0)).map_err(|e| e.to_string())?;
    if !has_seen_unread {
        db.execute("ALTER TABLE completion_unread_observations ADD COLUMN seen_unread INTEGER NOT NULL DEFAULT 1", [])
            .map_err(|e| e.to_string())?;
    }
    let tx = db.transaction().map_err(|e| e.to_string())?;
    let mut dismissed = false;
    for item in items {
        let mut unread = false;
        for (identity, hosts) in &state.identities {
            for (host, threads) in hosts {
                // Remote hosts have separate read state and cannot acknowledge a local hook.
                if !host.starts_with("local:") || !threads.contains(&item.thread_id) { continue; }
                unread = true;
                tx.execute("INSERT INTO completion_unread_observations
                    (thread_id,turn_id,identity_key,host_key,seen_unread) VALUES (?1,?2,?3,?4,1)
                    ON CONFLICT(thread_id,turn_id,identity_key,host_key) DO UPDATE SET seen_unread=1",
                    params![item.thread_id, item.turn_id, identity, host]).map_err(|e| e.to_string())?;
            }
        }
        if unread { continue; }
        let mut observations = {
            let mut query = tx.prepare("SELECT identity_key,host_key,seen_unread FROM completion_unread_observations
                WHERE thread_id=?1 AND turn_id=?2").map_err(|e| e.to_string())?;
            let rows = query.query_map(params![item.thread_id, item.turn_id],
                |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, bool>(2)?))).map_err(|e| e.to_string())?;
            rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?
        };
        if observations.is_empty() {
            // Pin the known local identity/host even if the user read the turn before
            // our first poll. Never replace these scopes after logout or a host change.
            for (identity, hosts) in &state.identities {
                for host in hosts.keys().filter(|host| host.starts_with("local:")) {
                    tx.execute("INSERT OR IGNORE INTO completion_unread_observations
                        (thread_id,turn_id,identity_key,host_key,seen_unread) VALUES (?1,?2,?3,?4,0)",
                        params![item.thread_id, item.turn_id, identity, host]).map_err(|e| e.to_string())?;
                    observations.push((identity.clone(), host.clone(), false));
                }
            }
        }
        let read_confirmed = observations.iter().any(|(_, _, seen)| *seen)
            || (saved_at_ms.is_some_and(|saved| saved > item.completed_at_ms)
                && now_ms >= item.completed_at_ms.saturating_add(READ_STATE_SETTLE_MS));
        // Logout or a changed host is unknown, not read. Persist observations so
        // opening a task while Spellcast is stopped can be reconciled on restart.
        if read_confirmed && !observations.is_empty() && observations.iter().all(|(identity, host, _)| {
            state.identities.get(identity).and_then(|hosts| hosts.get(host))
                .is_some_and(|threads| !threads.contains(&item.thread_id))
        }) {
            dismissed |= tx.execute("UPDATE completions SET dismissed=1 WHERE thread_id=?1 AND turn_id=?2 AND dismissed=0",
                params![item.thread_id, item.turn_id]).map_err(|e| e.to_string())? > 0;
        }
    }
    tx.execute("DELETE FROM completion_unread_observations AS o WHERE NOT EXISTS
        (SELECT 1 FROM completions c WHERE c.thread_id=o.thread_id AND c.turn_id=o.turn_id
         AND c.dismissed=0 AND NOT EXISTS (SELECT 1 FROM completions n
         WHERE n.thread_id=c.thread_id AND n.sequence>c.sequence))", []).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(dismissed)
}

#[cfg(test)]
fn synchronize(root: &Path, home: &Path, items: &[Completion]) -> Result<bool, String> {
    ReadSync::default().synchronize(root, home, items)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{fs, path::PathBuf};
    use serde_json::{json, Value};
    const THREAD: &str = "01a08f1a-30e0-7f02-a84f-5898148cca8e";
    const OTHER: &str = "12345678-1234-4234-9234-123456789abc";
    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!("spellcast-read-{}", uuid::Uuid::new_v4()));
            fs::create_dir_all(&path).unwrap(); Self(path)
        }
        fn capture(&self, thread: &str, turn: &str) {
            completion_hook::capture(&self.0, &json!({"type":"agent-turn-complete",
                "thread-id":thread,"turn-id":turn}).to_string()).unwrap();
        }
        fn state(&self, identities: Value) {
            fs::write(self.0.join(".codex-global-state.json"), json!({
                "electron-thread-read-state-v1":{"version":1,"unreadByIdentity":identities}
            }).to_string()).unwrap();
        }
        fn sync(&self) -> Vec<Completion> {
            synchronize(&self.0, &self.0, &completion_hook::pending(&self.0).unwrap()).unwrap();
            completion_hook::pending(&self.0).unwrap()
        }
        fn sync_at(&self, saved_at_ms: Option<u64>, now_ms: u64) -> Vec<Completion> {
            synchronize_state(&self.0, &snapshot(&self.0).unwrap(),
                &completion_hook::pending(&self.0).unwrap(), saved_at_ms, now_ms).unwrap();
            completion_hook::pending(&self.0).unwrap()
        }
    }
    impl Drop for Fixture { fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); } }

    #[test]
    fn missed_unread_transition_uses_a_fresh_read_snapshot_after_settling() {
        let f = Fixture::new(); f.capture(THREAD, "read-before-first-poll"); f.capture(OTHER, "unread");
        let completed = completion_hook::pending(&f.0).unwrap().iter()
            .find(|item| item.thread_id == THREAD).unwrap().completed_at_ms;
        f.state(json!({"account":{"local:host":[OTHER]}}));
        let original = fs::read(f.0.join(".codex-global-state.json")).unwrap();
        assert_eq!(f.sync_at(Some(completed + 1), completed + READ_STATE_SETTLE_MS - 1).len(), 2);
        // A new synchronizer also accepts the pinned scope after an app restart.
        let remaining = f.sync_at(Some(completed + 1), completed + READ_STATE_SETTLE_MS);
        assert_eq!(remaining.len(), 1); assert_eq!(remaining[0].thread_id, OTHER);
        assert_eq!(fs::read(f.0.join(".codex-global-state.json")).unwrap(), original);
    }

    #[test]
    fn absent_unread_in_an_old_or_unstable_snapshot_never_dismisses() {
        let f = Fixture::new(); f.capture(THREAD, "new");
        let completed = completion_hook::pending(&f.0).unwrap()[0].completed_at_ms;
        f.state(json!({"account":{"local:host":[]}}));
        for saved in [None, Some(completed - 1), Some(completed)] {
            assert_eq!(f.sync_at(saved, completed + 60_000).len(), 1);
        }
        assert!(f.sync_at(Some(completed + 1), completed + 60_000).is_empty());
    }

    #[test]
    fn missed_unread_observation_does_not_turn_logout_or_host_change_into_read() {
        let f = Fixture::new(); f.capture(THREAD, "new");
        let completed = completion_hook::pending(&f.0).unwrap()[0].completed_at_ms;
        f.state(json!({"account":{"local:host":[]}}));
        assert_eq!(f.sync_at(Some(completed + 1), completed).len(), 1);
        for scopes in [json!({}), json!({"different-account":{"local:host":[]}}),
            json!({"account":{"local:different":[]}}), json!({"account":{"ssh:remote":[]}})] {
            f.state(scopes);
            assert_eq!(f.sync_at(Some(completed + 2), completed + 60_000).len(), 1);
        }
        f.state(json!({"account":{"local:host":[]}}));
        assert!(f.sync_at(Some(completed + 3), completed + 60_000).is_empty());
    }

    #[test]
    fn unread_arriving_during_settling_is_preserved_until_read() {
        let f = Fixture::new(); f.capture(THREAD, "new");
        let completed = completion_hook::pending(&f.0).unwrap()[0].completed_at_ms;
        f.state(json!({"account":{"local:host":[]}}));
        assert_eq!(f.sync_at(Some(completed + 1), completed + 1).len(), 1);
        f.state(json!({"account":{"local:host":[THREAD]}}));
        assert_eq!(f.sync_at(Some(completed + 2), completed + 60_000).len(), 1);
        f.state(json!({"account":{"local:host":[]}}));
        assert!(f.sync_at(Some(completed + 3), completed + 60_000).is_empty());
    }

    #[test]
    fn settling_snapshot_is_rechecked_without_waiting_for_the_long_cache() {
        let f = Fixture::new(); f.capture(THREAD, "new");
        f.state(json!({"account":{"local:host":[]}}));
        let items = completion_hook::pending(&f.0).unwrap();
        let mut sync = ReadSync::default();
        assert!(!sync.synchronize(&f.0, &f.0, &items).unwrap());
        assert!(sync.checked.as_ref().unwrap().recheck_after <= Duration::from_millis(READ_STATE_SETTLE_MS));
    }

    #[test]
    fn legacy_unread_observations_keep_their_read_receipt_on_upgrade() {
        let f = Fixture::new(); f.capture(THREAD, "old");
        let db = completion_hook::inbox(&f.0).unwrap();
        db.execute_batch("CREATE TABLE completion_unread_observations (
            thread_id TEXT NOT NULL, turn_id TEXT NOT NULL, identity_key TEXT NOT NULL, host_key TEXT NOT NULL,
            PRIMARY KEY(thread_id,turn_id,identity_key,host_key));").unwrap();
        db.execute("INSERT INTO completion_unread_observations VALUES (?1,'old','account','local:host')", [THREAD]).unwrap();
        drop(db);
        f.state(json!({"account":{"local:host":[]}}));
        assert!(f.sync().is_empty());
    }

    #[test]
    fn read_transition_dismisses_only_matching_task_and_survives_restart() {
        let f = Fixture::new(); f.capture(THREAD, "one"); f.capture(OTHER, "other");
        f.state(json!({"account":{"local:host":[THREAD,OTHER]}}));
        assert_eq!(f.sync().len(), 2);
        f.state(json!({"account":{"local:host":[OTHER]}}));
        let before = fs::read(f.0.join(".codex-global-state.json")).unwrap();
        // Each call opens a new connection; the receipt is entirely durable.
        let pending = f.sync(); assert_eq!(pending.len(), 1); assert_eq!(pending[0].thread_id, OTHER);
        assert_eq!(f.sync(), pending);
        assert_eq!(fs::read(f.0.join(".codex-global-state.json")).unwrap(), before);
    }

    #[test]
    fn unknown_or_unavailable_state_never_acknowledges() {
        let f = Fixture::new(); f.capture(THREAD, "one");
        f.state(json!({"account":{"local:host":[]}})); assert_eq!(f.sync().len(), 1);
        f.state(json!({"account":{"local:host":[THREAD]}})); f.sync();
        for data in ["{", "{}", r#"{"electron-thread-read-state-v1":{"version":2,"unreadByIdentity":{}}}"#,
            r#"{"electron-thread-read-state-v1":{"version":1,"unreadByIdentity":{"account":{"local:host":null}}}}"#] {
            fs::write(f.0.join(".codex-global-state.json"), data).unwrap();
            assert_eq!(f.sync().len(), 1);
        }
        fs::remove_file(f.0.join(".codex-global-state.json")).unwrap(); assert_eq!(f.sync().len(), 1);
        for scopes in [json!({}), json!({"different-account":{"local:host":[]}}),
            json!({"account":{"local:different-host":[]}})] {
            f.state(scopes); assert_eq!(f.sync().len(), 1);
        }
        f.state(json!({"account":{"local:host":[]}})); assert!(f.sync().is_empty());
    }

    #[test]
    fn stale_read_receipt_cannot_dismiss_a_new_completion() {
        let f = Fixture::new(); f.capture(THREAD, "one");
        f.state(json!({"account":{"local:host":[THREAD]}})); f.sync();
        let old = completion_hook::pending(&f.0).unwrap();
        f.state(json!({"account":{"local:host":[]}})); f.capture(THREAD, "two");
        synchronize(&f.0, &f.0, &old).unwrap();
        assert_eq!(f.sync()[0].turn_id, "two");
        f.state(json!({"account":{"local:host":[THREAD]}})); f.sync();
        f.state(json!({"account":{"local:host":[]}})); assert!(f.sync().is_empty());
        f.capture(THREAD, "three"); assert_eq!(f.sync()[0].turn_id, "three");
    }

    #[test]
    fn remote_state_is_ignored_and_other_local_scopes_preserve_unread() {
        let f = Fixture::new(); f.capture(THREAD, "one");
        f.state(json!({"account":{"ssh:remote":[THREAD]}})); f.sync();
        f.state(json!({"account":{"ssh:remote":[]}})); assert_eq!(f.sync().len(), 1);
        f.state(json!({"account":{"local:a":[THREAD],"local:b":[THREAD]}})); f.sync();
        f.state(json!({"account":{"local:a":[],"local:b":[THREAD]}})); assert_eq!(f.sync().len(), 1);
        f.state(json!({"account":{"local:a":[],"local:b":[],"ssh:remote":[THREAD]}}));
        assert!(f.sync().is_empty());
    }

    #[test]
    fn unchanged_poll_skips_the_inbox_and_file_change_is_seen_immediately() {
        let f = Fixture::new(); f.capture(THREAD, "one");
        f.state(json!({"account":{"local:host":[THREAD]}}));
        let items = completion_hook::pending(&f.0).unwrap();
        let mut sync = ReadSync::default();
        assert!(!sync.synchronize(&f.0, &f.0, &items).unwrap());
        let db = completion_hook::inbox(&f.0).unwrap();
        db.execute_batch("BEGIN EXCLUSIVE").unwrap();
        // A cached check succeeds even while another connection prevents any SQL access.
        assert!(!sync.synchronize(&f.0, &f.0, &items).unwrap());
        db.execute_batch("ROLLBACK").unwrap(); drop(db);
        f.state(json!({"account":{"local:host":[]}}));
        assert!(sync.synchronize(&f.0, &f.0, &items).unwrap());
        assert!(completion_hook::pending(&f.0).unwrap().is_empty());
    }

    #[test]
    fn new_turn_invalidates_cache_even_when_codex_file_is_unchanged() {
        let f = Fixture::new(); f.capture(THREAD, "one");
        f.state(json!({"account":{"local:host":[THREAD]}}));
        let mut sync = ReadSync::default();
        sync.synchronize(&f.0, &f.0, &completion_hook::pending(&f.0).unwrap()).unwrap();
        f.capture(THREAD, "two");
        let items = completion_hook::pending(&f.0).unwrap();
        sync.synchronize(&f.0, &f.0, &items).unwrap();
        let db = completion_hook::inbox(&f.0).unwrap();
        let count: i64 = db.query_row("SELECT COUNT(*) FROM completion_unread_observations WHERE turn_id='two'", [], |r| r.get(0)).unwrap();
        assert_eq!(count, 1); drop(db);
        f.state(json!({"account":{"local:host":[]}}));
        assert!(sync.synchronize(&f.0, &f.0, &items).unwrap());
    }

    #[test]
    fn periodic_recheck_handles_same_size_and_same_timestamp_changes() {
        let f = Fixture::new(); f.capture(THREAD, "one");
        f.state(json!({"account":{"local:host":[THREAD]}}));
        let items = completion_hook::pending(&f.0).unwrap();
        let mut sync = ReadSync::default();
        sync.synchronize(&f.0, &f.0, &items).unwrap();
        let path = f.0.join(".codex-global-state.json");
        let modified = sync.checked.as_ref().unwrap().stamp.modified;
        f.state(json!({"account":{"local:host":[OTHER]}}));
        File::options().write(true).open(&path).unwrap()
            .set_times(fs::FileTimes::new().set_modified(modified)).unwrap();
        assert!(FileStamp::read(&path).unwrap() == sync.checked.as_ref().unwrap().stamp);
        assert!(!sync.synchronize(&f.0, &f.0, &items).unwrap());
        sync.checked.as_mut().unwrap().at -= RECHECK_AFTER + Duration::from_secs(1);
        assert!(sync.synchronize(&f.0, &f.0, &items).unwrap());
    }
}

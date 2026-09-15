//! Quiet, offline completion speech. No titles or reply content leave the inbox.
use std::{collections::HashSet, path::Path, time::{SystemTime, UNIX_EPOCH}};
use rusqlite::{params, OptionalExtension, TransactionBehavior};
use serde::Serialize;
use crate::completion_hook::{self, Completion};

pub const COOLDOWN_MS: u64 = 90_000;
const MERGE_MS: u64 = 3_000;

#[derive(Serialize)]
pub struct VoiceSettings {
    pub enabled: bool,
    pub supported: bool,
    pub volume: u8,
    pub cooldown_seconds: u64,
    pub quiet_hours: &'static str,
}

fn preferences(root: &Path) -> Result<rusqlite::Connection, String> {
    let db = completion_hook::inbox(root)?;
    db.execute_batch("CREATE TABLE IF NOT EXISTS completion_preferences (
        key TEXT PRIMARY KEY, value INTEGER NOT NULL);")
        .map_err(|e| e.to_string())?;
    Ok(db)
}

pub fn settings(root: &Path) -> Result<VoiceSettings, String> {
    let db = preferences(root)?;
    let enabled: Option<bool> = db.query_row(
        "SELECT value FROM completion_preferences WHERE key='voice_enabled'", [], |row| row.get(0)
    ).optional().map_err(|e| e.to_string())?;
    Ok(VoiceSettings { enabled: enabled.unwrap_or(true), supported: cfg!(windows),
        volume: 25, cooldown_seconds: COOLDOWN_MS / 1000, quiet_hours: "22:00–08:00" })
}

pub fn set_enabled(root: &Path, enabled: bool) -> Result<VoiceSettings, String> {
    preferences(root)?.execute("INSERT INTO completion_preferences(key,value) VALUES ('voice_enabled',?1)
        ON CONFLICT(key) DO UPDATE SET value=excluded.value", [enabled]).map_err(|e| e.to_string())?;
    settings(root)
}

fn claim_slot(root: &Path, now: u64) -> Result<bool, String> {
    let mut db = preferences(root)?;
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate).map_err(|e| e.to_string())?;
    let last: Option<u64> = tx.query_row("SELECT value FROM completion_preferences WHERE key='last_voice_at'",
        [], |row| row.get(0)).optional().map_err(|e| e.to_string())?;
    if last.is_some_and(|last| now.saturating_sub(last) < COOLDOWN_MS) { return Ok(false); }
    tx.execute("INSERT INTO completion_preferences(key,value) VALUES ('last_voice_at',?1)
        ON CONFLICT(key) DO UPDATE SET value=excluded.value", params![now]).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(true)
}

pub fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64
}

#[cfg(windows)]
fn local_hour() -> u16 {
    let mut time = windows_sys::Win32::Foundation::SYSTEMTIME::default();
    unsafe { windows_sys::Win32::System::SystemInformation::GetLocalTime(&mut time); }
    time.wHour
}

#[cfg(not(windows))]
fn local_hour() -> u16 { 0 }

pub struct SpeechPolicy {
    started: u64,
    seen: HashSet<(String, String)>,
    pending: HashSet<(String, String)>,
    due: Option<u64>,
}

impl SpeechPolicy {
    pub fn new(started: u64) -> Self {
        Self { started, seen: HashSet::new(), pending: HashSet::new(), due: None }
    }

    fn ready(&mut self, items: &[Completion], now: u64, enabled: bool, hour: u16) -> bool {
        let quiet = !enabled || !(8..22).contains(&hour);
        let visible: HashSet<_> = items.iter().map(|item| (item.thread_id.clone(), item.turn_id.clone())).collect();
        self.pending.retain(|key| visible.contains(key));
        for item in items {
            let key = (item.thread_id.clone(), item.turn_id.clone());
            if self.seen.insert(key.clone()) && item.completed_at_ms > self.started && !quiet {
                self.pending.insert(key);
                self.due.get_or_insert(now.saturating_add(MERGE_MS));
            }
        }
        if quiet || self.pending.is_empty() { self.pending.clear(); self.due = None; return false; }
        if self.due.is_some_and(|due| now >= due) {
            self.pending.clear(); self.due = None;
            return true;
        }
        false
    }

    pub fn tick(&mut self, root: &Path, items: &[Completion]) -> Result<(), String> {
        let now = now_ms();
        let voice = settings(root)?;
        if self.ready(items, now, voice.enabled && voice.supported, local_hour()) && claim_slot(root, now)? {
            let root = root.to_owned();
            std::thread::spawn(move || {
                if let Err(err) = speak(&root) { eprintln!("Completion speech unavailable: {err}"); }
            });
        }
        Ok(())
    }
}

#[cfg(windows)]
pub fn speak(root: &Path) -> Result<(), String> {
    use std::{os::windows::process::CommandExt, process::{Command, Stdio}, time::{Duration, Instant}};
    // All command text is fixed. Task content is never interpolated into a shell or read aloud.
    const SCRIPT: &str = r#"
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
$completionVoice = New-Object System.Speech.Synthesis.SpeechSynthesizer
try {
    $completionVoice.Volume = 25
    $completionVoice.Rate = -1
    $chineseVoice = $completionVoice.GetInstalledVoices() | Where-Object { $_.Enabled -and $_.VoiceInfo.Culture.Name -like 'zh-*' } | Select-Object -First 1
    if ($chineseVoice) {
        $completionVoice.SelectVoice($chineseVoice.VoiceInfo.Name)
        $completionVoice.Speak('Codex 有任务完成了。')
    } else {
        $completionVoice.Speak('A Codex task is ready.')
    }
} finally { $completionVoice.Dispose() }
"#;
    if !settings(root)?.enabled || !(8..22).contains(&local_hour()) { return Ok(()); }
    let executable = std::env::var_os("SystemRoot").map(std::path::PathBuf::from)
        .ok_or("找不到 Windows 系统目录。")?.join("System32/WindowsPowerShell/v1.0/powershell.exe");
    let mut child = Command::new(executable).args(["-NoProfile", "-NonInteractive", "-Command", SCRIPT])
        .creation_flags(0x0800_0000).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null())
        .spawn().map_err(|e| e.to_string())?;
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return if status.success() { Ok(()) } else { Err("系统语音不可用；气泡仍然保留。".into()) },
            Ok(None) => {},
            Err(err) => { let _ = child.kill(); let _ = child.wait(); return Err(err.to_string()); }
        }
        if Instant::now() >= deadline {
            let _ = child.kill(); let _ = child.wait(); return Err("系统语音未及时结束，已停止播报。".into());
        }
        if !settings(root).map(|s| s.enabled).unwrap_or(false) {
            let _ = child.kill(); let _ = child.wait(); return Ok(());
        }
        std::thread::sleep(Duration::from_millis(150));
    }
}

#[cfg(not(windows))]
fn speak(_root: &Path) -> Result<(), String> { Ok(()) }

#[cfg(test)]
mod tests {
    use super::*;
    fn item(turn: &str, at: u64) -> Completion { Completion { thread_id: "thread".into(), turn_id: turn.into(),
        title: String::new(), summary: String::new(), project: String::new(), completed_at_ms: at } }
    #[test]
    fn completion_speech_merges_and_does_not_replay_restored_or_dismissed_items() {
        let mut policy=SpeechPolicy::new(100);
        assert!(!policy.ready(&[item("old",99)],101,true,12));
        assert!(!policy.ready(&[item("a",102)],102,true,12));
        assert!(!policy.ready(&[item("a",102),item("b",103)],103,true,12));
        assert!(policy.ready(&[item("a",102),item("b",103)],3102,true,12));
        assert!(!policy.ready(&[item("a",102),item("b",103)],6102,true,12));
        assert!(!policy.ready(&[item("c",6200)],6200,true,12));
        assert!(!policy.ready(&[],9500,true,12));
    }
    #[test]
    fn completion_speech_quiet_hours_and_mute_drop_backlog() {
        let mut policy=SpeechPolicy::new(100);
        assert!(!policy.ready(&[item("a",101)],101,true,22));
        assert!(!policy.ready(&[item("a",101)],10000,true,8));
        assert!(!policy.ready(&[item("b",10001)],10001,false,12));
        assert!(!policy.ready(&[item("b",10001)],14000,true,12));
        assert!(!policy.ready(&[item("c",14001)],14001,true,21));
        assert!(!policy.ready(&[item("c",14001)],18000,true,22));
        assert!(!policy.ready(&[item("c",14001)],100000,true,8));
    }
    #[test]
    fn completion_speech_settings_and_cooldown_survive_restart() {
        let p=std::env::temp_dir().join(format!("spellcast-voice-{}",uuid::Uuid::new_v4()));
        assert!(settings(&p).unwrap().enabled);
        set_enabled(&p,false).unwrap(); assert!(!settings(&p).unwrap().enabled);
        assert!(claim_slot(&p,100000).unwrap()); assert!(!claim_slot(&p,110000).unwrap());
        assert!(!claim_slot(&p,90000).unwrap()); assert!(claim_slot(&p,190000).unwrap());
        std::fs::remove_dir_all(p).unwrap();
    }
    #[cfg(windows)]
    #[test]
    #[ignore = "plays one quiet phrase through the Windows default audio device"]
    fn completion_voice_native_smoke() {
        assert!((8..22).contains(&local_hour()), "Respect quiet hours; run the audible smoke check during daytime.");
        let p=std::env::temp_dir().join(format!("spellcast-voice-smoke-{}",uuid::Uuid::new_v4()));
        speak(&p).unwrap();
        std::fs::remove_dir_all(p).unwrap();
    }
}

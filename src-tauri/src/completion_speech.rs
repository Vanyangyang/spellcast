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

pub const SPEECH_PHRASE_ZH: &str = "有任务完成了。";
pub const SPEECH_PHRASE_EN: &str = "A task is ready.";

const SCRIPT_ZH: &str = r#"
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
$completionVoice = New-Object System.Speech.Synthesis.SpeechSynthesizer
try {
    $completionVoice.Volume = 25
    $completionVoice.Rate = -1
    $match = $completionVoice.GetInstalledVoices() | Where-Object { $_.Enabled -and $_.VoiceInfo.Culture.Name -like 'zh-*' } | Select-Object -First 1
    if ($match) { $completionVoice.SelectVoice($match.VoiceInfo.Name) }
    $completionVoice.Speak('有任务完成了。')
} finally { $completionVoice.Dispose() }
"#;

const SCRIPT_EN: &str = r#"
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
$completionVoice = New-Object System.Speech.Synthesis.SpeechSynthesizer
try {
    $completionVoice.Volume = 25
    $completionVoice.Rate = -1
    $match = $completionVoice.GetInstalledVoices() | Where-Object { $_.Enabled -and $_.VoiceInfo.Culture.Name -like 'en-*' } | Select-Object -First 1
    if ($match) { $completionVoice.SelectVoice($match.VoiceInfo.Name) }
    $completionVoice.Speak('A task is ready.')
} finally { $completionVoice.Dispose() }
"#;

pub fn normalize_locale(raw: &str) -> &'static str {
    let lower = raw.trim().to_ascii_lowercase();
    if lower == "zh-cn" || lower == "zh" || lower.starts_with("zh-") {
        "zh-CN"
    } else {
        "en"
    }
}

pub fn speech_phrase(locale: &str) -> &'static str {
    if normalize_locale(locale) == "zh-CN" { SPEECH_PHRASE_ZH } else { SPEECH_PHRASE_EN }
}

pub fn powershell_script(locale: &str) -> &'static str {
    if normalize_locale(locale) == "zh-CN" { SCRIPT_ZH } else { SCRIPT_EN }
}

pub fn window_title(locale: &str) -> &'static str {
    if normalize_locale(locale) == "zh-CN" {
        "Spellcast · 已完成的任务"
    } else {
        "Spellcast · Completed tasks"
    }
}

fn preferences(root: &Path) -> Result<rusqlite::Connection, String> {
    let db = completion_hook::inbox(root)?;
    db.execute_batch("CREATE TABLE IF NOT EXISTS completion_preferences (
        key TEXT PRIMARY KEY, value INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS completion_text (
        key TEXT PRIMARY KEY, value TEXT NOT NULL);")
        .map_err(|e| e.to_string())?;
    Ok(db)
}

pub fn ui_locale(root: &Path) -> Result<&'static str, String> {
    let stored: Option<String> = preferences(root)?.query_row(
        "SELECT value FROM completion_text WHERE key='ui_locale'", [], |row| row.get(0)
    ).optional().map_err(|e| e.to_string())?;
    Ok(normalize_locale(stored.as_deref().unwrap_or("zh-CN")))
}

pub fn set_ui_locale(root: &Path, locale: &str) -> Result<&'static str, String> {
    let locale = normalize_locale(locale);
    preferences(root)?.execute(
        "INSERT INTO completion_text(key,value) VALUES ('ui_locale',?1)
         ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        [locale],
    ).map_err(|e| e.to_string())?;
    Ok(locale)
}

pub fn copy(root: &Path, zh: &str, en: &str) -> String {
    if ui_locale(root).ok() == Some("en") { en.to_string() } else { zh.to_string() }
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
    // Scripts are fixed per UI locale. Task content is never interpolated into a shell or read aloud.
    if !settings(root)?.enabled || !(8..22).contains(&local_hour()) { return Ok(()); }
    let script = powershell_script(ui_locale(root)?);
    let executable = std::env::var_os("SystemRoot").map(std::path::PathBuf::from)
        .ok_or_else(|| copy(root, "找不到 Windows 系统目录。", "Windows system directory was not found."))?
        .join("System32/WindowsPowerShell/v1.0/powershell.exe");
    let mut child = Command::new(executable).args(["-NoProfile", "-NonInteractive", "-Command", script])
        .creation_flags(0x0800_0000).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null())
        .spawn().map_err(|e| e.to_string())?;
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return if status.success() { Ok(()) } else {
                Err(copy(root, "系统语音不可用；气泡仍然保留。", "System speech is unavailable; the bubble stays."))
            },
            Ok(None) => {},
            Err(err) => { let _ = child.kill(); let _ = child.wait(); return Err(err.to_string()); }
        }
        if Instant::now() >= deadline {
            let _ = child.kill(); let _ = child.wait();
            return Err(copy(root, "系统语音未及时结束，已停止播报。", "System speech did not finish in time and was stopped."));
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
        title: String::new(), summary: String::new(), project: String::new(), completed_at_ms: at, client: "codex".into() } }
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
    #[test]
    fn completion_speech_follows_ui_locale() {
        assert_eq!(normalize_locale("ja"), "en");
        assert_eq!(normalize_locale("zh-TW"), "zh-CN");
        assert_eq!(speech_phrase("zh-CN"), SPEECH_PHRASE_ZH);
        assert_eq!(speech_phrase("en"), SPEECH_PHRASE_EN);
        assert!(powershell_script("zh-CN").contains(SPEECH_PHRASE_ZH));
        assert!(!powershell_script("zh-CN").contains(SPEECH_PHRASE_EN));
        assert!(powershell_script("en").contains(SPEECH_PHRASE_EN));
        assert!(!powershell_script("en").contains(SPEECH_PHRASE_ZH));
        let p=std::env::temp_dir().join(format!("spellcast-voice-locale-{}",uuid::Uuid::new_v4()));
        assert_eq!(ui_locale(&p).unwrap(), "zh-CN");
        assert_eq!(set_ui_locale(&p, "en").unwrap(), "en");
        assert_eq!(ui_locale(&p).unwrap(), "en");
        assert_eq!(window_title(ui_locale(&p).unwrap()), "Spellcast · Completed tasks");
        assert_eq!(set_ui_locale(&p, "zh-CN").unwrap(), "zh-CN");
        assert_eq!(window_title(ui_locale(&p).unwrap()), "Spellcast · 已完成的任务");
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

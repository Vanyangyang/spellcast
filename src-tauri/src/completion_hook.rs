//! Local Codex notify adapter. The Codex database is opened read-only; our inbox is separate.
use std::{fs, path::{Path, PathBuf}, process::Command, time::{Duration, SystemTime, UNIX_EPOCH}};
use rusqlite::{params, Connection, OpenFlags, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use toml_edit::{value, Array, ArrayOfTables, DocumentMut, Item, Table};

pub const CLIENT_CODEX: &str = "codex";
pub const CLIENT_GROK: &str = "grok";

fn default_client() -> String { CLIENT_CODEX.to_string() }

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Completion {
    pub thread_id: String,
    pub turn_id: String,
    pub title: String,
    pub summary: String,
    pub project: String,
    pub completed_at_ms: u64,
    /// Which host produced this completion: `codex` (notify hook) or `grok` (Grok Build notification hook).
    #[serde(default = "default_client")]
    pub client: String,
}

#[derive(Serialize, Deserialize)]
struct HookSettings { previous_notify: Vec<String> }

pub fn codex_home() -> Result<PathBuf, String> {
    std::env::var_os("CODEX_HOME").map(PathBuf::from).or_else(|| {
        std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME"))
            .map(|p| PathBuf::from(p).join(".codex"))
    }).ok_or_else(|| "找不到 Codex 用户目录。".into())
}

pub fn grok_home() -> Result<PathBuf, String> {
    std::env::var_os("GROK_HOME").map(PathBuf::from).or_else(|| {
        std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME"))
            .map(|p| PathBuf::from(p).join(".grok"))
    }).ok_or_else(|| "找不到 Grok Build 用户目录。".into())
}

pub fn root() -> Result<PathBuf, String> {
    Ok(std::env::var_os("SPELLCAST_COMPLETIONS_DIR").map(PathBuf::from)
        .unwrap_or(codex_home()?.join("spellcast/completions")))
}

pub(crate) fn inbox(root: &Path) -> Result<Connection, String> {
    fs::create_dir_all(root).map_err(|e| e.to_string())?;
    let db = Connection::open(root.join("inbox.sqlite3")).map_err(|e| e.to_string())?;
    db.busy_timeout(Duration::from_secs(3)).map_err(|e| e.to_string())?;
    db.execute_batch("CREATE TABLE IF NOT EXISTS completions (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        thread_id TEXT NOT NULL, turn_id TEXT NOT NULL, title TEXT NOT NULL,
        summary TEXT NOT NULL, project TEXT NOT NULL, completed_at_ms INTEGER NOT NULL,
        dismissed INTEGER NOT NULL DEFAULT 0, UNIQUE(thread_id, turn_id));
        CREATE INDEX IF NOT EXISTS completion_threads ON completions(thread_id, sequence);")
        .map_err(|e| e.to_string())?;
    // Inboxes created before Grok Build support only knew Codex completions.
    let has_client: bool = db.query_row(
        "SELECT COUNT(*) > 0 FROM pragma_table_info('completions') WHERE name='client'", [], |r| r.get(0)
    ).map_err(|e| e.to_string())?;
    if !has_client {
        db.execute_batch("ALTER TABLE completions ADD COLUMN client TEXT NOT NULL DEFAULT 'codex';")
            .map_err(|e| e.to_string())?;
    }
    Ok(db)
}

pub fn thread_url(id: &str) -> Result<String, String> {
    let parsed = uuid::Uuid::parse_str(id).map_err(|_| "Codex 任务标识无效。".to_string())?;
    if parsed.to_string() != id.to_ascii_lowercase() { return Err("Codex 任务标识无效。".into()); }
    Ok(format!("codex://threads/{parsed}"))
}

fn short(text: &str, limit: usize) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ").chars().take(limit).collect()
}

pub fn capture(root: &Path, raw: &str) -> Result<bool, String> {
    if raw.len() > 2 * 1024 * 1024 { return Err("完成通知过大。".into()); }
    let data: Value = serde_json::from_str(raw).map_err(|e| e.to_string())?;
    if data["type"] != "agent-turn-complete" { return Ok(false); }
    let thread = data["thread-id"].as_str().ok_or("完成通知缺少线程标识。")?.to_ascii_lowercase();
    thread_url(&thread)?;
    let turn = data["turn-id"].as_str().filter(|s| !s.is_empty() && s.len() <= 256)
        .ok_or("完成通知缺少轮次标识。")?;
    let title = data["input-messages"].as_array().and_then(|a| a.first()).and_then(Value::as_str).unwrap_or("Codex 任务");
    let summary = data["last-assistant-message"].as_str().unwrap_or("");
    let cwd = data["cwd"].as_str().unwrap_or("");
    let project = cwd.trim_end_matches(['/', '\\']).rsplit(['/', '\\']).next().unwrap_or("");
    let at = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64;
    let db = inbox(root)?;
    let inserted = db.execute("INSERT OR IGNORE INTO completions
        (thread_id,turn_id,title,summary,project,completed_at_ms,client) VALUES (?1,?2,?3,?4,?5,?6,?7)",
        params![thread,turn,short(title,100),short(summary,240),short(project,60),at,CLIENT_CODEX])
        .map_err(|e| e.to_string())?;
    Ok(inserted > 0)
}

/// What Spellcast can learn about a Grok Build session from `~/.grok/sessions/<cwd>/<id>/summary.json`.
#[derive(Default)]
struct GrokSession { title: String, cwd: String, last_turn: String }

fn grok_session(grok_home: &Path, session: &str) -> GrokSession {
    let Ok(dirs) = fs::read_dir(grok_home.join("sessions")) else { return GrokSession::default(); };
    for entry in dirs.filter_map(Result::ok) {
        let summary = entry.path().join(session).join("summary.json");
        let Ok(bytes) = fs::read(&summary) else { continue; };
        let Ok(data) = serde_json::from_slice::<Value>(&bytes) else { continue; };
        let pick = |keys: &[&str]| keys.iter().find_map(|k| data[*k].as_str()).map(str::trim)
            .filter(|s| !s.is_empty()).unwrap_or("").to_string();
        return GrokSession {
            title: pick(&["generated_title", "session_summary"]),
            cwd: data["info"]["cwd"].as_str().unwrap_or("").to_string(),
            last_turn: pick(&["last_turn_summary"]),
        };
    }
    GrokSession::default()
}

/// One Grok Build hook invocation, as seen by the `--grok-notify` helper.
///
/// The lifecycle `Stop` hook (`~/.grok/hooks/spellcast.json`) sets `GROK_HOOK_EVENT=stop` and pipes a
/// JSON envelope on stdin: `sessionId`, `cwd`, `promptId`, `reason` and `lastAssistantMessage`.
/// The older `[[ui.notifications.hooks]]` path sets `GROK_EVENT` / `GROK_MESSAGE` / `GROK_SESSION_ID`.
#[derive(Default, Debug, Clone, PartialEq)]
pub struct GrokHook {
    pub event: String,
    pub reason: String,
    pub session: String,
    pub message: String,
    pub cwd: String,
    pub prompt_id: String,
}

impl GrokHook {
    pub fn from_hook(env: &dyn Fn(&str) -> String, stdin: &str) -> GrokHook {
        let envelope: Value = serde_json::from_str(stdin).unwrap_or(Value::Null);
        let text = |key: &str| envelope[key].as_str().unwrap_or("").trim().to_string();
        let lifecycle = env("GROK_HOOK_EVENT");
        let event = if lifecycle.trim().is_empty() { env("GROK_EVENT") } else { lifecycle };
        let session = { let s = env("GROK_SESSION_ID"); if s.trim().is_empty() { text("sessionId") } else { s } };
        let message = { let m = text("lastAssistantMessage"); if m.is_empty() { env("GROK_MESSAGE") } else { m } };
        GrokHook { event, reason: text("reason"), session, message, cwd: text("cwd"), prompt_id: text("promptId") }
    }

    /// `Stop` fires again with `reason = shutdown` when the session ends; only a finished turn counts.
    fn is_completion(&self) -> bool {
        match self.event.trim() {
            "stop" => self.reason.is_empty() || self.reason == "end_turn",
            "turn_complete" | "task_complete" => true,
            _ => false,
        }
    }
}

fn project_of(cwd: &str) -> String {
    cwd.trim_end_matches(['/', '\\']).rsplit(['/', '\\']).next().unwrap_or("").to_string()
}

/// Turn a Grok Build hook into one completion bubble; the message is a bounded summary.
pub fn capture_grok(root: &Path, grok_home: &Path, hook: &GrokHook) -> Result<bool, String> {
    if !hook.is_completion() { return Ok(false); }
    let session = hook.session.trim().to_ascii_lowercase();
    if session.is_empty() { return Err("Grok 通知缺少会话标识。".into()); }
    if uuid::Uuid::parse_str(&session).map(|u| u.to_string() != session).unwrap_or(true) {
        return Err("Grok 会话标识无效。".into());
    }
    let meta = grok_session(grok_home, &session);
    let project = if hook.cwd.trim().is_empty() { project_of(&meta.cwd) } else { project_of(&hook.cwd) };
    // A brand-new session has no generated title yet; the project name reads better than a placeholder.
    let title = if !meta.title.is_empty() { meta.title } else if !project.is_empty() { project.clone() } else { "Grok Build".to_string() };
    let summary = if hook.message.trim().is_empty() { meta.last_turn } else { hook.message.clone() };
    let at = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64;
    let db = inbox(root)?;
    // turn_complete and task_complete can describe the same turn; keep one bubble.
    let duplicate: Option<(String, u64)> = db.query_row(
        "SELECT summary,completed_at_ms FROM completions WHERE thread_id=?1 ORDER BY sequence DESC LIMIT 1",
        [&session], |r| Ok((r.get(0)?, r.get(1)?))).optional().map_err(|e| e.to_string())?;
    if duplicate.is_some_and(|(last, when)| last == short(&summary, 240) && at.saturating_sub(when) < 5_000) {
        return Ok(false);
    }
    let prompt = hook.prompt_id.trim();
    let turn = if prompt.is_empty() || prompt.len() > 128 { format!("{}-{at}", hook.event.trim()) } else { format!("stop-{prompt}") };
    let inserted = db.execute("INSERT OR IGNORE INTO completions
        (thread_id,turn_id,title,summary,project,completed_at_ms,client) VALUES (?1,?2,?3,?4,?5,?6,?7)",
        params![session,turn,short(&title,100),short(&summary,240),short(&project,60),at,CLIENT_GROK])
        .map_err(|e| e.to_string())?;
    Ok(inserted > 0)
}

/// Entry point for `spellcast --grok-notify <root>`.
/// Nothing is written to stdout: a `Stop` hook's stdout is parsed by Grok as a decision.
pub fn grok_notify(root: &Path) {
    let env = |name: &str| std::env::var(name).unwrap_or_default();
    // Lifecycle hooks always pipe an envelope; notification hooks may leave stdin attached to a terminal.
    let mut stdin = String::new();
    if !env("GROK_HOOK_EVENT").trim().is_empty() {
        use std::io::Read;
        let _ = std::io::stdin().take(1024 * 1024).read_to_string(&mut stdin);
    }
    let hook = GrokHook::from_hook(&env, &stdin);
    let home = match grok_home() { Ok(home) => home, Err(err) => { eprintln!("{err}"); return; } };
    if let Err(err) = capture_grok(root, &home, &hook) {
        eprintln!("Spellcast Grok completion capture failed: {err}");
    }
}

pub fn pending(root: &Path) -> Result<Vec<Completion>, String> {
    let db = inbox(root)?;
    let mut query = db.prepare("SELECT thread_id,turn_id,title,summary,project,completed_at_ms,client
        FROM completions c WHERE dismissed=0 AND NOT EXISTS
        (SELECT 1 FROM completions newer WHERE newer.thread_id=c.thread_id AND newer.sequence>c.sequence)
        ORDER BY sequence DESC").map_err(|e| e.to_string())?;
    let rows = query.query_map([], |row| Ok(Completion {
        thread_id: row.get(0)?, turn_id: row.get(1)?, title: row.get(2)?, summary: row.get(3)?,
        project: row.get(4)?, completed_at_ms: row.get(5)?, client: row.get(6)?,
    })).map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

pub fn dismiss(root: &Path, thread: &str, turn: &str) -> Result<(), String> {
    // A click on an older card cannot dismiss a completion that arrived during the click.
    inbox(root)?.execute("UPDATE completions SET dismissed=1 WHERE thread_id=?1 AND turn_id=?2",
        params![thread, turn]).map_err(|e| e.to_string())?;
    Ok(())
}

pub fn activate(root: &Path, thread: &str, turn: &str, open: impl FnOnce(String) -> Result<(), String>) -> Result<(), String> {
    open(thread_url(thread)?)?;
    dismiss(root, thread, turn).map_err(|_| "Codex 已打开，但气泡未能移除，请点击 × 重试。".to_string())
}

fn thread_database(home: &Path) -> Option<PathBuf> {
    fs::read_dir(home).ok()?.filter_map(Result::ok).filter_map(|entry| {
        let name = entry.file_name().to_string_lossy().into_owned();
        let version: u32 = name.strip_prefix("state_")?.strip_suffix(".sqlite")?.parse().ok()?;
        Some((version, entry.path()))
    }).max_by_key(|(version, _)| *version).map(|(_, path)| path)
}

pub fn visible(root: &Path, home: &Path, read_sync: &mut crate::completion_read::ReadSync) -> Result<Vec<Completion>, String> {
    let candidates = pending(root)?;
    if candidates.is_empty() { return Ok(candidates); }
    // Grok Build completions carry their own metadata; Codex read state and thread DB do not apply.
    let (mut shown, mut codex): (Vec<_>, Vec<_>) = candidates.into_iter().partition(|c| c.client != CLIENT_CODEX);
    if !codex.is_empty() {
        if read_sync.synchronize(root, home, &codex)? {
            codex = pending(root)?.into_iter().filter(|c| c.client == CLIENT_CODEX).collect();
        }
        // Unknown identities stay queued until Codex has persisted their metadata.
        if let Some(path) = thread_database(home) {
            let db = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
                .map_err(|e| e.to_string())?;
            db.busy_timeout(Duration::from_millis(250)).map_err(|e| e.to_string())?;
            let mut query = db.prepare("SELECT title,source FROM threads WHERE id=?1").map_err(|e| e.to_string())?;
            for mut item in codex {
                let metadata: Option<(String,String)> = query.query_row([&item.thread_id], |r| Ok((r.get(0)?,r.get(1)?)))
                    .optional().map_err(|e| e.to_string())?;
                let Some((title, source)) = metadata else { continue; };
                if source.contains("subagent") { dismiss(root, &item.thread_id, &item.turn_id)?; continue; }
                if !title.trim().is_empty() { item.title = short(&title, 100); }
                shown.push(item);
            }
        }
    }
    shown.sort_by(|a, b| b.completed_at_ms.cmp(&a.completed_at_ms));
    Ok(shown)
}

fn settings(root: &Path) -> Result<HookSettings, String> {
    serde_json::from_slice(&fs::read(root.join("hook.json")).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())
}

pub fn notify(root: &Path, raw: &str) {
    // Forward the original argv exactly, without shell interpolation or changing notify semantics.
    if let Ok(config) = settings(root) {
        if let Some(exe) = config.previous_notify.first() {
            let mut command = Command::new(exe);
            command.args(&config.previous_notify[1..]).arg(raw);
            #[cfg(windows)] {
                use std::os::windows::process::CommandExt;
                command.creation_flags(0x0800_0000);
            }
            if let Err(err) = command.spawn() { eprintln!("Original Codex notification failed: {err}"); }
        }
    }
    if let Err(err) = capture(root, raw) { eprintln!("Spellcast completion capture failed: {err}"); }
}

pub fn install(home: &Path, root: &Path, executable: &Path) -> Result<String, String> {
    let config_path = home.join("config.toml");
    let text = fs::read_to_string(&config_path).map_err(|e| e.to_string())?;
    let mut doc = text.parse::<DocumentMut>().map_err(|e| e.to_string())?;
    let current = match doc.get("notify") {
        None => Vec::new(),
        Some(item) => item.as_array().ok_or("notify 必须是命令数组。")?.iter()
            .map(|v| v.as_str().map(str::to_owned).ok_or("notify 必须只包含字符串。"))
            .collect::<Result<Vec<_>, _>>()?,
    };
    let previous = if current.get(1).is_some_and(|v| v == "--codex-notify") {
        let old_root = current.get(2).ok_or("现有 Spellcast 通知配置不完整。")?;
        settings(Path::new(old_root))?.previous_notify
    } else { current };
    fs::create_dir_all(root).map_err(|e| e.to_string())?;
    // A stable helper copy keeps notification delivery independent of the development binary.
    let helper = helper_path(root);
    crate::configure::commit_with_backup(&helper, &fs::read(executable).map_err(|e| e.to_string())?)?;
    #[cfg(unix)] {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&helper, fs::Permissions::from_mode(0o700)).map_err(|e| e.to_string())?;
    }
    let next_settings = serde_json::to_vec_pretty(&HookSettings { previous_notify: previous }).map_err(|e| e.to_string())?;
    crate::configure::commit_with_backup(&root.join("hook.json"), &next_settings)?;
    let mut argv = Array::new();
    argv.push(helper.to_string_lossy().as_ref());
    argv.push("--codex-notify");
    argv.push(root.to_string_lossy().as_ref());
    doc["notify"] = value(argv);
    // Detect a config edit made while the helper was being copied.
    if fs::read_to_string(&config_path).map_err(|e| e.to_string())? != text {
        return Err("Codex 配置已被其他程序修改；未替换，请重试。".into());
    }
    crate::configure::commit_with_backup(&config_path, doc.to_string().as_bytes())?;
    Ok(format!("已安装完成通知：{}", config_path.display()))
}

pub fn uninstall(home: &Path, root: &Path) -> Result<String, String> {
    let path = home.join("config.toml");
    let text = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let mut doc = text.parse::<DocumentMut>().map_err(|e| e.to_string())?;
    let ours = doc.get("notify").and_then(|v| v.as_array()).is_some_and(|args|
        args.get(1).and_then(|v| v.as_str()) == Some("--codex-notify") &&
        args.get(2).and_then(|v| v.as_str()) == Some(root.to_string_lossy().as_ref()));
    if !ours { return Err("notify 已由其他配置接管，未修改。".into()); }
    let mut previous = Array::new();
    for arg in settings(root)?.previous_notify { previous.push(arg); }
    if previous.is_empty() { doc.remove("notify"); } else { doc["notify"] = value(previous); }
    crate::configure::commit_with_backup(&path, doc.to_string().as_bytes())?;
    Ok("已恢复原来的 Codex 完成通知。".into())
}

const GROK_NOTIFY_FLAG: &str = "--grok-notify";
/// Global lifecycle hooks under `~/.grok/hooks/*.json` are always trusted and fire in the TUI and headless.
const GROK_HOOK_FILE: &str = "spellcast.json";

/// Grok runs hook commands through PowerShell on Windows; forward slashes keep the paths intact
/// and a quoted path needs the call operator to be invoked rather than echoed.
fn slash(path: &Path) -> String {
    let text = path.to_string_lossy().replace('\\', "/");
    if text.contains(' ') { format!("\"{text}\"") } else { text }
}

fn helper_path(root: &Path) -> PathBuf {
    root.join(if cfg!(windows) { "spellcast-notify.exe" } else { "spellcast-notify" })
}

pub fn grok_hook_command(root: &Path) -> String {
    let helper = slash(&helper_path(root));
    let call = if cfg!(windows) && helper.starts_with('"') { "& " } else { "" };
    format!("{call}{helper} {GROK_NOTIFY_FLAG} {}", slash(root))
}

pub fn grok_hook_path(grok_home: &Path) -> PathBuf { grok_home.join("hooks").join(GROK_HOOK_FILE) }

fn grok_hook_document(root: &Path) -> Value {
    serde_json::json!({
        "hooks": {
            "Stop": [{
                "hooks": [{ "type": "command", "command": grok_hook_command(root), "timeout": 10 }]
            }]
        }
    })
}

fn hook_file_command(path: &Path) -> Option<String> {
    let doc: Value = serde_json::from_slice(&fs::read(path).ok()?).ok()?;
    doc["hooks"]["Stop"].as_array()?.iter()
        .filter_map(|group| group["hooks"].as_array())
        .flatten()
        .find_map(|hook| hook["command"].as_str().filter(|c| c.contains(GROK_NOTIFY_FLAG)).map(str::to_string))
}

/// Whether `~/.grok/hooks/spellcast.json` already runs this inbox's helper when a turn ends.
pub fn grok_hook_installed(grok_home: &Path, root: &Path) -> bool {
    hook_file_command(&grok_hook_path(grok_home)).as_deref() == Some(grok_hook_command(root).as_str())
        && helper_path(root).is_file()
}

fn is_spellcast_hook(table: &Table) -> bool {
    table.get("command").and_then(|v| v.as_str()).is_some_and(|c| c.contains(GROK_NOTIFY_FLAG))
}

/// Earlier builds registered a `[[ui.notifications.hooks]]` entry in `config.toml`; Grok's terminal
/// notifications never fired it on this platform. Remove only that entry, leaving every other key.
fn remove_legacy_notification_hook(grok_home: &Path) -> Result<bool, String> {
    let config_path = grok_home.join("config.toml");
    if !config_path.is_file() { return Ok(false); }
    let text = fs::read_to_string(&config_path).map_err(|e| e.to_string())?;
    let mut doc = text.parse::<DocumentMut>().map_err(|e| format!("Grok 配置不是有效 TOML：{e}"))?;
    let Some(hooks) = doc.get_mut("ui").and_then(|ui| ui.get_mut("notifications")).and_then(|n| n.get_mut("hooks"))
        .and_then(Item::as_array_of_tables_mut) else { return Ok(false); };
    let before = hooks.len();
    hooks.retain(|table| !is_spellcast_hook(table));
    if hooks.len() == before { return Ok(false); }
    if hooks.is_empty() {
        if let Some(n) = doc.get_mut("ui").and_then(|ui| ui.get_mut("notifications")).and_then(Item::as_table_mut) { n.remove("hooks"); }
    }
    let current = fs::read_to_string(&config_path).map_err(|e| e.to_string())?;
    if current != text { return Err("Grok 配置已被其他程序修改；未替换，请重试。".into()); }
    crate::configure::commit_with_backup(&config_path, doc.to_string().as_bytes())?;
    Ok(true)
}

/// Install `~/.grok/hooks/spellcast.json`: a `Stop` hook that captures Grok Build turn completions.
/// Nothing else under `~/.grok` is touched except the legacy notification entry, which is removed.
pub fn install_grok(grok_home: &Path, root: &Path, executable: &Path) -> Result<String, String> {
    fs::create_dir_all(root).map_err(|e| e.to_string())?;
    crate::configure::commit_with_backup(&helper_path(root), &fs::read(executable).map_err(|e| e.to_string())?)?;
    #[cfg(unix)] {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(helper_path(root), fs::Permissions::from_mode(0o700)).map_err(|e| e.to_string())?;
    }
    let hook_path = grok_hook_path(grok_home);
    fs::create_dir_all(hook_path.parent().unwrap_or(grok_home)).map_err(|e| e.to_string())?;
    let body = serde_json::to_string_pretty(&grok_hook_document(root)).map_err(|e| e.to_string())? + "\n";
    crate::configure::commit_with_backup(&hook_path, body.as_bytes())?;
    remove_legacy_notification_hook(grok_home)?;
    Ok(format!("已安装 Grok Build 完成通知：{}", hook_path.display()))
}

pub fn uninstall_grok(grok_home: &Path) -> Result<String, String> {
    let hook_path = grok_hook_path(grok_home);
    let had_file = hook_file_command(&hook_path).is_some();
    if had_file { fs::remove_file(&hook_path).map_err(|e| e.to_string())?; }
    let had_legacy = remove_legacy_notification_hook(grok_home)?;
    if !had_file && !had_legacy { return Err("Grok 里没有 Spellcast 完成通知，未修改。".into()); }
    Ok("已移除 Grok Build 完成通知。".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    const THREAD: &str = "01a08f1a-30e0-7f02-a84f-5898148cca8e";
    fn dir() -> PathBuf { let p=std::env::temp_dir().join(format!("spellcast-completion-{}", uuid::Uuid::new_v4())); fs::create_dir_all(&p).unwrap(); p }
    fn event(turn: &str) -> String { serde_json::json!({"type":"agent-turn-complete","thread-id":THREAD,"turn-id":turn,"cwd":"G:\\project","input-messages":["实现功能"],"last-assistant-message":"已完成"}).to_string() }
    #[test]
    fn completion_dedup_restart_and_dismiss_race() {
        let p=dir(); assert!(capture(&p,&event("one")).unwrap()); assert!(!capture(&p,&event("one")).unwrap());
        assert!(capture(&p,&event("two")).unwrap()); dismiss(&p,THREAD,"one").unwrap();
        let list=pending(&p).unwrap(); assert_eq!(list.len(),1); assert_eq!(list[0].turn_id,"two");
        dismiss(&p,THREAD,"two").unwrap(); assert!(pending(&p).unwrap().is_empty());
        assert!(!capture(&p,&event("two")).unwrap()); assert!(pending(&p).unwrap().is_empty());
        capture(&p,&event("three")).unwrap(); assert_eq!(pending(&p).unwrap().len(),1);
        fs::remove_dir_all(p).unwrap();
    }
    #[test]
    fn completion_ignores_non_completion_and_invalid_urls() {
        let p=dir(); assert!(!capture(&p,r#"{"type":"approval-requested"}"#).unwrap());
        assert!(capture(&p,r#"{"type":"agent-turn-complete","thread-id":"../../evil"}"#).is_err());
        assert!(thread_url("https://evil").is_err()); assert!(thread_url(&format!("{THREAD}?x=1")).is_err());
        assert_eq!(thread_url(THREAD).unwrap(),format!("codex://threads/{THREAD}"));
        fs::remove_dir_all(p).unwrap();
    }
    #[test]
    fn completion_open_dismisses_only_after_success_and_preserves_a_new_turn() {
        let p=dir(); capture(&p,&event("one")).unwrap();
        assert!(activate(&p,THREAD,"one",|_| Err("cannot open".into())).is_err());
        assert_eq!(pending(&p).unwrap().len(),1);
        activate(&p,THREAD,"one",|url| {
            assert_eq!(url,format!("codex://threads/{THREAD}"));
            capture(&p,&event("two")).unwrap(); Ok(())
        }).unwrap();
        assert_eq!(pending(&p).unwrap()[0].turn_id,"two");
        activate(&p,THREAD,"two",|_| Ok(())).unwrap();
        assert!(pending(&p).unwrap().is_empty());
        fs::remove_dir_all(p).unwrap();
    }
    #[test]
    fn completion_requires_root_thread_metadata() {
        let p=dir(); let root=p.join("inbox"); capture(&root,&event("one")).unwrap();
        let mut read_sync = crate::completion_read::ReadSync::default();
        assert!(visible(&root,&p,&mut read_sync).unwrap().is_empty());
        let db=Connection::open(p.join("state_5.sqlite")).unwrap();
        db.execute_batch("CREATE TABLE threads(id TEXT,title TEXT,source TEXT);").unwrap();
        db.execute("INSERT INTO threads VALUES (?1,'真实标题','vscode')",[THREAD]).unwrap();
        assert_eq!(visible(&root,&p,&mut read_sync).unwrap()[0].title,"真实标题");
        db.execute("UPDATE threads SET source=?1",[r#"{"subagent":{"other":"title"}}"#]).unwrap();
        assert!(visible(&root,&p,&mut read_sync).unwrap().is_empty()); drop(db); fs::remove_dir_all(p).unwrap();
    }
    #[test]
    fn completion_install_preserves_config_and_original_notify_on_reinstall() {
        let p=dir(); let root=p.join("completion"); let exe=p.join("fake.exe"); fs::write(&exe,b"test helper").unwrap();
        fs::write(p.join("config.toml"),"# user config\nmodel = 'keep'\nnotify = ['original.exe', 'argument with spaces']\n[hooks]\nenabled = true\n").unwrap();
        install(&p,&root,&exe).unwrap(); install(&p,&root,&exe).unwrap();
        let text=fs::read_to_string(p.join("config.toml")).unwrap(); assert!(text.contains("model = 'keep'")); assert!(text.contains("[hooks]"));
        assert_eq!(settings(&root).unwrap().previous_notify,vec!["original.exe","argument with spaces"]);
        assert!(p.join("config.toml.spellcast.bak").exists());
        uninstall(&p,&root).unwrap();
        let restored=fs::read_to_string(p.join("config.toml")).unwrap().parse::<DocumentMut>().unwrap();
        assert_eq!(restored["notify"][0].as_str(),Some("original.exe"));
        assert!(uninstall(&p,&root).is_err());
        fs::remove_dir_all(p).unwrap();
    }
    const GROK_SESSION: &str = "01a0b065-a7b3-71c1-917f-d1e2a211cde2";
    fn grok_home_fixture(p: &Path) -> PathBuf {
        let home = p.join("grok-home");
        let session = home.join("sessions").join("G%3A%5CDemos%5CPlatformer").join(GROK_SESSION);
        fs::create_dir_all(&session).unwrap();
        fs::write(session.join("summary.json"), serde_json::json!({
            "info": {"id": GROK_SESSION, "cwd": "G:\\Demos\\Platformer"},
            "generated_title": "平台跳跃：加金币与计分",
            "last_turn_summary": "Coins and score added"
        }).to_string()).unwrap();
        home
    }
    fn legacy(event: &str, message: &str, session: &str) -> GrokHook {
        GrokHook { event: event.into(), message: message.into(), session: session.into(), ..GrokHook::default() }
    }
    #[test]
    fn grok_completion_uses_session_metadata_and_is_visible_without_codex() {
        let p=dir(); let root=p.join("inbox"); let home=grok_home_fixture(&p);
        assert!(!capture_grok(&root,&home,&legacy("agent_error","boom",GROK_SESSION)).unwrap());
        assert!(capture_grok(&root,&home,&legacy("turn_complete","",GROK_SESSION)).is_ok());
        assert!(capture_grok(&root,&home,&legacy("turn_complete","x","not-a-session")).is_err());
        let list=pending(&root).unwrap(); assert_eq!(list.len(),1);
        assert_eq!(list[0].client,CLIENT_GROK); assert_eq!(list[0].thread_id,GROK_SESSION);
        assert_eq!(list[0].title,"平台跳跃：加金币与计分"); assert_eq!(list[0].summary,"Coins and score added");
        assert_eq!(list[0].project,"Platformer");
        // task_complete describing the same turn does not add a second bubble.
        assert!(!capture_grok(&root,&home,&legacy("task_complete","Coins and score added",GROK_SESSION)).unwrap());
        // No Codex thread database exists, yet Grok completions still show.
        let mut read_sync = crate::completion_read::ReadSync::default();
        let shown = visible(&root,&p.join("no-codex"),&mut read_sync).unwrap();
        assert_eq!(shown.len(),1); assert_eq!(shown[0].client,CLIENT_GROK);
        // A Codex completion without metadata stays hidden while the Grok one remains.
        capture(&root,&event("one")).unwrap();
        let shown = visible(&root,&p.join("no-codex"),&mut read_sync).unwrap();
        assert_eq!(shown.len(),1); assert_eq!(shown[0].client,CLIENT_GROK);
        dismiss(&root,GROK_SESSION,&shown[0].turn_id).unwrap();
        assert!(visible(&root,&p.join("no-codex"),&mut read_sync).unwrap().is_empty());
        fs::remove_dir_all(p).unwrap();
    }
    #[test]
    fn grok_completion_migrates_an_inbox_created_before_client_column() {
        let p=dir(); let root=p.join("inbox"); fs::create_dir_all(&root).unwrap();
        let db=Connection::open(root.join("inbox.sqlite3")).unwrap();
        db.execute_batch("CREATE TABLE completions (sequence INTEGER PRIMARY KEY AUTOINCREMENT,
            thread_id TEXT NOT NULL, turn_id TEXT NOT NULL, title TEXT NOT NULL, summary TEXT NOT NULL,
            project TEXT NOT NULL, completed_at_ms INTEGER NOT NULL, dismissed INTEGER NOT NULL DEFAULT 0,
            UNIQUE(thread_id, turn_id));
            INSERT INTO completions(thread_id,turn_id,title,summary,project,completed_at_ms) VALUES ('t','one','','','',1);").unwrap();
        drop(db);
        let list=pending(&root).unwrap(); assert_eq!(list.len(),1); assert_eq!(list[0].client,CLIENT_CODEX);
        fs::remove_dir_all(p).unwrap();
    }
    #[test]
    fn grok_stop_hook_envelope_counts_once_and_ignores_shutdown() {
        let p=dir(); let root=p.join("inbox"); let home=p.join("grok-home"); fs::create_dir_all(&home).unwrap();
        let session="01a0b2f3-fc97-7432-8a3e-e2a4bd689751";
        let env = |name: &str| -> String { match name { "GROK_HOOK_EVENT" => "stop".into(), "GROK_SESSION_ID" => session.into(), _ => String::new() } };
        let envelope = |reason: &str, prompt: &str| serde_json::json!({
            "hookEventName":"stop","sessionId":session,"cwd":"G:\\Demos\\Platformer","promptId":prompt,
            "reason":reason,"lastAssistantMessage":"Double jump added; canDoubleJump resets on landing."}).to_string();
        let hook = GrokHook::from_hook(&env, &envelope("end_turn","41676faa-10c7-4f09-88fd-f1742d435226"));
        assert_eq!(hook.event,"stop"); assert_eq!(hook.reason,"end_turn"); assert_eq!(hook.session,session);
        assert!(capture_grok(&root,&home,&hook).unwrap());
        // Grok fires Stop twice per hook run at shutdown; a second delivery of the same prompt is not a new bubble.
        assert!(!capture_grok(&root,&home,&hook).unwrap());
        assert!(!capture_grok(&root,&home,&GrokHook::from_hook(&env, &envelope("shutdown","x"))).unwrap());
        let list=pending(&root).unwrap(); assert_eq!(list.len(),1);
        assert_eq!(list[0].client,CLIENT_GROK); assert_eq!(list[0].project,"Platformer");
        // No summary.json yet: the project stands in for the title, the last assistant message is the summary.
        assert_eq!(list[0].title,"Platformer");
        assert_eq!(list[0].summary,"Double jump added; canDoubleJump resets on landing.");
        assert_eq!(list[0].turn_id,"stop-41676faa-10c7-4f09-88fd-f1742d435226");
        // Environment without stdin (legacy notification hook) still maps onto the same struct.
        let legacy_env = |name: &str| -> String { match name { "GROK_EVENT" => "turn_complete".into(), "GROK_MESSAGE" => "done".into(), "GROK_SESSION_ID" => session.into(), _ => String::new() } };
        let hook = GrokHook::from_hook(&legacy_env, "");
        assert_eq!(hook, GrokHook { event:"turn_complete".into(), message:"done".into(), session:session.into(), ..GrokHook::default() });
        fs::remove_dir_all(p).unwrap();
    }
    #[test]
    fn grok_hook_install_writes_stop_hook_file_and_removes_legacy_entry() {
        let p=dir(); let home=p.join("grok"); fs::create_dir_all(&home).unwrap();
        let root=p.join("completion"); let exe=p.join("fake.exe"); fs::write(&exe,b"helper").unwrap();
        let legacy = format!("[ui]\ntheme = \"dark\"\n\n[ui.notifications]\nmethod = \"auto\"\n\n[[ui.notifications.hooks]]\ncommand = \"powershell.exe -File C:/hooks/banner.ps1\"\nevents = [\"turn_complete\"]\n\n[[ui.notifications.hooks]]\ncommand = \"{}\"\nevents = [\"turn_complete\"]\n\n[mcp_servers.other]\nurl = \"http://other\"\n", grok_hook_command(&root));
        fs::write(home.join("config.toml"), &legacy).unwrap();
        assert!(!grok_hook_installed(&home,&root));
        install_grok(&home,&root,&exe).unwrap(); install_grok(&home,&root,&exe).unwrap();
        assert!(grok_hook_installed(&home,&root));
        assert_eq!(fs::read(helper_path(&root)).unwrap(),b"helper");
        let hook_text=fs::read_to_string(grok_hook_path(&home)).unwrap();
        let doc: Value = serde_json::from_str(&hook_text).unwrap();
        let stop=&doc["hooks"]["Stop"][0]["hooks"][0];
        assert_eq!(stop["type"],"command"); assert_eq!(stop["timeout"],10);
        assert_eq!(stop["command"].as_str().unwrap(),grok_hook_command(&root));
        assert!(!stop["command"].as_str().unwrap().contains('\\'), "hook command must use forward slashes: {hook_text}");
        // The legacy notification entry is gone; the user's own hook and every other table survive.
        let text=fs::read_to_string(home.join("config.toml")).unwrap();
        assert!(text.contains("theme = \"dark\"")); assert!(text.contains("method = \"auto\"")); assert!(text.contains("[mcp_servers.other]"));
        assert!(text.contains("C:/hooks/banner.ps1")); assert!(!text.contains("--grok-notify"), "{text}");
        uninstall_grok(&home).unwrap();
        assert!(!grok_hook_path(&home).exists());
        assert!(uninstall_grok(&home).is_err());
        assert!(fs::read_to_string(home.join("config.toml")).unwrap().contains("C:/hooks/banner.ps1"));
        // No config.toml at all: the hook file is still written and nothing else appears.
        let bare=p.join("bare"); fs::create_dir_all(&bare).unwrap();
        install_grok(&bare,&root,&exe).unwrap();
        assert!(grok_hook_installed(&bare,&root)); assert!(!bare.join("config.toml").exists());
        // A path with spaces is quoted and invoked through the call operator.
        let spaced = grok_hook_command(Path::new("C:\\Users\\Jane Doe\\.codex\\spellcast\\completions"));
        assert!(spaced.contains("\"C:/Users/Jane Doe/.codex/spellcast/completions/spellcast-notify"), "{spaced}");
        if cfg!(windows) { assert!(spaced.starts_with("& \""), "{spaced}"); }
        fs::remove_dir_all(p).unwrap();
    }
}

//! Local Codex notify adapter. The Codex database is opened read-only; our inbox is separate.
use std::{fs, path::{Path, PathBuf}, process::Command, time::{Duration, SystemTime, UNIX_EPOCH}};
use rusqlite::{params, Connection, OpenFlags, OptionalExtension};
use serde::{de::{MapAccess, Visitor}, Deserialize, Deserializer, Serialize};
use serde_json::{value::RawValue, Value};
use toml_edit::{value, Array, ArrayOfTables, DocumentMut, Item, Table};

pub const CLIENT_CODEX: &str = "codex";
pub const CLIENT_GROK: &str = "grok";
pub const CLIENT_CLAUDE: &str = "claude";

fn default_client() -> String { CLIENT_CODEX.to_string() }

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Completion {
    pub thread_id: String,
    pub turn_id: String,
    pub title: String,
    pub summary: String,
    pub project: String,
    pub completed_at_ms: u64,
    /// Which host produced this completion: `codex` (notify hook), `grok` (Grok Build hook) or `claude` (Claude Code `Stop` hook).
    #[serde(default = "default_client")]
    pub client: String,
    /// Runtime only, never stored: the host that can take the user back to this task (`ccgui` for a Claude task
    /// whose CC GUI window is connected). Without it a card can only be closed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub host: Option<String>,
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

pub fn claude_home() -> Result<PathBuf, String> {
    std::env::var_os("CLAUDE_CONFIG_DIR").filter(|p| !p.is_empty()).map(PathBuf::from).or_else(|| {
        std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME"))
            .map(|p| PathBuf::from(p).join(".claude"))
    }).ok_or_else(|| "找不到 Claude Code 用户目录。".into())
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

pub(crate) fn short(text: &str, limit: usize) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ").chars().take(limit).collect()
}

/// `[label](target)` reads as just its label.
fn unlink(line: &str) -> String {
    let mut out = String::with_capacity(line.len());
    let mut rest = line;
    while let Some(open) = rest.find('[') {
        let after = &rest[open + 1..];
        let link = after.find("](").and_then(|mid| after[mid + 2..].find(')').map(|end| (mid, mid + 2 + end)));
        match link {
            Some((mid, end)) if !after[..mid].contains('[') => {
                out.push_str(&rest[..open]);
                out.push_str(&after[..mid]);
                rest = &after[end + 1..];
            }
            _ => { out.push_str(&rest[..=open]); rest = after; }
        }
    }
    out.push_str(rest);
    out
}

/// A model's reply as plain card text. The markdown it writes (headings, bullets, `**bold**`, backticks, links,
/// fenced code) is noise on a small card, and fenced code is not a summary.
pub(crate) fn plain(text: &str) -> String {
    let mut lines = Vec::new();
    let mut fenced = false;
    for line in text.lines() {
        let line = line.trim();
        if line.starts_with("```") { fenced = !fenced; continue; }
        if fenced || line.is_empty() || line.chars().all(|c| matches!(c, '|' | '-' | ':' | ' ' | '=' | '*' | '_')) { continue; }
        let line = line.trim_start_matches('>').trim_start();
        let line = line.trim_start_matches('#').trim_start();
        let line = ["- ", "* ", "+ "].iter().find_map(|bullet| line.strip_prefix(bullet)).unwrap_or(line);
        lines.push(unlink(line).replace("**", "").replace('`', "").replace('|', " "));
    }
    lines.join(" ").split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Card summary: plain text of at most `limit` characters, ending in an ellipsis when it was cut.
pub(crate) fn brief(text: &str, limit: usize) -> String {
    let flat = short(&plain(text), usize::MAX);
    if flat.chars().count() <= limit { return flat; }
    let mut cut: String = flat.chars().take(limit.saturating_sub(1)).collect();
    cut.truncate(cut.trim_end().len());
    cut.push('…');
    cut
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
        params![thread,turn,short(title,100),brief(summary,240),short(project,60),at,CLIENT_CODEX])
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

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64
}

/// The canonical lowercase UUID of a hook's session, or an error naming the host that sent a bad one.
fn session_uuid(raw: &str, host: &str) -> Result<String, String> {
    let session = raw.trim().to_ascii_lowercase();
    if session.is_empty() { return Err(format!("{host} 通知缺少会话标识。")); }
    if uuid::Uuid::parse_str(&session).map(|u| u.to_string() != session).unwrap_or(true) {
        return Err(format!("{host} 会话标识无效。"));
    }
    Ok(session)
}

/// A finished turn from a host that reports its own title and summary (Grok Build, Claude Code).
struct Hosted<'a> {
    client: &'a str, session: &'a str, turn: &'a str,
    title: &'a str, summary: &'a str, project: &'a str, at: u64,
}

fn record_hosted(root: &Path, item: &Hosted) -> Result<bool, String> {
    let db = inbox(root)?;
    // Two events can describe the same turn; keep one bubble.
    let duplicate: Option<(String, u64)> = db.query_row(
        "SELECT summary,completed_at_ms FROM completions WHERE thread_id=?1 ORDER BY sequence DESC LIMIT 1",
        [item.session], |r| Ok((r.get(0)?, r.get(1)?))).optional().map_err(|e| e.to_string())?;
    if duplicate.is_some_and(|(last, when)| last == brief(item.summary, 240) && item.at.saturating_sub(when) < 5_000) {
        return Ok(false);
    }
    let inserted = db.execute("INSERT OR IGNORE INTO completions
        (thread_id,turn_id,title,summary,project,completed_at_ms,client) VALUES (?1,?2,?3,?4,?5,?6,?7)",
        params![item.session,item.turn,short(item.title,100),brief(item.summary,240),short(item.project,60),item.at,item.client])
        .map_err(|e| e.to_string())?;
    Ok(inserted > 0)
}

/// Turn a Grok Build hook into one completion bubble; the message is a bounded summary.
pub fn capture_grok(root: &Path, grok_home: &Path, hook: &GrokHook) -> Result<bool, String> {
    if !hook.is_completion() { return Ok(false); }
    let session = session_uuid(&hook.session, "Grok")?;
    let meta = grok_session(grok_home, &session);
    let project = if hook.cwd.trim().is_empty() { project_of(&meta.cwd) } else { project_of(&hook.cwd) };
    // A brand-new session has no generated title yet; the project name reads better than a placeholder.
    let title = if !meta.title.is_empty() { meta.title } else if !project.is_empty() { project.clone() } else { "Grok Build".to_string() };
    let summary = if hook.message.trim().is_empty() { meta.last_turn } else { hook.message.clone() };
    let at = now_ms();
    let prompt = hook.prompt_id.trim();
    let turn = if prompt.is_empty() || prompt.len() > 128 { format!("{}-{at}", hook.event.trim()) } else { format!("stop-{prompt}") };
    record_hosted(root, &Hosted { client: CLIENT_GROK, session: &session, turn: &turn, title: &title, summary: &summary, project: &project, at })
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

/// One Claude Code `Stop` hook invocation, as seen by the `--claude-notify` helper.
///
/// Claude Code pipes a JSON envelope on stdin: `session_id`, `cwd`, `transcript_path`,
/// `hook_event_name` and, for `Stop`, `last_assistant_message`. `Stop` fires only when the main
/// agent finishes a turn (never on a user interrupt); subagents report through `SubagentStop`.
#[derive(Default, Debug, Clone, PartialEq)]
pub struct ClaudeHook {
    pub event: String,
    pub session: String,
    pub cwd: String,
    pub message: String,
    pub transcript: String,
    /// A subagent or observer child. Only the conversation the user is in gets a bubble.
    pub child: bool,
}

impl ClaudeHook {
    pub fn from_stdin(stdin: &str) -> ClaudeHook {
        let data: Value = serde_json::from_str(stdin).unwrap_or(Value::Null);
        let text = |key: &str| data[key].as_str().unwrap_or("").trim().to_string();
        // Same markers `spellcast-hook` skips; a role name alone (`--agent reviewer`) is still the main session.
        let child = data["is_subagent"] == true || data["isSubagent"] == true
            || !text("agent_id").is_empty() || !text("subagent_id").is_empty()
            || matches!(text("agent_type").to_ascii_lowercase().as_str(), "child" | "subagent" | "observer");
        ClaudeHook {
            event: text("hook_event_name"), session: text("session_id"), cwd: text("cwd"),
            message: text("last_assistant_message"), transcript: text("transcript_path"), child,
        }
    }

    fn is_completion(&self) -> bool { self.event == "Stop" && !self.child }
}

/// What Spellcast can learn from the tail of `~/.claude/projects/<cwd>/<session>.jsonl`.
#[derive(Default)]
struct ClaudeTranscript { title: String, reply: String }

fn assistant_text(content: &Value) -> String {
    match content {
        Value::String(text) => text.clone(),
        Value::Array(blocks) => blocks.iter().filter(|b| b["type"] == "text")
            .filter_map(|b| b["text"].as_str()).collect::<Vec<_>>().join(" "),
        _ => String::new(),
    }
}

/// Only the last 512 KiB is read: titles are rewritten as a session goes on, and a long one is many MiB.
fn claude_transcript(path: &str) -> ClaudeTranscript {
    use std::io::{Read, Seek, SeekFrom};
    const TAIL: u64 = 512 * 1024;
    let path = Path::new(path);
    if path.extension().and_then(|e| e.to_str()) != Some("jsonl") { return ClaudeTranscript::default(); }
    let Ok(mut file) = fs::File::open(path) else { return ClaudeTranscript::default(); };
    let start = file.metadata().map(|m| m.len()).unwrap_or(0).saturating_sub(TAIL);
    let mut bytes = Vec::new();
    if file.seek(SeekFrom::Start(start)).and_then(|_| file.take(TAIL).read_to_end(&mut bytes)).is_err() {
        return ClaudeTranscript::default();
    }
    let text = String::from_utf8_lossy(&bytes);
    // A tail read begins mid-line; that fragment is not a record.
    let lines: Vec<&str> = text.lines().skip(usize::from(start > 0)).collect();
    let (mut custom, mut generated) = (String::new(), String::new());
    let mut found = ClaudeTranscript::default();
    for line in lines.iter().rev() {
        let Ok(record) = serde_json::from_str::<Value>(line) else { continue; };
        let pick = |key: &str| record[key].as_str().map(str::trim).unwrap_or("").to_string();
        match record["type"].as_str() {
            Some("custom-title") if custom.is_empty() => custom = pick("customTitle"),
            Some("ai-title") if generated.is_empty() => generated = pick("aiTitle"),
            Some("assistant") if found.reply.is_empty() && record["isSidechain"] != true => {
                found.reply = assistant_text(&record["message"]["content"]);
            }
            _ => {}
        }
    }
    found.title = if custom.is_empty() { generated } else { custom };
    found
}

/// Turn a Claude Code `Stop` hook into one completion bubble.
pub fn capture_claude(root: &Path, hook: &ClaudeHook) -> Result<bool, String> {
    if !hook.is_completion() { return Ok(false); }
    let session = session_uuid(&hook.session, "Claude")?;
    let transcript = claude_transcript(&hook.transcript);
    let project = project_of(&hook.cwd);
    // A prompt is not a name: without a session title the card shows only the project, and CC GUI's own title
    // (completion_title.rs) replaces this one as soon as it exists.
    let title = transcript.title.clone();
    // The hook carries the final reply; the transcript is not guaranteed to hold it yet at Stop time.
    let summary = if hook.message.is_empty() { transcript.reply } else { hook.message.clone() };
    let at = now_ms();
    record_hosted(root, &Hosted { client: CLIENT_CLAUDE, session: &session, turn: &format!("stop-{at}"),
        title: &title, summary: &summary, project: &project, at })
}

/// CC GUI sets this on the CLI of a Leader-managed child chat; the CLI's `Stop` hook and Codex's notify program
/// inherit it. The child's parent chat reports its results, so the child's turns get no bubble.
pub const CCGUI_LEADER_CHILD_ENV: &str = "CCGUI_LEADER_CHILD";

fn leader_child(value: Option<&std::ffi::OsStr>) -> bool {
    value.is_some_and(|value| value == "1")
}

fn launched_for_leader_child() -> bool {
    leader_child(std::env::var_os(CCGUI_LEADER_CHILD_ENV).as_deref())
}

/// Entry point for `spellcast --claude-notify <root>`.
/// Nothing is written to stdout: a `Stop` hook's stdout is parsed by Claude Code as a decision.
pub fn claude_notify(root: &Path) {
    use std::io::Read;
    let mut stdin = String::new();
    let _ = std::io::stdin().take(2 * 1024 * 1024).read_to_string(&mut stdin);
    if launched_for_leader_child() { return; }
    // A one-off `claude -p "<question>"` (a script, or CC GUI's auto-title plugin naming a chat) has no one to tell.
    if crate::claude_process::claude_command_line().is_some_and(|line| crate::claude_process::is_one_shot_print(&line)) { return; }
    if let Err(err) = capture_claude(root, &ClaudeHook::from_stdin(&stdin)) {
        eprintln!("Spellcast Claude completion capture failed: {err}");
    }
}

pub const HOST_CCGUI: &str = "ccgui";

/// The bridge knows a Claude conversation by this source id, which its host plugin registers.
pub fn claude_source(thread_id: &str) -> String {
    format!("claude:{thread_id}")
}

/// Drop Claude completions whose chat was attended after the task finished. The CC GUI plugin attests
/// explicit attention (a chat selected, or its window focused on it), so a later one means the result was
/// seen — the same moment a Codex task goes from unread to read. `attention` is the bridge's latest
/// attention for a source, `None` when no CC GUI window reports for it.
pub fn dismiss_viewed(root: &Path, items: Vec<Completion>, attention: &dyn Fn(&str) -> Option<u64>) -> Result<Vec<Completion>, String> {
    let mut kept = Vec::with_capacity(items.len());
    for item in items {
        let viewed = item.client == CLIENT_CLAUDE
            && attention(&claude_source(&item.thread_id)).is_some_and(|at| at > item.completed_at_ms);
        if viewed { dismiss(root, &item.thread_id, &item.turn_id)?; } else { kept.push(item); }
    }
    Ok(kept)
}

/// Mark the Claude tasks whose CC GUI window is connected, so a double-click can go back to the chat.
/// Never stored: it follows the window coming and going.
pub fn mark_openable(items: &mut [Completion], connected: &dyn Fn(&str) -> bool) {
    for item in items {
        item.host = (item.client == CLIENT_CLAUDE && connected(&claude_source(&item.thread_id)))
            .then(|| HOST_CCGUI.to_string());
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
        project: row.get(4)?, completed_at_ms: row.get(5)?, client: row.get(6)?, host: None,
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
    // Grok Build and Claude Code completions carry their own metadata; Codex read state and thread DB do not apply.
    let (mut shown, codex): (Vec<_>, Vec<_>) = candidates.into_iter().partition(|c| c.client != CLIENT_CODEX);
    if !codex.is_empty() {
        // Unknown identities stay queued until Codex has persisted their metadata.
        if let Some(path) = thread_database(home) {
            let db = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
                .map_err(|e| e.to_string())?;
            db.busy_timeout(Duration::from_millis(250)).map_err(|e| e.to_string())?;
            let mut query = db.prepare("SELECT title,source FROM threads WHERE id=?1").map_err(|e| e.to_string())?;
            let mut known = Vec::new();
            for mut item in codex {
                let metadata: Option<(String,String)> = query.query_row([&item.thread_id], |r| Ok((r.get(0)?,r.get(1)?)))
                    .optional().map_err(|e| e.to_string())?;
                let Some((title, source)) = metadata else { continue; };
                if source.contains("subagent") { dismiss(root, &item.thread_id, &item.turn_id)?; continue; }
                if !title.trim().is_empty() { item.title = short(&title, 100); }
                known.push(item);
            }
            // A missing thread in the read snapshot is meaningful only after the
            // task itself is known. Metadata can lag behind the completion hook.
            if read_sync.synchronize(root, home, &known)? {
                let remaining = pending(root)?;
                known.retain(|item| remaining.iter().any(|pending|
                    pending.thread_id == item.thread_id && pending.turn_id == item.turn_id));
            }
            shown.extend(known);
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
    // The original notify above still runs for a child; only Spellcast's own bubble is skipped.
    if launched_for_leader_child() { return; }
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

fn grok_notify_group(root: &Path) -> Value {
    serde_json::json!({
        "hooks": [{ "type": "command", "command": grok_hook_command(root), "timeout": 10 }]
    })
}

fn group_runs_grok_notify(group: &Value) -> bool {
    group["hooks"].as_array().is_some_and(|hooks| {
        hooks.iter().any(|hook| {
            hook["command"].as_str().is_some_and(|c| c.contains(GROK_NOTIFY_FLAG))
        })
    })
}

/// Merge our `Stop` group into an existing hook file. Other events, other Stop groups, and
/// unknown top-level keys stay. Invalid JSON is refused so a user file is never replaced blindly.
fn merge_grok_hook_file(existing: Option<&[u8]>, root: &Path) -> Result<String, String> {
    let mut doc = match existing {
        None | Some(b"") => serde_json::json!({ "hooks": {} }),
        Some(bytes) => serde_json::from_slice(bytes)
            .map_err(|e| format!("~/.grok/hooks/spellcast.json 不是有效 JSON，已保护：{e}"))?,
    };
    let Some(root_obj) = doc.as_object_mut() else {
        return Err("~/.grok/hooks/spellcast.json 顶层不是对象，已保护。".into());
    };
    let hooks = root_obj.entry("hooks".to_string()).or_insert_with(|| serde_json::json!({}));
    let Some(hooks_map) = hooks.as_object_mut() else {
        return Err("~/.grok/hooks/spellcast.json 的 hooks 不是对象，已保护。".into());
    };
    match hooks_map.get_mut("Stop") {
        None => {
            hooks_map.insert("Stop".into(), serde_json::json!([grok_notify_group(root)]));
        }
        Some(Value::Array(arr)) => {
            arr.retain(|group| !group_runs_grok_notify(group));
            arr.push(grok_notify_group(root));
        }
        Some(_) => return Err("~/.grok/hooks/spellcast.json 的 hooks.Stop 不是数组，已保护。".into()),
    }
    Ok(serde_json::to_string_pretty(&doc).map_err(|e| e.to_string())? + "\n")
}

fn strip_grok_notify_from_hook_file(existing: &[u8]) -> Result<Option<String>, String> {
    let mut doc: Value = serde_json::from_slice(existing)
        .map_err(|e| format!("~/.grok/hooks/spellcast.json 不是有效 JSON，已保护：{e}"))?;
    let Some(hooks_map) = doc.get_mut("hooks").and_then(Value::as_object_mut) else {
        return Ok(Some(String::from_utf8_lossy(existing).into_owned()));
    };
    let mut changed = false;
    if let Some(Value::Array(arr)) = hooks_map.get_mut("Stop") {
        let before = arr.len();
        arr.retain(|group| !group_runs_grok_notify(group));
        changed = arr.len() != before;
        if arr.is_empty() {
            hooks_map.remove("Stop");
        }
    }
    if !changed {
        return Ok(Some(String::from_utf8_lossy(existing).into_owned()));
    }
    if hooks_map.is_empty() && doc.as_object().is_some_and(|o| o.len() == 1 && o.contains_key("hooks")) {
        return Ok(None);
    }
    Ok(Some(serde_json::to_string_pretty(&doc).map_err(|e| e.to_string())? + "\n"))
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
    let existing = fs::read(&hook_path).ok();
    let body = merge_grok_hook_file(existing.as_deref(), root)?;
    crate::configure::commit_with_backup(&hook_path, body.as_bytes())?;
    remove_legacy_notification_hook(grok_home)?;
    Ok(format!("已安装 Grok Build 完成通知：{}", hook_path.display()))
}

pub fn uninstall_grok(grok_home: &Path) -> Result<String, String> {
    let hook_path = grok_hook_path(grok_home);
    let had_file = hook_file_command(&hook_path).is_some();
    if had_file {
        let bytes = fs::read(&hook_path).map_err(|e| e.to_string())?;
        match strip_grok_notify_from_hook_file(&bytes)? {
            None => fs::remove_file(&hook_path).map_err(|e| e.to_string())?,
            Some(rest) => { crate::configure::commit_with_backup(&hook_path, rest.as_bytes())?; }
        }
    }
    let had_legacy = remove_legacy_notification_hook(grok_home)?;
    if !had_file && !had_legacy { return Err("Grok 里没有 Spellcast 完成通知，未修改。".into()); }
    Ok("已移除 Grok Build 完成通知。".into())
}

const CLAUDE_NOTIFY_FLAG: &str = "--claude-notify";
const SETTINGS_LABEL: &str = "Claude Code 的 settings.json";
const INDENT: &str = "  ";

pub fn claude_settings_path(claude_home: &Path) -> PathBuf { claude_home.join("settings.json") }

/// A JSON object kept as written: member order and each value's exact text survive an edit.
struct Members(Vec<(String, Box<RawValue>)>);

impl<'de> Deserialize<'de> for Members {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct Collect;
        impl<'de> Visitor<'de> for Collect {
            type Value = Members;
            fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result { f.write_str("a JSON object") }
            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Members, A::Error> {
                let mut members = Vec::new();
                while let Some(entry) = map.next_entry::<String, Box<RawValue>>()? { members.push(entry); }
                Ok(Members(members))
            }
        }
        deserializer.deserialize_map(Collect)
    }
}

fn members_of(text: &str) -> Result<Vec<(String, String)>, serde_json::Error> {
    serde_json::from_str::<Members>(text)
        .map(|members| members.0.into_iter().map(|(key, value)| (key, value.get().to_string())).collect())
}

/// A `{}` or `[]` whose items are already text and sit one level below `depth`.
fn container(open: char, close: char, items: &[String], depth: usize) -> String {
    if items.is_empty() { return format!("{open}{close}"); }
    let pad = INDENT.repeat(depth + 1);
    let body = items.iter().map(|item| format!("{pad}{item}")).collect::<Vec<_>>().join(",\n");
    format!("{open}\n{body}\n{}{close}", INDENT.repeat(depth))
}

fn object_text(members: &[(String, String)], depth: usize) -> String {
    let items: Vec<String> = members.iter().map(|(key, value)| format!("{}: {value}", Value::String(key.clone()))).collect();
    container('{', '}', &items, depth)
}

/// Exec form (`args` set): Claude Code spawns the helper directly, so a path with spaces needs no quoting.
fn claude_group_text(root: &Path) -> String {
    let quote = |text: &str| Value::String(text.to_string()).to_string();
    let group = format!(r#"{{
  "hooks": [
    {{
      "type": "command",
      "command": {},
      "args": ["{CLAUDE_NOTIFY_FLAG}", {}],
      "timeout": 10
    }}
  ]
}}"#, quote(&helper_path(root).to_string_lossy()), quote(&root.to_string_lossy()));
    group.replace('\n', &format!("\n{}", INDENT.repeat(3)))
}

fn group_runs_claude_notify(group: &Value) -> bool {
    group["hooks"].as_array().is_some_and(|hooks| hooks.iter().any(|hook| {
        hook["args"].as_array().is_some_and(|args| args.iter().any(|arg| arg == CLAUDE_NOTIFY_FLAG))
    }))
}

fn text_runs_claude_notify(group: &str) -> bool {
    serde_json::from_str::<Value>(group).is_ok_and(|group| group_runs_claude_notify(&group))
}

fn read_settings(path: &Path) -> Result<Option<String>, String> {
    match fs::read_to_string(path) {
        Ok(text) => Ok(Some(text)),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(err) => Err(format!("读不了 {}：{err}", path.display())),
    }
}

/// Rewrite settings.json with `edit` applied to the groups of `hooks.Stop`. Everything else is copied from
/// the original text — member order, formatting, every other hook — so only the Stop array differs.
/// A file that is not a JSON object, or has a `hooks`/`Stop` of the wrong shape, is refused.
fn edit_claude_stop(existing: Option<&str>, edit: impl FnOnce(&mut Vec<String>)) -> Result<String, String> {
    let original = existing.map(|t| t.trim_start_matches('\u{feff}')).filter(|t| !t.trim().is_empty()).unwrap_or("{}");
    let mut top = members_of(original).map_err(|e| format!("{SETTINGS_LABEL} 不是有效的 JSON 对象，已保护：{e}"))?;
    let hooks_at = top.iter().position(|(key, _)| key == "hooks");
    let mut hooks = match hooks_at {
        Some(at) => members_of(&top[at].1).map_err(|_| format!("{SETTINGS_LABEL} 的 hooks 不是对象，已保护。"))?,
        None => Vec::new(),
    };
    let stop_at = hooks.iter().position(|(key, _)| key == "Stop");
    let mut groups: Vec<String> = match stop_at {
        Some(at) => serde_json::from_str::<Vec<Box<RawValue>>>(&hooks[at].1)
            .map_err(|_| format!("{SETTINGS_LABEL} 的 hooks.Stop 不是数组，已保护。"))?
            .into_iter().map(|group| group.get().to_string()).collect(),
        None => Vec::new(),
    };
    edit(&mut groups);
    // Containers we emptied go away; ones that were never there are not created.
    match (stop_at, groups.is_empty()) {
        (Some(at), true) => { hooks.remove(at); }
        (Some(at), false) => hooks[at].1 = container('[', ']', &groups, 2),
        (None, false) => hooks.push(("Stop".into(), container('[', ']', &groups, 2))),
        (None, true) => {}
    }
    match (hooks_at, hooks.is_empty()) {
        (Some(at), true) => { top.remove(at); }
        (Some(at), false) => top[at].1 = object_text(&hooks, 1),
        (None, false) => top.push(("hooks".into(), object_text(&hooks, 1))),
        (None, true) => {}
    }
    let mut text = object_text(&top, 0);
    if existing.map_or(true, |t| t.trim().is_empty() || t.ends_with('\n')) { text.push('\n'); }
    // JSON strings cannot hold a raw newline, so every newline here is layout and safe to convert.
    if original.contains("\r\n") { text = text.replace("\r\n", "\n").replace('\n', "\r\n"); }
    Ok(text)
}

/// Whether Claude Code's settings already run this inbox's helper when a turn ends.
pub fn claude_hook_installed(claude_home: &Path, root: &Path) -> bool {
    let Ok(Some(text)) = read_settings(&claude_settings_path(claude_home)) else { return false; };
    let Ok(doc) = serde_json::from_str::<Value>(text.trim_start_matches('\u{feff}')) else { return false; };
    let helper = helper_path(root);
    let (helper_text, root_text) = (helper.to_string_lossy(), root.to_string_lossy());
    doc["hooks"]["Stop"].as_array().into_iter().flatten()
        .filter_map(|group| group["hooks"].as_array()).flatten()
        .any(|hook| hook["command"].as_str() == Some(helper_text.as_ref())
            && hook["args"][0] == CLAUDE_NOTIFY_FLAG && hook["args"][1].as_str() == Some(root_text.as_ref()))
        && helper.is_file()
}

/// Add a `Stop` hook group to `<claude_home>/settings.json` that captures Claude Code turn completions.
/// The user's other settings and hooks are left exactly as written; the previous file is backed up.
pub fn install_claude(claude_home: &Path, root: &Path, executable: &Path) -> Result<String, String> {
    let path = claude_settings_path(claude_home);
    let existing = read_settings(&path)?;
    let group = claude_group_text(root);
    // Computed before the helper is copied, so a settings file we refuse leaves nothing behind.
    let body = edit_claude_stop(existing.as_deref(), |groups| {
        groups.retain(|group| !text_runs_claude_notify(group));
        groups.push(group);
    })?;
    fs::create_dir_all(root).map_err(|e| e.to_string())?;
    crate::configure::commit_with_backup(&helper_path(root), &fs::read(executable).map_err(|e| e.to_string())?)?;
    #[cfg(unix)] {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(helper_path(root), fs::Permissions::from_mode(0o700)).map_err(|e| e.to_string())?;
    }
    // Claude Code and other hook managers also write this file; do not overwrite an edit made meanwhile.
    if read_settings(&path)? != existing {
        return Err("Claude 配置已被其他程序修改；未替换，请重试。".into());
    }
    crate::configure::commit_with_backup(&path, body.as_bytes())?;
    Ok(format!("已安装 Claude Code 完成通知：{}", path.display()))
}

pub fn uninstall_claude(claude_home: &Path) -> Result<String, String> {
    let path = claude_settings_path(claude_home);
    let existing = read_settings(&path)?;
    let mut found = false;
    let body = edit_claude_stop(existing.as_deref(), |groups| {
        let before = groups.len();
        groups.retain(|group| !text_runs_claude_notify(group));
        found = groups.len() != before;
    })?;
    if !found { return Err("Claude Code 里没有 Spellcast 完成通知，未修改。".into()); }
    crate::configure::commit_with_backup(&path, body.as_bytes())?;
    Ok("已移除 Claude Code 完成通知。".into())
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
    fn fresh_read_snapshot_does_not_acknowledge_a_task_with_missing_metadata() {
        let p=dir(); let root=p.join("inbox"); capture(&root,&event("one")).unwrap();
        inbox(&root).unwrap().execute("UPDATE completions SET completed_at_ms=1", []).unwrap();
        fs::write(p.join(".codex-global-state.json"), serde_json::json!({
            "electron-thread-read-state-v1":{"version":1,"unreadByIdentity":{"account":{"local:host":[]}}}
        }).to_string()).unwrap();
        let mut read_sync = crate::completion_read::ReadSync::default();
        assert!(visible(&root,&p,&mut read_sync).unwrap().is_empty());
        assert_eq!(pending(&root).unwrap().len(),1);
        let db=Connection::open(p.join("state_5.sqlite")).unwrap();
        db.execute_batch("CREATE TABLE threads(id TEXT,title TEXT,source TEXT);").unwrap();
        assert!(visible(&root,&p,&mut read_sync).unwrap().is_empty());
        assert_eq!(pending(&root).unwrap().len(),1);
        db.execute("INSERT INTO threads VALUES (?1,'Known task','vscode')", [THREAD]).unwrap();
        assert!(visible(&root,&p,&mut read_sync).unwrap().is_empty());
        assert!(pending(&root).unwrap().is_empty());
        drop(db); fs::remove_dir_all(p).unwrap();
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

    #[test]
    fn grok_hook_install_merges_stop_and_refuses_to_clobber_user_json() {
        let p=dir(); let home=p.join("grok"); fs::create_dir_all(home.join("hooks")).unwrap();
        let root=p.join("completion"); let exe=p.join("fake.exe"); fs::write(&exe,b"helper").unwrap();
        let user_hook = serde_json::json!({
            "version": 1,
            "hooks": {
                "SessionStart": [{ "hooks": [{ "type": "command", "command": "echo keep-session" }] }],
                "Stop": [
                    { "hooks": [{ "type": "command", "command": "echo keep-stop" }] }
                ]
            }
        });
        fs::write(home.join("hooks").join("spellcast.json"), serde_json::to_string_pretty(&user_hook).unwrap()).unwrap();
        fs::write(home.join("hooks").join("user-other.json"), "{\"keep\":true}\n").unwrap();
        install_grok(&home,&root,&exe).unwrap();
        let doc: Value = serde_json::from_str(&fs::read_to_string(grok_hook_path(&home)).unwrap()).unwrap();
        assert_eq!(doc["version"], 1);
        assert_eq!(doc["hooks"]["SessionStart"][0]["hooks"][0]["command"], "echo keep-session");
        let stop = doc["hooks"]["Stop"].as_array().unwrap();
        assert_eq!(stop.len(), 2);
        assert_eq!(stop[0]["hooks"][0]["command"], "echo keep-stop");
        assert!(stop[1]["hooks"][0]["command"].as_str().unwrap().contains("--grok-notify"));
        assert_eq!(fs::read_to_string(home.join("hooks").join("user-other.json")).unwrap(), "{\"keep\":true}\n");
        uninstall_grok(&home).unwrap();
        let after: Value = serde_json::from_str(&fs::read_to_string(grok_hook_path(&home)).unwrap()).unwrap();
        assert_eq!(after["version"], 1);
        assert_eq!(after["hooks"]["SessionStart"][0]["hooks"][0]["command"], "echo keep-session");
        assert_eq!(after["hooks"]["Stop"].as_array().unwrap().len(), 1);
        assert_eq!(after["hooks"]["Stop"][0]["hooks"][0]["command"], "echo keep-stop");
        fs::write(grok_hook_path(&home), "not-json").unwrap();
        let err = install_grok(&home,&root,&exe).unwrap_err();
        assert!(err.contains("已保护"), "{err}");
        assert_eq!(fs::read_to_string(grok_hook_path(&home)).unwrap(), "not-json");
        fs::remove_dir_all(p).unwrap();
    }
    const CLAUDE_SESSION: &str = "a09c1947-841e-48c0-8817-6b82325eef08";
    fn lf(text: &str) -> String { text.replace("\r\n", "\n") }
    fn claude_stop(extra: Value) -> String {
        let mut data = serde_json::json!({"session_id":CLAUDE_SESSION,"hook_event_name":"Stop","cwd":"G:\\VibeProj\\spellcast",
            "stop_hook_active":false,"last_assistant_message":"Stop 钩子已接入，Claude 卡片会出现。"});
        for (key, value) in extra.as_object().unwrap() { data[key] = value.clone(); }
        data.to_string()
    }
    fn claude_transcript_file(dir: &Path, records: &[Value]) -> String {
        let path = dir.join(format!("{CLAUDE_SESSION}.jsonl"));
        fs::write(&path, records.iter().map(Value::to_string).collect::<Vec<_>>().join("\n") + "\n").unwrap();
        path.to_string_lossy().into_owned()
    }
    #[test]
    fn claude_stop_hook_becomes_a_claude_bubble_without_codex() {
        let p=dir(); let root=p.join("inbox");
        let transcript = claude_transcript_file(&p, &[
            serde_json::json!({"type":"ai-title","aiTitle":"旧标题"}),
            serde_json::json!({"type":"last-prompt","lastPrompt":"接 Claude Code 的 Stop 钩子"}),
            serde_json::json!({"type":"ai-title","aiTitle":"接入 Claude Stop 钩子"}),
            serde_json::json!({"type":"assistant","isSidechain":false,"message":{"content":[{"type":"text","text":"transcript reply"}]}}),
        ]);
        let hook = ClaudeHook::from_stdin(&claude_stop(serde_json::json!({"transcript_path":transcript})));
        assert_eq!(hook.event,"Stop"); assert_eq!(hook.session,CLAUDE_SESSION); assert!(!hook.child);
        assert!(capture_claude(&root,&hook).unwrap());
        // The same Stop delivered twice in a row is one bubble.
        assert!(!capture_claude(&root,&hook).unwrap());
        let list=pending(&root).unwrap(); assert_eq!(list.len(),1);
        assert_eq!(list[0].client,CLIENT_CLAUDE); assert_eq!(list[0].thread_id,CLAUDE_SESSION);
        assert_eq!(list[0].title,"接入 Claude Stop 钩子"); assert_eq!(list[0].project,"spellcast");
        assert_eq!(list[0].summary,"Stop 钩子已接入，Claude 卡片会出现。");
        // No Codex thread database exists, yet the Claude completion shows and can be dismissed.
        let mut read_sync = crate::completion_read::ReadSync::default();
        let shown = visible(&root,&p.join("no-codex"),&mut read_sync).unwrap();
        assert_eq!(shown.len(),1); assert_eq!(shown[0].client,CLIENT_CLAUDE);
        dismiss(&root,CLAUDE_SESSION,&shown[0].turn_id).unwrap();
        assert!(visible(&root,&p.join("no-codex"),&mut read_sync).unwrap().is_empty());
        fs::remove_dir_all(p).unwrap();
    }
    #[test]
    fn claude_stop_ignores_children_other_events_and_bad_sessions() {
        let p=dir(); let root=p.join("inbox");
        for payload in [
            claude_stop(serde_json::json!({"hook_event_name":"SubagentStop","agent_id":"agent-1"})),
            claude_stop(serde_json::json!({"hook_event_name":"UserPromptSubmit"})),
            claude_stop(serde_json::json!({"agent_id":"agent-1"})),
            claude_stop(serde_json::json!({"subagent_id":"obs-1"})),
            claude_stop(serde_json::json!({"isSubagent":true})),
            claude_stop(serde_json::json!({"agent_type":"observer"})),
            "not json".to_string(), String::new(),
        ] { assert!(!capture_claude(&root,&ClaudeHook::from_stdin(&payload)).unwrap(), "{payload}"); }
        assert!(pending(&root).unwrap().is_empty());
        for bad in ["../../evil", "", "{a09c1947-841e-48c0-8817-6b82325eef08}", "abc123"] {
            let hook = ClaudeHook::from_stdin(&claude_stop(serde_json::json!({"session_id":bad})));
            assert!(capture_claude(&root,&hook).is_err(), "{bad}");
        }
        // A main session started with --agent keeps its bubble: a role name alone is not a child marker.
        let role = ClaudeHook::from_stdin(&claude_stop(serde_json::json!({"agent_type":"reviewer"})));
        assert!(capture_claude(&root,&role).unwrap());
        assert_eq!(pending(&root).unwrap().len(),1);
        fs::remove_dir_all(p).unwrap();
    }
    #[test]
    fn only_the_exact_ccgui_marker_makes_a_leader_child() {
        use std::ffi::OsStr;
        assert!(leader_child(Some(OsStr::new("1"))));
        for other in [None, Some(OsStr::new("")), Some(OsStr::new("0")), Some(OsStr::new("true")), Some(OsStr::new(" 1"))] {
            assert!(!leader_child(other), "{other:?}");
        }
    }
    #[test]
    fn claude_transcript_fills_gaps_and_reads_only_the_tail() {
        let p=dir();
        // No reply in the envelope and no title records: the transcript's last text reply stands in, and the title
        // stays empty rather than quoting the last prompt.
        let transcript = claude_transcript_file(&p, &[
            serde_json::json!({"type":"last-prompt","lastPrompt":"  修一下\n登录页  "}),
            serde_json::json!({"type":"assistant","isSidechain":true,"message":{"content":[{"type":"text","text":"sidechain"}]}}),
            serde_json::json!({"type":"assistant","isSidechain":false,"message":{"content":[{"type":"tool_use","name":"Bash"},{"type":"text","text":"登录页已修好"}]}}),
            serde_json::json!({"type":"assistant","isSidechain":false,"message":{"content":[{"type":"tool_use","name":"Bash"}]}}),
        ]);
        let root=p.join("one");
        let hook = ClaudeHook::from_stdin(&claude_stop(serde_json::json!({"transcript_path":transcript,"last_assistant_message":""})));
        assert!(capture_claude(&root,&hook).unwrap());
        let item=pending(&root).unwrap().remove(0);
        assert_eq!(item.title,""); assert_eq!(item.summary,"登录页已修好");
        // A custom title (/rename) wins over the generated one, however old.
        let transcript = claude_transcript_file(&p, &[
            serde_json::json!({"type":"custom-title","customTitle":"我起的名字"}),
            serde_json::json!({"type":"ai-title","aiTitle":"生成的名字"}),
        ]);
        let root=p.join("two");
        capture_claude(&root,&ClaudeHook::from_stdin(&claude_stop(serde_json::json!({"transcript_path":transcript})))).unwrap();
        assert_eq!(pending(&root).unwrap()[0].title,"我起的名字");
        // Without a transcript there is no title (the card falls back to the project); a transcript path that is not a .jsonl file is never read.
        let root=p.join("three"); fs::write(p.join("secret.txt"),"{\"type\":\"ai-title\",\"aiTitle\":\"leak\"}").unwrap();
        let hook = ClaudeHook::from_stdin(&claude_stop(serde_json::json!({"transcript_path":p.join("secret.txt").to_string_lossy()})));
        capture_claude(&root,&hook).unwrap();
        assert_eq!(pending(&root).unwrap()[0].title,""); assert_eq!(pending(&root).unwrap()[0].project,"spellcast");
        // Long sessions: a title written in the tail is found past a cut first line; one before the tail is not read.
        let filler = serde_json::json!({"type":"attachment","text":"x".repeat(700_000)});
        let early = serde_json::json!({"type":"ai-title","aiTitle":"early title"});
        let late = serde_json::json!({"type":"ai-title","aiTitle":"late title"});
        let root=p.join("four");
        let transcript = claude_transcript_file(&p, &[early.clone(), filler.clone(), late]);
        capture_claude(&root,&ClaudeHook::from_stdin(&claude_stop(serde_json::json!({"transcript_path":transcript})))).unwrap();
        assert_eq!(pending(&root).unwrap()[0].title,"late title");
        let root=p.join("five");
        let transcript = claude_transcript_file(&p, &[early, filler]);
        capture_claude(&root,&ClaudeHook::from_stdin(&claude_stop(serde_json::json!({"transcript_path":transcript})))).unwrap();
        assert_eq!(pending(&root).unwrap()[0].title,"");
        fs::remove_dir_all(p).unwrap();
    }
    #[test]
    fn card_summary_is_plain_text_that_ends_in_an_ellipsis_when_cut() {
        let reply = "## 结论\n\n你说的**两点**都对：\n- 见 [说明](https://example.com/a) 里的 `codex exec`\n- 第二条\n\n```rust\nfn main() {}\n```\n> 引用\n| a | b |\n|---|---|\n---";
        assert_eq!(plain(reply), "结论 你说的两点都对： 见 说明 里的 codex exec 第二条 引用 a b");
        assert_eq!(brief("  done \n now ", 240), "done now");
        assert_eq!(brief("[x] kept and [y](z", 240), "[x] kept and [y](z");
        let long = "字".repeat(300);
        let cut = brief(&long, 240);
        assert_eq!(cut.chars().count(), 240); assert!(cut.ends_with('…'));
        assert_eq!(brief(&"字".repeat(240), 240).chars().count(), 240);
        assert!(!brief(&"字".repeat(240), 240).ends_with('…'));
        // The stored summary is what the 5 second duplicate check compares: a cut reply must still be recognised.
        let p=dir(); let root=p.join("inbox");
        let hook = ClaudeHook::from_stdin(&claude_stop(serde_json::json!({"last_assistant_message":long})));
        assert!(capture_claude(&root,&hook).unwrap()); assert!(!capture_claude(&root,&hook).unwrap());
        assert_eq!(pending(&root).unwrap()[0].summary, cut);
        fs::remove_dir_all(p).unwrap();
    }
    const CLAUDE_SETTINGS: &str = r#"{
  "$schema": "https://json.schemastore.org/claude-code-settings.json",
  "theme": "dark",
  "env": {
    "KEEP": "1"
  },
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "echo keep-session"
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "echo keep-stop",
            "timeout": 10
          }
        ]
      }
    ]
  },
  "effortLevel": "high"
}
"#;
    #[test]
    fn claude_hook_install_adds_one_stop_group_and_uninstall_restores_the_file() {
        let p=dir(); let home=p.join("claude"); fs::create_dir_all(&home).unwrap();
        let root=p.join("with space").join("completion"); let exe=p.join("fake.exe"); fs::write(&exe,b"helper").unwrap();
        let settings=claude_settings_path(&home);
        let original=lf(CLAUDE_SETTINGS); fs::write(&settings,&original).unwrap();
        assert!(!claude_hook_installed(&home,&root));
        install_claude(&home,&root,&exe).unwrap(); install_claude(&home,&root,&exe).unwrap();
        assert!(claude_hook_installed(&home,&root));
        assert_eq!(fs::read(helper_path(&root)).unwrap(),b"helper");
        let text=fs::read_to_string(&settings).unwrap();
        let doc: Value=serde_json::from_str(&text).unwrap();
        let stop=doc["hooks"]["Stop"].as_array().unwrap(); assert_eq!(stop.len(),2);
        assert_eq!(stop[0]["hooks"][0]["command"],"echo keep-stop");
        let ours=&stop[1]["hooks"][0];
        assert_eq!(ours["type"],"command"); assert_eq!(ours["timeout"],10);
        assert_eq!(ours["command"].as_str().unwrap(),helper_path(&root).to_string_lossy());
        // Exec form: the root travels as its own argument, so the space in it needs no quoting.
        assert_eq!(ours["args"],serde_json::json!([CLAUDE_NOTIFY_FLAG,root.to_string_lossy()]));
        // Member order and everything before the new group are byte-for-byte what the user had.
        let keep=original.find("      }\n    ]\n  },\n  \"effortLevel\"").unwrap();
        assert!(text.starts_with(&original[..keep]), "{text}");
        assert!(text.ends_with("  },\n  \"effortLevel\": \"high\"\n}\n"), "{text}");
        assert!(settings.with_file_name("settings.json.spellcast.bak").exists());
        uninstall_claude(&home).unwrap();
        assert_eq!(fs::read_to_string(&settings).unwrap(),original);
        assert!(uninstall_claude(&home).is_err()); assert!(!claude_hook_installed(&home,&root));
        // CRLF files stay CRLF all the way through.
        let crlf=original.replace('\n',"\r\n"); fs::write(&settings,&crlf).unwrap();
        install_claude(&home,&root,&exe).unwrap();
        assert!(!fs::read_to_string(&settings).unwrap().replace("\r\n","").contains('\n'));
        uninstall_claude(&home).unwrap(); assert_eq!(fs::read_to_string(&settings).unwrap(),crlf);
        fs::remove_dir_all(p).unwrap();
    }
    #[test]
    fn claude_hook_install_creates_and_removes_what_it_added_and_protects_odd_files() {
        let p=dir(); let home=p.join("claude"); let root=p.join("completion");
        let exe=p.join("fake.exe"); fs::write(&exe,b"helper").unwrap();
        let settings=claude_settings_path(&home);
        // No settings file at all: it is created, and removing the hook leaves an empty object.
        install_claude(&home,&root,&exe).unwrap();
        assert!(claude_hook_installed(&home,&root));
        uninstall_claude(&home).unwrap();
        assert_eq!(serde_json::from_str::<Value>(&fs::read_to_string(&settings).unwrap()).unwrap(),serde_json::json!({}));
        // A file without hooks gets one and loses it again; unrelated keys keep their order.
        fs::write(&settings,"{\n  \"theme\": \"dark\",\n  \"env\": {\n    \"A\": \"1\"\n  }\n}").unwrap();
        install_claude(&home,&root,&exe).unwrap();
        let text=fs::read_to_string(&settings).unwrap();
        assert!(text.find("\"theme\"").unwrap() < text.find("\"env\"").unwrap() && text.find("\"env\"").unwrap() < text.find("\"hooks\"").unwrap());
        assert!(!text.ends_with('\n'));
        uninstall_claude(&home).unwrap();
        assert_eq!(fs::read_to_string(&settings).unwrap(),"{\n  \"theme\": \"dark\",\n  \"env\": {\n    \"A\": \"1\"\n  }\n}");
        // Files we cannot safely edit are refused untouched, and no helper is copied for them.
        let fresh=p.join("fresh-root");
        for bad in ["not-json", "[1,2]", "{\"hooks\":[]}", "{\"hooks\":{\"Stop\":{}}}"] {
            fs::write(&settings,bad).unwrap();
            let err=install_claude(&home,&fresh,&exe).unwrap_err();
            assert!(err.contains("已保护"), "{bad}: {err}");
            assert_eq!(fs::read_to_string(&settings).unwrap(),bad); assert!(!helper_path(&fresh).exists());
        }
        fs::remove_dir_all(p).unwrap();
    }

    const OTHER_CLAUDE: &str = "e2b1f6d4-5c3a-4f0e-9b7d-3a6c8d1f2e47";
    fn claude_task(root: &Path, session: &str, message: &str) {
        let payload = claude_stop(serde_json::json!({"session_id":session,"last_assistant_message":message}));
        assert!(capture_claude(root,&ClaudeHook::from_stdin(&payload)).unwrap());
    }
    #[test]
    fn a_claude_card_goes_away_once_its_chat_is_attended_after_the_task() {
        let p=dir(); let root=p.join("inbox");
        claude_task(&root,CLAUDE_SESSION,"第一轮"); claude_task(&root,OTHER_CLAUDE,"另一个会话"); capture(&root,&event("one")).unwrap();
        let list=pending(&root).unwrap(); assert_eq!(list.len(),3);
        let done=|session:&str| list.iter().find(|c| c.thread_id==session).unwrap().completed_at_ms;
        let (after,before,same)=(done(CLAUDE_SESSION)+1,done(OTHER_CLAUDE)-1,done(OTHER_CLAUDE));
        let attention=|source:&str| -> Option<u64> {
            if source==claude_source(CLAUDE_SESSION) { Some(after) } else if source==claude_source(OTHER_CLAUDE) { Some(before) }
            else { panic!("only Claude tasks ask the host: {source}") }
        };
        let kept=dismiss_viewed(&root,list.clone(),&attention).unwrap();
        // Attended after the task: gone, and stays gone. Attended before it, and the Codex task: kept.
        assert_eq!(kept.len(),2); assert!(kept.iter().all(|c| c.thread_id!=CLAUDE_SESSION));
        assert_eq!(pending(&root).unwrap().len(),2);
        // Attention in the very millisecond is not "after"; a chat no window reports for is never dismissed.
        let tie=|source:&str| if source==claude_source(OTHER_CLAUDE) { Some(same) } else { None };
        assert_eq!(dismiss_viewed(&root,kept.clone(),&tie).unwrap().len(),2);
        // The next task of the attended chat is a new card, and only attention after it clears it.
        std::thread::sleep(std::time::Duration::from_millis(5));
        claude_task(&root,CLAUDE_SESSION,"第二轮");
        let again=pending(&root).unwrap(); assert_eq!(again.len(),3);
        assert_eq!(dismiss_viewed(&root,again.clone(),&attention).unwrap().len(),3);
        let later=|_: &str| Some(u64::MAX);
        assert_eq!(dismiss_viewed(&root,again,&later).unwrap().iter().filter(|c| c.client==CLIENT_CODEX).count(),1);
        fs::remove_dir_all(p).unwrap();
    }
    #[test]
    fn only_claude_tasks_with_a_connected_chat_window_can_be_opened() {
        let p=dir(); let root=p.join("inbox");
        claude_task(&root,CLAUDE_SESSION,"一"); claude_task(&root,OTHER_CLAUDE,"二"); capture(&root,&event("one")).unwrap();
        let mut list=pending(&root).unwrap();
        let connected=|source:&str| source==claude_source(CLAUDE_SESSION);
        mark_openable(&mut list,&connected);
        fn host(list:&[Completion], session:&str) -> Option<String> { list.iter().find(|c| c.thread_id==session).unwrap().host.clone() }
        assert_eq!(host(&list,CLAUDE_SESSION).as_deref(),Some(HOST_CCGUI));
        assert_eq!(host(&list,OTHER_CLAUDE),None); assert_eq!(host(&list,THREAD),None);
        // The mark is runtime state: it is serialised only while set, and never read back from the inbox.
        let json=|c:&Completion| serde_json::to_value(c).unwrap();
        assert_eq!(json(list.iter().find(|c| c.thread_id==CLAUDE_SESSION).unwrap())["host"],"ccgui");
        assert!(json(list.iter().find(|c| c.thread_id==OTHER_CLAUDE).unwrap()).get("host").is_none());
        assert!(pending(&root).unwrap().iter().all(|c| c.host.is_none()));
        // A codex task is never opened through the CC GUI, even when the bridge answers for its id.
        mark_openable(&mut list,&|_: &str| true);
        assert_eq!(host(&list,THREAD),None); assert_eq!(host(&list,OTHER_CLAUDE).as_deref(),Some(HOST_CCGUI));
        // The window goes away: the mark follows.
        mark_openable(&mut list,&|_: &str| false);
        assert!(list.iter().all(|c| c.host.is_none()));
        assert_eq!(claude_source(CLAUDE_SESSION),format!("claude:{CLAUDE_SESSION}"));
        fs::remove_dir_all(p).unwrap();
    }

}

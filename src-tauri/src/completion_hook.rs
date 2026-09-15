//! Local Codex notify adapter. The Codex database is opened read-only; our inbox is separate.
use std::{fs, path::{Path, PathBuf}, process::Command, time::{Duration, SystemTime, UNIX_EPOCH}};
use rusqlite::{params, Connection, OpenFlags, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use toml_edit::{value, Array, DocumentMut};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Completion {
    pub thread_id: String,
    pub turn_id: String,
    pub title: String,
    pub summary: String,
    pub project: String,
    pub completed_at_ms: u64,
}

#[derive(Serialize, Deserialize)]
struct HookSettings { previous_notify: Vec<String> }

pub fn codex_home() -> Result<PathBuf, String> {
    std::env::var_os("CODEX_HOME").map(PathBuf::from).or_else(|| {
        std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME"))
            .map(|p| PathBuf::from(p).join(".codex"))
    }).ok_or_else(|| "找不到 Codex 用户目录。".into())
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
        (thread_id,turn_id,title,summary,project,completed_at_ms) VALUES (?1,?2,?3,?4,?5,?6)",
        params![thread,turn,short(title,100),short(summary,240),short(project,60),at])
        .map_err(|e| e.to_string())?;
    Ok(inserted > 0)
}

pub fn pending(root: &Path) -> Result<Vec<Completion>, String> {
    let db = inbox(root)?;
    let mut query = db.prepare("SELECT thread_id,turn_id,title,summary,project,completed_at_ms
        FROM completions c WHERE dismissed=0 AND NOT EXISTS
        (SELECT 1 FROM completions newer WHERE newer.thread_id=c.thread_id AND newer.sequence>c.sequence)
        ORDER BY sequence DESC").map_err(|e| e.to_string())?;
    let rows = query.query_map([], |row| Ok(Completion {
        thread_id: row.get(0)?, turn_id: row.get(1)?, title: row.get(2)?, summary: row.get(3)?,
        project: row.get(4)?, completed_at_ms: row.get(5)?,
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
    let mut candidates = pending(root)?;
    if candidates.is_empty() { return Ok(candidates); }
    if read_sync.synchronize(root, home, &candidates)? { candidates = pending(root)?; }
    // Unknown identities stay queued until Codex has persisted their metadata.
    let Some(path) = thread_database(home) else { return Ok(Vec::new()); };
    let db = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|e| e.to_string())?;
    db.busy_timeout(Duration::from_millis(250)).map_err(|e| e.to_string())?;
    let mut query = db.prepare("SELECT title,source FROM threads WHERE id=?1").map_err(|e| e.to_string())?;
    let mut shown = Vec::new();
    for mut item in candidates {
        let metadata: Option<(String,String)> = query.query_row([&item.thread_id], |r| Ok((r.get(0)?,r.get(1)?)))
            .optional().map_err(|e| e.to_string())?;
        let Some((title, source)) = metadata else { continue; };
        if source.contains("subagent") { dismiss(root, &item.thread_id, &item.turn_id)?; continue; }
        if !title.trim().is_empty() { item.title = short(&title, 100); }
        shown.push(item);
    }
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
    let helper = root.join(if cfg!(windows) { "spellcast-notify.exe" } else { "spellcast-notify" });
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
}

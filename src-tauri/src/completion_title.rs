//! The headline of a completion card is the task's own name, read when the card is shown rather than when the task
//! finished: Codex and CC GUI's auto-title plugin name a conversation a few seconds after its turn ends, so a name
//! captured at that moment would be the placeholder.
//! A name is never a prompt. Where no name exists the card shows its project instead.
use std::{collections::HashMap, fs, path::{Path, PathBuf}, time::{Duration, SystemTime}};
use rusqlite::{Connection, OpenFlags};
use serde_json::Value;
use crate::completion_hook::{short, Completion, CLIENT_CLAUDE, CLIENT_CODEX};

const TITLE_CHARS: usize = 100;

/// Remembers Codex's name index between looks; it only grows, and is parsed again only when it changes.
#[derive(Default)]
pub struct Titles { codex: Option<CodexIndex> }

struct CodexIndex { len: u64, modified: Option<SystemTime>, names: HashMap<String, String> }

/// `~/.ccgui-next/app.db`, CC GUI's session table; `SPELLCAST_CCGUI_DB` points checks at a copy.
fn ccgui_database() -> Option<PathBuf> {
    std::env::var_os("SPELLCAST_CCGUI_DB").filter(|p| !p.is_empty()).map(PathBuf::from).or_else(|| {
        std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME"))
            .map(|home| PathBuf::from(home).join(".ccgui-next").join("app.db"))
    })
}

/// CC GUI keeps a name the user or the auto-title plugin chose in `custom_title`; `title` is only the first
/// message, which is exactly what a card must not headline. Opened read-only and briefly: CC GUI owns the file.
fn ccgui_titles(database: &Path) -> HashMap<String, String> {
    let mut names = HashMap::new();
    if !database.is_file() { return names; }
    let Ok(db) = Connection::open_with_flags(database, OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX) else { return names; };
    let _ = db.busy_timeout(Duration::from_millis(200));
    let Ok(mut query) = db.prepare("SELECT session_id, custom_title FROM sessions
        WHERE engine='claude' AND custom_title IS NOT NULL AND TRIM(custom_title) <> ''") else { return names; };
    let Ok(rows) = query.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))) else { return names; };
    for (session, title) in rows.flatten() { names.insert(session.to_ascii_lowercase(), short(&title, TITLE_CHARS)); }
    names
}

/// `session_index.jsonl`: one `{"id","thread_name"}` line per naming, the latest of a thread being its name.
fn codex_index(text: &str) -> HashMap<String, String> {
    let mut names = HashMap::new();
    for line in text.lines() {
        let Ok(record) = serde_json::from_str::<Value>(line) else { continue; };
        let (Some(id), Some(name)) = (record["id"].as_str(), record["thread_name"].as_str()) else { continue; };
        let name = short(name, TITLE_CHARS);
        if !name.is_empty() { names.insert(id.to_ascii_lowercase(), name); }
    }
    names
}

impl Titles {
    fn codex_names(&mut self, home: &Path) -> &HashMap<String, String> {
        let path = home.join("session_index.jsonl");
        let stamp = fs::metadata(&path).ok().map(|meta| (meta.len(), meta.modified().ok()));
        let fresh = matches!((&self.codex, stamp), (Some(known), Some((len, modified))) if known.len == len && known.modified == modified);
        if !fresh {
            self.codex = Some(match stamp {
                Some((len, modified)) => CodexIndex {
                    len, modified,
                    names: fs::read(&path).map(|bytes| codex_index(&String::from_utf8_lossy(&bytes))).unwrap_or_default(),
                },
                None => CodexIndex { len: 0, modified: None, names: HashMap::new() },
            });
        }
        &self.codex.as_ref().expect("index was just read").names
    }

    /// Give each card the name its client currently knows the task by. A task without one keeps what it has.
    pub fn apply(&mut self, items: &mut [Completion], codex_home: &Path) {
        if items.iter().any(|item| item.client == CLIENT_CODEX) {
            let names = self.codex_names(codex_home);
            for item in items.iter_mut().filter(|item| item.client == CLIENT_CODEX) {
                if let Some(name) = names.get(&item.thread_id.to_ascii_lowercase()) { item.title = name.clone(); }
            }
        }
        if items.iter().any(|item| item.client == CLIENT_CLAUDE) {
            let Some(database) = ccgui_database() else { return; };
            let names = ccgui_titles(&database);
            for item in items.iter_mut().filter(|item| item.client == CLIENT_CLAUDE) {
                if let Some(name) = names.get(&item.thread_id.to_ascii_lowercase()) { item.title = name.clone(); }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SESSION: &str = "a09c1947-841e-48c0-8817-6b82325eef08";
    const THREAD: &str = "01a0fb09-a45d-7540-aff2-7e0cf5178d20";

    fn dir() -> PathBuf {
        let p = std::env::temp_dir().join(format!("spellcast-title-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&p).unwrap();
        p
    }
    fn item(client: &str, thread: &str, title: &str) -> Completion {
        Completion { thread_id: thread.into(), turn_id: "t".into(), title: title.into(), summary: String::new(),
            project: "spellcast".into(), completed_at_ms: 1, client: client.into(), host: None }
    }
    fn ccgui_db(path: &Path, rows: &[(&str, &str, Option<&str>)]) {
        let db = Connection::open(path).unwrap();
        db.execute_batch("CREATE TABLE sessions(engine TEXT NOT NULL, session_id TEXT NOT NULL, title TEXT NOT NULL DEFAULT '',
            custom_title TEXT, PRIMARY KEY(engine, session_id));").unwrap();
        for (engine, id, custom) in rows {
            db.execute("INSERT INTO sessions(engine,session_id,title,custom_title) VALUES (?1,?2,'the first message',?3)",
                rusqlite::params![engine, id, custom]).unwrap();
        }
    }

    #[test]
    fn ccgui_names_come_from_custom_title_never_from_the_first_message() {
        let p = dir(); let db = p.join("app.db");
        ccgui_db(&db, &[("claude", SESSION, Some("🧩 Spellcast｜完成卡片")), ("claude", "b0000000-0000-4000-8000-000000000000", None),
            ("claude", "c0000000-0000-4000-8000-000000000000", Some("  ")), ("codex", THREAD, Some("not claude's"))]);
        let names = ccgui_titles(&db);
        assert_eq!(names.len(), 1);
        assert_eq!(names[SESSION], "🧩 Spellcast｜完成卡片");
        // No database, or one without the table, is simply no names.
        assert!(ccgui_titles(&p.join("missing.db")).is_empty());
        fs::write(p.join("other.db"), b"not sqlite").unwrap();
        assert!(ccgui_titles(&p.join("other.db")).is_empty());
        fs::remove_dir_all(p).unwrap();
    }

    #[test]
    fn codex_index_latest_name_wins_and_bad_lines_are_skipped() {
        let names = codex_index(&format!("{{\"id\":\"{THREAD}\",\"thread_name\":\"旧名\"}}\nnot json\n{{\"id\":\"{THREAD}\",\"thread_name\":\"新名\"}}\n\
            {{\"id\":\"x\",\"thread_name\":\"  \"}}\n{{\"thread_name\":\"no id\"}}\n"));
        assert_eq!(names.len(), 1);
        assert_eq!(names[THREAD], "新名");
    }

    #[test]
    fn titles_follow_the_index_as_it_grows_and_leave_unnamed_tasks_alone() {
        let p = dir();
        let mut titles = Titles::default();
        let mut items = vec![item(CLIENT_CODEX, THREAD, "first prompt"), item("grok", THREAD, "grok name")];
        // No index file yet.
        titles.apply(&mut items, &p);
        assert_eq!(items[0].title, "first prompt");
        fs::write(p.join("session_index.jsonl"), format!("{{\"id\":\"{THREAD}\",\"thread_name\":\"排查新版部署卡死\"}}\n")).unwrap();
        titles.apply(&mut items, &p);
        assert_eq!(items[0].title, "排查新版部署卡死"); assert_eq!(items[1].title, "grok name");
        // A rename is appended later: the cached parse must not hide it.
        let mut file = fs::OpenOptions::new().append(true).open(p.join("session_index.jsonl")).unwrap();
        std::io::Write::write_all(&mut file, format!("{{\"id\":\"{}\",\"thread_name\":\"改名后\"}}\n", THREAD.to_uppercase()).as_bytes()).unwrap();
        drop(file);
        titles.apply(&mut items, &p);
        assert_eq!(items[0].title, "改名后");
        fs::remove_dir_all(p).unwrap();
    }

    #[test]
    fn claude_cards_take_the_ccgui_name_through_the_database_override() {
        let p = dir(); let db = p.join("app.db");
        ccgui_db(&db, &[("claude", SESSION, Some("📝 方法整理｜卡片文案"))]);
        std::env::set_var("SPELLCAST_CCGUI_DB", &db);
        let mut titles = Titles::default();
        let mut items = vec![item(CLIENT_CLAUDE, SESSION, ""), item(CLIENT_CLAUDE, "d0000000-0000-4000-8000-000000000000", "from the transcript")];
        titles.apply(&mut items, &p);
        std::env::remove_var("SPELLCAST_CCGUI_DB");
        assert_eq!(items[0].title, "📝 方法整理｜卡片文案");
        assert_eq!(items[1].title, "from the transcript");
        fs::remove_dir_all(p).unwrap();
    }
}

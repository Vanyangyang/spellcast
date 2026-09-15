//! Loopback-only Codex hook helper. Never reads prompts, transcripts, or project files.

mod cache;
mod diag;
mod event;
mod http;
mod policy;

pub use cache::{cache_path, transact, CacheState, SaveOutcome};
pub use event::{
    classify_event, is_subagent_event, parse_event, ChildSkip, EventParse, HookEvent, SessionSource,
};
pub use http::{fetch_status, validate_loopback_http_url, ObserverStatus};
pub use policy::{decide, Action, CacheView, Decision};

pub const DEFAULT_ENDPOINT: &str = "http://127.0.0.1:47194/api/observer/status";
pub const HTTP_TIMEOUT_MS: u64 = 500;
pub const STDIN_LIMIT: usize = 64 * 1024;
pub const HTTP_BODY_LIMIT: usize = 8 * 1024;
pub const BOOTSTRAP: &str = include_str!("../../hooks/observer-bootstrap.txt");
pub const STOP: &str = include_str!("../../hooks/observer-stop.txt");

use std::io::{Read, Write};
use std::path::PathBuf;
use std::time::Duration;

#[derive(Debug, Clone)]
pub struct Config {
    pub endpoint: String,
    pub state_dir: Option<PathBuf>,
    pub timeout: Duration,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            endpoint: DEFAULT_ENDPOINT.into(),
            state_dir: None,
            timeout: Duration::from_millis(HTTP_TIMEOUT_MS),
        }
    }
}

pub fn parse_args(args: impl IntoIterator<Item = String>) -> Config {
    parse_config(args, std::env::vars())
}

pub fn parse_config(
    args: impl IntoIterator<Item = String>,
    env: impl IntoIterator<Item = (String, String)>,
) -> Config {
    let mut cfg = Config::default();
    let env: Vec<(String, String)> = env.into_iter().collect();
    fn env_val(env: &[(String, String)], key: &str) -> Option<String> {
        env.iter()
            .find(|(k, _)| k.eq_ignore_ascii_case(key))
            .map(|(_, v)| v.clone())
            .filter(|v| !v.trim().is_empty())
    }
    if let Some(endpoint) = env_val(&env, "SPELLCAST_HOOK_ENDPOINT") {
        cfg.endpoint = endpoint;
    }
    if let Some(dir) = env_val(&env, "SPELLCAST_HOOK_STATE_DIR") {
        cfg.state_dir = Some(PathBuf::from(dir));
    } else if let Some(dir) = env_val(&env, "PLUGIN_DATA") {
        cfg.state_dir = Some(PathBuf::from(dir).join("spellcast-hook"));
    } else if let Some(dir) = env_val(&env, "CLAUDE_PLUGIN_DATA") {
        cfg.state_dir = Some(PathBuf::from(dir).join("spellcast-hook"));
    }
    let mut args = args.into_iter();
    let _exe = args.next();
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--endpoint" => {
                if let Some(value) = args.next() {
                    cfg.endpoint = value;
                }
            }
            "--state-dir" => {
                if let Some(value) = args.next() {
                    cfg.state_dir = Some(PathBuf::from(value));
                }
            }
            "--timeout-ms" => {
                if let Some(value) = args.next() {
                    if let Ok(ms) = value.parse::<u64>() {
                        cfg.timeout = Duration::from_millis(ms.max(1));
                    }
                }
            }
            _ => {}
        }
    }
    cfg
}

pub fn hook_json(event_name: &str, context: &str) -> String {
    serde_json::json!({
        "hookSpecificOutput": {
            "hookEventName": event_name,
            "additionalContext": context
        }
    })
    .to_string()
}

pub fn run(stdin: &mut impl Read, stdout: &mut impl Write, cfg: &Config) -> i32 {
    let mut diag = diag::DiagRecord::new();
    let emit = run_inner(stdin, cfg, &mut diag);
    match &emit {
        Some((name, context)) => {
            diag.stdout = if write!(stdout, "{}", hook_json(name, context)).is_ok() {
                diag::StdoutOutcome::Written
            } else {
                diag::StdoutOutcome::WriteFailed
            };
        }
        None => diag.stdout = diag::StdoutOutcome::Skipped,
    }
    diag::write_record(cfg.state_dir.as_deref(), &diag);
    0
}

fn run_inner(
    stdin: &mut impl Read,
    cfg: &Config,
    diag: &mut diag::DiagRecord,
) -> Option<(String, String)> {
    let mut buf = Vec::new();
    let mut chunk = [0u8; 4096];
    loop {
        let n = match stdin.read(&mut chunk) {
            Ok(n) => n,
            Err(_) => {
                diag.parse = diag::ParseOutcome::Fail;
                return None;
            }
        };
        if n == 0 {
            break;
        }
        if buf.len() + n > STDIN_LIMIT {
            diag.parse = diag::ParseOutcome::Fail;
            return None;
        }
        buf.extend_from_slice(&chunk[..n]);
    }
    if buf.is_empty() {
        diag.parse = diag::ParseOutcome::EmptyStdin;
        return None;
    }
    let event = match classify_event(&buf) {
        EventParse::Ok(event) => event,
        EventParse::Unsupported { event_name } => {
            diag.parse = diag::ParseOutcome::Unsupported;
            diag.event_name = Some(event_name);
            return None;
        }
        EventParse::Fail => {
            diag.parse = diag::ParseOutcome::Fail;
            return None;
        }
    };
    diag.parse = diag::ParseOutcome::Ok;
    diag::fill_event(diag, &event);
    if event.session_id.trim().is_empty() {
        diag.missing_session = true;
        return None;
    }
    if let Some(skip) = event.child_skip {
        diag.child_skip = Some(skip);
        return None;
    }
    let status = match fetch_status(&cfg.endpoint, cfg.timeout) {
        Ok(status) => {
            diag.http = diag::HttpOutcome::Ok;
            Some(status)
        }
        Err(err) => {
            diag.http = diag::http_from_err(&err);
            None
        }
    };
    let (decision, outcome) = transact(
        cfg.state_dir.as_deref(),
        &cfg.endpoint,
        &event,
        status.as_ref(),
        Duration::from_millis(200),
    );
    diag.save = Some(outcome);
    diag.action = Some(decision.action);
    match (decision.action, outcome) {
        (_, SaveOutcome::Busy) => None,
        (Action::Empty, _) => None,
        (Action::Bootstrap | Action::Stop, outcome)
            if event.hook_event_name == "UserPromptSubmit" && outcome != SaveOutcome::Saved =>
        {
            None
        }
        (Action::Bootstrap, _) => Some((event.hook_event_name.clone(), BOOTSTRAP.trim().to_string())),
        (Action::Stop, _) => Some((event.hook_event_name.clone(), STOP.trim().to_string())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hook_json_matches_host_shape() {
        let raw = hook_json("SessionStart", "hello");
        let value: serde_json::Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(
            value["hookSpecificOutput"]["hookEventName"],
            "SessionStart"
        );
        assert_eq!(value["hookSpecificOutput"]["additionalContext"], "hello");
    }

    #[test]
    fn child_skip_and_missing_session_do_not_claim_http() {
        let dir = std::env::temp_dir().join(format!("spellcast-hook-lib-diag-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let cfg = Config {
            endpoint: "http://127.0.0.1:1/api/observer/status".into(),
            state_dir: Some(dir.clone()),
            timeout: Duration::from_millis(50),
        };
        let sub = br#"{"hook_event_name":"SessionStart","session_id":"s","agent_type":"observer"}"#;
        assert_eq!(run(&mut &sub[..], &mut Vec::new(), &cfg), 0);
        let missing = br#"{"hook_event_name":"SessionStart","source":"startup"}"#;
        assert_eq!(run(&mut &missing[..], &mut Vec::new(), &cfg), 0);
        let native = br#"{"hook_event_name":"UserPromptSubmit","session_id":"s","agent_id":"agt-1","agent_type":"default"}"#;
        assert_eq!(run(&mut &native[..], &mut Vec::new(), &cfg), 0);
        let terra = br#"{"hook_event_name":"UserPromptSubmit","session_id":"s","agentId":"agt-2","agent_type":"terra_max"}"#;
        assert_eq!(run(&mut &terra[..], &mut Vec::new(), &cfg), 0);
        let unsupported = br#"{"hook_event_name":"PreToolUse","session_id":"s","prompt":"secret"}"#;
        assert_eq!(run(&mut &unsupported[..], &mut Vec::new(), &cfg), 0);
        let raw = std::fs::read_to_string(dir.join("diag.jsonl")).unwrap();
        assert!(raw.contains("\"child_skip\":\"compat_agent_type\""));
        assert!(raw.contains("\"child_skip\":\"native_agent_id\""));
        assert!(raw.contains("\"missing_session\":true"));
        assert!(raw.contains("\"parse\":\"unsupported_event\""));
        assert!(raw.contains("\"event\":\"PreToolUse\""));
        assert!(!raw.contains("\"parse\":\"fail\""));
        assert!(raw.contains("\"http\":\"not_attempted\""));
        assert!(!raw.contains("\"http\":\"ok\""));
        assert!(!raw.contains("secret"));
        assert!(!raw.contains("agt-1"));
    }

    #[test]
    fn parent_metadata_alone_still_attempts_http() {
        let dir = std::env::temp_dir().join(format!(
            "spellcast-hook-lib-parent-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let cfg = Config {
            endpoint: "http://127.0.0.1:1/api/observer/status".into(),
            state_dir: Some(dir.clone()),
            timeout: Duration::from_millis(50),
        };
        let parent = br#"{"hook_event_name":"SessionStart","session_id":"s","parent_session_id":"PARENT-SECRET-XYZ","source":"startup"}"#;
        let mut out = Vec::new();
        assert_eq!(run(&mut &parent[..], &mut out, &cfg), 0);
        let raw = std::fs::read_to_string(dir.join("diag.jsonl")).unwrap();
        let line: serde_json::Value = serde_json::from_str(raw.lines().next().unwrap()).unwrap();
        assert!(line.get("child_skip").unwrap().is_null());
        assert!(
            line["http"] == "transport" || line["http"] == "rejected_url",
            "{line}"
        );
        assert_eq!(line["parse"], "ok");
        assert!(!raw.contains("PARENT-SECRET-XYZ"));
        assert!(!raw.contains("parent_session"));
    }

    struct FailWriter;

    impl Write for FailWriter {
        fn write(&mut self, _buf: &[u8]) -> std::io::Result<usize> {
            Err(std::io::Error::other("stdout fail"))
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Err(std::io::Error::other("stdout fail"))
        }
    }

    fn serve_on_status() -> String {
        use std::io::{Read, Write as IoWrite};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let addr = listener.local_addr().unwrap();
        let body = serde_json::json!({
            "enabled": true,
            "paused": false,
            "allowed": true,
            "reason": "ok",
            "policy_revision": 1
        })
        .to_string();
        std::thread::spawn(move || loop {
            match listener.accept() {
                Ok((mut stream, _)) => {
                    let mut buf = [0u8; 1024];
                    let _ = stream.read(&mut buf);
                    let head = format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                        body.len()
                    );
                    let _ = stream.write_all(head.as_bytes());
                    let _ = stream.write_all(body.as_bytes());
                }
                Err(err) if err.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::sleep(Duration::from_millis(5));
                }
                Err(_) => break,
            }
        });
        format!("http://127.0.0.1:{}/api/observer/status", addr.port())
    }

    #[test]
    fn failing_stdout_writer_still_returns_zero() {
        let dir = std::env::temp_dir().join(format!(
            "spellcast-hook-lib-failout-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let cfg = Config {
            endpoint: serve_on_status(),
            state_dir: Some(dir.clone()),
            timeout: Duration::from_millis(400),
        };
        let start = br#"{"hook_event_name":"SessionStart","session_id":"s","source":"startup"}"#;
        assert_eq!(run(&mut &start[..], &mut FailWriter, &cfg), 0);
        let raw = std::fs::read_to_string(dir.join("diag.jsonl")).unwrap();
        assert!(raw.contains("\"stdout_write\":\"write_failed\""), "{raw}");
        assert!(raw.contains("\"action\":\"bootstrap\""), "{raw}");
    }
}

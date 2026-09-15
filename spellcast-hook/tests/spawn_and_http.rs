use std::io::{Read, Write};
use std::net::TcpListener;
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use spellcast_hook::{hook_json, ObserverStatus, BOOTSTRAP, STOP};

fn on_json(rev: u64) -> String {
    serde_json::json!({
        "enabled": true,
        "paused": false,
        "allowed": true,
        "reason": "ok",
        "policy_revision": rev
    })
    .to_string()
}

fn off_json(rev: u64) -> String {
    serde_json::json!({
        "enabled": false,
        "paused": false,
        "allowed": false,
        "reason": "disabled",
        "policy_revision": rev
    })
    .to_string()
}

struct Mock {
    url: String,
    queue: Arc<Mutex<Vec<MockResp>>>,
    fallback: Arc<Mutex<String>>,
}

struct MockResp {
    status: String,
    headers: Vec<(String, String)>,
    body: String,
}

impl Mock {
    fn start() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let addr = listener.local_addr().unwrap();
        let queue = Arc::new(Mutex::new(Vec::<MockResp>::new()));
        let fallback = Arc::new(Mutex::new(off_json(0)));
        let q = queue.clone();
        let fb = fallback.clone();
        thread::spawn(move || loop {
            match listener.accept() {
                Ok((mut stream, _)) => {
                    let mut buf = [0u8; 2048];
                    let _ = stream.read(&mut buf);
                    let resp = q.lock().unwrap().pop().unwrap_or(MockResp {
                        status: "200 OK".into(),
                        headers: vec![("Content-Type".into(), "application/json".into())],
                        body: fb.lock().unwrap().clone(),
                    });
                    let mut head = format!("HTTP/1.1 {}\r\nContent-Length: {}\r\nConnection: close\r\n", resp.status, resp.body.len());
                    for (k, v) in resp.headers {
                        head.push_str(&format!("{k}: {v}\r\n"));
                    }
                    head.push_str("\r\n");
                    let _ = stream.write_all(head.as_bytes());
                    let _ = stream.write_all(resp.body.as_bytes());
                }
                Err(err) if err.kind() == std::io::ErrorKind::WouldBlock => {
                    thread::sleep(Duration::from_millis(5));
                }
                Err(_) => break,
            }
        });
        Self {
            url: format!("http://127.0.0.1:{}/api/observer/status", addr.port()),
            queue,
            fallback,
        }
    }

    fn set_fallback(&self, body: String) {
        *self.fallback.lock().unwrap() = body;
    }

    fn push_ok(&self, body: String) {
        self.queue.lock().unwrap().insert(
            0,
            MockResp {
                status: "200 OK".into(),
                headers: vec![("Content-Type".into(), "application/json".into())],
                body,
            },
        );
    }

    fn push_redirect(&self, location: &str) {
        self.queue.lock().unwrap().insert(
            0,
            MockResp {
                status: "302 Found".into(),
                headers: vec![("Location".into(), location.into())],
                body: String::new(),
            },
        );
    }
}

fn hook_cmd() -> Command {
    let exe = env!("CARGO_BIN_EXE_spellcast-hook");
    let mut cmd = Command::new(exe);
    cmd.env_remove("PLUGIN_DATA")
        .env_remove("CLAUDE_PLUGIN_DATA")
        .env_remove("SPELLCAST_HOOK_STATE_DIR")
        .env_remove("SPELLCAST_HOOK_ENDPOINT");
    cmd
}

fn run_hook(endpoint: &str, state_dir: &str, stdin: &str) -> (String, String, i32) {
    let mut child = hook_cmd()
        .args(["--endpoint", endpoint, "--state-dir", state_dir, "--timeout-ms", "400"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child.stdin.take().unwrap().write_all(stdin.as_bytes()).unwrap();
    let output = child.wait_with_output().unwrap();
    (
        String::from_utf8_lossy(&output.stdout).into_owned(),
        String::from_utf8_lossy(&output.stderr).into_owned(),
        output.status.code().unwrap_or(1),
    )
}

fn session_start(source: &str) -> String {
    serde_json::json!({
        "hook_event_name": "SessionStart",
        "session_id": "sess-1",
        "source": source
    })
    .to_string()
}

fn prompt() -> String {
    serde_json::json!({
        "hook_event_name": "UserPromptSubmit",
        "session_id": "sess-1"
    })
    .to_string()
}

#[test]
fn spawn_covers_on_off_resume_subagent_and_paths() {
    let mock = Mock::start();
    let dir = std::env::temp_dir().join(format!("spellcast hook 中文 {}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let dir = dir.to_string_lossy().into_owned();

    mock.push_ok(off_json(0));
    let (out, err, code) = run_hook(&mock.url, &dir, &session_start("startup"));
    assert_eq!(code, 0);
    assert!(err.is_empty(), "{err}");
    assert!(out.is_empty());

    mock.push_ok(on_json(1));
    let (out, err, code) = run_hook(&mock.url, &dir, &session_start("startup"));
    assert_eq!(code, 0);
    assert!(err.is_empty(), "{err}");
    let value: serde_json::Value = serde_json::from_str(&out).unwrap();
    assert_eq!(value["hookSpecificOutput"]["hookEventName"], "SessionStart");
    assert_eq!(
        value["hookSpecificOutput"]["additionalContext"].as_str().unwrap().trim(),
        BOOTSTRAP.trim()
    );

    mock.push_ok(on_json(1));
    let (out, err, code) = run_hook(&mock.url, &dir, &prompt());
    assert_eq!(code, 0);
    assert!(err.is_empty(), "{err}");
    assert!(out.is_empty(), "repeat prompt must be empty: {out}");

    mock.push_ok(on_json(1));
    let (out, _, _) = run_hook(&mock.url, &dir, &session_start("resume"));
    let value: serde_json::Value = serde_json::from_str(&out).unwrap();
    assert_eq!(value["hookSpecificOutput"]["hookEventName"], "SessionStart");

    mock.push_ok(on_json(1));
    let (out, _, _) = run_hook(&mock.url, &dir, &session_start("compact"));
    assert!(out.contains("SessionStart"));

    mock.push_ok(off_json(2));
    let (out, _, _) = run_hook(&mock.url, &dir, &prompt());
    let value: serde_json::Value = serde_json::from_str(&out).unwrap();
    assert_eq!(
        value["hookSpecificOutput"]["additionalContext"].as_str().unwrap().trim(),
        STOP.trim()
    );

    mock.push_ok(on_json(3));
    let (out, _, _) = run_hook(&mock.url, &dir, &prompt());
    assert!(out.contains("UserPromptSubmit"));

    let sub = serde_json::json!({
        "hook_event_name": "SessionStart",
        "session_id": "sess-1",
        "source": "startup",
        "agent_type": "subagent"
    })
    .to_string();
    mock.push_ok(on_json(3));
    let (out, err, code) = run_hook(&mock.url, &dir, &sub);
    assert_eq!(code, 0);
    assert!(err.is_empty());
    assert!(out.is_empty());
    let diag = std::fs::read_to_string(std::path::Path::new(&dir).join("diag.jsonl")).unwrap();
    assert!(diag.contains("\"child_skip\":\"compat_agent_type\""), "{diag}");
    assert!(diag.contains("\"http\":\"not_attempted\""), "{diag}");

    let _ = ObserverStatus {
        enabled: true,
        paused: false,
        allowed: true,
        reason: "ok".into(),
        policy_revision: 1,
    };
    let _ = hook_json("SessionStart", "x");
}

#[test]
fn spawn_rejects_illegal_oversize_remote_and_redirect() {
    let mock = Mock::start();
    let dir = std::env::temp_dir().join(format!("spellcast-hook-reject-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let dir = dir.to_string_lossy().into_owned();

    let (out, err, code) = run_hook(&mock.url, &dir, "{not json");
    assert_eq!(code, 0);
    assert!(out.is_empty());
    assert!(err.is_empty(), "{err}");

    let huge = format!("{{\"hook_event_name\":\"SessionStart\",\"session_id\":\"{}\"}}", "x".repeat(70_000));
    let (out, _, code) = run_hook(&mock.url, &dir, &huge);
    assert_eq!(code, 0);
    assert!(out.is_empty());

    let (out, _, code) = run_hook(
        "http://example.com/api/observer/status",
        &dir,
        &session_start("startup"),
    );
    assert_eq!(code, 0);
    assert!(out.is_empty());

    mock.push_redirect("http://example.com/steal");
    let (out, _, code) = run_hook(&mock.url, &dir, &session_start("startup"));
    assert_eq!(code, 0);
    assert!(out.is_empty());

    let missing = serde_json::json!({"hook_event_name":"SessionStart","source":"startup"}).to_string();
    mock.push_ok(on_json(1));
    let (out, _, code) = run_hook(&mock.url, &dir, &missing);
    assert_eq!(code, 0);
    assert!(out.is_empty());

    std::fs::write(
        spellcast_hook::cache_path(std::path::Path::new(&dir), &mock.url, "sess-1"),
        "not-json",
    )
    .unwrap();
    mock.push_ok(on_json(1));
    let (out, _, _) = run_hook(&mock.url, &dir, &prompt());
    assert!(out.is_empty(), "corrupt cache must not repeat on prompt: {out}");
    mock.push_ok(on_json(1));
    let (out, _, _) = run_hook(&mock.url, &dir, &session_start("startup"));
    assert!(out.contains("SessionStart"), "{out}");
}

#[test]
fn spawn_without_cache_dir_does_not_repeat_prompt() {
    let mock = Mock::start();
    mock.set_fallback(on_json(1));
    let mut child = hook_cmd()
        .args(["--endpoint", &mock.url, "--timeout-ms", "400"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(session_start("startup").as_bytes())
        .unwrap();
    let first = child.wait_with_output().unwrap();
    assert!(String::from_utf8_lossy(&first.stdout).contains("SessionStart"));
    let mut child = hook_cmd()
        .args(["--endpoint", &mock.url, "--timeout-ms", "400"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(prompt().as_bytes())
        .unwrap();
    let second = child.wait_with_output().unwrap();
    assert!(
        String::from_utf8_lossy(&second.stdout).is_empty(),
        "{}",
        String::from_utf8_lossy(&second.stdout)
    );
}

#[test]
fn spawn_concurrent_session_and_prompt_bootstrap_once() {
    let mock = Mock::start();
    mock.set_fallback(on_json(4));
    let dir = std::env::temp_dir().join(format!("spellcast hook conc {}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let dir = dir.to_string_lossy().into_owned();
    let url = mock.url.clone();
    let start = session_start("startup");
    let msg = prompt();
    let handles: Vec<_> = (0..2)
        .map(|i| {
            let url = url.clone();
            let dir = dir.clone();
            let stdin = if i == 0 { start.clone() } else { msg.clone() };
            std::thread::spawn(move || run_hook(&url, &dir, &stdin))
        })
        .collect();
    let outs: Vec<_> = handles.into_iter().map(|h| h.join().unwrap()).collect();
    let nonempty = outs
        .iter()
        .filter(|(out, _, _)| out.contains("additionalContext"))
        .count();
    assert_eq!(nonempty, 1, "{outs:?}");
    assert!(outs.iter().all(|(_, err, code)| err.is_empty() && *code == 0));
}

#[test]
fn spawn_second_startup_empty_while_lock_held() {
    use std::fs::OpenOptions;
    let mock = Mock::start();
    mock.set_fallback(on_json(1));
    let dir = std::env::temp_dir().join(format!("spellcast hook busy {}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let dir_s = dir.to_string_lossy().into_owned();
    let cache = spellcast_hook::cache_path(&dir, &mock.url, "sess-1");
    let lock_path = cache.with_extension("lock");
    let lock = OpenOptions::new().create(true).read(true).write(true).open(&lock_path).unwrap();
    fs2::FileExt::lock_exclusive(&lock).unwrap();
    let (out, err, code) = run_hook(&mock.url, &dir_s, &session_start("startup"));
    assert_eq!(code, 0);
    assert!(err.is_empty());
    assert!(out.is_empty(), "busy must be empty: {out}");
    drop(lock);
    let (out2, _, _) = run_hook(&mock.url, &dir_s, &session_start("startup"));
    assert!(out2.contains("SessionStart"), "{out2}");
}

#[test]
fn spawn_child_skip_follows_codex_contract() {
    let mock = Mock::start();
    mock.set_fallback(on_json(7));
    let dir = std::env::temp_dir().join(format!("spellcast hook contract {}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let dir_s = dir.to_string_lossy().into_owned();

    let native_default = serde_json::json!({
        "hook_event_name": "UserPromptSubmit",
        "session_id": "native-default",
        "agent_id": "agt-1",
        "agent_type": "default"
    })
    .to_string();
    let (out, err, code) = run_hook(&mock.url, &dir_s, &native_default);
    assert_eq!(code, 0);
    assert!(err.is_empty(), "{err}");
    assert!(out.is_empty(), "{out}");

    let native_terra = serde_json::json!({
        "hook_event_name": "UserPromptSubmit",
        "session_id": "native-terra",
        "agentId": "agt-2",
        "agent_type": "terra_max"
    })
    .to_string();
    let (out, err, code) = run_hook(&mock.url, &dir_s, &native_terra);
    assert_eq!(code, 0);
    assert!(err.is_empty(), "{err}");
    assert!(out.is_empty(), "{out}");

    let parent = serde_json::json!({
        "hook_event_name": "SessionStart",
        "session_id": "user-parent-only",
        "source": "startup",
        "parent_session_id": "PARENT-SECRET-XYZ"
    })
    .to_string();
    let (out, err, code) = run_hook(&mock.url, &dir_s, &parent);
    assert_eq!(code, 0);
    assert!(err.is_empty(), "{err}");
    assert!(out.contains("SessionStart"), "{out}");

    let spawned = serde_json::json!({
        "hook_event_name": "UserPromptSubmit",
        "session_id": "user-spawned-only",
        "spawned_by": "SPAWNED-SECRET-XYZ"
    })
    .to_string();
    let (out, err, code) = run_hook(&mock.url, &dir_s, &spawned);
    assert_eq!(code, 0);
    assert!(err.is_empty(), "{err}");
    assert!(out.contains("UserPromptSubmit"), "{out}");

    let flag = serde_json::json!({
        "hook_event_name": "SessionStart",
        "session_id": "compat-flag",
        "source": "startup",
        "is_subagent": true
    })
    .to_string();
    let (out, err, code) = run_hook(&mock.url, &dir_s, &flag);
    assert_eq!(code, 0);
    assert!(err.is_empty(), "{err}");
    assert!(out.is_empty(), "{out}");

    let ordinary = session_start("startup");
    let (out, err, code) = run_hook(&mock.url, &dir_s, &ordinary);
    assert_eq!(code, 0);
    assert!(err.is_empty(), "{err}");
    assert!(out.contains("SessionStart"), "{out}");

    let diag = std::fs::read_to_string(dir.join("diag.jsonl")).unwrap();
    assert!(diag.contains("\"child_skip\":\"native_agent_id\""), "{diag}");
    assert!(diag.contains("\"child_skip\":\"flag\""), "{diag}");
    assert!(diag.contains("\"http\":\"not_attempted\""), "{diag}");
    assert!(diag.contains("\"http\":\"ok\""), "{diag}");
    assert!(!diag.contains("PARENT-SECRET-XYZ"));
    assert!(!diag.contains("SPAWNED-SECRET-XYZ"));
    assert!(!diag.contains("agt-1"));
    for line in diag.lines().filter(|l| !l.is_empty()) {
        let v: serde_json::Value = serde_json::from_str(line).unwrap();
        if v["child_skip"] == "native_agent_id" || v["child_skip"] == "flag" {
            assert_eq!(v["http"], "not_attempted", "{v}");
        }
        if v["event"] == "SessionStart" && v.get("child_skip").map(|c| c.is_null()).unwrap_or(true) {
            assert_eq!(v["http"], "ok", "{v}");
        }
    }
}

#[test]
fn spawn_unsupported_event_is_not_parse_fail() {
    let mock = Mock::start();
    mock.set_fallback(on_json(1));
    let dir = std::env::temp_dir().join(format!("spellcast hook unsup {}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let dir_s = dir.to_string_lossy().into_owned();
    let pre = serde_json::json!({
        "hook_event_name": "PreToolUse",
        "session_id": "s",
        "prompt": "secret-prompt"
    })
    .to_string();
    let (out, err, code) = run_hook(&mock.url, &dir_s, &pre);
    assert_eq!(code, 0);
    assert!(err.is_empty(), "{err}");
    assert!(out.is_empty(), "{out}");
    let diag = std::fs::read_to_string(dir.join("diag.jsonl")).unwrap();
    let line: serde_json::Value = serde_json::from_str(diag.lines().next().unwrap()).unwrap();
    assert_eq!(line["parse"], "unsupported_event");
    assert_eq!(line["http"], "not_attempted");
    assert_eq!(line["event"], "PreToolUse");
    assert_ne!(line["parse"], "fail");
    assert!(!diag.contains("secret-prompt"));
}

#[test]
fn spawn_returns_before_stalled_diag_writer() {
    let mock = Mock::start();
    mock.set_fallback(on_json(1));
    // Non-existent state_dir so the worker must run exists/is_dir path selection after the stall.
    let dir = std::env::temp_dir().join(format!("spellcast hook stall {}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let started = std::time::Instant::now();
    let mut child = hook_cmd()
        .env("SPELLCAST_HOOK_DIAG_STALL_MS", "3000")
        .args([
            "--endpoint",
            &mock.url,
            "--state-dir",
            &dir.to_string_lossy(),
            "--timeout-ms",
            "400",
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(session_start("startup").as_bytes())
        .unwrap();
    let output = child.wait_with_output().unwrap();
    let elapsed = started.elapsed();
    assert!(
        elapsed < Duration::from_millis(1200),
        "helper waited for stalled diag writer: {elapsed:?}"
    );
    assert_eq!(output.status.code(), Some(0));
    assert!(String::from_utf8_lossy(&output.stderr).is_empty());
    assert!(String::from_utf8_lossy(&output.stdout).contains("SessionStart"));
}

#[test]
fn spawn_diag_lock_does_not_affect_stdout() {
    use std::fs::OpenOptions;
    let mock = Mock::start();
    mock.set_fallback(on_json(1));
    let dir = std::env::temp_dir().join(format!("spellcast hook diaglock {}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let dir_s = dir.to_string_lossy().into_owned();
    let diag_path = dir.join("diag.jsonl");
    std::fs::write(&diag_path, b"keep\n").unwrap();
    let lock = OpenOptions::new()
        .create(true)
        .read(true)
        .write(true)
        .open(&diag_path)
        .unwrap();
    fs2::FileExt::lock_exclusive(&lock).unwrap();
    let (out, err, code) = run_hook(&mock.url, &dir_s, &session_start("startup"));
    assert_eq!(code, 0);
    assert!(err.is_empty(), "{err}");
    assert!(out.contains("SessionStart"), "{out}");
    drop(lock);
    assert_eq!(std::fs::read_to_string(&diag_path).unwrap(), "keep\n");
}

#[test]
fn spawn_concurrent_helpers_keep_diag_bounded_and_parseable() {
    let mock = Mock::start();
    mock.set_fallback(on_json(9));
    let dir = std::env::temp_dir().join(format!("spellcast hook diagconc {}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let diag_path = dir.join("diag.jsonl");
    std::fs::write(&diag_path, vec![b'x'; (256 * 1024) - 80]).unwrap();
    let dir_s = dir.to_string_lossy().into_owned();
    let url = mock.url.clone();
    let handles: Vec<_> = (0..8)
        .map(|i| {
            let url = url.clone();
            let dir = dir_s.clone();
            let stdin = serde_json::json!({
                "hook_event_name": "SessionStart",
                "session_id": format!("conc-{i}"),
                "source": "startup"
            })
            .to_string();
            std::thread::spawn(move || run_hook(&url, &dir, &stdin))
        })
        .collect();
    let outs: Vec<_> = handles.into_iter().map(|h| h.join().unwrap()).collect();
    assert!(outs.iter().all(|(_, err, code)| err.is_empty() && *code == 0));
    let meta = std::fs::metadata(&diag_path).unwrap();
    assert!(
        meta.len() <= 256 * 1024,
        "diag grew past cap: {}",
        meta.len()
    );
    let raw = std::fs::read_to_string(&diag_path).unwrap();
    let mut parsed = 0;
    for line in raw.lines() {
        if line.is_empty() {
            continue;
        }
        if !line.starts_with('{') {
            continue;
        }
        let v: serde_json::Value = serde_json::from_str(line).expect(line);
        assert!(v.get("prompt").is_none());
        assert!(v.get("transcript").is_none());
        assert!(v.get("cwd").is_none());
        assert!(v.get("parse").is_some());
        parsed += 1;
    }
    assert!(parsed >= 1, "expected at least one diag JSON line, got {raw:?}");
}

#[test]
fn plugin_data_env_is_used_when_state_dir_absent() {
    let mock = Mock::start();
    mock.set_fallback(on_json(1));
    let plugin_data = std::env::temp_dir().join(format!("plugin data {}", std::process::id()));
    std::fs::create_dir_all(&plugin_data).unwrap();
    let mut child = hook_cmd()
        .env("PLUGIN_DATA", &plugin_data)
        .args(["--endpoint", &mock.url, "--timeout-ms", "400"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(session_start("startup").as_bytes())
        .unwrap();
    let first = child.wait_with_output().unwrap();
    assert!(String::from_utf8_lossy(&first.stdout).contains("SessionStart"));
    let cache_dir = plugin_data.join("spellcast-hook");
    assert!(cache_dir.read_dir().unwrap().next().is_some());
}

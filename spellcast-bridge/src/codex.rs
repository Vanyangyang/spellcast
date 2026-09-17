//! Read-only Codex task metadata and binding verification. Never starts a model.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};

const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);
const MAX_FRAME: u64 = 2 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CodexBinding {
    pub source_id: String,
    pub thread_id: String,
    pub cwd: String,
    pub label: String,
    pub executable: PathBuf,
    pub protocol_agent: String,
    pub bound_at_ms: u64,
}

#[derive(Debug, Clone)]
pub struct CodexError {
    pub message: String,
    /// After a write was attempted, an absent receipt is not permission to resend.
    pub uncertain: bool,
}

impl CodexError {
    fn new(message: impl Into<String>, uncertain: bool) -> Self {
        Self {
            message: message.into(),
            uncertain,
        }
    }
    fn before_send(mut self) -> Self {
        self.uncertain = false;
        self
    }
}

/// Prefer the same PATH entry the CLI launcher uses; npm's Windows shim needs
/// its actual executable because user input is never passed through a shell.
pub fn find_executable() -> Result<PathBuf, CodexError> {
    if let Some(explicit) = std::env::var_os("SPELLCAST_CODEX_BIN") {
        let path = PathBuf::from(explicit);
        if path.is_absolute() && path.is_file() {
            return Ok(path);
        }
        return Err(CodexError::new(
            "SPELLCAST_CODEX_BIN 没有指向存在的绝对可执行文件路径。",
            false,
        ));
    }
    for dir in std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default()) {
        #[cfg(windows)]
        {
            let direct = dir.join("codex.exe");
            if direct.is_file() {
                return Ok(direct);
            }
            if dir.join("codex.cmd").is_file() {
                let (package, target) = if cfg!(target_arch = "aarch64") {
                    ("codex-win32-arm64", "aarch64-pc-windows-msvc")
                } else {
                    ("codex-win32-x64", "x86_64-pc-windows-msvc")
                };
                let root = dir.join("node_modules/@openai/codex");
                for vendor in [
                    root.join(format!("node_modules/@openai/{package}/vendor")),
                    root.join("vendor"),
                ] {
                    let exe = vendor.join(target).join("bin/codex.exe");
                    if exe.is_file() {
                        return Ok(exe);
                    }
                }
            }
        }
        #[cfg(not(windows))]
        {
            let direct = dir.join("codex");
            if direct.is_file() {
                return Ok(direct);
            }
        }
    }
    Err(CodexError::new(
        "找不到 Codex 可执行文件。请安装 Codex CLI 后重新连接任务。",
        false,
    ))
}

struct Rpc {
    child: Child,
    input: Option<ChildStdin>,
    output: BufReader<ChildStdout>,
    next_id: u64,
    protocol_agent: String,
}

impl Rpc {
    async fn open(executable: &Path) -> Result<Self, CodexError> {
        Self::open_in_profile(executable, None).await
    }

    async fn open_in_profile(executable: &Path, profile: Option<(&Path, &Path)>) -> Result<Self, CodexError> {
        let mut command = Command::new(executable);
        command
            .args(["app-server", "--stdio"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        if let Some((user_home, codex_home)) = profile {
            command.current_dir(user_home).env("HOME", user_home)
                .env("USERPROFILE", user_home).env("CODEX_HOME", codex_home);
        }
        #[cfg(windows)]
        command.creation_flags(0x0800_0000); // This owned protocol helper has no interactive window.
        let mut child = command
            .spawn()
            .map_err(|e| CodexError::new(format!("无法启动 Codex 连接：{e}"), false))?;
        let input = child.stdin.take().expect("piped stdin");
        let output = child.stdout.take().expect("piped stdout");
        let mut rpc = Self {
            child,
            input: Some(input),
            output: BufReader::new(output),
            next_id: 0,
            protocol_agent: String::new(),
        };
        let initialized = rpc
            .request(
                "initialize",
                json!({
                    "clientInfo": { "name": "spellcast", "version": crate::VERSION },
                    "capabilities": { "experimentalApi": true }
                }),
            )
            .await
            .map_err(CodexError::before_send)?;
        rpc.protocol_agent = initialized
            .get("userAgent")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        rpc.write(json!({ "method": "initialized" }))
            .await
            .map_err(CodexError::before_send)?;
        Ok(rpc)
    }

    async fn write(&mut self, value: Value) -> Result<(), CodexError> {
        let mut bytes = serde_json::to_vec(&value).expect("JSON value");
        bytes.push(b'\n');
        self.input
            .as_mut()
            .ok_or_else(|| CodexError::new("Codex 连接已关闭。", true))?
            .write_all(&bytes)
            .await
            .map_err(|e| CodexError::new(format!("Codex 连接写入失败：{e}"), true))
    }

    async fn request(&mut self, method: &str, params: Value) -> Result<Value, CodexError> {
        self.next_id += 1;
        let id = self.next_id;
        tokio::time::timeout(REQUEST_TIMEOUT, async {
            self.write(json!({ "id": id, "method": method, "params": params }))
                .await?;
            loop {
                let mut line = Vec::new();
                let count = (&mut self.output)
                    .take(MAX_FRAME + 1)
                    .read_until(b'\n', &mut line)
                    .await
                    .map_err(|e| CodexError::new(format!("Codex 连接读取失败：{e}"), true))?;
                if count == 0 {
                    return Err(CodexError::new("Codex 在返回确认前关闭了连接。", true));
                }
                if count as u64 > MAX_FRAME {
                    return Err(CodexError::new("Codex 返回的数据超过连接上限。", true));
                }
                let message: Value = serde_json::from_slice(&line)
                    .map_err(|_| CodexError::new("Codex 返回了无法识别的协议数据。", true))?;
                if message.get("id").and_then(Value::as_u64) != Some(id) {
                    continue;
                }
                return rpc_result(message);
            }
        })
        .await
        .map_err(|_| CodexError::new(format!("Codex {method} 未在 15 秒内返回确认。"), true))?
    }

    async fn close(mut self) {
        // EOF normally closes app-server cleanly. Drop is only a final guard for
        // this helper if it hangs or the containing application is shutting down.
        self.input.take();
        if tokio::time::timeout(Duration::from_secs(3), self.child.wait())
            .await
            .is_err()
        {
            let _ = self.child.kill().await;
            let _ = self.child.wait().await;
        }
    }

}

/// Ask Codex to evaluate current hook hashes and trust. Never creates a thread,
/// runs a hook, or writes trust. The caller supplies the exact installation profile.
pub async fn list_hooks(executable: &Path, user_home: &Path, codex_home: &Path) -> Result<Value, CodexError> {
    let mut rpc = Rpc::open_in_profile(executable, Some((user_home, codex_home))).await?;
    let result = rpc.request("hooks/list", json!({ "cwds": [user_home] })).await;
    rpc.close().await;
    result.map_err(CodexError::before_send)
}

fn rpc_result(message: Value) -> Result<Value, CodexError> {
    if let Some(error) = message.get("error") {
        let code = error.get("code").and_then(Value::as_i64);
        let text = error
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("未知协议错误");
        let safe_text: String = text.chars().take(500).collect();
        return Err(CodexError::new(
            format!("Codex 拒绝请求：{safe_text}"),
            !matches!(code, Some(-32600 | -32601 | -32602)),
        ));
    }
    message
        .get("result")
        .cloned()
        .ok_or_else(|| CodexError::new("Codex 没有返回确认结果。", true))
}

pub async fn verify_binding(
    source_id: String,
    thread_id: String,
    expected_cwd: Option<String>,
) -> Result<CodexBinding, CodexError> {
    let thread_id = uuid::Uuid::parse_str(&thread_id)
        .map_err(|_| CodexError::new("需要原任务的实际 UUID，不能使用模型名或任务标签。", false))?
        .to_string();
    let executable = find_executable()?;
    let mut rpc = Rpc::open(&executable).await?;
    let result = async {
        let read = rpc
            .request(
                "thread/read",
                json!({ "threadId": thread_id, "includeTurns": false }),
            )
            .await
            .map_err(CodexError::before_send)?;
        let thread = read
            .get("thread")
            .ok_or_else(|| CodexError::new("Codex 没有返回指定任务。", false))?;
        if thread.get("id").and_then(Value::as_str) != Some(thread_id.as_str()) {
            return Err(CodexError::new("Codex 返回的任务与请求不一致。", false));
        }
        let cwd = thread
            .get("cwd")
            .and_then(Value::as_str)
            .ok_or_else(|| CodexError::new("原任务没有可验证的工作目录。", false))?;
        let actual = std::fs::canonicalize(cwd)
            .map_err(|_| CodexError::new("原任务的本地工作目录不存在。", false))?;
        if let Some(expected) = expected_cwd {
            if !Path::new(&expected).is_absolute()
                || std::fs::canonicalize(expected).ok().as_ref() != Some(&actual)
            {
                return Err(CodexError::new(
                    "原任务工作目录不匹配；没有绑定其他项目。",
                    false,
                ));
            }
        }
        let label = thread
            .get("name")
            .and_then(Value::as_str)
            .filter(|v| !v.trim().is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| {
                Path::new(cwd)
                    .file_name()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .into_owned()
            });
        Ok(CodexBinding {
            source_id,
            thread_id,
            cwd: cwd.to_string(),
            label,
            executable,
            protocol_agent: rpc.protocol_agent.clone(),
            bound_at_ms: spellcast_core::inbox::now_ms(),
        })
    }
    .await;
    rpc.close().await;
    result
}

#[derive(Debug, Clone)]
pub enum TaskPresence {
    Present { label: String, cwd: String },
    Deleted,
    Unknown(String),
}

fn presence_from_thread(thread: &Value, id: &str) -> Option<TaskPresence> {
    if thread.get("id").and_then(Value::as_str) != Some(id) { return None; }
    Some(TaskPresence::Present {
        label: thread.get("name").and_then(Value::as_str).unwrap_or_default().to_owned(),
        cwd: thread.get("cwd").and_then(Value::as_str).unwrap_or_default().to_owned(),
    })
}

/// Metadata-only lookup. A `not loaded` rejection alone is not proof of deletion.
pub async fn task_presence(executable: &Path, id: &str) -> TaskPresence {
    let mut rpc = match Rpc::open(executable).await { Ok(rpc) => rpc, Err(error) => return TaskPresence::Unknown(error.message) };
    let outcome = tokio::time::timeout(Duration::from_secs(20), async {
        match rpc.request("thread/read", json!({"threadId":id,"includeTurns":false})).await {
            Ok(read) => return presence_from_thread(&read["thread"], id).unwrap_or_else(|| TaskPresence::Unknown("返回的任务身份不匹配。".into())),
            Err(error) => {
                if error.uncertain || error.message != format!("Codex 拒绝请求：thread not loaded: {id}") {
                    return TaskPresence::Unknown(error.message);
                }
            }
        }
        // Include every provider/source and archived tasks. Only a complete successful
        // listing can establish absence; pagination limits and transport failures stay unknown.
        for archived in [false, true] {
            let mut cursor = None::<String>; let mut complete = false;
            for _ in 0..128 {
                // Thread previews can be large; keep each metadata page within the
                // protocol frame bound without reducing the total scan allowance.
                let page = match rpc.request("thread/list", json!({"limit":25,"cursor":cursor,"archived":archived,"modelProviders":[],"sourceKinds":["cli","vscode","exec","appServer","subAgent","subAgentReview","subAgentCompact","subAgentThreadSpawn","subAgentOther","unknown"]})).await {
                    Ok(page) => page, Err(error) => return TaskPresence::Unknown(error.message),
                };
                let Some(data) = page.get("data").and_then(Value::as_array) else { return TaskPresence::Unknown("无法识别任务列表。".into()); };
                if data.iter().any(|thread| thread.get("id").and_then(Value::as_str).is_none()) { return TaskPresence::Unknown("任务列表缺少稳定身份。".into()); }
                if let Some(found) = data.iter().find_map(|thread| presence_from_thread(thread, id)) { return found; }
                let Some(next) = page.get("nextCursor") else { return TaskPresence::Unknown("任务列表缺少分页确认。".into()); };
                if !next.is_null() && !next.is_string() { return TaskPresence::Unknown("无法确认任务列表是否完整。".into()); }
                cursor = next.as_str().map(str::to_owned);
                if cursor.is_none() { complete = true; break; }
            }
            if !complete { return TaskPresence::Unknown("任务列表尚未完整核验。".into()); }
        }
        TaskPresence::Deleted
    }).await.unwrap_or_else(|_| TaskPresence::Unknown("核验任务超时，请稍后重试。".into()));
    rpc.close().await;
    outcome
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn protocol_rejection_and_unknown_outcomes_remain_distinct() {
        assert!(
            !rpc_result(json!({"error":{"code":-32602,"message":"invalid params"}}))
                .unwrap_err()
                .uncertain
        );
        assert!(
            rpc_result(json!({"error":{"code":-32603,"message":"internal error"}}))
                .unwrap_err()
                .uncertain
        );
        assert!(rpc_result(json!({"id":1})).unwrap_err().uncertain);
        assert_eq!(
            rpc_result(json!({"result":{"ok":true}})).unwrap()["ok"],
            true
        );
    }
}

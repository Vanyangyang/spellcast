//! Reuse the running Codex Desktop's app-tools connection. Never starts another model runtime.
use crate::codex::{CodexBinding, CodexError};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::time::Duration;
use std::sync::{Mutex, OnceLock};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

const MAX_FRAME: usize = 8 * 1024 * 1024;
const TIMEOUT: Duration = Duration::from_secs(15);
static HOST_PIPE: OnceLock<Mutex<Option<String>>> = OnceLock::new();

#[cfg(windows)]
type Stream = tokio::net::windows::named_pipe::NamedPipeClient;
#[cfg(unix)]
type Stream = tokio::net::UnixStream;

fn error(message: impl Into<String>, uncertain: bool) -> CodexError {
    CodexError { message: message.into(), uncertain }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Submission {
    pub thread_id: String,
    pub cwd: String,
    pub previous_turn_id: Option<String>,
    pub accepted_at_ms: u64,
    #[serde(skip)] pub checked_at_ms: u64,
    #[serde(default)] pub turn_id: Option<String>,
    #[serde(default)] pub host_status: String,
    #[serde(default)] pub attention: Option<String>,
}

impl Submission {
    pub fn pending(binding: &CodexBinding) -> Self {
        Self { thread_id: binding.thread_id.clone(), cwd: binding.cwd.clone(), previous_turn_id: None, accepted_at_ms: 0,
            checked_at_ms: 0, turn_id: None, host_status: "connecting".into(), attention: None }
    }
    pub fn completed_without_result(&self, snapshot: &Snapshot, was_read: bool) -> bool {
        snapshot.host_status != "active" && matches!(snapshot.turn_status.as_str(), "completed" | "interrupted" | "failed")
            && snapshot.turn_id.is_some() && (snapshot.turn_id != self.previous_turn_id || was_read)
    }
}

#[derive(Debug, Clone)]
pub struct Snapshot {
    pub turn_id: Option<String>,
    pub turn_status: String,
    pub host_status: String,
    pub attention: Option<String>,
}

fn parse_snapshot(value: &Value, binding: &CodexBinding) -> Result<Snapshot, CodexError> {
    let thread = &value["thread"];
    if thread["id"].as_str() != Some(&binding.thread_id)
        || !thread["cwd"].as_str().is_some_and(|cwd| crate::task_target::same_cwd(cwd, &binding.cwd)) {
        return Err(error("桌面返回的任务或工作区不匹配，没有发送。", false));
    }
    let turn = value["turns"].as_array().and_then(|turns| turns.first());
    let flags = thread["status"]["activeFlags"].as_array();
    let attention = flags.and_then(|flags| flags.iter().find_map(|flag| match flag.as_str() {
        Some("waitingOnApproval") => Some("原任务需要权限确认，请在 Codex 中处理。".into()),
        Some("waitingOnUserInput") => Some("原任务需要你的补充，请在 Codex 中处理。".into()),
        _ => None,
    }));
    Ok(Snapshot { turn_id: turn.and_then(|turn| turn["id"].as_str()).map(str::to_owned),
        turn_status: turn.and_then(|turn| turn["status"].as_str()).unwrap_or_default().into(),
        host_status: thread["status"]["type"].as_str().unwrap_or("unknown").into(), attention })
}

struct Client<S = Stream> { stream: S, next_id: u64, thread_id: String }

fn candidates() -> Vec<String> {
    let mut paths = Vec::new();
    if let Some(path) = HOST_PIPE.get_or_init(|| Mutex::new(None)).lock().unwrap().clone() { paths.push(path); }
    if let Ok(path) = std::env::var("CODEX_APP_TOOLS_PIPE_PATH") { paths.push(path); }
    #[cfg(windows)]
    if let Ok(entries) = std::fs::read_dir(r"\\.\pipe\") {
        let mut discovered = entries.filter_map(Result::ok).map(|entry| entry.path().to_string_lossy().into_owned())
            .filter(|path| valid_pipe(path)).collect::<Vec<_>>();
        discovered.sort(); paths.extend(discovered);
    }
    paths.retain(|path| valid_pipe(path));
    let mut unique = Vec::new(); for path in paths { if !unique.contains(&path) { unique.push(path); } }
    unique.truncate(16); unique
}

fn valid_pipe(path: &str) -> bool {
    #[cfg(windows)]
    { path.strip_prefix(r"\\.\pipe\codex-browser-use-").is_some_and(|id| uuid::Uuid::parse_str(id).is_ok()) }
    #[cfg(unix)]
    { std::path::Path::new(path).is_absolute() }
}

impl Client<Stream> {
    async fn connect(binding: &CodexBinding) -> Result<(Self, Snapshot), CodexError> {
        let mut last = None;
        for path in candidates() {
            #[cfg(windows)]
            let stream = match tokio::net::windows::named_pipe::ClientOptions::new().open(&path) { Ok(stream) => stream, Err(_) => continue };
            #[cfg(unix)]
            let stream = match tokio::net::UnixStream::connect(&path).await { Ok(stream) => stream, Err(_) => continue };
            let mut client = Client { stream, next_id: 0, thread_id: binding.thread_id.clone() };
            // The browser transport shares this pipe prefix. A catalog handshake distinguishes app tools.
            let catalog = match tokio::time::timeout(Duration::from_millis(700), client.request("tools/list", json!({"threadStartKind":"all"}), false)).await {
                Ok(Ok(catalog)) => catalog, _ => continue,
            };
            if !["send_message_to_thread", "read_thread"].iter().all(|name| catalog["tools"].as_array().is_some_and(|tools| tools.iter().any(|tool| tool["name"] == *name && tool["namespace"] == "codex_app"))) { continue; }
            match client.snapshot(binding).await {
                Ok(snapshot) => { *HOST_PIPE.get_or_init(|| Mutex::new(None)).lock().unwrap() = Some(path); return Ok((client, snapshot)); },
                Err(failure) => last = Some(failure),
            }
        }
        Err(last.unwrap_or_else(|| error("无法连接原 Codex 桌面任务。请打开 Codex 后重试；请求已保留。", false)))
    }
}

impl<S: AsyncRead + AsyncWrite + Unpin> Client<S> {
    async fn request(&mut self, method: &str, params: Value, writing: bool) -> Result<Value, CodexError> {
        self.next_id += 1; let id = self.next_id;
        let result = tokio::time::timeout(TIMEOUT, async {
            let bytes = serde_json::to_vec(&json!({"jsonrpc":"2.0","id":id,"method":method,"params":params})).unwrap();
            if bytes.len() > MAX_FRAME { return Err(error("发送内容超过桌面连接上限。", false)); }
            self.stream.write_all(&(bytes.len() as u32).to_le_bytes()).await.map_err(|e| error(format!("桌面连接写入失败：{e}"), writing))?;
            self.stream.write_all(&bytes).await.map_err(|e| error(format!("桌面连接写入失败：{e}"), writing))?;
            loop {
                let length = self.stream.read_u32_le().await.map_err(|e| error(format!("桌面连接中断：{e}"), writing))? as usize;
                if length > MAX_FRAME { return Err(error("桌面响应超过连接上限。", writing)); }
                let mut frame = vec![0; length]; self.stream.read_exact(&mut frame).await.map_err(|e| error(format!("桌面响应中断：{e}"), writing))?;
                let value: Value = serde_json::from_slice(&frame).map_err(|_| error("桌面响应格式无效。", writing))?;
                if value["id"].as_u64() != Some(id) { continue; }
                if let Some(failure) = value.get("error") {
                    let rejected = matches!(failure["code"].as_i64(), Some(-32600 | -32601 | -32602));
                    return Err(error(failure["message"].as_str().unwrap_or("桌面拒绝请求。"), writing && !rejected));
                }
                return value.get("result").cloned().ok_or_else(|| error("桌面没有返回结果。", writing));
            }
        }).await;
        result.unwrap_or_else(|_| Err(error("桌面响应超时，请核对原任务；没有自动重发。", writing)))
    }

    async fn tool(&mut self, name: &str, args: Value, call_id: &str, writing: bool) -> Result<Value, CodexError> {
        let value = self.request("tools/call", json!({"namespace":"codex_app","tool":name,"threadId":self.thread_id,
            "turnId":format!("spellcast-ui-{call_id}"),"callId":call_id,"arguments":args}), writing).await?;
        let text = value["contentItems"].as_array().and_then(|items| items.iter().find(|item| item["type"] == "inputText"))
            .and_then(|item| item["text"].as_str()).unwrap_or_default();
        if value["success"] != true {
            // This observed host response is emitted before locating a target; other tool
            // failures may follow a side effect and must remain uncertain.
            let missing_target = text.starts_with(&format!("No Codex thread found for threadId: {}.", self.thread_id));
            return Err(error(if text.is_empty() { "原任务未接受请求。" } else { text }, writing && !missing_target));
        }
        serde_json::from_str(text).map_err(|_| error("桌面返回了无法确认的接手结果。", writing))
    }

    async fn snapshot(&mut self, binding: &CodexBinding) -> Result<Snapshot, CodexError> {
        let value = self.tool("read_thread", json!({"threadId":binding.thread_id,"hostId":"local","turnLimit":1,"includeOutputs":false,"maxOutputCharsPerItem":0}), &format!("spellcast-check-{}", uuid::Uuid::new_v4()), false).await?;
        parse_snapshot(&value, binding)
    }

    async fn submit(&mut self, binding: &CodexBinding, client_id: &str, notice: &str, before: Snapshot) -> Result<Submission, CodexError> {
        let result = self.tool("send_message_to_thread", json!({"threadId":binding.thread_id,"hostId":"local","prompt":notice}), &format!("spellcast-feedback-{client_id}"), true).await?;
        if result["threadId"].as_str() != Some(&binding.thread_id) { return Err(error("桌面返回的接收任务不匹配；请核对，没有自动重发。", true)); }
        let mut submitted = Submission::pending(binding);
        submitted.previous_turn_id = before.turn_id; submitted.accepted_at_ms = spellcast_core::inbox::now_ms(); submitted.host_status = "submitted".into();
        Ok(submitted)
    }
}

pub async fn inspect(binding: &CodexBinding) -> Result<Snapshot, CodexError> { Client::connect(binding).await.map(|(_, snapshot)| snapshot) }

pub async fn deliver(binding: &CodexBinding, client_id: &str, notice: &str, reconcile_only: bool, should_send: impl Fn() -> bool) -> Result<Option<Submission>, CodexError> {
    if reconcile_only { return Err(error("这次发送结果尚未确认。原任务读取或更新画布后会自动确认；没有再次发送。", true)); }
    let (mut client, before) = Client::connect(binding).await?;
    if !should_send() { return Ok(None); }
    client.submit(binding, client_id, notice, before).await.map(Some)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn binding() -> CodexBinding { CodexBinding { source_id:"s".into(),thread_id:"t".into(),cwd:"G:/Project".into(),label:"Task".into(),executable:"unused.exe".into(),protocol_agent:"test".into(),bound_at_ms:0 } }
    #[test]
    fn validates_task_and_workspace_before_accepting_host_state() {
        let value = json!({"thread":{"id":"t","cwd":"G:/Project","status":{"type":"active","activeFlags":["waitingOnApproval"]}},"turns":[{"id":"new","status":"inProgress"}]});
        let status = parse_snapshot(&value, &binding()).unwrap(); assert_eq!(status.turn_id.as_deref(),Some("new")); assert!(status.attention.is_some());
        assert!(parse_snapshot(&value,&CodexBinding{thread_id:"other".into(),..binding()}).is_err());
        assert!(parse_snapshot(&value,&CodexBinding{cwd:"G:/Other".into(),..binding()}).is_err());
    }
    #[cfg(windows)]
    #[test]
    fn refuses_remote_and_unrelated_pipe_names() {
        assert!(valid_pipe(r"\\.\pipe\codex-browser-use-55fc4e43-2566-4795-b5f1-43a0efb0351c"));
        assert!(!valid_pipe(r"\\server\pipe\codex-browser-use-55fc4e43-2566-4795-b5f1-43a0efb0351c"));
        assert!(!valid_pipe(r"\\.\pipe\unrelated"));
    }

    fn snapshot(id: &str, status: &str) -> Snapshot { Snapshot { turn_id: Some(id.into()), turn_status: status.into(), host_status: if status == "inProgress" { "active" } else { "idle" }.into(), attention: None } }
    #[test]
    fn completion_needs_this_turn_or_a_read_receipt() {
        let mut submitted = Submission::pending(&binding()); submitted.previous_turn_id = Some("old".into());
        assert!(!submitted.completed_without_result(&snapshot("old", "completed"), false));
        assert!(!submitted.completed_without_result(&snapshot("new", "inProgress"), true));
        assert!(submitted.completed_without_result(&snapshot("new", "completed"), false));
        assert!(submitted.completed_without_result(&snapshot("old", "completed"), true), "Busy-turn feedback may be steered into the existing turn");
    }

    #[tokio::test]
    async fn native_submit_keeps_task_and_settings_and_requires_matching_receipt() {
        let (stream, mut peer) = tokio::io::duplex(8192);
        let mut client = Client { stream, next_id: 0, thread_id: "t".into() };
        let server = tokio::spawn(async move {
            let length = peer.read_u32_le().await.unwrap() as usize; let mut bytes = vec![0; length]; peer.read_exact(&mut bytes).await.unwrap();
            let request: Value = serde_json::from_slice(&bytes).unwrap();
            assert_eq!(request["params"]["arguments"], json!({"threadId":"t","hostId":"local","prompt":"canvas request"}));
            assert_eq!(request["params"]["callId"], "spellcast-feedback-once");
            let response = serde_json::to_vec(&json!({"jsonrpc":"2.0","id":request["id"],"result":{"success":true,"contentItems":[{"type":"inputText","text":"{\"threadId\":\"t\"}"}]}})).unwrap();
            peer.write_u32_le(response.len() as u32).await.unwrap(); peer.write_all(&response).await.unwrap();
        });
        let submitted = client.submit(&binding(), "once", "canvas request", snapshot("old", "completed")).await.unwrap();
        server.await.unwrap(); assert_eq!(submitted.thread_id, "t"); assert_eq!(submitted.previous_turn_id.as_deref(), Some("old"));
    }

    #[tokio::test]
    async fn definite_rejection_and_ambiguous_host_failure_remain_distinct() {
        for (reply, uncertain) in [
            (json!({"error":{"code":-32602,"message":"invalid params"}}), false),
            (json!({"error":{"code":-32603,"message":"internal error"}}), true),
            (json!({"result":{"success":false,"contentItems":[{"type":"inputText","text":"No Codex thread found for threadId: t. Hosts without a readable match: local"}]}}), false),
            (json!({"result":{"success":false,"contentItems":[{"type":"inputText","text":"Connection lost after delivery"}]}}), true),
        ] {
            let (stream, mut peer) = tokio::io::duplex(8192);
            let mut client = Client { stream, next_id: 0, thread_id: "t".into() };
            let server = tokio::spawn(async move {
                let length = peer.read_u32_le().await.unwrap() as usize; let mut bytes = vec![0; length]; peer.read_exact(&mut bytes).await.unwrap();
                let mut reply = reply; reply["id"] = json!(1); reply["jsonrpc"] = json!("2.0");
                let bytes = serde_json::to_vec(&reply).unwrap(); peer.write_u32_le(bytes.len() as u32).await.unwrap(); peer.write_all(&bytes).await.unwrap();
            });
            let failure = client.submit(&binding(), "once", "canvas request", snapshot("old", "completed")).await.unwrap_err();
            server.await.unwrap(); assert_eq!(failure.uncertain, uncertain);
        }
    }

    #[tokio::test]
    async fn lost_receipt_is_uncertain_and_reconcile_cannot_send() {
        let (stream, mut peer) = tokio::io::duplex(8192);
        let mut client = Client { stream, next_id: 0, thread_id: "t".into() };
        let server = tokio::spawn(async move { let length = peer.read_u32_le().await.unwrap() as usize; let mut bytes = vec![0; length]; peer.read_exact(&mut bytes).await.unwrap(); });
        let failure = client.submit(&binding(), "once", "canvas request", snapshot("old", "completed")).await.unwrap_err();
        server.await.unwrap(); assert!(failure.uncertain);
        let failure = deliver(&binding(), "once", "canvas request", true, || panic!("Reconciliation must not send")).await.unwrap_err();
        assert!(failure.uncertain);
    }
}

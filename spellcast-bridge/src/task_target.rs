use serde::{Deserialize, Serialize};
use crate::{Bridge, codex};
use spellcast_core::SpellcastError;

pub(crate) fn same_cwd(a: &str, b: &str) -> bool {
    if let (Ok(a), Ok(b)) = (std::fs::canonicalize(a), std::fs::canonicalize(b)) { return a == b; }
    let normalize = |value: &str| { let path = value.replace('\\', "/"); let path = path.trim_end_matches('/'); if path.as_bytes().get(1) == Some(&b':') || path.starts_with("//") { path.to_lowercase() } else { path.to_string() } };
    normalize(a) == normalize(b)
}

#[derive(Debug, Clone, Deserialize)]
pub struct TaskTargetRequest {
    pub source_id: String,
    #[serde(default)] pub thread_id: Option<String>,
    #[serde(default)] pub cwd: Option<String>,
    #[serde(default)] pub host_pin: Option<spellcast_core::HostRoutePin>,
}

#[derive(Debug, Clone, Serialize)]
pub struct TaskTargetStatus {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub host_pin: Option<spellcast_core::HostRoutePin>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub hosts: Vec<crate::host_sessions::HostStatus>,
    pub source_id: String,
    pub thread_id: Option<String>,
    pub label: String,
    pub status: &'static str,
    pub message: String,
    pub checked_at_ms: u64,
}

impl Bridge {
    pub async fn task_target_status(&self, request: TaskTargetRequest) -> Result<TaskTargetStatus, SpellcastError> {
        spellcast_core::reply::validate_id(&request.source_id)?;
        if request.source_id.starts_with("claude:") || request.host_pin.is_some() {
            self.refresh_host_deliveries()?;
            let hosts = self.hosts.lock().unwrap();
            let sessions = hosts.statuses_for(&request.source_id);
            let live: Vec<_> = sessions.iter().filter(|session| session.reachable).collect();
            let selected = match &request.host_pin {
                Some(pin) => sessions.iter().find(|session| &session.host_pin == pin && session.reachable),
                None if live.len() == 1 => Some(live[0]),
                _ => None,
            };
            let mut status = if selected.is_some() { "available" } else if request.host_pin.is_some() { "changed" } else if live.len() > 1 { "ambiguous" } else { "unlinked" };
            if selected.is_some_and(|session| request.thread_id.as_ref().is_some_and(|id| id != &session.host_pin.native_session_id) || request.cwd.as_ref().is_some_and(|cwd| !same_cwd(cwd, &session.host_pin.cwd))) { status = "changed"; }
            return Ok(TaskTargetStatus { host_pin: selected.map(|session| session.host_pin.clone()),
                thread_id: selected.map(|session| session.host_pin.native_session_id.clone()),
                label: selected.map(|session| session.label.clone()).unwrap_or_default(), hosts: sessions,
                source_id: request.source_id, status, message: match status { "ambiguous" => "此来源有多个宿主实例，请固定完整宿主路由。", "changed" => "原宿主租约或身份已变化，没有改投其他会话。", "unlinked" => "原会话没有有效宿主连接。", _ => "" }.into(), checked_at_ms: spellcast_core::inbox::now_ms() });
        }
        let encoded_thread = codex::source_thread_id(&request.source_id).map(str::to_owned);
        let conflicting = encoded_thread.as_deref().is_some_and(|thread| {
            request.thread_id.as_deref().is_some_and(|requested| !thread.eq_ignore_ascii_case(requested))
                || self.state.lock().unwrap().bindings.iter().any(|binding| binding.source_id == request.source_id
                    && !thread.eq_ignore_ascii_case(&binding.thread_id))
        });
        if conflicting {
            return Ok(TaskTargetStatus { host_pin: None, hosts: Vec::new(), source_id: request.source_id, thread_id: encoded_thread, label: String::new(),
                status: "changed", message: "来源 ID 与原任务关联不一致，没有改投其他任务。".into(), checked_at_ms: spellcast_core::inbox::now_ms() });
        }
        let binding = codex::binding_for_source(&self.state.lock().unwrap().bindings, &request.source_id).cloned();
        let thread_id = request.thread_id.clone().or_else(|| binding.as_ref().map(|b| b.thread_id.clone()));
        let mut result = TaskTargetStatus { host_pin: None, hosts: Vec::new(), source_id: request.source_id, thread_id: thread_id.clone(), label: binding.as_ref().filter(|b| Some(&b.thread_id) == thread_id.as_ref()).map(|b| b.label.clone()).unwrap_or_default(), status: "unlinked", message: String::new(), checked_at_ms: spellcast_core::inbox::now_ms() };
        let Some(thread_id) = thread_id else { return Ok(result); };
        uuid::Uuid::parse_str(&thread_id).map_err(|_| SpellcastError::user("原任务 ID 无效。"))?;
        let executable = match binding.as_ref().map(|b| Ok(b.executable.clone())).unwrap_or_else(codex::find_executable) {
            Ok(executable) => executable,
            Err(error) => { result.status = "unknown"; result.message = error.message; return Ok(result); }
        };
        match codex::task_presence(&executable, &thread_id).await {
            codex::TaskPresence::Deleted => { result.status = "deleted"; result.message = "原任务已删除".into(); },
            codex::TaskPresence::Unknown(message) => { result.status = "unknown"; result.message = message; },
            codex::TaskPresence::Present { label, cwd } => {
                if !label.is_empty() { result.label = label; }
                result.status = match &binding {
                    None => "unlinked",
                    Some(binding) if binding.thread_id != thread_id || !same_cwd(&binding.cwd, &cwd) || request.cwd.as_ref().is_some_and(|expected| !same_cwd(expected, &cwd)) => "changed",
                    Some(_) => "available",
                };
                // A binding may change while its metadata request is in flight.
                if result.status == "available" && !codex::binding_for_source(&self.state.lock().unwrap().bindings, &result.source_id).is_some_and(|current| current.thread_id == thread_id && same_cwd(&current.cwd, &cwd)) { result.status = "changed"; }
            },
        }
        Ok(result)
    }
}

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
}

#[derive(Debug, Clone, Serialize)]
pub struct TaskTargetStatus {
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
        let binding = self.state.lock().unwrap().bindings.iter().find(|b| b.source_id == request.source_id).cloned();
        let thread_id = request.thread_id.clone().or_else(|| binding.as_ref().map(|b| b.thread_id.clone()));
        let mut result = TaskTargetStatus { source_id: request.source_id, thread_id: thread_id.clone(), label: binding.as_ref().filter(|b| Some(&b.thread_id) == thread_id.as_ref()).map(|b| b.label.clone()).unwrap_or_default(), status: "unlinked", message: String::new(), checked_at_ms: spellcast_core::inbox::now_ms() };
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
                if result.status == "available" && !self.state.lock().unwrap().bindings.iter().any(|current| current.source_id == result.source_id && current.thread_id == thread_id && same_cwd(&current.cwd, &cwd)) { result.status = "changed"; }
            },
        }
        Ok(result)
    }
}

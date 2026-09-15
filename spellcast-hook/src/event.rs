use serde::Deserialize;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SessionSource {
    Startup,
    Resume,
    Clear,
    Compact,
    Other(String),
}

impl SessionSource {
    pub fn parse(raw: &str) -> Self {
        match raw.trim().to_ascii_lowercase().as_str() {
            "startup" => Self::Startup,
            "resume" => Self::Resume,
            "clear" => Self::Clear,
            "compact" => Self::Compact,
            other => Self::Other(other.to_string()),
        }
    }

    pub fn force_refresh(&self) -> bool {
        matches!(self, Self::Resume | Self::Clear | Self::Compact)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChildSkip {
    Flag,
    NativeAgentId,
    CompatAgentType,
    SubagentId,
}

#[derive(Debug, Clone)]
pub struct HookEvent {
    pub hook_event_name: String,
    pub session_id: String,
    pub source: Option<SessionSource>,
    pub is_subagent: bool,
    pub child_skip: Option<ChildSkip>,
}

#[derive(Debug)]
pub enum EventParse {
    Ok(HookEvent),
    Unsupported { event_name: String },
    Fail,
}

#[derive(Debug, Deserialize)]
struct RawEvent {
    #[serde(default)]
    hook_event_name: String,
    #[serde(default)]
    session_id: String,
    #[serde(default)]
    source: Option<String>,
    #[serde(default, alias = "isSubagent")]
    is_subagent: Option<bool>,
    #[serde(default, alias = "agentType")]
    agent_type: Option<String>,
    #[serde(default, alias = "agentId")]
    agent_id: Option<String>,
    #[serde(default, alias = "subagentId")]
    subagent_id: Option<String>,
}

pub fn parse_event(bytes: &[u8]) -> Option<HookEvent> {
    match classify_event(bytes) {
        EventParse::Ok(event) => Some(event),
        EventParse::Unsupported { .. } | EventParse::Fail => None,
    }
}

pub fn classify_event(bytes: &[u8]) -> EventParse {
    let raw: RawEvent = match serde_json::from_slice(bytes) {
        Ok(raw) => raw,
        Err(_) => return EventParse::Fail,
    };
    if raw.hook_event_name != "SessionStart" && raw.hook_event_name != "UserPromptSubmit" {
        return EventParse::Unsupported {
            event_name: sanitize_event_name(&raw.hook_event_name),
        };
    }
    let child_skip = detect_child_skip(&raw);
    EventParse::Ok(HookEvent {
        hook_event_name: raw.hook_event_name,
        session_id: raw.session_id,
        source: raw.source.as_deref().map(SessionSource::parse),
        is_subagent: child_skip.is_some(),
        child_skip,
    })
}

fn sanitize_event_name(raw: &str) -> String {
    let trimmed = raw.trim();
    if trimmed.len() <= 64
        && trimmed
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    {
        trimmed.to_string()
    } else {
        "other".into()
    }
}

/// Native Codex: UserPromptSubmit SubAgent spawn fills `agent_id`/`agent_type`.
/// Compat: explicit is_subagent / subagent_id / exact agent_type child|subagent|observer.
/// `parent_session_id` and `spawned_by` are ignored (not sufficient product identity).
fn detect_child_skip(raw: &RawEvent) -> Option<ChildSkip> {
    if raw.is_subagent == Some(true) {
        return Some(ChildSkip::Flag);
    }
    if raw
        .agent_id
        .as_deref()
        .is_some_and(|id| !id.trim().is_empty())
    {
        return Some(ChildSkip::NativeAgentId);
    }
    if raw
        .subagent_id
        .as_deref()
        .is_some_and(|id| !id.trim().is_empty())
    {
        return Some(ChildSkip::SubagentId);
    }
    if let Some(kind) = raw.agent_type.as_deref() {
        match kind.trim().to_ascii_lowercase().as_str() {
            "child" | "subagent" | "observer" => return Some(ChildSkip::CompatAgentType),
            _ => {}
        }
    }
    None
}

pub fn is_subagent_event(event: &HookEvent) -> bool {
    event.child_skip.is_some()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_session_id_is_still_parsed() {
        let event = parse_event(br#"{"hook_event_name":"SessionStart","source":"startup"}"#).unwrap();
        assert!(event.session_id.is_empty());
        assert!(!event.is_subagent);
    }

    #[test]
    fn unknown_events_are_unsupported_not_parse_fail() {
        match classify_event(br#"{"hook_event_name":"PreToolUse","session_id":"s"}"#) {
            EventParse::Unsupported { event_name } => assert_eq!(event_name, "PreToolUse"),
            other => panic!("{other:?}"),
        }
        assert!(parse_event(br#"{"hook_event_name":"PreToolUse","session_id":"s"}"#).is_none());
        assert!(matches!(classify_event(b"{not json"), EventParse::Fail));
        let event = parse_event(
            br#"{"hook_event_name":"UserPromptSubmit","session_id":"s","prompt":"secret","transcript_path":"/tmp/x"}"#,
        )
        .unwrap();
        assert_eq!(event.session_id, "s");
        assert!(!event.is_subagent);
    }

    #[test]
    fn native_agent_id_skips_regardless_of_role() {
        let default = parse_event(
            br#"{"hook_event_name":"UserPromptSubmit","session_id":"s","agent_id":"agt-1","agent_type":"default"}"#,
        )
        .unwrap();
        assert_eq!(default.child_skip, Some(ChildSkip::NativeAgentId));
        let terra = parse_event(
            br#"{"hook_event_name":"UserPromptSubmit","session_id":"s","agentId":"agt-2","agent_type":"terra_max"}"#,
        )
        .unwrap();
        assert_eq!(terra.child_skip, Some(ChildSkip::NativeAgentId));
    }

    #[test]
    fn parent_or_spawned_metadata_alone_does_not_skip() {
        let parent = parse_event(
            br#"{"hook_event_name":"SessionStart","session_id":"child","parent_session_id":"parent","source":"startup"}"#,
        )
        .unwrap();
        assert!(parent.child_skip.is_none());
        let spawned = parse_event(
            br#"{"hook_event_name":"UserPromptSubmit","session_id":"s","spawned_by":"main"}"#,
        )
        .unwrap();
        assert!(spawned.child_skip.is_none());
    }

    #[test]
    fn compat_markers_still_skip() {
        let flag = parse_event(
            br#"{"hook_event_name":"SessionStart","session_id":"s","isSubagent":true}"#,
        )
        .unwrap();
        assert_eq!(flag.child_skip, Some(ChildSkip::Flag));
        let id = parse_event(
            br#"{"hook_event_name":"UserPromptSubmit","session_id":"s","subagent_id":"obs-1"}"#,
        )
        .unwrap();
        assert_eq!(id.child_skip, Some(ChildSkip::SubagentId));
        let kind = parse_event(
            br#"{"hook_event_name":"SessionStart","session_id":"s","agent_type":"observer"}"#,
        )
        .unwrap();
        assert_eq!(kind.child_skip, Some(ChildSkip::CompatAgentType));
        let terra_role_only = parse_event(
            br#"{"hook_event_name":"UserPromptSubmit","session_id":"s","agent_type":"terra_max"}"#,
        )
        .unwrap();
        assert!(terra_role_only.child_skip.is_none());
        let empty_id = parse_event(
            br#"{"hook_event_name":"UserPromptSubmit","session_id":"s","agent_id":"  "}"#,
        )
        .unwrap();
        assert!(empty_id.child_skip.is_none());
    }

    #[test]
    fn ordinary_session_start_and_prompt_are_ok() {
        let start = parse_event(
            br#"{"hook_event_name":"SessionStart","session_id":"s","source":"startup"}"#,
        )
        .unwrap();
        assert!(start.child_skip.is_none());
        assert!(matches!(classify_event(
            br#"{"hook_event_name":"SessionStart","session_id":"s","source":"startup"}"#
        ), EventParse::Ok(_)));
        let prompt = parse_event(br#"{"hook_event_name":"UserPromptSubmit","session_id":"s"}"#).unwrap();
        assert!(prompt.child_skip.is_none());
    }
}

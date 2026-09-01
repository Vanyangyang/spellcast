use crate::types::{ChatMessage, ChatRequest, ModelPayload};

/// Local preview only. Spellcast is a presentation surface, not an LLM client.
pub async fn complete(
    req: &ChatRequest,
    focus_title: Option<&str>,
) -> Result<(ModelPayload, String, String), crate::types::OrbitError> {
    Ok((
        crate::mock::brainstorm(
            &req.messages,
            focus_title,
            &req.locale,
            &req.surface,
            req.screen_count.unwrap_or(1),
        ),
        "preview".into(),
        "preview".into(),
    ))
}

pub fn parse_payload(raw: &str) -> ModelPayload {
    if let Some(json_text) = extract_json(raw) {
        if let Ok(payload) = serde_json::from_str::<ModelPayload>(&json_text) {
            if !payload.reply.is_empty() || !payload.nodes.is_empty() {
                return payload;
            }
        }
    }

    let mut payload = crate::mock::brainstorm(
        &[ChatMessage {
            role: "user".into(),
            content: raw.into(),
        }],
        None,
        "zh-CN",
        "focus",
        1,
    );
    payload.reply = crate::layout::clip(raw, 80);
    payload
}

fn extract_json(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if let Some(start) = trimmed.find("```") {
        let after = &trimmed[start + 3..];
        let after = after
            .strip_prefix("json")
            .or_else(|| after.strip_prefix("JSON"))
            .unwrap_or(after);
        if let Some(end) = after.find("```") {
            return Some(after[..end].trim().to_string());
        }
    }
    let start = trimmed.find('{')?;
    let end = trimmed.rfind('}')?;
    if end > start {
        Some(trimmed[start..=end].to_string())
    } else {
        None
    }
}

pub fn provider_list() -> Vec<crate::types::ProviderInfo> {
    crate::types::catalog()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_fenced_json() {
        let raw = "```json\n{\"reply\":\"旁白\",\"form\":\"stack\",\"nodes\":[{\"title\":\"A\"}],\"throws\":[{\"node\":0,\"tease\":\"A\",\"size\":\"whisper\",\"on_poke\":\"peek\"}]}\n```";
        let payload = parse_payload(raw);
        assert_eq!(payload.reply, "旁白");
        assert_eq!(payload.form.as_deref(), Some("stack"));
        assert_eq!(payload.nodes.len(), 1);
        let throws = payload.throws.unwrap();
        assert_eq!(throws.len(), 1);
        assert_eq!(throws[0].tease, "A");
    }

    #[test]
    fn missing_throws_means_undecided() {
        let payload = parse_payload(r#"{"reply":"旁白","nodes":[{"title":"A"}]}"#);
        assert!(payload.throws.is_none());
    }
}

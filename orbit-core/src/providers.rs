use crate::types::{
    catalog, provider_meta, system_prompt, ChatMessage, ChatRequest, ModelPayload, OrbitError,
};
use serde_json::{json, Value};

pub async fn complete(
    req: &ChatRequest,
    focus_title: Option<&str>,
) -> Result<(ModelPayload, String, String), OrbitError> {
    let meta = provider_meta(&req.provider).ok_or_else(|| OrbitError::user("未知的模型来源"))?;
    let model = req
        .model
        .as_deref()
        .filter(|s| !s.is_empty())
        .unwrap_or(&meta.default_model)
        .to_string();

    if meta.id == "orbit" {
        return Ok((
            crate::mock::brainstorm(
                &req.messages,
                focus_title,
                &req.locale,
                &req.surface,
                req.screen_count.unwrap_or(1),
            ),
            meta.id,
            model,
        ));
    }

    if meta.needs_key && req.api_key.as_deref().unwrap_or("").trim().is_empty() {
        return Err(OrbitError::user(format!(
            "{} 需要 API Key。也可以先用 Orbit 本地向导。",
            meta.label
        )));
    }

    let base = req
        .base_url
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(&meta.default_base_url);

    let raw = match meta.kind.as_str() {
        "anthropic" => {
            call_anthropic(base, req.api_key.as_deref().unwrap_or(""), &model, &req.messages, &req.locale, &req.surface, req.screen_count.unwrap_or(1)).await?
        }
        "gemini" => {
            call_gemini(base, req.api_key.as_deref().unwrap_or(""), &model, &req.messages, &req.locale, &req.surface, req.screen_count.unwrap_or(1)).await?
        }
        _ => {
            call_openai(
                base,
                req.api_key.as_deref().unwrap_or(""),
                &model,
                &req.messages,
                &meta.id,
                &req.locale,
                &req.surface,
                req.screen_count.unwrap_or(1),
            )
            .await?
        }
    };

    Ok((parse_payload(&raw), meta.id, model))
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

fn client() -> Result<reqwest::Client, OrbitError> {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(60))
        .build()
        .map_err(|e| OrbitError::Provider(e.to_string()))
}

async fn call_openai(
    base: &str,
    key: &str,
    model: &str,
    messages: &[ChatMessage],
    provider_id: &str,
    locale: &str,
    surface: &str,
    screen_count: u32,
) -> Result<String, OrbitError> {
    let url = format!("{}/chat/completions", base.trim_end_matches('/'));
    let mut body_messages = vec![json!({"role": "system", "content": system_prompt(locale, surface, screen_count)})];
    for m in messages {
        body_messages.push(json!({"role": m.role, "content": m.content}));
    }
    let mut req = client()?.post(url).json(&json!({
        "model": model,
        "temperature": 0.7,
        "messages": body_messages,
    }));
    if !key.is_empty() {
        req = req.bearer_auth(key);
    }
    if provider_id == "openrouter" {
        req = req
            .header("HTTP-Referer", "https://orbit.local")
            .header("X-Title", "Orbit Board");
    }
    let value = send(req).await?;
    first_text(&value, &["choices", "0", "message", "content"])
}

async fn call_anthropic(
    base: &str,
    key: &str,
    model: &str,
    messages: &[ChatMessage],
    locale: &str,
    surface: &str,
    screen_count: u32,
) -> Result<String, OrbitError> {
    let url = format!("{}/v1/messages", base.trim_end_matches('/'));
    let body_messages: Vec<Value> = messages
        .iter()
        .map(|m| {
            json!({
                "role": if m.role == "assistant" { "assistant" } else { "user" },
                "content": m.content,
            })
        })
        .collect();
    let req = client()?
        .post(url)
        .header("x-api-key", key)
        .header("anthropic-version", "2023-06-01")
        .json(&json!({
            "model": model,
            "max_tokens": 1800,
            "system": system_prompt(locale, surface, screen_count),
            "messages": body_messages,
        }));
    let value = send(req).await?;
    first_text(&value, &["content", "0", "text"])
}

async fn call_gemini(
    base: &str,
    key: &str,
    model: &str,
    messages: &[ChatMessage],
    locale: &str,
    surface: &str,
    screen_count: u32,
) -> Result<String, OrbitError> {
    let url = format!(
        "{}/models/{}:generateContent?key={}",
        base.trim_end_matches('/'),
        model,
        key
    );
    let mut contents = Vec::new();
    for m in messages {
        contents.push(json!({
            "role": if m.role == "assistant" { "model" } else { "user" },
            "parts": [{ "text": m.content }]
        }));
    }
    let req = client()?.post(url).json(&json!({
        "system_instruction": { "parts": [{ "text": system_prompt(locale, surface, screen_count) }] },
        "contents": contents,
    }));
    let value = send(req).await?;
    first_text(&value, &["candidates", "0", "content", "parts", "0", "text"])
}

async fn send(req: reqwest::RequestBuilder) -> Result<Value, OrbitError> {
    let res = req.send().await?;
    let status = res.status();
    let text = res.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(OrbitError::Provider(format!(
            "{} {}",
            status,
            crate::layout::clip(&text, 180)
        )));
    }
    serde_json::from_str(&text).map_err(|e| OrbitError::Provider(e.to_string()))
}

fn first_text(value: &Value, path: &[&str]) -> Result<String, OrbitError> {
    let mut cur = value;
    for key in path {
        cur = if let Ok(i) = key.parse::<usize>() {
            cur.get(i)
        } else {
            cur.get(*key)
        }
        .ok_or_else(|| OrbitError::Provider("模型返回里没有文本".into()))?;
    }
    cur.as_str()
        .map(|s| s.to_string())
        .ok_or_else(|| OrbitError::Provider("模型返回里没有文本".into()))
}

pub fn provider_list() -> Vec<crate::types::ProviderInfo> {
    catalog()
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

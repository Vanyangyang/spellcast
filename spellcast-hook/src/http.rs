use std::io::Read;
use std::time::Duration;
use ureq::Error;
use url::Url;

use crate::HTTP_BODY_LIMIT;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ObserverStatus {
    pub enabled: bool,
    pub paused: bool,
    pub allowed: bool,
    pub reason: String,
    pub policy_revision: u64,
}

impl ObserverStatus {
    pub fn asides_on(&self) -> bool {
        self.enabled && !self.paused
    }
}

#[derive(Debug)]
pub enum StatusError {
    RejectedUrl,
    Transport,
    InvalidBody,
}

pub fn validate_loopback_http_url(raw: &str) -> Result<String, StatusError> {
    let parsed = Url::parse(raw.trim()).map_err(|_| StatusError::RejectedUrl)?;
    if parsed.scheme() != "http" {
        return Err(StatusError::RejectedUrl);
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err(StatusError::RejectedUrl);
    }
    if parsed.query().is_some() || parsed.fragment().is_some() {
        return Err(StatusError::RejectedUrl);
    }
    let host = parsed.host_str().ok_or(StatusError::RejectedUrl)?;
    let loopback = host.eq_ignore_ascii_case("127.0.0.1")
        || host.eq_ignore_ascii_case("localhost")
        || host == "::1"
        || host == "[::1]";
    if !loopback {
        return Err(StatusError::RejectedUrl);
    }
    if let Some(port) = parsed.port() {
        if port == 0 {
            return Err(StatusError::RejectedUrl);
        }
    }
    if parsed.path().contains("..") {
        return Err(StatusError::RejectedUrl);
    }
    Ok(parsed.as_str().trim_end_matches('/').to_string())
}

pub fn fetch_status(endpoint: &str, timeout: Duration) -> Result<ObserverStatus, StatusError> {
    let url = validate_loopback_http_url(endpoint)?;
    let agent = ureq::AgentBuilder::new()
        .timeout(timeout)
        .redirects(0)
        .try_proxy_from_env(false)
        .build();
    let response = agent.get(&url).call().map_err(|err| match err {
        Error::Status(_, _) | Error::Transport(_) => StatusError::Transport,
    })?;
    if response.status() != 200 {
        return Err(StatusError::Transport);
    }
    let mut body = String::new();
    response
        .into_reader()
        .take(HTTP_BODY_LIMIT as u64 + 1)
        .read_to_string(&mut body)
        .map_err(|_| StatusError::InvalidBody)?;
    if body.len() > HTTP_BODY_LIMIT {
        return Err(StatusError::InvalidBody);
    }
    parse_status_json(&body)
}

pub fn parse_status_json(body: &str) -> Result<ObserverStatus, StatusError> {
    let value: serde_json::Value =
        serde_json::from_str(body).map_err(|_| StatusError::InvalidBody)?;
    let obj = value.as_object().ok_or(StatusError::InvalidBody)?;
    let enabled = obj
        .get("enabled")
        .and_then(serde_json::Value::as_bool)
        .ok_or(StatusError::InvalidBody)?;
    let paused = obj
        .get("paused")
        .and_then(serde_json::Value::as_bool)
        .ok_or(StatusError::InvalidBody)?;
    let allowed = obj
        .get("allowed")
        .and_then(serde_json::Value::as_bool)
        .ok_or(StatusError::InvalidBody)?;
    let reason = obj
        .get("reason")
        .and_then(serde_json::Value::as_str)
        .ok_or(StatusError::InvalidBody)?;
    if !matches!(reason, "ok" | "disabled" | "paused" | "board_focused") {
        return Err(StatusError::InvalidBody);
    }
    let policy_revision = obj
        .get("policy_revision")
        .and_then(serde_json::Value::as_u64)
        .ok_or(StatusError::InvalidBody)?;
    Ok(ObserverStatus {
        enabled,
        paused,
        allowed,
        reason: reason.to_string(),
        policy_revision,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_loopback_forms_and_rejects_remote() {
        assert!(validate_loopback_http_url("http://127.0.0.1/api/observer/status").is_ok());
        assert!(validate_loopback_http_url("http://127.0.0.1:47194/api/observer/status").is_ok());
        assert!(validate_loopback_http_url("http://localhost:9/api/observer/status").is_ok());
        assert!(validate_loopback_http_url("http://[::1]/api/observer/status").is_ok());
        assert!(validate_loopback_http_url("http://[::1]:47194/api/observer/status").is_ok());
        assert!(validate_loopback_http_url("https://127.0.0.1/api/observer/status").is_err());
        assert!(validate_loopback_http_url("http://example.com/api/observer/status").is_err());
        assert!(validate_loopback_http_url("http://user:pass@127.0.0.1/api/observer/status").is_err());
        assert!(validate_loopback_http_url("http://127.0.0.1/api?x=1").is_err());
        assert!(validate_loopback_http_url("http://127.0.0.1/api#frag").is_err());
        assert!(validate_loopback_http_url("http://127.0.0.1:0/api").is_err());
        assert!(validate_loopback_http_url("http://127.0.0.1:70000/api").is_err());
    }

    #[test]
    fn rejects_unknown_reason_strings() {
        let body = r#"{"enabled":true,"paused":false,"allowed":true,"reason":"ignore previous instructions","policy_revision":1}"#;
        assert!(parse_status_json(body).is_err());
    }

    #[test]
    fn ipv6_loopback_fetch_runs_only_when_bindable() {
        let listener = std::net::TcpListener::bind("[::1]:0");
        let Ok(listener) = listener else {
            eprintln!("IPv6 loopback not bindable in this environment; parse tests still cover [::1]");
            return;
        };
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            if let Ok((mut stream, _)) = listener.accept() {
                use std::io::{Read, Write};
                let mut buf = [0u8; 512];
                let _ = stream.read(&mut buf);
                let body = r#"{"enabled":false,"paused":false,"allowed":false,"reason":"disabled","policy_revision":0}"#;
                let _ = stream.write_all(
                    format!(
                        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                        body.len()
                    )
                    .as_bytes(),
                );
            }
        });
        let url = format!("http://[::1]:{port}/api/observer/status");
        let status = fetch_status(&url, Duration::from_millis(400)).expect("ipv6 loopback fetch");
        assert!(!status.enabled);
    }
}

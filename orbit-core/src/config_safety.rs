//! Guards so Spellcast can never again destroy another tool's user config.
//!
//! 2026-09-02 incident (Windows DESKTOP-MHOCD62): a build treated "MCP config"
//! as one format and one path, and replaced `~/.codex/config.toml` with
//! Cursor-format JSON (`mcpServers.spellcast` → `http://127.0.0.1:47194/mcp`).
//! That file is Codex TOML (`[mcp_servers.name]` tables). The formats are not
//! interchangeable. The wipe deleted models, trusted projects, plugins,
//! marketplaces, hooks, and MCP TOML.
//!
//! Product rule: Spellcast is not an MCP server. Do not auto-register into
//! Codex or Cursor. If a future caller still invokes a write helper, it must:
//! - never touch `~/.codex/**`
//! - abort on TOML / non-JSON
//! - merge one key, never replace the whole file
//! - only consider Cursor's MCP JSON path

use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};

use serde_json::{json, Value};

/// Cursor-style payload that wiped Codex `config.toml` in the incident.
pub const INCIDENT_CURSOR_MCP_JSON: &str = r#"{
  "mcpServers": {
    "spellcast": {
      "url": "http://127.0.0.1:47194/mcp"
    }
  }
}"#;

/// Spellcast is not an MCP server. Keep this false.
pub const MCP_REGISTRATION_ENABLED: bool = false;

const CURSOR_DIR: &str = ".cursor";
const CODEX_DIR: &str = ".codex";
const CURSOR_MCP_FILE: &str = "mcp.json";
const TOML_EXT: &str = "toml";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConfigFormat {
    Json,
    Toml,
    Other,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ConfigSafetyError {
    RegistrationDisabled,
    CodexPathForbidden,
    NotCursorMcpPath,
    TomlTarget,
    NotJson,
    WouldReplaceFile,
    Io(String),
}

impl std::fmt::Display for ConfigSafetyError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::RegistrationDisabled => {
                write!(f, "Spellcast is not an MCP server; registration is disabled")
            }
            Self::CodexPathForbidden => {
                write!(f, "refusing to write any path under .codex")
            }
            Self::NotCursorMcpPath => {
                write!(f, "refusing to write a non-Cursor MCP JSON path")
            }
            Self::TomlTarget => {
                write!(f, "target is TOML; Cursor MCP config must be JSON")
            }
            Self::NotJson => write!(f, "target is not JSON; aborting to avoid data loss"),
            Self::WouldReplaceFile => {
                write!(f, "refusing to replace an entire tool config file")
            }
            Self::Io(msg) => write!(f, "config safety I/O: {msg}"),
        }
    }
}

impl std::error::Error for ConfigSafetyError {}

impl From<io::Error> for ConfigSafetyError {
    fn from(err: io::Error) -> Self {
        Self::Io(err.to_string())
    }
}

/// Product entry: do not register Spellcast into any tool MCP config.
pub fn register_spellcast_mcp(_target: Option<&Path>) -> Result<(), ConfigSafetyError> {
    let _ = MCP_REGISTRATION_ENABLED;
    Err(ConfigSafetyError::RegistrationDisabled)
}

/// Split on `/` and `\` so a Windows path string is recognized on any host.
fn path_segments(path: &Path) -> Vec<String> {
    path.to_string_lossy()
        .split(['/', '\\'])
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .collect()
}

/// True when `path` is under a `.codex` directory (any OS, any drive).
pub fn path_is_under_codex(path: &Path) -> bool {
    path_segments(path)
        .iter()
        .any(|s| s.eq_ignore_ascii_case(CODEX_DIR))
}

/// Cursor MCP JSON lives at `~/.cursor/mcp.json` (or a project `.cursor/mcp.json`).
pub fn path_is_cursor_mcp_json(path: &Path) -> bool {
    let bits = path_segments(path);
    let file_ok = bits
        .last()
        .is_some_and(|n| n.eq_ignore_ascii_case(CURSOR_MCP_FILE));
    let has_cursor_dir = bits.iter().any(|s| s.eq_ignore_ascii_case(CURSOR_DIR));
    file_ok && has_cursor_dir && !path_is_under_codex(path)
}

pub fn path_has_toml_extension(path: &Path) -> bool {
    path_segments(path)
        .last()
        .is_some_and(|name| {
            name.rsplit_once('.')
                .is_some_and(|(_, ext)| ext.eq_ignore_ascii_case(TOML_EXT))
        })
}

/// Classify bytes. TOML (Codex) and JSON (Cursor) are not interchangeable.
pub fn detect_config_format(bytes: &[u8]) -> ConfigFormat {
    let text = match std::str::from_utf8(bytes) {
        Ok(s) => s.trim_start_matches('\u{feff}').trim(),
        Err(_) => return ConfigFormat::Other,
    };
    if text.is_empty() {
        return ConfigFormat::Other;
    }
    if serde_json::from_str::<Value>(text).is_ok() {
        return ConfigFormat::Json;
    }
    if looks_like_toml(text) {
        return ConfigFormat::Toml;
    }
    ConfigFormat::Other
}

fn looks_like_toml(text: &str) -> bool {
    let trimmed = text.trim();
    if trimmed.starts_with('[') && !trimmed.starts_with("[{") {
        return true;
    }
    trimmed.lines().any(|line| {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            return false;
        }
        if line.starts_with('[') && line.ends_with(']') {
            return true;
        }
        let Some((key, rest)) = line.split_once('=') else {
            return false;
        };
        let key = key.trim();
        let value = rest.trim_start();
        !key.is_empty()
            && !key.contains('{')
            && (value.starts_with('"')
                || value.parse::<f64>().is_ok()
                || value.eq_ignore_ascii_case("true")
                || value.eq_ignore_ascii_case("false"))
    })
}

fn reject_target(path: &Path, existing: Option<&[u8]>) -> Result<(), ConfigSafetyError> {
    if path_is_under_codex(path) {
        return Err(ConfigSafetyError::CodexPathForbidden);
    }
    if path_has_toml_extension(path) {
        return Err(ConfigSafetyError::TomlTarget);
    }
    if let Some(bytes) = existing {
        match detect_config_format(bytes) {
            ConfigFormat::Json => {}
            ConfigFormat::Toml => return Err(ConfigSafetyError::TomlTarget),
            ConfigFormat::Other => {
                if !bytes.iter().all(|b| b.is_ascii_whitespace()) {
                    return Err(ConfigSafetyError::NotJson);
                }
            }
        }
    }
    if !path_is_cursor_mcp_json(path) {
        return Err(ConfigSafetyError::NotCursorMcpPath);
    }
    Ok(())
}

/// Merge one Cursor `mcpServers` key into an existing JSON object.
/// Never used to replace a whole file. Callers still need [`reject_target`].
pub fn merge_mcp_servers_object(
    existing: &Value,
    name: &str,
    server: Value,
) -> Result<Value, ConfigSafetyError> {
    let Value::Object(mut root) = existing.clone() else {
        return Err(ConfigSafetyError::NotJson);
    };
    let servers = root.entry("mcpServers").or_insert_with(|| json!({}));
    let Value::Object(map) = servers else {
        return Err(ConfigSafetyError::NotJson);
    };
    map.insert(name.to_string(), server);
    Ok(Value::Object(root))
}

fn read_existing_json(path: &Path) -> Result<Value, ConfigSafetyError> {
    if !path.exists() {
        return Ok(json!({}));
    }
    let bytes = fs::read(path)?;
    reject_target(path, Some(&bytes))?;
    if bytes.iter().all(|b| b.is_ascii_whitespace()) {
        return Ok(json!({}));
    }
    serde_json::from_slice(&bytes).map_err(|_| ConfigSafetyError::NotJson)
}

fn write_json_atomic(path: &Path, value: &Value) -> Result<(), ConfigSafetyError> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let payload = serde_json::to_vec_pretty(value).map_err(|e| ConfigSafetyError::Io(e.to_string()))?;
    let tmp = path.with_extension("json.tmp-spellcast");
    {
        let mut file = fs::File::create(&tmp)?;
        file.write_all(&payload)?;
        file.write_all(b"\n")?;
    }
    fs::rename(&tmp, path)?;
    Ok(())
}

/// Guarded write helper. Default product path never calls this.
///
/// Even if a future build calls it:
/// - `.codex/**` is refused
/// - TOML / non-JSON is refused
/// - only `.cursor/mcp.json` is eligible
/// - a key is merged; the rest of the file is kept
pub fn merge_cursor_mcp_server(
    path: &Path,
    name: &str,
    server: Value,
) -> Result<(), ConfigSafetyError> {
    if path_is_under_codex(path) {
        return Err(ConfigSafetyError::CodexPathForbidden);
    }
    if path_has_toml_extension(path) {
        return Err(ConfigSafetyError::TomlTarget);
    }
    if path.exists() {
        let bytes = fs::read(path)?;
        reject_target(path, Some(&bytes))?;
    } else {
        reject_target(path, None)?;
    }
    let existing = read_existing_json(path)?;
    let merged = merge_mcp_servers_object(&existing, name, server)?;
    if path.exists() {
        let original = fs::read_to_string(path)?;
        let as_value: Value =
            serde_json::from_str(&original).map_err(|_| ConfigSafetyError::NotJson)?;
        if as_value == merged {
            return Ok(());
        }
        if !as_value.is_object() {
            return Err(ConfigSafetyError::WouldReplaceFile);
        }
    }
    write_json_atomic(path, &merged)
}

/// The only supported "register" action: refuse.
pub fn auto_register_spellcast_mcp(home: &Path) -> Result<PathBuf, ConfigSafetyError> {
    let _cursor = home.join(CURSOR_DIR).join(CURSOR_MCP_FILE);
    let _codex = home.join(CODEX_DIR).join("config.toml");
    register_spellcast_mcp(None)?;
    unreachable!("register_spellcast_mcp always errors");
}

/// Sample Codex `config.toml` (models, trust, plugins, marketplaces, hooks, MCP).
pub fn sample_codex_config_toml() -> &'static str {
    r##"# Codex user config — TOML. Not Cursor MCP JSON.
model = "gpt-5"
model_reasoning_effort = "high"

[projects."C:\\work\\spellcast"]
trust_level = "trusted"

[plugins]
enabled = true

[marketplaces.official]
url = "https://example.invalid/marketplace"

[hooks]
notify = "echo done"

[mcp_servers.docs]
command = "npx"
args = ["-y", "@modelcontextprotocol/server-filesystem"]
"##
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn scratch() -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(1);
        let dir = std::env::temp_dir().join(format!("spellcast-cfg-safety-{nanos}"));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write_fixture(path: &Path, body: &str) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(path, body).unwrap();
    }

    #[test]
    fn registration_stays_disabled() {
        assert!(!MCP_REGISTRATION_ENABLED);
        assert_eq!(
            register_spellcast_mcp(None),
            Err(ConfigSafetyError::RegistrationDisabled)
        );
    }

    #[test]
    fn auto_register_does_not_touch_codex_or_cursor() {
        let home = scratch();
        let codex = home.join(".codex").join("config.toml");
        let cursor = home.join(".cursor").join("mcp.json");
        write_fixture(&codex, sample_codex_config_toml());
        write_fixture(
            &cursor,
            r#"{ "mcpServers": { "keep": { "command": "echo" } } }"#,
        );
        let before_codex = fs::read(&codex).unwrap();
        let before_cursor = fs::read(&cursor).unwrap();

        let err = auto_register_spellcast_mcp(&home).unwrap_err();
        assert_eq!(err, ConfigSafetyError::RegistrationDisabled);
        assert_eq!(fs::read(&codex).unwrap(), before_codex);
        assert_eq!(fs::read(&cursor).unwrap(), before_cursor);
        assert_eq!(
            detect_config_format(&fs::read(&codex).unwrap()),
            ConfigFormat::Toml
        );
        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn write_helper_refuses_codex_config_toml() {
        let home = scratch();
        let codex = home.join(".codex").join("config.toml");
        write_fixture(&codex, sample_codex_config_toml());
        let before = fs::read(&codex).unwrap();

        let err = merge_cursor_mcp_server(
            &codex,
            "spellcast",
            json!({ "url": "http://127.0.0.1:47194/mcp" }),
        )
        .unwrap_err();
        assert_eq!(err, ConfigSafetyError::CodexPathForbidden);
        assert_eq!(fs::read(&codex).unwrap(), before);
        assert!(
            !String::from_utf8_lossy(&fs::read(&codex).unwrap()).contains("mcpServers"),
            "Codex TOML must not be rewritten as Cursor JSON"
        );
        assert_eq!(detect_config_format(&before), ConfigFormat::Toml);
        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn write_helper_refuses_windows_codex_path_shape() {
        let home = scratch();
        let codex = home
            .join("Users")
            .join("Administrator")
            .join(".codex")
            .join("config.toml");
        write_fixture(&codex, sample_codex_config_toml());
        let before = fs::read(&codex).unwrap();
        assert!(path_is_under_codex(&codex));
        let err = merge_cursor_mcp_server(
            &codex,
            "spellcast",
            serde_json::from_str::<Value>(INCIDENT_CURSOR_MCP_JSON)
                .unwrap()
                .get("mcpServers")
                .unwrap()
                .get("spellcast")
                .unwrap()
                .clone(),
        )
        .unwrap_err();
        assert_eq!(err, ConfigSafetyError::CodexPathForbidden);
        assert_eq!(fs::read(&codex).unwrap(), before);
        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn write_helper_refuses_toml_even_outside_codex() {
        let home = scratch();
        let toml_path = home.join("misc").join("config.toml");
        write_fixture(&toml_path, sample_codex_config_toml());
        let before = fs::read(&toml_path).unwrap();
        let err = merge_cursor_mcp_server(
            &toml_path,
            "spellcast",
            json!({ "url": "http://127.0.0.1:47194/mcp" }),
        )
        .unwrap_err();
        assert_eq!(err, ConfigSafetyError::TomlTarget);
        assert_eq!(fs::read(&toml_path).unwrap(), before);
        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn write_helper_refuses_non_json_cursor_file() {
        let home = scratch();
        let mcp = home.join(".cursor").join("mcp.json");
        write_fixture(&mcp, sample_codex_config_toml());
        let before = fs::read(&mcp).unwrap();
        let err = merge_cursor_mcp_server(
            &mcp,
            "spellcast",
            json!({ "url": "http://127.0.0.1:47194/mcp" }),
        )
        .unwrap_err();
        assert_eq!(err, ConfigSafetyError::TomlTarget);
        assert_eq!(fs::read(&mcp).unwrap(), before);
        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn write_helper_refuses_plain_text() {
        let home = scratch();
        let mcp = home.join(".cursor").join("mcp.json");
        write_fixture(&mcp, "not json and not really toml either ???");
        let before = fs::read(&mcp).unwrap();
        let err = merge_cursor_mcp_server(&mcp, "spellcast", json!({ "url": "http://x" })).unwrap_err();
        assert_eq!(err, ConfigSafetyError::NotJson);
        assert_eq!(fs::read(&mcp).unwrap(), before);
        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn write_helper_merges_cursor_json_without_replacing() {
        let home = scratch();
        let mcp = home.join(".cursor").join("mcp.json");
        write_fixture(
            &mcp,
            r#"{
  "mcpServers": {
    "keep-me": { "command": "echo", "args": ["ok"] }
  },
  "other": { "stay": true }
}
"#,
        );
        merge_cursor_mcp_server(
            &mcp,
            "spellcast",
            json!({ "url": "http://127.0.0.1:47194/mcp" }),
        )
        .unwrap();
        let parsed: Value = serde_json::from_slice(&fs::read(&mcp).unwrap()).unwrap();
        assert_eq!(parsed["other"]["stay"], true);
        assert_eq!(parsed["mcpServers"]["keep-me"]["command"], "echo");
        assert_eq!(
            parsed["mcpServers"]["spellcast"]["url"],
            "http://127.0.0.1:47194/mcp"
        );
        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn detect_incident_payload_as_json_and_codex_as_toml() {
        assert_eq!(
            detect_config_format(INCIDENT_CURSOR_MCP_JSON.as_bytes()),
            ConfigFormat::Json
        );
        assert_eq!(
            detect_config_format(sample_codex_config_toml().as_bytes()),
            ConfigFormat::Toml
        );
    }

    #[test]
    fn windows_and_unix_codex_paths_are_forbidden() {
        assert!(path_is_under_codex(Path::new(
            r"C:\Users\Administrator\.codex\config.toml"
        )));
        assert!(path_is_under_codex(Path::new(
            "/Users/administrator/.codex/config.toml"
        )));
        assert!(path_is_under_codex(Path::new(
            r"C:\Users\Administrator\.CODEX\config.toml"
        )));
        assert!(!path_is_under_codex(Path::new(
            r"C:\Users\Administrator\.cursor\mcp.json"
        )));
        assert!(path_is_cursor_mcp_json(Path::new(
            r"C:\Users\Administrator\.cursor\mcp.json"
        )));
        assert!(!path_is_cursor_mcp_json(Path::new(
            r"C:\Users\Administrator\.codex\config.toml"
        )));
    }
}

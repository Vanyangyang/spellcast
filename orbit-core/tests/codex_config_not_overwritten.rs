//! The 2026-09-02 Codex wipe: Cursor-format JSON must never replace
//! a TOML fixture that looks like `~/.codex/config.toml`.

use std::fs;
use std::path::PathBuf;

use orbit_core::config_safety::{
    auto_register_spellcast_mcp, detect_config_format, merge_cursor_mcp_server, path_is_under_codex,
    ConfigFormat, ConfigSafetyError, INCIDENT_CURSOR_MCP_JSON,
};

fn fixture() -> String {
    fs::read_to_string(
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/codex-config.toml"),
    )
    .expect("codex-config.toml fixture")
}

#[test]
fn fixture_is_toml_not_cursor_json() {
    let body = fixture();
    assert_eq!(detect_config_format(body.as_bytes()), ConfigFormat::Toml);
    assert_eq!(
        detect_config_format(INCIDENT_CURSOR_MCP_JSON.as_bytes()),
        ConfigFormat::Json
    );
    assert!(body.contains("[mcp_servers.docs]"));
    assert!(!body.contains("mcpServers"));
}

#[test]
fn write_helper_leaves_codex_fixture_byte_identical() {
    let home = std::env::temp_dir().join(format!(
        "spellcast-codex-fixture-{}",
        std::process::id()
    ));
    let codex = home.join(".codex").join("config.toml");
    fs::create_dir_all(codex.parent().unwrap()).unwrap();
    let original = fixture();
    fs::write(&codex, &original).unwrap();
    assert!(path_is_under_codex(&codex));

    let err = merge_cursor_mcp_server(
        &codex,
        "spellcast",
        serde_json::json!({ "url": "http://127.0.0.1:47194/mcp" }),
    )
    .unwrap_err();
    assert_eq!(err, ConfigSafetyError::CodexPathForbidden);
    assert_eq!(fs::read_to_string(&codex).unwrap(), original);
    assert_eq!(
        detect_config_format(&fs::read(&codex).unwrap()),
        ConfigFormat::Toml
    );

    let err = auto_register_spellcast_mcp(&home).unwrap_err();
    assert_eq!(err, ConfigSafetyError::RegistrationDisabled);
    assert_eq!(fs::read_to_string(&codex).unwrap(), original);
    let _ = fs::remove_dir_all(&home);
}

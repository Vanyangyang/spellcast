//! Format-bound MCP client configuration. Each supported client owns one fixed path and writer.

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

use axum::http::Uri;
use serde::Serialize;
use serde_json::{json, Value};
use toml_edit::{value, DocumentMut, Item, Table};

// One canonical skill is copied into each supported client's native global skill directory.
const SPELLCAST_SKILL: &str = include_str!("../../skills/spellcast/SKILL.md");

#[derive(Debug, Clone, Serialize)]
pub struct ClientConfig {
    pub client: String,
    pub label: String,
    pub path: Option<String>,
    pub snippet: String,
    pub written: bool,
    pub backup: Option<String>,
    pub skill_path: Option<String>,
    pub note: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct SkillInstall {
    pub client: String,
    pub path: String,
    pub installed: bool,
    pub backup: Option<String>,
    pub note: String,
}

fn home() -> Result<PathBuf, String> {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
        .ok_or_else(|| "找不到用户目录。".into())
}

fn endpoint(port: u16, override_url: Option<&str>) -> Result<String, String> {
    let raw = override_url
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .unwrap_or_else(|| format!("http://127.0.0.1:{port}/mcp"));
    let uri = raw
        .parse::<Uri>()
        .map_err(|err| format!("MCP 地址无效：{err}"))?;
    if matches!(uri.scheme_str(), Some("http" | "https")) && uri.authority().is_some() {
        return Ok(raw);
    }
    Err("MCP 地址必须是完整的 http:// 或 https:// URL。".into())
}

pub fn describe(
    client: &str,
    port: u16,
    override_url: Option<&str>,
) -> Result<ClientConfig, String> {
    describe_for_home(client, &home()?, &endpoint(port, override_url)?)
}

fn describe_for_home(client: &str, home: &Path, url: &str) -> Result<ClientConfig, String> {
    let (label, path, snippet, note) = match client {
        "cursor" => (
            "Cursor",
            Some(home.join(".cursor").join("mcp.json")),
            serde_json::to_string_pretty(&json!({
                "mcpServers": { "spellcast": { "type": "http", "url": url } }
            }))
            .unwrap(),
            "只合并 mcpServers.spellcast；其他 Cursor 配置保持不变。",
        ),
        "codex" => (
            "Codex",
            Some(home.join(".codex").join("config.toml")),
            format!(
                "[mcp_servers.spellcast]\nenabled = true\nurl = {}\n",
                serde_json::to_string(url).unwrap()
            ),
            "只合并 [mcp_servers.spellcast]；模型、插件、信任项目和 hooks 保持不变。",
        ),
        "windsurf" => (
            "Windsurf",
            Some(
                home.join(".codeium")
                    .join("windsurf")
                    .join("mcp_config.json"),
            ),
            serde_json::to_string_pretty(&json!({
                "mcpServers": { "spellcast": { "serverUrl": url } }
            }))
            .unwrap(),
            "只合并 mcpServers.spellcast；其他 Windsurf 配置保持不变。",
        ),
        "claude-code" => (
            "Claude Code",
            None,
            serde_json::to_string_pretty(&json!({
                "mcpServers": { "spellcast": { "type": "http", "url": url } }
            }))
            .unwrap(),
            "复制片段到项目的 .mcp.json；Spellcast 不替你选择项目目录。",
        ),
        "generic" => (
            "其他",
            None,
            serde_json::to_string_pretty(&json!({
                "mcpServers": { "spellcast": { "url": url } }
            }))
            .unwrap(),
            "只提供片段；Spellcast 不猜测文件路径或格式。",
        ),
        other => return Err(format!("不认识的客户端：{other}")),
    };

    Ok(ClientConfig {
        client: client.into(),
        label: label.into(),
        path: path.map(|value| value.to_string_lossy().into_owned()),
        snippet,
        written: false,
        backup: None,
        skill_path: skill_path_for_home(client, home)?
            .map(|value| value.to_string_lossy().into_owned()),
        note: note.into(),
    })
}

fn skill_path_for_home(client: &str, home: &Path) -> Result<Option<PathBuf>, String> {
    let path = match client {
        "cursor" => Some(
            home.join(".cursor")
                .join("skills")
                .join("spellcast")
                .join("SKILL.md"),
        ),
        "codex" => Some(
            home.join(".codex")
                .join("skills")
                .join("spellcast")
                .join("SKILL.md"),
        ),
        "windsurf" => Some(
            home.join(".codeium")
                .join("windsurf")
                .join("skills")
                .join("spellcast")
                .join("SKILL.md"),
        ),
        "claude-code" => Some(
            home.join(".claude")
                .join("skills")
                .join("spellcast")
                .join("SKILL.md"),
        ),
        "generic" => None,
        other => return Err(format!("不认识的客户端：{other}")),
    };
    Ok(path)
}

pub fn install_skill(client: &str) -> Result<SkillInstall, String> {
    install_skill_for_home(client, &home()?)
}

fn install_skill_for_home(client: &str, home: &Path) -> Result<SkillInstall, String> {
    let path = skill_path_for_home(client, home)?
        .ok_or_else(|| "这个客户端没有可确认的全局 Skill 目录，只提供手动安装。".to_string())?;
    let backup = commit_with_backup(&path, SPELLCAST_SKILL.as_bytes())?;
    let note = match &backup {
        Some(path) => format!(
            "Skill 已安装；原文件备份在 {}。重载 Agent 后生效。",
            path.display()
        ),
        None => "Skill 已安装或已是最新版。重载 Agent 后生效。".into(),
    };
    Ok(SkillInstall {
        client: client.into(),
        path: path.to_string_lossy().into_owned(),
        installed: true,
        backup: backup.map(|value| value.to_string_lossy().into_owned()),
        note,
    })
}

pub fn write(client: &str, port: u16, override_url: Option<&str>) -> Result<ClientConfig, String> {
    let url = endpoint(port, override_url)?;
    write_for_home(client, &home()?, &url)
}

fn write_for_home(client: &str, home: &Path, url: &str) -> Result<ClientConfig, String> {
    let mut config = describe_for_home(client, home, url)?;
    let Some(path) = config.path.as_deref().map(PathBuf::from) else {
        return Ok(config);
    };

    let next = match client {
        "cursor" => merge_json(&path, &url, "url", true)?,
        "windsurf" => merge_json(&path, &url, "serverUrl", false)?,
        "codex" => merge_codex_toml(&path, &url)?,
        _ => return Err("这个客户端只支持复制片段。".into()),
    };
    let backup = commit_with_backup(&path, next.as_bytes())?;
    config.written = true;
    config.backup = backup
        .as_ref()
        .map(|value| value.to_string_lossy().into_owned());
    config.note = match backup {
        Some(path) => format!("已合并；原文件备份在 {}。", path.display()),
        None => "已写入；原配置内容没有变化或这是新文件。".into(),
    };
    Ok(config)
}

fn merge_json(path: &Path, url: &str, url_key: &str, include_type: bool) -> Result<String, String> {
    let mut root = if path.exists() {
        let text =
            fs::read_to_string(path).map_err(|err| format!("读不了 {}：{err}", path.display()))?;
        let text = text.strip_prefix('\u{feff}').unwrap_or(&text);
        serde_json::from_str::<Value>(text)
            .map_err(|err| format!("{} 不是有效 JSON，未写入：{err}", path.display()))?
    } else {
        json!({})
    };
    let root = root
        .as_object_mut()
        .ok_or_else(|| format!("{} 的 JSON 顶层不是对象，未写入。", path.display()))?;
    let servers = root.entry("mcpServers").or_insert_with(|| json!({}));
    let servers = servers
        .as_object_mut()
        .ok_or_else(|| format!("{} 的 mcpServers 不是对象，未写入。", path.display()))?;
    let entry = servers.entry("spellcast").or_insert_with(|| json!({}));
    let entry = entry.as_object_mut().ok_or_else(|| {
        format!(
            "{} 的 mcpServers.spellcast 不是对象，未写入。",
            path.display()
        )
    })?;

    for key in ["command", "args", "url", "serverUrl", "type"] {
        entry.remove(key);
    }
    if include_type {
        entry.insert("type".into(), Value::String("http".into()));
    }
    entry.insert(url_key.into(), Value::String(url.into()));

    let mut rendered = serde_json::to_string_pretty(&root).map_err(|err| err.to_string())?;
    rendered.push('\n');
    Ok(rendered)
}

fn merge_codex_toml(path: &Path, url: &str) -> Result<String, String> {
    let mut doc = if path.exists() {
        let text =
            fs::read_to_string(path).map_err(|err| format!("读不了 {}：{err}", path.display()))?;
        text.parse::<DocumentMut>()
            .map_err(|err| format!("{} 不是有效 TOML，未写入：{err}", path.display()))?
    } else {
        DocumentMut::new()
    };

    if doc.get("mcp_servers").is_none() {
        doc["mcp_servers"] = Item::Table(Table::new());
    }
    let servers = doc["mcp_servers"]
        .as_table_mut()
        .ok_or_else(|| format!("{} 的 mcp_servers 不是表，未写入。", path.display()))?;
    if !servers.contains_key("spellcast") {
        servers.insert("spellcast", Item::Table(Table::new()));
    }
    let entry = servers["spellcast"].as_table_mut().ok_or_else(|| {
        format!(
            "{} 的 mcp_servers.spellcast 不是表，未写入。",
            path.display()
        )
    })?;
    for key in ["command", "args", "type"] {
        entry.remove(key);
    }
    entry["enabled"] = value(true);
    entry["url"] = value(url);
    Ok(doc.to_string())
}

fn commit_with_backup(path: &Path, contents: &[u8]) -> Result<Option<PathBuf>, String> {
    if path.exists() {
        let meta = fs::symlink_metadata(path)
            .map_err(|err| format!("检查不了 {}：{err}", path.display()))?;
        if !meta.file_type().is_file() {
            return Err(format!("{} 不是普通文件，未写入。", path.display()));
        }
        if fs::read(path).map_err(|err| format!("读不了 {}：{err}", path.display()))? == contents
        {
            return Ok(None);
        }
    }

    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|err| format!("建不了目录 {}：{err}", parent.display()))?;
    }
    let temp = unique_sibling(path, "spellcast.tmp")?;
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temp)
        .map_err(|err| format!("建不了临时文件 {}：{err}", temp.display()))?;
    if let Err(err) = file.write_all(contents).and_then(|_| file.sync_all()) {
        let _ = fs::remove_file(&temp);
        return Err(format!("写不了临时文件 {}：{err}", temp.display()));
    }
    drop(file);

    if !path.exists() {
        return fs::rename(&temp, path)
            .map(|_| None)
            .map_err(|err| format!("提交不了 {}：{err}", path.display()));
    }

    let backup = unique_sibling(path, "spellcast.bak")?;
    fs::rename(path, &backup).map_err(|err| format!("备份不了 {}：{err}", path.display()))?;
    if let Err(err) = fs::rename(&temp, path) {
        let restore = fs::rename(&backup, path);
        let _ = fs::remove_file(&temp);
        return Err(match restore {
            Ok(_) => format!("提交失败，原文件已恢复：{err}"),
            Err(restore_err) => format!(
                "提交失败且自动恢复失败；原文件仍在 {}：{err}；恢复错误：{restore_err}",
                backup.display()
            ),
        });
    }
    Ok(Some(backup))
}

fn unique_sibling(path: &Path, suffix: &str) -> Result<PathBuf, String> {
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| format!("文件名不可用：{}", path.display()))?;
    for index in 0..1000 {
        let extra = if index == 0 {
            String::new()
        } else {
            format!(".{index}")
        };
        let candidate = parent.join(format!("{name}.{suffix}{extra}"));
        if !candidate.exists() {
            return Ok(candidate);
        }
    }
    Err(format!("找不到可用的备份名：{}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cursor_merge_preserves_root_fields_and_other_servers() {
        let dir = test_dir("cursor");
        let path = dir.join("mcp.json");
        fs::write(
            &path,
            r#"{"theme":"dark","mcpServers":{"other":{"command":"keep"}}}"#,
        )
        .unwrap();
        let next = merge_json(&path, "http://127.0.0.1:47194/mcp", "url", true).unwrap();
        let value: Value = serde_json::from_str(&next).unwrap();
        assert_eq!(value["theme"], "dark");
        assert_eq!(value["mcpServers"]["other"]["command"], "keep");
        assert_eq!(value["mcpServers"]["spellcast"]["type"], "http");
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn cursor_merge_accepts_utf8_bom_and_preserves_root_fields_and_other_servers() {
        let dir = test_dir("cursor-bom");
        let path = dir.join("mcp.json");
        fs::write(
            &path,
            "\u{feff}{\"theme\":\"dark\",\"mcpServers\":{\"other\":{\"command\":\"keep\"}}}",
        )
        .unwrap();
        let next = merge_json(&path, "http://127.0.0.1:47194/mcp", "url", true).unwrap();
        let value: Value = serde_json::from_str(&next).unwrap();
        assert_eq!(value["theme"], "dark");
        assert_eq!(value["mcpServers"]["other"]["command"], "keep");
        assert_eq!(value["mcpServers"]["spellcast"]["type"], "http");
        assert_eq!(
            value["mcpServers"]["spellcast"]["url"],
            "http://127.0.0.1:47194/mcp"
        );
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn codex_merge_preserves_models_plugins_projects_hooks_and_other_servers() {
        let dir = test_dir("codex");
        let path = dir.join("config.toml");
        fs::write(
            &path,
            "model = \"gpt-5\"\n[plugins.demo]\nenabled = true\n[projects.demo]\ntrust_level = \"trusted\"\n[hooks]\nnotify = [\"echo\"]\n[mcp_servers.other]\nurl = \"http://other\"\n",
        )
        .unwrap();
        let next = merge_codex_toml(&path, "http://127.0.0.1:47194/mcp").unwrap();
        assert!(next.contains("model = \"gpt-5\""));
        assert!(next.contains("[plugins.demo]"));
        assert!(next.contains("[projects.demo]"));
        assert!(next.contains("[hooks]"));
        assert!(next.contains("[mcp_servers.other]"));
        assert!(next.contains("[mcp_servers.spellcast]"));
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn invalid_existing_json_is_rejected_without_change() {
        let dir = test_dir("invalid-json");
        let path = dir.join("mcp.json");
        fs::write(&path, "not json").unwrap();
        assert!(merge_json(&path, "http://127.0.0.1:47194/mcp", "url", true).is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), "not json");
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn invalid_existing_toml_is_rejected_without_change() {
        let dir = test_dir("invalid-toml");
        let path = dir.join("config.toml");
        fs::write(&path, "model = [").unwrap();
        assert!(merge_codex_toml(&path, "http://127.0.0.1:47194/mcp").is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), "model = [");
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn cursor_writer_cannot_touch_codex_config() {
        let dir = test_dir("client-path-isolation");
        let cursor = dir.join(".cursor").join("mcp.json");
        let codex = dir.join(".codex").join("config.toml");
        fs::create_dir_all(cursor.parent().unwrap()).unwrap();
        fs::create_dir_all(codex.parent().unwrap()).unwrap();
        fs::write(&cursor, r#"{"mcpServers":{"other":{"command":"keep"}}}"#).unwrap();
        fs::write(&codex, "model = \"keep\"\n[hooks]\nnotify = [\"keep\"]\n").unwrap();

        let result = write_for_home("cursor", &dir, "http://127.0.0.1:47194/mcp").unwrap();
        assert_eq!(PathBuf::from(result.path.unwrap()), cursor);
        assert_eq!(
            fs::read_to_string(&codex).unwrap(),
            "model = \"keep\"\n[hooks]\nnotify = [\"keep\"]\n"
        );
        let cursor_json: Value =
            serde_json::from_str(&fs::read_to_string(cursor).unwrap()).unwrap();
        assert_eq!(cursor_json["mcpServers"]["other"]["command"], "keep");
        assert_eq!(
            cursor_json["mcpServers"]["spellcast"]["url"],
            "http://127.0.0.1:47194/mcp"
        );
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn commit_keeps_the_original_as_a_backup() {
        let dir = test_dir("backup");
        let path = dir.join("config.toml");
        fs::write(&path, "model = \"keep\"\n").unwrap();
        let backup = commit_with_backup(&path, b"model = \"next\"\n")
            .unwrap()
            .unwrap();
        assert_eq!(fs::read_to_string(path).unwrap(), "model = \"next\"\n");
        assert_eq!(fs::read_to_string(backup).unwrap(), "model = \"keep\"\n");
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn skill_installer_uses_each_clients_global_directory_and_backs_up_changes() {
        let dir = test_dir("skills");
        assert_eq!(
            skill_path_for_home("cursor", &dir).unwrap().unwrap(),
            dir.join(".cursor/skills/spellcast/SKILL.md")
        );
        assert_eq!(
            skill_path_for_home("codex", &dir).unwrap().unwrap(),
            dir.join(".codex/skills/spellcast/SKILL.md")
        );
        assert_eq!(
            skill_path_for_home("windsurf", &dir).unwrap().unwrap(),
            dir.join(".codeium/windsurf/skills/spellcast/SKILL.md")
        );
        assert_eq!(
            skill_path_for_home("claude-code", &dir).unwrap().unwrap(),
            dir.join(".claude/skills/spellcast/SKILL.md")
        );
        assert!(skill_path_for_home("generic", &dir).unwrap().is_none());

        let first = install_skill_for_home("cursor", &dir).unwrap();
        assert_eq!(fs::read_to_string(&first.path).unwrap(), SPELLCAST_SKILL);
        fs::write(&first.path, "user-edited skill").unwrap();
        let updated = install_skill_for_home("cursor", &dir).unwrap();
        assert_eq!(fs::read_to_string(&updated.path).unwrap(), SPELLCAST_SKILL);
        assert_eq!(
            fs::read_to_string(updated.backup.unwrap()).unwrap(),
            "user-edited skill"
        );
        let _ = fs::remove_dir_all(dir);
    }

    fn test_dir(label: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "spellcast-config-{label}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&path).unwrap();
        path
    }
}

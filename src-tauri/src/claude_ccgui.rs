//! CC GUI half of the Claude integration. CC GUI starts a fresh `claude -p`
//! for every turn and kills it when the turn ends, so nothing on the Claude
//! side is alive in an idle chat; only a CC GUI plugin can begin a turn there.
//! Spellcast therefore deploys that plugin straight into CC GUI's plugin home,
//! records it in CC GUI's plugin registry and pre-pairs it with this machine's
//! host-link key. The layout follows CC GUI's `plugins/` module:
//! `plugins/<id>/`, `plugins.json` and the `plugin_kv` table in `app.db`.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

use rusqlite::{Connection, OpenFlags, OptionalExtension};
use serde_json::{json, Value};

pub(super) const PLUGIN_ID: &str = "spellcast-canvas-bridge";

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(super) struct State {
    pub detected: bool,
    /// Files match this build and CC GUI's registry has the plugin enabled with its permissions.
    pub plugin_current: bool,
    /// The plugin's storage holds this machine's host-link key and its connect switch is on.
    pub paired: bool,
}

impl State {
    /// Nothing left for an install to do here: CC GUI is absent, or deployed and paired.
    pub fn ready(&self) -> bool {
        !self.detected || (self.plugin_current && self.paired)
    }
}

fn plugins_dir(home: &Path) -> PathBuf {
    home.join("plugins")
}
fn plugin_dir(home: &Path) -> PathBuf {
    plugins_dir(home).join(PLUGIN_ID)
}
fn registry(home: &Path) -> PathBuf {
    home.join("plugins.json")
}
fn database(home: &Path) -> PathBuf {
    home.join("app.db")
}

pub(super) fn detected(home: &Path) -> bool {
    database(home).is_file() || registry(home).is_file()
}

fn manifest_of(files: &[(String, Vec<u8>)]) -> Result<Value, String> {
    let bytes = files
        .iter()
        .find(|(rel, _)| rel == "manifest.json")
        .map(|(_, bytes)| bytes)
        .ok_or("CC GUI 插件缺少清单。")?;
    serde_json::from_slice(bytes).map_err(|_| "CC GUI 插件清单不是有效 JSON。".into())
}

fn read_registry(home: &Path) -> Result<Value, String> {
    let path = registry(home);
    if !path.exists() {
        return Ok(json!({}));
    }
    super::no_links(&path)?;
    let text = fs::read_to_string(&path).map_err(|_| "无法读取 CC GUI 插件登记。".to_string())?;
    let text = text.strip_prefix('\u{feff}').unwrap_or(&text);
    // CC GUI reads a missing or empty file as "no plugins".
    if text.trim().is_empty() {
        return Ok(json!({}));
    }
    let doc: Value = serde_json::from_str(text).map_err(|_| "CC GUI 插件登记不是有效 JSON。".to_string())?;
    if !doc.is_object() {
        return Err("CC GUI 插件登记格式不受支持。".into());
    }
    Ok(doc)
}

fn record_ready(doc: &Value, manifest: &Value) -> bool {
    let record = &doc["plugins"][PLUGIN_ID];
    let granted: Vec<&str> = record["permissions"]
        .as_array()
        .map(|items| items.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default();
    let wanted = manifest["permissions"].as_array().cloned().unwrap_or_default();
    record["enabled"] == true
        && record["quarantined"] != true
        && wanted
            .iter()
            .filter_map(Value::as_str)
            .all(|p| granted.contains(&p))
}

fn read_pairing(home: &Path) -> Result<(Option<String>, bool), String> {
    let conn = Connection::open_with_flags(
        database(home),
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|_| "无法读取 CC GUI 数据库。".to_string())?;
    conn.busy_timeout(Duration::from_secs(2)).map_err(|e| e.to_string())?;
    let value = |key: &str| -> Result<Option<Value>, String> {
        conn.query_row(
            "SELECT value FROM plugin_kv WHERE plugin_id=?1 AND key=?2",
            [PLUGIN_ID, key],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|_| "无法读取 CC GUI 插件存储。".to_string())
        .map(|text| text.and_then(|t| serde_json::from_str(&t).ok()))
    };
    let key = value("bootstrap-key")?.and_then(|v| v.as_str().map(str::to_owned));
    let enabled = value("enabled")? == Some(Value::Bool(true));
    Ok((key, enabled))
}

/// `files` is the exact bundle to deploy, including `integrity.json`.
pub(super) fn inspect(home: &Path, files: &[(String, Vec<u8>)], key: Option<&str>) -> State {
    if !detected(home) {
        return State::default();
    }
    let dir = plugin_dir(home);
    let files_current = files
        .iter()
        .all(|(rel, bytes)| fs::read(dir.join(rel)).is_ok_and(|have| &have == bytes));
    let registered = match (read_registry(home), manifest_of(files)) {
        (Ok(doc), Ok(manifest)) => record_ready(&doc, &manifest),
        _ => false,
    };
    let paired = key.is_some_and(|key| {
        read_pairing(home).is_ok_and(|(stored, enabled)| enabled && stored.as_deref() == Some(key))
    });
    State {
        detected: true,
        plugin_current: files_current && registered,
        paired,
    }
}

fn install_files(home: &Path, files: &[(String, Vec<u8>)]) -> Result<(), String> {
    let plugins = plugins_dir(home);
    super::no_links(&plugins)?;
    fs::create_dir_all(&plugins).map_err(|e| format!("无法创建 CC GUI 插件目录：{e}"))?;
    // CC GUI's own installer uses these names and heals a stranded backup on its next install.
    let staging = plugins.join(format!(".staging-{PLUGIN_ID}"));
    let backup = plugins.join(format!(".backup-{PLUGIN_ID}"));
    let target = plugin_dir(home);
    super::no_links(&target)?;
    if staging.exists() {
        fs::remove_dir_all(&staging).map_err(|e| format!("无法清理 CC GUI 暂存目录：{e}"))?;
    }
    if backup.exists() {
        if target.exists() {
            fs::remove_dir_all(&backup).map_err(|e| format!("无法清理 CC GUI 旧备份：{e}"))?;
        } else {
            fs::rename(&backup, &target).map_err(|e| format!("无法恢复 CC GUI 插件备份：{e}"))?;
        }
    }
    fs::create_dir_all(&staging).map_err(|e| e.to_string())?;
    for (rel, bytes) in files {
        if let Err(e) = fs::write(staging.join(rel), bytes) {
            let _ = fs::remove_dir_all(&staging);
            return Err(format!("写入 CC GUI 插件暂存失败：{e}"));
        }
    }
    let had_target = target.exists();
    if had_target {
        if let Err(e) = fs::rename(&target, &backup) {
            let _ = fs::remove_dir_all(&staging);
            return Err(format!("无法替换 CC GUI 中的旧插件（可能正被占用）：{e}"));
        }
    }
    if let Err(e) = fs::rename(&staging, &target) {
        let restored = !had_target || fs::rename(&backup, &target).is_ok();
        let _ = fs::remove_dir_all(&staging);
        return Err(format!(
            "提交 CC GUI 插件失败：{e}；{}",
            if restored { "原插件保持不变。" } else { "原插件留在备份目录。" }
        ));
    }
    if had_target {
        let _ = fs::remove_dir_all(&backup);
    }
    Ok(())
}

fn register(home: &Path, manifest: &Value) -> Result<(), String> {
    let path = registry(home);
    let mut doc = read_registry(home)?;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let root = doc.as_object_mut().ok_or("CC GUI 插件登记格式不受支持。")?;
    let plugins = root.entry("plugins").or_insert_with(|| json!({}));
    let plugins = plugins.as_object_mut().ok_or("CC GUI 插件登记格式不受支持。")?;
    let previous = plugins.get(PLUGIN_ID).cloned().unwrap_or(Value::Null);
    plugins.insert(
        PLUGIN_ID.into(),
        json!({
            "version": manifest["version"],
            "enabled": true,
            "source": previous["source"].as_str().unwrap_or("local"),
            "permissions": manifest["permissions"],
            "quarantined": false,
            "lastError": null,
            "installedAt": previous["installedAt"].as_i64().unwrap_or(now),
        }),
    );
    // A tombstone would make CC GUI purge the plugin's storage, including the pairing.
    if let Some(tombstones) = root.get_mut("kvTombstones").and_then(Value::as_object_mut) {
        tombstones.remove(PLUGIN_ID);
    }
    let tmp = home.join(format!("plugins.json.spellcast-{}.tmp", uuid::Uuid::new_v4()));
    let bytes = serde_json::to_vec_pretty(&doc).map_err(|e| e.to_string())?;
    fs::write(&tmp, bytes).map_err(|e| format!("写入 CC GUI 插件登记失败：{e}"))?;
    fs::rename(&tmp, &path).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        format!("提交 CC GUI 插件登记失败：{e}")
    })
}

fn pair(home: &Path, key: &str) -> Result<(), String> {
    let path = database(home);
    if !path.is_file() {
        return Err("未找到 CC GUI 数据库，请先启动一次 CC GUI 再执行接入。".into());
    }
    super::no_links(&path)?;
    let conn = Connection::open_with_flags(
        &path,
        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|_| "无法打开 CC GUI 数据库。".to_string())?;
    conn.busy_timeout(Duration::from_secs(5)).map_err(|e| e.to_string())?;
    let has_table = conn
        .query_row(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='plugin_kv'",
            [],
            |_| Ok(()),
        )
        .optional()
        .map_err(|_| "无法读取 CC GUI 数据库结构。".to_string())?
        .is_some();
    if !has_table {
        return Err("CC GUI 数据库缺少插件存储，未写入配对。".into());
    }
    // Same encoding as CC GUI's plugin_storage_set: JSON text per value.
    let secret = serde_json::to_string(&Value::String(key.into())).map_err(|e| e.to_string())?;
    let upsert = "INSERT INTO plugin_kv(plugin_id, key, value) VALUES(?1, ?2, ?3)
        ON CONFLICT(plugin_id, key) DO UPDATE SET value=excluded.value";
    conn.execute_batch("BEGIN IMMEDIATE")
        .map_err(|_| "CC GUI 数据库正忙，未写入配对。".to_string())?;
    let written = conn
        .execute(upsert, [PLUGIN_ID, "bootstrap-key", secret.as_str()])
        .and_then(|_| conn.execute(upsert, [PLUGIN_ID, "enabled", "true"]));
    match written {
        Ok(_) => conn
            .execute_batch("COMMIT")
            .map_err(|_| "提交 CC GUI 配对失败。".to_string()),
        Err(_) => {
            let _ = conn.execute_batch("ROLLBACK");
            Err("写入 CC GUI 配对失败。".into())
        }
    }
}

/// Deploy, register and pair. Returns the completed steps for the report.
pub(super) fn deploy(home: &Path, files: &[(String, Vec<u8>)], key: Option<&str>) -> Result<Vec<String>, String> {
    let manifest = manifest_of(files)?;
    install_files(home, files)?;
    register(home, &manifest)?;
    let mut done = vec!["CC GUI 会话插件已部署到 CC GUI 插件目录并启用。".to_string()];
    let key = key.ok_or("缺少本机连接密钥，未能自动配对 CC GUI 会话插件。")?;
    pair(home, key)?;
    done.push("CC GUI 会话插件已用本机连接密钥自动配对。".into());
    Ok(done)
}

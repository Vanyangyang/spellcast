//! Codex complete integration (MCP + hooks + Skill) via the official plugin CLI.
//! Isolated from UI. Does not write hook trust, aside settings, or unrelated config.

use std::cell::Cell;
use std::fs::{self, OpenOptions};
use std::io::{ErrorKind, Read};
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use fs2::FileExt;

use serde::Serialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use toml_edit::{DocumentMut, Item};

use crate::configure;

const PLUGIN_NAME: &str = "spellcast";
const SOURCE_REL: &str = "plugins/spellcast";
const DEFAULT_MARKET_NAME: &str = "personal";
const PIPE_CAP: usize = 256 * 1024;
const MATCHER: &str = "startup|resume|clear|compact";
const HOOK_TIMEOUT: u64 = 2;

pub const REQUIRED_RELATIVE: &[&str] = &[
    ".codex-plugin/plugin.json",
    "hooks/hooks.json",
    "hooks/observer-bootstrap.txt",
    "hooks/observer-stop.txt",
    "skills/spellcast/SKILL.md",
    "skills/spellcast/references/asides.md",
    "skills/spellcast/references/canvas.md",
    "skills/spellcast/references/works.md",
    "skills/spellcast/references/feedback.md",
    ".mcp.json",
    "LICENSE",
];

const MANAGED_RELATIVE: &[&str] = &[
    ".codex-plugin/plugin.json",
    "hooks/hooks.json",
    "hooks/observer-bootstrap.txt",
    "hooks/observer-stop.txt",
    "skills/spellcast/SKILL.md",
    "skills/spellcast/references/asides.md",
    "skills/spellcast/references/canvas.md",
    "skills/spellcast/references/works.md",
    "skills/spellcast/references/feedback.md",
    ".mcp.json",
    "LICENSE",
];

const SKILL_OFFICIAL: &[&str] = &[
    "SKILL.md",
    "references/asides.md",
    "references/canvas.md",
    "references/works.md",
    "references/feedback.md",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SetupKind {
    Unsupported,
    MissingCli,
    MissingResources,
    NotInstalled,
    Installing,
    InstalledPendingTrust,
    InstalledUnverified,
    PendingReload,
    Verified,
    ConflictCustom,
    ConflictEndpoint,
    Failed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum HookTrust { Trusted, Untrusted, Modified, Disabled, Unknown }

#[derive(Debug, Clone, Serialize)]
pub struct SetupReport {
    pub client: String,
    pub kind: SetupKind,
    pub complete_supported: bool,
    pub installed: bool,
    pub note: String,
    pub done: Vec<String>,
    pub not_done: Vec<String>,
    pub source_path: Option<String>,
    pub cache_path: Option<String>,
    pub marketplace_path: Option<String>,
    pub backup: Option<String>,
    pub mcp_url: Option<String>,
    pub conflicts: Vec<String>,
    pub partial: bool,
    pub hook_trust: Option<HookTrust>,
}

impl SetupReport {
    fn base(client: &str, kind: SetupKind, note: &str) -> Self {
        Self {
            client: client.into(),
            kind,
            complete_supported: matches!(client, "codex" | "grok"),
            installed: matches!(
                kind,
                SetupKind::InstalledPendingTrust | SetupKind::InstalledUnverified | SetupKind::PendingReload | SetupKind::Verified
            ),
            note: note.into(),
            done: Vec::new(),
            not_done: Vec::new(),
            source_path: None,
            cache_path: None,
            marketplace_path: None,
            backup: None,
            mcp_url: None,
            conflicts: Vec::new(),
            partial: false,
            hook_trust: None,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FaultInject {
    OverlayNth(usize),
    Fingerprint,
    MarketplaceWrite,
    ActivateCommit,
    ActivateRestore,
}

#[derive(Clone)]
pub struct SetupPaths {
    pub user_home: PathBuf,
    pub codex_home: PathBuf,
    pub resource_root: PathBuf,
    pub cli: Option<PathBuf>,
    pub cli_timeout: Duration,
    pub lock: Arc<Mutex<()>>,
    pub skip_path_lookup: bool,
    pub fault: Option<FaultInject>,
    /// Completion inbox shared by Codex notify and the Grok Build notification hook.
    pub completion_root: PathBuf,
    /// Executable copied next to the inbox as the stable notification helper.
    pub notify_helper: PathBuf,
}

#[derive(Clone)]
pub struct CliEnv {
    pub user_home: PathBuf,
    pub codex_home: PathBuf,
}

pub trait PluginCli: Send + Sync {
    fn plugin_add(&self, selector: &str, env: &CliEnv) -> Result<CliOutcome, String>;
    fn plugin_list(&self, marketplace: &str, env: &CliEnv) -> Result<CliOutcome, String>;
    fn hooks_list(&self, _env: &CliEnv) -> Result<Value, String> {
        Err("当前 Codex 连接不支持读取 Hook 信任状态。".into())
    }
}

#[derive(Debug, Clone)]
pub struct CliOutcome {
    pub status: i32,
    pub stdout: String,
    pub stderr: String,
}

pub struct ProcessCli {
    pub program: PathBuf,
    pub timeout: Duration,
}

impl PluginCli for ProcessCli {
    fn hooks_list(&self, env: &CliEnv) -> Result<Value, String> {
        let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build()
            .map_err(|e| e.to_string())?;
        runtime.block_on(spellcast_bridge::codex::list_hooks(&self.program, &env.user_home, &env.codex_home))
            .map_err(|e| e.message)
    }

    fn plugin_add(&self, selector: &str, env: &CliEnv) -> Result<CliOutcome, String> {
        run_owned(
            &self.program,
            &["plugin", "add", selector, "--json"],
            env,
            self.timeout,
        )
    }

    fn plugin_list(&self, marketplace: &str, env: &CliEnv) -> Result<CliOutcome, String> {
        run_owned(
            &self.program,
            &["plugin", "list", "--marketplace", marketplace, "--json"],
            env,
            self.timeout,
        )
    }
}

struct ScriptCli<FA, FL> {
    add: FA,
    list: FL,
}

impl<FA, FL> PluginCli for ScriptCli<FA, FL>
where
    FA: Fn(&str, &CliEnv) -> Result<CliOutcome, String> + Send + Sync,
    FL: Fn(&str, &CliEnv) -> Result<CliOutcome, String> + Send + Sync,
{
    fn plugin_add(&self, selector: &str, env: &CliEnv) -> Result<CliOutcome, String> {
        (self.add)(selector, env)
    }
    fn plugin_list(&self, marketplace: &str, env: &CliEnv) -> Result<CliOutcome, String> {
        (self.list)(marketplace, env)
    }
}

pub fn helper_name() -> &'static str {
    if cfg!(windows) {
        "spellcast-hook.exe"
    } else {
        "spellcast-hook"
    }
}

pub fn posix_hook_command(status: &str) -> String {
    format!("\"${{PLUGIN_ROOT}}/bin/spellcast-hook\" --endpoint {status}")
}

pub fn windows_hook_command(status: &str) -> String {
    format!(
        "powershell.exe -NoProfile -NonInteractive -Command \"& (Join-Path ([Environment]::GetEnvironmentVariable('PLUGIN_ROOT')) 'bin/spellcast-hook.exe') --endpoint '{status}'\""
    )
}

pub fn hooks_document(status: &str) -> Value {
    let unix = posix_hook_command(status);
    let win = windows_hook_command(status);
    let hook = json!({
        "type": "command",
        "command": unix,
        "commandWindows": win,
        "timeout": HOOK_TIMEOUT
    });
    json!({
        "hooks": {
            "SessionStart": [{ "matcher": MATCHER, "hooks": [hook.clone()] }],
            "UserPromptSubmit": [{ "hooks": [hook] }]
        }
    })
}

pub fn mcp_document(mcp: &str) -> Value {
    json!({ "mcpServers": { "spellcast": { "type": "http", "url": mcp } } })
}

pub fn validate_loopback_mcp_url(raw: &str) -> Result<String, String> {
    let raw = raw.trim();
    if raw.contains('|')
        || raw.contains('&')
        || raw.contains(';')
        || raw.contains('`')
        || raw.contains('@')
        || raw.contains('?')
        || raw.contains('#')
        || raw.contains(' ')
    {
        return Err("MCP 地址含有非法字符。".into());
    }
    let rest = raw
        .strip_prefix("http://")
        .ok_or_else(|| "只允许 http 回环地址。".to_string())?;
    let (hostport, path) = rest
        .split_once('/')
        .ok_or_else(|| "MCP 路径必须是 /mcp。".to_string())?;
    if path != "mcp" {
        return Err("MCP 路径必须是 /mcp。".into());
    }
    let (host, port) = if let Some((h, p)) = hostport.rsplit_once(':') {
        let port: u16 = p.parse().map_err(|_| "端口无效。".to_string())?;
        (h, port)
    } else {
        (hostport, 80)
    };
    if port == 0 {
        return Err("端口无效。".into());
    }
    let loopback = host.eq_ignore_ascii_case("127.0.0.1") || host.eq_ignore_ascii_case("localhost");
    if !loopback {
        return Err("只允许 127.0.0.1 或 localhost。".into());
    }
    Ok(format!("http://127.0.0.1:{port}/mcp"))
}

pub fn status_url_for_mcp(mcp: &str) -> Result<String, String> {
    let mcp = validate_loopback_mcp_url(mcp)?;
    Ok(mcp.replacen("/mcp", "/api/observer/status", 1))
}

fn sha256_bytes(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn sha256_file(path: &Path) -> Result<String, String> {
    let bytes = fs::read(path).map_err(|err| format!("读不了 {}：{err}", path.display()))?;
    Ok(sha256_bytes(&bytes))
}

fn is_reparse(path: &Path) -> bool {
    let Ok(meta) = fs::symlink_metadata(path) else {
        return false;
    };
    if meta.file_type().is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const REPARSE: u32 = 0x400;
        return meta.file_attributes() & REPARSE != 0;
    }
    #[cfg(not(windows))]
    {
        false
    }
}

fn is_system_symlink_prefix(path: &Path) -> bool {
    #[cfg(unix)]
    {
        path == Path::new("/")
            || path == Path::new("/var")
            || path == Path::new("/tmp")
            || path == Path::new("/private")
            || path == Path::new("/etc")
    }
    #[cfg(not(unix))]
    {
        let _ = path;
        false
    }
}

fn reject_reparse_chain(path: &Path) -> Result<(), String> {
    let mut cur = Some(path);
    while let Some(p) = cur {
        // macOS /var -> /private/var and /tmp -> /private/tmp. Walking those
        // ancestors would reject every TempDir path as MissingResources.
        if is_system_symlink_prefix(p) {
            break;
        }
        if p.exists() && is_reparse(p) {
            return Err(format!("拒绝符号链接或重解析点：{}", p.display()));
        }
        cur = p.parent();
    }
    Ok(())
}

fn regular_file(path: &Path, rel: &str) -> Result<(), String> {
    reject_reparse_chain(path)?;
    if path.is_dir() {
        return Err(format!("资源损坏：{rel} 是目录。"));
    }
    let meta = fs::symlink_metadata(path).map_err(|_| format!("缺少插件资源：{rel}"))?;
    if !meta.file_type().is_file() || is_reparse(path) {
        return Err(format!("资源损坏：{rel} 不是普通文件。"));
    }
    Ok(())
}

pub fn write_integrity(root: &Path) -> Result<(), String> {
    let mut files = serde_json::Map::new();
    for rel in MANAGED_RELATIVE {
        let path = root.join(rel);
        files.insert((*rel).into(), json!(sha256_file(&path)?));
    }
    let helper = format!("bin/{}", helper_name());
    files.insert(helper, json!(sha256_file(&root.join("bin").join(helper_name()))?));
    let doc = json!({ "algorithm": "sha256", "files": files });
    let mut out = serde_json::to_string_pretty(&doc).map_err(|e| e.to_string())?;
    out.push('\n');
    fs::write(root.join("integrity.json"), out).map_err(|e| e.to_string())
}

pub fn inspect_resources(root: &Path) -> Result<(), String> {
    reject_reparse_chain(root)?;
    if !root.is_dir() || is_reparse(root) {
        return Err("缺少随包插件资源。".into());
    }
    let integrity_path = root.join("integrity.json");
    regular_file(&integrity_path, "integrity.json")?;
    let integrity = read_json(&integrity_path)?;
    let files = integrity
        .get("files")
        .and_then(Value::as_object)
        .ok_or_else(|| "integrity.json 缺少 files。".to_string())?;
    for rel in MANAGED_RELATIVE {
        let path = root.join(rel);
        regular_file(&path, rel)?;
        let got = sha256_file(&path)?;
        let want = files.get(*rel).and_then(Value::as_str).unwrap_or("");
        if got != want {
            return Err(format!("资源哈希不符：{rel}"));
        }
    }
    let helper_rel = format!("bin/{}", helper_name());
    let helper = root.join("bin").join(helper_name());
    regular_file(&helper, &helper_rel)?;
    let got = sha256_file(&helper)?;
    let want = files.get(&helper_rel).and_then(Value::as_str).unwrap_or("");
    if got != want {
        return Err("native helper 哈希与发行清单不符。".into());
    }
    let mcp = read_json(&root.join(".mcp.json"))?;
    let url = mcp
        .pointer("/mcpServers/spellcast/url")
        .and_then(Value::as_str)
        .ok_or_else(|| "资源 .mcp.json 缺少 spellcast url。".to_string())?;
    let status = status_url_for_mcp(url)?;
    let hooks = read_json(&root.join("hooks/hooks.json"))?;
    expect_hooks_exact(&hooks, &status)?;
    Ok(())
}

fn expect_hooks_exact(hooks: &Value, status: &str) -> Result<(), String> {
    let unix = posix_hook_command(status);
    let win = windows_hook_command(status);
    let matcher = hooks
        .pointer("/hooks/SessionStart/0/matcher")
        .and_then(Value::as_str);
    if matcher != Some(MATCHER) {
        return Err("hooks.json matcher 不是完整接入要求。".into());
    }
    for event in ["SessionStart", "UserPromptSubmit"] {
        let base = format!("/hooks/{event}/0/hooks/0");
        if hooks.pointer(&format!("{base}/command")).and_then(Value::as_str) != Some(unix.as_str()) {
            return Err(format!("{event} POSIX 命令不是精确生成值。"));
        }
        if hooks
            .pointer(&format!("{base}/commandWindows"))
            .and_then(Value::as_str)
            != Some(win.as_str())
        {
            return Err(format!("{event} Windows 命令不是精确生成值。"));
        }
        if hooks.pointer(&format!("{base}/timeout")).and_then(Value::as_u64) != Some(HOOK_TIMEOUT)
        {
            return Err(format!("{event} timeout 必须是 {HOOK_TIMEOUT}。"));
        }
    }
    Ok(())
}

fn marketplace_path(user_home: &Path) -> PathBuf {
    user_home.join(".agents").join("plugins").join("marketplace.json")
}

fn source_path(user_home: &Path) -> PathBuf {
    user_home.join("plugins").join(PLUGIN_NAME)
}

fn standalone_skill_dir(codex_home: &Path) -> PathBuf {
    codex_home.join("skills").join(PLUGIN_NAME)
}

fn cache_root(codex_home: &Path, market: &str) -> PathBuf {
    codex_home
        .join("plugins")
        .join("cache")
        .join(market)
        .join(PLUGIN_NAME)
}

fn config_path(codex_home: &Path) -> PathBuf {
    codex_home.join("config.toml")
}

fn backup_root(codex_home: &Path) -> PathBuf {
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    codex_home
        .join("spellcast-setup-backup")
        .join(ts.to_string())
}

fn is_windows_cli_wrapper(path: &Path) -> bool {
    let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
        return false;
    };
    let lower = name.to_ascii_lowercase();
    lower.ends_with(".ps1") || lower.ends_with(".cmd") || lower.ends_with(".bat")
}

pub fn native_codex_near(dir: &Path) -> Option<PathBuf> {
    const RELS: &[&str] = &[
        "node_modules/@openai/codex/node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe",
        "node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe",
        "vendor/x86_64-pc-windows-msvc/bin/codex.exe",
    ];
    for rel in RELS {
        let candidate = dir.join(rel);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

fn find_codex_cli() -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    let mut wrappers = Vec::new();
    for dir in std::env::split_paths(&path) {
        if cfg!(windows) {
            if let Some(native) = native_codex_near(&dir) {
                return Some(native);
            }
        }
        let exe = dir.join(if cfg!(windows) { "codex.exe" } else { "codex" });
        if exe.is_file() && !is_windows_cli_wrapper(&exe) {
            return Some(exe);
        }
        if cfg!(windows) {
            for name in ["codex.cmd", "codex.ps1", "codex"] {
                let wrapper = dir.join(name);
                if wrapper.is_file() {
                    wrappers.push(wrapper);
                }
            }
        }
    }
    for wrapper in wrappers {
        if let Some(parent) = wrapper.parent() {
            if let Some(native) = native_codex_near(parent) {
                return Some(native);
            }
        }
    }
    None
}

fn read_json(path: &Path) -> Result<Value, String> {
    let text = fs::read_to_string(path).map_err(|err| format!("读不了 {}：{err}", path.display()))?;
    serde_json::from_str(text.strip_prefix('\u{feff}').unwrap_or(&text))
        .map_err(|err| format!("{} 不是有效 JSON：{err}", path.display()))
}

fn files_equal(a: &Path, b: &Path) -> bool {
    match (fs::read(a), fs::read(b)) {
        (Ok(x), Ok(y)) => x == y,
        _ => false,
    }
}

fn walk_files(root: &Path) -> Result<Vec<PathBuf>, String> {
    reject_reparse_chain(root)?;
    let mut out = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        if is_reparse(&dir) {
            return Err(format!("拒绝符号链接或重解析点：{}", dir.display()));
        }
        let entries = fs::read_dir(&dir).map_err(|err| format!("读不了 {}：{err}", dir.display()))?;
        for entry in entries {
            let entry = entry.map_err(|err| err.to_string())?;
            let path = entry.path();
            if is_reparse(&path) {
                return Err(format!("拒绝符号链接或重解析点：{}", path.display()));
            }
            let ft = entry.file_type().map_err(|err| err.to_string())?;
            if ft.is_symlink() {
                return Err(format!("拒绝符号链接：{}", path.display()));
            }
            if ft.is_dir() {
                stack.push(path);
            } else if ft.is_file() {
                out.push(path);
            }
        }
    }
    Ok(out)
}

fn rel_to(root: &Path, path: &Path) -> PathBuf {
    path.strip_prefix(root).unwrap_or(path).to_path_buf()
}

fn overlay_keep_extras(src: &Path, dest: &Path, fault: Option<FaultInject>) -> Result<(), String> {
    let mut written = 0usize;
    for from in walk_files(src)? {
        written += 1;
        if let Some(FaultInject::OverlayNth(n)) = fault {
            if n > 0 && written == n {
                return Err(format!("注入故障：第 {n} 个受管文件写入失败。"));
            }
        }
        let rel = rel_to(src, &from);
        let to = dest.join(&rel);
        reject_reparse_chain(&to)?;
        if to.exists() && to.is_dir() {
            return Err(format!("必需文件被目录占用：{}", rel.display()));
        }
        if let Some(parent) = to.parent() {
            reject_reparse_chain(parent)?;
            fs::create_dir_all(parent).map_err(|err| format!("建不了 {}：{err}", parent.display()))?;
        }
        fs::copy(&from, &to).map_err(|err| format!("复制不了 {}：{err}", rel.display()))?;
    }
    Ok(())
}

fn sibling_dir(path: &Path, suffix: &str) -> PathBuf {
    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("spellcast");
    path.parent().unwrap_or(path).join(format!("{name}.{suffix}"))
}

fn txn_id() -> String {
    let ns = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("{}-{ns}", std::process::id())
}

fn prepare_next_source(
    dest: &Path,
    stage: &Path,
    fault: Option<FaultInject>,
    txn: &str,
) -> Result<PathBuf, String> {
    let next = sibling_dir(dest, &format!("spellcast-next-{txn}"));
    if next.exists() {
        return Err(format!(
            "本次 next 目录已存在，拒绝覆盖他人或历史目录：{}",
            next.display()
        ));
    }
    if dest.exists() {
        copy_tree(dest, &next)?;
    } else {
        fs::create_dir_all(&next).map_err(|err| err.to_string())?;
    }
    if let Err(err) = overlay_keep_extras(stage, &next, fault) {
        if let Err(clean) = fs::remove_dir_all(&next) {
            return Err(format!("{err}；清理本次 next 也失败：{clean}"));
        }
        return Err(err);
    }
    Ok(next)
}

struct ActivateError {
    message: String,
    partial: bool,
    restored: bool,
    recoverable: Option<PathBuf>,
}

fn dir_rename(from: &Path, to: &Path) -> Result<(), String> {
    fs::rename(from, to).map_err(|err| {
        format!(
            "无法重命名 {} → {}：{err}",
            from.display(),
            to.display()
        )
    })
}

fn activate_source(
    next: &Path,
    dest: &Path,
    txn: &str,
    fault: Option<FaultInject>,
) -> Result<(), ActivateError> {
    let fail = |message: String, partial: bool, restored: bool, recoverable: Option<PathBuf>| {
        Err(ActivateError {
            message,
            partial,
            restored,
            recoverable,
        })
    };
    if !dest.exists() {
        if let Some(parent) = dest.parent() {
            fs::create_dir_all(parent).map_err(|err| ActivateError {
                message: err.to_string(),
                partial: false,
                restored: false,
                recoverable: Some(next.to_path_buf()),
            })?;
        }
        if matches!(
            fault,
            Some(FaultInject::ActivateCommit | FaultInject::ActivateRestore)
        ) {
            return fail(
                "注入故障：提交 rename 失败。".into(),
                true,
                false,
                Some(next.to_path_buf()),
            );
        }
        return dir_rename(next, dest).map_err(|message| ActivateError {
            message,
            partial: true,
            restored: false,
            recoverable: Some(next.to_path_buf()),
        });
    }
    let prev = sibling_dir(dest, &format!("spellcast-prev-{txn}"));
    if prev.exists() {
        return fail(
            format!(
                "本次 prev 目录已存在，拒绝删除他人或历史目录：{}",
                prev.display()
            ),
            false,
            false,
            Some(prev),
        );
    }
    if let Err(err) = dir_rename(dest, &prev) {
        return fail(format!("无法切换插件源：{err}"), false, false, None);
    }
    let commit_err = if matches!(
        fault,
        Some(FaultInject::ActivateCommit | FaultInject::ActivateRestore)
    ) {
        Some("注入故障：提交 rename 失败。".to_string())
    } else {
        dir_rename(next, dest).err()
    };
    if commit_err.is_none() {
        if let Err(clean) = fs::remove_dir_all(&prev) {
            let _ = clean;
        }
        return Ok(());
    }
    let err = commit_err.unwrap();
    let restore_err = if matches!(fault, Some(FaultInject::ActivateRestore)) {
        Some("注入故障：恢复 rename 失败。".to_string())
    } else {
        dir_rename(&prev, dest).err()
    };
    if let Some(restore_err) = restore_err {
        return fail(
            format!(
                "无法提交插件源：{err}。原目录未能恢复到目标，仍在 {}，新内容在 {}。恢复未完成。（{restore_err}）",
                prev.display(),
                next.display()
            ),
            true,
            false,
            Some(prev),
        );
    }
    fail(
        format!("无法提交插件源：{err}（已恢复原目录）。"),
        false,
        true,
        Some(prev),
    )
}

fn copy_tree(src: &Path, dest: &Path) -> Result<(), String> {
    fs::create_dir_all(dest).map_err(|err| err.to_string())?;
    for from in walk_files(src)? {
        let rel = rel_to(src, &from);
        let to = dest.join(rel);
        if let Some(parent) = to.parent() {
            fs::create_dir_all(parent).map_err(|err| err.to_string())?;
        }
        fs::copy(&from, &to).map_err(|err| err.to_string())?;
    }
    Ok(())
}

fn apply_endpoint(root: &Path, mcp: &str, status: &str) -> Result<(), String> {
    let mut mcp_out = serde_json::to_string_pretty(&mcp_document(mcp)).map_err(|e| e.to_string())?;
    mcp_out.push('\n');
    fs::write(root.join(".mcp.json"), mcp_out).map_err(|e| e.to_string())?;
    let mut hooks_out = serde_json::to_string_pretty(&hooks_document(status)).map_err(|e| e.to_string())?;
    hooks_out.push('\n');
    fs::write(root.join("hooks/hooks.json"), hooks_out).map_err(|e| e.to_string())?;
    Ok(())
}

fn managed_payload_digest(root: &Path) -> Result<String, String> {
    let mut acc = String::new();
    for rel in MANAGED_RELATIVE {
        acc.push_str(rel);
        acc.push(':');
        let path = root.join(rel);
        if *rel == ".codex-plugin/plugin.json" {
            let mut value = read_json(&path)?;
            if let Some(obj) = value.as_object_mut() {
                obj.remove("version");
            }
            let bytes = serde_json::to_vec(&value).map_err(|e| e.to_string())?;
            acc.push_str(&sha256_bytes(&bytes));
        } else {
            acc.push_str(&sha256_file(&path)?);
        }
        acc.push(';');
    }
    acc.push_str("helper:");
    acc.push_str(&sha256_file(&root.join("bin").join(helper_name()))?);
    Ok(sha256_bytes(acc.as_bytes()))
}

pub fn stamp_payload_version(root: &Path) -> Result<String, String> {
    let digest = managed_payload_digest(root)?;
    let short = digest.get(..12).unwrap_or(&digest);
    let version = format!("0.3.0+sc.{short}");
    let path = root.join(".codex-plugin/plugin.json");
    let mut value = read_json(&path)?;
    if let Some(obj) = value.as_object_mut() {
        obj.insert("version".into(), json!(version.clone()));
    }
    let mut out = serde_json::to_string_pretty(&value).map_err(|e| e.to_string())?;
    out.push('\n');
    fs::write(&path, out).map_err(|e| e.to_string())?;
    Ok(version)
}

fn plugin_json_only_version_may_differ(dest: &Value, bundle: &Value) -> Result<(), String> {
    let Some(dest_obj) = dest.as_object() else {
        return Err("plugin.json 不是对象。".into());
    };
    let Some(bundle_obj) = bundle.as_object() else {
        return Err("发行 plugin.json 不是对象。".into());
    };
    let mut dest_keys: Vec<_> = dest_obj.keys().filter(|k| *k != "version").cloned().collect();
    let mut bundle_keys: Vec<_> = bundle_obj.keys().filter(|k| *k != "version").cloned().collect();
    dest_keys.sort();
    bundle_keys.sort();
    if dest_keys != bundle_keys {
        return Err("plugin.json 含未知或缺失字段，已保护。".into());
    }
    for key in &dest_keys {
        if dest_obj.get(key) != bundle_obj.get(key) {
            return Err(format!("plugin.json 字段 {key} 与发行包不同。"));
        }
    }
    Ok(())
}

fn mcp_json_managed(dest: &Value) -> Result<String, String> {
    let url = dest
        .pointer("/mcpServers/spellcast/url")
        .and_then(Value::as_str)
        .ok_or_else(|| "MCP 缺少 spellcast url。".to_string())?;
    let url = validate_loopback_mcp_url(url)?;
    if dest != &mcp_document(&url) {
        return Err("MCP JSON 含额外 server/headers/transport/auth 或其它字段，已保护。".into());
    }
    Ok(url)
}

fn existing_is_custom(dest: &Path, bundle: &Path) -> Result<Option<String>, String> {
    if !dest.exists() {
        return Ok(None);
    }
    if dest.is_file() {
        return Err("插件源路径是文件，不是目录。".into());
    }
    let mut saw_managed = false;
    for rel in MANAGED_RELATIVE {
        let have = dest.join(rel);
        if have.exists() {
            saw_managed = true;
            regular_file(&have, rel)?;
        }
    }
    let helper = dest.join("bin").join(helper_name());
    if helper.exists() {
        saw_managed = true;
        regular_file(&helper, &format!("bin/{}", helper_name()))?;
    }
    if !saw_managed {
        return Ok(None);
    }
    for rel in [
        "hooks/observer-bootstrap.txt",
        "hooks/observer-stop.txt",
        "skills/spellcast/SKILL.md",
        "skills/spellcast/references/asides.md",
        "skills/spellcast/references/canvas.md",
        "skills/spellcast/references/works.md",
        "skills/spellcast/references/feedback.md",
        "LICENSE",
    ] {
        let have = dest.join(rel);
        let want = bundle.join(rel);
        if have.is_file() && want.is_file() && !files_equal(&have, &want) {
            return Ok(Some(format!("受管文件与发行包不同：{rel}")));
        }
    }
    let dh = dest.join("bin").join(helper_name());
    let bh = bundle.join("bin").join(helper_name());
    if dh.is_file() && bh.is_file() && !files_equal(&dh, &bh) {
        return Ok(Some("helper 与发行包不同。".into()));
    }
    if dest.join(".codex-plugin/plugin.json").is_file() && bundle.join(".codex-plugin/plugin.json").is_file()
    {
        let a = read_json(&dest.join(".codex-plugin/plugin.json"))?;
        let b = read_json(&bundle.join(".codex-plugin/plugin.json"))?;
        if let Err(err) = plugin_json_only_version_may_differ(&a, &b) {
            return Ok(Some(err));
        }
    }
    let mut mcp_url: Option<String> = None;
    if dest.join(".mcp.json").is_file() {
        let mcp = read_json(&dest.join(".mcp.json"))?;
        match mcp_json_managed(&mcp) {
            Ok(url) => mcp_url = Some(url),
            Err(err) => return Ok(Some(err)),
        }
    }
    if dest.join("hooks/hooks.json").is_file() {
        let hooks = read_json(&dest.join("hooks/hooks.json"))?;
        if let Some(url) = mcp_url {
            let status = status_url_for_mcp(&url)?;
            if let Err(err) = expect_hooks_exact(&hooks, &status) {
                return Ok(Some(err));
            }
        } else {
            return Ok(Some("hooks.json 无法与受管 MCP 对齐。".into()));
        }
    }
    Ok(None)
}

fn managed_source_ok(source: &Value, user_home: &Path) -> Result<(), String> {
    let kind = source.get("source").and_then(Value::as_str).unwrap_or("");
    if kind != "local" {
        return Err(format!("未知或自定义 source 类型：{kind}"));
    }
    let path = source.get("path").and_then(Value::as_str).unwrap_or("");
    let normalized = path.trim_start_matches("./");
    if normalized != SOURCE_REL && path != format!("./{SOURCE_REL}") {
        return Err(format!("自定义 Spellcast source 路径：{path}"));
    }
    let resolved = user_home.join(normalized);
    let expected = source_path(user_home);
    if resolved != expected {
        return Err("source 解析后的目标不在用户 home 的受管目录内。".into());
    }
    Ok(())
}

fn marketplace_spellcast_conflict(path: &Path, user_home: &Path) -> Result<Option<String>, String> {
    if !path.exists() {
        return Ok(None);
    }
    if !path.is_file() {
        return Err("marketplace.json 不是普通文件。".into());
    }
    reject_reparse_chain(path)?;
    let root = read_json(path)?;
    let plugins = root
        .get("plugins")
        .and_then(Value::as_array)
        .ok_or_else(|| "marketplace.json 缺少 plugins 数组。".to_string())?;
    for plugin in plugins {
        if plugin.get("name").and_then(Value::as_str) == Some(PLUGIN_NAME) {
            let source = plugin
                .get("source")
                .ok_or_else(|| "spellcast marketplace source 无效。".to_string())?;
            if let Err(err) = managed_source_ok(source, user_home) {
                return Ok(Some(err));
            }
        }
    }
    Ok(None)
}

fn marketplace_name(path: &Path) -> String {
    path.is_file()
        .then(|| read_json(path).ok())
        .flatten()
        .and_then(|v| v.get("name").and_then(Value::as_str).map(|s| s.to_string()))
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| DEFAULT_MARKET_NAME.into())
}

fn upsert_marketplace(
    path: &Path,
    user_home: &Path,
    source_rel: &str,
    fault: Option<FaultInject>,
) -> Result<(String, Option<PathBuf>, String), String> {
    if let Some(FaultInject::MarketplaceWrite) = fault {
        return Err("注入故障：marketplace 写入失败。".into());
    }
    let (mut root, _existed) = if path.is_file() {
        reject_reparse_chain(path)?;
        (read_json(path)?, true)
    } else if path.exists() {
        return Err("marketplace.json 不是普通文件。".into());
    } else {
        (
            json!({
                "name": DEFAULT_MARKET_NAME,
                "plugins": []
            }),
            false,
        )
    };
    let name = root
        .get("name")
        .and_then(Value::as_str)
        .filter(|s| !s.trim().is_empty())
        .unwrap_or(DEFAULT_MARKET_NAME)
        .to_string();
    let plugins = root
        .get_mut("plugins")
        .and_then(Value::as_array_mut)
        .ok_or_else(|| "marketplace.json 缺少 plugins 数组。".to_string())?;
    let mut found = false;
    for plugin in plugins.iter_mut() {
        if plugin.get("name").and_then(Value::as_str) == Some(PLUGIN_NAME) {
            found = true;
            let source = plugin
                .get("source")
                .cloned()
                .ok_or_else(|| "spellcast marketplace source 无效。".to_string())?;
            managed_source_ok(&source, user_home)?;
        }
    }
    if !found {
        plugins.push(json!({
            "name": PLUGIN_NAME,
            "source": { "source": "local", "path": format!("./{source_rel}") },
            "policy": { "installation": "AVAILABLE", "authentication": "ON_INSTALL" },
            "category": "Productivity"
        }));
    }
    if let Some(obj) = root.as_object_mut() {
        obj.insert("name".into(), json!(name.clone()));
    }
    let mut rendered = serde_json::to_string_pretty(&root).map_err(|e| e.to_string())?;
    rendered.push('\n');
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let backup = configure::commit_with_backup(path, rendered.as_bytes())?;
    Ok((name, backup, rendered))
}

fn verify_cache(cache: &Path, staged: &Path, mcp: &str) -> Result<(), String> {
    reject_reparse_chain(cache)?;
    for rel in MANAGED_RELATIVE {
        let have = cache.join(rel);
        let want = staged.join(rel);
        regular_file(&have, rel)?;
        regular_file(&want, rel)?;
        if !files_equal(&have, &want) {
            return Err(format!("已安装 {rel} 与 stage 字节不一致。"));
        }
    }
    let helper_rel = format!("bin/{}", helper_name());
    let have_helper = cache.join("bin").join(helper_name());
    let want_helper = staged.join("bin").join(helper_name());
    regular_file(&have_helper, &helper_rel)?;
    regular_file(&want_helper, &helper_rel)?;
    if !files_equal(&have_helper, &want_helper) {
        return Err("已安装 helper 与 stage 不一致。".into());
    }
    let mcp_json = read_json(&cache.join(".mcp.json"))?;
    if mcp_json != mcp_document(mcp) {
        return Err("已安装 MCP 文档与目标 endpoint 不一致。".into());
    }
    let status = status_url_for_mcp(mcp)?;
    let hooks = read_json(&cache.join("hooks/hooks.json"))?;
    expect_hooks_exact(&hooks, &status)?;
    Ok(())
}

#[derive(Debug)]
enum PluginListState {
    Missing,
    Disabled { version: Option<String> },
    VersionMismatch { found: String },
    Active { version: String, entry: Value },
}

enum PluginListEntries {
    Flat(Vec<Value>),
    Envelope { installed: Vec<Value> },
}

fn plugin_list_entries(v: &Value) -> Result<PluginListEntries, String> {
    if let Some(a) = v.as_array() {
        return Ok(PluginListEntries::Flat(a.clone()));
    }
    let Some(obj) = v.as_object() else {
        return Err("plugin list 形状无法识别。".into());
    };
    if let Some(installed) = obj.get("installed") {
        if let Some(arr) = installed.as_array() {
            return Ok(PluginListEntries::Envelope {
                installed: arr.clone(),
            });
        }
        if installed.as_bool().is_some() && obj.get("name").and_then(Value::as_str).is_some() {
            return Ok(PluginListEntries::Flat(vec![v.clone()]));
        }
        return Err("plugin list installed 字段非法。".into());
    }
    if obj
        .get("available")
        .and_then(Value::as_array)
        .is_some()
        && obj.get("name").and_then(Value::as_str).is_none()
    {
        return Ok(PluginListEntries::Envelope {
            installed: Vec::new(),
        });
    }
    if let Some(plugins) = obj.get("plugins") {
        return plugins
            .as_array()
            .cloned()
            .map(PluginListEntries::Flat)
            .ok_or_else(|| "plugin list 形状无法识别。".into());
    }
    if obj.get("name").and_then(Value::as_str).is_some() {
        return Ok(PluginListEntries::Flat(vec![v.clone()]));
    }
    Err("plugin list 形状无法识别。".into())
}

fn plugin_list_source_ok(entry: &Value, source_rel: &str, expected_source: &Path) -> Result<(), String> {
    if let Some(kind) = entry.pointer("/source/source") {
        if kind.as_str() != Some("local") {
            return Err(format!("未知或自定义 source 类型：{kind}"));
        }
    }
    let path = entry
        .pointer("/source/path")
        .and_then(Value::as_str)
        .unwrap_or("");
    managed_plugin_list_path(path, source_rel, expected_source)
}

fn managed_plugin_list_path(
    path: &str,
    source_rel: &str,
    expected_source: &Path,
) -> Result<(), String> {
    let reported = path;
    if reported.is_empty() {
        return Err(format!("plugin list source.path={path}"));
    }
    let as_path = Path::new(reported);
    if as_path
        .components()
        .any(|c| matches!(c, Component::ParentDir))
    {
        return Err(format!("plugin list source.path={path}"));
    }
    if !as_path.is_absolute() {
        if reported == source_rel || reported == format!("./{source_rel}") {
            return Ok(());
        }
        return Err(format!("plugin list source.path={path}"));
    }
    reject_reparse_chain(as_path)?;
    reject_reparse_chain(expected_source)?;
    if as_path == expected_source {
        return Ok(());
    }
    if as_path.exists() && expected_source.exists() {
        let got = fs::canonicalize(as_path)
            .map_err(|e| format!("plugin list source.path={path}: {e}"))?;
        let want = fs::canonicalize(expected_source)
            .map_err(|e| format!("plugin list source.path={path}: {e}"))?;
        if got == want {
            return Ok(());
        }
    }
    Err(format!("plugin list source.path={path}"))
}

fn inspect_plugin_list(
    stdout: &str,
    market: &str,
    source_rel: &str,
    user_home: &Path,
    expected_version: Option<&str>,
) -> Result<PluginListState, String> {
    let v: Value = serde_json::from_str(stdout.trim()).map_err(|_| "plugin list 不是 JSON。".to_string())?;
    let entries = plugin_list_entries(&v)?;
    let search = match &entries {
        PluginListEntries::Flat(a) | PluginListEntries::Envelope { installed: a } => a.as_slice(),
    };
    if search.iter().any(|entry| {
        entry.get("name").and_then(Value::as_str).is_none()
            || entry.get("marketplaceName").and_then(Value::as_str).is_none()
            || entry.get("installed").and_then(Value::as_bool).is_none()
    }) {
        return Err("plugin list 条目或 installed 字段非法。".into());
    }
    let Some(p) = search.iter().find(|p| {
        p.get("name").and_then(Value::as_str) == Some(PLUGIN_NAME)
            && p.get("marketplaceName").and_then(Value::as_str) == Some(market)
    }).cloned() else {
        return Ok(PluginListState::Missing);
    };
    match p.get("installed") {
        None => return Ok(PluginListState::Missing),
        Some(flag) => match flag.as_bool() {
            Some(true) => {}
            Some(false) => return Ok(PluginListState::Missing),
            None => return Err("plugin list installed 字段非法。".into()),
        },
    }
    let version = p
        .get("version")
        .and_then(Value::as_str)
        .map(|s| s.to_string());
    if p.get("enabled").and_then(Value::as_bool) != Some(true) {
        return Ok(PluginListState::Disabled { version });
    }
    plugin_list_source_ok(&p, source_rel, &source_path(user_home))?;
    let Some(version) = version.filter(|s| !s.is_empty()) else {
        return Err("plugin list 缺少 version。".into());
    };
    if let Some(expected) = expected_version {
        if version != expected {
            return Ok(PluginListState::VersionMismatch { found: version });
        }
    }
    Ok(PluginListState::Active { version, entry: p })
}

fn cache_dir_for_version(root: &Path, version: &str) -> PathBuf {
    root.join(version)
}

fn merge_standalone_skill(
    codex_home: &Path,
    staged: &Path,
    backup: &Path,
) -> Result<Vec<String>, String> {
    let mut notes = Vec::new();
    let skill_dir = standalone_skill_dir(codex_home);
    if !skill_dir.exists() {
        return Ok(notes);
    }
    let staged_skill = staged.join("skills/spellcast");
    let mut official_match = true;
    for rel in SKILL_OFFICIAL {
        let have = skill_dir.join(rel);
        let want = staged_skill.join(rel);
        if have.is_file() && want.is_file() && files_equal(&have, &want) {
            continue;
        }
        if have.is_file() {
            official_match = false;
        }
    }
    if !official_match {
        notes.push("独立 Skill 含自定义内容，已保留，未覆盖。".into());
        return Ok(notes);
    }
    let dest = backup.join("standalone-skill");
    fs::create_dir_all(&dest).map_err(|e| e.to_string())?;
    for rel in SKILL_OFFICIAL {
        let have = skill_dir.join(rel);
        if have.is_file() {
            let to = dest.join(rel);
            if let Some(parent) = to.parent() {
                fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            fs::copy(&have, &to).map_err(|e| e.to_string())?;
            fs::remove_file(&have).map_err(|e| e.to_string())?;
        }
    }
    notes.push(format!(
        "与即将安装内容一致的独立 Skill 已备份到 {}。",
        dest.display()
    ));
    Ok(notes)
}

#[derive(Debug, PartialEq, Eq)]
enum LegacySpellcast {
    Absent,
    Redundant,
    ConflictEndpoint(String),
    ConflictShape(String),
}

fn inspect_legacy_spellcast(doc: &DocumentMut, mcp: &str) -> LegacySpellcast {
    let Some(servers_item) = doc.get("mcp_servers") else {
        return LegacySpellcast::Absent;
    };
    let Some(servers) = servers_item.as_table() else {
        return LegacySpellcast::ConflictShape("mcp_servers 不是表，已保护。".into());
    };
    let Some(entry_item) = servers.get(PLUGIN_NAME) else {
        return LegacySpellcast::Absent;
    };
    let Some(entry) = entry_item.as_table() else {
        return LegacySpellcast::ConflictShape(
            "mcp_servers.spellcast 不是普通表（inline 或其它形状），已保护。".into(),
        );
    };
    let mut enabled = false;
    let mut url: Option<String> = None;
    for (key, item) in entry.iter() {
        match key {
            "enabled" => {
                enabled = item.as_value().and_then(|v| v.as_bool()).unwrap_or(false);
            }
            "url" => {
                url = item.as_value().and_then(|v| v.as_str()).map(|s| s.to_string());
            }
            other => {
                return LegacySpellcast::ConflictEndpoint(format!(
                    "mcp_servers.spellcast 含额外字段 {other}，已保护。"
                ));
            }
        }
    }
    match (enabled, url.as_deref()) {
        (true, Some(u)) if u == mcp => LegacySpellcast::Redundant,
        (true, Some(u)) => LegacySpellcast::ConflictEndpoint(format!(
            "mcp_servers.spellcast.url={u} 指向其他实例。"
        )),
        _ => LegacySpellcast::ConflictEndpoint("mcp_servers.spellcast 形状不是原 App 输出。".into()),
    }
}

fn remove_redundant_legacy(codex_home: &Path, mcp: &str) -> Result<Option<String>, String> {
    let path = config_path(codex_home);
    if !path.is_file() {
        return Ok(None);
    }
    let text = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let mut doc = text
        .parse::<DocumentMut>()
        .map_err(|err| format!("config.toml 不是有效 TOML：{err}"))?;
    match inspect_legacy_spellcast(&doc, mcp) {
        LegacySpellcast::Redundant => {}
        LegacySpellcast::Absent => return Ok(None),
        LegacySpellcast::ConflictEndpoint(reason) | LegacySpellcast::ConflictShape(reason) => {
            return Ok(Some(reason));
        }
    }
    let latest = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    if latest != text {
        return Ok(Some("config.toml 在迁移前被并发修改，未删除 legacy MCP。".into()));
    }
    if let Some(servers) = doc.get_mut("mcp_servers").and_then(Item::as_table_mut) {
        servers.remove(PLUGIN_NAME);
    }
    configure::commit_with_backup(&path, doc.to_string().as_bytes())?;
    Ok(None)
}

fn capped_read(mut reader: impl Read, cap: usize) -> Vec<u8> {
    let mut buf = Vec::new();
    let mut chunk = [0u8; 4096];
    loop {
        match reader.read(&mut chunk) {
            Ok(0) => break,
            Ok(n) => {
                let room = cap.saturating_sub(buf.len());
                buf.extend_from_slice(&chunk[..n.min(room)]);
                if buf.len() >= cap {
                    break;
                }
            }
            Err(_) => break,
        }
    }
    buf
}

fn apply_cli_env(cmd: &mut Command, env: &CliEnv) {
    cmd.env("CODEX_HOME", &env.codex_home);
    cmd.env("USERPROFILE", &env.user_home);
    cmd.env("HOME", &env.user_home);
}

thread_local! {
    static RUN_OWNED_FAULT: Cell<u8> = const { Cell::new(0) };
}

const JOB_FAULT_NONE: u8 = 0;
const JOB_FAULT_SKIP_RESUME: u8 = 1;
const JOB_FAULT_TERMINATE: u8 = 2;

#[cfg(windows)]
struct WinJob(windows_sys::Win32::Foundation::HANDLE);

#[cfg(windows)]
impl Drop for WinJob {
    fn drop(&mut self) {
        unsafe {
            if !self.0.is_null() && self.0 != windows_sys::Win32::Foundation::INVALID_HANDLE_VALUE {
                let _ = windows_sys::Win32::Foundation::CloseHandle(self.0);
            }
        }
        self.0 = std::ptr::null_mut();
    }
}

#[cfg(windows)]
fn create_kill_on_close_job() -> Result<WinJob, String> {
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::JobObjects::{
        CreateJobObjectW, JobObjectExtendedLimitInformation, SetInformationJobObject,
        JOBOBJECT_BASIC_LIMIT_INFORMATION, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    unsafe {
        let handle = CreateJobObjectW(std::ptr::null(), std::ptr::null());
        if handle.is_null() || handle == INVALID_HANDLE_VALUE {
            return Err("无法建立 Windows Job Object，未启动 CLI。".into());
        }
        let info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
            BasicLimitInformation: JOBOBJECT_BASIC_LIMIT_INFORMATION {
                LimitFlags: JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
                ..Default::default()
            },
            ..Default::default()
        };
        let ok = SetInformationJobObject(
            handle,
            JobObjectExtendedLimitInformation,
            &info as *const _ as *const core::ffi::c_void,
            std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        );
        if ok == 0 {
            let _ = CloseHandle(handle);
            return Err("无法配置 Job Object（KILL_ON_JOB_CLOSE），未启动 CLI。".into());
        }
        Ok(WinJob(handle))
    }
}

#[cfg(windows)]
fn assign_child_to_job(
    job: &WinJob,
    child: &std::process::Child,
) -> Result<(), String> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::System::JobObjects::AssignProcessToJobObject;
    let process = child.as_raw_handle() as windows_sys::Win32::Foundation::HANDLE;
    let ok = unsafe { AssignProcessToJobObject(job.0, process) };
    if ok == 0 {
        return Err("无法把 CLI 绑定到 Job Object。".into());
    }
    Ok(())
}

#[cfg(windows)]
fn resume_child_threads(pid: u32) -> Result<usize, String> {
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Thread32First, Thread32Next, TH32CS_SNAPTHREAD, THREADENTRY32,
    };
    use windows_sys::Win32::System::Threading::{OpenThread, ResumeThread, THREAD_SUSPEND_RESUME};
    unsafe {
        let snap = CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0);
        if snap.is_null() || snap == INVALID_HANDLE_VALUE {
            return Err("无法枚举 CLI 线程以恢复挂起进程。".into());
        }
        let mut te = THREADENTRY32 {
            dwSize: std::mem::size_of::<THREADENTRY32>() as u32,
            ..Default::default()
        };
        let mut resumed = 0usize;
        let mut resume_failed = false;
        if Thread32First(snap, &mut te) != 0 {
            loop {
                if te.th32OwnerProcessID == pid {
                    let thread = OpenThread(THREAD_SUSPEND_RESUME, 0, te.th32ThreadID);
                    if !thread.is_null() && thread != INVALID_HANDLE_VALUE {
                        let prev = ResumeThread(thread);
                        let _ = CloseHandle(thread);
                        if prev == u32::MAX {
                            resume_failed = true;
                        } else {
                            resumed += 1;
                        }
                    }
                }
                if Thread32Next(snap, &mut te) == 0 {
                    break;
                }
            }
        }
        let _ = CloseHandle(snap);
        if resume_failed {
            return Err("ResumeThread 失败，未把挂起线程全部恢复。".into());
        }
        if resumed == 0 {
            return Err("CLI 进程没有可恢复的线程。".into());
        }
        Ok(resumed)
    }
}

#[cfg(windows)]
fn terminate_job(job: &WinJob) -> Result<(), String> {
    if RUN_OWNED_FAULT.get() == JOB_FAULT_TERMINATE {
        return Err("注入故障：TerminateJobObject 失败。".into());
    }
    let ok = unsafe { windows_sys::Win32::System::JobObjects::TerminateJobObject(job.0, 1) };
    if ok == 0 {
        let gle = unsafe { windows_sys::Win32::Foundation::GetLastError() };
        return Err(format!("TerminateJobObject 失败（gle={gle}）。"));
    }
    Ok(())
}

#[cfg(windows)]
fn job_active_processes(job: &WinJob) -> Result<u32, String> {
    use windows_sys::Win32::System::JobObjects::{
        JobObjectBasicAccountingInformation, QueryInformationJobObject,
        JOBOBJECT_BASIC_ACCOUNTING_INFORMATION,
    };
    let mut info = JOBOBJECT_BASIC_ACCOUNTING_INFORMATION::default();
    let ok = unsafe {
        QueryInformationJobObject(
            job.0,
            JobObjectBasicAccountingInformation,
            &mut info as *mut _ as *mut core::ffi::c_void,
            std::mem::size_of::<JOBOBJECT_BASIC_ACCOUNTING_INFORMATION>() as u32,
            std::ptr::null_mut(),
        )
    };
    if ok == 0 {
        let gle = unsafe { windows_sys::Win32::Foundation::GetLastError() };
        return Err(format!("QueryInformationJobObject 失败（gle={gle}）。"));
    }
    Ok(info.ActiveProcesses)
}

#[cfg(windows)]
fn wait_job_empty(job: &WinJob, budget: Duration) -> Result<(), String> {
    let start = Instant::now();
    loop {
        let n = job_active_processes(job)?;
        if n == 0 {
            return Ok(());
        }
        if start.elapsed() >= budget {
            return Err(format!("Job 仍有 {n} 个活动进程，不声称整树已终止。"));
        }
        std::thread::sleep(Duration::from_millis(40));
    }
}

#[cfg(windows)]
fn reap_owned_job(
    job: &WinJob,
    child: &mut std::process::Child,
    budget: Duration,
) -> Result<(), String> {
    let term = terminate_job(job);
    if term.is_err() {
        let _ = child.kill();
    }
    let job_empty = wait_job_empty(job, budget);
    let root = wait_child_exit(child, budget);
    match (term, job_empty, root) {
        (Ok(()), Ok(()), Ok(_)) => Ok(()),
        (Err(term), job_empty, root) => Err(format!(
            "{term} ActiveProcesses={}；根进程={}。不从退出码推断整树已终止。",
            job_empty.err().map(|e| e).unwrap_or_else(|| "0".into()),
            root.err().map(|e| e).unwrap_or_else(|| "已退出".into())
        )),
        (Ok(()), Err(job_err), Ok(_)) => Err(format!(
            "根进程已退出但 {job_err} 不声称整树已终止。"
        )),
        (Ok(()), Ok(()), Err(root_err)) => Err(format!(
            "Job ActiveProcesses=0 但未能确认根进程退出：{root_err}"
        )),
        (Ok(()), Err(job_err), Err(root_err)) => {
            Err(format!("未能确认 Job 树终止：{job_err}；{root_err}"))
        }
    }
}

fn wait_child_exit(child: &mut std::process::Child, budget: Duration) -> Result<std::process::ExitStatus, String> {
    let start = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(st)) => return Ok(st),
            Ok(None) if start.elapsed() < budget => std::thread::sleep(Duration::from_millis(40)),
            Ok(None) => return Err("等待 CLI 退出超时，未能确认进程已结束。".into()),
            Err(err) => return Err(format!("等待 CLI 失败：{err}")),
        }
    }
}

fn run_owned(program: &Path, args: &[&str], env: &CliEnv, timeout: Duration) -> Result<CliOutcome, String> {
    let mut cmd = Command::new(program);
    cmd.args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    apply_cli_env(&mut cmd, env);

    #[cfg(windows)]
    let job = create_kill_on_close_job()?;

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        const CREATE_SUSPENDED: u32 = 0x0000_0004;
        cmd.creation_flags(CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP | CREATE_SUSPENDED);
    }

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(err) => return Err(format!("无法启动 Codex CLI：{err}")),
    };

    #[cfg(windows)]
    {
        if let Err(err) = assign_child_to_job(&job, &child) {
            let _ = child.kill();
            let wait_err = child.wait().err().map(|e| e.to_string());
            return Err(match wait_err {
                Some(wait) => format!("{err}；结束挂起进程失败：{wait}"),
                None => err,
            });
        }
        let resume = if RUN_OWNED_FAULT.get() == JOB_FAULT_SKIP_RESUME {
            Err("注入故障：跳过 ResumeThread。".to_string())
        } else {
            resume_child_threads(child.id())
        };
        if let Err(err) = resume {
            let reap = reap_owned_job(&job, &mut child, Duration::from_secs(30));
            return Err(match reap {
                Ok(()) => format!("{err} 已收束 owned child（Job ActiveProcesses=0）。"),
                Err(reap) => format!("{err}；{reap}"),
            });
        }
    }

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let t_out = std::thread::spawn(move || stdout.map(|r| capped_read(r, PIPE_CAP)).unwrap_or_default());
    let t_err = std::thread::spawn(move || stderr.map(|r| capped_read(r, PIPE_CAP)).unwrap_or_default());
    let start = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(st)) => break st,
            Ok(None) if start.elapsed() < timeout => std::thread::sleep(Duration::from_millis(40)),
            Ok(None) => {
                #[cfg(windows)]
                {
                    let reap = reap_owned_job(&job, &mut child, Duration::from_secs(30));
                    let _ = t_out.join();
                    let _ = t_err.join();
                    return Err(match reap {
                        Ok(()) => {
                            "Codex CLI 超时，Job ActiveProcesses=0 且根进程已退出，未确认安装完成。".into()
                        }
                        Err(err) => format!("Codex CLI 超时：{err}"),
                    });
                }
                #[cfg(not(windows))]
                {
                    let _ = child.kill();
                    let waited = child.wait();
                    let _ = t_out.join();
                    let _ = t_err.join();
                    return Err(match waited {
                        Ok(_) => "Codex CLI 超时，已结束本次进程（Unix 不保证子孙进程）。".into(),
                        Err(err) => format!("Codex CLI 超时且未能确认退出：{err}。"),
                    });
                }
            }
            Err(err) => return Err(format!("等待 CLI 失败：{err}")),
        }
    };
    let stdout = t_out.join().unwrap_or_default();
    let stderr = t_err.join().unwrap_or_default();
    Ok(CliOutcome {
        status: status.code().unwrap_or(1),
        stdout: String::from_utf8_lossy(&stdout).into_owned(),
        stderr: String::from_utf8_lossy(&stderr).into_owned(),
    })
}

fn tree_fingerprint(dir: &Path) -> Result<String, String> {
    reject_reparse_chain(dir)?;
    let mut files = walk_files(dir)?;
    files.sort();
    let mut acc = String::new();
    for path in files {
        let rel = rel_to(dir, &path);
        acc.push_str(&rel.to_string_lossy());
        acc.push(':');
        acc.push_str(&sha256_file(&path)?);
        acc.push(';');
    }
    Ok(sha256_bytes(acc.as_bytes()))
}

fn restore_if_ours(
    dest: &Path,
    our_fp: &str,
    backup: Option<&Path>,
    created: bool,
) -> Result<bool, String> {
    if our_fp.is_empty() {
        return Err("拒绝用空指纹授权整目录回滚。".into());
    }
    if !dest.exists() {
        return Ok(true);
    }
    let now = tree_fingerprint(dest)?;
    if now != our_fp {
        return Ok(false);
    }
    if created {
        fs::remove_dir_all(dest).map_err(|err| format!("撤回新插件源失败：{err}"))?;
        return Ok(true);
    }
    if let Some(backup) = backup {
        if backup.exists() {
            fs::remove_dir_all(dest).map_err(|err| format!("回滚前清除本次插件源失败：{err}"))?;
            copy_tree(backup, dest)?;
            return Ok(true);
        }
    }
    Ok(false)
}

fn restore_file_if_ours(path: &Path, written: &str, backup: Option<&Path>, created: bool) -> Result<bool, String> {
    if !path.exists() {
        return Ok(true);
    }
    let now = fs::read_to_string(path).map_err(|err| format!("读不了 {}：{err}", path.display()))?;
    if now != written {
        return Ok(false);
    }
    if created {
        fs::remove_file(path).map_err(|err| format!("撤回 marketplace 失败：{err}"))?;
        return Ok(true);
    }
    if let Some(backup) = backup {
        if backup.is_file() {
            fs::copy(backup, path).map_err(|e| e.to_string())?;
            return Ok(true);
        }
    }
    Ok(false)
}

fn plugin_version(dir: &Path) -> Option<String> {
    read_json(&dir.join(".codex-plugin/plugin.json"))
        .ok()?
        .get("version")
        .and_then(Value::as_str)
        .map(|s| s.to_string())
}

fn source_matches_target(dest: &Path, bundle: &Path, mcp: &str) -> bool {
    if !dest.is_dir() {
        return false;
    }
    match existing_is_custom(dest, bundle) {
        Ok(None) => {}
        _ => return false,
    }
    for rel in MANAGED_RELATIVE {
        if !dest.join(rel).is_file() {
            return false;
        }
    }
    let helper = dest.join("bin").join(helper_name());
    if !helper.is_file() {
        return false;
    }
    let Ok(dest_mcp) = read_json(&dest.join(".mcp.json")) else {
        return false;
    };
    if dest_mcp != mcp_document(mcp) {
        return false;
    }
    let Ok(hooks) = read_json(&dest.join("hooks/hooks.json")) else {
        return false;
    };
    let Ok(status) = status_url_for_mcp(mcp) else {
        return false;
    };
    if expect_hooks_exact(&hooks, &status).is_err() {
        return false;
    }
    for rel in MANAGED_RELATIVE {
        if matches!(
            *rel,
            ".mcp.json" | "hooks/hooks.json" | ".codex-plugin/plugin.json"
        ) {
            continue;
        }
        if !files_equal(&dest.join(rel), &bundle.join(rel)) {
            return false;
        }
    }
    if !files_equal(&helper, &bundle.join("bin").join(helper_name())) {
        return false;
    }
    let Ok(a) = read_json(&dest.join(".codex-plugin/plugin.json")) else {
        return false;
    };
    let Ok(b) = read_json(&bundle.join(".codex-plugin/plugin.json")) else {
        return false;
    };
    plugin_json_only_version_may_differ(&a, &b).is_ok()
}

struct MatchingPayload {
    dest: PathBuf,
    cache: PathBuf,
    market: String,
    version: String,
}

fn matching_payload(paths: &SetupPaths, mcp: &str) -> Option<MatchingPayload> {
    // Matching plugin bytes alone do not complete a legacy installation: the
    // transaction still needs to remove duplicate MCP and official Skill entries.
    if !matches!(read_legacy(&paths.codex_home, mcp), Ok(LegacySpellcast::Absent)) {
        return None;
    }
    let standalone = standalone_skill_dir(&paths.codex_home);
    if standalone.join("SKILL.md").is_file()
        && SKILL_OFFICIAL.iter().all(|rel| {
            let have = standalone.join(rel);
            !have.is_file() || files_equal(&have, &paths.resource_root.join("skills/spellcast").join(rel))
        })
    {
        return None;
    }
    let dest = source_path(&paths.user_home);
    if !source_matches_target(&dest, &paths.resource_root, mcp) {
        return None;
    }
    let version = plugin_version(&dest)?;
    let market = marketplace_name(&marketplace_path(&paths.user_home));
    let cache = cache_dir_for_version(&cache_root(&paths.codex_home, &market), &version);
    verify_cache(&cache, &dest, mcp).ok()?;
    Some(MatchingPayload {
        dest,
        cache,
        market,
        version,
    })
}

fn write_journal(backup: &Path, doc: &Value) {
    let _ = fs::create_dir_all(backup);
    if let Ok(mut text) = serde_json::to_string_pretty(doc) {
        text.push('\n');
        let _ = fs::write(backup.join("journal.json"), text);
    }
}

fn locate_report(mut r: SetupReport, paths: &SetupPaths, mcp: &str, cache: Option<&Path>) -> SetupReport {
    r.mcp_url = Some(mcp.to_string());
    r.marketplace_path = Some(marketplace_path(&paths.user_home).display().to_string());
    r.source_path = Some(source_path(&paths.user_home).display().to_string());
    r.cache_path = cache.map(|p| p.display().to_string());
    r
}

fn grok_config_path(user_home: &Path) -> PathBuf {
    user_home.join(".grok").join("config.toml")
}

fn grok_skill_root(user_home: &Path) -> PathBuf {
    user_home
        .join(".grok")
        .join("skills")
        .join("spellcast")
}

#[derive(Debug, PartialEq, Eq)]
enum GrokMcp {
    Absent,
    Ready,
    Incomplete,
    Conflict(String),
    Shape(String),
}

fn inspect_grok_spellcast(doc: &DocumentMut, mcp: &str) -> GrokMcp {
    let Some(servers_item) = doc.get("mcp_servers") else {
        return GrokMcp::Absent;
    };
    let Some(servers) = servers_item.as_table() else {
        return GrokMcp::Shape("mcp_servers 不是表，已保护。".into());
    };
    let Some(entry_item) = servers.get(PLUGIN_NAME) else {
        return GrokMcp::Absent;
    };
    let Some(entry) = entry_item.as_table() else {
        return GrokMcp::Shape("mcp_servers.spellcast 不是普通表，已保护。".into());
    };
    let mut enabled = false;
    let mut url: Option<String> = None;
    let mut stdio_residue = false;
    for (key, item) in entry.iter() {
        match key {
            "enabled" => {
                enabled = item.as_value().and_then(|v| v.as_bool()).unwrap_or(false);
            }
            "url" => {
                url = item.as_value().and_then(|v| v.as_str()).map(str::to_string);
            }
            "command" | "args" | "type" => stdio_residue = true,
            _ => {}
        }
    }
    match (enabled, url.as_deref()) {
        (true, Some(found)) if found == mcp && !stdio_residue => GrokMcp::Ready,
        (true, Some(found)) if found == mcp => GrokMcp::Incomplete,
        (true, Some(found)) => {
            GrokMcp::Conflict(format!("mcp_servers.spellcast.url={found} 指向其他实例。"))
        }
        (_, None) => GrokMcp::Absent,
        _ => GrokMcp::Incomplete,
    }
}

fn inspect_grok_config(path: &Path, mcp: &str) -> Result<GrokMcp, String> {
    if !path.is_file() {
        return Ok(GrokMcp::Absent);
    }
    let text =
        fs::read_to_string(path).map_err(|err| format!("读不了 {}：{err}", path.display()))?;
    let doc = text
        .parse::<DocumentMut>()
        .map_err(|err| format!("{} 不是有效 TOML：{err}", path.display()))?;
    Ok(inspect_grok_spellcast(&doc, mcp))
}

fn grok_skill_present(root: &Path) -> bool {
    root.join("SKILL.md").is_file()
        && ["asides.md", "canvas.md", "works.md", "feedback.md"]
            .iter()
            .all(|name| root.join("references").join(name).is_file())
}

fn locate_grok(mut r: SetupReport, mcp: &str) -> SetupReport {
    r.mcp_url = Some(mcp.to_string());
    r
}

fn grok_status(client: &str, url: Option<&str>, paths: &SetupPaths) -> SetupReport {
    let mcp = match url
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(validate_loopback_mcp_url)
        .unwrap_or_else(|| Ok("http://127.0.0.1:47194/mcp".into()))
    {
        Ok(v) => v,
        Err(err) => return SetupReport::base(client, SetupKind::Failed, &err),
    };
    let config = grok_config_path(&paths.user_home);
    let skill = grok_skill_root(&paths.user_home);
    let mcp_state = match inspect_grok_config(&config, &mcp) {
        Ok(state) => state,
        Err(err) => {
            return locate_grok(SetupReport::base(client, SetupKind::Failed, &err), &mcp);
        }
    };
    match &mcp_state {
        GrokMcp::Conflict(reason) => {
            let mut r = SetupReport::base(client, SetupKind::ConflictEndpoint, reason);
            r.conflicts.push(reason.clone());
            r.not_done.push("未改 Grok 配置、未安装 Skill。".into());
            return locate_grok(r, &mcp);
        }
        GrokMcp::Shape(reason) => {
            let mut r = SetupReport::base(client, SetupKind::ConflictCustom, reason);
            r.conflicts.push(reason.clone());
            r.not_done.push("未改 Grok 配置、未安装 Skill。".into());
            return locate_grok(r, &mcp);
        }
        GrokMcp::Absent | GrokMcp::Ready | GrokMcp::Incomplete => {}
    }
    let skill_ok = grok_skill_present(&skill);
    let grok_home = paths.user_home.join(".grok");
    let hook_ok = crate::completion_hook::grok_hook_installed(&grok_home, &paths.completion_root);
    if matches!(mcp_state, GrokMcp::Ready) && skill_ok && hook_ok {
        let mut r = SetupReport::base(
            client,
            SetupKind::Verified,
            "Grok Build 的 MCP、Skill 与完成通知已按文件核验。",
        );
        r.done.push(format!("MCP：{}", config.display()));
        r.done
            .push(format!("Skill：{}", skill.join("SKILL.md").display()));
        r.done.push(format!(
            "完成通知：{} → {}",
            crate::completion_hook::grok_hook_path(&grok_home).display(),
            crate::completion_hook::grok_hook_command(&paths.completion_root)
        ));
        r.done.push("未写 hook trust。".into());
        r.not_done.push("未改旁念开关。".into());
        return locate_grok(r, &mcp);
    }
    let mut r = SetupReport::base(
        client,
        SetupKind::NotInstalled,
        "尚未安装 Grok Build 接入（MCP + Skill + 完成通知）。",
    );
    if matches!(mcp_state, GrokMcp::Ready) {
        r.done.push("MCP 已写入。".into());
    } else {
        r.not_done.push("MCP 未写入。".into());
    }
    if skill_ok {
        r.done.push("Skill 已安装。".into());
    } else {
        r.not_done.push("Skill 未安装。".into());
    }
    if hook_ok {
        r.done.push("完成通知已写入。".into());
    } else {
        r.not_done.push("完成通知未写入。".into());
    }
    locate_grok(r, &mcp)
}

fn grok_install_inner(client: &str, url: Option<&str>, paths: &SetupPaths) -> SetupReport {
    let mut probe = grok_status(client, url, paths);
    if matches!(
        probe.kind,
        SetupKind::Unsupported
            | SetupKind::Failed
            | SetupKind::ConflictEndpoint
            | SetupKind::ConflictCustom
            | SetupKind::Installing
    ) {
        probe.not_done.push("安装未开始。".into());
        return probe;
    }
    if probe.kind == SetupKind::Verified && probe.installed {
        probe.note = "已是当前 Grok Build 接入，未重复写入。".into();
        probe.done.push("未调用 Codex CLI。".into());
        probe.done.push("未写 hook trust。".into());
        return probe;
    }
    let mcp = match validate_loopback_mcp_url(
        probe
            .mcp_url
            .as_deref()
            .unwrap_or("http://127.0.0.1:47194/mcp"),
    ) {
        Ok(v) => v,
        Err(err) => return SetupReport::base(client, SetupKind::Failed, &err),
    };
    let written = match configure::write_for_home(client, &paths.user_home, &mcp) {
        Ok(cfg) => cfg,
        Err(err) => return SetupReport::base(client, SetupKind::Failed, &err),
    };
    let skill = match configure::install_skill_for_home(client, &paths.user_home) {
        Ok(installed) => installed,
        Err(err) => {
            let mut r = SetupReport::base(client, SetupKind::Failed, &err);
            r.partial = true;
            r.mcp_url = Some(mcp);
            r.done.push("MCP 已写入，Skill 未完成。".into());
            r.backup = written.backup;
            return r;
        }
    };
    // Grok Build's Stop lifecycle hook (~/.grok/hooks/spellcast.json) is the completion signal, like Codex notify.
    if let Err(err) = crate::completion_hook::install_grok(
        &paths.user_home.join(".grok"),
        &paths.completion_root,
        &paths.notify_helper,
    ) {
        let mut r = SetupReport::base(client, SetupKind::Failed, &err);
        r.partial = true;
        r.mcp_url = Some(mcp);
        r.done.push("MCP 与 Skill 已写入，完成通知未完成。".into());
        r.backup = written.backup.or(skill.backup);
        return r;
    }
    let mut r = grok_status(client, Some(&mcp), paths);
    if r.backup.is_none() {
        r.backup = written.backup.or(skill.backup);
    }
    r.done.insert(0, "未调用 Codex CLI。".into());
    r.done.insert(0, "未写 hook trust。".into());
    r
}

fn status_inner(
    client: &str,
    url: Option<&str>,
    paths: &SetupPaths,
    cli: Option<&dyn PluginCli>,
) -> SetupReport {
    if client == "grok" {
        return grok_status(client, url, paths);
    }
    if client != "codex" {
        let mut r = SetupReport::base(
            client,
            SetupKind::Unsupported,
            "此客户端暂不支持完整接入（MCP + hooks + Skill）。",
        );
        r.not_done.push("完整接入未执行。".into());
        return r;
    }
    let mcp = match url
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(validate_loopback_mcp_url)
        .unwrap_or_else(|| Ok("http://127.0.0.1:47194/mcp".into()))
    {
        Ok(v) => v,
        Err(err) => return SetupReport::base(client, SetupKind::Failed, &err),
    };
    if let Err(err) = inspect_resources(&paths.resource_root) {
        return SetupReport::base(client, SetupKind::MissingResources, &err);
    }
    let cli_ok = paths.cli.is_some()
        || cli.is_some()
        || (!paths.skip_path_lookup && find_codex_cli().is_some());
    if !cli_ok {
        return SetupReport::base(client, SetupKind::MissingCli, "未找到 Codex CLI（codex）。");
    }
    match read_legacy(&paths.codex_home, &mcp) {
        Ok(LegacySpellcast::ConflictEndpoint(reason)) => {
            let mut r = SetupReport::base(client, SetupKind::ConflictEndpoint, &reason);
            r.conflicts.push(reason);
            return locate_report(r, paths, &mcp, None);
        }
        Ok(LegacySpellcast::ConflictShape(reason)) => {
            let mut r = SetupReport::base(client, SetupKind::ConflictCustom, &reason);
            r.conflicts.push(reason);
            return locate_report(r, paths, &mcp, None);
        }
        Ok(_) => {}
        Err(err) => return SetupReport::base(client, SetupKind::Failed, &err),
    }
    let market_path = marketplace_path(&paths.user_home);
    match marketplace_spellcast_conflict(&market_path, &paths.user_home) {
        Ok(Some(reason)) => {
            let mut r = SetupReport::base(client, SetupKind::ConflictCustom, &reason);
            r.conflicts.push(reason);
            r.not_done.push("未改 marketplace、未调用 CLI、未覆盖插件源。".into());
            return locate_report(r, paths, &mcp, None);
        }
        Err(err) => return SetupReport::base(client, SetupKind::Failed, &err),
        Ok(None) => {}
    }
    let dest = source_path(&paths.user_home);
    match existing_is_custom(&dest, &paths.resource_root) {
        Ok(Some(reason)) => {
            let mut r = SetupReport::base(client, SetupKind::ConflictCustom, &reason);
            r.conflicts.push(reason);
            r.not_done.push("未改 marketplace、未调用 CLI、未覆盖插件源。".into());
            return locate_report(r, paths, &mcp, None);
        }
        Err(err) => return SetupReport::base(client, SetupKind::Failed, &err),
        Ok(None) => {}
    }
    if let Some(payload) = matching_payload(paths, &mcp) {
        return locate_report(
            classify_installed_payload(client, paths, &payload, cli),
            paths,
            &mcp,
            Some(&payload.cache),
        );
    }
    locate_report(
        SetupReport::base(client, SetupKind::NotInstalled, "尚未安装完整 Spellcast 接入。"),
        paths,
        &mcp,
        None,
    )
}

pub fn status(client: &str, url: Option<&str>, paths: &SetupPaths) -> SetupReport {
    status_inner(client, url, paths, None)
}

pub fn status_with_cli(
    client: &str,
    url: Option<&str>,
    paths: &SetupPaths,
    cli: &dyn PluginCli,
) -> SetupReport {
    status_inner(client, url, paths, Some(cli))
}

fn read_legacy(codex_home: &Path, mcp: &str) -> Result<LegacySpellcast, String> {
    let path = config_path(codex_home);
    if !path.is_file() {
        return Ok(LegacySpellcast::Absent);
    }
    let text = fs::read_to_string(path).map_err(|e| e.to_string())?;
    let doc = text
        .parse::<DocumentMut>()
        .map_err(|err| format!("config.toml 不是有效 TOML：{err}"))?;
    Ok(inspect_legacy_spellcast(&doc, mcp))
}

fn setup_lock_path(codex_home: &Path) -> PathBuf {
    codex_home.join("spellcast-setup.lock")
}

fn is_lock_busy(err: &std::io::Error) -> bool {
    matches!(
        err.kind(),
        ErrorKind::WouldBlock
            | ErrorKind::TimedOut
            | ErrorKind::AlreadyExists
            | ErrorKind::ResourceBusy
    ) || matches!(
        err.raw_os_error(),
        Some(11) | Some(16) | Some(32) | Some(33) | Some(35) | Some(167)
    )
}

fn same_existing_path(a: &Path, b: &Path) -> bool {
    match (fs::canonicalize(a), fs::canonicalize(b)) {
        (Ok(a), Ok(b)) => a == b,
        _ => false,
    }
}

fn inspect_hook_trust(value: &Value, user_home: &Path, market: &str, cache: &Path) -> Result<HookTrust, String> {
    let entries = value.get("data").and_then(Value::as_array).ok_or("Codex 未返回有效的 Hook 列表。")?;
    let entries: Vec<_> = entries.iter().filter(|entry| entry.get("cwd").and_then(Value::as_str)
        .is_some_and(|cwd| same_existing_path(Path::new(cwd), user_home))).collect();
    if entries.len() != 1 { return Err("Codex 未返回当前安装配置的唯一 Hook 列表。".into()); }
    let entry = entries[0];
    if !entry.get("errors").and_then(Value::as_array).is_some_and(Vec::is_empty) {
        return Err("Codex 读取 Hook 配置时报告错误。".into());
    }
    let plugin = format!("spellcast@{market}");
    let hooks: Vec<_> = entry.get("hooks").and_then(Value::as_array).ok_or("Codex Hook 列表缺失。")?
        .iter().filter(|hook| hook.get("pluginId").and_then(Value::as_str) == Some(plugin.as_str())).collect();
    if hooks.len() != 2 { return Err("Codex 尚未加载当前 Spellcast 的两项 Hook。".into()); }
    let expected_path = cache.join("hooks/hooks.json");
    let mut states = Vec::new();
    for (event, key) in [("sessionStart", "session_start"), ("userPromptSubmit", "user_prompt_submit")] {
        let expected_key = format!("{plugin}:hooks/hooks.json:{key}:0:0");
        let hook = hooks.iter().find(|hook| hook.get("key").and_then(Value::as_str) == Some(expected_key.as_str()))
            .ok_or("Codex 的 Hook 标识与当前插件不一致。")?;
        if hook.get("eventName").and_then(Value::as_str) != Some(event)
            || hook.get("source").and_then(Value::as_str) != Some("plugin")
            || !hook.get("sourcePath").and_then(Value::as_str).is_some_and(|p| same_existing_path(Path::new(p), &expected_path)) {
            return Err("Codex Hook 来源与当前已安装版本不一致。".into());
        }
        let hash = hook.get("currentHash").and_then(Value::as_str).unwrap_or("");
        if !hash.strip_prefix("sha256:").is_some_and(|h| h.len() == 64 && h.bytes().all(|c| c.is_ascii_hexdigit())) {
            return Err("Codex 未返回可核验的当前 Hook 标识。".into());
        }
        let enabled = hook.get("enabled").and_then(Value::as_bool).ok_or("Codex 未返回 Hook 启用状态。")?;
        let state = match hook.get("trustStatus").and_then(Value::as_str) {
            Some("trusted" | "managed") => HookTrust::Trusted,
            Some("untrusted") => HookTrust::Untrusted,
            Some("modified") => HookTrust::Modified,
            _ => return Err("当前 Codex Hook 信任状态无法识别。".into()),
        };
        states.push(if enabled { state } else { HookTrust::Disabled });
    }
    for state in [HookTrust::Disabled, HookTrust::Modified, HookTrust::Untrusted] {
        if states.contains(&state) { return Ok(state); }
    }
    Ok(HookTrust::Trusted)
}

fn apply_hook_trust(mut report: SetupReport, paths: &SetupPaths, market: &str, cache: &Path, cli: &dyn PluginCli) -> SetupReport {
    let env = CliEnv { user_home: paths.user_home.clone(), codex_home: paths.codex_home.clone() };
    let trust = match cli.hooks_list(&env).and_then(|v| inspect_hook_trust(&v, &paths.user_home, market, cache)) {
        Ok(trust) => trust,
        Err(reason) => { report.not_done.push(reason); HookTrust::Unknown }
    };
    report.hook_trust = Some(trust);
    let (kind, note) = match trust {
        HookTrust::Trusted => (SetupKind::Verified, "MCP、Hooks 和 Skill 已安装；Codex 确认当前两项 Hook 已启用并信任。"),
        HookTrust::Untrusted => (SetupKind::InstalledPendingTrust, "已安装。请在 Codex /hooks 信任 Spellcast 的两项 Hook。"),
        HookTrust::Modified => (SetupKind::InstalledPendingTrust, "已安装。Hook 内容发生变化，请在 Codex /hooks 重新检查并信任。"),
        HookTrust::Disabled => (SetupKind::InstalledUnverified, "已安装，但 Codex 中的 Spellcast Hook 已停用。请在 /hooks 中启用。"),
        HookTrust::Unknown => (SetupKind::InstalledUnverified, "已安装；暂时无法读取当前 Hook 信任状态。已信任时无需重复安装，可重新检查。"),
    };
    report.kind = kind;
    report.note = note.into();
    report
}

fn classify_installed_payload(
    client: &str,
    paths: &SetupPaths,
    payload: &MatchingPayload,
    cli: Option<&dyn PluginCli>,
) -> SetupReport {
    let pending_files = || {
        let mut r = SetupReport::base(
            client,
            SetupKind::InstalledUnverified,
            "已安装并核验文件；尚未取得 Codex 的 Hook 信任结果。",
        );
        r.hook_trust = Some(HookTrust::Unknown);
        r
    };
    let Some(cli) = cli else {
        return pending_files();
    };
    let env = CliEnv {
        user_home: paths.user_home.clone(),
        codex_home: paths.codex_home.clone(),
    };
    let queried = match cli.plugin_list(&payload.market, &env) {
        Ok(out) if out.status == 0 => {
            inspect_plugin_list(
                &out.stdout,
                &payload.market,
                SOURCE_REL,
                &paths.user_home,
                Some(&payload.version),
            )
        }
        Ok(out) => Err(format!("plugin list exit {}", out.status)),
        Err(err) => Err(err),
    };
    match queried {
        Ok(PluginListState::Active { .. }) => {
            let mut r = pending_files();
            r.done
                .push("CLI list 确认 installed/enabled，且 version 绑定当前 cache。".into());
            apply_hook_trust(r, paths, &payload.market, &payload.cache, cli)
        }
        Ok(PluginListState::Missing) => {
            let mut r = SetupReport::base(client, SetupKind::NotInstalled, "CLI list 确认插件未安装。");
            r.installed = false;
            r.not_done.push("本地文件匹配当前 payload，但 CLI 标记 missing。".into());
            r
        }
        Ok(PluginListState::Disabled { .. }) => {
            let mut r = SetupReport::base(
                client,
                SetupKind::PendingReload,
                "插件未启用，需要修复。",
            );
            r.installed = false;
            r.not_done.push("CLI list 确认 installed 但 enabled=false。".into());
            r
        }
        Ok(PluginListState::VersionMismatch { found }) => {
            let mut r = SetupReport::base(
                client,
                SetupKind::NotInstalled,
                &format!("已安装 version {found} 与当前 payload {} 不匹配。", payload.version),
            );
            r.installed = false;
            r.not_done.push("version 差异，不视为完整接入。".into());
            r
        }
        Err(err) => {
            let mut r = SetupReport::base(
                client,
                SetupKind::PendingReload,
                "已存在当前 payload，CLI 查询失败，待核验。",
            );
            r.installed = false;
            r.not_done
                .push(format!("验证受阻：{err}。未当作未安装，未清理或重装。"));
            r
        }
    }
}

pub fn install(
    client: &str,
    url: Option<&str>,
    paths: &SetupPaths,
    cli: &dyn PluginCli,
) -> SetupReport {
    if client == "grok" {
        let _lock = match paths.lock.try_lock() {
            Ok(guard) => guard,
            Err(_) => {
                return SetupReport::base(client, SetupKind::Installing, "已有安装正在进行。");
            }
        };
        return grok_install_inner(client, url, paths);
    }
    let lock = match paths.lock.try_lock() {
        Ok(g) => g,
        Err(_) => {
            return SetupReport::base(client, SetupKind::Installing, "已有安装正在进行。");
        }
    };
    if let Err(err) = fs::create_dir_all(&paths.codex_home) {
        return SetupReport::base(client, SetupKind::Failed, &format!("建不了 Codex home：{err}"));
    }
    let lock_path = setup_lock_path(&paths.codex_home);
    let file = match OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .open(&lock_path)
    {
        Ok(f) => f,
        Err(err) => {
            return SetupReport::base(client, SetupKind::Failed, &format!("打不开安装锁：{err}"));
        }
    };
    if let Err(err) = file.try_lock_exclusive() {
        if is_lock_busy(&err) {
            return SetupReport::base(client, SetupKind::Installing, "已有安装正在进行。");
        }
        return SetupReport::base(client, SetupKind::Failed, &format!("获取安装锁失败：{err}"));
    }
    if let Ok(ready) = std::env::var("SPELLCAST_SETUP_LOCK_READY") {
        let _ = fs::write(ready, b"ready\n");
    }
    let report = install_inner(client, url, paths, cli);
    let _ = FileExt::unlock(&file);
    drop(lock);
    report
}

fn skip_current_report(
    client: &str,
    paths: &SetupPaths,
    mcp: &str,
    payload: &MatchingPayload,
    cli: &dyn PluginCli,
) -> SetupReport {
    let mut r = SetupReport::base(
        client,
        SetupKind::InstalledUnverified,
        "已是当前完整接入，未重复写入。",
    );
    r.done.push("未写 hook trust。".into());
    r.done
        .push("源与 cache 已匹配且 CLI installed/enabled，跳过 plugin add、备份与写文件。".into());
    r.not_done.push("未改旁念开关。".into());
    let r = apply_hook_trust(r, paths, &payload.market, &payload.cache, cli);
    locate_report(r, paths, mcp, Some(&payload.cache))
}

fn blocked_current_report(
    client: &str,
    paths: &SetupPaths,
    mcp: &str,
    payload: &MatchingPayload,
    reason: String,
) -> SetupReport {
    let mut r = SetupReport::base(
        client,
        SetupKind::PendingReload,
        "已存在当前 payload，CLI 查询失败，待核验。",
    );
    r.installed = false;
    r.done.push("未写 hook trust。".into());
    r.done.push("未重复写入插件源或 marketplace。".into());
    r.not_done.push(reason);
    locate_report(r, paths, mcp, Some(&payload.cache))
}

fn install_inner(
    client: &str,
    url: Option<&str>,
    paths: &SetupPaths,
    cli: &dyn PluginCli,
) -> SetupReport {
    let mut probe = status_with_cli(client, url, paths, cli);
    if matches!(
        probe.kind,
        SetupKind::Unsupported
            | SetupKind::MissingCli
            | SetupKind::MissingResources
            | SetupKind::Failed
            | SetupKind::ConflictEndpoint
            | SetupKind::ConflictCustom
            | SetupKind::Installing
    ) {
        probe.not_done.push("安装未开始。".into());
        return probe;
    }
    let mcp = match validate_loopback_mcp_url(
        probe.mcp_url.as_deref().unwrap_or("http://127.0.0.1:47194/mcp"),
    ) {
        Ok(v) => v,
        Err(err) => return SetupReport::base(client, SetupKind::Failed, &err),
    };
    let status_url = match status_url_for_mcp(&mcp) {
        Ok(v) => v,
        Err(err) => return SetupReport::base(client, SetupKind::Failed, &err),
    };
    let dest = source_path(&paths.user_home);
    let env = CliEnv {
        user_home: paths.user_home.clone(),
        codex_home: paths.codex_home.clone(),
    };
    if let Some(payload) = matching_payload(paths, &mcp) {
        match cli.plugin_list(&payload.market, &env) {
            Ok(out) if out.status == 0 => {
                match inspect_plugin_list(
                    &out.stdout,
                    &payload.market,
                    SOURCE_REL,
                    &paths.user_home,
                    Some(&payload.version),
                ) {
                    Ok(PluginListState::Active { .. }) => {
                        return skip_current_report(client, paths, &mcp, &payload, cli);
                    }
                    Ok(PluginListState::Missing)
                    | Ok(PluginListState::Disabled { .. })
                    | Ok(PluginListState::VersionMismatch { .. }) => {}
                    Err(err) => {
                        return blocked_current_report(
                            client,
                            paths,
                            &mcp,
                            &payload,
                            format!("验证受阻：{err}。未当作未安装，未清理或重装。"),
                        );
                    }
                }
            }
            Ok(out) => {
                return blocked_current_report(
                    client,
                    paths,
                    &mcp,
                    &payload,
                    format!("验证受阻：plugin list exit {}。未当作未安装，未清理或重装。", out.status),
                );
            }
            Err(err) => {
                return blocked_current_report(
                    client,
                    paths,
                    &mcp,
                    &payload,
                    format!("验证受阻：{err}。未当作未安装，未清理或重装。"),
                );
            }
        }
    }

    let backup = backup_root(&paths.codex_home);
    let mut done = vec!["未写 hook trust。".into()];
    let mut not_done = vec![
        "未改旁念开关。".into(),
        "未改其他插件/hooks/model。".into(),
    ];
    let created_source = !dest.exists();
    let txn = txn_id();
    write_journal(
        &backup,
        &json!({
            "phase": "start",
            "created_source": created_source,
            "dest": dest.display().to_string(),
            "txn": txn,
        }),
    );
    if dest.exists() {
        if let Err(err) = copy_tree(&dest, &backup.join("plugin-source")) {
            return SetupReport::base(client, SetupKind::Failed, &err);
        }
        done.push("已备份现有插件源。".into());
    }
    let stage = backup.join("stage");
    if let Err(err) = copy_tree(&paths.resource_root, &stage) {
        return SetupReport::base(client, SetupKind::Failed, &err);
    }
    if let Err(err) = apply_endpoint(&stage, &mcp, &status_url) {
        return SetupReport::base(client, SetupKind::Failed, &err);
    }
    if let Err(err) = stamp_payload_version(&stage) {
        return SetupReport::base(client, SetupKind::Failed, &err);
    }
    done.push("已在隔离 stage 精确生成两事件 POSIX/Windows 命令、matcher、timeout 与同实例 MCP。".into());

    let next = match prepare_next_source(&dest, &stage, paths.fault, &txn) {
        Ok(next) => next,
        Err(err) => {
            write_journal(&backup, &json!({"phase": "overlay_failed", "error": err, "txn": txn}));
            let mut r = SetupReport::base(client, SetupKind::Failed, &err);
            r.done = done;
            r.not_done = not_done;
            r.not_done.push("插件源未提交，现有安装保持原样。".into());
            r.backup = Some(backup.display().to_string());
            return locate_report(r, paths, &mcp, None);
        }
    };
    if matches!(paths.fault, Some(FaultInject::Fingerprint)) {
        if let Err(clean) = fs::remove_dir_all(&next) {
            write_journal(
                &backup,
                &json!({"phase": "fingerprint_failed", "cleanup": clean.to_string()}),
            );
        }
        let mut r = SetupReport::base(client, SetupKind::Failed, "注入故障：fingerprint 失败。");
        r.done = done;
        r.not_done = not_done;
        r.not_done.push("插件源未提交，现有安装保持原样。".into());
        r.backup = Some(backup.display().to_string());
        return locate_report(r, paths, &mcp, None);
    }
    let source_fp = match tree_fingerprint(&next) {
        Ok(v) => v,
        Err(err) => {
            let _ = fs::remove_dir_all(&next);
            let mut r = SetupReport::base(client, SetupKind::Failed, &err);
            r.done = done;
            r.not_done = not_done;
            r.backup = Some(backup.display().to_string());
            return locate_report(r, paths, &mcp, None);
        }
    };
    if let Err(err) = activate_source(&next, &dest, &txn, paths.fault) {
        write_journal(
            &backup,
            &json!({
                "phase": "activate_failed",
                "error": err.message,
                "partial": err.partial,
                "restored": err.restored,
                "recoverable": err.recoverable.as_ref().map(|p| p.display().to_string()),
            }),
        );
        let mut r = SetupReport::base(client, SetupKind::Failed, &err.message);
        r.done = done;
        r.not_done = not_done;
        r.partial = err.partial;
        if err.restored {
            r.not_done.push("提交失败，已恢复原插件源。".into());
        } else if err.partial {
            r.not_done.push("原目录未能恢复到目标，恢复未完成。".into());
            if let Some(path) = &err.recoverable {
                r.not_done.push(format!("可恢复路径：{}", path.display()));
            }
        }
        r.backup = Some(
            err.recoverable
                .as_ref()
                .map(|p| p.display().to_string())
                .unwrap_or_else(|| backup.display().to_string()),
        );
        return locate_report(r, paths, &mcp, None);
    }
    write_journal(
        &backup,
        &json!({
            "phase": "source_committed",
            "created_source": created_source,
            "source_fp": source_fp,
        }),
    );
    done.push("已更新插件源（保留未知额外文件）。".into());

    let market_path = marketplace_path(&paths.user_home);
    let market_existed = market_path.is_file();
    let market = match upsert_marketplace(&market_path, &paths.user_home, SOURCE_REL, paths.fault) {
        Ok(v) => v,
        Err(err) => {
            let (restored, restore_note) = match restore_if_ours(
                &dest,
                &source_fp,
                (!created_source)
                    .then_some(backup.join("plugin-source"))
                    .as_deref(),
                created_source,
            ) {
                Ok(v) => (v, None),
                Err(restore_err) => (false, Some(restore_err)),
            };
            write_journal(
                &backup,
                &json!({
                    "phase": "marketplace_failed",
                    "error": err,
                    "source_restored": restored,
                    "restore_note": restore_note,
                }),
            );
            let mut r = SetupReport::base(client, SetupKind::Failed, &err);
            r.done = done;
            r.not_done = not_done;
            r.not_done.push("marketplace 未更新，CLI 未调用。".into());
            if let Some(note) = restore_note {
                r.partial = true;
                r.not_done.push(note);
            } else if !restored {
                r.partial = true;
                r.not_done.push("插件源未能证明仍是本次写入，未强行回滚。journal 在 backup 目录。".into());
            }
            r.backup = Some(backup.display().to_string());
            return locate_report(r, paths, &mcp, None);
        }
    };
    done.push("已更新 marketplace 中的 spellcast 条目，其他条目保留。".into());
    let market_written = market.2.clone();

    let env = CliEnv {
        user_home: paths.user_home.clone(),
        codex_home: paths.codex_home.clone(),
    };
    let selector = format!("{PLUGIN_NAME}@{}", market.0);
    let fail = |mut r: SetupReport, extra: String, done: Vec<String>, mut not_done: Vec<String>| {
        let (src_ok, src_note) = match restore_if_ours(
            &dest,
            &source_fp,
            (!created_source).then_some(backup.join("plugin-source")).as_deref(),
            created_source,
        ) {
            Ok(v) => (v, None),
            Err(e) => (false, Some(e)),
        };
        let (market_ok, market_note) = match restore_file_if_ours(
            &market_path,
            &market_written,
            market.1.as_deref(),
            !market_existed,
        ) {
            Ok(v) => (v, None),
            Err(e) => (false, Some(e)),
        };
        r.done = done;
        not_done.push(extra);
        if let Some(note) = src_note {
            not_done.push(note);
        }
        if let Some(note) = market_note {
            not_done.push(note);
        }
        write_journal(
            &backup,
            &json!({
                "phase": "cli_failed",
                "source_restored": src_ok,
                "market_restored": market_ok,
                "partial": !src_ok || !market_ok,
            }),
        );
        if !src_ok || !market_ok {
            r.partial = true;
            not_done.push("部分组件未能安全回滚，journal 在 backup 目录。".into());
        }
        r.not_done = not_done;
        r.backup = Some(backup.display().to_string());
        r.source_path = Some(dest.display().to_string());
        r.marketplace_path = Some(market_path.display().to_string());
        r
    };

    match cli.plugin_add(&selector, &env) {
        Ok(out) if out.status == 0 => {
            done.push("已调用官方 codex plugin add --json。".into());
            let list = match cli.plugin_list(&market.0, &env) {
                Ok(v) if v.status == 0 => v,
                Ok(v) => {
                    return fail(
                        SetupReport::base(client, SetupKind::Failed, "plugin list 失败，未报告已安装。"),
                        format!("list exit {}", v.status),
                        done.clone(),
                        not_done.clone(),
                    );
                }
                Err(err) => {
                    return fail(
                        SetupReport::base(client, SetupKind::Failed, &err),
                        err,
                        done.clone(),
                        not_done.clone(),
                    );
                }
            };
            let version = match inspect_plugin_list(
                &list.stdout,
                &market.0,
                SOURCE_REL,
                &paths.user_home,
                None,
            ) {
                Ok(PluginListState::Active { version, .. }) => version,
                Ok(PluginListState::Missing) => {
                    return fail(
                        SetupReport::base(client, SetupKind::Failed, "plugin list 确认未安装。"),
                        "plugin list missing after add".into(),
                        done.clone(),
                        not_done.clone(),
                    );
                }
                Ok(PluginListState::Disabled { .. }) => {
                    return fail(
                        SetupReport::base(client, SetupKind::Failed, "plugin list 确认未启用。"),
                        "plugin list disabled after add".into(),
                        done.clone(),
                        not_done.clone(),
                    );
                }
                Ok(PluginListState::VersionMismatch { found }) => found,
                Err(err) => {
                    return fail(
                        SetupReport::base(client, SetupKind::Failed, &err),
                        err,
                        done.clone(),
                        not_done.clone(),
                    );
                }
            };
            let cache = cache_dir_for_version(&cache_root(&paths.codex_home, &market.0), &version);
            if !cache.is_dir() {
                return fail(
                    SetupReport::base(
                        client,
                        SetupKind::Failed,
                        "未找到与本次 CLI version 绑定的 cache 目录。",
                    ),
                    format!("bound cache missing: {}", cache.display()),
                    done.clone(),
                    not_done.clone(),
                );
            }
            if let Err(err) = verify_cache(&cache, &stage, &mcp) {
                return fail(
                    SetupReport::base(client, SetupKind::Failed, &err),
                    err,
                    done.clone(),
                    not_done.clone(),
                );
            }
            done.push("已核验 cache 全部受管字节、两事件命令、plugin list 启用状态。".into());
            match merge_standalone_skill(&paths.codex_home, &stage, &backup) {
                Ok(notes) => done.extend(notes),
                Err(err) => done.push(format!("独立 Skill 归并跳过：{err}")),
            }
            match remove_redundant_legacy(&paths.codex_home, &mcp) {
                Ok(Some(reason)) => {
                    done.push(reason);
                }
                Ok(None) => {}
                Err(err) => done.push(format!("legacy MCP 处理跳过：{err}")),
            }
            not_done.push("CLI 成功不等于 hook 已信任或运行时已生效。".into());
            let mut r = SetupReport::base(
                client,
                SetupKind::InstalledUnverified,
                "已安装并核验 MCP、Hooks 和 Skill。",
            );
            r.done = done;
            r.not_done = not_done;
            r.source_path = Some(dest.display().to_string());
            r.cache_path = Some(cache.display().to_string());
            r.marketplace_path = Some(market_path.display().to_string());
            r.backup = Some(backup.display().to_string());
            r.mcp_url = Some(mcp);
            r.installed = true;
            apply_hook_trust(r, paths, &market.0, &cache, cli)
        }
        Ok(out) => fail(
            SetupReport::base(
                client,
                SetupKind::Failed,
                &format!("Codex CLI 失败（exit {}）。", out.status),
            ),
            "未报告已安装。".into(),
            done.clone(),
            not_done.clone(),
        ),
        Err(err) => fail(
            SetupReport::base(client, SetupKind::Failed, &err),
            err,
            done.clone(),
            not_done.clone(),
        ),
    }
}

pub fn default_paths(user_home: PathBuf, resource_root: PathBuf) -> Result<SetupPaths, String> {
    let codex_home = crate::completion_hook::codex_home()?;
    let completion_root = crate::completion_hook::root()?;
    let notify_helper = std::env::current_exe().map_err(|err| format!("找不到 Spellcast 程序：{err}"))?;
    Ok(SetupPaths {
        user_home,
        codex_home,
        resource_root,
        cli: find_codex_cli(),
        cli_timeout: Duration::from_secs(45),
        lock: global_install_lock(),
        skip_path_lookup: false,
        fault: None,
        completion_root,
        notify_helper,
    })
}

fn global_install_lock() -> Arc<Mutex<()>> {
    use std::sync::OnceLock;
    static LOCK: OnceLock<Arc<Mutex<()>>> = OnceLock::new();
    LOCK.get_or_init(|| Arc::new(Mutex::new(()))).clone()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn temp_dir(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "spellcast-{label}-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        // Parallel tests must never share a profile when the wall clock repeats.
        fs::create_dir(&dir).unwrap();
        dir
    }

    fn write_bundle(root: &Path, helper: &[u8]) {
        for rel in REQUIRED_RELATIVE {
            let path = root.join(rel);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(&path, rel.as_bytes()).unwrap();
        }
        fs::create_dir_all(root.join("bin")).unwrap();
        fs::write(root.join("bin").join(helper_name()), helper).unwrap();
        fs::write(
            root.join(".codex-plugin/plugin.json"),
            r#"{"name":"spellcast","version":"0.3.0","skills":"./skills/","mcpServers":"./.mcp.json"}"#,
        )
        .unwrap();
        apply_endpoint(
            root,
            "http://127.0.0.1:47194/mcp",
            "http://127.0.0.1:47194/api/observer/status",
        )
        .unwrap();
        fs::write(root.join("hooks/observer-bootstrap.txt"), b"BOOT").unwrap();
        fs::write(root.join("hooks/observer-stop.txt"), b"STOP").unwrap();
        fs::write(root.join("skills/spellcast/SKILL.md"), b"SKILL").unwrap();
        write_integrity(root).unwrap();
    }

    fn paths(user: &Path, codex: &Path, bundle: &Path) -> SetupPaths {
        SetupPaths {
            user_home: user.to_path_buf(),
            codex_home: codex.to_path_buf(),
            resource_root: bundle.to_path_buf(),
            cli: Some(PathBuf::from("injected")),
            cli_timeout: Duration::from_secs(2),
            lock: Arc::new(Mutex::new(())),
            skip_path_lookup: true,
            fault: None,
            completion_root: codex.join("spellcast").join("completions"),
            notify_helper: bundle.join("bin").join(helper_name()),
        }
    }

    fn hook_fixture(user: &Path, cache: &Path) -> Value {
        let hooks: Vec<_> = [("sessionStart", "session_start"), ("userPromptSubmit", "user_prompt_submit")]
            .into_iter().map(|(event, key)| json!({
                "key": format!("spellcast@personal:hooks/hooks.json:{key}:0:0"),
                "eventName": event, "pluginId": "spellcast@personal", "source": "plugin",
                "sourcePath": cache.join("hooks/hooks.json"), "enabled": true,
                "currentHash": format!("sha256:{}", "a".repeat(64)), "trustStatus": "trusted"
            })).collect();
        json!({ "data": [{ "cwd": user, "errors": [], "hooks": hooks }] })
    }

    #[test]
    fn hook_trust_uses_both_current_handlers_and_preserves_unknown() {
        let user = temp_dir("hook-trust"); let cache = user.join("cache");
        write_bundle(&cache, b"HELPER");
        let value = hook_fixture(&user, &cache);
        assert_eq!(inspect_hook_trust(&value, &user, "personal", &cache).unwrap(), HookTrust::Trusted);
        for (state, expected) in [("untrusted", HookTrust::Untrusted), ("modified", HookTrust::Modified), ("managed", HookTrust::Trusted)] {
            let mut changed = value.clone(); changed["data"][0]["hooks"][1]["trustStatus"] = json!(state);
            assert_eq!(inspect_hook_trust(&changed, &user, "personal", &cache).unwrap(), expected);
        }
        let mut disabled = value.clone(); disabled["data"][0]["hooks"][0]["enabled"] = json!(false);
        assert_eq!(inspect_hook_trust(&disabled, &user, "personal", &cache).unwrap(), HookTrust::Disabled);
        let other = user.join("old-cache"); write_bundle(&other, b"OLD");
        let mut stale = value.clone(); stale["data"][0]["hooks"][0]["sourcePath"] = json!(other.join("hooks/hooks.json"));
        assert!(inspect_hook_trust(&stale, &user, "personal", &cache).is_err());
        let mut missing = value.clone(); missing["data"][0]["hooks"].as_array_mut().unwrap().pop();
        assert!(inspect_hook_trust(&missing, &user, "personal", &cache).is_err());
        let mut unknown = value.clone(); unknown["data"][0]["hooks"][0]["trustStatus"] = json!("future-status");
        assert!(inspect_hook_trust(&unknown, &user, "personal", &cache).is_err());
        assert!(inspect_hook_trust(&value, &user, "other-market", &cache).is_err());
        assert!(inspect_hook_trust(&json!({}), &user, "personal", &cache).is_err());
    }

    #[test]
    fn hook_query_failure_does_not_mean_missing_install_or_pending_trust() {
        let user = temp_dir("hook-query"); let cache = user.join("cache");
        write_bundle(&cache, b"HELPER");
        let p = paths(&user, &user.join(".codex"), &cache);
        let report = apply_hook_trust(SetupReport::base("codex", SetupKind::InstalledUnverified, "installed"), &p, "personal", &cache, &ok_cli(&cache));
        assert!(report.installed);
        assert_eq!(report.kind, SetupKind::InstalledUnverified);
        assert_eq!(report.hook_trust, Some(HookTrust::Unknown));
        assert!(!report.note.contains("请在 Codex /hooks 信任"));
    }

    fn materialize_cache(bundle: &Path, env: &CliEnv, mcp: &str) -> (PathBuf, String) {
        let status = status_url_for_mcp(mcp).unwrap();
        let root = cache_root(&env.codex_home, "personal");
        fs::create_dir_all(&root).unwrap();
        let tmp = root.join(format!("tmp-{}", std::process::id()));
        let _ = fs::remove_dir_all(&tmp);
        copy_tree(bundle, &tmp).unwrap();
        apply_endpoint(&tmp, mcp, &status).unwrap();
        let version = stamp_payload_version(&tmp).unwrap();
        let cache = root.join(&version);
        if cache.is_dir() {
            fs::remove_dir_all(&tmp).unwrap();
            return (cache, version);
        }
        fs::rename(&tmp, &cache).unwrap();
        (cache, version)
    }

    fn list_json(env: &CliEnv, installed: bool, enabled: bool, version: Option<&str>) -> String {
        let version = version
            .map(|s| s.to_string())
            .or_else(|| plugin_version(&source_path(&env.user_home)))
            .unwrap_or_else(|| "0.3.0".into());
        json!([{
            "pluginId": "spellcast@personal",
            "name": "spellcast",
            "marketplaceName": "personal",
            "version": version,
            "installed": installed,
            "enabled": enabled,
            "source": { "path": "./plugins/spellcast" }
        }])
        .to_string()
    }

    fn ok_cli(bundle: &Path) -> impl PluginCli {
        let bundle = bundle.to_path_buf();
        ScriptCli {
            add: {
                let bundle = bundle.clone();
                move |_sel: &str, env: &CliEnv| {
                    let (cache, version) =
                        materialize_cache(&bundle, env, "http://127.0.0.1:47194/mcp");
                    Ok(CliOutcome {
                        status: 0,
                        stdout: json!({"installedPath": cache, "version": version}).to_string(),
                        stderr: String::new(),
                    })
                }
            },
            list: {
                move |_m: &str, env: &CliEnv| {
                    Ok(CliOutcome {
                        status: 0,
                        stdout: list_json(env, true, true, None),
                        stderr: String::new(),
                    })
                }
            },
        }
    }

    #[test]
    fn temp_profile_is_not_rejected_for_system_var_symlink() {
        let dir = temp_dir("reparse-var");
        reject_reparse_chain(&dir).unwrap();
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn rejects_remote_and_shell_endpoint() {
        assert!(validate_loopback_mcp_url("https://example.com/mcp").is_err());
        assert!(validate_loopback_mcp_url("http://127.0.0.1:47194/mcp; rm").is_err());
        assert!(validate_loopback_mcp_url("http://10.0.0.1:47194/mcp").is_err());
        assert!(validate_loopback_mcp_url("http://127.0.0.1:47194/mcp").is_ok());
    }

    #[test]
    fn unsupported_clients_do_not_install() {
        let user = temp_dir("user");
        let bundle = user.join("bundle");
        write_bundle(&bundle, b"HELPER");
        for client in ["windsurf", "cursor", "claude-code", "generic"] {
            let r = install(
                client,
                None,
                &paths(&user, &user.join(".codex"), &bundle),
                &ok_cli(&bundle),
            );
            assert_eq!(r.kind, SetupKind::Unsupported, "{client}");
            assert!(!r.installed);
            assert!(!r.complete_supported);
        }
    }

    struct PanicCli;

    impl PluginCli for PanicCli {
        fn plugin_add(&self, _selector: &str, _env: &CliEnv) -> Result<CliOutcome, String> {
            panic!("Grok Build 接入不得调用 Codex CLI");
        }
        fn plugin_list(&self, _marketplace: &str, _env: &CliEnv) -> Result<CliOutcome, String> {
            panic!("Grok Build 接入不得调用 Codex CLI");
        }
    }

    #[test]
    fn grok_status_and_install_write_mcp_and_skill_under_isolated_home() {
        let user = temp_dir("grok-user");
        let codex = user.join(".codex");
        let bundle = user.join("bundle");
        write_bundle(&bundle, b"HELPER");
        fs::create_dir_all(&codex).unwrap();
        fs::write(&codex.join("config.toml"), "model = \"keep-codex\"\n").unwrap();
        let grok_dir = user.join(".grok");
        fs::create_dir_all(&grok_dir).unwrap();
        fs::write(
            grok_dir.join("config.toml"),
            "[models]\ndefault = \"grok-4\"\n[plugins.demo]\nenabled = true\n[marketplace]\norigin = \"keep\"\n[ui]\ntheme = \"dark\"\n[mcp_servers.other]\nurl = \"http://other\"\n[mcp_servers.spellcast]\ncommand = \"npx\"\nargs = [\"-y\", \"old\"]\ntype = \"stdio\"\nenabled = false\n",
        )
        .unwrap();
        let mut p = paths(&user, &codex, &bundle);
        p.cli = None;
        p.skip_path_lookup = true;

        let before = status("grok", None, &p);
        assert_eq!(before.kind, SetupKind::NotInstalled);
        assert!(before.complete_supported);
        assert!(!before.installed);
        assert_ne!(before.kind, SetupKind::MissingCli);

        let installed = install("grok", Some("http://127.0.0.1:47194/mcp"), &p, &PanicCli);
        assert!(installed.complete_supported, "{:?}", installed);
        assert!(installed.installed, "{:?}", installed);
        assert_eq!(installed.kind, SetupKind::Verified, "{:?}", installed);
        assert_eq!(
            installed.mcp_url.as_deref(),
            Some("http://127.0.0.1:47194/mcp")
        );
        assert!(installed.source_path.is_none());
        assert!(installed.cache_path.is_none());
        assert!(installed.marketplace_path.is_none());
        assert!(installed.hook_trust.is_none());

        let text = fs::read_to_string(grok_dir.join("config.toml")).unwrap();
        assert!(text.contains("[models]"));
        assert!(text.contains("[plugins.demo]"));
        assert!(text.contains("[marketplace]"));
        assert!(text.contains("[ui]"));
        assert!(text.contains("[mcp_servers.other]"));
        assert!(text.contains("[mcp_servers.spellcast]"));
        assert!(text.contains("url = \"http://127.0.0.1:47194/mcp\""));
        assert!(text.contains("enabled = true"));
        assert!(!text.contains("args"));
        assert!(!text.contains("type = "));
        // The completion signal is a Stop lifecycle hook file, not a config.toml entry.
        assert!(!text.contains("--grok-notify"), "{text}");
        let hook_text = fs::read_to_string(grok_dir.join("hooks").join("spellcast.json")).unwrap();
        assert!(hook_text.contains("\"Stop\"") && hook_text.contains("--grok-notify"), "{hook_text}");
        assert!(text.contains("theme = \"dark\""));
        assert!(installed.done.iter().any(|d| d.starts_with("完成通知：")), "{:?}", installed.done);
        let notify_helper = if cfg!(windows) { "spellcast-notify.exe" } else { "spellcast-notify" };
        assert!(codex.join("spellcast").join("completions").join(notify_helper).is_file());
        assert_eq!(
            fs::read_to_string(codex.join("config.toml")).unwrap(),
            "model = \"keep-codex\"\n"
        );
        assert!(!codex.join("skills").join("spellcast").join("SKILL.md").exists());
        let skill = grok_dir.join("skills").join("spellcast").join("SKILL.md");
        assert!(skill.is_file(), "{}", skill.display());
        assert_eq!(fs::read_to_string(&skill).unwrap(), configure::SPELLCAST_SKILL);
        assert!(grok_skill_present(&grok_dir.join("skills").join("spellcast")));

        let again = install("grok", Some("http://127.0.0.1:47194/mcp"), &p, &PanicCli);
        assert_eq!(again.kind, SetupKind::Verified);
        assert!(again.note.contains("未重复写入"));
        let _ = fs::remove_dir_all(user);
    }

    #[test]
    fn grok_conflict_endpoint_does_not_overwrite() {
        let user = temp_dir("grok-conflict");
        let bundle = user.join("bundle");
        write_bundle(&bundle, b"HELPER");
        let grok_dir = user.join(".grok");
        fs::create_dir_all(&grok_dir).unwrap();
        fs::write(
            grok_dir.join("config.toml"),
            "[mcp_servers.spellcast]\nenabled = true\nurl = \"http://127.0.0.1:9/mcp\"\n",
        )
        .unwrap();
        let mut p = paths(&user, &user.join(".codex"), &bundle);
        p.cli = None;
        p.skip_path_lookup = true;
        let r = install("grok", Some("http://127.0.0.1:47194/mcp"), &p, &PanicCli);
        assert_eq!(r.kind, SetupKind::ConflictEndpoint, "{:?}", r);
        assert!(!r.installed);
        assert!(r.complete_supported);
        assert_eq!(
            fs::read_to_string(grok_dir.join("config.toml")).unwrap(),
            "[mcp_servers.spellcast]\nenabled = true\nurl = \"http://127.0.0.1:9/mcp\"\n"
        );
        assert!(!grok_dir.join("skills").join("spellcast").join("SKILL.md").exists());
        let _ = fs::remove_dir_all(user);
    }

    #[test]
    fn missing_helper_hash_is_not_nonempty_trust() {
        let user = temp_dir("user");
        let bundle = user.join("bundle");
        write_bundle(&bundle, b"HELPER");
        fs::write(bundle.join("bin").join(helper_name()), b"OTHER").unwrap();
        let r = status("codex", None, &paths(&user, &user.join(".codex"), &bundle));
        assert_eq!(r.kind, SetupKind::MissingResources);
    }

    #[test]
    fn user_home_and_codex_home_are_split() {
        let user = temp_dir("userA");
        let codex = temp_dir("codexB");
        let bundle = user.join("bundle");
        write_bundle(&bundle, b"HELPER");
        let r = install("codex", None, &paths(&user, &codex, &bundle), &ok_cli(&bundle));
        assert!(r.installed, "{:?}", r);
        assert!(source_path(&user).join("bin").join(helper_name()).is_file());
        assert!(!user.join(".codex").join("plugins").exists());
        let ver = plugin_version(&source_path(&user)).unwrap();
        assert!(ver.starts_with("0.3.0+sc."), "{ver}");
        assert!(cache_root(&codex, "personal").join(&ver).is_dir());
        assert!(marketplace_path(&user).is_file());
        assert!(!codex.join(".agents").exists());
    }

    #[test]
    fn isolated_homes_do_not_write_real_profile() {
        let token = format!("setup-sentinel-{}", std::process::id());
        let user = temp_dir("iso-user");
        let codex = temp_dir("iso-codex");
        let bundle = user.join("bundle");
        write_bundle(&bundle, b"HELPER");
        let _ = install("codex", None, &paths(&user, &codex, &bundle), &ok_cli(&bundle));
        let real_user = PathBuf::from(std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")).unwrap());
        assert!(!real_user.join("plugins/spellcast").join(&token).exists());
        if let Ok(real_codex) = crate::completion_hook::codex_home() {
            assert!(!real_codex.join(&token).exists());
        }
    }

    #[test]
    fn marketplace_unknown_source_is_zero_write() {
        let user = temp_dir("user");
        let bundle = user.join("bundle");
        write_bundle(&bundle, b"HELPER");
        let market = marketplace_path(&user);
        fs::create_dir_all(market.parent().unwrap()).unwrap();
        fs::write(
            &market,
            r#"{"name":"personal","plugins":[{"name":"spellcast","source":{"source":"npm","path":"./plugins/spellcast"}}]}"#,
        )
        .unwrap();
        let r = install(
            "codex",
            None,
            &paths(&user, &user.join(".codex"), &bundle),
            &ok_cli(&bundle),
        );
        assert_eq!(r.kind, SetupKind::ConflictCustom, "{:?}", r);
        assert!(!source_path(&user).exists());
        let v = read_json(&market).unwrap();
        assert_eq!(v["plugins"][0]["source"]["source"], "npm");
    }

    #[test]
    fn custom_stop_text_is_conflict() {
        let user = temp_dir("user");
        let bundle = user.join("bundle");
        write_bundle(&bundle, b"HELPER");
        let dest = source_path(&user);
        copy_tree(&bundle, &dest).unwrap();
        fs::write(dest.join("hooks/observer-stop.txt"), b"CUSTOM-STOP").unwrap();
        let r = install(
            "codex",
            None,
            &paths(&user, &user.join(".codex"), &bundle),
            &ok_cli(&bundle),
        );
        assert_eq!(r.kind, SetupKind::ConflictCustom);
        assert_eq!(fs::read(dest.join("hooks/observer-stop.txt")).unwrap(), b"CUSTOM-STOP");
    }

    #[test]
    fn required_file_as_directory_fails() {
        let user = temp_dir("user");
        let bundle = user.join("bundle");
        write_bundle(&bundle, b"HELPER");
        let dest = source_path(&user);
        fs::create_dir_all(dest.join("hooks/hooks.json")).unwrap();
        overlay_keep_extras(&bundle, &dest, None).unwrap_err();
    }

    #[test]
    fn fresh_install_and_idempotent() {
        let user = temp_dir("user");
        let bundle = user.join("bundle");
        write_bundle(&bundle, b"HELPER");
        let p = paths(&user, &user.join(".codex"), &bundle);
        let calls = Arc::new(AtomicUsize::new(0));
        let c = calls.clone();
        let bundle2 = bundle.clone();
        let cli = ScriptCli {
            add: {
                let bundle2 = bundle2.clone();
                let c = c.clone();
                move |_sel: &str, env: &CliEnv| {
                    c.fetch_add(1, Ordering::SeqCst);
                    let (cache, version) =
                        materialize_cache(&bundle2, env, "http://127.0.0.1:47194/mcp");
                    Ok(CliOutcome {
                        status: 0,
                        stdout: json!({"installedPath": cache, "version": version}).to_string(),
                        stderr: String::new(),
                    })
                }
            },
            list: {
                move |_m: &str, env: &CliEnv| {
                    Ok(CliOutcome {
                        status: 0,
                        stdout: list_json(env, true, true, None),
                        stderr: String::new(),
                    })
                }
            },
        };
        let first = install("codex", Some("http://127.0.0.1:47194/mcp"), &p, &cli);
        assert!(first.installed, "{:?}", first);
        assert_eq!(first.kind, SetupKind::InstalledUnverified);
        let second = install("codex", Some("http://127.0.0.1:47194/mcp"), &p, &cli);
        assert!(second.installed, "{:?}", second);
        assert_eq!(second.kind, SetupKind::InstalledUnverified);
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert!(second.done.iter().any(|s| s.contains("跳过 plugin add")));
    }

    #[test]
    fn matching_plugin_still_migrates_legacy_mcp_and_official_skill() {
        let user = temp_dir("legacy-matching-plugin");
        let bundle = user.join("bundle");
        let codex = user.join(".codex");
        write_bundle(&bundle, b"HELPER");
        let p = paths(&user, &codex, &bundle);
        let cli = ok_cli(&bundle);
        assert!(install("codex", None, &p, &cli).installed);
        fs::write(config_path(&codex), "[mcp_servers.spellcast]\nenabled = true\nurl = \"http://127.0.0.1:47194/mcp\"\n\n[mcp_servers.keepme]\nenabled = false\nurl = \"http://127.0.0.1:49999/mcp\"\n").unwrap();
        let skill = standalone_skill_dir(&codex);
        copy_tree(&bundle.join("skills/spellcast"), &skill).unwrap();
        fs::write(skill.join("SKILL.md.before-test"), b"USER BACKUP").unwrap();
        assert!(matching_payload(&p, "http://127.0.0.1:47194/mcp").is_none());
        let migrated = install("codex", None, &p, &cli);
        assert!(migrated.installed, "{migrated:?}");
        assert_eq!(read_legacy(&codex, "http://127.0.0.1:47194/mcp").unwrap(), LegacySpellcast::Absent);
        assert!(fs::read_to_string(config_path(&codex)).unwrap().contains("[mcp_servers.keepme]"));
        assert!(!skill.join("SKILL.md").exists());
        assert_eq!(fs::read(skill.join("SKILL.md.before-test")).unwrap(), b"USER BACKUP");
        let repeated = install("codex", None, &p, &cli);
        assert!(repeated.done.iter().any(|s| s.contains("跳过 plugin add")), "{repeated:?}");
    }

    #[test]
    fn trust_comment_is_not_trusted() {
        let user = temp_dir("user");
        let bundle = user.join("bundle");
        write_bundle(&bundle, b"HELPER");
        let r = install("codex", None, &paths(&user, &user.join(".codex"), &bundle), &ok_cli(&bundle));
        assert_eq!(r.kind, SetupKind::InstalledUnverified);
        fs::create_dir_all(user.join(".codex")).unwrap();
        fs::write(
            user.join(".codex/config.toml"),
            "# [hooks.state.\"spellcast@personal:hooks/hooks.json:session_start:0:0\"]\n# trusted_hash = \"sha256:dead\"\n",
        )
        .unwrap();
        let s = status("codex", None, &paths(&user, &user.join(".codex"), &bundle));
        assert_ne!(s.kind, SetupKind::Verified);
        assert_ne!(s.kind, SetupKind::PendingReload);
    }

    #[test]
    fn merges_matching_standalone_skill_keeps_backup_file() {
        let user = temp_dir("user");
        let codex = user.join(".codex");
        let bundle = user.join("bundle");
        write_bundle(&bundle, b"HELPER");
        let skill = standalone_skill_dir(&codex);
        fs::create_dir_all(skill.join("references")).unwrap();
        fs::write(skill.join("SKILL.md"), b"SKILL").unwrap();
        fs::write(skill.join("references/asides.md"), b"skills/spellcast/references/asides.md").unwrap();
        fs::write(skill.join("references/canvas.md"), b"skills/spellcast/references/canvas.md").unwrap();
        fs::write(skill.join("references/works.md"), b"skills/spellcast/references/works.md").unwrap();
        fs::write(skill.join("references/feedback.md"), b"skills/spellcast/references/feedback.md").unwrap();
        fs::write(skill.join("SKILL.md.before-observer-20260906-173329"), b"OLD").unwrap();
        let r = install("codex", None, &paths(&user, &codex, &bundle), &ok_cli(&bundle));
        assert!(r.installed, "{:?}", r);
        assert!(!skill.join("SKILL.md").exists());
        assert!(skill.join("SKILL.md.before-observer-20260906-173329").exists());
    }

    #[test]
    fn keeps_custom_skill() {
        let user = temp_dir("user");
        let codex = user.join(".codex");
        let bundle = user.join("bundle");
        write_bundle(&bundle, b"HELPER");
        let skill = standalone_skill_dir(&codex);
        fs::create_dir_all(&skill).unwrap();
        fs::write(skill.join("SKILL.md"), b"CUSTOM").unwrap();
        let r = install("codex", None, &paths(&user, &codex, &bundle), &ok_cli(&bundle));
        assert!(r.installed);
        assert_eq!(fs::read(skill.join("SKILL.md")).unwrap(), b"CUSTOM");
    }

    #[test]
    fn conflict_endpoint_does_not_write() {
        let user = temp_dir("user");
        let codex = user.join(".codex");
        let bundle = user.join("bundle");
        write_bundle(&bundle, b"HELPER");
        fs::create_dir_all(&codex).unwrap();
        fs::write(
            config_path(&codex),
            "[mcp_servers.spellcast]\nenabled = true\nurl = \"http://127.0.0.1:9999/mcp\"\n",
        )
        .unwrap();
        let r = install(
            "codex",
            Some("http://127.0.0.1:47194/mcp"),
            &paths(&user, &codex, &bundle),
            &ok_cli(&bundle),
        );
        assert_eq!(r.kind, SetupKind::ConflictEndpoint);
        assert!(!source_path(&user).exists());
    }

    #[test]
    fn other_mcp_server_does_not_affect_spellcast() {
        let user = temp_dir("user");
        let codex = user.join(".codex");
        let bundle = user.join("bundle");
        write_bundle(&bundle, b"HELPER");
        fs::create_dir_all(&codex).unwrap();
        fs::write(
            config_path(&codex),
            "[mcp_servers.other]\nurl = \"http://127.0.0.1:9/mcp\"\n[mcp_servers.spellcast]\nenabled = true\nurl = \"http://127.0.0.1:47194/mcp\"\n",
        )
        .unwrap();
        let r = install("codex", None, &paths(&user, &codex, &bundle), &ok_cli(&bundle));
        assert!(r.installed, "{:?}", r);
        let text = fs::read_to_string(config_path(&codex)).unwrap();
        assert!(text.contains("[mcp_servers.other]"));
        assert!(!text.contains("[mcp_servers.spellcast]"));
    }

    #[test]
    fn extra_spellcast_mcp_fields_are_protected() {
        let user = temp_dir("user");
        let codex = user.join(".codex");
        let bundle = user.join("bundle");
        write_bundle(&bundle, b"HELPER");
        fs::create_dir_all(&codex).unwrap();
        fs::write(
            config_path(&codex),
            "[mcp_servers.spellcast]\nenabled = true\nurl = \"http://127.0.0.1:47194/mcp\"\nenv = \"secret\"\n",
        )
        .unwrap();
        let r = install("codex", None, &paths(&user, &codex, &bundle), &ok_cli(&bundle));
        assert_eq!(r.kind, SetupKind::ConflictEndpoint);
        let text = fs::read_to_string(config_path(&codex)).unwrap();
        assert!(text.contains("env = \"secret\""));
    }

    #[test]
    fn damaged_marketplace_fails_cleanly() {
        let user = temp_dir("user");
        let bundle = user.join("bundle");
        write_bundle(&bundle, b"HELPER");
        let market = marketplace_path(&user);
        fs::create_dir_all(market.parent().unwrap()).unwrap();
        fs::write(&market, "not-json").unwrap();
        let r = install("codex", None, &paths(&user, &user.join(".codex"), &bundle), &ok_cli(&bundle));
        assert_eq!(r.kind, SetupKind::Failed);
        assert_eq!(fs::read_to_string(market).unwrap(), "not-json");
    }

    #[test]
    fn missing_cli() {
        let user = temp_dir("user");
        let bundle = user.join("bundle");
        write_bundle(&bundle, b"HELPER");
        let mut p = paths(&user, &user.join(".codex"), &bundle);
        p.cli = None;
        p.skip_path_lookup = true;
        let r = status("codex", None, &p);
        assert_eq!(r.kind, SetupKind::MissingCli);
    }

    #[test]
    fn cli_failure_restores_old_source() {
        let user = temp_dir("user");
        let bundle = user.join("bundle");
        write_bundle(&bundle, b"HELPER");
        let dest = source_path(&user);
        copy_tree(&bundle, &dest).unwrap();
        fs::write(dest.join("keep-me.txt"), b"EXTRA").unwrap();
        let r = install(
            "codex",
            None,
            &paths(&user, &user.join(".codex"), &bundle),
            &ScriptCli {
                add: |_s: &str, _e: &CliEnv| {
                    Ok(CliOutcome { status: 2, stdout: String::new(), stderr: "nope".into() })
                },
                list: |_m: &str, _e: &CliEnv| unreachable!(),
            },
        );
        assert_eq!(r.kind, SetupKind::Failed);
        assert_eq!(fs::read(dest.join("keep-me.txt")).unwrap(), b"EXTRA");
        assert!(!r.installed);
    }

    #[test]
    fn marketplace_other_entries_kept() {
        let user = temp_dir("user");
        let bundle = user.join("bundle");
        write_bundle(&bundle, b"HELPER");
        let market = marketplace_path(&user);
        fs::create_dir_all(market.parent().unwrap()).unwrap();
        fs::write(
            &market,
            r#"{"name":"personal","plugins":[{"name":"other","source":{"source":"local","path":"./plugins/other"}}]}"#,
        )
        .unwrap();
        let r = install("codex", None, &paths(&user, &user.join(".codex"), &bundle), &ok_cli(&bundle));
        assert!(r.installed, "{:?}", r);
        let v = read_json(&market).unwrap();
        let names: Vec<_> = v["plugins"].as_array().unwrap().iter().map(|p| p["name"].as_str().unwrap()).collect();
        assert!(names.contains(&"other"));
        assert!(names.contains(&"spellcast"));
    }

    #[test]
    fn endpoint_rewrites_both_events_exactly() {
        let user = temp_dir("user");
        let bundle = user.join("bundle");
        write_bundle(&bundle, b"HELPER");
        let cli = ScriptCli {
            add: {
                let bundle = bundle.clone();
                move |_s: &str, env: &CliEnv| {
                    let (cache, version) =
                        materialize_cache(&bundle, env, "http://127.0.0.1:48001/mcp");
                    Ok(CliOutcome {
                        status: 0,
                        stdout: json!({"installedPath": cache, "version": version}).to_string(),
                        stderr: String::new(),
                    })
                }
            },
            list: {
                move |_m: &str, env: &CliEnv| {
                    Ok(CliOutcome {
                        status: 0,
                        stdout: list_json(env, true, true, None),
                        stderr: String::new(),
                    })
                }
            },
        };
        let r = install(
            "codex",
            Some("http://127.0.0.1:48001/mcp"),
            &paths(&user, &user.join(".codex"), &bundle),
            &cli,
        );
        assert!(r.installed, "{:?}", r);
        let hooks = read_json(&source_path(&user).join("hooks/hooks.json")).unwrap();
        expect_hooks_exact(&hooks, "http://127.0.0.1:48001/api/observer/status").unwrap();
        let mcp = read_json(&source_path(&user).join(".mcp.json")).unwrap();
        assert_eq!(mcp, mcp_document("http://127.0.0.1:48001/mcp"));
    }

    #[test]
    fn unicode_and_quote_home_paths() {
        let user = std::env::temp_dir().join(format!("spellcast 接入's {}", std::process::id()));
        let _ = fs::remove_dir_all(&user);
        fs::create_dir_all(&user).unwrap();
        let bundle = user.join("bundle");
        write_bundle(&bundle, b"HELPER");
        let r = install("codex", None, &paths(&user, &user.join(".codex"), &bundle), &ok_cli(&bundle));
        assert!(r.installed, "{:?}", r);
    }

    #[test]
    fn double_click_second_sees_lock() {
        let user = temp_dir("user");
        let bundle = user.join("bundle");
        write_bundle(&bundle, b"HELPER");
        let p = paths(&user, &user.join(".codex"), &bundle);
        let hold = p.lock.lock().unwrap();
        let r = install("codex", None, &p, &ok_cli(&bundle));
        drop(hold);
        assert_eq!(r.kind, SetupKind::Installing);
    }

    #[test]
    fn timeout_kills_owned_process_no_late_write() {
        let user = temp_dir("job");
        let sentinel = user.join("late.txt");
        let env = CliEnv {
            user_home: user.clone(),
            codex_home: user.join(".codex"),
        };
        if cfg!(windows) {
            let child_script = user.join("latechild.cmd");
            let script = user.join("slow.cmd");
            fs::write(
                &child_script,
                format!(
                    "@echo off\r\nping 127.0.0.1 -n 8 >nul\r\necho LATE> \"{}\"\r\n",
                    sentinel.display()
                ),
            )
            .unwrap();
            fs::write(
                &script,
                format!(
                    "@echo off\r\nstart \"\" /b cmd.exe /d /c \"{}\"\r\nping 127.0.0.1 -n 8 >nul\r\n",
                    child_script.display()
                ),
            )
            .unwrap();
            let err = run_owned(
                Path::new("cmd.exe"),
                &["/C", script.to_str().unwrap()],
                &env,
                Duration::from_millis(400),
            );
            assert!(err.is_err(), "{err:?}");
            let again = Instant::now();
            let err2 = run_owned(
                Path::new("cmd.exe"),
                &["/C", "echo second"],
                &env,
                Duration::from_secs(2),
            );
            assert!(err2.is_ok(), "second runner overlapped first: {err2:?}");
            assert!(again.elapsed() < Duration::from_secs(5));
        } else {
            let err = run_owned(
                Path::new("/bin/sh"),
                &["-c", "sleep 8; echo LATE"],
                &env,
                Duration::from_millis(400),
            );
            assert!(err.is_err());
        }
        std::thread::sleep(Duration::from_millis(2500));
        assert!(!sentinel.exists(), "late write after timeout from descendant");
    }

    #[test]
    fn custom_mcp_headers_are_conflict_zero_write() {
        let user = temp_dir("user");
        let bundle = user.join("bundle");
        write_bundle(&bundle, b"HELPER");
        let dest = source_path(&user);
        copy_tree(&bundle, &dest).unwrap();
        let custom = json!({
            "mcpServers": {
                "spellcast": {
                    "type": "http",
                    "url": "http://127.0.0.1:47194/mcp",
                    "headers": { "X-Custom": "keep" }
                }
            }
        });
        fs::write(
            dest.join(".mcp.json"),
            serde_json::to_string_pretty(&custom).unwrap(),
        )
        .unwrap();
        let r = install(
            "codex",
            None,
            &paths(&user, &user.join(".codex"), &bundle),
            &ok_cli(&bundle),
        );
        assert_eq!(r.kind, SetupKind::ConflictCustom, "{:?}", r);
        assert!(!r.installed);
        let kept = read_json(&dest.join(".mcp.json")).unwrap();
        assert_eq!(kept["mcpServers"]["spellcast"]["headers"]["X-Custom"], "keep");
        assert!(!marketplace_path(&user).exists());
    }

    #[test]
    fn plugin_json_extra_field_is_conflict() {
        let user = temp_dir("user");
        let bundle = user.join("bundle");
        write_bundle(&bundle, b"HELPER");
        let dest = source_path(&user);
        copy_tree(&bundle, &dest).unwrap();
        let mut manifest = read_json(&dest.join(".codex-plugin/plugin.json")).unwrap();
        manifest
            .as_object_mut()
            .unwrap()
            .insert("experimental".into(), json!(true));
        fs::write(
            dest.join(".codex-plugin/plugin.json"),
            serde_json::to_string_pretty(&manifest).unwrap(),
        )
        .unwrap();
        let r = install(
            "codex",
            None,
            &paths(&user, &user.join(".codex"), &bundle),
            &ok_cli(&bundle),
        );
        assert_eq!(r.kind, SetupKind::ConflictCustom, "{:?}", r);
        assert_eq!(read_json(&dest.join(".codex-plugin/plugin.json")).unwrap()["experimental"], true);
    }

    #[test]
    fn legacy_inline_table_same_url_is_conflict_custom() {
        let user = temp_dir("user");
        let codex = user.join(".codex");
        let bundle = user.join("bundle");
        write_bundle(&bundle, b"HELPER");
        fs::create_dir_all(&codex).unwrap();
        fs::write(
            config_path(&codex),
            "[mcp_servers]\nspellcast = { enabled = true, url = \"http://127.0.0.1:47194/mcp\", env = \"secret\" }\n",
        )
        .unwrap();
        let r = install("codex", None, &paths(&user, &codex, &bundle), &ok_cli(&bundle));
        assert_eq!(r.kind, SetupKind::ConflictCustom, "{:?}", r);
        let text = fs::read_to_string(config_path(&codex)).unwrap();
        assert!(text.contains("env = \"secret\"") || text.contains("env=\"secret\"") || text.contains("secret"));
        assert!(!source_path(&user).exists());
    }

    #[test]
    fn overlay_nth_file_failure_leaves_existing_source() {
        let user = temp_dir("user");
        let bundle = user.join("bundle");
        write_bundle(&bundle, b"HELPER");
        let dest = source_path(&user);
        copy_tree(&bundle, &dest).unwrap();
        fs::write(dest.join("keep-me.txt"), b"EXTRA").unwrap();
        let original = fs::read(dest.join("hooks/observer-stop.txt")).unwrap();
        let mut p = paths(&user, &user.join(".codex"), &bundle);
        p.fault = Some(FaultInject::OverlayNth(1));
        let r = install("codex", None, &p, &ok_cli(&bundle));
        assert_eq!(r.kind, SetupKind::Failed, "{:?}", r);
        assert_eq!(fs::read(dest.join("keep-me.txt")).unwrap(), b"EXTRA");
        assert_eq!(fs::read(dest.join("hooks/observer-stop.txt")).unwrap(), original);
        assert!(!r.installed);
    }

    #[test]
    fn fingerprint_failure_leaves_existing_source() {
        let user = temp_dir("user");
        let bundle = user.join("bundle");
        write_bundle(&bundle, b"HELPER");
        let dest = source_path(&user);
        copy_tree(&bundle, &dest).unwrap();
        fs::write(dest.join("keep-me.txt"), b"EXTRA").unwrap();
        let mut p = paths(&user, &user.join(".codex"), &bundle);
        p.fault = Some(FaultInject::Fingerprint);
        let r = install("codex", None, &p, &ok_cli(&bundle));
        assert_eq!(r.kind, SetupKind::Failed, "{:?}", r);
        assert_eq!(fs::read(dest.join("keep-me.txt")).unwrap(), b"EXTRA");
        assert!(!sibling_dir(&dest, "spellcast-next").exists());
    }

    #[test]
    fn marketplace_write_failure_retracts_fresh_source() {
        let user = temp_dir("user");
        let bundle = user.join("bundle");
        write_bundle(&bundle, b"HELPER");
        let mut p = paths(&user, &user.join(".codex"), &bundle);
        p.fault = Some(FaultInject::MarketplaceWrite);
        let r = install("codex", None, &p, &ok_cli(&bundle));
        assert_eq!(r.kind, SetupKind::Failed, "{:?}", r);
        assert!(!source_path(&user).exists());
        assert!(!marketplace_path(&user).exists());
    }

    #[test]
    fn marketplace_write_failure_restores_old_source() {
        let user = temp_dir("user");
        let bundle = user.join("bundle");
        write_bundle(&bundle, b"HELPER");
        let dest = source_path(&user);
        copy_tree(&bundle, &dest).unwrap();
        fs::write(dest.join("keep-me.txt"), b"EXTRA").unwrap();
        let mut p = paths(&user, &user.join(".codex"), &bundle);
        p.fault = Some(FaultInject::MarketplaceWrite);
        let r = install("codex", None, &p, &ok_cli(&bundle));
        assert_eq!(r.kind, SetupKind::Failed, "{:?}", r);
        assert_eq!(fs::read(dest.join("keep-me.txt")).unwrap(), b"EXTRA");
        assert!(dest.exists());
    }

    #[test]
    fn concurrent_user_edit_is_partial_not_overwritten() {
        let user = temp_dir("user");
        let bundle = user.join("bundle");
        write_bundle(&bundle, b"HELPER");
        let dest = source_path(&user);
        copy_tree(&bundle, &dest).unwrap();
        let r = install(
            "codex",
            None,
            &paths(&user, &user.join(".codex"), &bundle),
            &ScriptCli {
                add: {
                    let dest = dest.clone();
                    move |_s: &str, _e: &CliEnv| {
                        fs::write(dest.join("hooks/observer-stop.txt"), b"USER").unwrap();
                        Ok(CliOutcome {
                            status: 2,
                            stdout: String::new(),
                            stderr: "nope".into(),
                        })
                    }
                },
                list: |_m: &str, _e: &CliEnv| unreachable!(),
            },
        );
        assert_eq!(r.kind, SetupKind::Failed);
        assert!(r.partial, "{:?}", r);
        assert_eq!(fs::read(dest.join("hooks/observer-stop.txt")).unwrap(), b"USER");
    }

    #[test]
    fn list_failure_does_not_report_verified_payload_as_missing() {
        let user = temp_dir("user");
        let bundle = user.join("bundle");
        write_bundle(&bundle, b"HELPER");
        let p = paths(&user, &user.join(".codex"), &bundle);
        let first = install("codex", None, &p, &ok_cli(&bundle));
        assert!(first.installed, "{:?}", first);
        let blocked = status_with_cli(
            "codex",
            None,
            &p,
            &ScriptCli {
                add: |_s: &str, _e: &CliEnv| unreachable!(),
                list: |_m: &str, _e: &CliEnv| Err("cli down".into()),
            },
        );
        assert_eq!(blocked.kind, SetupKind::PendingReload, "{:?}", blocked);
        assert!(!blocked.installed);
        assert_ne!(blocked.kind, SetupKind::NotInstalled);
        assert!(blocked.not_done.iter().any(|s| s.contains("验证受阻")), "{:?}", blocked);
        let again = install(
            "codex",
            None,
            &p,
            &ScriptCli {
                add: |_s: &str, _e: &CliEnv| panic!("must not plugin add when list fails"),
                list: |_m: &str, _e: &CliEnv| Err("cli down".into()),
            },
        );
        assert_eq!(again.kind, SetupKind::PendingReload);
        assert!(!again.installed);
        assert!(again.not_done.iter().any(|s| s.contains("验证受阻")));
    }

    #[test]
    fn cache_uses_bound_version_not_newest_mtime() {
        let user = temp_dir("user");
        let codex = user.join(".codex");
        let bundle = user.join("bundle");
        write_bundle(&bundle, b"HELPER");
        let p = paths(&user, &codex, &bundle);
        let first = install("codex", None, &p, &ok_cli(&bundle));
        assert!(first.installed, "{:?}", first);
        let newest = cache_root(&codex, "personal").join("9.9.9-newer");
        fs::create_dir_all(&newest).unwrap();
        fs::write(newest.join("junk.txt"), b"nope").unwrap();
        let later = SystemTime::now() + Duration::from_secs(3600);
        let _ = fs::File::open(&newest).and_then(|f| f.set_modified(later));
        let s = status("codex", None, &p);
        assert_eq!(s.kind, SetupKind::InstalledUnverified, "{:?}", s);
        let path = s.cache_path.as_deref().unwrap_or("").replace('\\', "/");
        assert!(path.contains("0.3.0+sc."), "{:?}", s.cache_path);
        assert!(!path.contains("9.9.9-newer"), "{:?}", s.cache_path);
    }

    #[test]
    fn verify_cache_rejects_helper_directory() {
        let user = temp_dir("user");
        let bundle = user.join("bundle");
        write_bundle(&bundle, b"HELPER");
        let cache = user.join("cache");
        copy_tree(&bundle, &cache).unwrap();
        let helper = cache.join("bin").join(helper_name());
        fs::remove_file(&helper).unwrap();
        fs::create_dir_all(&helper).unwrap();
        let err = verify_cache(&cache, &bundle, "http://127.0.0.1:47194/mcp").unwrap_err();
        assert!(err.contains("目录") || err.contains("不是普通文件"), "{err}");
    }

    #[test]
    fn status_after_install_is_not_not_installed() {
        let user = temp_dir("user");
        let bundle = user.join("bundle");
        write_bundle(&bundle, b"HELPER");
        let p = paths(&user, &user.join(".codex"), &bundle);
        assert!(install("codex", None, &p, &ok_cli(&bundle)).installed);
        let s = status("codex", None, &p);
        assert_eq!(s.kind, SetupKind::InstalledUnverified, "{:?}", s);
        assert_ne!(s.kind, SetupKind::NotInstalled);
        assert_ne!(s.kind, SetupKind::Verified);
    }

    #[test]
    fn cli_user_extra_add_modify_delete_is_partial() {
        let user = temp_dir("user");
        let bundle = user.join("bundle");
        write_bundle(&bundle, b"HELPER");
        let dest = source_path(&user);
        copy_tree(&bundle, &dest).unwrap();
        fs::write(dest.join("keep-me.txt"), b"OLD").unwrap();
        let add_extra = dest.clone();
        let r = install(
            "codex",
            None,
            &paths(&user, &user.join(".codex"), &bundle),
            &ScriptCli {
                add: move |_s: &str, _e: &CliEnv| {
                    fs::write(add_extra.join("keep-me.txt"), b"USER").unwrap();
                    fs::write(add_extra.join("new-extra.txt"), b"NEW").unwrap();
                    fs::remove_file(add_extra.join("LICENSE")).ok();
                    Ok(CliOutcome {
                        status: 2,
                        stdout: String::new(),
                        stderr: "nope".into(),
                    })
                },
                list: |_m: &str, _e: &CliEnv| unreachable!(),
            },
        );
        assert_eq!(r.kind, SetupKind::Failed);
        assert!(r.partial, "{:?}", r);
        assert_eq!(fs::read(dest.join("keep-me.txt")).unwrap(), b"USER");
        assert_eq!(fs::read(dest.join("new-extra.txt")).unwrap(), b"NEW");
        assert!(!dest.join("LICENSE").exists());
    }

    #[test]
    fn activate_restore_dual_failure_keeps_backup_and_partial() {
        let user = temp_dir("user");
        let bundle = user.join("bundle");
        write_bundle(&bundle, b"HELPER");
        let dest = source_path(&user);
        copy_tree(&bundle, &dest).unwrap();
        fs::write(dest.join("keep-me.txt"), b"ORIGINAL").unwrap();
        let mut p = paths(&user, &user.join(".codex"), &bundle);
        p.fault = Some(FaultInject::ActivateRestore);
        let r = install("codex", None, &p, &ok_cli(&bundle));
        assert_eq!(r.kind, SetupKind::Failed, "{:?}", r);
        assert!(r.partial, "{:?}", r);
        assert!(r.not_done.iter().any(|s| s.contains("恢复未完成")), "{:?}", r);
        assert!(!r.not_done.iter().any(|s| s.contains("已恢复原插件源")));
        let recoverable = PathBuf::from(r.backup.as_deref().unwrap_or(""));
        assert!(recoverable.exists(), "{:?}", r.backup);
        let kept = walk_files(&recoverable).unwrap();
        let has_original = kept.iter().any(|p| {
            p.file_name().and_then(|n| n.to_str()) == Some("keep-me.txt")
                && fs::read(p).ok().as_deref() == Some(&b"ORIGINAL"[..])
        });
        assert!(has_original, "old content missing from recoverable {:?}", recoverable);
    }

    #[test]
    fn list_missing_disabled_version_mismatch_are_not_complete() {
        let user = temp_dir("user");
        let bundle = user.join("bundle");
        write_bundle(&bundle, b"HELPER");
        let p = paths(&user, &user.join(".codex"), &bundle);
        assert!(install("codex", None, &p, &ok_cli(&bundle)).installed);
        let ver = plugin_version(&source_path(&user)).unwrap();

        let missing = status_with_cli(
            "codex",
            None,
            &p,
            &ScriptCli {
                add: |_s: &str, _e: &CliEnv| panic!("must not plugin add"),
                list: |_m: &str, env: &CliEnv| {
                    Ok(CliOutcome {
                        status: 0,
                        stdout: list_json(env, false, true, None),
                        stderr: String::new(),
                    })
                },
            },
        );
        assert_eq!(missing.kind, SetupKind::NotInstalled, "{:?}", missing);
        assert!(!missing.installed);

        let disabled = status_with_cli(
            "codex",
            None,
            &p,
            &ScriptCli {
                add: |_s: &str, _e: &CliEnv| panic!("must not plugin add"),
                list: |_m: &str, env: &CliEnv| {
                    Ok(CliOutcome {
                        status: 0,
                        stdout: list_json(env, true, false, None),
                        stderr: String::new(),
                    })
                },
            },
        );
        assert_eq!(disabled.kind, SetupKind::PendingReload, "{:?}", disabled);
        assert!(!disabled.installed);
        assert!(disabled.note.contains("未启用"), "{:?}", disabled);

        let mismatch = status_with_cli(
            "codex",
            None,
            &p,
            &ScriptCli {
                add: |_s: &str, _e: &CliEnv| panic!("must not plugin add"),
                list: |_m: &str, env: &CliEnv| {
                    Ok(CliOutcome {
                        status: 0,
                        stdout: list_json(env, true, true, Some("9.9.9")),
                        stderr: String::new(),
                    })
                },
            },
        );
        assert_eq!(mismatch.kind, SetupKind::NotInstalled, "{:?}", mismatch);
        assert!(!mismatch.installed);
        assert!(mismatch.note.contains("不匹配"), "{:?}", mismatch);

        let adds = Arc::new(AtomicUsize::new(0));
        let c = adds.clone();
        let skip = install(
            "codex",
            None,
            &p,
            &ScriptCli {
                add: move |_s: &str, _e: &CliEnv| {
                    c.fetch_add(1, Ordering::SeqCst);
                    panic!("matched active must not add");
                },
                list: {
                    let ver = ver.clone();
                    move |_m: &str, env: &CliEnv| {
                        Ok(CliOutcome {
                            status: 0,
                            stdout: list_json(env, true, true, Some(&ver)),
                            stderr: String::new(),
                        })
                    }
                },
            },
        );
        assert_eq!(skip.kind, SetupKind::InstalledUnverified, "{:?}", skip);
        assert_eq!(adds.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn payload_change_updates_version_same_payload_reuses_cache() {
        let user = temp_dir("user");
        let bundle = user.join("bundle");
        write_bundle(&bundle, b"HELPER");
        let p = paths(&user, &user.join(".codex"), &bundle);
        let reused = Arc::new(AtomicUsize::new(0));
        let adds = Arc::new(AtomicUsize::new(0));
        let r1 = {
            let bundle = bundle.clone();
            let reused = reused.clone();
            let adds = adds.clone();
            install(
                "codex",
                None,
                &p,
                &ScriptCli {
                    add: move |_s: &str, env: &CliEnv| {
                        adds.fetch_add(1, Ordering::SeqCst);
                        let root = cache_root(&env.codex_home, "personal");
                        fs::create_dir_all(&root).unwrap();
                        let tmp = root.join(format!("tmp-{}", adds.load(Ordering::SeqCst)));
                        copy_tree(&bundle, &tmp).unwrap();
                        apply_endpoint(
                            &tmp,
                            "http://127.0.0.1:47194/mcp",
                            "http://127.0.0.1:47194/api/observer/status",
                        )
                        .unwrap();
                        let version = stamp_payload_version(&tmp).unwrap();
                        let cache = root.join(&version);
                        if cache.is_dir() {
                            reused.fetch_add(1, Ordering::SeqCst);
                            fs::remove_dir_all(&tmp).unwrap();
                        } else {
                            fs::rename(&tmp, &cache).unwrap();
                        }
                        Ok(CliOutcome {
                            status: 0,
                            stdout: json!({"version": version}).to_string(),
                            stderr: String::new(),
                        })
                    },
                    list: |_m: &str, env: &CliEnv| {
                        Ok(CliOutcome {
                            status: 0,
                            stdout: list_json(env, true, true, None),
                            stderr: String::new(),
                        })
                    },
                },
            )
        };
        assert!(r1.installed, "{:?}", r1);
        let v1 = plugin_version(&source_path(&user)).unwrap();
        let skip = install("codex", None, &p, &ok_cli(&bundle));
        assert_eq!(skip.kind, SetupKind::InstalledUnverified);
        assert_eq!(plugin_version(&source_path(&user)).unwrap(), v1);

        let reused_before = reused.load(Ordering::SeqCst);
        let lists = Arc::new(AtomicUsize::new(0));
        let r_reuse = install(
            "codex",
            None,
            &p,
            &ScriptCli {
                add: {
                    let bundle = bundle.clone();
                    let reused = reused.clone();
                    let adds = adds.clone();
                    move |_s: &str, env: &CliEnv| {
                        adds.fetch_add(1, Ordering::SeqCst);
                        let root = cache_root(&env.codex_home, "personal");
                        let tmp = root.join(format!("tmp-re{}", adds.load(Ordering::SeqCst)));
                        copy_tree(&bundle, &tmp).unwrap();
                        apply_endpoint(
                            &tmp,
                            "http://127.0.0.1:47194/mcp",
                            "http://127.0.0.1:47194/api/observer/status",
                        )
                        .unwrap();
                        let version = stamp_payload_version(&tmp).unwrap();
                        let cache = root.join(&version);
                        if cache.is_dir() {
                            reused.fetch_add(1, Ordering::SeqCst);
                            fs::remove_dir_all(&tmp).unwrap();
                        } else {
                            fs::rename(&tmp, &cache).unwrap();
                        }
                        Ok(CliOutcome {
                            status: 0,
                            stdout: json!({"version": version}).to_string(),
                            stderr: String::new(),
                        })
                    }
                },
                list: {
                    let lists = lists.clone();
                    move |_m: &str, env: &CliEnv| {
                        let n = lists.fetch_add(1, Ordering::SeqCst);
                        let installed = n >= 2;
                        Ok(CliOutcome {
                            status: 0,
                            stdout: list_json(env, installed, installed, None),
                            stderr: String::new(),
                        })
                    }
                },
            },
        );
        assert!(r_reuse.installed, "{:?}", r_reuse);
        assert_eq!(plugin_version(&source_path(&user)).unwrap(), v1);
        assert!(
            reused.load(Ordering::SeqCst) > reused_before,
            "same payload+endpoint must reuse cache dir"
        );

        let r2 = install(
            "codex",
            Some("http://127.0.0.1:48001/mcp"),
            &p,
            &ScriptCli {
                add: {
                    let bundle = bundle.clone();
                    move |_s: &str, env: &CliEnv| {
                        let (cache, version) =
                            materialize_cache(&bundle, env, "http://127.0.0.1:48001/mcp");
                        Ok(CliOutcome {
                            status: 0,
                            stdout: json!({"installedPath": cache, "version": version}).to_string(),
                            stderr: String::new(),
                        })
                    }
                },
                list: |_m: &str, env: &CliEnv| {
                    Ok(CliOutcome {
                        status: 0,
                        stdout: list_json(env, true, true, None),
                        stderr: String::new(),
                    })
                },
            },
        );
        assert!(r2.installed, "{:?}", r2);
        let v2 = plugin_version(&source_path(&user)).unwrap();
        assert_ne!(v1, v2, "endpoint change must mint a new stable version");
        assert!(v2.starts_with("0.3.0+sc."));
        assert!(cache_root(&user.join(".codex"), "personal").join(&v2).is_dir());
        assert!(cache_root(&user.join(".codex"), "personal").join(&v1).is_dir());
    }

    #[cfg(windows)]
    #[test]
    fn skip_resume_reaps_suspended_child() {
        let user = temp_dir("job");
        let sentinel = user.join("late.txt");
        let env = CliEnv {
            user_home: user.clone(),
            codex_home: user.join(".codex"),
        };
        let script = user.join("slow.cmd");
        fs::write(
            &script,
            format!(
                "@echo off\r\necho LATE> \"{}\"\r\nping 127.0.0.1 -n 5 >nul\r\n",
                sentinel.display()
            ),
        )
        .unwrap();
        RUN_OWNED_FAULT.set(JOB_FAULT_SKIP_RESUME);
        let err = run_owned(
            Path::new("cmd.exe"),
            &["/C", script.to_str().unwrap()],
            &env,
            Duration::from_secs(2),
        );
        RUN_OWNED_FAULT.set(JOB_FAULT_NONE);
        assert!(err.is_err(), "{err:?}");
        let msg = err.unwrap_err();
        assert!(
            msg.contains("收束") || msg.contains("ActiveProcesses") || msg.contains("跳过 ResumeThread"),
            "{msg}"
        );
        std::thread::sleep(Duration::from_millis(800));
        assert!(!sentinel.exists(), "suspended child wrote after failed resume");
    }

    #[cfg(windows)]
    #[test]
    fn terminate_failure_does_not_claim_tree_dead() {
        let user = temp_dir("job");
        let sentinel = user.join("late.txt");
        let env = CliEnv {
            user_home: user.clone(),
            codex_home: user.join(".codex"),
        };
        let child_script = user.join("latechild.cmd");
        let script = user.join("slow.cmd");
        fs::write(
            &child_script,
            format!(
                "@echo off\r\nping 127.0.0.1 -n 8 >nul\r\necho LATE> \"{}\"\r\n",
                sentinel.display()
            ),
        )
        .unwrap();
        fs::write(
            &script,
            format!(
                "@echo off\r\nstart \"\" /b cmd.exe /d /c \"{}\"\r\nping 127.0.0.1 -n 8 >nul\r\n",
                child_script.display()
            ),
        )
        .unwrap();
        RUN_OWNED_FAULT.set(JOB_FAULT_TERMINATE);
        let err = run_owned(
            Path::new("cmd.exe"),
            &["/C", script.to_str().unwrap()],
            &env,
            Duration::from_millis(400),
        );
        RUN_OWNED_FAULT.set(JOB_FAULT_NONE);
        assert!(err.is_err(), "{err:?}");
        let msg = err.unwrap_err();
        assert!(msg.contains("不从退出码推断") || msg.contains("TerminateJobObject"), "{msg}");
        assert!(!msg.contains("已终止本次 Job 内进程树"));
    }

    // Nested libtest spawn of this Tauri --lib binary is Windows-CI proven.
    // macOS children link AppKit/WebKit and never write the lock-ready file.
    #[cfg(windows)]
    #[test]
    fn two_processes_contend_same_profile() {
        if std::env::var_os("SPELLCAST_SETUP_LOCK_CHILD").is_some() {
            let user = PathBuf::from(std::env::var("SPELLCAST_SETUP_USER").unwrap());
            let codex = PathBuf::from(std::env::var("SPELLCAST_SETUP_CODEX").unwrap());
            let bundle = PathBuf::from(std::env::var("SPELLCAST_SETUP_BUNDLE").unwrap());
            let _ = install(
                "codex",
                None,
                &paths(&user, &codex, &bundle),
                &ScriptCli {
                    add: |_s: &str, _e: &CliEnv| {
                        std::thread::sleep(Duration::from_secs(3));
                        Ok(CliOutcome {
                            status: 2,
                            stdout: String::new(),
                            stderr: "held".into(),
                        })
                    },
                    list: |_m: &str, env: &CliEnv| {
                        Ok(CliOutcome {
                            status: 0,
                            stdout: list_json(env, false, false, None),
                            stderr: String::new(),
                        })
                    },
                },
            );
            std::process::exit(0);
        }
        let user = temp_dir("lock-user");
        let codex = temp_dir("lock-codex");
        let bundle = user.join("bundle");
        write_bundle(&bundle, b"HELPER");
        let ready = user.join("ready.txt");
        let exe = std::env::current_exe().unwrap();
        let mut child = Command::new(&exe)
            .args([
                "complete_setup::tests::two_processes_contend_same_profile",
                "--exact",
            ])
            .env("SPELLCAST_SETUP_LOCK_CHILD", "1")
            .env("SPELLCAST_SETUP_USER", &user)
            .env("SPELLCAST_SETUP_CODEX", &codex)
            .env("SPELLCAST_SETUP_BUNDLE", &bundle)
            .env("SPELLCAST_SETUP_LOCK_READY", &ready)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let start = Instant::now();
        while !ready.exists() && start.elapsed() < Duration::from_secs(15) {
            std::thread::sleep(Duration::from_millis(50));
        }
        assert!(ready.exists(), "child did not acquire lock");
        let busy = install("codex", None, &paths(&user, &codex, &bundle), &ok_cli(&bundle));
        assert_eq!(busy.kind, SetupKind::Installing, "{:?}", busy);
        let status = child.wait().unwrap();
        assert!(status.success(), "{status:?}");
        let after = install("codex", None, &paths(&user, &codex, &bundle), &ok_cli(&bundle));
        assert!(after.installed || after.kind == SetupKind::Failed, "{:?}", after);
        let mut locker = Command::new(&exe)
            .args([
                "complete_setup::tests::two_processes_contend_same_profile",
                "--exact",
            ])
            .env("SPELLCAST_SETUP_LOCK_CHILD", "1")
            .env("SPELLCAST_SETUP_USER", &user)
            .env("SPELLCAST_SETUP_CODEX", &codex)
            .env("SPELLCAST_SETUP_BUNDLE", &bundle)
            .env("SPELLCAST_SETUP_LOCK_READY", user.join("ready2.txt"))
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let start = Instant::now();
        while !user.join("ready2.txt").exists() && start.elapsed() < Duration::from_secs(15) {
            std::thread::sleep(Duration::from_millis(50));
        }
        let _ = locker.kill();
        let _ = locker.wait();
        let recovered = install("codex", None, &paths(&user, &codex, &bundle), &ok_cli(&bundle));
        assert_ne!(recovered.kind, SetupKind::Installing, "{:?}", recovered);
    }

    #[test]
    fn native_codex_skips_ps1_wrapper() {
        let dir = temp_dir("cli");
        fs::write(dir.join("codex.ps1"), b"wrapper").unwrap();
        fs::write(dir.join("codex.cmd"), b"wrapper").unwrap();
        let vendor = dir.join(
            "node_modules/@openai/codex/node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin",
        );
        fs::create_dir_all(&vendor).unwrap();
        fs::write(vendor.join("codex.exe"), b"native").unwrap();
        let got = native_codex_near(&dir).expect("vendor exe");
        assert_eq!(got, vendor.join("codex.exe"));
        assert!(is_windows_cli_wrapper(&dir.join("codex.ps1")));
        assert!(!is_windows_cli_wrapper(&got));
    }

    fn native_plugin_entry(
        path: &str,
        installed: bool,
        enabled: bool,
        version: &str,
        source_kind: Option<&str>,
    ) -> Value {
        let mut source = serde_json::Map::new();
        if let Some(kind) = source_kind {
            source.insert("source".into(), json!(kind));
        }
        source.insert("path".into(), json!(path));
        json!({
            "pluginId": "spellcast@personal",
            "name": "spellcast",
            "marketplaceName": "personal",
            "version": version,
            "installed": installed,
            "enabled": enabled,
            "source": Value::Object(source),
            "installPolicy": "AVAILABLE",
            "authPolicy": "ON_INSTALL"
        })
    }

    fn native_envelope(installed: Vec<Value>, available: Vec<Value>) -> String {
        json!({ "installed": installed, "available": available }).to_string()
    }

    fn parse_list(
        stdout: &str,
        user_home: &Path,
        expected_version: Option<&str>,
    ) -> Result<PluginListState, String> {
        inspect_plugin_list(stdout, "personal", SOURCE_REL, user_home, expected_version)
    }

    #[test]
    fn inspect_native_installed_absolute_is_active() {
        let user = temp_dir("cli-abs-user");
        let expected = source_path(&user);
        fs::create_dir_all(&expected).unwrap();
        let path = expected.to_string_lossy().into_owned();
        let stdout = native_envelope(
            vec![native_plugin_entry(&path, true, true, "0.3.0", Some("local"))],
            vec![],
        );
        let got = parse_list(&stdout, &user, Some("0.3.0")).unwrap();
        assert!(
            matches!(got, PluginListState::Active { ref version, .. } if version == "0.3.0"),
            "{got:?}"
        );
    }

    #[test]
    fn inspect_native_available_only_is_missing() {
        let user = temp_dir("cli-avail-user");
        let expected = source_path(&user);
        fs::create_dir_all(&expected).unwrap();
        let path = expected.to_string_lossy().into_owned();
        let available_only = json!({
            "available": [native_plugin_entry(&path, false, false, "0.3.0", Some("local"))]
        })
        .to_string();
        assert!(matches!(
            parse_list(&available_only, &user, Some("0.3.0")).unwrap(),
            PluginListState::Missing
        ));
        let empty_installed = native_envelope(
            vec![],
            vec![native_plugin_entry(&path, false, false, "0.3.0", Some("local"))],
        );
        assert!(matches!(
            parse_list(&empty_installed, &user, Some("0.3.0")).unwrap(),
            PluginListState::Missing
        ));
    }

    #[test]
    fn inspect_native_wrong_profile_or_escape_is_rejected() {
        let user = temp_dir("cli-home-a");
        let expected = source_path(&user);
        fs::create_dir_all(&expected).unwrap();
        let other = temp_dir("cli-home-b");
        let other_src = source_path(&other);
        fs::create_dir_all(&other_src).unwrap();
        let suffix = other.join("decoy").join("plugins").join("spellcast");
        fs::create_dir_all(&suffix).unwrap();
        let sibling = user.join("plugins").join("other");
        fs::create_dir_all(&sibling).unwrap();
        let escaped = expected.join("..").join("spellcast");
        fs::create_dir_all(&escaped).unwrap();

        for bad in [
            other_src.to_string_lossy().into_owned(),
            suffix.to_string_lossy().into_owned(),
            sibling.to_string_lossy().into_owned(),
            escaped.to_string_lossy().into_owned(),
            ".plugins/spellcast".into(),
            ".../plugins/spellcast".into(),
            " ./plugins/spellcast ".into(),
        ] {
            let stdout = native_envelope(
                vec![native_plugin_entry(&bad, true, true, "0.3.0", Some("local"))],
                vec![],
            );
            let err = parse_list(&stdout, &user, Some("0.3.0")).unwrap_err();
            assert!(
                err.contains("source.path") || err.contains("自定义"),
                "accepted {bad}: {err}"
            );
        }
    }

    #[test]
    fn inspect_malformed_list_is_error_not_missing() {
        let user = temp_dir("cli-bad-user");
        let expected = source_path(&user);
        fs::create_dir_all(&expected).unwrap();
        let path = expected.to_string_lossy().into_owned();
        for raw in [
            "not-json",
            "null",
            "{\"foo\":1}",
            "{\"installed\":\"yes\"}",
            "{\"installed\":{}}",
            "{\"plugins\":\"nope\"}",
            "{\"installed\":[null]}",
            "{\"installed\":[{}]}",
            "{\"installed\":[{\"name\":\"spellcast\",\"marketplaceName\":\"personal\"}]}",
        ] {
            let err = parse_list(raw, &user, None).expect_err(raw);
            assert!(
                !err.is_empty() && !err.contains("Missing"),
                "{raw} => {err}"
            );
        }
        assert!(matches!(
            parse_list("[]", &user, None).unwrap(),
            PluginListState::Missing
        ));
        let illegal_entry = native_envelope(
            vec![json!({
                "name": "spellcast",
                "marketplaceName": "personal",
                "installed": "yes",
                "enabled": true,
                "version": "0.3.0",
                "source": { "source": "local", "path": path }
            })],
            vec![],
        );
        parse_list(&illegal_entry, &user, Some("0.3.0")).unwrap_err();
        let remote = native_envelope(
            vec![native_plugin_entry(&path, true, true, "0.3.0", Some("npm"))],
            vec![],
        );
        let err = parse_list(&remote, &user, Some("0.3.0")).unwrap_err();
        assert!(err.contains("npm"), "{err}");
    }

    #[test]
    fn inspect_native_disabled_and_version_mismatch() {
        let user = temp_dir("cli-state-user");
        let expected = source_path(&user);
        fs::create_dir_all(&expected).unwrap();
        let path = expected.to_string_lossy().into_owned();
        let disabled = native_envelope(
            vec![native_plugin_entry(&path, true, false, "0.3.0", Some("local"))],
            vec![],
        );
        assert!(matches!(
            parse_list(&disabled, &user, Some("0.3.0")).unwrap(),
            PluginListState::Disabled { .. }
        ));
        let mismatch = native_envelope(
            vec![native_plugin_entry(&path, true, true, "9.9.9", Some("local"))],
            vec![],
        );
        assert!(matches!(
            parse_list(&mismatch, &user, Some("0.3.0")).unwrap(),
            PluginListState::VersionMismatch { ref found } if found == "9.9.9"
        ));
    }

    #[test]
    fn inspect_legacy_shapes_and_relative_source_still_work() {
        let user = temp_dir("cli-legacy-user");
        let rel_dot = native_plugin_entry("./plugins/spellcast", true, true, "0.3.0", None);
        let rel = native_plugin_entry("plugins/spellcast", true, true, "0.3.0", Some("local"));
        assert!(matches!(
            parse_list(&json!([rel_dot]).to_string(), &user, Some("0.3.0")).unwrap(),
            PluginListState::Active { .. }
        ));
        assert!(matches!(
            parse_list(&json!({ "plugins": [rel] }).to_string(), &user, Some("0.3.0")).unwrap(),
            PluginListState::Active { .. }
        ));
        assert!(matches!(
            parse_list(
                &native_plugin_entry("./plugins/spellcast", true, true, "0.3.0", Some("local"))
                    .to_string(),
                &user,
                Some("0.3.0")
            )
            .unwrap(),
            PluginListState::Active { .. }
        ));
    }
}

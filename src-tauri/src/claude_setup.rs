//! Claude Code's native plugin setup. The official CLI owns its native registry
//! and enablement; Spellcast owns only the exported, self-contained payload.

use std::collections::BTreeSet;
use std::fs::{self, OpenOptions};
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use fs2::FileExt;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::complete_setup::{self, CliOutcome, SetupComponents, SetupKind, SetupReport};

#[path = "claude_ccgui.rs"]
mod ccgui;

const MARKET: &str = "spellcast-local";
const SELECTOR: &str = "spellcast@spellcast-local";
const OWNER: &str = "spellcast-desktop-claude-v1";
const MARKER: &str = ".spellcast-managed.json";
const PLUGIN_FILES: &[&str] = &[
    ".claude-plugin/plugin.json",
    ".mcp.json",
    "LICENSE",
    "package-meta.json",
    "hooks/hooks.json",
    "hooks/observer-bootstrap.txt",
    "hooks/observer-stop.txt",
    "hooks/claude-observer-runner.mjs",
    "skills/spellcast/SKILL.md",
    "skills/spellcast/references/asides.md",
    "skills/spellcast/references/canvas.md",
    "skills/spellcast/references/feedback.md",
    "skills/spellcast/references/project-records.md",
    "skills/spellcast/references/sigil.md",
    "skills/spellcast/references/works.md",
    "skills/spellcast/scripts/project-api.mjs",
];
const GUI_FILES: &[&str] = &["manifest.json", "main.js", "README.md", "package-meta.json"];

#[derive(Clone)]
pub struct ClaudePaths {
    pub user_home: PathBuf,
    pub claude_home: PathBuf,
    pub resource_root: PathBuf,
    pub ccgui_resource_root: PathBuf,
    /// CC GUI's data home (`~/.ccgui-next`); absent when CC GUI is not installed.
    pub ccgui_home: PathBuf,
    /// This machine's host-link key, used to pre-pair the CC GUI plugin. Never reported.
    pub host_link_key: Option<String>,
    pub cli: Option<PathBuf>,
    pub cli_timeout: Duration,
    pub lock: Arc<Mutex<()>>,
}

impl ClaudePaths {
    fn root(&self) -> PathBuf {
        self.user_home.join(".spellcast/integrations/claude")
    }
    fn marketplace(&self) -> PathBuf {
        self.root().join("marketplace")
    }
    fn source(&self) -> PathBuf {
        self.marketplace().join("plugins/spellcast")
    }
    fn gui(&self) -> PathBuf {
        self.root().join("ccgui-spellcast")
    }
    fn registry(&self) -> PathBuf {
        self.claude_home.join("plugins/known_marketplaces.json")
    }
}

pub fn default_paths(user_home: PathBuf, resources: &Path) -> ClaudePaths {
    static LOCK: OnceLock<Arc<Mutex<()>>> = OnceLock::new();
    let locate = |name: &str| {
        [resources.join(name), resources.join("resources").join(name)]
            .into_iter()
            .find(|p| p.join("integrity.json").is_file())
            .unwrap_or_else(|| resources.join(name))
    };
    let claude_home = std::env::var_os("CLAUDE_CONFIG_DIR")
        .filter(|p| !p.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| user_home.join(".claude"));
    let cli = find_cli(&user_home);
    ClaudePaths {
        ccgui_home: user_home.join(".ccgui-next"),
        host_link_key: None,
        user_home,
        claude_home,
        resource_root: locate("claude-plugin"),
        ccgui_resource_root: locate("ccgui-spellcast"),
        cli,
        cli_timeout: Duration::from_secs(45),
        lock: LOCK.get_or_init(|| Arc::new(Mutex::new(()))).clone(),
    }
}

fn find_cli(home: &Path) -> Option<PathBuf> {
    let name = if cfg!(windows) {
        "claude.exe"
    } else {
        "claude"
    };
    let native = home.join(".local/bin").join(name);
    if native.is_file() {
        return Some(native);
    }
    std::env::var_os("PATH").and_then(|path| {
        std::env::split_paths(&path)
            .map(|p| p.join(name))
            .find(|p| p.is_file())
    })
}

pub trait ClaudeCli: Send + Sync {
    fn run(&self, args: &[&str], paths: &ClaudePaths) -> Result<CliOutcome, String>;
}

struct ProcessCli;
impl ClaudeCli for ProcessCli {
    fn run(&self, args: &[&str], paths: &ClaudePaths) -> Result<CliOutcome, String> {
        let cli = paths
            .cli
            .as_ref()
            .ok_or("未找到 Claude Code CLI（claude）。")?;
        complete_setup::run_claude_owned(
            cli,
            args,
            &paths.user_home,
            &paths.claude_home,
            paths.cli_timeout,
        )
    }
}

#[derive(Clone)]
struct Payload {
    version: String,
    mcp: String,
}

fn read_json(path: &Path) -> Result<Value, String> {
    no_links(path)?;
    let text = fs::read_to_string(path).map_err(|_| format!("无法读取 {}。", path.display()))?;
    serde_json::from_str(text.strip_prefix('\u{feff}').unwrap_or(&text))
        .map_err(|_| format!("{} 不是有效 JSON。", path.display()))
}

fn write_json(path: &Path, value: &Value) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let mut bytes = serde_json::to_vec_pretty(value).map_err(|e| e.to_string())?;
    bytes.push(b'\n');
    fs::write(path, bytes).map_err(|e| e.to_string())
}

fn digest(path: &Path) -> Result<String, String> {
    fs::read(path)
        .map(|b| format!("{:x}", Sha256::digest(b)))
        .map_err(|_| format!("无法读取资源 {}。", path.display()))
}

fn no_links(path: &Path) -> Result<(), String> {
    for p in path.ancestors() {
        // System-owned macOS aliases must not reject every temporary HOME.
        #[cfg(unix)]
        if matches!(p.to_str(), Some("/var" | "/tmp" | "/private")) {
            break;
        }
        if let Ok(meta) = fs::symlink_metadata(p) {
            let mut linked = meta.file_type().is_symlink();
            #[cfg(windows)]
            {
                use std::os::windows::fs::MetadataExt;
                linked |= meta.file_attributes() & 0x400 != 0;
            }
            if linked {
                return Err(format!("拒绝符号链接或重解析点：{}。", p.display()));
            }
        }
    }
    Ok(())
}

fn relative_ok(rel: &str) -> bool {
    !rel.contains('\\')
        && Path::new(rel)
            .components()
            .all(|p| matches!(p, Component::Normal(_)))
}

fn expected_plugin_files() -> Vec<String> {
    PLUGIN_FILES
        .iter()
        .map(|p| p.to_string())
        .chain(std::iter::once(format!(
            "bin/{}",
            complete_setup::helper_name()
        )))
        .collect()
}

fn file_inventory(root: &Path, at: &Path, files: &mut BTreeSet<String>) -> Result<(), String> {
    no_links(at)?;
    for item in fs::read_dir(at).map_err(|_| format!("无法读取插件目录 {}。", at.display()))?
    {
        let path = item.map_err(|e| e.to_string())?.path();
        no_links(&path)?;
        let meta = fs::symlink_metadata(&path).map_err(|e| e.to_string())?;
        if meta.is_dir() {
            file_inventory(root, &path, files)?;
        } else if meta.is_file() {
            let rel = path
                .strip_prefix(root)
                .map_err(|e| e.to_string())?
                .to_string_lossy()
                .replace('\\', "/");
            files.insert(rel);
        } else {
            return Err("插件目录包含非普通文件。".into());
        }
    }
    Ok(())
}

fn check_integrity(root: &Path, expected: &[String]) -> Result<(), String> {
    no_links(root)?;
    let integrity = read_json(&root.join("integrity.json"))?;
    if integrity["algorithm"] != "sha256" {
        return Err("插件完整性算法必须是 sha256。".into());
    }
    let hashes = integrity["files"]
        .as_object()
        .ok_or("插件完整性清单缺少 files。")?;
    let want: BTreeSet<_> = expected.iter().cloned().collect();
    let got: BTreeSet<_> = hashes.keys().cloned().collect();
    if got != want || got.iter().any(|p| !relative_ok(p)) {
        return Err("插件完整性清单与正式资源列表不一致。".into());
    }
    let mut actual = BTreeSet::new();
    file_inventory(root, root, &mut actual)?;
    let mut allowed = want;
    allowed.insert("integrity.json".into());
    if actual != allowed {
        return Err("插件目录包含缺失或自定义文件。".into());
    }
    for rel in expected {
        if hashes[rel].as_str() != Some(digest(&root.join(rel))?.as_str()) {
            return Err(format!("插件资源完整性校验失败：{rel}。"));
        }
    }
    Ok(())
}

fn check_payload(root: &Path) -> Result<Payload, String> {
    check_integrity(root, &expected_plugin_files())?;
    let manifest = read_json(&root.join(".claude-plugin/plugin.json"))?;
    if manifest["name"] != "spellcast" {
        return Err("Claude 插件名称不是 spellcast。".into());
    }
    let version = manifest["version"]
        .as_str()
        .filter(|s| {
            !s.is_empty()
                && s.bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b".-+".contains(&b))
        })
        .ok_or("Claude 插件版本无效。")?
        .to_owned();
    let meta = read_json(&root.join("package-meta.json"))?;
    if meta["host"] != "claude" || meta["name"] != "spellcast" || meta["version"] != version {
        return Err("Claude 插件包元数据不匹配。".into());
    }
    let mcp = read_json(&root.join(".mcp.json"))?;
    let servers = mcp["mcpServers"]
        .as_object()
        .ok_or("缺少 Claude MCP 配置。")?;
    let server = servers
        .get("spellcast")
        .ok_or("Claude MCP 配置缺少 spellcast。")?;
    if servers.len() != 1
        || server["type"] != "http"
        || server.as_object().map(|o| o.len()) != Some(2)
    {
        return Err("Claude MCP 配置包含自定义组件。".into());
    }
    let endpoint = server["url"].as_str().ok_or("缺少 MCP 地址。")?;
    let endpoint = complete_setup::validate_loopback_mcp_url(endpoint)?;
    let hooks = read_json(&root.join("hooks/hooks.json"))?;
    let events = hooks["hooks"]
        .as_object()
        .ok_or("缺少 Claude 原生 hooks。")?;
    if events.len() != 2 {
        return Err("Claude hooks 包含自定义事件。".into());
    }
    let status = complete_setup::status_url_for_mcp(&endpoint)?;
    for name in ["SessionStart", "UserPromptSubmit"] {
        let groups = events
            .get(name)
            .and_then(Value::as_array)
            .ok_or("缺少 Claude 生命周期 hook。")?;
        if groups.len() != 1 {
            return Err("Claude hook 组无效。".into());
        }
        if name == "SessionStart" && groups[0]["matcher"] != "startup|resume|clear|compact" {
            return Err("Claude SessionStart 匹配器无效。".into());
        }
        let commands = groups[0]["hooks"]
            .as_array()
            .ok_or("缺少 Claude hook 命令。")?;
        let command = format!(
            "${{CLAUDE_PLUGIN_ROOT}}/bin/{}",
            complete_setup::helper_name()
        );
        if commands.len() != 1
            || commands[0]["type"] != "command"
            || commands[0]["command"] != command
            || commands[0]["args"] != json!(["--host", "claude", "--endpoint", status])
            || commands[0]["timeout"] != 2
        {
            return Err("Claude hooks 必须使用原生 Claude 身份和同一回环地址。".into());
        }
    }
    if !fs::read_to_string(root.join("skills/spellcast/SKILL.md"))
        .map_err(|e| e.to_string())?
        .contains("name: spellcast")
    {
        return Err("Claude Skill 元数据无效。".into());
    }
    Ok(Payload {
        version,
        mcp: endpoint,
    })
}

fn check_gui(root: &Path) -> Result<(), String> {
    check_integrity(
        root,
        &GUI_FILES.iter().map(|p| p.to_string()).collect::<Vec<_>>(),
    )?;
    let manifest = read_json(&root.join("manifest.json"))?;
    if manifest["id"] != "spellcast-canvas-bridge"
        || manifest["tier"] != "js"
        || manifest["version"].as_str().is_none()
    {
        return Err("CC GUI 插件清单无效。".into());
    }
    gui_endpoint(root)?;
    Ok(())
}

fn gui_endpoint(root: &Path) -> Result<String, String> {
    let manifest = read_json(&root.join("manifest.json"))?;
    let script = fs::read_to_string(root.join("main.js")).map_err(|e| e.to_string())?;
    let marker = "const base = '";
    if script.matches(marker).count() != 1 {
        return Err("CC GUI 插件连接地址声明无效。".into());
    }
    let base = script
        .split_once(marker)
        .and_then(|(_, tail)| tail.split_once("';").map(|(url, _)| url))
        .ok_or("CC GUI 插件连接地址声明无效。")?;
    let endpoint = complete_setup::validate_loopback_mcp_url(&format!("{base}/mcp"))?;
    if endpoint.strip_suffix("/mcp") != Some(base) {
        return Err("CC GUI 插件必须使用明确的 IPv4 回环地址。".into());
    }
    let port = base.rsplit_once(':').ok_or("CC GUI 插件缺少端口。")?.1;
    let permissions = manifest["permissions"]
        .as_array()
        .ok_or("CC GUI 插件缺少权限声明。")?;
    let network: Vec<_> = permissions
        .iter()
        .filter_map(Value::as_str)
        .filter(|p| p.starts_with("network:"))
        .collect();
    if network != [format!("network:127.0.0.1:{port}").as_str()] {
        return Err("CC GUI 网络权限必须精确匹配连接地址和单个回环端口。".into());
    }
    Ok(endpoint)
}

fn desired_gui_contents(root: &Path, mcp: &str) -> Result<Vec<(String, Vec<u8>)>, String> {
    let mut files: Vec<_> = GUI_FILES
        .iter()
        .map(|p| fs::read(root.join(p)).map(|b| (p.to_string(), b)))
        .collect::<Result<_, _>>()
        .map_err(|e| e.to_string())?;
    if mcp == "http://127.0.0.1:47194/mcp" {
        return Ok(files);
    }
    if gui_endpoint(root)? != "http://127.0.0.1:47194/mcp" {
        return Err("随包 CC GUI 插件的默认连接地址不是正式默认端口。".into());
    }
    let base = mcp.strip_suffix("/mcp").ok_or("MCP 地址缺少 /mcp。")?;
    let port = base.rsplit_once(':').ok_or("MCP 地址缺少端口。")?.1;
    for (name, bytes) in &mut files {
        if name == "main.js" {
            let script = std::str::from_utf8(bytes).map_err(|e| e.to_string())?;
            let old = "const base = 'http://127.0.0.1:47194';";
            if script.matches(old).count() != 1 {
                return Err("CC GUI 固定连接地址无法安全替换。".into());
            }
            *bytes = script
                .replacen(old, &format!("const base = '{base}';"), 1)
                .into_bytes();
        } else if name == "manifest.json" {
            let mut manifest: Value = serde_json::from_slice(bytes).map_err(|e| e.to_string())?;
            let permissions = manifest["permissions"]
                .as_array_mut()
                .ok_or("CC GUI 插件缺少权限声明。")?;
            let grant = permissions
                .iter_mut()
                .find(|p| **p == "network:127.0.0.1:47194")
                .ok_or("CC GUI 缺少精确默认端口权限。")?;
            *grant = json!(format!("network:127.0.0.1:{port}"));
            *bytes = serde_json::to_vec_pretty(&manifest).map_err(|e| e.to_string())?;
            bytes.push(b'\n');
        }
    }
    Ok(files)
}

/// The exact bundle CC GUI should hold, with an integrity record over it.
fn ccgui_files(paths: &ClaudePaths, mcp: &str) -> Result<Vec<(String, Vec<u8>)>, String> {
    let mut files = desired_gui_contents(&paths.ccgui_resource_root, mcp)?;
    let hashes: serde_json::Map<String, Value> = files
        .iter()
        .map(|(rel, bytes)| (rel.clone(), json!(format!("{:x}", Sha256::digest(bytes)))))
        .collect();
    let mut integrity = serde_json::to_vec_pretty(&json!({"algorithm":"sha256", "files":hashes}))
        .map_err(|e| e.to_string())?;
    integrity.push(b'\n');
    files.push(("integrity.json".into(), integrity));
    Ok(files)
}

fn ccgui_state(paths: &ClaudePaths, mcp: &str) -> ccgui::State {
    match ccgui_files(paths, mcp) {
        Ok(files) => ccgui::inspect(&paths.ccgui_home, &files, paths.host_link_key.as_deref()),
        Err(_) => ccgui::State {
            detected: ccgui::detected(&paths.ccgui_home),
            ..Default::default()
        },
    }
}

fn gui_current(paths: &ClaudePaths, mcp: &str) -> bool {
    desired_gui_contents(&paths.ccgui_resource_root, mcp).is_ok_and(|files| {
        files.into_iter().all(|(rel, expected)| {
            fs::read(paths.gui().join(rel)).is_ok_and(|have| have == expected)
        })
    })
}

fn marketplace_doc() -> Value {
    json!({"name": MARKET, "owner": {"name": "Spellcast desktop"}, "plugins": [
        {"name": "spellcast", "source": "./plugins/spellcast", "description": "Spellcast native Claude integration"}
    ]})
}

fn check_marketplace(root: &Path) -> Result<(), String> {
    no_links(root)?;
    let doc = read_json(&root.join(".claude-plugin/marketplace.json"))?;
    if doc["name"] != MARKET
        || doc["plugins"].as_array().map(Vec::len) != Some(1)
        || doc["plugins"][0]["name"] != "spellcast"
        || doc["plugins"][0]["source"] != "./plugins/spellcast"
    {
        return Err("spellcast-local marketplace 包含自定义来源或其他插件。".into());
    }
    let mut got = BTreeSet::new();
    file_inventory(root, root, &mut got)?;
    if got
        .iter()
        .any(|p| p != ".claude-plugin/marketplace.json" && !p.starts_with("plugins/spellcast/"))
    {
        return Err("spellcast-local marketplace 包含自定义文件。".into());
    }
    check_payload(&root.join("plugins/spellcast"))?;
    Ok(())
}

fn same_path(a: &Path, b: &Path) -> bool {
    fn norm(p: &Path) -> String {
        let s = p
            .to_string_lossy()
            .replace('\\', "/")
            .trim_end_matches('/')
            .to_owned();
        if cfg!(windows) {
            s.to_lowercase()
        } else {
            s
        }
    }
    norm(a) == norm(b)
}

fn known_test_market(path: &Path) -> bool {
    path.to_string_lossy()
        .replace('\\', "/")
        .trim_end_matches('/')
        .ends_with("/artifacts/ccgui-compat/claude-marketplace")
}

fn registered_source(paths: &ClaudePaths) -> Result<Option<PathBuf>, String> {
    let registry = paths.registry();
    no_links(&registry)?;
    if !registry.exists() {
        return Ok(None);
    }
    let doc = read_json(&registry)?;
    if doc.as_object().is_none() {
        return Err("Claude marketplace 注册表格式无效。".into());
    }
    let Some(entry) = doc.get(MARKET) else {
        return Ok(None);
    };
    if entry["source"]["source"] != "directory" {
        return Err("spellcast-local 已注册为自定义 marketplace 来源。".into());
    }
    let source = entry["source"]["path"]
        .as_str()
        .ok_or("spellcast-local 未记录本地来源。")?;
    let source = PathBuf::from(source);
    if !same_path(&source, &paths.marketplace()) && !known_test_market(&source) {
        return Err(
            "spellcast-local 指向自定义目录；请先在 Claude 的插件管理器中处理来源冲突。".into(),
        );
    }
    check_marketplace(&source)?;
    Ok(Some(source))
}

fn check_owned_root(paths: &ClaudePaths) -> Result<(), String> {
    let root = paths.root();
    no_links(&root)?;
    if !root.exists() {
        return Ok(());
    }
    if read_json(&root.join(MARKER))?["owner"] != OWNER {
        return Err("稳定导出目录已有非 Spellcast 管理的内容。".into());
    }
    for entry in fs::read_dir(&root).map_err(|e| e.to_string())? {
        let name = entry.map_err(|e| e.to_string())?.file_name();
        if !["marketplace", "ccgui-spellcast", MARKER]
            .iter()
            .any(|n| name == *n)
        {
            return Err("稳定导出目录包含自定义内容。".into());
        }
    }
    check_marketplace(&paths.marketplace())?;
    check_gui(&paths.gui())?;
    if gui_endpoint(&paths.gui())? != check_payload(&paths.source())?.mcp {
        return Err("稳定导出的 Claude 和 CC GUI 插件使用不同连接地址。".into());
    }
    Ok(())
}

fn target(url: Option<&str>) -> Result<String, String> {
    complete_setup::validate_loopback_mcp_url(
        url.map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or("http://127.0.0.1:47194/mcp"),
    )
}

fn locate(mut report: SetupReport, paths: &ClaudePaths, mcp: &str) -> SetupReport {
    report.source_path = Some(paths.source().to_string_lossy().into_owned());
    report.marketplace_path = Some(
        paths
            .marketplace()
            .join(".claude-plugin/marketplace.json")
            .to_string_lossy()
            .into_owned(),
    );
    report.mcp_url = Some(mcp.into());
    report.runtime_verified = Some(false);
    if check_gui(&paths.gui()).is_ok() {
        report.ccgui_plugin_path = Some(paths.gui().to_string_lossy().into_owned());
    }
    let ccgui = ccgui_state(paths, mcp);
    report.ccgui_detected = Some(ccgui.detected);
    if ccgui.detected {
        report.ccgui_plugin_current = Some(ccgui.plugin_current);
        report.ccgui_paired = Some(ccgui.paired);
    }
    report
}

fn push_ccgui_lines(r: &mut SetupReport) {
    match (r.ccgui_detected, r.ccgui_plugin_current, r.ccgui_paired) {
        (Some(true), Some(true), Some(true)) => r
            .done
            .push("CC GUI 会话插件已部署、启用并配对；CC GUI 加载插件后会自动连接打开的 Claude 聊天。".into()),
        (Some(true), _, _) => r
            .not_done
            .push("CC GUI 会话插件尚未部署或配对；执行 Claude 接入即可自动完成。".into()),
        _ => r
            .not_done
            .push("未检测到 CC GUI；如需在 CC GUI 中接收画布回发，安装并启动 CC GUI 后重新执行接入。".into()),
    }
}

fn report(kind: SetupKind, note: &str, paths: &ClaudePaths, mcp: &str) -> SetupReport {
    locate(claude_report(kind, note), paths, mcp)
}

fn claude_report(kind: SetupKind, note: &str) -> SetupReport {
    let mut r = SetupReport::base("claude-code", kind, note);
    r.complete_supported = true;
    r.runtime_verified = Some(false);
    r
}

fn conflict(kind: SetupKind, note: &str, paths: &ClaudePaths, mcp: &str) -> SetupReport {
    let mut r = report(kind, note, paths, mcp);
    r.conflicts.push(note.into());
    r.not_done.push("原生插件和现有设置尚未更改。".into());
    r
}

fn cli_call(
    cli: &dyn ClaudeCli,
    paths: &ClaudePaths,
    args: &[&str],
    phase: &str,
) -> Result<CliOutcome, String> {
    let output = cli.run(args, paths).map_err(|_| {
        format!("Claude Code CLI {phase}未完成；请检查 CLI 是否可启动或操作是否超时。")
    })?;
    if output.status != 0 {
        // Native output may contain environment or credentials. Never echo it to UI.
        return Err(format!("Claude Code CLI {phase}失败（退出码 {}）；请在 Claude 插件管理器中检查错误或待确认操作。", output.status));
    }
    Ok(output)
}

fn native_list(cli: &dyn ClaudeCli, paths: &ClaudePaths) -> Result<Vec<Value>, String> {
    let output = cli_call(cli, paths, &["plugin", "list", "--json"], "状态查询")?;
    let value: Value = serde_json::from_str(output.stdout.trim())
        .map_err(|_| "Claude CLI 没有返回有效的插件 JSON。")?;
    value
        .as_array()
        .cloned()
        .ok_or_else(|| "Claude CLI 插件列表格式不受支持。".into())
}

struct Inspection {
    bundled: Payload,
    registered: Option<PathBuf>,
    native: Option<Value>,
}

fn inspect(paths: &ClaudePaths, cli: &dyn ClaudeCli, mcp: &str) -> Result<Inspection, SetupReport> {
    let bundled = check_payload(&paths.resource_root)
        .and_then(|p| {
            check_gui(&paths.ccgui_resource_root)?;
            Ok(p)
        })
        .map_err(|e| {
            report(
                SetupKind::MissingResources,
                &format!("随包 Claude/CC GUI 资源不可用：{e}"),
                paths,
                mcp,
            )
        })?;
    if paths.cli.is_none() {
        return Err(report(
            SetupKind::MissingCli,
            "未找到 Claude Code CLI（claude）；安装官方 CLI 后重新检查。",
            paths,
            mcp,
        ));
    }
    check_owned_root(paths).map_err(|e| conflict(SetupKind::ConflictCustom, &e, paths, mcp))?;
    let registered = registered_source(paths)
        .map_err(|e| conflict(SetupKind::ConflictCustom, &e, paths, mcp))?;
    if let Some(source) = &registered {
        let payload = check_payload(&source.join("plugins/spellcast"))
            .map_err(|e| conflict(SetupKind::ConflictCustom, &e, paths, mcp))?;
        if payload.mcp != mcp {
            return Err(conflict(
                SetupKind::ConflictEndpoint,
                "现有 Claude Spellcast 来源使用其他 MCP 地址；请先处理地址冲突。",
                paths,
                mcp,
            ));
        }
    }
    let list = native_list(cli, paths).map_err(|e| report(SetupKind::Failed, &e, paths, mcp))?;
    if list.iter().any(|p| {
        p["id"]
            .as_str()
            .is_some_and(|id| id.starts_with("spellcast@") && id != SELECTOR)
    }) {
        return Err(conflict(
            SetupKind::ConflictCustom,
            "Claude 已安装其他来源的 spellcast 插件；请先在原生插件管理器中处理。",
            paths,
            mcp,
        ));
    }
    let rows: Vec<_> = list
        .into_iter()
        .filter(|p| p["id"] == SELECTOR && p["scope"] == "user")
        .collect();
    if rows.len() > 1 {
        return Err(conflict(
            SetupKind::ConflictCustom,
            "Claude 存在重复的用户级 Spellcast 安装记录。",
            paths,
            mcp,
        ));
    }
    let native = rows.into_iter().next();
    if let Some(row) = &native {
        let cache = row["installPath"].as_str().ok_or_else(|| {
            report(
                SetupKind::Failed,
                "Claude 安装记录缺少缓存路径。",
                paths,
                mcp,
            )
        })?;
        let cache = PathBuf::from(cache);
        let expected = paths
            .claude_home
            .join("plugins/cache")
            .join(MARKET)
            .join("spellcast");
        let version = row["version"]
            .as_str()
            .ok_or_else(|| report(SetupKind::Failed, "Claude 安装记录缺少版本。", paths, mcp))?;
        if !same_path(cache.parent().unwrap_or(Path::new("")), &expected)
            || cache.file_name().and_then(|p| p.to_str()) != Some(version)
        {
            return Err(conflict(
                SetupKind::ConflictCustom,
                "Claude Spellcast 缓存路径不是该用户的原生插件缓存。",
                paths,
                mcp,
            ));
        }
        let payload = check_payload(&cache).map_err(|e| {
            conflict(
                SetupKind::ConflictCustom,
                &format!("Claude 插件缓存不可验证：{e}"),
                paths,
                mcp,
            )
        })?;
        if payload.version != version {
            return Err(conflict(
                SetupKind::ConflictCustom,
                "Claude 缓存版本与安装记录不一致。",
                paths,
                mcp,
            ));
        }
        if payload.mcp != mcp
            || row
                .get("mcpServers")
                .and_then(|m| m.get("spellcast"))
                .and_then(|s| s.get("url"))
                .and_then(Value::as_str)
                .is_some_and(|url| {
                    complete_setup::validate_loopback_mcp_url(url)
                        .ok()
                        .as_deref()
                        != Some(mcp)
                })
        {
            return Err(conflict(
                SetupKind::ConflictEndpoint,
                "现有 Claude Spellcast 缓存使用其他 MCP 地址；请先处理地址冲突。",
                paths,
                mcp,
            ));
        }
        if registered.is_none() {
            return Err(conflict(
                SetupKind::ConflictCustom,
                "Claude Spellcast 安装记录没有可验证的 marketplace 来源。",
                paths,
                mcp,
            ));
        }
        if row["enabled"].as_bool().is_none() {
            return Err(report(
                SetupKind::Failed,
                "Claude 安装记录没有明确的启用状态。",
                paths,
                mcp,
            ));
        }
    }
    Ok(Inspection {
        bundled,
        registered,
        native,
    })
}

fn managed_file_current(root: &Path, bundled: &Path, relative: &str) -> bool {
    if relative == "package-meta.json" {
        let (Ok(mut actual), Ok(mut expected)) =
            (read_json(&root.join(relative)), read_json(&bundled.join(relative)))
        else {
            return false;
        };
        let (Some(actual), Some(expected)) = (actual.as_object_mut(), expected.as_object_mut()) else {
            return false;
        };
        // Packaging provenance changes on every build. It does not change the
        // installed Skill, helper, compatibility requirements, or runtime files.
        actual.remove("built_at");
        expected.remove("built_at");
        return actual == expected;
    }
    matches!((digest(&root.join(relative)), digest(&bundled.join(relative))), (Ok(actual), Ok(expected)) if actual == expected)
}

fn payload_current(root: &Path, bundled: &Path) -> bool {
    // Endpoint overlay is validated separately; only build provenance is inert.
    expected_plugin_files()
        .iter()
        .filter(|p| !matches!(p.as_str(), ".mcp.json" | "hooks/hooks.json"))
        .all(|p| managed_file_current(root, bundled, p))
}

fn skill_current(root: &Path, bundled: &Path) -> bool {
    expected_plugin_files()
        .iter()
        .filter(|p| p.starts_with("skills/spellcast/"))
        .all(|p| managed_file_current(root, bundled, p))
}

fn status_inspected(paths: &ClaudePaths, mcp: &str, inspection: &Inspection) -> SetupReport {
    let Some(native) = &inspection.native else {
        let mut r = report(
            SetupKind::NotInstalled,
            "尚未安装 Claude Code 原生 Spellcast 插件。",
            paths,
            mcp,
        );
        r.plugin_version = Some(inspection.bundled.version.clone());
        r.plugin_enabled = Some(false);
        r.components = Some(SetupComponents {
            mcp: false,
            skill: false,
            skill_current: false,
            hooks: false,
        });
        push_ccgui_lines(&mut r);
        return r;
    };
    let enabled = native["enabled"].as_bool().unwrap_or(false);
    let cache = PathBuf::from(native["installPath"].as_str().unwrap_or_default());
    let stable = inspection
        .registered
        .as_ref()
        .is_some_and(|p| same_path(p, &paths.marketplace()));
    let current = payload_current(&cache, &paths.resource_root)
        && stable
        && payload_current(&paths.source(), &paths.resource_root);
    let note = if !enabled {
        "Claude 原生插件已安装但已停用；执行完整接入可通过官方 CLI 启用。"
    } else if !stable {
        "原生插件仍使用受管理的测试来源；执行完整接入将迁移到用户目录。"
    } else if !current {
        "原生插件已安装；随包资源已有更新，请执行完整接入。"
    } else {
        "Claude 原生插件已启用；当前会话的 MCP、Skill、hooks 加载情况尚未验证，请重载 Claude 会话并检查 CC GUI 连接。"
    };
    let mut r = report(SetupKind::InstalledUnverified, note, paths, mcp);
    r.installed = true;
    r.cache_path = Some(cache.to_string_lossy().into_owned());
    r.plugin_version = native["version"].as_str().map(str::to_owned);
    r.plugin_enabled = Some(enabled);
    r.plugin_resources_current = Some(current);
    r.native_reload_required = Some(true);
    r.components = Some(SetupComponents {
        mcp: enabled,
        skill: enabled,
        skill_current: skill_current(&cache, &paths.resource_root),
        hooks: enabled,
    });
    r.done
        .push("原生 CLI 安装记录、缓存清单、回环地址和 Claude hooks 已检查。".into());
    r.not_done
        .push("当前 Claude 会话加载状态和 Hook 信任尚未验证。".into());
    push_ccgui_lines(&mut r);
    r
}

pub fn status(url: Option<&str>, paths: &ClaudePaths) -> SetupReport {
    status_with_cli(url, paths, &ProcessCli)
}

pub fn ccgui_plugin_path(paths: &ClaudePaths) -> Result<PathBuf, String> {
    if !paths.user_home.is_absolute() {
        return Err("用户目录必须是绝对路径。".into());
    }
    check_owned_root(paths)?;
    let folder = paths.gui();
    no_links(&folder)?;
    check_gui(&folder)?;
    Ok(folder)
}

pub fn status_with_cli(url: Option<&str>, paths: &ClaudePaths, cli: &dyn ClaudeCli) -> SetupReport {
    let mcp = match target(url) {
        Ok(v) => v,
        Err(e) => return claude_report(SetupKind::Failed, &e),
    };
    match inspect(paths, cli, &mcp) {
        Ok(state) => status_inspected(paths, &mcp, &state),
        Err(report) => report,
    }
}

fn copy_payload(from: &Path, to: &Path, files: &[String]) -> Result<(), String> {
    fs::create_dir_all(to).map_err(|e| e.to_string())?;
    for rel in files
        .iter()
        .map(String::as_str)
        .chain(std::iter::once("integrity.json"))
    {
        let dest = to.join(rel);
        if let Some(parent) = dest.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        fs::copy(from.join(rel), &dest).map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn write_integrity(root: &Path) -> Result<(), String> {
    let files: serde_json::Map<String, Value> = expected_plugin_files()
        .into_iter()
        .map(|p| digest(&root.join(&p)).map(|h| (p, json!(h))))
        .collect::<Result<_, _>>()?;
    write_json(
        &root.join("integrity.json"),
        &json!({"algorithm":"sha256", "files":files}),
    )
}

fn stage(paths: &ClaudePaths, stage: &Path, mcp: &str) -> Result<(), String> {
    let plugin = stage.join("marketplace/plugins/spellcast");
    copy_payload(&paths.resource_root, &plugin, &expected_plugin_files())?;
    write_json(
        &plugin.join(".mcp.json"),
        &complete_setup::mcp_document(mcp),
    )?;
    let mut hooks = read_json(&plugin.join("hooks/hooks.json"))?;
    let endpoint = complete_setup::status_url_for_mcp(mcp)?;
    for event in ["SessionStart", "UserPromptSubmit"] {
        hooks["hooks"][event][0]["hooks"][0]["args"][3] = json!(endpoint);
    }
    write_json(&plugin.join("hooks/hooks.json"), &hooks)?;
    write_integrity(&plugin)?;
    write_json(
        &stage.join("marketplace/.claude-plugin/marketplace.json"),
        &marketplace_doc(),
    )?;
    copy_payload(
        &paths.ccgui_resource_root,
        &stage.join("ccgui-spellcast"),
        &GUI_FILES.iter().map(|p| p.to_string()).collect::<Vec<_>>(),
    )?;
    if mcp != "http://127.0.0.1:47194/mcp" {
        let gui = stage.join("ccgui-spellcast");
        for (rel, bytes) in desired_gui_contents(&paths.ccgui_resource_root, mcp)? {
            // Only the fixed base literal and its exact network grant differ.
            if matches!(rel.as_str(), "main.js" | "manifest.json") {
                fs::write(gui.join(rel), bytes).map_err(|e| e.to_string())?;
            }
        }
        let hashes: serde_json::Map<String, Value> = GUI_FILES
            .iter()
            .map(|p| digest(&gui.join(p)).map(|h| (p.to_string(), json!(h))))
            .collect::<Result<_, _>>()?;
        write_json(
            &gui.join("integrity.json"),
            &json!({"algorithm":"sha256", "files":hashes}),
        )?;
    }
    write_json(
        &stage.join(MARKER),
        &json!({"owner":OWNER, "schema":1, "mcp_url":mcp}),
    )?;
    check_marketplace(&stage.join("marketplace"))?;
    check_gui(&stage.join("ccgui-spellcast"))?;
    Ok(())
}

fn backup_legacy(paths: &ClaudePaths, source: &Path) -> Result<PathBuf, String> {
    let backup = paths
        .root()
        .parent()
        .ok_or("导出目录没有父路径。")?
        .join(format!("claude-legacy-backup-{}", uuid::Uuid::new_v4()));
    let result = (|| {
        copy_payload(
            &source.join("plugins/spellcast"),
            &backup.join("plugins/spellcast"),
            &expected_plugin_files(),
        )?;
        write_json(
            &backup.join(".claude-plugin/marketplace.json"),
            &read_json(&source.join(".claude-plugin/marketplace.json"))?,
        )?;
        check_marketplace(&backup)
    })();
    match result {
        Ok(()) => Ok(backup),
        Err(e) => Err(format!("备份旧 marketplace 失败：{e}")),
    }
}

pub fn install(url: Option<&str>, paths: &ClaudePaths) -> SetupReport {
    install_with_cli(url, paths, &ProcessCli)
}

pub fn install_with_cli(
    url: Option<&str>,
    paths: &ClaudePaths,
    cli: &dyn ClaudeCli,
) -> SetupReport {
    let mcp = match target(url) {
        Ok(v) => v,
        Err(e) => return claude_report(SetupKind::Failed, &e),
    };
    let _guard = match paths.lock.try_lock() {
        Ok(v) => v,
        Err(_) => {
            return report(
                SetupKind::Installing,
                "另一个 Claude 接入任务正在执行。",
                paths,
                &mcp,
            )
        }
    };
    if let Err(r) = inspect(paths, cli, &mcp) {
        return r;
    }
    let parent = paths.root().parent().unwrap().to_path_buf();
    if let Err(e) =
        no_links(&parent).and_then(|_| fs::create_dir_all(&parent).map_err(|e| e.to_string()))
    {
        return report(SetupKind::Failed, &e, paths, &mcp);
    }
    let lock_path = parent.join("claude-setup.lock");
    if let Err(e) = no_links(&lock_path) {
        return report(SetupKind::ConflictCustom, &e, paths, &mcp);
    }
    let lock = match OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(&lock_path)
    {
        Ok(v) => v,
        Err(_) => {
            return report(
                SetupKind::Failed,
                "无法打开 Claude 接入任务锁。",
                paths,
                &mcp,
            )
        }
    };
    if lock.try_lock_exclusive().is_err() {
        return report(
            SetupKind::Installing,
            "另一个进程正在执行 Claude 接入。",
            paths,
            &mcp,
        );
    }
    // Recheck after the OS lock: do not overwrite a source changed by another task.
    let initial = match inspect(paths, cli, &mcp) {
        Ok(v) => v,
        Err(r) => return r,
    };
    let already_current = initial
        .native
        .as_ref()
        .is_some_and(|r| r["enabled"] == true)
        && initial
            .registered
            .as_ref()
            .is_some_and(|p| same_path(p, &paths.marketplace()))
        && payload_current(&paths.source(), &paths.resource_root)
        && gui_current(paths, &mcp)
        && ccgui_state(paths, &mcp).ready()
        && initial
            .native
            .as_ref()
            .and_then(|r| r["installPath"].as_str())
            .is_some_and(|p| payload_current(Path::new(p), &paths.resource_root));
    if already_current {
        return status_inspected(paths, &mcp, &initial);
    }
    let migration = initial
        .registered
        .as_ref()
        .filter(|p| !same_path(p, &paths.marketplace()));
    let mut backup: Option<PathBuf> = None;
    if let Some(old) = migration {
        match backup_legacy(paths, old) {
            Ok(p) => backup = Some(p),
            Err(e) => return report(SetupKind::Failed, &e, paths, &mcp),
        }
    }
    let stage_path = parent.join(format!("claude-stage-{}", uuid::Uuid::new_v4()));
    if let Err(e) = stage(paths, &stage_path, &mcp) {
        let _ = fs::remove_dir_all(&stage_path);
        return report(
            SetupKind::Failed,
            &format!("准备 Claude 稳定资源失败：{e}"),
            paths,
            &mcp,
        );
    }
    let root = paths.root();
    if root.exists() {
        let previous = parent.join(format!("claude-backup-{}", uuid::Uuid::new_v4()));
        if let Err(e) = fs::rename(&root, &previous) {
            let _ = fs::remove_dir_all(&stage_path);
            return report(
                SetupKind::Failed,
                &format!("备份稳定目录失败：{e}"),
                paths,
                &mcp,
            );
        }
        backup = Some(previous.clone());
        if let Err(e) = fs::rename(&stage_path, &root) {
            let restored = fs::rename(&previous, &root).is_ok();
            let mut r = report(
                SetupKind::Failed,
                &format!(
                    "提交稳定资源失败：{e}；恢复原目录{}。",
                    if restored { "成功" } else { "失败" }
                ),
                paths,
                &mcp,
            );
            r.backup = Some(previous.to_string_lossy().into_owned());
            r.partial = !restored;
            return r;
        }
    } else if let Err(e) = fs::rename(&stage_path, &root) {
        let _ = fs::remove_dir_all(&stage_path);
        return report(
            SetupKind::Failed,
            &format!("提交稳定资源失败：{e}"),
            paths,
            &mcp,
        );
    }
    let mut done = vec!["Claude 原生插件和 CC GUI 薄插件已导出到稳定用户目录并验证完整性。".into()];
    let result: Result<(), String> = (|| {
        if migration.is_some() {
            cli_call(
                cli,
                paths,
                &["plugin", "marketplace", "remove", MARKET, "--scope", "user"],
                "移除受管理的旧来源",
            )?;
            done.push("受管理的旧测试 marketplace 已由官方 CLI 移除；原目录已备份。".into());
        }
        if initial.registered.is_none() || migration.is_some() {
            let path = paths.marketplace().to_string_lossy().into_owned();
            cli_call(
                cli,
                paths,
                &["plugin", "marketplace", "add", &path, "--scope", "user"],
                "注册本地 marketplace",
            )?;
            done.push("稳定本地 marketplace 已由官方 CLI 注册。".into());
        }
        let before_install = native_list(cli, paths)?;
        if !before_install
            .iter()
            .any(|p| p["id"] == SELECTOR && p["scope"] == "user")
        {
            cli_call(
                cli,
                paths,
                &["plugin", "install", SELECTOR, "--scope", "user", "--json"],
                "安装 Spellcast",
            )?;
        } else {
            // The official CLI may keep a same-version cache. The subsequent
            // resource check, including meaningful metadata, remains authoritative.
            cli_call(
                cli,
                paths,
                &["plugin", "update", SELECTOR, "--scope", "user", "--json"],
                "更新 Spellcast",
            )?;
        }
        done.push("Spellcast 已通过官方 Claude 插件命令安装或更新。".into());
        let after = native_list(cli, paths)?;
        if after
            .iter()
            .any(|p| p["id"] == SELECTOR && p["scope"] == "user" && p["enabled"] == false)
        {
            cli_call(
                cli,
                paths,
                &["plugin", "enable", SELECTOR, "--scope", "user", "--json"],
                "启用 Spellcast",
            )?;
            done.push("用户级 Spellcast 已由官方 CLI 启用。".into());
        }
        Ok(())
    })();
    // CC GUI is independent of the Claude CLI steps: its plugin starts turns in CC GUI chats.
    let ccgui_detected = ccgui::detected(&paths.ccgui_home);
    let ccgui_result = ccgui_detected.then(|| {
        ccgui_files(paths, &mcp)
            .and_then(|files| ccgui::deploy(&paths.ccgui_home, &files, paths.host_link_key.as_deref()))
    });
    let mut r = status_with_cli(Some(&mcp), paths, cli);
    r.backup = backup.map(|p| p.to_string_lossy().into_owned());
    if let Some(Ok(steps)) = &ccgui_result {
        done.extend(steps.iter().cloned());
    }
    r.done.splice(0..0, done);
    let ccgui_error = match &ccgui_result {
        Some(Err(e)) => Some(format!("CC GUI 会话插件未完成：{e}")),
        _ => None,
    };
    if let Err(e) = result {
        r.kind = SetupKind::Failed;
        r.partial = true;
        r.note = e;
        r.not_done
            .push("部分步骤未完成；已保留稳定资源及备份，可在原生插件管理器处理后重试。".into());
        r.not_done.extend(ccgui_error);
    } else if let Some(e) = ccgui_error {
        r.kind = SetupKind::Failed;
        r.partial = true;
        r.note = e;
    } else if !r.installed
        || r.plugin_enabled != Some(true)
        || r.plugin_resources_current != Some(true)
        || r.components.as_ref().is_none_or(|p| !p.skill_current)
        || !gui_current(paths, &mcp)
        || (ccgui_detected && !(r.ccgui_plugin_current == Some(true) && r.ccgui_paired == Some(true)))
    {
        r.kind = SetupKind::Failed;
        r.partial = true;
        r.note =
            "安装命令已返回，但原生来源、启用状态、缓存资源或 CC GUI 会话插件复查未通过；未确认完整接入。".into();
    } else {
        r.kind = SetupKind::PendingReload;
        r.note = if ccgui_detected {
            "Claude 原生 MCP、Skill、hooks 已安装并启用，CC GUI 会话插件已部署并自动配对。请重新打开 Claude 会话；CC GUI 需要重启，或在它的插件页把「Spellcast 会话回发」关一下再打开，才会加载新插件。".into()
        } else {
            "Claude 原生 MCP、Skill、hooks 已安装并启用，请重新打开 Claude 会话。未检测到 CC GUI，所以没有部署 CC GUI 会话插件。".into()
        };
        r.native_reload_required = Some(true);
    }
    r
}

#[cfg(test)]
#[path = "claude_setup_tests.rs"]
mod tests;

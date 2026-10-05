use super::*;

struct Fixture {
    root: PathBuf,
    paths: ClaudePaths,
    cli: MockCli,
}
impl Fixture {
    fn new() -> Self {
        let root =
            std::env::temp_dir().join(format!("spellcast-claude-setup-{}", uuid::Uuid::new_v4()));
        let home = root.join("home");
        fs::create_dir_all(&home).unwrap();
        let plugin = root.join("resources/claude-plugin");
        make_payload(&plugin, "0.1.0", "http://127.0.0.1:47194/mcp");
        let gui = root.join("resources/ccgui-spellcast");
        make_gui(&gui);
        let paths = ClaudePaths {
            user_home: home.clone(),
            claude_home: home.join(".claude"),
            resource_root: plugin,
            ccgui_resource_root: gui,
            ccgui_home: home.join(".ccgui-next"),
            host_link_key: Some("ab".repeat(32)),
            cli: Some(root.join("mock-claude.exe")),
            cli_timeout: Duration::from_secs(1),
            lock: Arc::new(Mutex::new(())),
        };
        write_json(&paths.claude_home.join("settings.json"), &json!({
            "model":"sonnet", "effortLevel":"xhigh", "permissions":{"defaultMode":"auto"},
            "env":{"HTTPS_PROXY":"http://127.0.0.1:7897"}, "enabledPlugins":{"other@other":true},
            "hooks":{"UserPromptSubmit":[{"hooks":[{"type":"command","command":"unrelated-hook"}]}]}
        })).unwrap();
        fs::write(
            home.join("native-auth-sentinel.json"),
            b"auth-must-not-change",
        )
        .unwrap();
        fs::create_dir_all(home.join(".codex")).unwrap();
        fs::write(
            home.join(".codex/config.toml"),
            b"model = 'preserve-codex'\n",
        )
        .unwrap();
        Self {
            root,
            paths,
            cli: MockCli::default(),
        }
    }
    fn install(&self) -> SetupReport {
        install_with_cli(None, &self.paths, &self.cli)
    }
    fn status(&self) -> SetupReport {
        status_with_cli(None, &self.paths, &self.cli)
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

fn make_payload(root: &Path, version: &str, endpoint: &str) {
    for rel in expected_plugin_files() {
        let path = root.join(rel);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, b"fixture-payload\n").unwrap();
    }
    write_json(
        &root.join(".claude-plugin/plugin.json"),
        &json!({"name":"spellcast", "version":version}),
    )
    .unwrap();
    write_json(
        &root.join("package-meta.json"),
        &json!({"name":"spellcast", "version":version, "host":"claude"}),
    )
    .unwrap();
    write_json(
        &root.join(".mcp.json"),
        &complete_setup::mcp_document(endpoint),
    )
    .unwrap();
    let command = format!(
        "${{CLAUDE_PLUGIN_ROOT}}/bin/{}",
        complete_setup::helper_name()
    );
    let h = json!({"type":"command", "command":command,
        "args":["--host","claude","--endpoint",complete_setup::status_url_for_mcp(endpoint).unwrap()],"timeout":2});
    write_json(
        &root.join("hooks/hooks.json"),
        &json!({"hooks":{
            "SessionStart":[{"matcher":"startup|resume|clear|compact","hooks":[h.clone()]}],
            "UserPromptSubmit":[{"hooks":[h]}]
        }}),
    )
    .unwrap();
    fs::write(
        root.join("skills/spellcast/SKILL.md"),
        b"---\nname: spellcast\n---\nNative fixture skill\n",
    )
    .unwrap();
    write_integrity(root).unwrap();
}

fn make_gui(root: &Path) {
    fs::create_dir_all(root).unwrap();
    for file in GUI_FILES {
        fs::write(root.join(file), b"gui-fixture\n").unwrap();
    }
    write_json(
        &root.join("manifest.json"),
        &json!({"id":"spellcast-canvas-bridge","tier":"js","version":"0.1.0",
            "permissions":["host:chat","host:session","network:127.0.0.1:47194"]}),
    )
    .unwrap();
    fs::write(root.join("main.js"), b"export default function activate(ctx) { const base = 'http://127.0.0.1:47194'; return { base }; }\n").unwrap();
    let hashes: serde_json::Map<String, Value> = GUI_FILES
        .iter()
        .map(|p| (p.to_string(), json!(digest(&root.join(p)).unwrap())))
        .collect();
    write_json(
        &root.join("integrity.json"),
        &json!({"algorithm":"sha256", "files":hashes}),
    )
    .unwrap();
}

#[derive(Default)]
struct MockCli {
    calls: Mutex<Vec<Vec<String>>>,
    rows: Mutex<Vec<Value>>,
    fail: Mutex<Option<String>>,
    leave_disabled: Mutex<bool>,
    update_noop: Mutex<bool>,
}
impl MockCli {
    fn mutations(&self) -> Vec<Vec<String>> {
        self.calls
            .lock()
            .unwrap()
            .iter()
            .filter(|a| a.get(1).map(String::as_str) != Some("list"))
            .cloned()
            .collect()
    }
    fn seed_native(&self, paths: &ClaudePaths, source: &Path, enabled: bool) {
        check_marketplace(source).unwrap();
        write_json(
            &paths.registry(),
            &json!({
                "unrelated-market":{"source":{"source":"github","repo":"preserve/unrelated"}},
                MARKET:{"source":{"source":"directory","path":source},"installLocation":source}
            }),
        )
        .unwrap();
        self.cache_from_source(paths, enabled);
    }
    fn cache_from_source(&self, paths: &ClaudePaths, enabled: bool) {
        let source = PathBuf::from(
            read_json(&paths.registry()).unwrap()[MARKET]["source"]["path"]
                .as_str()
                .unwrap(),
        );
        let plugin = source.join("plugins/spellcast");
        let payload = check_payload(&plugin).unwrap();
        let cache = paths
            .claude_home
            .join("plugins/cache")
            .join(MARKET)
            .join("spellcast")
            .join(&payload.version);
        if cache.exists() {
            fs::remove_dir_all(&cache).unwrap();
        }
        copy_payload(&plugin, &cache, &expected_plugin_files()).unwrap();
        let mut rows = self.rows.lock().unwrap();
        rows.retain(|r| r["id"] != SELECTOR);
        rows.push(
            json!({"id":SELECTOR,"scope":"user","version":payload.version,"enabled":enabled,
            "installPath":cache,"mcpServers":{"spellcast":{"type":"http","url":payload.mcp}}}),
        );
    }
}
impl ClaudeCli for MockCli {
    fn run(&self, args: &[&str], paths: &ClaudePaths) -> Result<CliOutcome, String> {
        assert!(args.iter().all(|p| !p.contains("codex")));
        self.calls
            .lock()
            .unwrap()
            .push(args.iter().map(|s| s.to_string()).collect());
        if self
            .fail
            .lock()
            .unwrap()
            .as_ref()
            .is_some_and(|p| args.get(1) == Some(&p.as_str()) || args.get(2) == Some(&p.as_str()))
        {
            return Ok(CliOutcome {
                status: 9,
                stdout: "secret-token-must-not-escape".into(),
                stderr: "api-key-must-not-escape".into(),
            });
        }
        match args {
            ["plugin", "list", "--json"] => Ok(CliOutcome {
                status: 0,
                stdout: serde_json::to_string(&*self.rows.lock().unwrap()).unwrap(),
                stderr: String::new(),
            }),
            ["plugin", "marketplace", "add", source, "--scope", "user"] => {
                let mut doc = if paths.registry().exists() {
                    read_json(&paths.registry()).unwrap()
                } else {
                    json!({})
                };
                doc[MARKET] =
                    json!({"source":{"source":"directory","path":source},"installLocation":source});
                write_json(&paths.registry(), &doc).unwrap();
                Ok(CliOutcome {
                    status: 0,
                    stdout: "registered".into(),
                    stderr: String::new(),
                })
            }
            ["plugin", "marketplace", "remove", MARKET, "--scope", "user"] => {
                let mut doc = read_json(&paths.registry()).unwrap();
                doc.as_object_mut().unwrap().remove(MARKET);
                write_json(&paths.registry(), &doc).unwrap();
                Ok(CliOutcome {
                    status: 0,
                    stdout: "removed".into(),
                    stderr: String::new(),
                })
            }
            ["plugin", op @ ("install" | "update"), SELECTOR, "--scope", "user", "--json"] => {
                if *op != "update" || !*self.update_noop.lock().unwrap() {
                    let prior_enabled = self
                        .rows
                        .lock()
                        .unwrap()
                        .iter()
                        .find(|r| r["id"] == SELECTOR)
                        .and_then(|r| r["enabled"].as_bool())
                        .unwrap_or(true);
                    self.cache_from_source(
                        paths,
                        prior_enabled && !*self.leave_disabled.lock().unwrap(),
                    );
                }
                Ok(CliOutcome {
                    status: 0,
                    stdout: "{}".into(),
                    stderr: String::new(),
                })
            }
            ["plugin", "enable", SELECTOR, "--scope", "user", "--json"] => {
                if !*self.leave_disabled.lock().unwrap() {
                    for row in self
                        .rows
                        .lock()
                        .unwrap()
                        .iter_mut()
                        .filter(|r| r["id"] == SELECTOR)
                    {
                        row["enabled"] = json!(true);
                    }
                }
                Ok(CliOutcome {
                    status: 0,
                    stdout: "{}".into(),
                    stderr: String::new(),
                })
            }
            _ => panic!("unexpected native operation: {args:?}"),
        }
    }
}

fn snapshot(root: &Path) -> Vec<(String, String)> {
    let mut paths = BTreeSet::new();
    file_inventory(root, root, &mut paths).unwrap();
    paths
        .into_iter()
        .map(|p| {
            let h = digest(&root.join(&p)).unwrap();
            (p, h)
        })
        .collect()
}

#[test]
fn preview_is_read_only_and_never_dispatches_codex() {
    let f = Fixture::new();
    let before = snapshot(&f.root);
    let report = f.status();
    assert_eq!(report.kind, SetupKind::NotInstalled);
    assert!(report.complete_supported);
    assert!(!report.installed);
    assert_eq!(before, snapshot(&f.root));
    assert!(f.cli.mutations().is_empty());
}

#[test]
fn missing_cli_resources_and_invalid_endpoint_are_actionable_and_read_only() {
    let mut f = Fixture::new();
    f.paths.cli = None;
    assert_eq!(f.status().kind, SetupKind::MissingCli);
    f.paths.cli = Some(f.root.join("mock.exe"));
    fs::remove_file(f.paths.resource_root.join(".mcp.json")).unwrap();
    assert_eq!(f.status().kind, SetupKind::MissingResources);
    assert_eq!(
        install_with_cli(Some("http://public.example/mcp"), &f.paths, &f.cli).kind,
        SetupKind::Failed
    );
    assert!(f.cli.calls.lock().unwrap().is_empty());
}

#[test]
fn fresh_install_exports_self_contained_payload_and_preserves_native_settings() {
    let f = Fixture::new();
    let settings = fs::read(f.paths.claude_home.join("settings.json")).unwrap();
    let auth = fs::read(f.paths.user_home.join("native-auth-sentinel.json")).unwrap();
    let codex = fs::read(f.paths.user_home.join(".codex/config.toml")).unwrap();
    let r = f.install();
    assert_eq!(r.kind, SetupKind::PendingReload, "{r:?}");
    assert!(r.installed);
    assert_eq!(r.plugin_enabled, Some(true));
    assert_eq!(r.runtime_verified, Some(false));
    assert!(r.hook_trust.is_none());
    assert_eq!(
        r.ccgui_plugin_path,
        Some(f.paths.gui().to_string_lossy().into_owned())
    );
    assert_eq!(ccgui_plugin_path(&f.paths).unwrap(), f.paths.gui());
    assert_eq!(
        settings,
        fs::read(f.paths.claude_home.join("settings.json")).unwrap()
    );
    assert_eq!(
        auth,
        fs::read(f.paths.user_home.join("native-auth-sentinel.json")).unwrap()
    );
    assert_eq!(
        codex,
        fs::read(f.paths.user_home.join(".codex/config.toml")).unwrap()
    );
    assert_eq!(
        registered_source(&f.paths).unwrap(),
        Some(f.paths.marketplace())
    );
    assert!(r.components.as_ref().unwrap().mcp && r.components.as_ref().unwrap().hooks);
    assert!(r.components.as_ref().unwrap().skill_current);
    // Production path and cache survive removal of build/test resources.
    fs::remove_dir_all(f.root.join("resources")).unwrap();
    check_payload(&f.paths.source()).unwrap();
    check_gui(&f.paths.gui()).unwrap();
}

#[test]
fn recheck_enabled_and_disabled_never_claims_runtime_verified() {
    let f = Fixture::new();
    assert!(f.install().installed);
    let enabled = f.status();
    assert_eq!(enabled.kind, SetupKind::InstalledUnverified);
    assert_eq!(enabled.native_reload_required, Some(true));
    f.cli.rows.lock().unwrap()[0]["enabled"] = json!(false);
    let disabled = f.status();
    assert!(disabled.installed);
    assert_eq!(disabled.plugin_enabled, Some(false));
    assert!(!disabled.components.unwrap().hooks);
    let r = f.install();
    assert_eq!(r.plugin_enabled, Some(true));
    assert!(f
        .cli
        .mutations()
        .iter()
        .any(|a| a.get(1).map(String::as_str) == Some("enable")));
}

#[test]
fn stable_install_is_idempotent_and_updated_payload_has_backup() {
    let f = Fixture::new();
    assert!(f.install().installed);
    let mutations = f.cli.mutations().len();
    assert!(f.install().installed);
    assert_eq!(mutations, f.cli.mutations().len());
    make_payload(
        &f.paths.resource_root,
        "0.2.0",
        "http://127.0.0.1:47194/mcp",
    );
    let r = f.install();
    assert_eq!(r.kind, SetupKind::PendingReload, "{r:?}");
    assert_eq!(r.plugin_version.as_deref(), Some("0.2.0"));
    let backup = PathBuf::from(r.backup.unwrap());
    assert_eq!(
        check_payload(&backup.join("marketplace/plugins/spellcast"))
            .unwrap()
            .version,
        "0.1.0"
    );
}

#[test]
fn managed_test_source_migrates_only_through_official_cli_and_preserves_other_markets() {
    let f = Fixture::new();
    let old = f
        .root
        .join("repo/artifacts/ccgui-compat/claude-marketplace");
    copy_payload(
        &f.paths.resource_root,
        &old.join("plugins/spellcast"),
        &expected_plugin_files(),
    )
    .unwrap();
    write_json(
        &old.join(".claude-plugin/marketplace.json"),
        &marketplace_doc(),
    )
    .unwrap();
    f.cli.seed_native(&f.paths, &old, true);
    let before = snapshot(&old);
    let r = f.install();
    assert_eq!(r.kind, SetupKind::PendingReload, "{r:?}");
    assert_eq!(before, snapshot(&old));
    assert!(PathBuf::from(r.backup.unwrap())
        .join(".claude-plugin/marketplace.json")
        .is_file());
    assert_eq!(
        read_json(&f.paths.registry()).unwrap()["unrelated-market"]["source"]["repo"],
        "preserve/unrelated"
    );
    assert!(f
        .cli
        .mutations()
        .iter()
        .any(|a| a.get(2).map(String::as_str) == Some("remove")));
}

#[test]
fn custom_source_and_endpoint_conflicts_are_not_overwritten() {
    let f = Fixture::new();
    write_json(
        &f.paths.registry(),
        &json!({MARKET:{"source":{"source":"directory","path":f.root.join("custom")}}}),
    )
    .unwrap();
    let before = snapshot(&f.root);
    assert_eq!(f.install().kind, SetupKind::ConflictCustom);
    assert_eq!(before, snapshot(&f.root));
    assert!(f.cli.mutations().is_empty());
    fs::remove_file(f.paths.registry()).unwrap();
    assert!(f.install().installed);
    let before = snapshot(&f.root);
    let r = install_with_cli(Some("http://127.0.0.1:47195/mcp"), &f.paths, &f.cli);
    assert_eq!(r.kind, SetupKind::ConflictEndpoint);
    assert_eq!(before, snapshot(&f.root));
}

#[test]
fn custom_cache_files_and_other_source_plugin_are_conflicts() {
    let f = Fixture::new();
    assert!(f.install().installed);
    let cache = PathBuf::from(
        f.cli.rows.lock().unwrap()[0]["installPath"]
            .as_str()
            .unwrap(),
    );
    fs::write(cache.join("my-custom-file"), b"preserve").unwrap();
    let before = snapshot(&f.root);
    assert_eq!(f.install().kind, SetupKind::ConflictCustom);
    assert_eq!(before, snapshot(&f.root));
    fs::remove_file(cache.join("my-custom-file")).unwrap();
    f.cli
        .rows
        .lock()
        .unwrap()
        .push(json!({"id":"spellcast@custom","scope":"project"}));
    assert_eq!(f.status().kind, SetupKind::ConflictCustom);
}

#[test]
fn partial_cli_failure_is_reported_without_leaking_cli_output() {
    let f = Fixture::new();
    *f.cli.fail.lock().unwrap() = Some("install".into());
    let r = f.install();
    assert_eq!(r.kind, SetupKind::Failed);
    assert!(r.partial);
    assert!(!r.installed);
    assert_eq!(r.plugin_enabled, Some(false));
    assert!(r.ccgui_plugin_path.is_some());
    let json = serde_json::to_string(&r).unwrap();
    assert!(!json.contains("secret-token") && !json.contains("api-key"));
    *f.cli.fail.lock().unwrap() = None;
    assert_eq!(f.install().kind, SetupKind::PendingReload);
}

#[test]
fn successful_exit_without_current_cache_or_enablement_is_not_a_pass() {
    let f = Fixture::new();
    assert!(f.install().installed);
    make_payload(
        &f.paths.resource_root,
        "0.2.0",
        "http://127.0.0.1:47194/mcp",
    );
    *f.cli.update_noop.lock().unwrap() = true;
    let r = f.install();
    assert_eq!(r.kind, SetupKind::Failed);
    assert!(r.partial);
    assert!(r.components.unwrap().skill_current);
    assert_eq!(r.plugin_resources_current, Some(false));
    let f = Fixture::new();
    *f.cli.leave_disabled.lock().unwrap() = true;
    let r = f.install();
    assert_eq!(r.kind, SetupKind::Failed);
    assert_eq!(r.plugin_enabled, Some(false));
}

#[test]
fn rebuilt_timestamp_is_inert_even_with_a_same_version_cli_cache() {
    let f = Fixture::new();
    assert!(f.install().installed);
    let cache = PathBuf::from(f.status().cache_path.unwrap());
    let skill_before = fs::read(cache.join("skills/spellcast/SKILL.md")).unwrap();
    let cache_meta_before = fs::read(cache.join("package-meta.json")).unwrap();
    let mut meta = read_json(&f.paths.resource_root.join("package-meta.json")).unwrap();
    meta["built_at"] = json!("new-build-time-only");
    write_json(&f.paths.resource_root.join("package-meta.json"), &meta).unwrap();
    write_integrity(&f.paths.resource_root).unwrap();
    *f.cli.update_noop.lock().unwrap() = true;
    let mutations = f.cli.mutations().len();
    for _ in 0..2 {
        let r = f.install();
        assert_eq!(r.kind, SetupKind::InstalledUnverified, "{r:?}");
        assert_eq!(r.plugin_resources_current, Some(true));
        assert!(r.components.unwrap().skill_current);
        assert_eq!(r.runtime_verified, Some(false));
        assert!(r.hook_trust.is_none());
    }
    assert_eq!(f.cli.mutations().len(), mutations);
    assert_eq!(fs::read(cache.join("skills/spellcast/SKILL.md")).unwrap(), skill_before);
    assert_eq!(fs::read(cache.join("package-meta.json")).unwrap(), cache_meta_before);
}

#[test]
fn meaningful_metadata_and_helper_drift_are_plugin_level_failures() {
    for metadata in [true, false] {
        let f = Fixture::new();
        assert!(f.install().installed);
        if metadata {
            let mut meta = read_json(&f.paths.resource_root.join("package-meta.json")).unwrap();
            meta["compatibility"] = json!({"minimum_host":"changed"});
            write_json(&f.paths.resource_root.join("package-meta.json"), &meta).unwrap();
        } else {
            fs::write(f.paths.resource_root.join("bin").join(complete_setup::helper_name()), b"new-helper-version").unwrap();
        }
        write_integrity(&f.paths.resource_root).unwrap();
        *f.cli.update_noop.lock().unwrap() = true;
        let status = f.status();
        assert_eq!(status.plugin_resources_current, Some(false));
        assert!(status.components.unwrap().skill_current);
        let r = f.install();
        assert_eq!(r.kind, SetupKind::Failed, "{r:?}");
        assert!(r.partial);
        assert_eq!(r.plugin_resources_current, Some(false));
        assert!(r.components.unwrap().skill_current);
    }
}

#[test]
fn actual_canvas_usage_drift_is_not_hidden_by_timestamp_handling() {
    let f = Fixture::new();
    assert!(f.install().installed);
    let cache = PathBuf::from(f.status().cache_path.unwrap());
    let original = fs::read(cache.join("skills/spellcast/references/canvas.md")).unwrap();
    fs::write(f.paths.resource_root.join("skills/spellcast/references/canvas.md"), b"new-native-canvas-usage").unwrap();
    write_integrity(&f.paths.resource_root).unwrap();
    *f.cli.update_noop.lock().unwrap() = true;
    assert!(!f.status().components.unwrap().skill_current);
    let r = f.install();
    assert_eq!(r.kind, SetupKind::Failed);
    assert!(!r.components.unwrap().skill_current);
    assert_eq!(r.plugin_resources_current, Some(false));
    assert_eq!(fs::read(cache.join("skills/spellcast/references/canvas.md")).unwrap(), original);
}

#[test]
fn packaged_resources_have_native_identity_and_valid_integrity() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources");
    let payload = check_payload(&root.join("claude-plugin")).unwrap();
    assert!(!payload.version.is_empty());
    check_gui(&root.join("ccgui-spellcast")).unwrap();
}

#[test]
fn default_port_exports_original_thin_plugin_bytes() {
    let f = Fixture::new();
    assert_eq!(f.install().kind, SetupKind::PendingReload);
    for rel in GUI_FILES
        .iter()
        .copied()
        .chain(std::iter::once("integrity.json"))
    {
        assert_eq!(
            fs::read(f.paths.gui().join(rel)).unwrap(),
            fs::read(f.paths.ccgui_resource_root.join(rel)).unwrap()
        );
    }
}

#[test]
fn chosen_loopback_port_matches_native_mcp_hooks_and_exact_thin_network_grant() {
    let f = Fixture::new();
    let bundled = snapshot(&f.paths.ccgui_resource_root);
    let mcp = "http://127.0.0.1:48194/mcp";
    let r = install_with_cli(Some("http://localhost:48194/mcp"), &f.paths, &f.cli);
    assert_eq!(r.kind, SetupKind::PendingReload, "{r:?}");
    assert_eq!(check_payload(&f.paths.source()).unwrap().mcp, mcp);
    assert_eq!(gui_endpoint(&f.paths.gui()).unwrap(), mcp);
    let hooks = read_json(&f.paths.source().join("hooks/hooks.json")).unwrap();
    for event in ["SessionStart", "UserPromptSubmit"] {
        assert_eq!(
            hooks["hooks"][event][0]["hooks"][0]["args"][3],
            "http://127.0.0.1:48194/api/observer/status"
        );
    }
    let manifest = read_json(&f.paths.gui().join("manifest.json")).unwrap();
    assert_eq!(
        manifest["permissions"],
        json!(["host:chat", "host:session", "network:127.0.0.1:48194"])
    );
    assert_eq!(bundled, snapshot(&f.paths.ccgui_resource_root));
    for rel in ["README.md", "package-meta.json"] {
        assert_eq!(
            fs::read(f.paths.gui().join(rel)).unwrap(),
            fs::read(f.paths.ccgui_resource_root.join(rel)).unwrap()
        );
    }
    check_gui(&f.paths.gui()).unwrap();
    let mutations = f.cli.mutations().len();
    assert!(install_with_cli(Some(mcp), &f.paths, &f.cli).installed);
    assert_eq!(mutations, f.cli.mutations().len());
}

#[test]
fn gui_only_resource_update_refreshes_default_and_exact_port_exports() {
    for mcp in ["http://127.0.0.1:47194/mcp", "http://127.0.0.1:48194/mcp"] {
        let f = Fixture::new();
        assert_eq!(
            install_with_cli(Some(mcp), &f.paths, &f.cli).kind,
            SetupKind::PendingReload
        );
        let old_gui = fs::read(f.paths.gui().join("main.js")).unwrap();
        let cache = PathBuf::from(
            f.cli.rows.lock().unwrap()[0]["installPath"]
                .as_str()
                .unwrap(),
        );
        let old_native_cache = snapshot(&cache);
        let mut new_script = fs::read(f.paths.ccgui_resource_root.join("main.js")).unwrap();
        new_script.extend_from_slice(b"// new GUI-only build\n");
        fs::write(f.paths.ccgui_resource_root.join("main.js"), new_script).unwrap();
        let hashes: serde_json::Map<String, Value> = GUI_FILES
            .iter()
            .map(|p| {
                (
                    p.to_string(),
                    json!(digest(&f.paths.ccgui_resource_root.join(p)).unwrap()),
                )
            })
            .collect();
        write_json(
            &f.paths.ccgui_resource_root.join("integrity.json"),
            &json!({"algorithm":"sha256","files":hashes}),
        )
        .unwrap();
        *f.cli.update_noop.lock().unwrap() = true;
        assert!(!gui_current(&f.paths, mcp));
        let r = install_with_cli(Some(mcp), &f.paths, &f.cli);
        assert_eq!(r.kind, SetupKind::PendingReload, "{r:?}");
        assert!(gui_current(&f.paths, mcp));
        assert_ne!(old_gui, fs::read(f.paths.gui().join("main.js")).unwrap());
        assert_eq!(old_native_cache, snapshot(&cache));
        assert_eq!(
            old_gui,
            fs::read(PathBuf::from(r.backup.unwrap()).join("ccgui-spellcast/main.js")).unwrap()
        );
        assert_eq!(gui_endpoint(&f.paths.gui()).unwrap(), mcp);
    }
}

#[cfg(windows)]
#[test]
fn native_process_runner_isolates_home_without_injecting_codex_or_changing_proxy() {
    let f = Fixture::new();
    let script = f.root.join("mock-cli.ps1");
    fs::write(&script, "@{ home=$env:HOME; profile=$env:USERPROFILE; claude=$env:CLAUDE_CONFIG_DIR; codex=$env:CODEX_HOME; proxy=$env:HTTPS_PROXY } | ConvertTo-Json -Compress\n").unwrap();
    let program = PathBuf::from(std::env::var_os("SystemRoot").unwrap())
        .join("System32/WindowsPowerShell/v1.0/powershell.exe");
    let output = complete_setup::run_claude_owned(
        &program,
        &[
            "-NoProfile",
            "-NonInteractive",
            "-File",
            script.to_str().unwrap(),
        ],
        &f.paths.user_home,
        &f.paths.claude_home,
        Duration::from_secs(8),
    )
    .unwrap();
    assert_eq!(output.status, 0);
    let value: Value = serde_json::from_str(output.stdout.trim()).unwrap();
    assert_eq!(value["home"].as_str(), f.paths.user_home.to_str());
    assert_eq!(value["profile"].as_str(), f.paths.user_home.to_str());
    assert_eq!(value["claude"].as_str(), f.paths.claude_home.to_str());
    assert_eq!(
        value["codex"].as_str().filter(|s| !s.is_empty()),
        std::env::var("CODEX_HOME")
            .ok()
            .as_deref()
            .filter(|s| !s.is_empty())
    );
    assert_eq!(
        value["proxy"].as_str().filter(|s| !s.is_empty()),
        std::env::var("HTTPS_PROXY")
            .ok()
            .as_deref()
            .filter(|s| !s.is_empty())
    );
}

fn make_ccgui_home(home: &Path) -> PathBuf {
    let ccgui = home.join(".ccgui-next");
    fs::create_dir_all(&ccgui).unwrap();
    let db = rusqlite::Connection::open(ccgui.join("app.db")).unwrap();
    db.execute_batch(
        "PRAGMA journal_mode=WAL;
         CREATE TABLE plugin_kv(plugin_id TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(plugin_id, key));
         INSERT INTO plugin_kv VALUES('other-plugin', 'k', '\"keep\"');
         INSERT INTO plugin_kv VALUES('spellcast-canvas-bridge', 'diagnosis-v1:x', '{\"stage\":\"registered\"}');",
    )
    .unwrap();
    fs::write(
        ccgui.join("plugins.json"),
        serde_json::to_vec_pretty(&json!({
            "plugins": {"other-plugin": {"version":"1.0.0","enabled":false,"source":"local","permissions":["storage"],
                "quarantined":false,"lastError":null,"installedAt":7}},
            "kvTombstones": {"spellcast-canvas-bridge": 5, "gone-plugin": 6}
        }))
        .unwrap(),
    )
    .unwrap();
    ccgui
}

fn ccgui_kv(ccgui: &Path, plugin: &str, key: &str) -> Option<String> {
    let db = rusqlite::Connection::open(ccgui.join("app.db")).unwrap();
    db.query_row(
        "SELECT value FROM plugin_kv WHERE plugin_id=?1 AND key=?2",
        [plugin, key],
        |row| row.get(0),
    )
    .ok()
}

#[test]
fn install_without_ccgui_skips_the_send_back_plugin() {
    let f = Fixture::new();
    let r = f.install();
    assert_eq!(r.kind, SetupKind::PendingReload, "{r:?}");
    assert_eq!(r.ccgui_detected, Some(false));
    assert_eq!(r.ccgui_plugin_current, None);
    assert!(!f.paths.ccgui_home.exists(), "nothing may be created for an absent CC GUI");
    assert!(r.note.contains("未检测到 CC GUI"), "{}", r.note);
}

#[test]
fn install_deploys_registers_and_pairs_the_ccgui_plugin() {
    let f = Fixture::new();
    let ccgui = make_ccgui_home(&f.paths.user_home);
    let before = f.status();
    assert_eq!(
        (before.ccgui_detected, before.ccgui_plugin_current, before.ccgui_paired),
        (Some(true), Some(false), Some(false))
    );
    let r = f.install();
    assert_eq!(r.kind, SetupKind::PendingReload, "{r:?}");
    assert_eq!(
        (r.ccgui_detected, r.ccgui_plugin_current, r.ccgui_paired),
        (Some(true), Some(true), Some(true))
    );
    let key = f.paths.host_link_key.clone().unwrap();
    assert!(!serde_json::to_string(&r).unwrap().contains(&key), "the key must never reach the report");
    let dir = ccgui.join("plugins/spellcast-canvas-bridge");
    for (rel, bytes) in ccgui_files(&f.paths, "http://127.0.0.1:47194/mcp").unwrap() {
        assert_eq!(fs::read(dir.join(&rel)).unwrap(), bytes, "{rel}");
    }
    let registry = read_json(&ccgui.join("plugins.json")).unwrap();
    let record = &registry["plugins"]["spellcast-canvas-bridge"];
    assert_eq!(record["enabled"], true);
    assert_eq!(record["quarantined"], false);
    assert_eq!(record["source"], "local");
    assert_eq!(record["version"], "0.1.0");
    assert_eq!(record["permissions"], json!(["host:chat","host:session","network:127.0.0.1:47194"]));
    assert_eq!(registry["plugins"]["other-plugin"]["installedAt"], 7);
    assert!(registry["kvTombstones"].get("spellcast-canvas-bridge").is_none());
    assert_eq!(registry["kvTombstones"]["gone-plugin"], 6);
    assert_eq!(ccgui_kv(&ccgui, "spellcast-canvas-bridge", "bootstrap-key"), Some(format!("\"{key}\"")));
    assert_eq!(ccgui_kv(&ccgui, "spellcast-canvas-bridge", "enabled").as_deref(), Some("true"));
    assert_eq!(ccgui_kv(&ccgui, "other-plugin", "k").as_deref(), Some("\"keep\""));
    assert!(ccgui_kv(&ccgui, "spellcast-canvas-bridge", "diagnosis-v1:x").is_some());
    assert!(!ccgui.join("plugins/.staging-spellcast-canvas-bridge").exists());
    assert!(!ccgui.join("plugins/.backup-spellcast-canvas-bridge").exists());
    let again = f.install();
    assert!(again.installed && again.ccgui_paired == Some(true), "{again:?}");
}

#[test]
fn ccgui_redeploy_replaces_stale_files_and_repairs_a_changed_key() {
    let f = Fixture::new();
    let ccgui = make_ccgui_home(&f.paths.user_home);
    let dir = ccgui.join("plugins/spellcast-canvas-bridge");
    fs::create_dir_all(&dir).unwrap();
    fs::write(dir.join("main.js"), b"stale").unwrap();
    fs::write(dir.join("leftover.txt"), b"old").unwrap();
    let mut registry = read_json(&ccgui.join("plugins.json")).unwrap();
    registry["plugins"]["spellcast-canvas-bridge"] = json!({"version":"0.0.9","enabled":false,"source":"local",
        "permissions":["host:chat"],"quarantined":true,"lastError":"boom","installedAt":123});
    fs::write(ccgui.join("plugins.json"), serde_json::to_vec(&registry).unwrap()).unwrap();
    rusqlite::Connection::open(ccgui.join("app.db"))
        .unwrap()
        .execute_batch("INSERT INTO plugin_kv VALUES('spellcast-canvas-bridge','bootstrap-key','\"old-key\"');
                        INSERT INTO plugin_kv VALUES('spellcast-canvas-bridge','enabled','false');")
        .unwrap();
    let r = f.install();
    assert_eq!(r.kind, SetupKind::PendingReload, "{r:?}");
    assert!(!dir.join("leftover.txt").exists());
    let record = &read_json(&ccgui.join("plugins.json")).unwrap()["plugins"]["spellcast-canvas-bridge"];
    assert_eq!(record["installedAt"], 123);
    assert_eq!(record["quarantined"], false);
    assert_eq!(record["lastError"], Value::Null);
    assert_eq!(record["enabled"], true);
    let key = f.paths.host_link_key.clone().unwrap();
    assert_eq!(ccgui_kv(&ccgui, "spellcast-canvas-bridge", "bootstrap-key"), Some(format!("\"{key}\"")));
    assert_eq!(ccgui_kv(&ccgui, "spellcast-canvas-bridge", "enabled").as_deref(), Some("true"));
}

#[test]
fn ccgui_status_does_not_count_a_foreign_key_as_paired() {
    let f = Fixture::new();
    let ccgui = make_ccgui_home(&f.paths.user_home);
    assert_eq!(f.install().ccgui_paired, Some(true));
    rusqlite::Connection::open(ccgui.join("app.db"))
        .unwrap()
        .execute("UPDATE plugin_kv SET value='\"someone-else\"' WHERE key='bootstrap-key'", [])
        .unwrap();
    let r = f.status();
    assert_eq!((r.ccgui_plugin_current, r.ccgui_paired), (Some(true), Some(false)));
    assert!(r.not_done.iter().any(|line| line.contains("CC GUI 会话插件尚未部署或配对")), "{r:?}");
}

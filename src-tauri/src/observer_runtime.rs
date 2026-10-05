//! Desktop-owned, integrity-checked runtime paths for independent Claude asides.
//! Neither MCP input nor a host integration can select the executable or script.

#[cfg(windows)]
pub fn configure(app: &tauri::AppHandle, bridge: &std::sync::Arc<spellcast_bridge::Bridge>) {
    use tauri::Manager;

    let result = (|| {
        let mut roots = Vec::new();
        let resource_error = match app.path().resource_dir() {
            Ok(root) => {
                roots.push(root);
                None
            }
            Err(error) => Some(error.to_string()),
        };
        #[cfg(debug_assertions)]
        roots.push(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("resources"));
        if roots.is_empty() {
            return Err(format!(
                "Tauri resource directory unavailable: {}",
                resource_error.unwrap_or_default()
            ));
        }

        let mut node_dirs = Vec::new();
        for name in ["ProgramW6432", "ProgramFiles", "ProgramFiles(x86)"] {
            if let Some(root) = std::env::var_os(name) {
                node_dirs.push(std::path::PathBuf::from(root).join("nodejs"));
            }
        }
        if let Some(path) = std::env::var_os("PATH") {
            node_dirs.extend(std::env::split_paths(&path));
        }
        let node = trusted::find_node(&node_dirs)?;
        let script = trusted::find_script(&roots)?;
        let runner = spellcast_bridge::observer_runner::ClaudeObserverRunner::new(node, script)?;
        bridge.configure_claude_observer_runner(runner);
        Ok::<(), String>(())
    })();
    if let Err(reason) = result {
        // Startup diagnostics only; never log briefs, model output, or environment values.
        eprintln!("Spellcast Claude observer unavailable: {reason}");
    }
}

#[cfg(not(windows))]
pub fn configure(_app: &tauri::AppHandle, _bridge: &std::sync::Arc<spellcast_bridge::Bridge>) {
    // The process-tree-protected Claude runtime currently supports Windows only.
}

#[cfg(any(windows, test))]
mod trusted {
    use std::collections::BTreeMap;
    use std::fs;
    use std::io::Read;
    use std::path::{Path, PathBuf};

    use serde::Deserialize;
    use sha2::{Digest, Sha256};

    const SCRIPT: &str = "hooks/claude-observer-runner.mjs";
    const PLUGINS: &[&str] = &[
        "resources/claude-plugin",
        "claude-plugin",
        "resources/codex-plugin",
        "codex-plugin",
    ];

    pub(super) fn find_node(directories: &[PathBuf]) -> Result<PathBuf, String> {
        directories
            .iter()
            .filter(|dir| dir.is_absolute())
            .find_map(|dir| {
                let node = dir.join("node.exe");
                if !node.is_file() {
                    return None;
                }
                let node = node.canonicalize().ok()?;
                // Do not accept a link that resolves to a different executable name.
                node.file_name()?
                    .to_str()?
                    .eq_ignore_ascii_case("node.exe")
                    .then_some(node)
            })
            .ok_or_else(|| {
                "node.exe not found in absolute Program Files or startup PATH directories".into()
            })
    }

    fn canonical_file_within(root: &Path, path: &Path) -> Result<PathBuf, String> {
        let resolved = path
            .canonicalize()
            .map_err(|error| format!("resource file {} unavailable: {error}", path.display()))?;
        if !resolved.starts_with(root) {
            return Err(format!(
                "resource file {} escapes its trusted root",
                path.display()
            ));
        }
        if !resolved.is_file() {
            return Err(format!("resource path {} is not a file", path.display()));
        }
        Ok(resolved)
    }

    #[derive(Deserialize)]
    struct Integrity {
        algorithm: String,
        files: BTreeMap<String, String>,
    }

    fn verify_plugin(resource_root: &Path, plugin: &Path) -> Result<PathBuf, String> {
        let plugin = plugin
            .canonicalize()
            .map_err(|error| format!("plugin resource directory unavailable: {error}"))?;
        if !plugin.starts_with(resource_root) || !plugin.is_dir() {
            return Err("plugin resource directory escapes its trusted resource root".into());
        }
        let manifest = canonical_file_within(&plugin, &plugin.join("integrity.json"))?;
        let script = canonical_file_within(&plugin, &plugin.join(SCRIPT))?;
        // Both the manifest and script must belong to this same packaged plugin.
        let integrity: Integrity = serde_json::from_slice(
            &fs::read(&manifest)
                .map_err(|error| format!("integrity manifest unreadable: {error}"))?,
        )
        .map_err(|error| format!("integrity manifest invalid: {error}"))?;
        if integrity.algorithm != "sha256" {
            return Err("integrity manifest must use sha256".into());
        }
        let expected = integrity
            .files
            .get(SCRIPT)
            .filter(|hash| hash.len() == 64 && hash.bytes().all(|byte| byte.is_ascii_hexdigit()))
            .ok_or_else(|| "integrity manifest has no valid Claude runner SHA-256".to_string())?;
        let mut file = fs::File::open(&script)
            .map_err(|error| format!("Claude runner unreadable: {error}"))?;
        let mut digest = Sha256::new();
        let mut buffer = [0; 8192];
        loop {
            let count = file
                .read(&mut buffer)
                .map_err(|error| format!("Claude runner hash read failed: {error}"))?;
            if count == 0 {
                break;
            }
            digest.update(&buffer[..count]);
        }
        if !format!("{:x}", digest.finalize()).eq_ignore_ascii_case(expected) {
            return Err("Claude runner SHA-256 does not match packaged integrity manifest".into());
        }
        Ok(script)
    }

    pub(super) fn find_script(roots: &[PathBuf]) -> Result<PathBuf, String> {
        let mut rejection = None;
        for root in roots.iter().filter(|root| root.is_absolute()) {
            let Ok(root) = root.canonicalize() else {
                continue;
            };
            for relative in PLUGINS {
                let plugin = root.join(relative);
                if !plugin.exists() {
                    continue;
                }
                match verify_plugin(&root, &plugin) {
                    Ok(script) => return Ok(script),
                    Err(reason) => rejection = Some(format!("{}: {reason}", plugin.display())),
                }
            }
        }
        Err(rejection
            .unwrap_or_else(|| "packaged Claude observer runner resources not found".into()))
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        struct Sandbox(PathBuf);
        impl Sandbox {
            fn new() -> Self {
                let root = std::env::temp_dir().join(format!(
                    "spellcast-observer-runtime-{}",
                    uuid::Uuid::new_v4()
                ));
                fs::create_dir_all(&root).unwrap();
                Self(root.canonicalize().unwrap())
            }
            fn plugin(&self, relative: &str) -> PathBuf {
                let plugin = self.0.join(relative);
                fs::create_dir_all(plugin.join("hooks")).unwrap();
                fs::write(plugin.join(SCRIPT), b"// trusted fixture\n").unwrap();
                let hash = format!("{:x}", Sha256::digest(b"// trusted fixture\n"));
                fs::write(
                    plugin.join("integrity.json"),
                    serde_json::to_vec(&serde_json::json!({
                        "algorithm": "sha256", "files": { SCRIPT: hash },
                    }))
                    .unwrap(),
                )
                .unwrap();
                plugin
            }
        }
        impl Drop for Sandbox {
            fn drop(&mut self) {
                let _ = fs::remove_dir_all(&self.0);
            }
        }

        #[test]
        fn finds_integrity_checked_runner_in_each_packaged_layout() {
            for relative in PLUGINS {
                let fixture = Sandbox::new();
                let plugin = fixture.plugin(relative);
                assert_eq!(
                    find_script(&[fixture.0.clone()]).unwrap(),
                    plugin.join(SCRIPT).canonicalize().unwrap()
                );
            }
        }

        #[test]
        fn rejects_changed_runner_and_missing_manifest() {
            let fixture = Sandbox::new();
            let plugin = fixture.plugin("claude-plugin");
            fs::write(plugin.join(SCRIPT), b"// modified\n").unwrap();
            assert!(find_script(&[fixture.0.clone()])
                .unwrap_err()
                .contains("does not match"));
            fs::remove_file(plugin.join("integrity.json")).unwrap();
            assert!(find_script(&[fixture.0.clone()])
                .unwrap_err()
                .contains("integrity.json"));
        }

        #[test]
        fn rejects_missing_runner_and_resources() {
            let fixture = Sandbox::new();
            assert!(find_script(&[fixture.0.clone()])
                .unwrap_err()
                .contains("not found"));
            let plugin = fixture.plugin("claude-plugin");
            fs::remove_file(plugin.join(SCRIPT)).unwrap();
            assert!(find_script(&[fixture.0.clone()])
                .unwrap_err()
                .contains("claude-observer-runner.mjs"));
        }

        #[test]
        fn rejects_wrong_algorithm_and_missing_hash() {
            let fixture = Sandbox::new();
            let plugin = fixture.plugin("claude-plugin");
            for (manifest, expected) in [
                (
                    serde_json::json!({ "algorithm": "sha1", "files": {} }),
                    "must use sha256",
                ),
                (
                    serde_json::json!({ "algorithm": "sha256", "files": {} }),
                    "no valid",
                ),
            ] {
                fs::write(
                    plugin.join("integrity.json"),
                    serde_json::to_vec(&manifest).unwrap(),
                )
                .unwrap();
                assert!(find_script(&[fixture.0.clone()])
                    .unwrap_err()
                    .contains(expected));
            }
        }

        #[test]
        fn rejects_files_and_plugin_directories_outside_trusted_root() {
            let fixture = Sandbox::new();
            let plugin = fixture.plugin("claude-plugin");
            // A lexical prefix and traversal cannot substitute for canonical containment.
            let sibling = fixture.plugin("claude-plugin-other");
            assert!(canonical_file_within(
                &plugin,
                &plugin.join("../claude-plugin-other").join(SCRIPT)
            )
            .unwrap_err()
            .contains("escapes"));
            assert!(
                canonical_file_within(&plugin, &sibling.join("integrity.json"))
                    .unwrap_err()
                    .contains("escapes")
            );
            assert!(verify_plugin(&plugin, &sibling)
                .unwrap_err()
                .contains("escapes"));
        }

        #[test]
        fn rejects_relative_resource_roots() {
            assert!(find_script(&[PathBuf::from("resources")])
                .unwrap_err()
                .contains("not found"));
        }

        #[test]
        fn node_discovery_requires_existing_absolute_node_exe() {
            let fixture = Sandbox::new();
            assert!(find_node(&[]).is_err());
            assert!(find_node(&[fixture.0.clone()]).is_err());
            fs::write(fixture.0.join("node.cmd"), b"unused").unwrap();
            assert!(find_node(&[fixture.0.clone()]).is_err());
            fs::write(fixture.0.join("node.exe"), b"unused test executable").unwrap();
            assert!(find_node(&[PathBuf::from("relative-node-directory")]).is_err());
            assert_eq!(
                find_node(&[fixture.0.clone()]).unwrap(),
                fixture.0.join("node.exe").canonicalize().unwrap()
            );
        }

        #[cfg(unix)]
        #[test]
        fn rejects_runner_symlink_that_escapes_plugin() {
            let fixture = Sandbox::new();
            let plugin = fixture.plugin("claude-plugin");
            let other = fixture.plugin("other");
            fs::remove_file(plugin.join(SCRIPT)).unwrap();
            std::os::unix::fs::symlink(other.join(SCRIPT), plugin.join(SCRIPT)).unwrap();
            assert!(find_script(&[fixture.0.clone()])
                .unwrap_err()
                .contains("escapes"));
        }
    }
}

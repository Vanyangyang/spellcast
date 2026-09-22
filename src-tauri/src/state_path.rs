//! One Windows store, independent of the launching host's MSIX AppData view.
//! Legacy paths are read only during first migration, never as runtime fallbacks.
use rusqlite::{
    backup::{Backup, StepResult},
    Connection, OpenFlags,
};
use std::{
    fs,
    path::{Path, PathBuf},
};

const DATABASE: &str = "spellcast.sqlite3";

fn absolute(path: PathBuf) -> Result<PathBuf, String> {
    if !path.is_absolute() {
        return Err(format!(
            "Spellcast 数据路径必须是绝对路径：{}",
            path.display()
        ));
    }
    Ok(path)
}

fn windows_default(profile: PathBuf) -> Result<PathBuf, String> {
    Ok(absolute(profile)?.join(".spellcast").join(DATABASE))
}

#[cfg(windows)]
fn profile() -> Result<PathBuf, String> {
    std::env::var_os("USERPROFILE")
        .map(PathBuf::from)
        .ok_or_else(|| "找不到 Windows 用户目录；未创建其他数据库。".into())
        .and_then(absolute)
}

pub fn resolve(legacy_dir: impl FnOnce() -> Result<PathBuf, String>) -> Result<PathBuf, String> {
    // An explicit developer/test override is never a fallback or a migration source.
    if let Some(path) = std::env::var_os("SPELLCAST_STATE_FILE") {
        return absolute(PathBuf::from(path));
    }
    #[cfg(windows)]
    {
        let home = profile()?;
        let target = windows_default(home.clone())?;
        prepare(&target, || legacy_candidates(&home, &legacy_dir()?))?;
        Ok(target)
    }
    #[cfg(not(windows))]
    {
        Ok(absolute(legacy_dir()?)?.join(DATABASE))
    }
}

#[cfg(windows)]
fn legacy_candidates(home: &Path, legacy_dir: &Path) -> Result<Vec<PathBuf>, String> {
    let legacy = legacy_dir.join(DATABASE);
    let redirected = exists(&legacy)?
        && redirected_legacy_path(
            &legacy,
            &fs::canonicalize(&legacy).map_err(|e| e.to_string())?,
        );
    let mut paths = vec![legacy];
    let packages = home.join("AppData/Local/Packages");
    if packages.try_exists().map_err(|e| e.to_string())? {
        for entry in fs::read_dir(&packages).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            // Only this app's old database; never inspect another app's data.
            paths.push(
                entry
                    .path()
                    .join("LocalCache/Roaming/com.spellcast.board")
                    .join(DATABASE),
            );
        }
    }
    // The packaged view can hide a different physical Roaming file. It cannot
    // prove there is only one old store, even if canonicalization deduplicates
    // every visible candidate. Require a nonvirtualized scan or explicit import.
    let mut found = Vec::new();
    for path in &paths {
        if exists(path)? {
            found.push(path.display().to_string());
        }
    }
    if !found.is_empty() && redirected {
        return Err(format!(
            "当前启动环境会重定向旧数据目录，无法安全判断要迁移哪份画布。未创建新数据库。\n请先从 Windows 开始菜单启动 Spellcast，或关闭旧实例并明确选择：\nspellcast --migrate-state-from \"所选数据库的完整路径\"\n\n当前可见的旧库：\n{}",
            found.join("\n")
        ));
    }
    Ok(paths)
}

fn redirected_legacy_path(requested: &Path, resolved: &Path) -> bool {
    fn normalized(path: &Path) -> String {
        path.to_string_lossy()
            .replace('/', "\\")
            .trim_start_matches(r"\\?\")
            .to_lowercase()
    }
    let actual = normalized(resolved);
    // A child can retain the redirected filesystem view even when the package
    // identity API returns NO_PACKAGE. Inspect the resolved file, not identity.
    actual != normalized(requested) || actual.contains(r"\localcache\roaming\com.spellcast.board\")
}

pub fn import_default(source: &Path) -> Result<PathBuf, String> {
    #[cfg(windows)]
    {
        if std::env::var_os("SPELLCAST_STATE_FILE").is_some() {
            return Err("迁移前请取消 SPELLCAST_STATE_FILE；迁移只写入固定主数据库。".into());
        }
        let target = windows_default(profile()?)?;
        let _guard = migration_lock(&target)?;
        migrate(source, &target)?;
        Ok(target)
    }
    #[cfg(not(windows))]
    {
        let _ = source;
        Err("此迁移命令仅用于 Windows 旧版数据目录。".into())
    }
}

fn exists(path: &Path) -> Result<bool, String> {
    path.try_exists()
        .map_err(|e| format!("无法检查 {}：{e}", path.display()))
}

fn migration_lock(target: &Path) -> Result<fs::File, String> {
    let parent = target.parent().ok_or("数据库缺少父目录")?;
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let lock = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(parent.join("state-migration.lock"))
        .map_err(|e| e.to_string())?;
    fs2::FileExt::try_lock_exclusive(&lock)
        .map_err(|e| format!("另一个 Spellcast 正在迁移数据，请待其完成后重试：{e}"))?;
    Ok(lock)
}

fn prepare(
    target: &Path,
    discover: impl FnOnce() -> Result<Vec<PathBuf>, String>,
) -> Result<(), String> {
    // An existing store is authoritative even when it is corrupt or inaccessible:
    // Bridge::open reports that problem instead of showing a different old board.
    if exists(target)? {
        return Ok(());
    }
    let _guard = migration_lock(target)?;
    if exists(target)? {
        return Ok(());
    }
    let mut candidates = Vec::new();
    for path in discover()? {
        if exists(&path)? {
            let physical = fs::canonicalize(&path).map_err(|e| e.to_string())?;
            if !candidates.contains(&physical) {
                candidates.push(physical);
            }
        }
    }
    match candidates.as_slice() {
        [] => Ok(()),
        [source] => migrate(source, target),
        _ => Err(format!(
            "发现多份旧画布，已停止迁移，没有加载或覆盖其中任何一份。\n{}\n\n请关闭旧版 Spellcast，明确选择要保留的数据库后运行：\nspellcast --migrate-state-from \"所选数据库的完整路径\"\n\n迁移后只使用：{}。旧文件会保留。",
            candidates.iter().map(|p| p.display().to_string()).collect::<Vec<_>>().join("\n"), target.display()
        )),
    }
}

fn validate(connection: &Connection) -> Result<(), String> {
    let check: String = connection
        .query_row("PRAGMA quick_check", [], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    if check != "ok" {
        return Err(format!("数据库完整性检查失败：{check}"));
    }
    let state: String = connection
        .query_row("SELECT value FROM spellcast_state WHERE id = 1", [], |r| {
            r.get(0)
        })
        .map_err(|e| format!("无法读取旧画布状态：{e}"))?;
    let value: serde_json::Value = serde_json::from_str(&state).map_err(|e| e.to_string())?;
    if !value
        .get("session")
        .and_then(|v| v.get("board"))
        .is_some_and(|v| v.is_object())
    {
        return Err("所选文件不是有效的 Spellcast 画布数据库。".into());
    }
    Ok(())
}

fn migrate(source: &Path, target: &Path) -> Result<(), String> {
    if exists(target)? {
        return Err(format!("主数据库已存在，拒绝覆盖：{}", target.display()));
    }
    let original = Connection::open_with_flags(source, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|e| format!("无法读取所选旧库 {}：{e}", source.display()))?;
    original
        .busy_timeout(std::time::Duration::ZERO)
        .map_err(|e| e.to_string())?;
    validate(&original)
        .map_err(|e| format!("未迁移 {}；请确认旧实例已关闭：{e}", source.display()))?;
    let staged = target.with_file_name(format!("state-migration-{}.sqlite3", uuid::Uuid::new_v4()));
    let result = (|| {
        fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&staged)
            .map_err(|e| e.to_string())?;
        let mut snapshot = Connection::open(&staged).map_err(|e| e.to_string())?;
        {
            let backup = Backup::new(&original, &mut snapshot).map_err(|e| e.to_string())?;
            if !matches!(
                backup.step(-1).map_err(|e| e.to_string())?,
                StepResult::Done
            ) {
                return Err("旧数据库正忙；未迁移，请关闭旧实例后重试。".into());
            }
        }
        validate(&snapshot)?;
        drop(snapshot);
        fs::OpenOptions::new()
            .write(true)
            .open(&staged)
            .and_then(|f| f.sync_all())
            .map_err(|e| e.to_string())?;
        // Atomic publication without replacing a destination created concurrently.
        fs::hard_link(&staged, target)
            .map_err(|e| format!("无法发布主数据库（未覆盖已有文件）：{e}"))?;
        Ok(())
    })();
    let _ = fs::remove_file(&staged);
    result
}

pub fn report_startup_error(message: &str) {
    eprintln!("Spellcast failed to start: {message}");
    #[cfg(windows)]
    {
        use windows_sys::Win32::UI::WindowsAndMessaging::{MessageBoxW, MB_ICONERROR, MB_OK};
        let text: Vec<u16> = message.encode_utf16().chain(Some(0)).collect();
        let title: Vec<u16> = "Spellcast 无法加载画布"
            .encode_utf16()
            .chain(Some(0))
            .collect();
        unsafe {
            MessageBoxW(
                std::ptr::null_mut(),
                text.as_ptr(),
                title.as_ptr(),
                MB_OK | MB_ICONERROR,
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let path =
                std::env::temp_dir().join(format!("spellcast-state-path-{}", uuid::Uuid::new_v4()));
            fs::create_dir(&path).unwrap();
            Self(path)
        }
        fn target(&self) -> PathBuf {
            self.0.join(".spellcast").join(DATABASE)
        }
        fn source(&self, name: &str) -> PathBuf {
            let path = self.0.join(name);
            let c = Connection::open(&path).unwrap();
            c.execute_batch("CREATE TABLE spellcast_state (id INTEGER PRIMARY KEY, schema_version INTEGER, value TEXT); CREATE TABLE spellcast_artifact_files (bytes BLOB);").unwrap();
            c.execute("INSERT INTO spellcast_state VALUES (1, 4, ?)", [r#"{"session":{"board":{"replies":[{"id":"vesperix","revision":2}],"canvas":{"items":[{"user_modified":true,"removed":false,"x":192,"y":1872}]}}},"bindings":[{"thread_id":"original"}]}"#]).unwrap();
            c.execute(
                "INSERT INTO spellcast_artifact_files VALUES (?)",
                [vec![0u8, 12, 255]],
            )
            .unwrap();
            path
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn windows_path_is_outside_appdata_and_rejects_relative_profile() {
        let f = Fixture::new();
        assert_eq!(windows_default(f.0.clone()).unwrap(), f.target());
        assert!(windows_default(PathBuf::from("relative")).is_err());
        assert!(absolute(PathBuf::from("")).is_err());
    }

    #[test]
    fn redirected_files_are_detected_without_relying_on_package_identity() {
        let old = Path::new(r"C:\Users\A\AppData\Roaming\com.spellcast.board\spellcast.sqlite3");
        let physical =
            Path::new(r"\\?\C:\Users\A\AppData\Roaming\com.spellcast.board\spellcast.sqlite3");
        let redirected = Path::new(
            r"\\?\C:\Users\A\AppData\Local\Packages\Host\LocalCache\Roaming\com.spellcast.board\spellcast.sqlite3",
        );
        assert!(!redirected_legacy_path(old, physical));
        assert!(redirected_legacy_path(old, redirected));
        assert!(redirected_legacy_path(redirected, redirected));
    }

    #[test]
    fn existing_canonical_store_never_discovers_or_falls_back_even_if_corrupt() {
        let f = Fixture::new();
        fs::create_dir_all(f.target().parent().unwrap()).unwrap();
        fs::write(f.target(), b"damaged").unwrap();
        prepare(&f.target(), || panic!("must not inspect old stores")).unwrap();
        assert_eq!(fs::read(f.target()).unwrap(), b"damaged");
    }

    #[test]
    fn inaccessible_or_redirected_discovery_never_initializes_a_new_store() {
        let f = Fixture::new();
        assert!(prepare(&f.target(), || Err("redirected legacy view".into())).is_err());
        assert!(!f.target().exists());
    }

    #[test]
    fn first_migration_preserves_complete_state_artifacts_and_original() {
        let f = Fixture::new();
        let source = f.source("old.sqlite3");
        let before = fs::read(&source).unwrap();
        prepare(&f.target(), || Ok(vec![source.clone(), source.clone()])).unwrap();
        let original = Connection::open(&source).unwrap();
        let current = Connection::open(f.target()).unwrap();
        for sql in [
            "SELECT value FROM spellcast_state",
            "SELECT hex(bytes) FROM spellcast_artifact_files",
        ] {
            let a: String = original.query_row(sql, [], |r| r.get(0)).unwrap();
            let b: String = current.query_row(sql, [], |r| r.get(0)).unwrap();
            assert_eq!(a, b);
        }
        assert_eq!(fs::read(source).unwrap(), before);
    }

    #[test]
    fn conflicting_legacy_stores_require_explicit_choice_without_creating_target() {
        let f = Fixture::new();
        let a = f.source("roaming.sqlite3");
        let b = f.source("localcache.sqlite3");
        assert!(prepare(&f.target(), || Ok(vec![a.clone(), b.clone()]))
            .unwrap_err()
            .contains("多份旧画布"));
        assert!(!f.target().exists());
        let _guard = migration_lock(&f.target()).unwrap();
        migrate(&b, &f.target()).unwrap();
        assert!(migrate(&a, &f.target()).unwrap_err().contains("拒绝覆盖"));
    }

    #[test]
    fn corrupt_and_locked_legacy_stores_never_create_an_empty_canonical_store() {
        let f = Fixture::new();
        let bad = f.0.join("bad.sqlite3");
        fs::write(&bad, b"broken").unwrap();
        assert!(prepare(&f.target(), || Ok(vec![bad])).is_err());
        assert!(!f.target().exists());
        let source = f.source("locked.sqlite3");
        let lock = Connection::open(&source).unwrap();
        lock.execute_batch("PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE; COMMIT;")
            .unwrap();
        assert!(prepare(&f.target(), || Ok(vec![source])).is_err());
        assert!(!f.target().exists());
    }

    #[test]
    fn backup_includes_committed_wal_records() {
        let f = Fixture::new();
        let source = f.source("wal.sqlite3");
        let c = Connection::open(&source).unwrap();
        c.execute_batch("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; INSERT INTO spellcast_artifact_files VALUES (x'CAFE');").unwrap();
        prepare(&f.target(), || Ok(vec![source])).unwrap();
        let current = Connection::open(f.target()).unwrap();
        assert_eq!(
            current
                .query_row("SELECT COUNT(*) FROM spellcast_artifact_files", [], |r| r
                    .get::<_, i64>(
                    0
                ))
                .unwrap(),
            2
        );
    }

    #[test]
    fn concurrent_migration_is_rejected_and_new_profiles_can_start_empty() {
        let f = Fixture::new();
        let guard = migration_lock(&f.target()).unwrap();
        assert!(prepare(&f.target(), || Ok(vec![])).is_err());
        drop(guard);
        prepare(&f.target(), || Ok(vec![])).unwrap();
        assert!(!f.target().exists());
    }
}

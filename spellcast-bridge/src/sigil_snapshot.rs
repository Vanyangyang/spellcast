//! Sigil snapshots. Each run keeps a private index and object directory under
//! `<data>/sigils/<id>/` and borrows the repository's objects as an alternate, so taking a
//! snapshot never writes the repository's index, refs or object contents. Diffs use plumbing
//! only (`diff-tree`), which writes no textconv cache. Recipe and evidence:
//! docs/sigil-phase1-contract.md, Observation.

use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, Instant, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tokio::io::AsyncReadExt;

use crate::sigils::{ChangedPath, LargeFile};

/// New untracked files above this size are listed by size but not stored.
pub const MAX_NEW_FILE_BYTES: u64 = 1024 * 1024;
/// Observation stops once the private directory grows beyond this.
pub const MAX_PRIVATE_BYTES: u64 = 2 * 1024 * 1024 * 1024;
pub const MAX_PATCH_BYTES: usize = 256 * 1024;
const GIT_TIMEOUT: Duration = Duration::from_secs(120);
const MAX_UNREADABLE: usize = 100;

/// Variables an inherited environment could use to point git somewhere else. Checks drop them too.
pub(crate) const INHERITED: [&str; 7] = ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_NAMESPACE"];

/// A git process with stdin closed, no prompt and no console window. Killed when dropped.
fn command(dir: &Path) -> tokio::process::Command {
    let mut command = tokio::process::Command::new("git");
    command.arg("-c").arg("core.longpaths=true").current_dir(dir)
        .env("GIT_ASK_YESNO", "false").env("GIT_TERMINAL_PROMPT", "0")
        .stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
    for name in INHERITED {
        command.env_remove(name);
    }
    #[cfg(windows)]
    command.creation_flags(0x0800_0000);
    command
}

async fn finish(mut command: tokio::process::Command, label: &str) -> Result<std::process::Output, String> {
    tokio::time::timeout(GIT_TIMEOUT, command.output()).await
        .map_err(|_| format!("git {label} 超时。"))?
        .map_err(|error| format!("无法运行 git：{error}"))
}

/// Runs git in `dir`; returns its trimmed output, or its error output on failure.
pub(crate) async fn git(dir: &Path, args: &[&str]) -> Result<String, String> {
    let mut command = command(dir);
    command.args(args);
    let output = finish(command, &args.join(" ")).await?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    } else {
        Err(format!("git {} 失败：{}", args.join(" "), String::from_utf8_lossy(&output.stderr).trim()))
    }
}

fn fields(bytes: &[u8]) -> impl Iterator<Item = String> + '_ {
    bytes.split(|byte| *byte == 0).filter(|field| !field.is_empty()).map(|field| String::from_utf8_lossy(field).into_owned())
}

fn io_error(action: &str, path: &Path, error: std::io::Error) -> String {
    format!("{action} {} 失败：{error}", path.display())
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Snapshot {
    pub tree: String,
    pub large: BTreeMap<String, LargeFile>,
    /// Files other programs kept from being read; their previous content stays in the tree.
    pub partial: Vec<String>,
    pub duration_ms: u64,
}

#[derive(Serialize, Deserialize)]
struct Saved {
    work: String,
    objects: String,
    submodules: Vec<String>,
}

/// One run's private snapshot directory.
pub(crate) struct Session {
    dir: PathBuf,
    work: PathBuf,
    objects: String,
    submodules: Vec<String>,
}

impl Session {
    /// Creates the private directory for the execution directory `work`, seeding its index
    /// from the repository's. Anything left in `dir` by an earlier attempt is removed first.
    pub async fn create(dir: &Path, work: &Path) -> Result<Self, String> {
        if dir.exists() {
            std::fs::remove_dir_all(dir).map_err(|error| io_error("清理快照目录", dir, error))?;
        }
        let located = git(work, &["rev-parse", "--path-format=absolute", "--git-path", "objects", "--git-path", "index"]).await?;
        let mut lines = located.lines();
        let (Some(objects), Some(index)) = (lines.next(), lines.next()) else {
            return Err("找不到仓库的对象目录。".into());
        };
        for name in ["objects", "nohooks", "lfs"] {
            std::fs::create_dir_all(dir.join(name)).map_err(|error| io_error("创建快照目录", dir, error))?;
        }
        // Seed with the repository's index and keep its modification time: Git compares entries
        // against it to catch edits within the same timestamp, and files whose stat data still
        // matches are not hashed again (an empty seed would re-clean every LFS file).
        let index = Path::new(index);
        if index.is_file() {
            let seed = dir.join("index");
            std::fs::copy(index, &seed).map_err(|error| io_error("复制索引", index, error))?;
            let modified = std::fs::metadata(index).and_then(|meta| meta.modified()).map_err(|error| io_error("读取索引时间", index, error))?;
            std::fs::File::options().write(true).open(&seed).and_then(|file| file.set_modified(modified))
                .map_err(|error| io_error("设置索引时间", &seed, error))?;
        }
        let mut session = Self { dir: dir.to_path_buf(), work: work.to_path_buf(), objects: objects.to_string(), submodules: vec![] };
        session.submodules = session.gitlinks().await?;
        let saved = Saved { work: work.to_string_lossy().into(), objects: session.objects.clone(), submodules: session.submodules.clone() };
        let json = serde_json::to_vec(&saved).map_err(|error| error.to_string())?;
        std::fs::write(dir.join("session.json"), json).map_err(|error| io_error("写入快照目录信息", dir, error))?;
        Ok(session)
    }

    /// Reopens a directory made by [`Session::create`], for example after a restart.
    pub fn open(dir: &Path) -> Result<Self, String> {
        let json = std::fs::read(dir.join("session.json")).map_err(|_| "这个法阵没有快照目录。".to_string())?;
        let saved: Saved = serde_json::from_slice(&json).map_err(|error| format!("快照目录信息损坏：{error}"))?;
        Ok(Self { dir: dir.to_path_buf(), work: PathBuf::from(saved.work), objects: saved.objects, submodules: saved.submodules })
    }

    /// A git command that reads and writes only the private index and objects. Hooks, split
    /// index, CRLF refusals, automatic maintenance and lazy fetches are off; LFS stores what its
    /// clean filter produces in the private directory. Messages are English so they can be read.
    fn private(&self, args: &[&str]) -> tokio::process::Command {
        let mut command = command(&self.work);
        let separator = if cfg!(windows) { ';' } else { ':' };
        let alternate = if self.objects.contains(separator) || self.objects.starts_with('"') {
            format!("\"{}\"", self.objects.replace('\\', "\\\\").replace('"', "\\\""))
        } else {
            self.objects.clone()
        };
        command.env("GIT_INDEX_FILE", self.dir.join("index")).env("GIT_OBJECT_DIRECTORY", self.dir.join("objects"))
            .env("GIT_ALTERNATE_OBJECT_DIRECTORIES", alternate).env("GIT_OPTIONAL_LOCKS", "0").env("GIT_NO_LAZY_FETCH", "1")
            .env("LC_ALL", "C").env("LANGUAGE", "C");
        let path = |name: &str| self.dir.join(name).to_string_lossy().to_string();
        let settings = [
            "core.splitIndex=false".to_string(),
            format!("core.hooksPath={}", path("nohooks")),
            "core.safecrlf=false".into(),
            format!("lfs.storage={}", path("lfs")),
            "gc.auto=0".into(),
            "maintenance.auto=false".into(),
        ];
        for setting in settings {
            command.arg("-c").arg(setting);
        }
        command.args(args);
        command
    }

    async fn run(&self, args: &[&str]) -> Result<std::process::Output, String> {
        finish(self.private(args), args[0]).await
    }

    async fn run_ok(&self, args: &[&str]) -> Result<Vec<u8>, String> {
        let output = self.run(args).await?;
        if output.status.success() {
            Ok(output.stdout)
        } else {
            Err(format!("git {} 失败：{}", args[0], String::from_utf8_lossy(&output.stderr).trim()))
        }
    }

    /// Submodule paths. They are left out of snapshots: adding them would run `git status` in
    /// every submodule on every snapshot.
    async fn gitlinks(&self) -> Result<Vec<String>, String> {
        let listed = self.run_ok(&["ls-files", "--stage", "-z"]).await?;
        Ok(fields(&listed).filter_map(|entry| {
            let (meta, path) = entry.split_once('\t')?;
            meta.starts_with("160000 ").then(|| path.to_string())
        }).collect())
    }

    /// Records the execution directory as a tree in the private objects. Ignored files are left
    /// out; new untracked files over `max_new_file` bytes are listed instead of stored.
    pub async fn take(&self, max_new_file: u64) -> Result<Snapshot, String> {
        let began = Instant::now();
        // Snapshots of one run never overlap, so a lock file here was left by a crash.
        let _ = std::fs::remove_file(self.dir.join("index.lock"));
        let others = self.run_ok(&["ls-files", "-z", "--others", "--exclude-standard"]).await?;
        let mut large = BTreeMap::new();
        let mut spec = String::from(".\0");
        for path in &self.submodules {
            spec.push_str(&format!(":(exclude,literal){path}\0"));
        }
        for path in fields(&others) {
            let Ok(meta) = std::fs::symlink_metadata(self.work.join(&path)) else { continue };
            if meta.is_file() && meta.len() > max_new_file {
                let modified_ms = meta.modified().ok().and_then(|time| time.duration_since(UNIX_EPOCH).ok()).map_or(0, |since| since.as_millis() as u64);
                spec.push_str(&format!(":(exclude,literal){path}\0"));
                large.insert(path, LargeFile { size: meta.len(), modified_ms });
            }
        }
        let spec_path = self.dir.join("pathspec");
        std::fs::write(&spec_path, spec).map_err(|error| io_error("写入快照路径", &spec_path, error))?;
        let spec_arg = format!("--pathspec-from-file={}", spec_path.to_string_lossy());
        let added = self.run(&["add", "-A", "--ignore-errors", &spec_arg, "--pathspec-file-nul"]).await?;
        let partial = match added.status.code() {
            Some(0) => vec![],
            // With --ignore-errors git adds what it can and exits 1 for files it could not read.
            Some(1) => unreadable(&String::from_utf8_lossy(&added.stderr)),
            _ => return Err(format!("快照失败：{}", String::from_utf8_lossy(&added.stderr).trim())),
        };
        let tree = String::from_utf8_lossy(&self.run_ok(&["write-tree"]).await?).trim().to_string();
        Ok(Snapshot { tree, large, partial, duration_ms: began.elapsed().as_millis() as u64 })
    }

    /// Files changed from `from` to `to`, with line counts when `counts` is set.
    pub async fn diff(&self, from: &str, to: &str, counts: bool) -> Result<Vec<ChangedPath>, String> {
        if from == to {
            return Ok(vec![]);
        }
        let mut args = vec!["diff-tree", "-r", "-z", "--no-renames", "--no-ext-diff", "--no-textconv", "--raw"];
        if counts {
            args.push("--numstat");
        }
        args.extend([from, to]);
        Ok(parse_changes(&self.run_ok(&args).await?))
    }

    /// The patch from `from` to `to`, optionally for one path, cut at `max` bytes.
    pub async fn patch(&self, from: &str, to: &str, path: Option<&str>, max: usize) -> Result<(String, bool), String> {
        let literal = path.map(|path| format!(":(literal){path}"));
        let mut args = vec!["diff-tree", "-r", "-p", "--no-color", "--no-ext-diff", "--no-textconv", "--no-renames", from, to];
        if let Some(literal) = &literal {
            args.extend(["--", literal.as_str()]);
        }
        let mut child = self.private(&args).spawn().map_err(|error| format!("无法运行 git：{error}"))?;
        let mut stdout = child.stdout.take().ok_or("无法读取 git 输出。")?;
        let mut buffer = Vec::new();
        tokio::time::timeout(GIT_TIMEOUT, (&mut stdout).take(max as u64 + 1).read_to_end(&mut buffer)).await
            .map_err(|_| "git diff-tree 超时。".to_string())?
            .map_err(|error| format!("读取 git 输出失败：{error}"))?;
        let truncated = buffer.len() > max;
        if truncated {
            buffer.truncate(max);
            let _ = child.kill().await;
        } else {
            drop(stdout);
            let output = tokio::time::timeout(GIT_TIMEOUT, child.wait_with_output()).await
                .map_err(|_| "git diff-tree 超时。".to_string())?
                .map_err(|error| format!("无法运行 git：{error}"))?;
            if !output.status.success() {
                return Err(format!("git diff-tree 失败：{}", String::from_utf8_lossy(&output.stderr).trim()));
            }
        }
        Ok((String::from_utf8_lossy(&buffer).into_owned(), truncated))
    }

    /// Bytes held by the private objects and LFS store.
    pub fn private_bytes(&self) -> u64 {
        let mut total = 0;
        let mut pending = vec![self.dir.join("objects"), self.dir.join("lfs")];
        while let Some(dir) = pending.pop() {
            let Ok(entries) = std::fs::read_dir(&dir) else { continue };
            for entry in entries.flatten() {
                match entry.file_type() {
                    Ok(kind) if kind.is_dir() => pending.push(entry.path()),
                    Ok(kind) if kind.is_file() => total += entry.metadata().map_or(0, |meta| meta.len()),
                    _ => {}
                }
            }
        }
        total
    }
}

/// Paths named by `error: unable to index file '…'`, or the first message when none parse.
fn unreadable(stderr: &str) -> Vec<String> {
    let mut paths: Vec<String> = stderr.lines()
        .filter_map(|line| line.strip_prefix("error: unable to index file '")?.strip_suffix('\'').map(str::to_string))
        .take(MAX_UNREADABLE).collect();
    if paths.is_empty() {
        paths.extend(stderr.lines().map(str::trim).find(|line| !line.is_empty()).map(str::to_string));
    }
    paths
}

/// Parses `diff-tree -z --raw [--numstat]`: raw records (`:modes oids status`, then the path)
/// come first, then numstat records (`added\tdeleted\tpath`, `-` for binary files).
fn parse_changes(bytes: &[u8]) -> Vec<ChangedPath> {
    let mut changes: Vec<ChangedPath> = Vec::new();
    let mut index = HashMap::new();
    let mut records = fields(bytes);
    while let Some(record) = records.next() {
        if let Some(header) = record.strip_prefix(':') {
            let Some(path) = records.next() else { break };
            let status = header.rsplit(' ').next().and_then(|code| code.chars().next()).unwrap_or('M');
            index.insert(path.clone(), changes.len());
            changes.push(ChangedPath { path, status: status.to_string(), ..Default::default() });
        } else {
            let mut parts = record.splitn(3, '\t');
            let (Some(added), Some(deleted), Some(path)) = (parts.next(), parts.next(), parts.next()) else { continue };
            if let Some(&at) = index.get(path) {
                let change = &mut changes[at];
                change.binary = added == "-";
                change.added = added.parse().ok();
                change.deleted = deleted.parse().ok();
            }
        }
    }
    changes
}

#[cfg(test)]
mod tests {
    use super::*;
    use sha2::{Digest, Sha256};

    struct Temp(PathBuf);

    impl Drop for Temp {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn temp() -> Temp {
        let root = std::env::temp_dir().join(format!("sigil-snap-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&root).unwrap();
        Temp(root)
    }

    fn sh(dir: &Path, args: &[&str]) -> String {
        let output = std::process::Command::new("git")
            .args(["-c", "user.name=Sigil Test", "-c", "user.email=sigil@test.invalid", "-c", "commit.gpgsign=false", "-c", "protocol.file.allow=always"])
            .args(args).current_dir(dir).output().unwrap();
        assert!(output.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&output.stderr));
        String::from_utf8_lossy(&output.stdout).trim().to_string()
    }

    fn write(path: &Path, text: &str) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, text).unwrap();
    }

    /// Bytes that do not compress, so a stored copy would show in the private size.
    fn noise(len: usize) -> Vec<u8> {
        let mut state = 0x2545_f491_u32;
        (0..len).map(|_| { state ^= state << 13; state ^= state >> 17; state ^= state << 5; state as u8 }).collect()
    }

    fn repo(root: &Path) -> PathBuf {
        let repo = root.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        sh(&repo, &["init", "-q", "-b", "main"]);
        write(&repo.join("src/a.txt"), "a\n");
        write(&repo.join("docs/b.md"), "b\n");
        write(&repo.join(".gitignore"), "*.log\n");
        sh(&repo, &["add", "-A"]);
        sh(&repo, &["commit", "-q", "-m", "init"]);
        repo
    }

    fn files(repo: &Path, dir: &str) -> Vec<String> {
        let mut found = vec![];
        let mut pending = vec![repo.join(dir)];
        while let Some(dir) = pending.pop() {
            for entry in std::fs::read_dir(&dir).into_iter().flatten().flatten() {
                if entry.file_type().unwrap().is_dir() { pending.push(entry.path()) } else { found.push(entry.path().to_string_lossy().into_owned()) }
            }
        }
        found.sort();
        found
    }

    /// Everything a snapshot must leave alone: index bytes, split-index files, refs, objects
    /// and LFS objects.
    fn repository_state(repo: &Path) -> String {
        let index = format!("{:x}", Sha256::digest(std::fs::read(repo.join(".git/index")).unwrap()));
        let shared: Vec<String> = std::fs::read_dir(repo.join(".git")).unwrap().flatten()
            .map(|entry| entry.file_name().to_string_lossy().into_owned()).filter(|name| name.starts_with("sharedindex")).collect();
        let refs = sh(repo, &["for-each-ref"]);
        let objects = sh(repo, &["count-objects", "-v"]);
        format!("{index}\n{shared:?}\n{refs}\n{objects}\n{:?}", files(repo, ".git/lfs/objects"))
    }

    fn statuses(changes: &[ChangedPath]) -> Vec<String> {
        changes.iter().map(|change| format!("{} {}", change.status, change.path)).collect()
    }

    #[tokio::test]
    async fn snapshots_never_write_the_repository() {
        let root = temp();
        let sub = root.0.join("sub");
        std::fs::create_dir_all(&sub).unwrap();
        sh(&sub, &["init", "-q", "-b", "main"]);
        write(&sub.join("s.txt"), "s\n");
        sh(&sub, &["add", "-A"]);
        sh(&sub, &["commit", "-q", "-m", "sub"]);
        let repo = repo(&root.0);
        write(&repo.join("other/o.txt"), "outside the sparse cone\n");
        write(&repo.join(".gitattributes"), "*.md diff=shout\n");
        sh(&repo, &["config", "diff.shout.textconv", "tr a-z A-Z"]);
        sh(&repo, &["config", "diff.shout.cachetextconv", "true"]);
        let lfs = std::process::Command::new("git").args(["lfs", "version"]).output().is_ok_and(|output| output.status.success());
        if lfs {
            sh(&repo, &["lfs", "install", "--local"]);
            sh(&repo, &["lfs", "track", "*.bin"]);
            std::fs::write(repo.join("model.bin"), noise(4096)).unwrap();
        }
        sh(&repo, &["add", "-A"]);
        sh(&repo, &["commit", "-q", "-m", "more"]);
        sh(&repo, &["submodule", "add", "-q", &sub.to_string_lossy(), "sub"]);
        sh(&repo, &["commit", "-q", "-m", "submodule"]);
        sh(&repo, &["config", "core.splitIndex", "true"]);
        sh(&repo, &["update-index", "--split-index"]);
        sh(&repo, &["sparse-checkout", "set", "src", "docs"]);
        assert!(!repo.join("other").exists(), "sparse checkout removed other/");
        let marker = root.0.join("hook-ran");
        write(&repo.join(".git/hooks/post-index-change"), &format!("#!/bin/sh\necho ran > '{}'\n", marker.to_string_lossy().replace('\\', "/")));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(repo.join(".git/hooks/post-index-change"), std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        let before = repository_state(&repo);

        let dir = root.0.join("private");
        let session = Session::create(&dir, &repo).await.unwrap();
        assert_eq!(session.submodules, ["sub"]);
        let base = session.take(MAX_NEW_FILE_BYTES).await.unwrap();
        write(&repo.join("src/a.txt"), "a\nmore\n");
        write(&repo.join("docs/b.md"), "b\nchanged\n");
        write(&repo.join("src/new.txt"), "new\n");
        write(&repo.join("sub/s.txt"), "s\ndirty\n");
        if lfs {
            std::fs::write(repo.join("model.bin"), noise(5000)).unwrap();
        }
        let next = session.take(MAX_NEW_FILE_BYTES).await.unwrap();
        assert!(next.partial.is_empty(), "{:?}", next.partial);
        let changes = session.diff(&base.tree, &next.tree, true).await.unwrap();
        let mut expected = vec!["M docs/b.md", "M src/a.txt", "A src/new.txt"];
        if lfs {
            expected.insert(1, "M model.bin");
        }
        assert_eq!(statuses(&changes), expected, "sparse entries stay, the submodule is skipped");
        let a = changes.iter().find(|change| change.path == "src/a.txt").unwrap();
        assert_eq!((a.added, a.deleted, a.binary), (Some(1), Some(0), false));
        let (patch, truncated) = session.patch(&base.tree, &next.tree, Some("docs/b.md"), MAX_PATCH_BYTES).await.unwrap();
        assert!(!truncated);
        assert!(patch.contains("+changed") && !patch.contains("CHANGED") && !patch.contains("src/a.txt"), "{patch}");

        assert_eq!(repository_state(&repo), before, "index, split index, refs, objects and LFS objects are untouched");
        assert!(!marker.exists(), "repository hooks never run");
        assert!(!sh(&repo, &["for-each-ref"]).contains("notes"), "no textconv cache ref");
        if lfs {
            assert!(!files(&dir, "lfs").is_empty(), "LFS objects go to the private store");
        }
        let reopened = Session::open(&dir).unwrap();
        assert_eq!(reopened.take(MAX_NEW_FILE_BYTES).await.unwrap().tree, next.tree, "a reopened session continues");
    }

    #[tokio::test]
    async fn large_new_files_are_listed_and_ignored_files_skipped() {
        let root = temp();
        let repo = repo(&root.0);
        let session = Session::create(&root.0.join("private"), &repo).await.unwrap();
        let base = session.take(MAX_NEW_FILE_BYTES).await.unwrap();
        let start = session.private_bytes();
        std::fs::write(repo.join("video.raw"), noise(1_500_000)).unwrap();
        std::fs::write(repo.join("build.log"), noise(1_500_000)).unwrap();
        write(&repo.join("small.txt"), "small\n");
        let next = session.take(MAX_NEW_FILE_BYTES).await.unwrap();
        assert_eq!(next.large.keys().collect::<Vec<_>>(), ["video.raw"]);
        assert_eq!(next.large["video.raw"].size, 1_500_000);
        assert_eq!(statuses(&session.diff(&base.tree, &next.tree, true).await.unwrap()), ["A small.txt"]);
        assert!(session.private_bytes() - start < 100_000, "the large file is not stored");

        let mut big = String::new();
        while big.len() <= 300_000 {
            big.push_str("a line that makes the patch long\n");
        }
        write(&repo.join("src/a.txt"), &big);
        let long = session.take(MAX_NEW_FILE_BYTES).await.unwrap();
        let (patch, truncated) = session.patch(&base.tree, &long.tree, None, MAX_PATCH_BYTES).await.unwrap();
        assert!(truncated);
        assert_eq!(patch.len(), MAX_PATCH_BYTES);
        let (only, _) = session.patch(&base.tree, &long.tree, Some("small.txt"), MAX_PATCH_BYTES).await.unwrap();
        assert!(only.contains("+small") && !only.contains("src/a.txt"));
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn a_locked_file_makes_a_partial_snapshot() {
        use std::os::windows::fs::OpenOptionsExt;
        let root = temp();
        let repo = repo(&root.0);
        let session = Session::create(&root.0.join("private"), &repo).await.unwrap();
        let base = session.take(MAX_NEW_FILE_BYTES).await.unwrap();
        write(&repo.join("src/locked.txt"), "held by another program\n");
        write(&repo.join("src/free.txt"), "free\n");
        let held = std::fs::OpenOptions::new().read(true).share_mode(0).open(repo.join("src/locked.txt")).unwrap();
        let partial = session.take(MAX_NEW_FILE_BYTES).await.unwrap();
        assert_eq!(partial.partial, ["src/locked.txt"]);
        assert_eq!(statuses(&session.diff(&base.tree, &partial.tree, false).await.unwrap()), ["A src/free.txt"]);
        drop(held);
        let whole = session.take(MAX_NEW_FILE_BYTES).await.unwrap();
        assert!(whole.partial.is_empty());
        assert_eq!(statuses(&session.diff(&base.tree, &whole.tree, false).await.unwrap()), ["A src/free.txt", "A src/locked.txt"]);
    }

    #[test]
    fn diff_records_parse_with_counts_and_binary_files() {
        let raw = [
            ":100644 100644 aaa bbb M", "src/a.txt", ":000000 100644 000 ccc A", "img.png", ":100644 000000 ddd 000 D", "gone.txt",
            "3\t1\tsrc/a.txt", "-\t-\timg.png", "0\t4\tgone.txt",
        ].map(|field| format!("{field}\0")).concat();
        let changes = parse_changes(raw.as_bytes());
        assert_eq!(statuses(&changes), ["M src/a.txt", "A img.png", "D gone.txt"]);
        assert_eq!((changes[0].added, changes[0].deleted), (Some(3), Some(1)));
        assert!(changes[1].binary && changes[1].added.is_none());
        assert_eq!(unreadable("error: open(\"x\"): Permission denied\nerror: unable to index file 'src/x y.txt'\n"), ["src/x y.txt"]);
        assert_eq!(unreadable("warning: odd\n"), ["warning: odd"]);
    }
}

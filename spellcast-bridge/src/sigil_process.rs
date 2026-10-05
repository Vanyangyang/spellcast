//! Runs a sigil's verification commands without a shell. The program is resolved like a shell
//! would (on Windows through `PATHEXT`, so `npm` finds `npm.cmd`), the command's whole process
//! tree ends with it (a kill-on-close job on Windows, a process group elsewhere), and stdout and
//! stderr share one pipe of which the last 64 KiB are kept. Contract:
//! docs/sigil-phase1-contract.md, Verification.

use std::borrow::Cow;
use std::collections::VecDeque;
use std::ffi::OsStr;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};

use crate::process_tree::ProcessTree as Tree;
use crate::sigil_snapshot::INHERITED;

/// Output kept for each command run.
pub const MAX_OUTPUT_BYTES: usize = 64 * 1024;
const POLL: Duration = Duration::from_millis(50);
/// How long the output may take to drain once the process tree has ended.
const DRAIN: Duration = Duration::from_secs(5);

/// The newest output of a command, shared with the live view while it runs.
#[derive(Default)]
pub(crate) struct Tail {
    bytes: VecDeque<u8>,
    total: u64,
}

impl Tail {
    fn push(&mut self, chunk: &[u8]) {
        self.total += chunk.len() as u64;
        let keep = &chunk[chunk.len().saturating_sub(MAX_OUTPUT_BYTES)..];
        let overflow = (self.bytes.len() + keep.len()).saturating_sub(MAX_OUTPUT_BYTES);
        self.bytes.drain(..overflow);
        self.bytes.extend(keep);
    }

    pub fn total(&self) -> u64 {
        self.total
    }

    /// The newest output as text, from at most the last `max` bytes.
    pub fn text(&self, max: usize) -> String {
        let start = self.bytes.len().saturating_sub(max);
        let bytes: Vec<u8> = self.bytes.range(start..).copied().collect();
        decode(&bytes, self.total > bytes.len() as u64)
    }
}

#[derive(Debug, Default, Clone)]
pub(crate) struct Outcome {
    /// The resolved program; empty when it was not found.
    pub program: String,
    pub exit_code: Option<i32>,
    pub timed_out: bool,
    /// Ended by Spellcast because the run was aborted or the step started again.
    pub stopped: bool,
    /// Why the command could not run.
    pub error: String,
    pub output: String,
    pub output_bytes: u64,
    pub truncated: bool,
    pub duration_ms: u64,
}

impl Outcome {
    pub fn passed(&self) -> bool {
        self.exit_code == Some(0) && !self.timed_out && !self.stopped && self.error.is_empty()
    }
}

/// Runs `argv` in `dir` until it exits, `timeout` passes or `cancel` is set, then ends its whole
/// process tree. `tail` receives the output as it arrives.
pub(crate) fn run(argv: &[String], dir: &Path, timeout: Duration, cancel: &AtomicBool, tail: &Arc<Mutex<Tail>>) -> Outcome {
    let began = Instant::now();
    let mut outcome = Outcome::default();
    // Stopped before it started, as when the run was aborted a moment earlier.
    if cancel.load(Ordering::Relaxed) {
        outcome.stopped = true;
        return outcome;
    }
    match argv.first().filter(|name| !name.trim().is_empty()) {
        None => outcome.error = "没有要运行的程序。".into(),
        Some(name) => match resolve(name, std::env::var_os("PATH").as_deref(), dir) {
            Err(error) => outcome.error = error,
            Ok(program) => {
                outcome.program = program.to_string_lossy().into_owned();
                if let Err(error) = run_resolved(&program, &argv[1..], dir, timeout, cancel, tail, &mut outcome) {
                    outcome.error = error;
                }
            }
        },
    }
    let tail = tail.lock().unwrap();
    outcome.output = tail.text(MAX_OUTPUT_BYTES);
    outcome.output_bytes = tail.total;
    outcome.truncated = tail.total > tail.bytes.len() as u64;
    outcome.duration_ms = began.elapsed().as_millis() as u64;
    outcome
}

fn run_resolved(program: &Path, args: &[String], dir: &Path, timeout: Duration, cancel: &AtomicBool, tail: &Arc<Mutex<Tail>>,
    outcome: &mut Outcome) -> Result<(), String> {
    let (mut reader, writer) = std::io::pipe().map_err(|error| format!("无法建立输出管道：{error}"))?;
    let error_writer = writer.try_clone().map_err(|error| format!("无法建立输出管道：{error}"))?;
    let mut command = Command::new(program);
    command.args(args).current_dir(dir).stdin(Stdio::null()).stdout(writer).stderr(error_writer);
    for name in INHERITED {
        command.env_remove(name);
    }
    let tree = Tree::prepare(&mut command)?;
    let spawned = command.spawn();
    // The command holds the pipe's write ends; once it is gone only the process tree does, and
    // the reader sees the end of the output when the tree ends.
    drop(command);
    let mut child = spawned.map_err(|error| spawn_error(program, &error))?;
    if let Err(error) = tree.adopt(&child) {
        let _ = child.kill();
        let _ = child.wait();
        return Err(error);
    }
    let (drained, done) = mpsc::channel();
    let sink = Arc::clone(tail);
    std::thread::spawn(move || {
        let mut buffer = vec![0_u8; 16 * 1024];
        while let Ok(read @ 1..) = reader.read(&mut buffer) {
            sink.lock().unwrap().push(&buffer[..read]);
        }
        let _ = drained.send(());
    });
    let began = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                outcome.exit_code = status.code();
                break;
            }
            Ok(None) => {}
            Err(error) => {
                outcome.error = format!("等待命令失败：{error}");
                break;
            }
        }
        if cancel.load(Ordering::Relaxed) {
            outcome.stopped = true;
            break;
        }
        if began.elapsed() >= timeout {
            outcome.timed_out = true;
            break;
        }
        std::thread::sleep(POLL);
    }
    // Every ending ends the whole tree, so no descendant keeps running or holds the pipe.
    tree.end(&mut child);
    let _ = child.wait();
    let _ = done.recv_timeout(DRAIN);
    Ok(())
}

fn spawn_error(program: &Path, error: &std::io::Error) -> String {
    if error.kind() == std::io::ErrorKind::InvalidInput {
        format!("参数无法安全地传给 {}：{error}。批处理文件（.bat、.cmd）的参数不能包含换行等字符。", program.display())
    } else {
        format!("无法启动 {}：{error}", program.display())
    }
}

/// Resolves a program the way a shell would: a name with a path separator against the execution
/// directory, a bare name on `PATH`. On Windows the extensions from `PATHEXT` that
/// `CreateProcess` can start (exe, com, bat, cmd) are tried, because Rust itself only appends
/// `.exe`.
pub(crate) fn resolve(program: &str, path: Option<&OsStr>, dir: &Path) -> Result<PathBuf, String> {
    let separated = program.contains('/') || (cfg!(windows) && program.contains('\\')) || Path::new(program).is_absolute();
    let candidates: Vec<PathBuf> = if separated {
        vec![dir.join(program)]
    } else {
        path.map(|path| std::env::split_paths(path).filter(|entry| entry.is_absolute()).map(|entry| entry.join(program)).collect()).unwrap_or_default()
    };
    candidates.iter().find_map(|candidate| runnable(candidate))
        .ok_or_else(|| if separated { format!("找不到程序 {program}（相对于执行目录）。") } else { format!("在 PATH 里找不到程序 {program}。") })
}

#[cfg(windows)]
fn runnable(candidate: &Path) -> Option<PathBuf> {
    const RUNNABLE: [&str; 4] = ["com", "exe", "bat", "cmd"];
    let extension = candidate.extension().and_then(OsStr::to_str).map(str::to_ascii_lowercase);
    if extension.is_some_and(|extension| RUNNABLE.contains(&extension.as_str())) && candidate.is_file() {
        return Some(candidate.to_path_buf());
    }
    let listed = std::env::var("PATHEXT").unwrap_or_default().to_ascii_lowercase();
    let mut extensions: Vec<&str> = listed.split(';').filter_map(|extension| extension.strip_prefix('.'))
        .filter(|extension| RUNNABLE.contains(extension)).collect();
    if extensions.is_empty() {
        extensions = RUNNABLE.to_vec();
    }
    extensions.into_iter().find_map(|extension| {
        let mut name = candidate.as_os_str().to_owned();
        name.push(".");
        name.push(extension);
        let path = PathBuf::from(name);
        path.is_file().then_some(path)
    })
}

#[cfg(not(windows))]
fn runnable(candidate: &Path) -> Option<PathBuf> {
    use std::os::unix::fs::PermissionsExt;
    let metadata = std::fs::metadata(candidate).ok()?;
    (metadata.is_file() && metadata.permissions().mode() & 0o111 != 0).then(|| candidate.to_path_buf())
}

/// Output as text. Each line decodes as UTF-8, else in the OEM code page (GBK on Chinese
/// Windows), else lossily. Terminal colour codes are dropped, and a carriage return keeps only
/// what follows it, as a terminal shows a progress line. `cut` drops the partial first line of
/// a tail.
pub(crate) fn decode(bytes: &[u8], cut: bool) -> String {
    let bytes = match bytes.iter().position(|byte| *byte == b'\n') {
        Some(index) if cut => &bytes[index + 1..],
        _ => bytes,
    };
    let mut text = String::with_capacity(bytes.len());
    for (index, line) in bytes.split(|byte| *byte == b'\n').enumerate() {
        if index > 0 {
            text.push('\n');
        }
        let line = line.strip_suffix(b"\r").unwrap_or(line);
        let line = line.iter().rposition(|byte| *byte == b'\r').map_or(line, |index| &line[index + 1..]);
        let decoded = match std::str::from_utf8(line) {
            Ok(line) => Cow::Borrowed(line),
            Err(_) => oem(line).map_or_else(|| String::from_utf8_lossy(line), Cow::Owned),
        };
        strip_escapes(&decoded, &mut text);
    }
    text
}

fn strip_escapes(line: &str, text: &mut String) {
    let mut chars = line.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch != '\u{1b}' {
            if ch == '\t' || !ch.is_control() {
                text.push(ch);
            }
            continue;
        }
        match chars.next() {
            // CSI: parameters, then one final byte.
            Some('[') => {
                for ch in chars.by_ref() {
                    if ('@'..='~').contains(&ch) {
                        break;
                    }
                }
            }
            // OSC: until BEL or ESC \.
            Some(']') => {
                while let Some(ch) = chars.next() {
                    if ch == '\u{7}' {
                        break;
                    }
                    if ch == '\u{1b}' {
                        if chars.peek() == Some(&'\\') {
                            chars.next();
                        }
                        break;
                    }
                }
            }
            _ => {}
        }
    }
}

#[cfg(windows)]
fn oem(bytes: &[u8]) -> Option<String> {
    use windows_sys::Win32::Globalization::{MultiByteToWideChar, CP_OEMCP, MB_ERR_INVALID_CHARS};
    let len = i32::try_from(bytes.len()).ok().filter(|len| *len > 0)?;
    // SAFETY: both calls get the buffer lengths they are given.
    unsafe {
        let needed = MultiByteToWideChar(CP_OEMCP, MB_ERR_INVALID_CHARS, bytes.as_ptr(), len, std::ptr::null_mut(), 0);
        if needed <= 0 {
            return None;
        }
        let mut wide = vec![0_u16; needed as usize];
        let written = MultiByteToWideChar(CP_OEMCP, MB_ERR_INVALID_CHARS, bytes.as_ptr(), len, wide.as_mut_ptr(), needed);
        (written > 0).then(|| String::from_utf16_lossy(&wide[..written as usize]))
    }
}

#[cfg(not(windows))]
fn oem(_bytes: &[u8]) -> Option<String> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Dir(PathBuf);

    impl Drop for Dir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn dir() -> Dir {
        let path = std::env::temp_dir().join(format!("sigil-process-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(path.join("tools")).unwrap();
        Dir(path)
    }

    /// Writes `tools/<name>` as a batch file on Windows or an executable shell script elsewhere.
    fn script(dir: &Path, name: &str, windows: &[u8], unix: &str) {
        if cfg!(windows) {
            std::fs::write(dir.join("tools").join(format!("{name}.cmd")), windows).unwrap();
        } else {
            let path = dir.join("tools").join(name);
            std::fs::write(&path, format!("#!/bin/sh\n{unix}")).unwrap();
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
            }
        }
    }

    fn argv(items: &[&str]) -> Vec<String> {
        items.iter().map(|item| item.to_string()).collect()
    }

    fn run_in(dir: &Path, items: &[&str], timeout: Duration) -> Outcome {
        run(&argv(items), dir, timeout, &AtomicBool::new(false), &Arc::new(Mutex::new(Tail::default())))
    }

    /// A background descendant that writes `late.txt` after about two seconds unless it is ended.
    const LATE_WINDOWS: &str = "start \"\" /b cmd /c \"ping -n 3 127.0.0.1 >nul & echo late>late.txt\"\r\n";
    const LATE_UNIX: &str = "(sleep 2; echo late > late.txt) &\n";

    #[test]
    fn commands_pass_and_fail_with_stdout_and_stderr_in_order() {
        let d = dir();
        script(&d.0, "check", b"@echo off\r\necho first\r\necho second 1>&2\r\necho third\r\nexit /b %1\r\n",
            "echo first\necho second 1>&2\necho third\nexit \"$1\"\n");
        let failed = run_in(&d.0, &["tools/check", "3"], Duration::from_secs(30));
        assert_eq!(failed.exit_code, Some(3), "{failed:?}");
        assert!(!failed.passed());
        assert_eq!(failed.output.trim_end().replace(" \n", "\n"), "first\nsecond\nthird", "{failed:?}");
        assert!(!failed.truncated);
        let passed = run_in(&d.0, &["tools/check", "0"], Duration::from_secs(30));
        assert!(passed.passed(), "{passed:?}");
        assert!(passed.program.to_ascii_lowercase().ends_with(if cfg!(windows) { "check.cmd" } else { "check" }), "{}", passed.program);
        let missing = run_in(&d.0, &["no-such-program-for-sigil"], Duration::from_secs(5));
        assert!(missing.error.contains("找不到程序"), "{missing:?}");
        assert!(!missing.passed());
    }

    #[test]
    fn a_timeout_ends_the_whole_process_tree_without_waiting_for_it() {
        let d = dir();
        script(&d.0, "slow", format!("@echo off\r\n{LATE_WINDOWS}echo waiting\r\nping -n 30 127.0.0.1 >nul\r\n").as_bytes(),
            &format!("{LATE_UNIX}echo waiting\nsleep 30\n"));
        let began = Instant::now();
        let outcome = run_in(&d.0, &["tools/slow"], Duration::from_secs(1));
        assert!(outcome.timed_out && !outcome.passed(), "{outcome:?}");
        assert!(began.elapsed() < Duration::from_secs(8), "the output pipe did not keep the run waiting: {:?}", began.elapsed());
        assert!(outcome.output.contains("waiting"), "{outcome:?}");
        std::thread::sleep(Duration::from_secs(4));
        assert!(!d.0.join("late.txt").exists(), "the background descendant was ended");
    }

    #[test]
    fn a_normal_exit_also_ends_descendants_left_behind() {
        let d = dir();
        script(&d.0, "leave", format!("@echo off\r\n{LATE_WINDOWS}echo done\r\n").as_bytes(), &format!("{LATE_UNIX}echo done\n"));
        let began = Instant::now();
        let outcome = run_in(&d.0, &["tools/leave"], Duration::from_secs(30));
        assert!(outcome.passed(), "{outcome:?}");
        assert!(began.elapsed() < Duration::from_secs(8), "{:?}", began.elapsed());
        std::thread::sleep(Duration::from_secs(4));
        assert!(!d.0.join("late.txt").exists(), "the descendant did not outlive the check");
    }

    #[test]
    fn cancelling_stops_a_running_command() {
        let d = dir();
        script(&d.0, "wait", b"@echo off\r\nping -n 30 127.0.0.1 >nul\r\n", "sleep 30\n");
        let cancel = Arc::new(AtomicBool::new(false));
        let flag = Arc::clone(&cancel);
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(500));
            flag.store(true, Ordering::Relaxed);
        });
        let began = Instant::now();
        let outcome = run(&argv(&["tools/wait"]), &d.0, Duration::from_secs(60), &cancel, &Arc::new(Mutex::new(Tail::default())));
        assert!(outcome.stopped && !outcome.timed_out && !outcome.passed(), "{outcome:?}");
        assert!(began.elapsed() < Duration::from_secs(8), "{:?}", began.elapsed());
    }

    #[test]
    fn output_keeps_the_last_64_kib_and_drops_terminal_codes() {
        let d = dir();
        script(&d.0, "loud", b"@echo off\r\nfor /l %%i in (1,1,3000) do @echo line %%i padding-padding-padding-padding\r\n",
            "i=1\nwhile [ $i -le 3000 ]; do echo \"line $i padding-padding-padding-padding\"; i=$((i+1)); done\n");
        let outcome = run_in(&d.0, &["tools/loud"], Duration::from_secs(60));
        assert!(outcome.passed(), "{outcome:?}");
        assert!(outcome.truncated && outcome.output_bytes > MAX_OUTPUT_BYTES as u64, "{}", outcome.output_bytes);
        assert!(outcome.output.len() <= MAX_OUTPUT_BYTES);
        assert!(outcome.output.trim_end().ends_with("line 3000 padding-padding-padding-padding"));
        assert!(outcome.output.starts_with("line "), "the partial first line is dropped");
        assert!(!outcome.output.contains("line 1 "));

        assert_eq!(decode(b"\x1b[32mok\x1b[0m\r\n50%\r100%\r\n\x1b]0;title\x07done\tx\x08", false), "ok\n100%\ndone\tx");
        assert_eq!(decode(b"partial\nwhole\n", true), "whole\n");
        let mut tail = Tail::default();
        tail.push(&vec![b'a'; MAX_OUTPUT_BYTES + 10]);
        tail.push(b"\nend");
        assert_eq!(tail.total(), MAX_OUTPUT_BYTES as u64 + 14);
        assert_eq!(tail.text(16), "end");
    }

    #[test]
    fn arguments_reach_the_program_literally() {
        let d = dir();
        // The batch file prints its arguments as cmd received them, still quoted where needed.
        script(&d.0, "args", b"@echo off\r\necho [%1] [%2]\r\n", "printf '[%s] [%s]\\n' \"$1\" \"$2\"\n");
        let variable = if cfg!(windows) { "%PATH%" } else { "$HOME" };
        let outcome = run_in(&d.0, &["tools/args", "a & echo injected", variable], Duration::from_secs(30));
        assert!(outcome.passed(), "{outcome:?}");
        let output = outcome.output.trim_end();
        assert_eq!(output.lines().count(), 1, "nothing ran as a second command: {output}");
        assert!(output.contains("a & echo injected") && output.contains(variable), "{output}");
        let expanded = std::env::var(if cfg!(windows) { "PATH" } else { "HOME" }).unwrap_or_default();
        assert!(expanded.len() < 3 || !output.contains(&expanded), "the variable was not expanded: {output}");
        if cfg!(windows) {
            let refused = run_in(&d.0, &["tools/args", "two\nlines"], Duration::from_secs(30));
            assert!(refused.error.contains("参数无法安全地传给"), "{refused:?}");
        }
    }

    #[cfg(windows)]
    #[test]
    fn pathext_finds_batch_files_and_npm() {
        let d = dir();
        std::fs::write(d.0.join("tools/fake"), "not runnable").unwrap();
        std::fs::write(d.0.join("tools/fake.cmd"), "@echo off\r\necho fake\r\n").unwrap();
        let path = std::env::join_paths([PathBuf::from("relative-ignored"), d.0.join("tools")]).unwrap();
        let found = resolve("fake", Some(&path), Path::new("C:\\")).unwrap();
        assert!(found.to_string_lossy().to_ascii_lowercase().ends_with("tools\\fake.cmd"), "{found:?}");
        assert!(resolve("fake", Some(OsStr::new("")), &d.0).is_err(), "a bare name is not looked up in the execution directory");
        assert!(resolve("tools\\fake", None, &d.0).is_ok());
        match resolve("npm", std::env::var_os("PATH").as_deref(), &d.0) {
            Ok(npm) => {
                assert!(npm.to_string_lossy().to_ascii_lowercase().ends_with("npm.cmd"), "{npm:?}");
                let outcome = run_in(&d.0, &["npm", "--version"], Duration::from_secs(120));
                assert!(outcome.passed(), "{outcome:?}");
            }
            Err(error) => eprintln!("npm is not installed here; skipped running it: {error}"),
        }
    }

    #[cfg(windows)]
    #[test]
    fn oem_code_page_output_decodes_line_by_line() {
        let d = dir();
        // "中文" in GBK from echo, then "✓ 完成" in UTF-8 from type, which copies the file's bytes
        // (echo would re-encode them through the console code page).
        std::fs::write(d.0.join("tools/utf8.txt"), "✓ 完成\r\n").unwrap();
        std::fs::write(d.0.join("tools/mixed.cmd"), b"@echo off\r\necho \xd6\xd0\xce\xc4\r\ntype tools\\utf8.txt\r\n").unwrap();
        let outcome = run_in(&d.0, &["tools/mixed"], Duration::from_secs(30));
        assert!(outcome.passed(), "{outcome:?}");
        let lines: Vec<&str> = outcome.output.lines().collect();
        assert_eq!(lines.get(1).map(|line| line.trim_end()), Some("✓ 完成"), "{outcome:?}");
        // SAFETY: a plain query.
        if unsafe { windows_sys::Win32::Globalization::GetOEMCP() } == 936 {
            assert_eq!(lines[0].trim_end(), "中文");
        } else {
            assert!(!lines[0].contains('\u{fffd}'), "decoded in the OEM code page: {}", lines[0]);
        }
    }

    /// Runs only when started by `checks_run_without_a_console_window_inside_a_job`.
    #[cfg(windows)]
    #[test]
    #[ignore]
    fn console_probe() {
        use windows_sys::Win32::System::{Console::GetConsoleWindow, JobObjects::IsProcessInJob, Threading::GetCurrentProcess};
        let mut in_job = 0;
        // SAFETY: plain queries on the current process.
        let (window, ok) = unsafe { (GetConsoleWindow(), IsProcessInJob(GetCurrentProcess(), std::ptr::null_mut(), &mut in_job)) };
        println!("console window: {}; in job: {}", !window.is_null(), ok != 0 && in_job != 0);
    }

    #[cfg(windows)]
    #[test]
    fn checks_run_without_a_console_window_inside_a_job() {
        let d = dir();
        let exe = std::env::current_exe().unwrap();
        let outcome = run_in(&d.0, &[&exe.to_string_lossy(), "--exact", "sigil_process::tests::console_probe", "--ignored", "--nocapture",
            "--test-threads=1"], Duration::from_secs(60));
        assert!(outcome.passed(), "{outcome:?}");
        assert!(outcome.output.contains("console window: false; in job: true"), "{}", outcome.output);
    }
}

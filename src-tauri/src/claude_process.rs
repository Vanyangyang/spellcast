//! Which kind of Claude Code run fired a Stop hook. Claude Code starts the hook as a child of its own process, and
//! that process's command line tells a conversation from a one-off question: CC GUI drives every chat as
//! `claude -p --input-format stream-json …`, while a script, or CC GUI's auto-title plugin naming a chat after each
//! turn, runs `claude -p "<one question>" --output-format text`. A one-off run has nobody to notify: whoever started
//! it reads the answer directly, and a card for it is only noise ("正常", or a naming plugin's JSON).

/// Split a Windows command line into arguments: whitespace outside double quotes separates, quotes are dropped.
fn arguments(line: &str) -> Vec<String> {
    let mut out = Vec::new();
    let (mut current, mut quoted, mut started) = (String::new(), false, false);
    for ch in line.chars() {
        match ch {
            '"' => { quoted = !quoted; started = true; }
            c if c.is_whitespace() && !quoted => {
                if started { out.push(std::mem::take(&mut current)); started = false; }
            }
            c => { current.push(c); started = true; }
        }
    }
    if started { out.push(current); }
    out
}

/// `-p`/`--print` without `--input-format`: a single question, not a conversation. Only whole arguments count, so a
/// quoted prompt that happens to say "-p" cannot turn an interactive session into a one-off.
pub fn is_one_shot_print(command_line: &str) -> bool {
    let args = arguments(command_line);
    let print = args.iter().skip(1).any(|a| a == "-p" || a == "--print");
    let streaming = args.iter().any(|a| a == "--input-format" || a.starts_with("--input-format="));
    print && !streaming
}

/// The command line of the `claude` process that started this one, found by walking up at most a few ancestors
/// (a shell may sit in between). `None` when no ancestor is Claude Code or it cannot be read: then nothing is hidden.
#[cfg(windows)]
pub fn claude_command_line() -> Option<String> {
    use windows_sys::Win32::System::Threading::GetCurrentProcessId;
    nearest_claude(unsafe { GetCurrentProcessId() })
}

#[cfg(not(windows))]
pub fn claude_command_line() -> Option<String> { None }

#[cfg(windows)]
fn processes() -> Vec<(u32, u32, String)> {
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
    };
    let mut list = Vec::new();
    unsafe {
        let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snapshot == INVALID_HANDLE_VALUE { return list; }
        let mut entry: PROCESSENTRY32W = std::mem::zeroed();
        entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
        let mut more = Process32FirstW(snapshot, &mut entry) != 0;
        while more {
            let length = entry.szExeFile.iter().position(|&c| c == 0).unwrap_or(entry.szExeFile.len());
            list.push((entry.th32ProcessID, entry.th32ParentProcessID, String::from_utf16_lossy(&entry.szExeFile[..length])));
            more = Process32NextW(snapshot, &mut entry) != 0;
        }
        CloseHandle(snapshot);
    }
    list
}

#[cfg(windows)]
fn nearest_claude(pid: u32) -> Option<String> {
    let all = processes();
    let mut current = pid;
    for _ in 0..4 {
        let parent = all.iter().find(|(id, _, _)| *id == current)?.1;
        let (_, _, exe) = all.iter().find(|(id, _, _)| *id == parent)?;
        if exe.eq_ignore_ascii_case("claude.exe") { return command_line_of(parent); }
        current = parent;
    }
    None
}

/// `NtQueryInformationProcess(ProcessCommandLineInformation)`: needs only PROCESS_QUERY_LIMITED_INFORMATION.
#[cfg(windows)]
fn command_line_of(pid: u32) -> Option<String> {
    use std::ffi::c_void;
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::System::Threading::{OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};
    #[link(name = "ntdll")]
    extern "system" {
        fn NtQueryInformationProcess(process: HANDLE, class: u32, info: *mut c_void, length: u32, returned: *mut u32) -> i32;
    }
    const PROCESS_COMMAND_LINE_INFORMATION: u32 = 60;
    unsafe {
        let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if process.is_null() { return None; }
        let mut needed = 0u32;
        NtQueryInformationProcess(process, PROCESS_COMMAND_LINE_INFORMATION, std::ptr::null_mut(), 0, &mut needed);
        // 8-byte units keep the UNICODE_STRING header aligned for the pointer it holds.
        let mut buffer = vec![0u64; (needed as usize).div_ceil(8).max(2)];
        let status = NtQueryInformationProcess(process, PROCESS_COMMAND_LINE_INFORMATION, buffer.as_mut_ptr().cast(), (buffer.len() * 8) as u32, &mut needed);
        CloseHandle(process);
        if status < 0 { return None; }
        // UNICODE_STRING { Length: u16 (bytes), MaximumLength: u16, Buffer: *u16 } with the text following it;
        // the pointer sits after two u16 and the padding that aligns it, which is one pointer's width in.
        let length = *(buffer.as_ptr().cast::<u16>()) as usize / 2;
        let text = *(buffer.as_ptr().cast::<u8>().add(std::mem::size_of::<usize>()).cast::<*const u16>());
        if text.is_null() { return None; }
        Some(String::from_utf16_lossy(std::slice::from_raw_parts(text, length)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chats_and_one_off_questions_are_told_apart_by_their_flags() {
        // How CC GUI starts a chat (flags as observed on a running install, values shortened).
        assert!(!is_one_shot_print(r#""C:\Users\u\.local\bin\claude.exe" -p --input-format stream-json --output-format stream-json --verbose --model opus --resume a09c1947"#));
        // The auto-title plugin's naming run and its connection test.
        assert!(is_one_shot_print(r#"C:\Users\u\.local\bin\claude.exe -p "你是会话标题编辑器。输入 JSON：{...}" --output-format text --model haiku"#));
        assert!(is_one_shot_print(r#""C:\Users\u\.local\bin\claude.exe" -p 只回复两个字：正常 --output-format text"#));
        assert!(is_one_shot_print("claude --print hi"));
        // Interactive terminal sessions never print, even when a quoted first prompt says "-p" or "--input-format".
        assert!(!is_one_shot_print(r#""C:\Users\u\.local\bin\claude.exe" --resume 38052"#));
        assert!(!is_one_shot_print(r#"claude "explain what -p means in grep""#));
        assert!(!is_one_shot_print(""));
        // The program name is never an argument: a path called -p.exe cannot count.
        assert!(!is_one_shot_print(r#"C:\tools\-p"#));
    }

    #[test]
    fn arguments_follow_windows_quoting() {
        assert_eq!(arguments(r#"a "b c" d"" e"#), vec!["a", "b c", "d", "e"]);
        assert_eq!(arguments("  "), Vec::<String>::new());
        assert_eq!(arguments(r#""" x"#), vec!["", "x"]);
    }

    #[cfg(windows)]
    #[test]
    fn a_process_command_line_and_its_claude_ancestor_can_be_read() {
        use std::process::{Command, Stdio};
        // A stand-in for claude.exe: cmd.exe under that name, running one long child.
        let dir = std::env::temp_dir().join(format!("spellcast-claude-process-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let fake = dir.join("claude.exe");
        std::fs::copy(r"C:\Windows\System32\cmd.exe", &fake).unwrap();
        let mut parent = Command::new(&fake).args(["/c", "ping", "-n", "20", "127.0.0.1"]).stdout(Stdio::null()).spawn().unwrap();
        let mut child = None;
        for _ in 0..40 {
            child = processes().into_iter().find(|(_, ppid, exe)| *ppid == parent.id() && exe.eq_ignore_ascii_case("PING.EXE")).map(|(pid, _, _)| pid);
            if child.is_some() { break; }
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
        let child = child.expect("the stand-in's child started");
        let own = command_line_of(child).expect("a command line");
        assert!(own.to_ascii_lowercase().contains("ping") && own.contains("127.0.0.1"), "{own}");
        let ancestor = nearest_claude(child).expect("the stand-in claude.exe is the child's parent");
        assert!(ancestor.contains("claude.exe") && ancestor.contains("/c ping"), "{ancestor}");
        // An unknown process has no ancestors to read.
        assert!(nearest_claude(u32::MAX).is_none());
        let _ = parent.kill(); let _ = parent.wait();
        let _ = std::fs::remove_dir_all(dir);
    }
}

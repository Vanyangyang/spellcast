//! Bring the CC GUI window to the front. The CC GUI plugin SDK can select a chat but cannot raise the OS
//! window, so a double-clicked completion card does that here.

/// Executable names of CC GUI builds.
const NAMES: &[&str] = &["ccgui-next.exe"];

/// `SPELLCAST_CCGUI_EXE` replaces the names: another CC GUI build, or a test that must not touch the real window.
fn names_from(over: Option<String>) -> Vec<String> {
    match over.map(|name| name.trim().to_ascii_lowercase()).filter(|name| !name.is_empty()) {
        Some(name) => vec![name],
        None => NAMES.iter().map(|name| name.to_string()).collect(),
    }
}

fn is_ccgui(exe: &str, names: &[String]) -> bool {
    names.iter().any(|name| exe.eq_ignore_ascii_case(name))
}

/// Raise the topmost visible CC GUI window. Returns whether it is now the foreground window; a card click
/// still succeeds without that, since the plugin has already switched the chat.
#[cfg(windows)]
pub fn raise() -> bool {
    use windows_sys::Win32::Foundation::{CloseHandle, HWND, INVALID_HANDLE_VALUE, LPARAM};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
    };
    use windows_sys::Win32::System::Threading::{AttachThreadInput, GetCurrentThreadId};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        BringWindowToTop, EnumWindows, GetForegroundWindow, GetWindow, GetWindowTextLengthW,
        GetWindowThreadProcessId, IsIconic, IsWindowVisible, SetForegroundWindow, ShowWindow, GW_OWNER,
        SW_RESTORE,
    };

    struct Search {
        pids: Vec<u32>,
        found: HWND,
    }
    unsafe extern "system" fn visit(hwnd: HWND, lparam: LPARAM) -> i32 {
        let search = &mut *(lparam as *mut Search);
        let mut pid = 0u32;
        GetWindowThreadProcessId(hwnd, &mut pid);
        let top_level = GetWindow(hwnd, GW_OWNER).is_null() && GetWindowTextLengthW(hwnd) > 0;
        if search.pids.contains(&pid) && IsWindowVisible(hwnd) != 0 && top_level {
            search.found = hwnd;
            return 0; // windows are enumerated front to back: the first match is the one used last
        }
        1
    }

    let names = names_from(std::env::var("SPELLCAST_CCGUI_EXE").ok());
    let mut pids = Vec::new();
    unsafe {
        let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snapshot == INVALID_HANDLE_VALUE {
            return false;
        }
        let mut entry: PROCESSENTRY32W = std::mem::zeroed();
        entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
        let mut more = Process32FirstW(snapshot, &mut entry);
        while more != 0 {
            let len = entry.szExeFile.iter().position(|&c| c == 0).unwrap_or(entry.szExeFile.len());
            if is_ccgui(&String::from_utf16_lossy(&entry.szExeFile[..len]), &names) {
                pids.push(entry.th32ProcessID);
            }
            more = Process32NextW(snapshot, &mut entry);
        }
        CloseHandle(snapshot);
    }
    if pids.is_empty() {
        return false;
    }
    let mut search = Search { pids, found: std::ptr::null_mut() };
    unsafe {
        EnumWindows(Some(visit), &mut search as *mut Search as LPARAM);
        let hwnd = search.found;
        if hwnd.is_null() {
            return false;
        }
        if IsIconic(hwnd) != 0 {
            ShowWindow(hwnd, SW_RESTORE);
        }
        if SetForegroundWindow(hwnd) == 0 {
            // Only the foreground thread may hand focus over; borrow its input queue for the call.
            let foreground = GetWindowThreadProcessId(GetForegroundWindow(), std::ptr::null_mut());
            let own = GetCurrentThreadId();
            if foreground != 0 && foreground != own {
                AttachThreadInput(own, foreground, 1);
                SetForegroundWindow(hwnd);
                BringWindowToTop(hwnd);
                AttachThreadInput(own, foreground, 0);
            }
        }
        GetForegroundWindow() == hwnd
    }
}

#[cfg(not(windows))]
pub fn raise() -> bool {
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_the_ccgui_executable_by_name_only() {
        let names = names_from(None);
        assert!(is_ccgui("ccgui-next.exe", &names));
        assert!(is_ccgui("CCGUI-Next.EXE", &names));
        for other in ["claude.exe", "ccgui-next.exe.bak", "spellcast.exe", ""] {
            assert!(!is_ccgui(other, &names), "{other}");
        }
    }

    #[test]
    fn the_override_replaces_the_names_and_blank_means_default() {
        assert_eq!(names_from(Some("  My-Build.EXE ".into())), vec!["my-build.exe"]);
        assert_eq!(names_from(Some("   ".into())), names_from(None));
        assert!(!is_ccgui("ccgui-next.exe", &names_from(Some("elsewhere.exe".into()))));
    }
}

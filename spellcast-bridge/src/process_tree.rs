//! Keeps a command and its descendants in one process tree for termination.

use std::process::{Child, Command};

/// The command's process tree: a kill-on-close job the command joins before it runs.
#[cfg(windows)]
pub(crate) struct ProcessTree(windows_sys::Win32::Foundation::HANDLE);

#[cfg(windows)]
impl Drop for ProcessTree {
    fn drop(&mut self) {
        // SAFETY: the handle came from CreateJobObjectW and is closed once. Closing it ends
        // anything still in the job.
        unsafe { windows_sys::Win32::Foundation::CloseHandle(self.0) };
    }
}

#[cfg(windows)]
impl ProcessTree {
    pub(crate) fn prepare(command: &mut Command) -> Result<Self, String> {
        use std::os::windows::process::CommandExt;
        use windows_sys::Win32::System::JobObjects::{CreateJobObjectW, JobObjectExtendedLimitInformation, SetInformationJobObject,
            JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE};
        const CREATE_SUSPENDED: u32 = 0x0000_0004;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_SUSPENDED | CREATE_NO_WINDOW);
        // SAFETY: plain Win32 calls with a correctly sized, initialized structure.
        unsafe {
            let handle = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if handle.is_null() {
                return Err("无法建立 Windows Job Object，没有运行命令。".into());
            }
            let tree = ProcessTree(handle);
            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let set = SetInformationJobObject(handle, JobObjectExtendedLimitInformation, &info as *const _ as *const core::ffi::c_void,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32);
            if set == 0 {
                return Err("无法配置 Windows Job Object，没有运行命令。".into());
            }
            Ok(tree)
        }
    }

    /// Puts the suspended command in the job before it can start anything, then lets it run.
    pub(crate) fn adopt(&self, child: &Child) -> Result<(), String> {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
        use windows_sys::Win32::System::Diagnostics::ToolHelp::{CreateToolhelp32Snapshot, Thread32First, Thread32Next, TH32CS_SNAPTHREAD, THREADENTRY32};
        use windows_sys::Win32::System::JobObjects::AssignProcessToJobObject;
        use windows_sys::Win32::System::Threading::{OpenThread, ResumeThread, THREAD_SUSPEND_RESUME};
        // SAFETY: the process handle belongs to `child`; thread handles are closed after use.
        unsafe {
            if AssignProcessToJobObject(self.0, child.as_raw_handle() as _) == 0 {
                return Err("无法把命令放进 Windows Job Object，没有运行命令。".into());
            }
            let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0);
            if snapshot == INVALID_HANDLE_VALUE {
                return Err("无法恢复挂起的命令。".into());
            }
            let mut entry: THREADENTRY32 = std::mem::zeroed();
            entry.dwSize = std::mem::size_of::<THREADENTRY32>() as u32;
            let mut resumed = 0;
            let mut more = Thread32First(snapshot, &mut entry) != 0;
            while more {
                if entry.th32OwnerProcessID == child.id() {
                    let thread = OpenThread(THREAD_SUSPEND_RESUME, 0, entry.th32ThreadID);
                    if !thread.is_null() {
                        if ResumeThread(thread) != u32::MAX {
                            resumed += 1;
                        }
                        CloseHandle(thread);
                    }
                }
                more = Thread32Next(snapshot, &mut entry) != 0;
            }
            CloseHandle(snapshot);
            if resumed == 0 {
                return Err("无法恢复挂起的命令。".into());
            }
        }
        Ok(())
    }

    pub(crate) fn end(&self, _child: &mut Child) {
        // SAFETY: the job handle is valid until drop.
        unsafe { windows_sys::Win32::System::JobObjects::TerminateJobObject(self.0, 1) };
    }
}

/// The command's process tree: its own process group. Descendants that leave the group are not
/// reached; phase 1 acceptance covers Windows only.
#[cfg(not(windows))]
pub(crate) struct ProcessTree;

#[cfg(not(windows))]
impl ProcessTree {
    pub(crate) fn prepare(command: &mut Command) -> Result<Self, String> {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
        Ok(ProcessTree)
    }

    pub(crate) fn adopt(&self, _child: &Child) -> Result<(), String> {
        Ok(())
    }

    pub(crate) fn end(&self, child: &mut Child) {
        if let Ok(group) = libc::pid_t::try_from(child.id()) {
            // SAFETY: signals the group the command leads; a group that is already gone is fine.
            unsafe { libc::killpg(group, libc::SIGKILL) };
        }
        let _ = child.kill();
    }
}

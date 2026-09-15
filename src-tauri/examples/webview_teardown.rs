//! Isolated WebView2 teardown smoke. Does not start the Spellcast bridge,
//! does not load production HTML/dist, and must not touch real Roaming.

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use tauri::Manager;

#[cfg(windows)]
const OUTER_SUBCLASS_ID: usize = 0x51C4_5C07;

#[cfg(windows)]
struct OuterState {
    log: PathBuf,
    in_destroy: AtomicBool,
}

#[cfg(windows)]
fn marker(path: &PathBuf, name: &str) {
    log_line(path, &format!("marker={name}"));
}

#[cfg(windows)]
unsafe extern "system" fn outer_subclass_proc(
    hwnd: windows_sys::Win32::Foundation::HWND,
    msg: u32,
    wparam: windows_sys::Win32::Foundation::WPARAM,
    lparam: windows_sys::Win32::Foundation::LPARAM,
    _id: usize,
    refdata: usize,
) -> windows_sys::Win32::Foundation::LRESULT {
    use windows_sys::Win32::UI::Shell::{DefSubclassProc, RemoveWindowSubclass};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        SendMessageW, WM_DESTROY, WM_ENTERSIZEMOVE, WM_NCDESTROY, WM_SETFOCUS,
    };
    let state = &*(refdata as *const OuterState);
    match msg {
        WM_DESTROY => {
            state.in_destroy.store(true, Ordering::SeqCst);
            marker(&state.log, "outer_destroy_enter");
            let result = DefSubclassProc(hwnd, msg, wparam, lparam);
            marker(&state.log, "outer_after_def");
            SendMessageW(hwnd, WM_SETFOCUS, 0, 0);
            SendMessageW(hwnd, WM_ENTERSIZEMOVE, 0, 0);
            state.in_destroy.store(false, Ordering::SeqCst);
            result
        }
        WM_SETFOCUS => {
            let nested = state.in_destroy.load(Ordering::SeqCst);
            if nested {
                marker(&state.log, "outer_focus_enter");
            }
            let result = DefSubclassProc(hwnd, msg, wparam, lparam);
            if nested {
                marker(&state.log, "outer_focus_after_def");
            }
            result
        }
        WM_ENTERSIZEMOVE => {
            let nested = state.in_destroy.load(Ordering::SeqCst);
            if nested {
                marker(&state.log, "outer_entersizemove_enter");
            }
            let result = DefSubclassProc(hwnd, msg, wparam, lparam);
            if nested {
                marker(&state.log, "outer_entersizemove_after_def");
            }
            result
        }
        WM_NCDESTROY => {
            let removed = RemoveWindowSubclass(hwnd, Some(outer_subclass_proc), OUTER_SUBCLASS_ID);
            if removed == 0 {
                marker(&state.log, "outer_ncdestroy_remove_failed");
                return DefSubclassProc(hwnd, msg, wparam, lparam);
            }
            marker(&state.log, "outer_ncdestroy_removed");
            let result = DefSubclassProc(hwnd, msg, wparam, lparam);
            drop(Box::from_raw(refdata as *mut OuterState));
            result
        }
        _ => DefSubclassProc(hwnd, msg, wparam, lparam),
    }
}

fn log_line(path: &PathBuf, line: &str) {
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .expect("teardown log");
    let _ = writeln!(file, "{line}");
    let _ = writeln!(std::io::stderr(), "{line}");
}

#[cfg(windows)]
fn suppress_windows_error_ui() {
    #[link(name = "kernel32")]
    extern "system" {
        fn SetErrorMode(u_mode: u32) -> u32;
    }
    const SEM_FAILCRITICALERRORS: u32 = 0x0001;
    const SEM_NOGPFAULTERRORBOX: u32 = 0x0002;
    const SEM_NOOPENFILEERRORBOX: u32 = 0x8000;
    unsafe {
        SetErrorMode(SEM_FAILCRITICALERRORS | SEM_NOGPFAULTERRORBOX | SEM_NOOPENFILEERRORBOX);
    }
}

#[cfg(not(windows))]
fn suppress_windows_error_ui() {}

fn isolate_profile() -> PathBuf {
    let root = std::env::var_os("SPELLCAST_TEARDOWN_PROFILE")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            std::env::temp_dir().join(format!("spellcast-teardown-{}", std::process::id()))
        });
    let roaming = root.join("Roaming");
    let local = root.join("Local");
    let webview = root.join("WebView2");
    fs::create_dir_all(&roaming).expect("isolated roaming");
    fs::create_dir_all(&local).expect("isolated local");
    fs::create_dir_all(&webview).expect("isolated webview2");
    std::env::set_var("APPDATA", &roaming);
    std::env::set_var("LOCALAPPDATA", &local);
    std::env::set_var("WEBVIEW2_USER_DATA_FOLDER", &webview);
    root
}

fn main() {
    suppress_windows_error_ui();
    let started = Instant::now();
    let log_path = std::env::var_os("SPELLCAST_TEARDOWN_LOG")
        .map(PathBuf::from)
        .or_else(|| std::env::args_os().nth(1).map(PathBuf::from))
        .unwrap_or_else(|| std::env::temp_dir().join("spellcast-webview-teardown.log"));
    if let Some(parent) = log_path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let _ = fs::write(&log_path, format!("step=main pid={}\n", std::process::id()));
    let profile = isolate_profile();
    log_line(
        &log_path,
        &format!(
            "step=isolate pid={} profile={} appdata={:?} localappdata={:?} webview2={:?}",
            std::process::id(),
            profile.display(),
            std::env::var_os("APPDATA"),
            std::env::var_os("LOCALAPPDATA"),
            std::env::var_os("WEBVIEW2_USER_DATA_FOLDER")
        ),
    );
    let timeout_log = log_path.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(25));
        log_line(&timeout_log, "step=timeout exit=2");
        std::process::exit(2);
    });

    let mut ctx = tauri::generate_context!();
    ctx.config_mut().app.windows.clear();
    ctx.config_mut().identifier = "com.spellcast.teardown".into();

    let log_setup = log_path.clone();
    let app = tauri::Builder::default()
        .setup(move |app| {
            log_line(&log_setup, "step=tauri_setup");
            if let Ok(dir) = app.path().app_data_dir() {
                log_line(
                    &log_setup,
                    &format!("step=app_data_dir {}", dir.display()),
                );
            }
            if let Ok(dir) = app.path().app_config_dir() {
                log_line(
                    &log_setup,
                    &format!("step=app_config_dir {}", dir.display()),
                );
            }
            let url = tauri::WebviewUrl::External("about:blank".parse()?);
            let window = tauri::WebviewWindowBuilder::new(app, "teardown", url)
                .visible(false)
                .skip_taskbar(true)
                .title("spellcast-webview-teardown")
                .inner_size(320.0, 240.0)
                .build()?;
            log_line(&log_setup, "step=blank_window_created_hidden");
            #[cfg(windows)]
            {
                use windows_sys::Win32::UI::Shell::SetWindowSubclass;
                use windows_sys::Win32::UI::WindowsAndMessaging::{
                    GetParent, GetWindowLongPtrW, GWL_STYLE,
                };
                const WS_CHILD: u32 = 0x4000_0000;
                let hwnd = window.hwnd().map_err(|err| err.to_string())?;
                let raw = hwnd.0;
                let (style, parent, is_child) = unsafe {
                    let style = GetWindowLongPtrW(raw, GWL_STYLE);
                    let is_child = (style as u32) & WS_CHILD != 0;
                    let parent = GetParent(raw);
                    (style, parent, is_child)
                };
                log_line(
                    &log_setup,
                    &format!(
                        "step=hwnd value={raw:?} target={raw:?} child={is_child} style=0x{style:x} parent={parent:?} target_eq_hwnd={}",
                        raw == hwnd.0
                    ),
                );
                if is_child {
                    marker(&log_setup, "hwnd_is_child");
                    return Err("HWND is WS_CHILD; refusing GA_ROOT fallback".into());
                }
                let target = raw;
                if target != hwnd.0 {
                    return Err("outer subclass target is not the original HWND".into());
                }
                let state = Box::new(OuterState {
                    log: log_setup.clone(),
                    in_destroy: AtomicBool::new(false),
                });
                let ptr = Box::into_raw(state);
                let ok = unsafe {
                    SetWindowSubclass(
                        target,
                        Some(outer_subclass_proc),
                        OUTER_SUBCLASS_ID,
                        ptr as usize,
                    )
                };
                if ok == 0 {
                    unsafe { drop(Box::from_raw(ptr)); }
                    log_line(&log_setup, "marker=outer_install_failed");
                    return Err("SetWindowSubclass failed".into());
                }
                marker(&log_setup, "outer_install_ok");
                log_line(&log_setup, "step=hwnd_coverage child=false target_eq_hwnd=true");
            }
            let handle = app.handle().clone();
            let log_destroy = log_setup.clone();
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_millis(600));
                let handle2 = handle.clone();
                let log_destroy2 = log_destroy.clone();
                let _ = handle.run_on_main_thread(move || {
                    if let Some(window) = handle2.get_webview_window("teardown") {
                        match window.destroy() {
                            Ok(()) => log_line(&log_destroy2, "step=destroy_window"),
                            Err(err) => {
                                log_line(&log_destroy2, &format!("step=destroy_error {err}"))
                            }
                        }
                    } else {
                        log_line(&log_destroy2, "step=missing_window_on_destroy");
                    }
                });
            });
            Ok(())
        })
        .build(ctx)
        .expect("tauri build");

    let log_run = log_path.clone();
    app.run(move |handle, event| match event {
        tauri::RunEvent::WindowEvent {
            label,
            event: tauri::WindowEvent::Destroyed,
            ..
        } => {
            log_line(
                &log_run,
                &format!(
                    "step=tauri_window_destroyed label={label} elapsed_ms={}",
                    started.elapsed().as_millis()
                ),
            );
            log_line(&log_run, "marker=tauriDestroyed");
            log_line(&log_run, "note=native-sync-message-test not-physical-user-focus");
            handle.exit(0);
        }
        tauri::RunEvent::Exit => {
            log_line(
                &log_run,
                &format!("step=exit elapsed_ms={}", started.elapsed().as_millis()),
            );
            log_line(&log_run, "marker=exit0");
        }
        _ => {}
    });
}

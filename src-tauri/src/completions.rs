use crate::{
    ccgui_window,
    completion_hook::{self, Completion},
    completion_speech, desktop, display_target,
};
use std::sync::{Arc, Mutex};
use tauri::{
    AppHandle, Emitter, LogicalSize, Manager, PhysicalPosition, WebviewUrl, WebviewWindowBuilder,
};
use tauri_plugin_opener::OpenerExt;

const LABEL: &str = "completions";
#[derive(Default)]
pub struct CompletionState(Mutex<Vec<Completion>>);

#[tauri::command]
pub fn get_completions(
    state: tauri::State<'_, Arc<CompletionState>>,
) -> Result<Vec<Completion>, String> {
    Ok(state.0.lock().map_err(|e| e.to_string())?.clone())
}

/// A Claude task whose CC GUI window is connected: ask its plugin to open the chat, bring the window forward,
/// and clear the card once the chat reports attention. If it never does, the card stays with an error, as
/// a Codex card does when the app cannot be opened.
async fn open_in_ccgui(app: &AppHandle, root: &std::path::Path, item: &Completion) -> Result<(), String> {
    let silent = || {
        completion_speech::copy(
            root,
            "CC GUI 没有响应。请确认它正在运行，并且 Spellcast 回发插件已连接。",
            "CC GUI did not respond. Make sure it is running and the Spellcast plugin is connected.",
        )
    };
    let bridge = app.state::<crate::AppState>().bridge.clone();
    let ticket = bridge
        .request_host_focus(&completion_hook::claude_source(&item.thread_id))
        .map_err(|_| silent())?;
    // The plugin switches the chat; the SDK cannot raise the window, so that happens here while the click is fresh.
    ccgui_window::raise();
    for _ in 0..30 {
        if bridge.host_focus_acked(&ticket) {
            return completion_hook::dismiss(root, &item.thread_id, &item.turn_id);
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    Err(silent())
}

#[tauri::command]
pub async fn open_completed_task(
    app: AppHandle,
    thread_id: String,
    turn_id: String,
) -> Result<(), String> {
    let root = completion_hook::root()?;
    let item = {
        let state = app.state::<Arc<CompletionState>>();
        let items = state.0.lock().map_err(|e| e.to_string())?;
        items
            .iter()
            .find(|item| item.thread_id == thread_id && item.turn_id == turn_id)
            .cloned()
    };
    let Some(item) = item else {
        return Err(completion_speech::copy(
            &root,
            "这条完成通知已不可用。",
            "That completion notice is no longer available.",
        ));
    };
    if item.host.as_deref() == Some(completion_hook::HOST_CCGUI) {
        return open_in_ccgui(&app, &root, &item).await;
    }
    if item.client != completion_hook::CLIENT_CODEX {
        // Grok Build, and Claude Code outside a connected CC GUI, have no way back to the session; opening just clears the card.
        return completion_hook::dismiss(&root, &thread_id, &turn_id);
    }
    completion_hook::activate(&root, &thread_id, &turn_id, |url| {
        app.opener().open_url(url, None::<&str>).map_err(|_| {
            completion_speech::copy(
                &root,
                "暂时无法打开 Codex，请确认 App 已安装后重试。",
                "Couldn't open Codex. Make sure the app is installed, then try again.",
            )
        })
    })
}

#[tauri::command]
pub fn set_ui_locale(
    app: AppHandle,
    state: tauri::State<'_, crate::AppState>,
    locale: String,
) -> Result<String, String> {
    let locale = state
        .bridge
        .set_ui_locale(&locale)
        .map_err(|err| err.to_string())?;
    let root = completion_hook::root()?;
    let locale = completion_speech::set_ui_locale(&root, &locale)?;
    if let Some(win) = app.get_webview_window(LABEL) {
        let _ = win.set_title(completion_speech::window_title(locale));
    }
    Ok(locale.to_string())
}

#[tauri::command]
pub fn get_completion_voice() -> Result<completion_speech::VoiceSettings, String> {
    completion_speech::settings(&completion_hook::root()?)
}

#[tauri::command]
pub fn set_completion_voice(
    app: AppHandle,
    enabled: bool,
) -> Result<completion_speech::VoiceSettings, String> {
    let settings = completion_speech::set_enabled(&completion_hook::root()?, enabled)?;
    let _ = app.emit("spellcast-completion-voice", &settings);
    Ok(settings)
}

#[tauri::command]
pub fn dismiss_completion(thread_id: String, turn_id: String) -> Result<(), String> {
    completion_hook::dismiss(&completion_hook::root()?, &thread_id, &turn_id)
}

/// The card window is built once, hidden, and then only shown, moved and hidden. Building a
/// transparent always-on-top WebView2 window in the middle of a completion has hung the main
/// thread on Windows; a window that already exists only needs cheap show/hide calls.
fn ensure_window(app: &AppHandle) -> Result<tauri::WebviewWindow, String> {
    if let Some(win) = app.get_webview_window(LABEL) {
        return Ok(win);
    }
    let root = completion_hook::root()?;
    WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("completions.html".into()))
        .title(completion_speech::window_title(
            completion_speech::ui_locale(&root)?,
        ))
        .inner_size(340.0, 160.0)
        .decorations(false)
        .shadow(false)
        .transparent(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .focused(false)
        .resizable(false)
        .maximizable(false)
        .minimizable(false)
        .visible(false)
        .build()
        .map_err(|e| e.to_string())
}

fn show_without_focus(win: &tauri::WebviewWindow) -> Result<(), String> {
    // Keep Tao's visibility flag in sync with the native window. Calling Win32
    // ShowWindow directly leaves that flag hidden, so the next cursor-pass-through
    // change reapplies the hidden state. The builder's focused(false) keeps this
    // managed show from activating the window on Windows.
    win.show().map_err(|err| err.to_string())
}

/// Restore the completion window's topmost Z order without activating it or changing
/// Tao's managed visibility state. Other desktop windows can cover it later.
pub(crate) fn keep_in_front(app: &AppHandle) -> Result<(), String> {
    let Some(win) = app.get_webview_window(LABEL) else { return Ok(()); };
    if !win.is_visible().map_err(|err| err.to_string())? { return Ok(()); }
    #[cfg(windows)]
    {
        use windows_sys::Win32::UI::WindowsAndMessaging::{
            SetWindowPos, HWND_TOPMOST, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE,
        };
        let hwnd = win.hwnd().map_err(|err| err.to_string())?.0;
        if unsafe { SetWindowPos(hwnd, HWND_TOPMOST, 0, 0, 0, 0,
            SWP_NOACTIVATE | SWP_NOMOVE | SWP_NOSIZE) } == 0 {
            return Err(std::io::Error::last_os_error().to_string());
        }
    }
    #[cfg(not(windows))]
    win.set_always_on_top(true).map_err(|err| err.to_string())?;
    Ok(())
}

fn present(app: &AppHandle, items: &[Completion]) -> Result<(), String> {
    if items.is_empty() {
        if let Some(win) = app.get_webview_window(LABEL) {
            let _ = win.emit("spellcast-completions", items);
            win.hide().map_err(|e| e.to_string())?;
        }
        return Ok(());
    }
    let root = completion_hook::root()?;
    // By default the screen holding the foreground window is where the user is looking. A
    // completion is re-anchored to the chosen display every time the list changes, so a card
    // never lands on a screen chosen hours earlier when the window was first created.
    let screens = desktop::list_screens(app)?;
    if screens.is_empty() {
        return Err(completion_speech::copy(&root, "没有显示器。", "No display found."));
    }
    let placed = display_target::resolve(&display_target::current(app), &screens);
    let screen = placed.screen;
    let width = 340.0_f64.min(screen.work_w - 32.0).max(180.0);
    let win = ensure_window(app)?;
    let height = (items.len() as f64 * 160.0 + 68.0)
        .min(screen.work_h - 32.0)
        .max(120.0);
    win.set_size(LogicalSize::new(width, height))
        .map_err(|e| e.to_string())?;
    win.set_position(PhysicalPosition::new(
        ((screen.work_x + screen.work_w - width - 16.0) * screen.scale).round() as i32,
        ((screen.work_y + 16.0) * screen.scale).round() as i32,
    ))
    .map_err(|e| e.to_string())?;
    win.emit("spellcast-completions", items)
        .map_err(|e| e.to_string())?;
    // Set visibility in the native lifecycle, like ordinary bubbles; the page
    // fetches its initial snapshot independently of window creation.
    show_without_focus(&win)?;
    if let Ok(mut on_fixed) = PLACED_ON_FIXED.lock() {
        *on_fixed = placed.on_fixed;
    }
    if let Err(err) = keep_in_front(app) {
        eprintln!("Completion window Z order: {err}");
    }
    Ok(())
}

/// Whether the visible card sits on the remembered fixed display (`Some(false)`: fallback).
static PLACED_ON_FIXED: Mutex<Option<bool>> = Mutex::new(None);

fn card_visible(app: &AppHandle) -> bool {
    app.get_webview_window(LABEL)
        .is_some_and(|win| win.is_visible().unwrap_or(false))
}

/// Re-anchor a visible card after the display target changes. Main thread only.
pub fn reposition(app: &AppHandle) {
    let items = app
        .try_state::<Arc<CompletionState>>()
        .and_then(|state| state.0.lock().ok().map(|items| items.clone()))
        .unwrap_or_default();
    if items.is_empty() || !card_visible(app) {
        return;
    }
    if let Err(err) = present(app, &items) {
        eprintln!("Completion window: {err}");
    }
}

/// Move a visible card when its fixed display disconnects or comes back. Main thread only.
pub fn follow_fixed(app: &AppHandle) {
    if !card_visible(app) {
        return;
    }
    let Ok(screens) = desktop::list_screens(app) else {
        return;
    };
    let now = display_target::resolve(&display_target::current(app), &screens).on_fixed;
    let placed = PLACED_ON_FIXED.lock().map(|on_fixed| *on_fixed).unwrap_or(now);
    if now != placed {
        reposition(app);
    }
}

/// Claude tasks are seen through their CC GUI window: a chat opened after the task finished clears its card,
/// and a connected window lets a double-click go back to the chat.
fn with_hosts(root: &std::path::Path, bridge: &spellcast_bridge::Bridge, items: Vec<Completion>) -> Vec<Completion> {
    let attention = |source: &str| bridge.host_attention(source);
    let mut items = match completion_hook::dismiss_viewed(root, items.clone(), &attention) {
        Ok(kept) => kept,
        Err(err) => {
            eprintln!("Completion read state: {err}");
            items
        }
    };
    completion_hook::mark_openable(&mut items, &|source| bridge.host_attention(source).is_some());
    items
}

pub fn start(app: AppHandle) {
    let mut speech = completion_speech::SpeechPolicy::new(completion_speech::now_ms());
    let state = Arc::new(CompletionState::default());
    app.manage(state.clone());
    let warm = app.clone();
    let _ = app.run_on_main_thread(move || {
        if let Err(err) = ensure_window(&warm) {
            eprintln!("Completion window: {err}");
        }
    });
    std::thread::spawn(move || {
        let Ok(root) = completion_hook::root() else {
            return;
        };
        let Ok(home) = completion_hook::codex_home() else {
            return;
        };
        let mut read_sync = crate::completion_read::ReadSync::default();
        let mut titles = crate::completion_title::Titles::default();
        let mut last_error = String::new();
        loop {
            let next = completion_hook::visible(&root, &home, &mut read_sync);
            match next {
                Ok(mut items) => {
                    last_error.clear();
                    titles.apply(&mut items, &home);
                    let items = match app.try_state::<crate::AppState>() {
                        Some(host) => with_hosts(&root, &host.bridge, items),
                        None => items,
                    };
                    let changed = state.0.lock().map(|old| *old != items).unwrap_or(false);
                    if changed {
                        let items = items.clone();
                        let ui_app = app.clone();
                        let state = state.clone();
                        let (tx, rx) = std::sync::mpsc::sync_channel(1);
                        if app
                            .run_on_main_thread(move || {
                                // Publish before window creation so initial invoke cannot see stale data.
                                let previous =
                                    std::mem::replace(&mut *state.0.lock().unwrap(), items.clone());
                                let result = present(&ui_app, &items);
                                if result.is_err() {
                                    *state.0.lock().unwrap() = previous;
                                }
                                let _ = tx.send(result);
                            })
                            .is_err()
                        {
                            break;
                        }
                        if let Ok(Err(err)) = rx.recv() {
                            eprintln!("Completion window: {err}");
                        }
                    } else if !items.is_empty() {
                        // Reassert while a notice is pending: another desktop window can
                        // cover a previously shown topmost window without changing the inbox.
                        let ui_app = app.clone();
                        let (tx, rx) = std::sync::mpsc::sync_channel(1);
                        if app.run_on_main_thread(move || {
                            let _ = tx.send(keep_in_front(&ui_app));
                        }).is_err() {
                            break;
                        }
                        if let Ok(Err(err)) = rx.recv() {
                            eprintln!("Completion window Z order: {err}");
                        }
                    }
                    if let Err(err) = speech.tick(&root, &items) {
                        eprintln!("Completion speech: {err}");
                    }
                }
                Err(err) => {
                    if err != last_error {
                        eprintln!("Completion inbox: {err}");
                        last_error = err;
                    }
                }
            }
            std::thread::sleep(std::time::Duration::from_secs(1));
        }
    });
}

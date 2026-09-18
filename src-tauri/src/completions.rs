use crate::{completion_hook::{self, Completion}, completion_speech, desktop};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, LogicalSize, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_opener::OpenerExt;

const LABEL: &str = "completions";
#[derive(Default)]
pub struct CompletionState(Mutex<Vec<Completion>>);

#[tauri::command]
pub fn get_completions(state: tauri::State<'_, Arc<CompletionState>>) -> Result<Vec<Completion>, String> {
    Ok(state.0.lock().map_err(|e| e.to_string())?.clone())
}

#[tauri::command]
pub fn open_completed_task(app: AppHandle, thread_id: String, turn_id: String) -> Result<(), String> {
    let root = completion_hook::root()?;
    let state = app.state::<Arc<CompletionState>>();
    let item = state.0.lock().map_err(|e| e.to_string())?.iter()
        .find(|item| item.thread_id == thread_id && item.turn_id == turn_id).cloned();
    let Some(item) = item else {
        return Err(completion_speech::copy(&root, "这条完成通知已不可用。", "That completion notice is no longer available."));
    };
    if item.client != completion_hook::CLIENT_CODEX {
        // Grok Build has no deep link back into the terminal; opening just clears the card.
        return completion_hook::dismiss(&root, &thread_id, &turn_id);
    }
    completion_hook::activate(&root, &thread_id, &turn_id,
        |url| app.opener().open_url(url, None::<&str>).map_err(|_| completion_speech::copy(&root,
            "暂时无法打开 Codex，请确认 App 已安装后重试。",
            "Couldn't open Codex. Make sure the app is installed, then try again.")))
}

#[tauri::command]
pub fn set_ui_locale(app: AppHandle, locale: String) -> Result<String, String> {
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
pub fn set_completion_voice(app: AppHandle, enabled: bool) -> Result<completion_speech::VoiceSettings, String> {
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
    if let Some(win) = app.get_webview_window(LABEL) { return Ok(win); }
    let root = completion_hook::root()?;
    WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("completions.html".into()))
        .title(completion_speech::window_title(completion_speech::ui_locale(&root)?))
        .inner_size(340.0, 160.0).decorations(false).shadow(false).transparent(true)
        .always_on_top(true).skip_taskbar(true).focused(false).resizable(false)
        .maximizable(false).minimizable(false).visible(false).build().map_err(|e| e.to_string())
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
    // The screen holding the foreground window is where the user is looking. A completion is
    // re-anchored there every time the list changes, so a card never lands on a screen chosen
    // hours earlier when the window was first created.
    let screens = desktop::list_screens(app)?;
    let screen = screens.iter().find(|s| s.is_active).or_else(|| screens.first())
        .ok_or_else(|| completion_speech::copy(&root, "没有显示器。", "No display found."))?;
    let width = 340.0_f64.min(screen.work_w - 32.0).max(180.0);
    let win = ensure_window(app)?;
    let height = (items.len() as f64 * 140.0 + 68.0).min(screen.work_h - 32.0).max(120.0);
    win.set_size(LogicalSize::new(width, height)).map_err(|e| e.to_string())?;
    win.set_position(PhysicalPosition::new(
        ((screen.work_x + screen.work_w - width - 16.0) * screen.scale).round() as i32,
        ((screen.work_y + 16.0) * screen.scale).round() as i32,
    )).map_err(|e| e.to_string())?;
    win.emit("spellcast-completions", items).map_err(|e| e.to_string())?;
    // Set visibility in the native lifecycle, like ordinary bubbles; the page
    // fetches its initial snapshot independently of window creation.
    win.show().map_err(|e| e.to_string())?;
    Ok(())
}

pub fn start(app: AppHandle) {
    let mut speech = completion_speech::SpeechPolicy::new(completion_speech::now_ms());
    let state = Arc::new(CompletionState::default());
    app.manage(state.clone());
    let warm = app.clone();
    let _ = app.run_on_main_thread(move || {
        if let Err(err) = ensure_window(&warm) { eprintln!("Completion window: {err}"); }
    });
    std::thread::spawn(move || {
        let Ok(root) = completion_hook::root() else { return; };
        let Ok(home) = completion_hook::codex_home() else { return; };
        let mut read_sync = crate::completion_read::ReadSync::default();
        let mut last_error = String::new();
        loop {
            let next = completion_hook::visible(&root, &home, &mut read_sync);
            match next {
                Ok(items) => {
                    last_error.clear();
                    let changed = state.0.lock().map(|old| *old != items).unwrap_or(false);
                    if changed {
                        let items = items.clone();
                        let ui_app = app.clone(); let state = state.clone();
                        let (tx, rx) = std::sync::mpsc::sync_channel(1);
                        if app.run_on_main_thread(move || {
                            // Publish before window creation so initial invoke cannot see stale data.
                            let previous = std::mem::replace(&mut *state.0.lock().unwrap(), items.clone());
                            let result = present(&ui_app, &items);
                            if result.is_err() { *state.0.lock().unwrap() = previous; }
                            let _ = tx.send(result);
                        }).is_err() { break; }
                        if let Ok(Err(err)) = rx.recv() { eprintln!("Completion window: {err}"); }
                    }
                    if let Err(err) = speech.tick(&root, &items) { eprintln!("Completion speech: {err}"); }
                }
                Err(err) => { if err != last_error { eprintln!("Completion inbox: {err}"); last_error = err; } }
            }
            std::thread::sleep(std::time::Duration::from_secs(1));
        }
    });
}

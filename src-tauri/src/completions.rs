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
    let state = app.state::<Arc<CompletionState>>();
    if !state.0.lock().map_err(|e| e.to_string())?.iter().any(|item| item.thread_id == thread_id && item.turn_id == turn_id) {
        return Err("这条完成通知已不可用。".into());
    }
    completion_hook::activate(&completion_hook::root()?, &thread_id, &turn_id,
        |url| app.opener().open_url(url, None::<&str>).map_err(|_| "暂时无法打开 Codex，请确认 App 已安装后重试。".to_string()))
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

fn present(app: &AppHandle, items: &[Completion]) -> Result<(), String> {
    if items.is_empty() {
        if let Some(win) = app.get_webview_window(LABEL) { win.close().map_err(|e| e.to_string())?; }
        return Ok(());
    }
    let win = if let Some(win) = app.get_webview_window(LABEL) { win } else {
        let screens = desktop::list_screens(app)?;
        let screen = screens.iter().find(|s| s.is_active).or_else(|| screens.first()).ok_or("没有显示器。")?;
        let width = 340.0_f64.min(screen.work_w - 32.0).max(180.0);
        let win = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("completions.html".into()))
            .title("Spellcast · 已完成的 Codex 任务")
            .inner_size(width, 160.0).decorations(false).shadow(false).transparent(true)
            .always_on_top(true).skip_taskbar(true).focused(false).resizable(false)
            .maximizable(false).minimizable(false).visible(false).build().map_err(|e| e.to_string())?;
        win.set_position(PhysicalPosition::new(
            ((screen.work_x + screen.work_w - width - 16.0) * screen.scale).round() as i32,
            ((screen.work_y + 16.0) * screen.scale).round() as i32,
        )).map_err(|e| e.to_string())?;
        win
    };
    let monitor = win.current_monitor().map_err(|e| e.to_string())?;
    let max_height = monitor.map(|m| f64::from(m.work_area().size.height) / m.scale_factor() - 32.0).unwrap_or(600.0);
    let width = f64::from(win.inner_size().map_err(|e| e.to_string())?.width) / win.scale_factor().map_err(|e| e.to_string())?;
    win.set_size(LogicalSize::new(width, (items.len() as f64 * 140.0 + 68.0).min(max_height).max(120.0)))
        .map_err(|e| e.to_string())?;
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

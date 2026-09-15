use tauri::Manager;

/// Official single-instance plugin entry. Register this as the first plugin.
/// Existing completion handling in `main` runs before the App starts.
pub fn plugin<R: tauri::Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri_plugin_single_instance::init(|app, _args, _cwd| {
        // Ensure restore runs on the UI thread. Official callback only
        // brings the existing window forward.
        let handle = app.clone();
        let _ = app.run_on_main_thread(move || {
            let Some(win) = handle.get_webview_window("main") else {
                return;
            };
            let _ = win.show();
            let _ = win.unminimize();
            let _ = win.set_focus();
        });
    })
}

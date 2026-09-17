use tauri::{Manager, WebviewWindowBuilder};

/// Official single-instance plugin entry. Register this as the first plugin.
/// Existing completion handling in `main` runs before the App starts.
pub fn plugin<R: tauri::Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri_plugin_single_instance::init(|app, _args, _cwd| {
        // Ensure restore runs on the UI thread. Official callback only
        // brings the existing window forward.
        let handle = app.clone();
        let _ = app.run_on_main_thread(move || restore_main(&handle));
    })
}

/// Show the board, or create it again if the user closed it while completions
/// or the single-instance helper window kept the process alive.
pub(crate) fn restore_main<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.show();
        let _ = win.unminimize();
        let _ = win.set_focus();
        return;
    }
    let Some(config) = app
        .config()
        .app
        .windows
        .iter()
        .find(|window| window.label == "main")
        .cloned()
    else {
        return;
    };
    if let Ok(builder) = WebviewWindowBuilder::from_config(app, &config) {
        let _ = builder.build();
    }
}

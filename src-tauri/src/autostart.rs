//! The OS startup entry is the source of truth, including choices made in the installer.
use tauri::AppHandle;
#[cfg(not(windows))]
use tauri_plugin_autostart::ManagerExt;
#[cfg(windows)]
mod windows;

pub fn plugin<R: tauri::Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri_plugin_autostart::Builder::new()
        // Keep this name in sync with the Windows installer and its uninstall cleanup.
        .app_name("Spellcast")
        .build()
}

#[tauri::command]
pub fn get_autostart_enabled(app: AppHandle) -> Result<bool, String> {
    #[cfg(windows)]
    {
        let _ = app;
        windows::is_enabled().map_err(|error| error.to_string())
    }
    #[cfg(not(windows))]
    app.autolaunch()
        .is_enabled()
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn set_autostart_enabled(app: AppHandle, enabled: bool) -> Result<bool, String> {
    #[cfg(windows)]
    {
        let _ = app;
        windows::set_enabled(enabled).map_err(|error| error.to_string())
    }
    #[cfg(not(windows))]
    {
        let manager = app.autolaunch();
        if enabled {
            manager.enable()
        } else if manager.is_enabled().map_err(|error| error.to_string())? {
            manager.disable()
        } else {
            // Disabling an entry that is already absent is a successful no-op.
            return Ok(false);
        }
        .map_err(|error| error.to_string())?;
        let actual = manager.is_enabled().map_err(|error| error.to_string())?;
        if actual != enabled {
            return Err("The system did not apply the startup setting".into());
        }
        Ok(actual)
    }
}

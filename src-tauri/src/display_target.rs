//! Which physical display desktop bubbles and completion cards appear on.
//! The choice is a user setting, stored beside the other completion preferences.
use crate::{
    completion_hook, completion_speech,
    desktop::{self, DesktopScreen},
};
use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};
use std::{path::Path, sync::Mutex, time::Duration};
use tauri::{AppHandle, Manager};

const KEY: &str = "display_target";

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "mode", rename_all = "snake_case")]
pub enum DisplayTarget {
    /// The display holding the foreground window when a notice arrives. Stored "default"
    /// values from the earlier three-choice setting migrate to this mode.
    #[default]
    #[serde(alias = "default")]
    Active,
    /// One remembered display. The snapshot describes it while it is disconnected.
    Fixed {
        id: String,
        number: usize,
        label: String,
        width: u32,
        height: u32,
    },
}

#[derive(Debug, Deserialize)]
#[serde(tag = "mode", rename_all = "snake_case")]
pub enum TargetRequest {
    #[serde(alias = "default")]
    Active,
    Fixed { id: String },
}

#[derive(Default)]
pub struct TargetState(Mutex<DisplayTarget>);

/// Where a notice lands. `on_fixed` is `Some(false)` while a remembered display is missing.
pub struct Resolved<'a> {
    pub screen: &'a DesktopScreen,
    pub on_fixed: Option<bool>,
}

/// `screens` is never empty; `desktop::list_screens` refuses to return an empty list.
pub fn resolve<'a>(
    target: &DisplayTarget,
    screens: &'a [DesktopScreen],
) -> Resolved<'a> {
    let active = screens.iter().find(|s| s.is_active).unwrap_or(&screens[0]);
    match target {
        DisplayTarget::Active => Resolved { screen: active, on_fixed: None },
        // A missing display falls back to where the user is looking, never to whichever
        // panel now occupies its old slot. The saved choice stays for when it returns.
        DisplayTarget::Fixed { id, .. } => match screens.iter().find(|s| s.id == *id) {
            Some(screen) => Resolved { screen, on_fixed: Some(true) },
            None => Resolved { screen: active, on_fixed: Some(false) },
        },
    }
}

pub fn current(app: &AppHandle) -> DisplayTarget {
    app.try_state::<TargetState>()
        .and_then(|state| state.0.lock().ok().map(|target| target.clone()))
        .unwrap_or_default()
}

pub fn bubble_screen<'a>(
    app: &AppHandle,
    screens: &'a [DesktopScreen],
) -> &'a DesktopScreen {
    resolve(&current(app), screens).screen
}

/// An unreadable or unknown stored value follows the active display; the row is left in place.
fn load(root: &Path) -> DisplayTarget {
    let stored: Option<String> = completion_speech::preferences(root)
        .and_then(|db| {
            db.query_row(
                "SELECT value FROM completion_text WHERE key=?1",
                [KEY],
                |row| row.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())
        })
        .unwrap_or_else(|err| {
            eprintln!("Display target: {err}");
            None
        });
    stored
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

fn save(root: &Path, target: &DisplayTarget) -> Result<(), String> {
    let raw = serde_json::to_string(target).map_err(|e| e.to_string())?;
    completion_speech::preferences(root)?
        .execute(
            "INSERT INTO completion_text(key,value) VALUES (?1,?2)
             ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            [KEY, raw.as_str()],
        )
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    pub target: DisplayTarget,
    pub screens: Vec<DesktopScreen>,
    /// The display holding the Spellcast main window, for "identify current display".
    pub window_screen: Option<String>,
    /// Where a completion card would appear right now.
    pub notice_screen: Option<String>,
    pub fixed_connected: Option<bool>,
}

fn report(app: &AppHandle) -> Result<Report, String> {
    let target = current(app);
    let screens = desktop::list_screens(app)?;
    let window = app
        .get_webview_window("main")
        .and_then(|win| win.current_monitor().ok().flatten());
    let window_screen = window.and_then(|monitor| {
        let (position, size) = (monitor.position(), monitor.size());
        screens
            .iter()
            .find(|s| {
                s.x == position.x && s.y == position.y
                    && s.width == size.width && s.height == size.height
            })
            .map(|s| s.id.clone())
    });
    let resolved = resolve(&target, &screens);
    let (notice_screen, fixed_connected) = (Some(resolved.screen.id.clone()), resolved.on_fixed);
    Ok(Report { target, screens, window_screen, notice_screen, fixed_connected })
}

#[tauri::command]
pub fn display_target_report(app: AppHandle) -> Result<Report, String> {
    report(&app)
}

#[tauri::command]
pub fn set_display_target(app: AppHandle, target: TargetRequest) -> Result<Report, String> {
    let root = completion_hook::root()?;
    let next = match target {
        TargetRequest::Active => DisplayTarget::Active,
        TargetRequest::Fixed { id } => {
            let screens = desktop::list_screens(&app)?;
            let screen = screens.iter().find(|s| s.id == id).ok_or_else(|| {
                completion_speech::copy(
                    &root,
                    "这块显示器已断开，请重新识别后再选。",
                    "That display is no longer connected. Identify it again, then choose it.",
                )
            })?;
            DisplayTarget::Fixed {
                id: screen.id.clone(),
                number: screen.number,
                label: screen.label.clone(),
                width: screen.width,
                height: screen.height,
            }
        }
    };
    save(&root, &next)?;
    if let Some(state) = app.try_state::<TargetState>() {
        *state.0.lock().map_err(|e| e.to_string())? = next;
    }
    // A visible completion card moves now; bubbles already in flight keep their display.
    let ui = app.clone();
    let _ = app.run_on_main_thread(move || crate::completions::reposition(&ui));
    report(&app)
}

pub fn start(app: AppHandle) {
    let target = completion_hook::root().map(|root| load(&root)).unwrap_or_default();
    app.manage(TargetState(Mutex::new(target)));
    // Follow a fixed display that disconnects or reconnects while a card is showing.
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_secs(2));
        if !matches!(current(&app), DisplayTarget::Fixed { .. }) {
            continue;
        }
        let ui = app.clone();
        if app.run_on_main_thread(move || crate::completions::follow_fixed(&ui)).is_err() {
            break;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::desktop::tests::screen;

    fn fixed(id: &str) -> DisplayTarget {
        DisplayTarget::Fixed { id: id.into(), number: 2, label: "Model".into(), width: 1920, height: 1080 }
    }

    #[test]
    fn active_display_is_the_default_for_every_notice() {
        let screens = [screen(0, "a", true, false), screen(1, "b", false, true)];
        assert_eq!(DisplayTarget::default(), DisplayTarget::Active);
        assert_eq!(resolve(&DisplayTarget::Active, &screens).screen.id, "b");
        assert_eq!(resolve(&DisplayTarget::Active, &screens).on_fixed, None);
    }

    #[test]
    fn fixed_display_wins_and_a_missing_one_falls_back_to_active_not_its_old_slot() {
        let screens = [screen(0, "a", true, true), screen(1, "b", false, false)];
        let placed = resolve(&fixed("b"), &screens);
        assert_eq!((placed.screen.id.as_str(), placed.on_fixed), ("b", Some(true)));
        // The remembered panel is gone; another one now sits at index 1 under a new id.
        let after = [screen(0, "a", true, false), screen(1, "c", false, true)];
        let placed = resolve(&fixed("b"), &after);
        assert_eq!((placed.screen.id.as_str(), placed.on_fixed), ("c", Some(false)));
        // Reconnected: the saved choice applies again.
        let back = [screen(0, "a", true, true), screen(1, "b", false, false)];
        assert_eq!(resolve(&fixed("b"), &back).on_fixed, Some(true));
    }

    #[test]
    fn one_or_three_displays_use_the_same_active_and_fixed_rules() {
        let one = [screen(0, "only", true, true)];
        assert_eq!(resolve(&DisplayTarget::Active, &one).screen.id, "only");
        assert_eq!(resolve(&fixed("only"), &one).screen.id, "only");
        let missing = resolve(&fixed("gone"), &one);
        assert_eq!((missing.screen.id.as_str(), missing.on_fixed), ("only", Some(false)));

        let three = [
            screen(0, "left", true, false),
            screen(1, "middle", false, false),
            screen(2, "right", false, true),
        ];
        assert_eq!(resolve(&DisplayTarget::Active, &three).screen.id, "right");
        let chosen = resolve(&fixed("middle"), &three);
        assert_eq!((chosen.screen.id.as_str(), chosen.on_fixed), ("middle", Some(true)));
        let missing = resolve(&fixed("gone"), &three);
        assert_eq!((missing.screen.id.as_str(), missing.on_fixed), ("right", Some(false)));
    }

    #[test]
    fn display_target_survives_restart_and_bad_rows_follow_active() {
        let root = std::env::temp_dir().join(format!("spellcast-display-{}", uuid::Uuid::new_v4()));
        assert_eq!(load(&root), DisplayTarget::Active);
        save(&root, &fixed("path:monitor")).unwrap();
        assert_eq!(load(&root), fixed("path:monitor"));
        save(&root, &DisplayTarget::Active).unwrap();
        assert_eq!(load(&root), DisplayTarget::Active);
        completion_speech::preferences(&root).unwrap()
            .execute("UPDATE completion_text SET value='{\"mode\":\"later\"}' WHERE key=?1", [KEY])
            .unwrap();
        assert_eq!(load(&root), DisplayTarget::Active);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn display_target_wire_format_is_tagged_by_mode() {
        assert_eq!(serde_json::to_value(DisplayTarget::Active).unwrap(), serde_json::json!({"mode": "active"}));
        assert_eq!(serde_json::from_str::<DisplayTarget>(r#"{"mode":"default"}"#).unwrap(), DisplayTarget::Active);
        let request: TargetRequest = serde_json::from_str(r#"{"mode":"fixed","id":"path:x"}"#).unwrap();
        assert!(matches!(request, TargetRequest::Fixed { id } if id == "path:x"));
        assert!(matches!(serde_json::from_str(r#"{"mode":"active"}"#).unwrap(), TargetRequest::Active));
        assert!(matches!(serde_json::from_str(r#"{"mode":"default"}"#).unwrap(), TargetRequest::Active));
    }
}

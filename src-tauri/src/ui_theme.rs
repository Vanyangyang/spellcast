//! Persist the main window's theme with the other completion text preferences.
use crate::{completion_hook, completion_speech};
use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};
use std::path::Path;

const KEY: &str = "ui_theme";

#[derive(Clone, Copy, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ThemePreference {
    Dark,
    Light,
    System,
}

impl ThemePreference {
    fn as_str(self) -> &'static str {
        match self {
            Self::Dark => "dark",
            Self::Light => "light",
            Self::System => "system",
        }
    }
}

fn read(root: &Path) -> Result<Option<ThemePreference>, String> {
    let stored: Option<String> = completion_speech::preferences(root)?
        .query_row(
            "SELECT value FROM completion_text WHERE key=?1",
            [KEY],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    stored.map(|value| match value.as_str() {
        "dark" => Ok(ThemePreference::Dark),
        "light" => Ok(ThemePreference::Light),
        "system" => Ok(ThemePreference::System),
        _ => Err(format!("Invalid stored ui_theme preference: {value}")),
    }).transpose()
}

fn write(root: &Path, preference: ThemePreference) -> Result<ThemePreference, String> {
    completion_speech::preferences(root)?
        .execute(
            "INSERT INTO completion_text(key,value) VALUES (?1,?2)
             ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            [KEY, preference.as_str()],
        )
        .map_err(|e| e.to_string())?;
    Ok(preference)
}

#[tauri::command]
pub fn get_theme_preference() -> Result<Option<ThemePreference>, String> {
    read(&completion_hook::root()?)
}

#[tauri::command]
pub fn set_theme_preference(preference: ThemePreference) -> Result<ThemePreference, String> {
    write(&completion_hook::root()?, preference)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    struct TestRoot(PathBuf);

    impl TestRoot {
        fn new() -> Self {
            Self(std::env::temp_dir().join(format!(
                "spellcast-ui-theme-{}",
                uuid::Uuid::new_v4()
            )))
        }
    }

    impl Drop for TestRoot {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn absent_and_saved_values_survive_reopened_connections() {
        let root = TestRoot::new();
        assert_eq!(read(&root.0).unwrap(), None);
        for preference in [ThemePreference::Light, ThemePreference::Dark, ThemePreference::System] {
            assert_eq!(write(&root.0, preference).unwrap(), preference);
            assert_eq!(read(&root.0).unwrap(), Some(preference));
        }
    }

    #[test]
    fn writing_theme_preserves_other_completion_text() {
        let root = TestRoot::new();
        {
            let db = completion_speech::preferences(&root.0).unwrap();
            db.execute(
                "INSERT INTO completion_text(key,value) VALUES (?1,?2)",
                ["ui_locale", "en"],
            ).unwrap();
        }
        write(&root.0, ThemePreference::Light).unwrap();
        let other: String = completion_speech::preferences(&root.0).unwrap()
            .query_row(
                "SELECT value FROM completion_text WHERE key=?1",
                ["ui_locale"],
                |row| row.get(0),
            ).unwrap();
        assert_eq!(other, "en");
    }

    #[test]
    fn invalid_input_and_stored_row_are_rejected_without_clearing_row() {
        assert!(serde_json::from_str::<ThemePreference>("\"later\"").is_err());
        let root = TestRoot::new();
        {
            let db = completion_speech::preferences(&root.0).unwrap();
            db.execute(
                "INSERT INTO completion_text(key,value) VALUES (?1,?2)",
                [KEY, "later"],
            ).unwrap();
        }
        assert!(read(&root.0).is_err());
        let stored: String = completion_speech::preferences(&root.0).unwrap()
            .query_row(
                "SELECT value FROM completion_text WHERE key=?1",
                [KEY],
                |row| row.get(0),
            ).unwrap();
        assert_eq!(stored, "later");
    }
}

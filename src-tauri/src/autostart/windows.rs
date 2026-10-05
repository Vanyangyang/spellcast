//! Quote Windows executable paths and share the installer's current-user startup entry.
//! The Rust-1.88-compatible plugin otherwise writes Windows paths without quotes.
use std::{io, path::Path};
use winreg::{
    enums::{HKEY_CURRENT_USER, KEY_READ, KEY_SET_VALUE, REG_BINARY},
    RegKey, RegValue,
};

const RUN_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
const APPROVED_KEY: &str =
    r"Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run";
const NAME: &str = "Spellcast";
const APPROVED: [u8; 12] = [2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];

fn optional<T>(result: io::Result<T>) -> io::Result<Option<T>> {
    match result {
        Ok(value) => Ok(Some(value)),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error),
    }
}

fn read(root: &RegKey, run_key: &str, approved_key: &str) -> io::Result<bool> {
    let Some(run) = optional(root.open_subkey_with_flags(run_key, KEY_READ))? else {
        return Ok(false);
    };
    if optional(run.get_value::<String, _>(NAME))?.is_none() {
        return Ok(false);
    }
    let Some(approved) = optional(root.open_subkey_with_flags(approved_key, KEY_READ))? else {
        return Ok(true);
    };
    let Some(value) = optional(approved.get_raw_value(NAME))? else {
        return Ok(true);
    };
    // Match auto-launch's Windows override: the final eight bytes hold the disable timestamp.
    Ok(value.bytes.len() < 8 || value.bytes.iter().rev().take(8).all(|byte| *byte == 0))
}

fn write(
    root: &RegKey,
    run_key: &str,
    approved_key: &str,
    exe: &Path,
    enabled: bool,
) -> io::Result<bool> {
    if enabled {
        let (run, _) = root.create_subkey(run_key)?;
        run.set_value(NAME, &format!("\"{}\"", exe.display()))?;
        if let Some(approved) = optional(root.open_subkey_with_flags(approved_key, KEY_SET_VALUE))?
        {
            approved.set_raw_value(
                NAME,
                &RegValue {
                    vtype: REG_BINARY,
                    bytes: APPROVED.to_vec(),
                },
            )?;
        }
    } else if let Some(run) = optional(root.open_subkey_with_flags(run_key, KEY_SET_VALUE))? {
        optional(run.delete_value(NAME))?;
    }
    let actual = read(root, run_key, approved_key)?;
    if actual != enabled {
        return Err(io::Error::other(
            "The system did not apply the startup setting",
        ));
    }
    Ok(actual)
}

pub fn is_enabled() -> io::Result<bool> {
    read(&RegKey::predef(HKEY_CURRENT_USER), RUN_KEY, APPROVED_KEY)
}

pub fn set_enabled(enabled: bool) -> io::Result<bool> {
    write(
        &RegKey::predef(HKEY_CURRENT_USER),
        RUN_KEY,
        APPROVED_KEY,
        &std::env::current_exe()?,
        enabled,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Fixture {
        root: RegKey,
        path: String,
    }
    impl Fixture {
        fn new() -> Self {
            let path = format!(r"Software\SpellcastAutostartTests\{}", uuid::Uuid::new_v4());
            let (root, _) = RegKey::predef(HKEY_CURRENT_USER)
                .create_subkey(&path)
                .unwrap();
            Self { root, path }
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = RegKey::predef(HKEY_CURRENT_USER).delete_subkey_all(&self.path);
        }
    }

    #[test]
    fn missing_entry_is_off_without_creating_keys_and_disable_is_idempotent() {
        let fixture = Fixture::new();
        assert!(!read(&fixture.root, "Run", "Approved").unwrap());
        assert_eq!(fixture.root.enum_keys().count(), 0);
        assert!(!write(
            &fixture.root,
            "Run",
            "Approved",
            Path::new(r"C:\Test\spellcast.exe"),
            false
        )
        .unwrap());
        assert_eq!(fixture.root.enum_keys().count(), 0);
    }

    #[test]
    fn enabling_quotes_the_full_path_and_disabling_removes_the_entry() {
        let fixture = Fixture::new();
        let exe = Path::new(r"C:\应用目录\Installed App\spellcast.exe");
        assert!(write(&fixture.root, "Run", "Approved", exe, true).unwrap());
        let run = fixture.root.open_subkey("Run").unwrap();
        assert_eq!(
            run.get_value::<String, _>(NAME).unwrap(),
            format!("\"{}\"", exe.display())
        );
        assert!(optional(fixture.root.open_subkey("Approved"))
            .unwrap()
            .is_none());
        assert!(!write(&fixture.root, "Run", "Approved", exe, false).unwrap());
        assert!(optional(run.get_value::<String, _>(NAME))
            .unwrap()
            .is_none());
        assert!(!write(&fixture.root, "Run", "Approved", exe, false).unwrap());
    }

    #[test]
    fn task_manager_disable_is_visible_and_explicit_enable_restores_it() {
        let fixture = Fixture::new();
        let (run, _) = fixture.root.create_subkey("Run").unwrap();
        run.set_value(NAME, &r#""C:\Old App\spellcast.exe""#)
            .unwrap();
        let (approved, _) = fixture.root.create_subkey("Approved").unwrap();
        approved
            .set_raw_value(
                NAME,
                &RegValue {
                    vtype: REG_BINARY,
                    bytes: vec![3, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0],
                },
            )
            .unwrap();
        assert!(!read(&fixture.root, "Run", "Approved").unwrap());
        let exe = Path::new(r"C:\New App\spellcast.exe");
        assert!(write(&fixture.root, "Run", "Approved", exe, true).unwrap());
        assert_eq!(approved.get_raw_value(NAME).unwrap().bytes, APPROVED);
        assert!(read(&fixture.root, "Run", "Approved").unwrap());
        assert!(!write(&fixture.root, "Run", "Approved", exe, false).unwrap());
    }
}

//! Only successful real runs count toward the optional application-start daily limit.
use std::io::Write;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::context::AppHandle;
use crate::services::paths::AppPaths;
use crate::utils::types::remotes::OperationType;

#[derive(Serialize, Deserialize)]
struct Success {
    day: String,
}

#[must_use]
pub fn key(backend: &str, remote: &str, profile: &str, operation: OperationType) -> String {
    let identity = serde_json::json!([backend, remote, profile, operation.config_key()]);
    Sha256::digest(identity.to_string().as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn state_error() -> String {
    crate::localized_error!("backendErrors.backup.dailyStateInvalid")
}

fn state_path(directory: &Path, key: &str) -> Result<PathBuf, String> {
    if key.len() != 64 || !key.bytes().all(|c| c.is_ascii_hexdigit()) {
        return Err(state_error());
    }
    Ok(directory.join(format!("{key}.json")))
}

fn is_due(directory: &Path, key: &str, today: &str) -> Result<bool, String> {
    let path = state_path(directory, key)?;
    let bytes = match std::fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(true),
        Err(_) => return Err(state_error()),
    };
    let success: Success = serde_json::from_slice(&bytes).map_err(|_| state_error())?;
    chrono::NaiveDate::parse_from_str(&success.day, "%Y-%m-%d").map_err(|_| state_error())?;
    Ok(success.day != today)
}

fn save_success(directory: &Path, key: &str, day: &str) -> Result<(), String> {
    let path = state_path(directory, key)?;
    chrono::NaiveDate::parse_from_str(day, "%Y-%m-%d").map_err(|_| state_error())?;
    let bytes = serde_json::to_vec(&Success {
        day: day.to_string(),
    })
    .map_err(|_| state_error())?;
    std::fs::create_dir_all(directory).map_err(|_| state_error())?;
    let mut temp = tempfile::NamedTempFile::new_in(directory).map_err(|_| state_error())?;
    temp.write_all(&bytes).map_err(|_| state_error())?;
    temp.flush().map_err(|_| state_error())?;
    temp.persist(path).map_err(|_| state_error())?;
    Ok(())
}

pub fn due(app: &AppHandle, key: &str) -> Result<bool, String> {
    let directory = AppPaths::from_app_handle(app)
        .map_err(|_| state_error())?
        .config_dir
        .join("backup-run-state");
    is_due(
        &directory,
        key,
        &chrono::Local::now().format("%Y-%m-%d").to_string(),
    )
}

pub fn record_success(app: &AppHandle, key: &str) -> Result<(), String> {
    let directory = AppPaths::from_app_handle(app)
        .map_err(|_| state_error())?
        .config_dir
        .join("backup-run-state");
    save_success(
        &directory,
        key,
        &chrono::Local::now().format("%Y-%m-%d").to_string(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn first_run_does_not_create_state_and_success_is_a_calendar_day_guard() {
        let temp = tempfile::tempdir().unwrap();
        let directory = temp.path().join("state");
        let id = key("local", "NAS", "Default", OperationType::Sync);
        assert!(is_due(&directory, &id, "2026-11-16").unwrap());
        assert!(!directory.exists());
        save_success(&directory, &id, "2026-11-16").unwrap();
        assert!(!is_due(&directory, &id, "2026-11-16").unwrap());
        assert!(is_due(&directory, &id, "2026-11-17").unwrap());
        save_success(&directory, &id, "2026-11-17").unwrap();
        assert!(!is_due(&directory, &id, "2026-11-17").unwrap());
        assert_eq!(std::fs::read_dir(&directory).unwrap().count(), 1);
    }

    #[test]
    fn profiles_operations_and_backends_do_not_share_a_daily_marker() {
        let id = key("local", "NAS", "Default", OperationType::Sync);
        for other in [
            key("remote", "NAS", "Default", OperationType::Sync),
            key("local", "Other", "Default", OperationType::Sync),
            key("local", "NAS", "other", OperationType::Sync),
            key("local", "NAS", "Default", OperationType::Copy),
        ] {
            assert_ne!(id, other);
        }
        assert_eq!(id.len(), 64);
        assert_eq!(id, key("local", "NAS", "Default", OperationType::Sync));
    }

    #[test]
    fn malformed_state_is_never_silently_overwritten_or_counted_as_success() {
        let temp = tempfile::tempdir().unwrap();
        let id = key("local", "NAS", "Default", OperationType::Sync);
        let path = state_path(temp.path(), &id).unwrap();
        for bytes in [b"invalid".as_slice(), br#"{"day":"not-a-date"}"#] {
            std::fs::write(&path, bytes).unwrap();
            assert!(is_due(temp.path(), &id, "2026-11-16").is_err());
            assert_eq!(std::fs::read(&path).unwrap(), bytes);
        }
    }

    #[test]
    fn invalid_keys_and_dates_do_not_create_any_files() {
        let temp = tempfile::tempdir().unwrap();
        let directory = temp.path().join("state");
        for id in ["", "../escape", "/tmp/other", &"z".repeat(64)] {
            assert!(is_due(&directory, id, "2026-11-16").is_err());
            assert!(save_success(&directory, id, "2026-11-16").is_err());
        }
        let id = key("local", "NAS", "Default", OperationType::Sync);
        assert!(save_success(&directory, &id, "bad").is_err());
        assert!(!directory.exists());
    }
}

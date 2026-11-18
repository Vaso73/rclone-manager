//! Version history keeps the source tree, adding timestamps to archived filenames.
//! Existing advanced flags are untouched unless the optional history setting is enabled.
use std::fs::OpenOptions;
use std::path::Path;

use crate::context::AppHandle;
use crate::services::paths::AppPaths;
use serde_json::Value;

fn state_error() -> String {
    crate::localized_error!("backendErrors.backup.historyStateInvalid")
}

/// Atomic receipts prevent timestamp reuse across processes and restarts on this installation.
/// No remote path or credentials are written here; previews never create state.
fn reserve_at(
    directory: &Path,
    now: chrono::DateTime<chrono::Local>,
    dry_run: bool,
) -> Result<String, String> {
    if !dry_run {
        std::fs::create_dir_all(directory).map_err(|_| state_error())?;
    }
    for offset in 0..10_000 {
        let time = now
            .checked_add_signed(chrono::Duration::milliseconds(offset))
            .ok_or_else(state_error)?;
        let stamp = time.format("%Y-%m-%d_%H-%M-%S%.3f").to_string();
        if dry_run {
            return Ok(stamp);
        }
        match OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(directory.join(&stamp))
        {
            Ok(_) => return Ok(stamp),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(_) => return Err(state_error()),
        }
    }
    Err(state_error())
}

pub fn reserve_run(app: &AppHandle, dry_run: bool) -> Result<String, String> {
    let paths = AppPaths::from_app_handle(app).map_err(|_| state_error())?;
    reserve_at(
        &paths.config_dir.join("backup-history-runs"),
        chrono::Local::now(),
        dry_run,
    )
}

#[derive(Debug, PartialEq, Eq)]
struct Location {
    filesystem: String,
    absolute: bool,
    components: Vec<String>,
}

fn invalid() -> String {
    crate::localized_error!("backendErrors.backup.historyPathInvalid")
}

fn location(path: &str, windows: bool) -> Result<Location, String> {
    if path.trim().is_empty() || path.chars().any(char::is_control) {
        return Err(invalid());
    }
    let normalized = if windows {
        path.replace('\\', "/")
    } else {
        path.to_owned()
    };
    let (filesystem, tail, fold_case) = if windows
        && normalized.as_bytes().get(1) == Some(&b':')
        && normalized
            .as_bytes()
            .first()
            .is_some_and(u8::is_ascii_alphabetic)
    {
        if normalized.as_bytes().get(2) != Some(&b'/') {
            return Err(invalid());
        }
        (normalized[..2].to_ascii_lowercase(), &normalized[2..], true)
    } else if windows && normalized.starts_with("//") {
        let rest = &normalized[2..];
        let mut parts = rest.splitn(3, '/');
        let server = parts.next().filter(|s| !s.is_empty()).ok_or_else(invalid)?;
        let share = parts.next().filter(|s| !s.is_empty()).ok_or_else(invalid)?;
        if matches!(server, "." | "?") {
            return Err(invalid());
        }
        (
            format!("//{server}/{share}").to_lowercase(),
            parts.next().unwrap_or(""),
            true,
        )
    } else if let Some((remote, tail)) = normalized.split_once(':') {
        if remote.is_empty() || remote.contains('/') {
            return Err(invalid());
        }
        (format!("{remote}:"), tail, false)
    } else if normalized.starts_with('/') {
        ("/".to_string(), normalized.as_str(), false)
    } else {
        // A remote's CWD is not necessarily the GUI's CWD. Require an unambiguous path.
        return Err(invalid());
    };
    let mut components = Vec::new();
    for component in tail.split('/') {
        match component {
            "" | "." => {}
            ".." => return Err(invalid()),
            value => components.push(if fold_case {
                value.to_lowercase()
            } else {
                value.to_string()
            }),
        }
    }
    Ok(Location {
        filesystem,
        absolute: tail.starts_with('/'),
        components,
    })
}

fn overlaps(a: &Location, b: &Location) -> bool {
    a.filesystem == b.filesystem
        && a.absolute == b.absolute
        && (a.components.starts_with(&b.components) || b.components.starts_with(&a.components))
}

/// Validate before creating any job. History must be outside both mirror and source.
/// Component-aware comparison shared by restore destination validation.
pub fn paths_overlap(first: &str, second: &str, windows: bool) -> Result<bool, String> {
    Ok(overlaps(
        &location(first, windows)?,
        &location(second, windows)?,
    ))
}

pub fn validate_root(
    root: &str,
    dest: &str,
    sources: &[String],
    windows: bool,
) -> Result<(), String> {
    let history = location(root, windows)?;
    let target = location(dest, windows)?;
    if history.filesystem != target.filesystem || history.absolute != target.absolute {
        return Err(crate::localized_error!(
            "backendErrors.backup.historySameFilesystem"
        ));
    }
    if overlaps(&history, &target) {
        return Err(crate::localized_error!(
            "backendErrors.backup.historyOverlap"
        ));
    }
    for source in sources {
        // URL/other virtual sources need not share a filesystem with the archive.
        if let Ok(source) = location(source, windows)
            && overlaps(&history, &source)
        {
            return Err(crate::localized_error!(
                "backendErrors.backup.historyOverlap"
            ));
        }
    }
    Ok(())
}

fn backup_key(key: &str) -> bool {
    key.replace(['_', '-'], "")
        .eq_ignore_ascii_case("backupdir")
}

fn managed_key(key: &str) -> bool {
    backup_key(key)
        || matches!(
            key.replace(['_', '-'], "").to_ascii_lowercase().as_str(),
            "suffix" | "suffixkeepextension"
        )
}

/// One timestamp is shared by a batch. Multiple source roots remain separated.
pub fn apply(
    config: &mut Value,
    root: &str,
    run: &str,
    source_index: usize,
    source_count: usize,
) -> Result<(), String> {
    if run.is_empty()
        || !run
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'-' | b'_' | b'.'))
    {
        return Err(invalid());
    }
    let object = config.as_object_mut().ok_or_else(invalid)?;
    let conflict = |map: &serde_json::Map<String, Value>| {
        map.iter().any(|(key, value)| {
            managed_key(key)
                && !value.is_null()
                && value.as_str() != Some("")
                && value.as_bool() != Some(false)
        })
    };
    if conflict(object)
        || object
            .get("_config")
            .and_then(Value::as_object)
            .is_some_and(conflict)
    {
        return Err(crate::localized_error!(
            "backendErrors.backup.historyConflict"
        ));
    }
    // Remove empty aliases so there is exactly one canonical backup-dir value in the payload.
    object.retain(|key, _| !managed_key(key));
    if let Some(nested) = object.get_mut("_config").and_then(Value::as_object_mut) {
        nested.retain(|key, _| !managed_key(key));
    }
    let mut path = root.trim_end_matches('/').to_string();
    if source_count > 1 {
        path.push_str(&format!("/source-{}", source_index + 1));
    }
    object.insert("BackupDir".to_string(), Value::String(path));
    object.insert("Suffix".to_string(), Value::String(format!("_{run}")));
    object.insert("SuffixKeepExtension".to_string(), Value::Bool(true));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn validates_separate_remote_and_local_history_without_requiring_it_to_exist() {
        for (root, dest, sources, windows) in [
            (
                "NAS:archive/Žlté !!!",
                "NAS:mirror",
                vec!["D:\\LiberKey".into()],
                true,
            ),
            (
                "NAS:/archive",
                "NAS:/mirror",
                vec!["other:data".into()],
                false,
            ),
            ("D:\\history", "d:\\mirror", vec!["D:\\source".into()], true),
            (
                "/mnt/history",
                "/mnt/mirror",
                vec!["/mnt/source".into()],
                false,
            ),
            (
                "\\\\server\\share\\history",
                "\\\\SERVER\\SHARE\\mirror",
                vec![],
                true,
            ),
            ("NAS:mirror-old", "NAS:mirror", vec![], false),
        ] {
            validate_root(root, dest, &sources, windows).unwrap();
        }
    }

    #[test]
    fn rejects_overlap_traversal_unknown_cwd_and_different_filesystems() {
        for (root, dest, sources, windows) in [
            ("NAS:mirror", "NAS:mirror", vec![], false),
            ("NAS:mirror/archive", "NAS:mirror", vec![], false),
            ("NAS:", "NAS:mirror", vec![], false),
            ("NAS:archive/../mirror", "NAS:mirror", vec![], false),
            ("NAS:archive", "OTHER:mirror", vec![], false),
            ("NAS:/archive", "NAS:mirror", vec![], false),
            ("archive", "NAS:mirror", vec![], false),
            ("", "NAS:mirror", vec![], false),
            ("NAS:archive\n", "NAS:mirror", vec![], false),
            (
                "NAS:archive",
                "NAS:mirror",
                vec!["NAS:archive/source".into()],
                false,
            ),
            (
                "D:\\SOURCE\\archive",
                "D:\\mirror",
                vec!["d:\\source".into()],
                true,
            ),
            ("D:archive", "D:\\mirror", vec![], true),
            ("\\\\?\\D:\\archive", "D:\\mirror", vec![], true),
        ] {
            assert!(
                validate_root(root, dest, &sources, windows).is_err(),
                "{root}"
            );
        }
    }

    #[test]
    fn keeps_names_and_tree_in_unique_per_run_and_per_source_archives() {
        let mut config = json!({"checksum": true});
        apply(
            &mut config,
            "NAS:history/",
            "2026-11-16_15-00-00_run1",
            0,
            1,
        )
        .unwrap();
        assert_eq!(
            config,
            json!({"checksum": true, "BackupDir": "NAS:history", "Suffix": "_2026-11-16_15-00-00_run1", "SuffixKeepExtension": true})
        );
        let mut second = json!({});
        apply(&mut second, "NAS:history", "2026-11-16_15-00-00_run2", 1, 2).unwrap();
        assert_eq!(second["BackupDir"], "NAS:history/source-2");
    }

    #[test]
    fn advanced_backup_dir_conflicts_are_rejected_without_mutation() {
        for key in [
            "backup_dir",
            "backup-dir",
            "backupDir",
            "BackupDir",
            "suffix",
            "Suffix",
            "suffix_keep_extension",
            "SuffixKeepExtension",
        ] {
            for nested in [false, true] {
                let entry = json!({key: "NAS:existing"});
                let mut config = if nested {
                    json!({"_config": entry})
                } else {
                    entry
                };
                let original = config.clone();
                assert!(apply(&mut config, "NAS:history", "run", 0, 1).is_err());
                assert_eq!(config, original);
            }
        }
        let mut empty = json!({"BackupDir": "", "_config": {"backup_dir": null, "Checksum": true}});
        apply(&mut empty, "NAS:history", "run", 0, 1).unwrap();
        assert_eq!(
            empty,
            json!({"BackupDir": "NAS:history", "Suffix": "_run", "SuffixKeepExtension": true, "_config": {"Checksum": true}})
        );
    }

    #[test]
    fn timestamp_reservations_survive_repeated_calls_and_previews_do_not_write() {
        let temp = tempfile::tempdir().unwrap();
        let directory = temp.path().join("runs");
        let now = chrono::Local::now();
        let preview = reserve_at(&directory, now, true).unwrap();
        assert!(!directory.exists());
        assert_eq!(preview, reserve_at(&directory, now, false).unwrap());
        let next = reserve_at(&directory, now, false).unwrap();
        assert_ne!(preview, next);
        assert!(chrono::NaiveDateTime::parse_from_str(&next, "%Y-%m-%d_%H-%M-%S%.3f").is_ok());
        assert_eq!(std::fs::read_dir(&directory).unwrap().count(), 2);
    }

    #[test]
    fn concurrent_reservations_are_unique() {
        let temp = tempfile::tempdir().unwrap();
        let now = chrono::Local::now();
        let handles: Vec<_> = (0..12)
            .map(|_| {
                let directory = temp.path().join("runs");
                std::thread::spawn(move || reserve_at(&directory, now, false).unwrap())
            })
            .collect();
        let names: std::collections::HashSet<_> =
            handles.into_iter().map(|h| h.join().unwrap()).collect();
        assert_eq!(names.len(), 12);
    }

    #[test]
    fn invalid_run_names_and_config_are_rejected_without_mutation() {
        for run in ["", "../escape", "a/b", "a\\b", "a\n"] {
            let mut config = json!({"checksum": true});
            let original = config.clone();
            assert!(apply(&mut config, "NAS:history", run, 0, 1).is_err());
            assert_eq!(config, original);
        }
        assert!(apply(&mut Value::Null, "NAS:history", "run", 0, 1).is_err());
    }
}

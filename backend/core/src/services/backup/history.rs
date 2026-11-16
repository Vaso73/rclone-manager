//! Version history uses rclone's backup-dir, with a fresh directory for each run.
//! Existing advanced flags are untouched unless the optional history setting is enabled.
use serde_json::Value;

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

/// One frozen run name is shared by its batch. Multiple sources have separate archives.
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
        map.iter()
            .any(|(key, value)| backup_key(key) && !value.is_null() && value.as_str() != Some(""))
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
    object.retain(|key, _| !backup_key(key));
    if let Some(nested) = object.get_mut("_config").and_then(Value::as_object_mut) {
        nested.retain(|key, _| !backup_key(key));
    }
    let mut path = format!("{}/{run}", root.trim_end_matches('/'));
    if source_count > 1 {
        path.push_str(&format!("/source-{}", source_index + 1));
    }
    object.insert("BackupDir".to_string(), Value::String(path));
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
            json!({"checksum": true, "BackupDir": "NAS:history/2026-11-16_15-00-00_run1"})
        );
        let mut second = json!({});
        apply(&mut second, "NAS:history", "2026-11-16_15-00-00_run2", 1, 2).unwrap();
        assert_eq!(
            second["BackupDir"],
            "NAS:history/2026-11-16_15-00-00_run2/source-2"
        );
    }

    #[test]
    fn advanced_backup_dir_conflicts_are_rejected_without_mutation() {
        for key in ["backup_dir", "backup-dir", "backupDir", "BackupDir"] {
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
            json!({"BackupDir": "NAS:history/run", "_config": {"Checksum": true}})
        );
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

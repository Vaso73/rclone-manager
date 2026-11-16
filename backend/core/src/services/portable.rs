//! Portable paths are stored relative to the installation and resolved before use.
//! Only Local is normalized: a remote backend's paths belong to its own machine.
use std::path::{Path, PathBuf};

use crate::services::settings::AppSettingsManager;

pub fn root(manager: &AppSettingsManager) -> &Path {
    let directory = &manager.config().config_dir;
    directory.parent().unwrap_or(directory)
}

/// Keep explicit external paths; never copy or overwrite a configuration implicitly.
pub fn stored_path(installation: &Path, path: &Path) -> PathBuf {
    path.strip_prefix(installation)
        .ok()
        .filter(|relative| !relative.as_os_str().is_empty())
        .unwrap_or(path)
        .to_path_buf()
}

pub fn resolve_path(installation: &Path, path: &Path) -> PathBuf {
    installation.join(path)
}

pub fn config_path(manager: &AppSettingsManager, configured: Option<&Path>) -> PathBuf {
    configured
        .filter(|path| !path.as_os_str().is_empty())
        .map_or_else(
            || manager.config().config_dir.join("rclone.conf"),
            |path| resolve_path(root(manager), path),
        )
}

/// Normalize old installations once, before the engine starts. Credentials and files stay put.
pub fn prepare_settings(manager: &AppSettingsManager) -> Result<(), String> {
    if let Ok(configured) = manager.get::<String>("core.rclone_binary")
        && !matches!(configured.as_str(), "" | "system")
    {
        let path = Path::new(&configured);
        let stored = stored_path(root(manager), path);
        if stored != path {
            manager.set("core.rclone_binary", &stored).map_err(|error| {
                crate::localized_error!("backendErrors.settings.saveFailed", "error" => error)
            })?;
        }
    }
    Ok(())
}

/// Anchor spawned rclone and its nested core/command processes, never the GUI's global CWD.
#[cfg(not(feature = "librclone"))]
pub fn configure_command(
    command: &mut tokio::process::Command,
    paths: &crate::services::paths::AppPaths,
    configured: Option<&Path>,
) {
    let config = configured
        .filter(|path| !path.as_os_str().is_empty())
        .map_or_else(
            || paths.config_dir.join("rclone.conf"),
            |path| resolve_path(&paths.resource_dir, path),
        );
    let temporary = paths.cache_dir.join("temp");
    command
        .current_dir(&paths.resource_dir)
        .arg("--config")
        .arg(config)
        .arg("--cache-dir")
        .arg(paths.cache_dir.join("rclone"))
        .env("TEMP", &temporary)
        .env("TMP", &temporary)
        .env("TMPDIR", &temporary);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rclone::backend::{BackendManager, types::Backend};
    use crate::utils::constants::LOCAL_BACKEND_NAME;

    fn manager(directory: &Path) -> AppSettingsManager {
        rcman::SettingsManager::builder("portable-path-test", "1")
            .with_config_dir(directory.join("config"))
            .with_schema::<crate::services::settings::schema::AppSettings>()
            .with_credential_config(rcman::CredentialConfig::Custom(std::sync::Arc::new(
                rcman::MemoryBackend::new(),
            )))
            .with_sub_settings(rcman::SubSettingsConfig::singlefile("connections"))
            .build()
            .unwrap()
    }

    #[test]
    fn unicode_spaces_and_exclamations_survive_relocation() {
        let old = Path::new("/old/!!!_LiberKey_!!!/Systémové pomôcky/RCloneManager");
        let new = Path::new("/other drive/!!!_LiberKey_!!!/Nástroje/RCloneManager");
        for file in ["config/rclone.conf", "config/rclone.exe"] {
            let stored = stored_path(old, &old.join(file));
            assert_eq!(stored, Path::new(file));
            assert_eq!(resolve_path(new, &stored), new.join(file));
        }
    }

    #[test]
    fn external_and_prefix_collision_paths_are_preserved() {
        let installation = Path::new("/apps/RCloneManager");
        for path in [
            "/external/rclone.conf",
            "/apps/RCloneManager-other/rclone.conf",
        ] {
            assert_eq!(stored_path(installation, Path::new(path)), Path::new(path));
            assert_eq!(resolve_path(installation, Path::new(path)), Path::new(path));
        }
    }

    #[test]
    fn relative_paths_resolve_against_installation_and_not_system32() {
        let installation = Path::new("/apps/RCloneManager");
        let foreign = Path::new("/Windows/System32");
        assert_eq!(
            resolve_path(installation, Path::new("config/rclone.conf")),
            installation.join("config/rclone.conf")
        );
        assert_ne!(
            resolve_path(installation, Path::new("config/rclone.conf")),
            foreign.join("config/rclone.conf")
        );
    }

    #[test]
    fn default_config_is_local_even_when_appdata_has_another_config() {
        let directory = tempfile::tempdir().unwrap();
        let settings = manager(directory.path());
        for configured in [None, Some(Path::new(""))] {
            assert_eq!(
                config_path(&settings, configured),
                directory.path().join("config/rclone.conf")
            );
        }
    }

    #[test]
    fn old_binary_path_is_normalized_without_changing_other_settings_or_files() {
        let directory = tempfile::tempdir().unwrap();
        let settings = manager(directory.path());
        let binary = directory.path().join("config/rclone.exe");
        std::fs::write(&binary, b"owned binary").unwrap();
        settings.set("core.rclone_binary", &binary).unwrap();
        settings.set("core.bandwidth_limit", &"17M").unwrap();
        prepare_settings(&settings).unwrap();
        prepare_settings(&settings).unwrap();
        assert_eq!(
            settings.get::<PathBuf>("core.rclone_binary").unwrap(),
            Path::new("config/rclone.exe")
        );
        assert_eq!(
            settings.get::<String>("core.bandwidth_limit").unwrap(),
            "17M"
        );
        assert_eq!(std::fs::read(&binary).unwrap(), b"owned binary");
    }

    #[test]
    fn explicit_system_binary_and_external_paths_are_not_rewritten() {
        let directory = tempfile::tempdir().unwrap();
        let settings = manager(directory.path());
        for value in ["system", "", "/external/rclone"] {
            settings.set("core.rclone_binary", &value).unwrap();
            prepare_settings(&settings).unwrap();
            assert_eq!(settings.get::<String>("core.rclone_binary").unwrap(), value);
        }
    }

    #[tokio::test]
    async fn loading_local_normalizes_storage_but_uses_absolute_runtime_path() {
        let directory = tempfile::tempdir().unwrap();
        let settings = manager(directory.path());
        let file = directory.path().join("config/rclone.conf");
        std::fs::write(&file, b"test data stays unchanged").unwrap();
        let mut local = Backend::new_local(LOCAL_BACKEND_NAME);
        local.config_path = Some(file.clone());
        let connections = settings.sub_settings("connections").unwrap();
        connections.set(LOCAL_BACKEND_NAME, &local).unwrap();
        let backends = BackendManager::new();
        backends.load_from_settings(&settings).await.unwrap();
        assert_eq!(
            backends.get(LOCAL_BACKEND_NAME).await.unwrap().config_path,
            Some(file.clone())
        );
        let saved = connections.get_value(LOCAL_BACKEND_NAME).unwrap();
        assert_eq!(
            Path::new(saved["config_path"].as_str().unwrap()),
            Path::new("config/rclone.conf")
        );
        assert_eq!(std::fs::read(file).unwrap(), b"test data stays unchanged");
    }

    #[tokio::test]
    async fn moving_settings_reanchors_config_and_binary_with_old_copy_still_present() {
        let directory = tempfile::tempdir().unwrap();
        let old = directory.path().join("old");
        let new = directory.path().join("new");
        let settings = manager(&old);
        let file = old.join("config/rclone.conf");
        std::fs::write(&file, b"old copy").unwrap();
        settings
            .set("core.rclone_binary", &old.join("config/rclone.exe"))
            .unwrap();
        let mut local = Backend::new_local(LOCAL_BACKEND_NAME);
        local.config_path = Some(file);
        settings
            .sub_settings("connections")
            .unwrap()
            .set(LOCAL_BACKEND_NAME, &local)
            .unwrap();
        prepare_settings(&settings).unwrap();
        BackendManager::new()
            .load_from_settings(&settings)
            .await
            .unwrap();
        drop(settings);
        std::fs::rename(&old, &new).unwrap();
        std::fs::create_dir_all(old.join("config")).unwrap();
        std::fs::write(
            old.join("config/rclone.conf"),
            b"unrelated original location",
        )
        .unwrap();
        let moved = manager(&new);
        let backends = BackendManager::new();
        backends.load_from_settings(&moved).await.unwrap();
        assert_eq!(
            backends.get(LOCAL_BACKEND_NAME).await.unwrap().config_path,
            Some(new.join("config/rclone.conf"))
        );
        let binary = moved.get::<PathBuf>("core.rclone_binary").unwrap();
        assert_eq!(
            resolve_path(root(&moved), &binary),
            new.join("config/rclone.exe")
        );
        assert_eq!(
            std::fs::read(old.join("config/rclone.conf")).unwrap(),
            b"unrelated original location"
        );
    }

    #[tokio::test]
    async fn fresh_local_uses_portable_config_and_remote_backend_paths_are_untouched() {
        let directory = tempfile::tempdir().unwrap();
        let settings = manager(directory.path());
        let mut remote = Backend::new_remote("Server", "10.1.2.3", 51900);
        remote.config_path = Some(PathBuf::from("/server/rclone.conf"));
        settings
            .sub_settings("connections")
            .unwrap()
            .set("Server", &remote)
            .unwrap();
        let backends = BackendManager::new();
        backends.load_from_settings(&settings).await.unwrap();
        assert_eq!(
            backends.get(LOCAL_BACKEND_NAME).await.unwrap().config_path,
            Some(directory.path().join("config/rclone.conf"))
        );
        assert_eq!(
            backends.get("Server").await.unwrap().config_path,
            remote.config_path
        );
    }

    #[cfg(not(feature = "librclone"))]
    #[test]
    fn child_command_pins_paths_and_cwd_without_mutating_the_parent_environment() {
        let directory = tempfile::tempdir().unwrap();
        let paths = crate::services::paths::AppPaths {
            config_dir: directory.path().join("config"),
            cache_dir: directory.path().join("cache"),
            logs_dir: directory.path().join("cache/logs"),
            resource_dir: directory.path().into(),
        };
        let cwd = std::env::current_dir().unwrap();
        let temporary = std::env::var_os("TEMP");
        for configured in [None, Some(Path::new("./config/rclone.conf"))] {
            let mut command = tokio::process::Command::new("rclone");
            configure_command(&mut command, &paths, configured);
            let command = command.as_std();
            assert_eq!(command.get_current_dir(), Some(directory.path()));
            let args: Vec<_> = command.get_args().map(PathBuf::from).collect();
            assert_eq!(args[0], Path::new("--config"));
            assert_eq!(args[1], paths.config_dir.join("rclone.conf"));
            assert_eq!(args[2], Path::new("--cache-dir"));
            assert_eq!(args[3], paths.cache_dir.join("rclone"));
            for (key, value) in command.get_envs() {
                assert!(matches!(key.to_str(), Some("TEMP" | "TMP" | "TMPDIR")));
                assert_eq!(value, Some(paths.cache_dir.join("temp").as_os_str()));
            }
        }
        assert_eq!(std::env::current_dir().unwrap(), cwd);
        assert_eq!(std::env::var_os("TEMP"), temporary);
    }

    #[cfg(windows)]
    #[test]
    fn windows_drive_and_unc_installations_relocate_without_cwd() {
        for (old, new) in [
            (r"D:\LiberKey\RCloneManager", r"E:\USB apps\RCloneManager"),
            (r"\\nas\portable\RCloneManager", r"F:\RCloneManager"),
        ] {
            let path = Path::new(old).join(r"config\rclone.conf");
            let stored = stored_path(Path::new(old), &path);
            assert_eq!(stored, Path::new(r"config\rclone.conf"));
            assert_eq!(
                resolve_path(Path::new(new), &stored),
                Path::new(new).join(r"config\rclone.conf")
            );
        }
    }

    #[cfg(not(feature = "librclone"))]
    fn application(directory: &Path) -> crate::context::AppHandle {
        let app = crate::context::AppHandle::default();
        app.manage(crate::services::paths::AppPaths {
            config_dir: directory.join("config"),
            cache_dir: directory.join("cache"),
            logs_dir: directory.join("cache/logs"),
            resource_dir: directory.to_path_buf(),
        });
        app.manage(manager(directory));
        app
    }

    #[cfg(not(feature = "librclone"))]
    #[test]
    fn binary_resolution_prefers_owned_default_and_never_falls_back_when_it_is_missing() {
        let directory = tempfile::tempdir().unwrap();
        let app = application(directory.path());
        let expected = directory
            .path()
            .join("config")
            .join(crate::rclone::binaries::util::RCLONE_EXECUTABLE);
        assert!(!expected.exists());
        assert_eq!(
            crate::services::check_binaries::read_rclone_binary(&app),
            expected
        );
        std::fs::write(&expected, b"test executable").unwrap();
        assert_eq!(
            crate::services::check_binaries::read_rclone_binary(&app),
            expected
        );
    }

    #[cfg(not(feature = "librclone"))]
    #[test]
    fn relative_binary_and_command_override_are_anchored_to_the_installation() {
        let directory = tempfile::tempdir().unwrap();
        let app = application(directory.path());
        let relative = Path::new("config").join(crate::rclone::binaries::util::RCLONE_EXECUTABLE);
        app.state::<AppSettingsManager>()
            .set("core.rclone_binary", &relative)
            .unwrap();
        let expected = directory.path().join(&relative);
        assert_eq!(
            crate::services::check_binaries::read_rclone_binary(&app),
            expected
        );
        let command = crate::services::check_binaries::build_rclone_command(
            &app,
            relative.to_str(),
            None,
            Some(&["version"]),
        );
        assert_eq!(command.as_std().get_program(), expected.as_os_str());
        assert_eq!(command.as_std().get_current_dir(), Some(directory.path()));
    }

    #[cfg(not(feature = "librclone"))]
    #[tokio::test]
    async fn saving_a_selected_binary_stores_relative_path_and_external_choice_stays_external() {
        let directory = tempfile::tempdir().unwrap();
        let app = application(directory.path());
        let path = directory.path().join("config/rclone.exe");
        crate::services::settings::operations::core::save_setting(
            app.clone(),
            "core".into(),
            "rclone_binary".into(),
            serde_json::json!(path),
        )
        .await
        .unwrap();
        assert_eq!(
            app.state::<AppSettingsManager>()
                .get::<PathBuf>("core.rclone_binary")
                .unwrap(),
            Path::new("config/rclone.exe")
        );
        let external = directory
            .path()
            .parent()
            .unwrap()
            .join("external-rclone.exe");
        crate::services::settings::operations::core::save_setting(
            app.clone(),
            "core".into(),
            "rclone_binary".into(),
            serde_json::json!(external),
        )
        .await
        .unwrap();
        assert_eq!(
            app.state::<AppSettingsManager>()
                .get::<PathBuf>("core.rclone_binary")
                .unwrap(),
            external
        );
    }

    #[cfg(not(feature = "librclone"))]
    #[test]
    fn explicit_external_config_is_not_overwritten_or_replaced_by_the_default() {
        let directory = tempfile::tempdir().unwrap();
        let app = application(directory.path());
        let external = directory
            .path()
            .parent()
            .unwrap()
            .join("external-rclone.conf");
        let command = crate::services::check_binaries::build_rclone_command(
            &app,
            None,
            Some(&external),
            None,
        );
        let arguments: Vec<_> = command.as_std().get_args().map(PathBuf::from).collect();
        assert_eq!(arguments[1], external);
        assert_eq!(
            arguments
                .iter()
                .filter(|argument| *argument == Path::new("--config"))
                .count(),
            1
        );
        assert!(!external.exists());
    }

    #[cfg(all(unix, not(feature = "librclone")))]
    #[tokio::test]
    async fn real_child_reads_only_the_owned_config_from_a_different_parent_cwd() {
        use std::os::unix::fs::PermissionsExt;
        let directory = tempfile::tempdir().unwrap();
        let installation = directory.path().join("!!! portable é !!!");
        let app = application(&installation);
        let paths = app.state::<crate::services::paths::AppPaths>();
        paths.ensure_dirs().unwrap();
        let binary = paths
            .config_dir
            .join(crate::rclone::binaries::util::RCLONE_EXECUTABLE);
        std::fs::write(paths.config_dir.join("rclone.conf"), b"owned config").unwrap();
        std::fs::write(
            &binary,
            r##"#!/bin/sh
[ "$PWD" = "$PORTABLE_TEST_ROOT" ] || exit 11
[ "$1" = "--config" ] || exit 12
[ "$(cat "$2")" = "owned config" ] || exit 13
[ "$3" = "--cache-dir" ] || exit 14
[ "$4" = "$PORTABLE_TEST_ROOT/cache/rclone" ] || exit 15
[ "$TEMP" = "$PORTABLE_TEST_ROOT/cache/temp" ] || exit 16
[ "$TMP" = "$TEMP" ] && [ "$TMPDIR" = "$TEMP" ] || exit 17
"##,
        )
        .unwrap();
        std::fs::set_permissions(&binary, std::fs::Permissions::from_mode(0o700)).unwrap();
        app.state::<AppSettingsManager>()
            .set("core.rclone_binary", &"config/rclone")
            .unwrap();
        let parent = std::env::current_dir().unwrap();
        assert_ne!(parent, installation);
        let output = crate::services::check_binaries::build_rclone_command(
            &app,
            None,
            Some(Path::new("./config/rclone.conf")),
            None,
        )
        .env("PORTABLE_TEST_ROOT", &installation)
        .output()
        .await
        .unwrap();
        assert!(
            output.status.success(),
            "child exit code: {:?}",
            output.status.code()
        );
        assert_eq!(std::env::current_dir().unwrap(), parent);
        assert_eq!(
            std::fs::read(paths.config_dir.join("rclone.conf")).unwrap(),
            b"owned config"
        );
    }
}

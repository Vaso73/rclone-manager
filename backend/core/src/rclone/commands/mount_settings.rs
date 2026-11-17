//! Applied mount options and an identity-checked, backend-bound reconnect operation.
use super::{
    common::resolve_profile_settings,
    mount::{MountParams, mount_remote_inner, unmount_remote_inner},
};
use crate::{
    context::AppHandle,
    rclone::{
        backend::{BackendManager, transport::RcloneTransport},
        state::cache::normalize_mount_path,
    },
    utils::types::{
        origin::Origin,
        remotes::{MountedRemote, MountedSettings, OperationType},
        starter::Starter,
    },
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::future::Future;

fn boolean(value: &Value, names: &[&str]) -> Option<bool> {
    names
        .iter()
        .find_map(|name| value.get(name).and_then(Value::as_bool))
}

fn settings_from_values(
    source: &str,
    payload: &Value,
    globals: &Value,
    stats: &Value,
) -> MountedSettings {
    let network = ["NetworkMode", "network_mode", "network-mode", "networkMode"];
    let readonly = ["ReadOnly", "read_only", "read-only", "readOnly"];
    MountedSettings {
        source: source.to_owned(),
        network_mode: boolean(&payload["mountOpt"], &network)
            .or_else(|| boolean(payload, &network))
            .or_else(|| boolean(&globals["mount"], &network)),
        // The live VFS may have been reused by rclone; its options are authoritative.
        read_only: boolean(&stats["opt"], &readonly)
            .or_else(|| boolean(&payload["vfsOpt"], &readonly))
            .or_else(|| boolean(payload, &readonly))
            .or_else(|| boolean(&globals["vfs"], &readonly)),
    }
}

pub(crate) async fn capture_settings(
    transport: &dyn RcloneTransport,
    source: &str,
    vfs_fs: &str,
    payload: &Value,
) -> MountedSettings {
    let timeout = std::time::Duration::from_secs(2);
    let groups = json!({"groups": ["mount", "vfs"]});
    let fs = json!({"fs": vfs_fs});
    let (globals, stats) = tokio::join!(
        transport.rpc_with_timeout("options/get", Some(&groups), timeout),
        transport.rpc_with_timeout("vfs/stats", Some(&fs), timeout),
    );
    settings_from_values(
        source,
        payload,
        &globals.unwrap_or(Value::Null),
        &stats.unwrap_or(Value::Null),
    )
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReconnectMountParams {
    pub backend_name: String,
    pub remote_name: String,
    pub profile_name: String,
    pub expected_mount_point: String,
    pub expected_fs: String,
    pub expected_execute_id: Option<String>,
}

fn check_mount(
    params: &ReconnectMountParams,
    current: Option<&MountedRemote>,
    target: &str,
    mounts: &[MountedRemote],
) -> Result<(), String> {
    let current =
        current.ok_or_else(|| crate::localized_error!("backendErrors.mount.reconnectChanged"))?;
    if current.fs != params.expected_fs
        || current.execute_id != params.expected_execute_id
        || normalize_mount_path(&current.mount_point)
            != normalize_mount_path(&params.expected_mount_point)
        || crate::utils::types::starter::profile_name(current.starter.as_ref())
            != Some(params.profile_name.as_str())
    {
        return Err(crate::localized_error!(
            "backendErrors.mount.reconnectChanged"
        ));
    }
    if mounts.iter().any(|mount| {
        normalize_mount_path(&mount.mount_point) == normalize_mount_path(target)
            && normalize_mount_path(&mount.mount_point)
                != normalize_mount_path(&current.mount_point)
    }) {
        return Err(
            crate::localized_error!("backendErrors.mount.alreadyInUse", "mountPoint" => target, "remote" => &params.remote_name),
        );
    }
    Ok(())
}

fn check_applied(
    expected: &MountedSettings,
    actual: Option<&MountedSettings>,
) -> Result<(), String> {
    let matches = actual.is_some_and(|actual| {
        actual.source == expected.source
            && (expected.network_mode.is_none() || actual.network_mode == expected.network_mode)
            && (expected.read_only.is_none() || actual.read_only == expected.read_only)
    });
    if !matches {
        return Err(crate::localized_error!(
            "backendErrors.mount.reconnectSettingsDiffer"
        ));
    }
    Ok(())
}

/// Every subsequent step is conditional on the preceding step's success.
async fn reconnect_steps<S, SF, V, VF, M, MF>(stop: S, verify: V, mount: M) -> Result<(), String>
where
    S: FnOnce() -> SF,
    SF: Future<Output = Result<(), String>>,
    V: FnOnce() -> VF,
    VF: Future<Output = Result<(), String>>,
    M: FnOnce() -> MF,
    MF: Future<Output = Result<(), String>>,
{
    stop().await?;
    verify().await?;
    mount().await
}

pub async fn reconnect_mount_profile(
    app: AppHandle,
    params: ReconnectMountParams,
) -> Result<(), String> {
    let manager = app.state::<BackendManager>();
    let backend = manager.get_active().await;
    if backend.name != params.backend_name {
        return Err(crate::localized_error!(
            "backendErrors.mount.reconnectChanged"
        ));
    }
    let cache = manager.remote_cache_for(&backend.name);
    let _guard = cache.mount_operations.lock().await;
    // Resolve and validate the new settings before disconnecting anything.
    let resolved = resolve_profile_settings(
        &app,
        &params.remote_name,
        &params.profile_name,
        OperationType::Mount,
        Some(&params.backend_name),
    )
    .await?;
    let mut planned = MountParams::from_common(params.remote_name.clone(), resolved.params)?;
    #[cfg(target_os = "android")]
    if planned.mount_type == "saf" {
        return Err(crate::localized_error!(
            "backendErrors.mount.reconnectUnsupported"
        ));
    }
    let requested = settings_from_values(
        &planned.source,
        &planned.to_rclone_body()?,
        &Value::Null,
        &Value::Null,
    );
    let remote_name = params.remote_name.clone();
    let profile_name = params.profile_name.clone();
    cache.refresh_mounted_remotes(app.clone(), &backend).await?;
    let mounts = cache.get_mounted_remotes().await;
    let current = cache
        .find_mount_by_profile(&params.remote_name, &params.profile_name)
        .await;
    check_mount(&params, current.as_ref(), &planned.mount_point, &mounts)?;
    let current =
        current.ok_or_else(|| crate::localized_error!("backendErrors.mount.reconnectChanged"))?;
    planned.backend = Some(backend.clone());
    planned.starter = Some(Starter::profile(params.profile_name));
    planned.origin = Some(Origin::Dashboard);
    planned.execute_id = Some(uuid::Uuid::new_v4().to_string());
    reconnect_steps(
        || async {
            unmount_remote_inner(
                app.clone(),
                backend.clone(),
                current.mount_point.clone(),
                params.remote_name,
            )
            .await
            .map(|_| ())
        },
        || async {
            cache.refresh_mounted_remotes(app.clone(), &backend).await?;
            if cache
                .get_mount_by_point(&current.mount_point)
                .await
                .is_some()
            {
                return Err(crate::localized_error!(
                    "backendErrors.mount.reconnectStillMounted"
                ));
            }
            Ok(())
        },
        || async { mount_remote_inner(app.clone(), planned).await },
    )
    .await?;
    let active = cache
        .find_mount_by_profile(&remote_name, &profile_name)
        .await;
    check_applied(
        &requested,
        active.as_ref().and_then(|mount| mount.settings.as_ref()),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};
    fn params() -> ReconnectMountParams {
        ReconnectMountParams {
            backend_name: "Local".into(),
            remote_name: "NAS".into(),
            profile_name: "Disk".into(),
            expected_mount_point: "W:".into(),
            expected_fs: "NAS:".into(),
            expected_execute_id: Some("mount-1".into()),
        }
    }
    fn mounted() -> MountedRemote {
        let mut mount = MountedRemote::new("NAS:", "W:");
        mount.starter = Some(Starter::profile("Disk"));
        mount.execute_id = Some("mount-1".into());
        mount
    }
    #[test]
    fn snapshots_follow_explicit_mount_options_and_live_vfs_and_keep_unknowns_unknown() {
        let settings = settings_from_values(
            "NAS:",
            &json!({"mountOpt":{"NetworkMode":true},"vfsOpt":{"ReadOnly":false}}),
            &json!({"mount":{"NetworkMode":false}}),
            &json!({"opt":{"ReadOnly":true}}),
        );
        assert_eq!(settings.network_mode, Some(true));
        assert_eq!(settings.read_only, Some(true));
        let unknown = settings_from_values("NAS:", &json!({}), &Value::Null, &Value::Null);
        assert_eq!(unknown.network_mode, None);
        assert_eq!(unknown.read_only, None);
        assert_eq!(unknown.source, "NAS:");
    }
    #[test]
    fn snapshots_support_legacy_flags_and_global_defaults_without_retaining_other_options() {
        let settings = settings_from_values(
            "NAS:",
            &json!({"network_mode":false,"read_only":true}),
            &json!({"mount":{"NetworkMode":true},"vfs":{"ReadOnly":false},"secret":"never retained"}),
            &Value::Null,
        );
        assert_eq!(settings.network_mode, Some(false));
        assert_eq!(settings.read_only, Some(true));
        assert!(
            !serde_json::to_string(&settings)
                .unwrap()
                .contains("never retained")
        );
        let settings = settings_from_values(
            "NAS:",
            &json!({}),
            &json!({"mount":{"NetworkMode":false},"vfs":{"ReadOnly":false}}),
            &Value::Null,
        );
        assert_eq!(settings.network_mode, Some(false));
        assert_eq!(settings.read_only, Some(false));
    }
    #[test]
    fn reconnect_rejects_missing_replaced_or_occupied_mounts_before_disconnect() {
        let p = params();
        let old = mounted();
        assert!(check_mount(&p, Some(&old), "V:", std::slice::from_ref(&old)).is_ok());
        assert!(check_mount(&p, None, "V:", &[]).is_err());
        for changed in [
            MountedRemote {
                fs: "Other:".into(),
                ..old.clone()
            },
            MountedRemote {
                execute_id: Some("new".into()),
                ..old.clone()
            },
            MountedRemote {
                mount_point: "X:".into(),
                ..old.clone()
            },
            MountedRemote {
                starter: Some(Starter::profile("Other")),
                ..old.clone()
            },
        ] {
            assert!(check_mount(&p, Some(&changed), "V:", &[]).is_err());
        }
        assert!(
            check_mount(
                &p,
                Some(&old),
                "V:",
                &[old.clone(), MountedRemote::new("Other:", "V:")]
            )
            .is_err()
        );
    }
    #[tokio::test]
    async fn reconnect_never_continues_after_stop_or_verification_failure() {
        for fail in ["stop", "verify", "mount", "none"] {
            let steps = Arc::new(Mutex::new(Vec::new()));
            let step = |name: &'static str| {
                let steps = steps.clone();
                async move {
                    steps.lock().unwrap().push(name);
                    if name == fail {
                        Err(name.into())
                    } else {
                        Ok(())
                    }
                }
            };
            let result =
                reconnect_steps(|| step("stop"), || step("verify"), || step("mount")).await;
            let expected = match fail {
                "stop" => vec!["stop"],
                "verify" => vec!["stop", "verify"],
                _ => vec!["stop", "verify", "mount"],
            };
            assert_eq!(*steps.lock().unwrap(), expected);
            assert_eq!(result.is_ok(), fail == "none");
        }
    }
    #[test]
    fn reconnect_never_reports_success_when_live_vfs_options_differ_or_are_missing() {
        let wanted = MountedSettings {
            source: "NAS:".into(),
            network_mode: Some(true),
            read_only: Some(false),
        };
        assert!(check_applied(&wanted, Some(&wanted)).is_ok());
        assert!(check_applied(&wanted, None).is_err());
        let reused = MountedSettings {
            read_only: Some(true),
            ..wanted.clone()
        };
        assert!(check_applied(&wanted, Some(&reused)).is_err());
        let unknown = MountedSettings {
            network_mode: None,
            ..wanted.clone()
        };
        assert!(check_applied(&wanted, Some(&unknown)).is_err());
    }
}

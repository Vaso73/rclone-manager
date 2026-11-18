//! Restore one archived file to a new local copy; never overwrite existing data.
use crate::context::AppHandle;
use crate::rclone::backend::{BackendManager, routing_transport::RoutingTransport};
use crate::rclone::commands::job::JobMetadata;
use crate::rclone::endpoints::operations;
use crate::utils::app::notification::notify;
use crate::utils::types::jobs::{JobCache, JobType, UploadCancellation};
use crate::utils::types::origin::Origin;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio_util::sync::CancellationToken;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreHistoryCopy {
    pub backend_name: String,
    pub root: String,
    pub path: String,
    pub name: String,
    pub destination: String,
    pub size: u64,
    pub modified: String,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoredCopy {
    pub job_id: u64,
    pub destination: String,
    pub size: u64,
    pub hash_type: Option<String>,
}
fn failed() -> String {
    crate::localized_error!("backendErrors.workspace.restoreFailed")
}
fn invalid() -> String {
    crate::localized_error!("backendErrors.workspace.restorePath")
}

fn safe_name(name: &str) -> bool {
    if name.is_empty()
        || name == "."
        || name == ".."
        || name.ends_with(['.', ' '])
        || name
            .chars()
            .any(|c| c.is_control() || "\\/:*?\"<>|".contains(c))
    {
        return false;
    }
    let stem = name
        .split('.')
        .next()
        .unwrap_or_default()
        .to_ascii_uppercase();
    !matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        && !(stem.len() == 4
            && (stem.starts_with("COM") || stem.starts_with("LPT"))
            && matches!(stem.as_bytes()[3], b'1'..=b'9'))
}
/// Resolve configured local aliases without following unknown remote filesystems.
fn local_archive_path(root: &str, configs: &Value) -> Option<PathBuf> {
    let mut current = root.to_string();
    let mut seen = std::collections::HashSet::new();
    for _ in 0..16 {
        if Path::new(&current).is_absolute() {
            return Some(PathBuf::from(current));
        }
        let (remote, tail) = current.split_once(':')?;
        if !seen.insert(remote.to_string()) {
            return None;
        }
        let config = configs.get(remote)?;
        match config.get("type")?.as_str()? {
            "alias" => {
                current = crate::utils::json_helpers::build_full_path(
                    config.get("remote")?.as_str()?,
                    tail,
                )
            }
            "local" => return Path::new(tail).is_absolute().then(|| PathBuf::from(tail)),
            _ => return None,
        }
    }
    None
}

fn validate_input(params: &RestoreHistoryCopy) -> Result<(), String> {
    if !safe_name(&params.name)
        || params.path.is_empty()
        || params.path.starts_with('/')
        || params.path.split('/').any(|part| !safe_name(part))
        || params.root.trim().is_empty()
        || params.root.chars().any(char::is_control)
        || params
            .root
            .replace('\\', "/")
            .split('/')
            .any(|part| part == "..")
    {
        return Err(invalid());
    }
    if !Path::new(&params.destination).is_absolute() {
        return Err(invalid());
    }
    Ok(())
}
fn verify_source(item: &Value, params: &RestoreHistoryCopy) -> Result<(), String> {
    if item.get("IsDir").and_then(Value::as_bool) != Some(false)
        || item.get("Size").and_then(Value::as_u64) != Some(params.size)
    {
        return Err(crate::localized_error!("backendErrors.workspace.changed"));
    }
    if !params.modified.is_empty() {
        let before =
            chrono::DateTime::parse_from_rfc3339(&params.modified).map_err(|_| invalid())?;
        let after = item
            .get("ModTime")
            .and_then(Value::as_str)
            .and_then(|value| chrono::DateTime::parse_from_rfc3339(value).ok())
            .ok_or_else(invalid)?;
        if before != after {
            return Err(crate::localized_error!("backendErrors.workspace.changed"));
        }
    }
    Ok(())
}
fn unique_name(name: &str, number: usize) -> String {
    if number == 0 {
        return name.to_string();
    }
    let path = Path::new(name);
    match (
        path.file_stem().and_then(|v| v.to_str()),
        path.extension().and_then(|v| v.to_str()),
    ) {
        (Some(stem), Some(ext)) => format!("{stem} ({number}).{ext}"),
        _ => format!("{name} ({number})"),
    }
}
/// TempPath uses no-replace persistence on the destination filesystem, including Windows.
fn publish_copy(stage: &Path, destination: &Path, name: &str) -> Result<PathBuf, String> {
    let mut temporary = tempfile::TempPath::try_from_path(stage).map_err(|_| failed())?;
    for number in 0..10_000 {
        let target = destination.join(unique_name(name, number));
        match temporary.persist_noclobber(&target) {
            Ok(()) => return Ok(target),
            Err(error) if error.error.kind() == std::io::ErrorKind::AlreadyExists => {
                temporary = error.path
            }
            Err(_) => return Err(failed()),
        }
    }
    Err(failed())
}
struct Registration {
    cache: Arc<JobCache>,
    id: u64,
    sender: tokio::sync::watch::Sender<Option<Result<(), String>>>,
}
impl Drop for Registration {
    fn drop(&mut self) {
        self.sender.send_replace(Some(Ok(())));
        self.cache.uploads.lock().remove(&self.id);
    }
}

pub async fn restore_history_copy(
    app: AppHandle,
    params: RestoreHistoryCopy,
) -> Result<RestoredCopy, String> {
    validate_input(&params)?;
    let manager = app.state::<BackendManager>();
    let backend = manager
        .get_active_checked(Some(&params.backend_name))
        .await?;
    let launch_lock = manager.workspace_operations.clone();
    let launch_guard = launch_lock.read().await;
    let destination = std::fs::canonicalize(&params.destination).map_err(|_| invalid())?;
    if !destination.is_dir() {
        return Err(invalid());
    }
    let transport = RoutingTransport::for_backend(app.clone(), backend.clone());
    let configs = transport
        .rpc(crate::rclone::endpoints::config::DUMP, None)
        .await
        .map_err(|_| failed())?;
    if backend.is_local
        && let Some(local_archive) = local_archive_path(&params.root, &configs)
    {
        let archive = std::fs::canonicalize(local_archive).map_err(|_| invalid())?;
        if destination.starts_with(&archive) {
            return Err(invalid());
        }
    } else {
        let (remote, _) = params.root.split_once(':').ok_or_else(invalid)?;
        if remote.is_empty()
            || remote.contains(['/', '\\'])
            || manager
                .remote_cache_for(&backend.name)
                .get_configs()
                .await
                .get(remote)
                .is_none()
        {
            return Err(invalid());
        }
        for mount in
            crate::rclone::queries::get_mounted_remotes_for_backend(app.clone(), &backend).await?
        {
            if let Ok(point) = std::fs::canonicalize(&mount.mount_point)
                && let Ok(relative) = destination.strip_prefix(point)
            {
                let mapped = crate::utils::json_helpers::build_full_path(
                    &mount.fs,
                    &relative.to_string_lossy().replace('\\', "/"),
                );
                if crate::services::backup::history::paths_overlap(
                    &params.root,
                    &mapped,
                    cfg!(windows),
                )? {
                    return Err(invalid());
                }
            }
        }
    }
    let stat = transport
        .rpc(
            operations::STAT,
            Some(&json!({"fs":params.root,"remote":params.path,"opt":{"showHash":true}})),
        )
        .await
        .map_err(|_| failed())?;
    let source = stat.get("item").ok_or_else(failed)?;
    verify_source(source, &params)?;
    let source_hashes = source
        .get("Hashes")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let job_id = crate::rclone::commands::upload::next_local_jobid();
    let mut metadata = JobMetadata::new(
        params.root.clone(),
        JobType::Copy,
        vec![crate::utils::json_helpers::build_full_path(
            &params.root,
            &params.path,
        )],
        destination.to_string_lossy(),
    )
    .with_origin(Some(Origin::Dashboard))
    .with_group(Some(format!("restore/{}", uuid::Uuid::new_v4())));
    metadata.prepare_execution();
    let cache = manager.job_cache_for(&backend.name);
    cache
        .create_job(job_id, metadata.clone(), backend.name.clone())
        .await;
    notify(&app, metadata.started_event(backend.name.clone()));
    let cancellation = CancellationToken::new();
    let (sender, receiver) = tokio::sync::watch::channel(None);
    cache.uploads.lock().insert(
        job_id,
        UploadCancellation {
            token: cancellation.clone(),
            result: receiver,
        },
    );
    let _registration = Registration {
        cache: cache.clone(),
        id: job_id,
        sender,
    };
    drop(launch_guard);
    let result: Result<RestoredCopy, String> = async {
        let directory = tempfile::Builder::new().prefix(".rclone-restore-").tempdir_in(&destination).map_err(|_| failed())?;
        let stage = directory.path().join("copy");
        let mut expected = source_hashes.iter().find(|(kind,value)| kind.replace('-', "").eq_ignore_ascii_case("sha256") && value.as_str().is_some_and(|value|!value.is_empty())).and_then(|(_,value)|value.as_str()).map(str::to_owned);
        // Preserve all transport targets: stream bytes onto this app host, never ask an
        // external daemon to write a path that belongs to another computer.
        // When only another hash type is exposed, request a source SHA-256 for comparison.
        if expected.is_none() && source_hashes.values().any(|value|value.as_str().is_some_and(|value|!value.is_empty())) {
            let hash_request=json!({"fs":params.root,"remote":params.path,"hashType":"SHA-256","download":true});
            let checksum = tokio::select! {
                _ = cancellation.cancelled() => return Err(crate::localized_error!("backendErrors.job.stopped")),
                checksum = transport.rpc(operations::HASHSUMFILE, Some(&hash_request)) => checksum.map_err(|_| failed())?,
            };
            expected = Some(checksum.get("hash").and_then(Value::as_str).filter(|value|!value.is_empty()).ok_or_else(failed)?.to_string());
        }
        let mut reader = tokio::select! {
            _ = cancellation.cancelled() => return Err(crate::localized_error!("backendErrors.job.stopped")),
            reader = transport.read_file(&params.root, &params.path, None) => reader.map_err(|_| failed())?,
        };
        let mut output=tokio::fs::OpenOptions::new().write(true).create_new(true).open(&stage).await.map_err(|_| failed())?;
        let mut buffer=vec![0u8;128*1024];let mut downloaded=0u64;let mut digest=Sha256::new();let mut updated=std::time::Instant::now();
        loop {
            let count=tokio::select! {
                _ = cancellation.cancelled() => return Err(crate::localized_error!("backendErrors.job.stopped")),
                result = reader.read(&mut buffer) => result.map_err(|_| failed())?,
            };
            if count==0 { break; }
            downloaded=downloaded.checked_add(count as u64).ok_or_else(failed)?;
            if downloaded>params.size { return Err(crate::localized_error!("backendErrors.workspace.changed")); }
            output.write_all(&buffer[..count]).await.map_err(|_| failed())?;digest.update(&buffer[..count]);
            if updated.elapsed()>=std::time::Duration::from_millis(200) {let _=cache.update_job_stats(job_id,json!({"bytes":downloaded,"totalBytes":params.size,"errors":0})).await;updated=std::time::Instant::now();}
        }
        output.flush().await.map_err(|_| failed())?;output.sync_all().await.map_err(|_| failed())?;drop(output);
        if downloaded!=params.size { return Err(failed()); }
        let actual:String=digest.finalize().iter().map(|byte|format!("{byte:02x}")).collect();
        if expected.as_ref().is_some_and(|value|!actual.eq_ignore_ascii_case(value)) { return Err(crate::localized_error!("backendErrors.workspace.restoreChecksum")); }
        if cancellation.is_cancelled() { return Err(crate::localized_error!("backendErrors.job.stopped")); }
        let published = crate::utils::spawn_blocking({let stage=stage.clone();let destination=destination.clone();let name=params.name.clone();move || publish_copy(&stage, &destination, &name)}).await.map_err(|_| failed())??;
        let final_path = published.to_string_lossy().to_string();
        if let Some(job) = cache.jobs.write().await.get_mut(&job_id) { job.destination = final_path.clone(); }
        Ok(RestoredCopy {job_id, destination:final_path, size:params.size, hash_type:expected.as_ref().map(|_|"SHA-256".to_string())})
    }.await;
    match &result {
        Ok(_) => {
            cache
                .complete_job_for_execution(
                    job_id,
                    metadata.execute_id.as_deref(),
                    true,
                    None,
                    Some(json!({"bytes":params.size,"totalBytes":params.size,"errors":0})),
                    None,
                )
                .await?;
            notify(&app, metadata.completed_event(backend.name));
        }
        Err(_) if cancellation.is_cancelled() => {
            cache.stop_job(job_id).await?;
            notify(&app, metadata.stopped_event(backend.name));
        }
        Err(error) => {
            cache
                .complete_job_for_execution(
                    job_id,
                    metadata.execute_id.as_deref(),
                    false,
                    Some(error.clone()),
                    None,
                    None,
                )
                .await?;
            notify(&app, metadata.failed_event(backend.name, error));
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn never_overwrites_a_racing_destination_and_preserves_bytes() {
        let directory = tempfile::tempdir().unwrap();
        let stage = directory.path().join("stage");
        std::fs::write(&stage, b"older version").unwrap();
        std::fs::write(directory.path().join("file.txt"), b"current version").unwrap();
        let restored = publish_copy(&stage, directory.path(), "file.txt").unwrap();
        assert_eq!(restored.file_name().unwrap(), "file (1).txt");
        assert_eq!(std::fs::read(restored).unwrap(), b"older version");
        assert_eq!(
            std::fs::read(directory.path().join("file.txt")).unwrap(),
            b"current version"
        );
    }
    #[test]
    fn local_aliases_resolve_without_guessing_remote_filesystems_or_cycles() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().to_string_lossy();
        let configs = json!({
            "Archive": {"type":"alias","remote":root},
            "Chained": {"type":"alias","remote":"Archive:older"},
            "Loop": {"type":"alias","remote":"Loop:again"},
            "Cloud": {"type":"drive"}
        });
        assert_eq!(
            local_archive_path("Chained:Apps", &configs),
            Some(directory.path().join("older/Apps"))
        );
        assert!(local_archive_path("Loop:", &configs).is_none());
        assert!(local_archive_path("Cloud:history", &configs).is_none());
        assert!(local_archive_path("Missing:", &configs).is_none());
    }
    #[test]
    fn traversal_ads_and_reserved_names_are_rejected() {
        for name in [
            "",
            ".",
            "..",
            "a/b",
            "a\\b",
            "file:ads",
            "CON.txt",
            "LPT1",
            "trailing.",
            "trailing ",
            "a\n",
        ] {
            assert!(!safe_name(name), "{name}");
        }
        assert!(safe_name("Žltý súbor !!!.txt"));
        assert_eq!(unique_name(".config", 2), ".config (2)");
    }
    #[test]
    fn changed_source_and_unknown_size_are_not_restored() {
        let request = RestoreHistoryCopy {
            backend_name: "Local".into(),
            root: "NAS:history".into(),
            path: "file.txt".into(),
            name: "file.txt".into(),
            destination: "/tmp".into(),
            size: 3,
            modified: "2026-11-18T08:00:00Z".into(),
        };
        assert!(
            verify_source(
                &json!({"IsDir":false,"Size":4,"ModTime":request.modified}),
                &request
            )
            .is_err()
        );
        assert!(
            verify_source(
                &json!({"IsDir":true,"Size":3,"ModTime":request.modified}),
                &request
            )
            .is_err()
        );
        assert!(
            verify_source(
                &json!({"IsDir":false,"Size":3,"ModTime":request.modified}),
                &request
            )
            .is_ok()
        );
    }
}

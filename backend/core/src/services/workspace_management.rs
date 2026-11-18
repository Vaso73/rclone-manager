//! Explicit, non-cascading management for the simple workspace.
use crate::context::AppHandle;
use crate::rclone::backend::{BackendManager, routing_transport::RoutingTransport, types::Backend};
use crate::rclone::endpoints::config;
use crate::services::settings::blocking;
use crate::utils::constants::{SUB_QUICK_RUNS, SUB_REMOTES, SUB_WORKFLOWS};
use crate::utils::types::events::REMOTE_CACHE_CHANGED;
use crate::utils::types::remotes::OperationType;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;

#[derive(Debug, Clone, Serialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "camelCase")]
pub struct Dependency {
    pub kind: String,
    pub name: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemovalReview {
    pub revision: String,
    pub dependencies: Vec<Dependency>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoveConnection {
    pub backend_name: String,
    pub name: String,
    pub revision: String,
}

fn failed() -> String {
    crate::localized_error!("backendErrors.workspace.changed")
}

/// Match complete remote names, including union upstreams; never mistake NAS2 for NAS.
fn references(value: &Value, name: &str) -> bool {
    match value {
        Value::String(text) => {
            let prefix = format!("{name}:");
            text == name
                || text.match_indices(&prefix).any(|(at, _)| {
                    at == 0
                        || text[..at]
                            .chars()
                            .last()
                            .is_some_and(|c| c.is_whitespace() || matches!(c, '\'' | '"'))
                })
        }
        Value::Array(values) => values.iter().any(|value| references(value, name)),
        Value::Object(values) => values.values().any(|value| references(value, name)),
        _ => false,
    }
}

fn dependency_review(
    name: &str,
    configs: &Value,
    settings: &Value,
    flows: &Value,
) -> RemovalReview {
    let mut dependencies = BTreeSet::new();
    if let Some(remotes) = configs.as_object() {
        for (other, value) in remotes {
            if other != name && references(value, name) {
                dependencies.insert(Dependency {
                    kind: "connection".into(),
                    name: other.clone(),
                });
            }
        }
    }
    if let Some(remotes) = settings.as_object() {
        for (owner, settings) in remotes {
            for operation in OperationType::ALL {
                if let Some(profiles) = settings
                    .get(operation.config_key())
                    .and_then(Value::as_object)
                {
                    for (profile, value) in profiles {
                        if owner == name || references(value, name) {
                            dependencies.insert(Dependency {
                                kind: "profile".into(),
                                name: format!("{owner} / {} / {profile}", operation.config_key()),
                            });
                        }
                    }
                }
            }
        }
    }
    if let Some(items) = flows.as_array() {
        for value in items {
            if references(value, name) {
                dependencies.insert(Dependency {
                    kind: "automation".into(),
                    name: value
                        .get("name")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string(),
                });
            }
        }
    }
    let mut sorted_flows = flows.as_array().cloned().unwrap_or_default();
    sorted_flows.sort_by_cached_key(Value::to_string);
    let flows = Value::Array(sorted_flows);
    // Only an opaque digest crosses the IPC boundary; config secrets never do.
    let revision = Sha256::digest(json!([configs, settings, flows]).to_string().as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    RemovalReview {
        revision,
        dependencies: dependencies.into_iter().collect(),
    }
}

async fn review(app: &AppHandle, backend: &Backend, name: &str) -> Result<RemovalReview, String> {
    let transport = RoutingTransport::for_backend(app.clone(), backend.clone());
    let configs = transport
        .rpc(config::DUMP, None)
        .await
        .map_err(|_| failed())?;
    if configs.get(name).is_none() {
        return Err(failed());
    }
    let (settings, flows) = blocking(app, |manager| {
        let settings = manager
            .sub_settings(SUB_REMOTES)
            .and_then(|store| store.get_all_values())
            .map_err(|_| failed())?;
        let mut flows = Vec::new();
        for section in [SUB_QUICK_RUNS, SUB_WORKFLOWS] {
            let values = manager
                .sub_settings(section)
                .and_then(|store| store.get_all_values())
                .map_err(|_| failed())?;
            flows.extend(values.into_values());
        }
        Ok::<_, String>((json!(settings), Value::Array(flows)))
    })
    .await??;
    let mut result = dependency_review(name, &configs, &settings, &flows);
    // Failed discovery is never interpreted as an unused connection.
    for mount in
        crate::rclone::queries::get_mounted_remotes_for_backend(app.clone(), backend).await?
    {
        if references(&json!(mount.fs), name) {
            result.dependencies.push(Dependency {
                kind: "mount".into(),
                name: mount.mount_point,
            });
        }
    }
    for serve in crate::rclone::queries::list_serves_for_backend(app.clone(), backend).await? {
        if references(&serve.params, name) {
            result.dependencies.push(Dependency {
                kind: "serve".into(),
                name: serve.id,
            });
        }
    }
    for job in app
        .state::<BackendManager>()
        .job_cache_for(&backend.name)
        .get_active_jobs()
        .await
    {
        if job.remote_name.trim_end_matches(':') == name
            || references(&json!([job.source, job.destination]), name)
        {
            result.dependencies.push(Dependency {
                kind: "job".into(),
                name: job.jobid.to_string(),
            });
        }
    }
    Ok(result)
}

pub async fn inspect_connection_removal(
    app: AppHandle,
    name: String,
    backend_name: String,
) -> Result<RemovalReview, String> {
    let manager = app.state::<BackendManager>();
    let _selection = manager.switch_lock.lock().await;
    let backend = manager.get_active_checked(Some(&backend_name)).await?;
    review(&app, &backend, &name).await
}

/// Unlike advanced delete_remote, never stop/unmount or purge completed records.
pub async fn remove_unused_connection(
    app: AppHandle,
    params: RemoveConnection,
) -> Result<(), String> {
    let manager = app.state::<BackendManager>();
    let _selection = manager.switch_lock.lock().await;
    let backend = manager
        .get_active_checked(Some(&params.backend_name))
        .await?;
    let mutation_lock = manager.workspace_operations.clone();
    let mutation_guard = mutation_lock.write().await;
    let review = review(&app, &backend, &params.name).await?;
    if review.revision != params.revision {
        return Err(failed());
    }
    if !review.dependencies.is_empty() {
        return Err(crate::localized_error!("backendErrors.workspace.inUse"));
    }
    RoutingTransport::for_backend(app.clone(), backend.clone())
        .rpc(config::DELETE, Some(&json!({"name": params.name})))
        .await
        .map_err(|_| failed())?;
    drop(mutation_guard);
    crate::services::settings::remote::manager::delete_remote_settings_on_backend(
        &app,
        params.name.clone(),
        &backend.name,
    )
    .await?;
    crate::services::bridge::emit(REMOTE_CACHE_CHANGED, params.name);
    Ok(())
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoveRecord {
    pub backend_name: String,
    pub job_id: u64,
    pub execute_id: Option<String>,
    pub start_time: chrono::DateTime<chrono::Utc>,
}

pub async fn remove_finished_record(app: AppHandle, params: RemoveRecord) -> Result<(), String> {
    let manager = app.state::<BackendManager>();
    let _selection = manager.switch_lock.lock().await;
    let backend = manager
        .get_active_checked(Some(&params.backend_name))
        .await?;
    manager
        .job_cache_for(&backend.name)
        .delete_finished_record(
            params.job_id,
            params.execute_id.as_deref(),
            params.start_time,
            Some(&app),
        )
        .await
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn exact_names_aliases_and_union_upstreams() {
        assert!(references(
            &json!({"upstreams": "OTHER:folder NAS:folder:ro"}),
            "NAS"
        ));
        assert!(references(&json!(["NAS", {"path": "NAS:history"}]), "NAS"));
        assert!(!references(&json!(["NAS2:mirror", "fooNAS:", null]), "NAS"));
        assert!(references(
            &json!("One Drive:folder with spaces"),
            "One Drive"
        ));
        assert!(references(
            &json!("NAS:folder \"One Drive:folder\""),
            "One Drive"
        ));
    }
    #[test]
    fn profiles_are_checked_across_owners_and_operations() {
        let settings = json!({"OTHER":{"syncConfigs":{"Backup":{"rclone":{"dstFs":"NAS:mirror"}}}},"NAS":{"mountConfigs":{"One":{}}}});
        let result = dependency_review(
            "NAS",
            &json!({"alias":{"remote":"NAS:folder"}}),
            &settings,
            &json!([{"name":"Flow", "path":"NAS:foo"}]),
        );
        assert_eq!(result.dependencies.len(), 4);
        assert!(
            result
                .dependencies
                .iter()
                .any(|entry| entry.name == "OTHER / syncConfigs / Backup")
        );
    }
    #[test]
    fn review_revision_is_independent_of_store_iteration_order() {
        let a = json!({"name":"a","remote":"OTHER:"});
        let b = json!({"name":"b","remote":"OTHER:"});
        assert_eq!(
            dependency_review("NAS", &json!({}), &json!({}), &json!([a, b])).revision,
            dependency_review("NAS", &json!({}), &json!({}), &json!([b, a])).revision
        );
    }
    #[test]
    fn completed_logs_are_not_dependencies_and_digest_contains_no_secret() {
        let configs = json!({"NAS":{"type":"sftp","pass":"not-a-real-secret"}});
        let clean = dependency_review("NAS", &configs, &json!({}), &json!([]));
        assert!(clean.dependencies.is_empty());
        assert_eq!(clean.revision.len(), 64);
        assert!(!clean.revision.contains("secret"));
        assert_ne!(
            clean.revision,
            dependency_review("NAS", &configs, &json!({"x":1}), &json!([])).revision
        );
    }
}

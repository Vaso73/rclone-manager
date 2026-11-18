use crate::context::AppHandle;
use log::{debug, error, info};
use serde_json::json;

use crate::{
    rclone::{
        backend::BackendManager,
        commands::{job::stop_job_on_backend, mount::unmount_all_remotes, serve::stop_all_serves},
    },
    services::{automation::engine::AutomationScheduler, bridge},
    utils::types::{events::APP_EVENT, state::RcloneState},
};

/// Longest shutdown waits for in-flight initialization before tearing services down anyway.
const INITIALIZATION_WAIT: std::time::Duration = std::time::Duration::from_secs(5);

/// Engine shutdown must outlast the graceful-exit wait, otherwise its forced kill is cut
/// off before it can run.
#[cfg(not(feature = "librclone"))]
const ENGINE_SHUTDOWN_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(
    crate::rclone::binaries::process_common::GRACEFUL_SHUTDOWN_TIMEOUT.as_secs() + 2,
);
#[cfg(feature = "librclone")]
const ENGINE_SHUTDOWN_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(3);

#[derive(Default)]
struct ShutdownState(tokio::sync::OnceCell<()>);

impl ShutdownState {
    async fn run(&self, cleanup: impl std::future::Future<Output = ()>) {
        self.0.get_or_init(|| cleanup).await;
    }
}

/// Concurrent exit requests share one completed cleanup sequence.
pub async fn handle_shutdown(app_handle: AppHandle) {
    app_handle.manage(ShutdownState::default());
    let state = app_handle.state::<ShutdownState>();
    state.run(shutdown(app_handle)).await;
}

/// Starting cleanup does not permit the host to exit. A second close request
/// must wait for the same completed cleanup, including pending FUSE unmounts.
pub fn is_shutdown_complete(app: &AppHandle) -> bool {
    app.try_state::<ShutdownState>()
        .is_some_and(|state| state.0.get().is_some())
}

async fn shutdown(app_handle: AppHandle) {
    info!("Beginning shutdown sequence...");

    let runtime = app_handle.state::<RcloneState>();
    runtime.set_shutting_down();
    // Let in-flight initialization finish before tearing its services down. A slow
    // auto-start must not keep the app from exiting.
    let _startup =
        match tokio::time::timeout(INITIALIZATION_WAIT, runtime.initialization_lock.lock()).await {
            Ok(guard) => Some(guard),
            Err(_) => {
                error!("Initialization is still running; shutting down without waiting for it");
                None
            }
        };

    bridge::emit(
        APP_EVENT,
        json!({ "status": "shutting_down", "message": "Shutting down RClone Manager" }),
    );

    #[cfg(all(
        feature = "desktop",
        not(any(target_os = "android", target_os = "ios"))
    ))]
    if let Some(power_state) = app_handle.try_state::<crate::services::power::PowerInhibitorState>()
    {
        power_state.release().await;
    }

    let scheduler_state = app_handle.state::<AutomationScheduler>();

    if let Some(watcher_manager) =
        app_handle.try_state::<crate::services::automation::watcher::WatcherManager>()
    {
        watcher_manager.stop_all().await;
    }

    crate::services::lifecycle::auto_updater::stop_auto_updater(&app_handle);

    match scheduler_state.stop().await {
        Ok(()) => info!("Cron scheduler stopped."),
        Err(e) => error!("Failed to stop cron scheduler: {e}"),
    }

    // Stop producers before removing mount points: a pending mount job must not
    // create another filesystem after the unmount batch has already finished.
    let (stop_jobs_result, stop_serves_result) = tokio::join!(
        tokio::time::timeout(
            tokio::time::Duration::from_secs(5),
            stop_all_active_jobs(app_handle.clone()),
        ),
        tokio::time::timeout(
            tokio::time::Duration::from_secs(5),
            stop_all_serves(
                app_handle.clone(),
                crate::rclone::commands::common::OperationContext::Shutdown,
            ),
        ),
    );

    // Windows rclone can spend ten seconds releasing EACH mount. Do not abandon
    // that work after five seconds and stop the engine underneath it. The batch
    // owns its deadline and waits for any individual mount/unmount in progress.
    if let Err(e) = unmount_all_remotes(
        app_handle.clone(),
        crate::rclone::commands::common::OperationContext::Shutdown,
    )
    .await
    {
        error!("Failed to unmount remotes: {e}");
    }

    if let Ok(Err(e)) = stop_jobs_result {
        error!("Failed to stop all jobs: {e}");
    } else if stop_jobs_result.is_err() {
        error!("Job stopping timed out");
    }

    if let Ok(Err(e)) = stop_serves_result {
        error!("Failed to stop all serves: {e}");
    } else if stop_serves_result.is_err() {
        error!("Serve stopping timed out");
    }

    // Shut down the rclone engine with a hard timeout.
    let app_clone = app_handle.clone();
    let engine_result = tokio::time::timeout(ENGINE_SHUTDOWN_TIMEOUT, async move {
        let engine_state = app_clone.state::<crate::utils::types::state::EngineState>();
        engine_state.lock().await.shutdown(&app_clone).await;
        Ok::<(), String>(())
    })
    .await;

    match engine_result {
        Ok(Ok(())) => info!("Engine shutdown completed."),
        Ok(Err(e)) => error!("Engine shutdown failed: {e}"),
        #[cfg(not(feature = "librclone"))]
        Err(_) => {
            error!("Engine shutdown timed out — force-killing rclone processes");
            // The engine's child always belongs to the Local backend, whichever one is active.
            let local = app_handle
                .state::<BackendManager>()
                .get(crate::utils::constants::LOCAL_BACKEND_NAME)
                .await;
            if let Some(local) = local
                && let Err(e) =
                    crate::utils::process::process_manager::kill_all_rclone_processes(local.port)
            {
                error!("Force kill failed: {e}");
            }
        }
        #[cfg(feature = "librclone")]
        Err(_) => {}
    }

    // Clear the in-memory config password so late-spawned processes can't read it.
    crate::services::security::rclone_env::clear_config_password();
    debug!("Cleared RCLONE_CONFIG_PASS from the environment");

    // Clear temporary file preview/viewer cache files
    app_handle.host().cleanup();

    #[cfg(not(feature = "librclone"))]
    apply_pending_updates(&app_handle).await;
}

pub async fn shutdown_app(app: AppHandle) -> Result<(), String> {
    handle_shutdown(app.clone()).await;
    info!("Shutdown completed.");
    app.exit(0);
    Ok(())
}

/// Applies any staged updates (app or rclone) during shutdown.
#[cfg(not(feature = "librclone"))]
async fn apply_pending_updates(app_handle: &AppHandle) {
    // Rclone update (binary swap — only available on desktop).
    #[cfg(not(feature = "librclone"))]
    if let Err(e) =
        crate::rclone::binaries::updater::apply_rclone_update_if_staged(app_handle).await
    {
        error!("Failed to apply rclone update during shutdown: {e}");
    }
}

pub async fn stop_all_active_jobs(app: AppHandle) -> Result<(), String> {
    let manager = app.state::<BackendManager>();
    let mut tasks = Vec::new();
    for info in manager.list_all().await {
        let Some(backend) = manager.get(&info.name).await else {
            continue;
        };
        for job in manager.job_cache_for(&backend.name).get_active_jobs().await {
            let app = app.clone();
            let backend = backend.clone();
            tasks.push(crate::utils::spawn(async move {
                stop_job_on_backend(app, backend, job.jobid, job.remote_name).await
            }));
        }
    }

    let errors: Vec<String> = futures::future::join_all(tasks)
        .await
        .into_iter()
        .filter_map(|r| match r {
            Ok(Err(e)) => Some(e),
            Err(e) => Some(format!("Task panicked: {e}")),
            Ok(Ok(())) => None,
        })
        .collect();

    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors.join(", "))
    }
}

/// Stops every active job for a user request (tray or notification action) and says so.
pub async fn stop_all_active_jobs_with_notice(app: AppHandle) {
    use crate::utils::app::notification::{NotificationEvent, SystemStage, notify};
    match stop_all_active_jobs(app.clone()).await {
        Ok(()) => notify(&app, NotificationEvent::System(SystemStage::AllJobsStopped)),
        Err(e) => error!("Failed to stop all active jobs: {e}"),
    }
}

#[cfg(test)]
mod tests {
    use super::{ShutdownState, is_shutdown_complete};
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[tokio::test]
    async fn concurrent_and_later_requests_wait_for_one_cleanup() {
        let state = ShutdownState::default();
        let completed = AtomicUsize::new(0);
        let cleanup = || async {
            tokio::task::yield_now().await;
            completed.fetch_add(1, Ordering::SeqCst);
        };
        tokio::join!(state.run(cleanup()), async {
            state.run(cleanup()).await;
            assert_eq!(completed.load(Ordering::SeqCst), 1);
        });
        state.run(cleanup()).await;
        assert_eq!(completed.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn host_exit_is_allowed_only_after_cleanup_finishes() {
        let app = crate::context::AppHandle::default();
        assert!(!is_shutdown_complete(&app));
        app.manage(ShutdownState::default());
        let state = app.state::<ShutdownState>();
        state
            .run(async {
                assert!(!is_shutdown_complete(&app));
                tokio::task::yield_now().await;
                assert!(!is_shutdown_complete(&app));
            })
            .await;
        assert!(is_shutdown_complete(&app));
    }

    #[tokio::test]
    async fn cancelled_cleanup_does_not_authorize_host_exit() {
        use futures::FutureExt;
        let app = crate::context::AppHandle::default();
        app.manage(ShutdownState::default());
        let state = app.state::<ShutdownState>();
        assert!(state.run(std::future::pending()).now_or_never().is_none());
        assert!(!is_shutdown_complete(&app));
        state.run(async {}).await;
        assert!(is_shutdown_complete(&app));
    }

    #[cfg(not(feature = "librclone"))]
    #[tokio::test]
    async fn full_shutdown_does_not_stop_engine_or_exit_during_a_slow_unmount() {
        use crate::context::{AppHandle, Host, ProductInfo};
        use crate::rclone::backend::{BackendManager, http_transport::RcHttpBackend};
        use crate::services::{automation::engine::AutomationScheduler, paths::AppPaths};
        use crate::utils::{
            constants::LOCAL_BACKEND_NAME,
            types::state::{EngineState, RcApiEngine, RcloneState},
        };
        use std::sync::{Arc, atomic::AtomicBool};
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        struct TestHost(Arc<AtomicBool>);
        #[async_trait::async_trait]
        impl Host for TestHost {
            fn resolve_paths(&self, _: &AppHandle) -> Result<AppPaths, String> {
                Err("No real filesystem is used in this shutdown test".into())
            }
            fn restart(&self, _: &AppHandle) -> Result<(), String> {
                unreachable!()
            }
            fn cleanup(&self) {
                self.0.store(true, Ordering::SeqCst);
            }
        }

        let cleaned = Arc::new(AtomicBool::new(false));
        let app = AppHandle::new(Arc::new(TestHost(cleaned.clone())), ProductInfo::default());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let manager = BackendManager::new();
        let mut backend = manager.get(LOCAL_BACKEND_NAME).await.unwrap();
        backend.port = listener.local_addr().unwrap().port();
        // This is an HTTP double, not an owned rclone child. Do not run the
        // engine's process/port cleanup against the test runner's listener.
        backend.is_local = false;
        manager.update(LOCAL_BACKEND_NAME, backend).await.unwrap();
        app.manage(manager);
        app.manage(RcloneState::new(
            crate::rclone::backend::types::rc_client(),
            Arc::new(RcHttpBackend::new(app.clone())),
        ));
        app.manage(AutomationScheduler::new());
        let mut engine = RcApiEngine::default();
        engine.mark_running();
        app.manage(EngineState::new(engine));
        let updater = crate::utils::types::updater::RcloneUpdaterState::default();
        // No staged update/filesystem access is part of this regression test.
        updater.data.lock().state = crate::utils::types::updater::UpdateState::Downloading;
        app.manage(updater);

        let exiting = app.clone();
        let shutdown = crate::utils::spawn(async move { super::handle_shutdown(exiting).await });
        for expected in ["/serve/stopall", "/mount/unmountall"] {
            let (mut socket, _) =
                tokio::time::timeout(std::time::Duration::from_secs(2), listener.accept())
                    .await
                    .unwrap()
                    .unwrap();
            let mut request = Vec::new();
            while !request.windows(4).any(|bytes| bytes == b"\r\n\r\n") {
                assert_ne!(socket.read_buf(&mut request).await.unwrap(), 0);
            }
            assert!(String::from_utf8_lossy(&request).starts_with(&format!("POST {expected} ")));
            if expected == "/mount/unmountall" {
                tokio::time::sleep(std::time::Duration::from_secs(6)).await;
                assert!(!shutdown.is_finished());
                assert!(!cleaned.load(Ordering::SeqCst));
                assert!(!is_shutdown_complete(&app));
                assert!(
                    app.state::<EngineState>()
                        .lock()
                        .await
                        .phase
                        .is_operational()
                );
            }
            socket
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}")
                .await
                .unwrap();
        }
        tokio::time::timeout(std::time::Duration::from_secs(2), shutdown)
            .await
            .unwrap()
            .unwrap();
        assert!(cleaned.load(Ordering::SeqCst));
        assert!(is_shutdown_complete(&app));
        assert!(
            !app.state::<EngineState>()
                .lock()
                .await
                .phase
                .is_operational()
        );
        // Subsequent exit requests reuse completed cleanup, with no further RPC.
        super::handle_shutdown(app.clone()).await;
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(50), listener.accept())
                .await
                .is_err()
        );
    }
}

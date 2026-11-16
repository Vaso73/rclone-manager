//! A privileged helper owns VSS snapshots; the ordinary app only gets a read lease.
//! The helper has no schedule and never receives rclone configuration or credentials.
use std::sync::Arc;

#[cfg(all(windows, feature = "desktop"))]
#[path = "vss/windows.rs"]
mod windows;

#[cfg(all(windows, feature = "desktop"))]
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HelperStatus {
    pub ready: bool,
    pub busy: bool,
}

#[derive(Debug)]
pub struct Session {
    #[cfg(all(windows, feature = "desktop"))]
    inner: windows::Lease,
    sources: Vec<String>,
}

impl Session {
    #[must_use]
    pub fn sources(&self) -> &[String] {
        &self.sources
    }

    /// Confirm exact cleanup before a successful run gets its daily marker.
    pub async fn finish(&self) -> Result<(), String> {
        #[cfg(all(windows, feature = "desktop"))]
        {
            self.inner.finish().await
        }
        #[cfg(not(all(windows, feature = "desktop")))]
        {
            Err(unsupported())
        }
    }
}

fn unsupported() -> String {
    crate::localized_error!("backendErrors.backup.vssUnsupported")
}

fn invalid_source() -> String {
    crate::localized_error!("backendErrors.backup.vssSourceInvalid")
}

fn validate_sources(sources: &[String], local: bool, windows: bool) -> Result<Vec<String>, String> {
    if !local || !windows {
        return Err(unsupported());
    }
    if sources.is_empty() || sources.len() > 128 {
        return Err(invalid_source());
    }
    let mut drive = None;
    sources
        .iter()
        .map(|source| {
            let path = source.replace('/', "\\");
            let bytes = path.as_bytes();
            if bytes.len() < 3
                || !bytes[0].is_ascii_alphabetic()
                || bytes[1] != b':'
                || bytes[2] != b'\\'
                || bytes.get(3) == Some(&b'\\')
                || path.chars().any(char::is_control)
                || path[2..].contains(':')
                || path[3..]
                    .split('\\')
                    .any(|part| part == "." || part == "..")
            {
                return Err(invalid_source());
            }
            let current = bytes[0].to_ascii_lowercase();
            if drive.is_some_and(|first| first != current) {
                return Err(invalid_source());
            }
            drive = Some(current);
            Ok(path)
        })
        .collect()
}

pub async fn prepare(
    sources: &[String],
    local: bool,
    windows: bool,
) -> Result<Arc<Session>, String> {
    let sources = validate_sources(sources, local, windows)?;
    #[cfg(all(windows, feature = "desktop"))]
    {
        let (inner, sources) = windows::prepare(&sources).await?;
        Ok(Arc::new(Session { inner, sources }))
    }
    #[cfg(not(all(windows, feature = "desktop")))]
    {
        let _ = sources;
        Err(unsupported())
    }
}

#[cfg(all(windows, feature = "desktop"))]
pub async fn helper_status() -> Result<HelperStatus, String> {
    windows::status().await
}

#[cfg(all(windows, feature = "desktop"))]
pub async fn enable_helper() -> Result<HelperStatus, String> {
    windows::enable().await
}

/// Early native entry point; it creates no webview and accepts only a user SID.
#[cfg(all(windows, feature = "desktop"))]
pub async fn run_install_if_requested() {
    windows::run_install_if_requested().await;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_multiple_folders_only_on_the_same_local_windows_volume() {
        assert_eq!(
            validate_sources(
                &["D:/LiberKey".into(), "d:\\Other folder\\Žlté".into()],
                true,
                true
            )
            .unwrap(),
            ["D:\\LiberKey", "d:\\Other folder\\Žlté"]
        );
        assert!(validate_sources(&["D:\\a".into(), "E:\\b".into()], true, true).is_err());
    }

    #[test]
    fn invalid_or_remote_sources_are_rejected_without_a_helper_call() {
        for source in [
            "",
            "D:relative",
            "D:\\\\source",
            "D://source",
            "NAS:folder",
            "\\\\server\\share",
            "\\\\?\\GLOBALROOT\\Device\\x",
            "D:\\source\\..",
            "D:\\a\\.\\b",
            "D:\\a:stream",
            "D:\\a\nb",
        ] {
            assert!(
                validate_sources(&[source.into()], true, true).is_err(),
                "{source}"
            );
        }
        assert!(validate_sources(&[], true, true).is_err());
        assert!(validate_sources(&["D:\\source".into()], false, true).is_err());
        assert!(validate_sources(&["D:\\source".into()], true, false).is_err());
    }

    #[cfg(not(all(windows, feature = "desktop")))]
    #[tokio::test]
    async fn unsupported_host_never_falls_back_to_live_files() {
        assert!(prepare(&["D:\\source".into()], true, true).await.is_err());
    }
}

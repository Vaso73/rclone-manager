use std::path::PathBuf;
use std::time::Duration;

use base64::Engine;
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::windows::named_pipe::{ClientOptions, NamedPipeClient};
use tokio::sync::Mutex;

use super::{HelperStatus, invalid_source};

const POLICY: &[u8] = include_bytes!("../../../../resources/vss/VssPolicy.psm1");
const BROKER: &[u8] = include_bytes!("../../../../resources/vss/Broker.ps1");
const NATIVE: &[u8] = include_bytes!("../../../../resources/vss/Native.cs");
const INSTALL: &str = include_str!("../../../../resources/vss/Install.ps1");

#[derive(Debug, Deserialize)]
struct Identity {
    sid: String,
    root: PathBuf,
}

#[derive(Deserialize)]
struct TaskStatus {
    ready: bool,
    busy: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "PascalCase")]
struct Receipt {
    version: u8,
    id: String,
    sid: String,
    shadow_id: Option<String>,
    volume: String,
    device: String,
    ready: bool,
    removed: bool,
}

#[derive(Debug)]
pub(super) struct Lease {
    client: Mutex<Option<BufReader<NamedPipeClient>>>,
    receipt: PathBuf,
    id: String,
    sid: String,
}

fn failed() -> String {
    crate::localized_error!("backendErrors.backup.vssHelperFailed")
}
fn cleanup_failed() -> String {
    crate::localized_error!("backendErrors.backup.vssCleanupFailed")
}

fn valid_sid(sid: &str) -> bool {
    let parts: Vec<_> = sid.split('-').collect();
    parts.len() == 8
        && parts[..4] == ["S", "1", "5", "21"]
        && parts[4..]
            .iter()
            .all(|part| !part.is_empty() && part.parse::<u32>().is_ok())
}

fn powershell() -> Result<PathBuf, String> {
    use std::os::windows::ffi::OsStringExt;
    let mut path = vec![0u16; 32768];
    let len = unsafe {
        windows_sys::Win32::System::SystemInformation::GetSystemDirectoryW(
            path.as_mut_ptr(),
            u32::try_from(path.len()).map_err(|_| failed())?,
        )
    };
    let len = usize::try_from(len).map_err(|_| failed())?;
    if len == 0 || len >= path.len() {
        return Err(failed());
    }
    Ok(PathBuf::from(std::ffi::OsString::from_wide(&path[..len]))
        .join("WindowsPowerShell/v1.0/powershell.exe"))
}

fn command() -> Result<tokio::process::Command, String> {
    let exe = powershell()?;
    let home = exe.parent().ok_or_else(failed)?;
    let mut command = crate::utils::process::command::command(&exe);
    command.args([
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "RemoteSigned",
    ]);
    // Never load user-controlled modules while running the elevated installer.
    command.env("PSModulePath", home.join("Modules"));
    Ok(command)
}

async fn ps(script: &str) -> Result<Vec<u8>, String> {
    let script = format!(
        "[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false); $OutputEncoding = [Console]::OutputEncoding; {script}"
    );
    let output = command()?
        .args(["-Command", &script])
        .output()
        .await
        .map_err(|_| failed())?;
    if !output.status.success() {
        return Err(failed());
    }
    Ok(output.stdout)
}

async fn identity() -> Result<Identity, String> {
    let bytes = ps("$ErrorActionPreference='Stop'; @{sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value; root=(Join-Path ([Environment]::GetFolderPath('CommonApplicationData')) 'RCloneManagerVss')} | ConvertTo-Json -Compress").await?;
    let mut identity: Identity = serde_json::from_slice(&bytes).map_err(|_| failed())?;
    if !valid_sid(&identity.sid) {
        return Err(failed());
    }
    identity.root.push(&identity.sid);
    Ok(identity)
}

async fn check(identity: &Identity) -> Result<HelperStatus, String> {
    let encoded = base64::engine::general_purpose::STANDARD.encode(
        serde_json::to_vec(&serde_json::json!({"sid": identity.sid, "root": identity.root}))
            .map_err(|_| failed())?,
    );
    let policy = std::str::from_utf8(POLICY).map_err(|_| failed())?;
    let script = format!(
        r#"$ErrorActionPreference='Stop';
$m=New-Module -ScriptBlock ([scriptblock]::Create(@'
{policy}
'@)); Import-Module $m;
$p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('{encoded}'))|ConvertFrom-Json;
if(-not (Test-Path -LiteralPath $p.root)){{@{{ready=$false;busy=$false}}|ConvertTo-Json -Compress;return}};
Assert-VssProtectedRoot $p.root $p.sid;
foreach($name in @('VssPolicy.psm1','Broker.ps1','Native.cs')){{Assert-VssProtectedFile (Join-Path $p.root $name)}};
$service=New-Object -ComObject 'Schedule.Service'; $service.Connect();
try{{$t=$service.GetFolder('\').GetTask('RClone Manager VSS '+$p.sid)}}catch{{@{{ready=$false;busy=$false}}|ConvertTo-Json -Compress;return}};
$d=$t.Definition; $a=$null; if($d.Actions.Count -eq 1){{$a=$d.Actions.Item(1)}};
$expected='-NoLogo -NoProfile -NonInteractive -ExecutionPolicy RemoteSigned -File "'+(Join-Path $p.root 'Broker.ps1')+'" -Sid '+$p.sid;
$valid=$d.Actions.Count -eq 1 -and $a.Type -eq 0 -and $a.Path -ieq (Join-Path $PSHOME 'powershell.exe') -and $a.Arguments -ceq $expected -and $a.WorkingDirectory -ieq $p.root -and $d.Triggers.Count -eq 0 -and $d.Principal.UserId -in @('SYSTEM','NT AUTHORITY\SYSTEM','S-1-5-18') -and $d.Principal.LogonType -eq 5 -and $d.Principal.RunLevel -eq 1 -and $d.Settings.MultipleInstances -eq 2 -and $d.Settings.Enabled -and ([Xml.XmlConvert]::ToTimeSpan($d.Settings.ExecutionTimeLimit).TotalSeconds -eq 0);
@{{ready=[bool]$valid;busy=($t.State -in @(2,4))}}|ConvertTo-Json -Compress"#
    );
    let bytes = ps(&script).await?;
    let task: TaskStatus = serde_json::from_slice(&bytes).map_err(|_| failed())?;
    let mut ready = task.ready;
    for (name, expected) in [
        ("VssPolicy.psm1", POLICY),
        ("Broker.ps1", BROKER),
        ("Native.cs", NATIVE),
    ] {
        ready &= std::fs::read(identity.root.join(name)).is_ok_and(|bytes| bytes == expected);
    }
    Ok(HelperStatus {
        ready,
        busy: task.busy,
    })
}

pub(super) async fn status() -> Result<HelperStatus, String> {
    check(&identity().await?).await
}

pub(super) async fn enable() -> Result<HelperStatus, String> {
    let identity = identity().await?;
    if let Ok(before) = check(&identity).await {
        if before.ready {
            return Ok(before);
        }
        if before.busy {
            return Err(crate::localized_error!(
                "backendErrors.backup.vssHelperBusy"
            ));
        }
    }
    let sid = identity.sid.clone();
    crate::utils::spawn_blocking(move || elevate_install(&sid))
        .await
        .map_err(|_| failed())??;
    let after = check(&identity).await?;
    if !after.ready {
        return Err(failed());
    }
    Ok(after)
}

fn elevate_install(sid: &str) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::{
        Foundation::{CloseHandle, GetLastError},
        System::Threading::{GetExitCodeProcess, WaitForSingleObject},
        UI::Shell::{SEE_MASK_NOCLOSEPROCESS, SHELLEXECUTEINFOW, ShellExecuteExW},
    };
    if !valid_sid(sid) {
        return Err(failed());
    }
    let exe = std::env::current_exe().map_err(|_| failed())?;
    let file: Vec<u16> = exe.as_os_str().encode_wide().chain(Some(0)).collect();
    let verb: Vec<u16> = "runas".encode_utf16().chain(Some(0)).collect();
    let args: Vec<u16> = format!("--install-vss-helper {sid}")
        .encode_utf16()
        .chain(Some(0))
        .collect();
    let mut info: SHELLEXECUTEINFOW = unsafe { std::mem::zeroed() };
    info.cbSize = u32::try_from(std::mem::size_of::<SHELLEXECUTEINFOW>()).map_err(|_| failed())?;
    info.fMask = SEE_MASK_NOCLOSEPROCESS;
    info.lpVerb = verb.as_ptr();
    info.lpFile = file.as_ptr();
    info.lpParameters = args.as_ptr();
    if unsafe { ShellExecuteExW(&mut info) } == 0 {
        if unsafe { GetLastError() } == 1223 {
            return Err(crate::localized_error!(
                "backendErrors.backup.vssSetupCancelled"
            ));
        }
        return Err(failed());
    }
    if info.hProcess.is_null() {
        return Err(failed());
    }
    let wait = unsafe { WaitForSingleObject(info.hProcess, 120_000) };
    let mut code = 1;
    let read = unsafe { GetExitCodeProcess(info.hProcess, &mut code) };
    unsafe {
        CloseHandle(info.hProcess);
    }
    if wait != 0 || read == 0 {
        return Err(failed());
    }
    if code != 0 {
        return Err(crate::localized_error!("backendErrors.backup.vssSetupFailed", "code" => code));
    }
    Ok(())
}

pub(super) async fn run_install_if_requested() {
    let args: Vec<_> = std::env::args_os().collect();
    if args.get(1).is_none_or(|arg| arg != "--install-vss-helper") {
        return;
    }
    let sid = args
        .get(2)
        .and_then(|arg| arg.to_str())
        .filter(|sid| valid_sid(sid));
    let result = if args.len() == 3 {
        match sid {
            Some(sid) => install(sid).await,
            None => Err(failed()),
        }
    } else {
        Err(failed())
    };
    std::process::exit(result.unwrap_or(100));
}

async fn install(sid: &str) -> Result<i32, String> {
    let encode = |bytes| base64::engine::general_purpose::STANDARD.encode(bytes);
    let payload = serde_json::json!({"sid":sid,"policy":encode(POLICY),"broker":encode(BROKER),"native":encode(NATIVE)});
    let script = INSTALL.replace(
        "__PAYLOAD__",
        &encode(&serde_json::to_vec(&payload).map_err(|_| failed())?),
    );
    let mut child = command()?
        .args([
            "-Command",
            "& ([scriptblock]::Create([Console]::In.ReadToEnd()))",
        ])
        .spawn()
        .map_err(|_| failed())?;
    let mut input = child.stdin.take().ok_or_else(failed)?;
    input
        .write_all(script.as_bytes())
        .await
        .map_err(|_| failed())?;
    input.shutdown().await.map_err(|_| failed())?;
    drop(input);
    let output = child.wait_with_output().await.map_err(|_| failed())?;
    Ok(output.status.code().unwrap_or(100))
}

async fn line(reader: &mut BufReader<NamedPipeClient>) -> Result<serde_json::Value, String> {
    let mut bytes = Vec::new();
    loop {
        let available = reader.fill_buf().await.map_err(|_| failed())?;
        if available.is_empty() {
            return Err(failed());
        }
        let end = available
            .iter()
            .position(|byte| *byte == b'\n')
            .map_or(available.len(), |end| end + 1);
        if bytes.len() + end > 4096 {
            return Err(failed());
        }
        bytes.extend_from_slice(&available[..end]);
        reader.consume(end);
        if bytes.last() == Some(&b'\n') {
            return serde_json::from_slice(&bytes).map_err(|_| failed());
        }
    }
}

fn receipt(path: &std::path::Path, id: &str, sid: &str) -> Result<Receipt, String> {
    let value: Receipt = serde_json::from_slice(&std::fs::read(path).map_err(|_| failed())?)
        .map_err(|_| failed())?;
    if value.version != 1
        || value.id != id
        || value.sid != sid
        || value.volume.is_empty()
        || value
            .shadow_id
            .as_deref()
            .is_none_or(|id| uuid::Uuid::parse_str(id.trim_matches(['{', '}'])).is_err())
        || !value
            .device
            .starts_with("\\\\?\\GLOBALROOT\\Device\\HarddiskVolumeShadowCopy")
    {
        return Err(failed());
    }
    Ok(value)
}

pub(super) async fn prepare(sources: &[String]) -> Result<(Lease, Vec<String>), String> {
    let identity = identity().await?;
    let state = check(&identity).await?;
    if !state.ready {
        return Err(crate::localized_error!(
            "backendErrors.backup.vssHelperRequired"
        ));
    }
    if state.busy {
        return Err(crate::localized_error!(
            "backendErrors.backup.vssHelperBusy"
        ));
    }
    let id = uuid::Uuid::new_v4().simple().to_string();
    #[derive(Serialize)]
    #[serde(rename_all = "PascalCase")]
    struct Request<'a> {
        version: u8,
        id: &'a str,
        sid: &'a str,
        sources: &'a [String],
    }
    let mut request = serde_json::to_vec(&Request {
        version: 1,
        id: &id,
        sid: &identity.sid,
        sources,
    })
    .map_err(|_| invalid_source())?;
    if request.len() > 16384 {
        return Err(invalid_source());
    }
    request.push(b'\n');
    let script = format!(
        "$ErrorActionPreference='Stop'; $service=New-Object -ComObject 'Schedule.Service'; $service.Connect(); $null=$service.GetFolder('\\').GetTask('RClone Manager VSS {}').Run($null)",
        identity.sid
    );
    ps(&script).await?;
    let name = format!(r"\\.\pipe\rclone-manager-vss-{}", identity.sid);
    let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
    let client = loop {
        match ClientOptions::new()
            .security_qos_flags(windows_sys::Win32::Storage::FileSystem::SECURITY_IDENTIFICATION)
            .open(&name)
        {
            Ok(client) => break client,
            Err(_) if tokio::time::Instant::now() < deadline => {
                tokio::time::sleep(Duration::from_millis(150)).await
            }
            Err(_) => return Err(failed()),
        }
    };
    let mut client = BufReader::new(client);
    client
        .get_mut()
        .write_all(&request)
        .await
        .map_err(|_| failed())?;
    let reply = tokio::time::timeout(Duration::from_secs(120), line(&mut client))
        .await
        .map_err(|_| failed())??;
    if reply.get("ready").and_then(serde_json::Value::as_bool) != Some(true) {
        return Err(failed());
    }
    let directory = identity.root.join("sessions").join(&id);
    let path = directory.join("receipt.json");
    // The nonce must also exist in the SYSTEM-owned directory: a forged pipe is insufficient.
    let proof = receipt(&path, &id, &identity.sid)?;
    if !proof.ready || proof.removed {
        return Err(failed());
    }
    let snapshot = directory.join("snapshot");
    let paths = sources
        .iter()
        .map(|source| {
            // A local connection string overrides daemon/env link options, so nothing can escape the snapshot.
            let path = snapshot.join(&source[3..]);
            format!(
                ":local,copy_links=false,links=false,no_check_updated=false:{}",
                path.display()
            )
        })
        .collect();
    Ok((
        Lease {
            client: Mutex::new(Some(client)),
            receipt: path,
            id,
            sid: identity.sid,
        },
        paths,
    ))
}

impl Lease {
    pub(super) async fn finish(&self) -> Result<(), String> {
        let mut lock = self.client.lock().await;
        if let Some(mut client) = lock.take() {
            client
                .get_mut()
                .write_all(b"finish\n")
                .await
                .map_err(|_| cleanup_failed())?;
            let reply = tokio::time::timeout(Duration::from_secs(60), line(&mut client))
                .await
                .map_err(|_| cleanup_failed())?
                .map_err(|_| cleanup_failed())?;
            if reply.get("removed").and_then(serde_json::Value::as_bool) != Some(true) {
                return Err(cleanup_failed());
            }
        }
        let proof = receipt(&self.receipt, &self.id, &self.sid).map_err(|_| cleanup_failed())?;
        if !proof.removed {
            return Err(cleanup_failed());
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn helper_identity_is_only_an_individual_windows_account() {
        assert!(valid_sid("S-1-5-21-123-456-789-1001"));
        for sid in [
            "",
            "S-1-5-18",
            "S-1-5-32-544",
            "S-1-5-21-1-2-3-4;anything",
            "S-1-5-21-1-2-3-4294967296",
        ] {
            assert!(!valid_sid(sid));
        }
    }
}

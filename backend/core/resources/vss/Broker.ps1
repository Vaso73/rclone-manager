#Requires -Version 5.1
#Requires -RunAsAdministrator
[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$Sid)
Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
Import-Module (Join-Path $root 'VssPolicy.psm1')
Assert-VssProtectedRoot $root $Sid
Add-Type -Path (Join-Path $root 'Native.cs')
$receipt = $null
$lock = $null
$pipe = $null
$reader = $null
$writer = $null
$failure = $null
try {
    $lock = [IO.File]::Open((Join-Path $root 'helper.lock'), 'OpenOrCreate', 'ReadWrite', 'None')
    # Resolve only receipts already stored under this protected, per-user root.
    $sessions = Join-Path $root 'sessions'
    $null = [IO.Directory]::CreateDirectory($sessions)
    foreach ($directory in Get-ChildItem -LiteralPath $sessions -Directory -Force) {
        Assert-VssPlainPath $directory.FullName
        if ($directory.Name -notmatch '^[0-9a-f]{32}$') { throw 'RECEIPT_REQUIRES_REVIEW' }
        $path = Join-Path $directory.FullName 'receipt.json'
        if (-not [IO.File]::Exists($path)) { throw 'RECEIPT_REQUIRES_REVIEW' }
        Assert-VssPlainPath $path
        $old = Get-Content -LiteralPath $path -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($old.Id -cne $directory.Name -or $old.Sid -cne $Sid) { throw 'RECEIPT_REQUIRES_REVIEW' }
        if (-not $old.Removed) { Remove-VssOwnedSnapshot $root $old $Sid }
    }
    $pipe = [RCloneManagerVss.PipeFactory]::Create(('rclone-manager-vss-' + $Sid), $Sid)
    $connection = $pipe.BeginWaitForConnection($null, $null)
    if (-not $connection.AsyncWaitHandle.WaitOne(60000)) { return }
    $pipe.EndWaitForConnection($connection)
    $reader = New-Object IO.StreamReader($pipe, (New-Object Text.UTF8Encoding($false)))
    $writer = New-Object IO.StreamWriter($pipe, (New-Object Text.UTF8Encoding($false)))
    $writer.AutoFlush = $true
    $line = [RCloneManagerVss.PipeFactory]::ReadLine($reader, 16384)
    # The identity belongs to the last message read from the pipe, not merely to a connection.
    if ([RCloneManagerVss.PipeFactory]::ClientSid($pipe) -cne $Sid) { throw 'CLIENT_IDENTITY_MISMATCH' }
    $request = $line | ConvertFrom-Json
    $sources = @(Assert-VssRequest $request $Sid)
    $drive = $sources[0].Substring(0, 2)
    foreach ($source in $sources) {
        if ($source.Substring(0, 2) -ine $drive) { throw 'SINGLE_VOLUME_REQUIRED' }
        Assert-VssPlainPath $source
        if (-not [IO.Directory]::Exists($source) -and -not [IO.File]::Exists($source)) { throw 'SOURCE_ENTRY_REQUIRED' }
    }
    $volumes = @(Get-CimInstance -ClassName Win32_Volume -Filter ("DriveLetter = '" + $drive + "'") -ErrorAction Stop)
    if ($volumes.Count -ne 1 -or $volumes[0].FileSystem -cne 'NTFS' -or $volumes[0].DriveType -ne 3) { throw 'FIXED_NTFS_REQUIRED' }
    if ([long]$volumes[0].FreeSpace -lt 2GB) { throw 'SOURCE_SPACE_LOW' }
    $run = Join-Path $sessions $request.Id
    if (Test-Path -LiteralPath $run) { throw 'SESSION_ALREADY_EXISTS' }
    $null = [IO.Directory]::CreateDirectory($run)
    $receipt = [pscustomobject]@{
        Version = 1; Id = $request.Id; Sid = $Sid; ShadowId = $null;
        Volume = [string]$volumes[0].DeviceID; Computer = (Get-VssComputerBinding);
        Device = ''; Ready = $false; Removed = $false
    }
    $receiptPath = Join-Path $run 'receipt.json'
    Write-VssJson $receiptPath $receipt
    $created = Invoke-CimMethod -ClassName Win32_ShadowCopy -MethodName Create -Arguments @{
        Volume = ($drive + '\'); Context = 'ClientAccessible'
    } -ErrorAction Stop
    if ($created.ReturnValue -ne 0) {
        $receipt.Removed = $true
        Write-VssJson $receiptPath $receipt
        $receipt = $null
        throw 'CREATE_FAILED'
    }
    $receipt.ShadowId = [string]$created.ShadowID
    Write-VssJson $receiptPath $receipt
    $shadow = Get-VssShadow $receipt.ShadowId
    if ($null -eq $shadow) { throw 'SNAPSHOT_MISSING' }
    Assert-VssOwnership $shadow $receipt $Sid
    $receipt.Device = [string]$shadow.DeviceObject
    Write-VssJson $receiptPath $receipt
    $link = Join-Path $run 'snapshot'
    if ([RCloneManagerVss.NativeMethods]::CreateDirectoryLink($link, ($receipt.Device + '\')) -ne 0) { throw 'EXPOSE_FAILED' }
    if ([RCloneManagerVss.NativeMethods]::GetLinkTarget($link).TrimEnd('\') -ine $receipt.Device) { throw 'SNAPSHOT_LINK_MISMATCH' }
    $receipt.Ready = $true
    Write-VssJson $receiptPath $receipt
    $writer.WriteLine('{"ready":true}')
    # Keeping this single connection open is the lease. EOF/crash also reaches exact cleanup.
    $finish = [RCloneManagerVss.PipeFactory]::ReadLine($reader, 256)
    if ($finish -and $finish -cne 'finish') { throw 'INVALID_FINISH' }
}
catch {
    # No arbitrary paths/exception text cross the privilege boundary.
    $failure = 'VSS_FAILED'
}
finally {
    if ($receipt -and -not $receipt.Removed) {
        try { Remove-VssOwnedSnapshot $root $receipt $Sid }
        catch { $failure = 'CLEANUP_FAILED' }
    }
    if ($writer -and $pipe.IsConnected) {
        try { $writer.WriteLine((@{ removed = ($null -eq $failure); error = $failure } | ConvertTo-Json -Compress)) }
        catch { }
    }
    if ($writer) { $writer.Dispose() }
    if ($reader) { $reader.Dispose() }
    if ($pipe) { $pipe.Dispose() }
    if ($lock) { $lock.Dispose() }
}
if ($failure) { exit 1 }

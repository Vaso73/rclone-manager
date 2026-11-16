#Requires -Version 5.1
# This script and its payload are supplied over the elevated executable's private stdin.
Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
$stageCode = 10
try {
$request = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('__PAYLOAD__')) | ConvertFrom-Json
$Sid = [string]$request.sid
if ($Sid -notmatch '^S-1-5-21-(\d+-){2}\d+-\d+$') { exit 2 }
$policyText = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([string]$request.policy))
$policyModule = New-Module -ScriptBlock ([scriptblock]::Create($policyText))
Import-Module $policyModule
Assert-VssSid $Sid
$top = Join-Path ([Environment]::GetFolderPath('CommonApplicationData')) 'RCloneManagerVss'
$root = Join-Path $top $Sid
$taskName = 'RClone Manager VSS ' + $Sid
$task = Get-ScheduledTask -TaskPath '\' -TaskName $taskName -ErrorAction SilentlyContinue
if ($task -and $task.State -in @('Running', 'Queued')) { throw 'HELPER_BUSY' }
function New-HelperAcl {
    param([string]$Reader)
    $acl = New-Object Security.AccessControl.DirectorySecurity
    $acl.SetAccessRuleProtection($true, $false)
    $acl.SetOwner((New-Object Security.Principal.SecurityIdentifier('S-1-5-32-544')))
    foreach ($value in @('S-1-5-18', 'S-1-5-32-544', $Reader)) {
        $rights = [Security.AccessControl.FileSystemRights]::FullControl
        if ($value -eq $Reader) { $rights = [Security.AccessControl.FileSystemRights]::ReadAndExecute }
        $identity = New-Object Security.Principal.SecurityIdentifier($value)
        $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($identity, $rights, 'ContainerInherit,ObjectInherit', 'None', 'Allow')))
    }
    return $acl
}
# Windows' DirectorySecurity overload applies the ACL at creation, without a writable interval.
foreach ($entry in @(@{ Path = $top; Reader = 'S-1-5-32-545' }, @{ Path = $root; Reader = $Sid })) {
    $stageCode = 11
    if (Test-Path -LiteralPath $entry.Path) { Assert-VssProtectedRoot $entry.Path $Sid }
    else { $null = [IO.Directory]::CreateDirectory($entry.Path, (New-HelperAcl $entry.Reader)) }
    Assert-VssProtectedRoot $entry.Path $Sid
}
$stageCode = 12
$lock = [IO.File]::Open((Join-Path $root 'helper.lock'), 'OpenOrCreate', 'ReadWrite', 'None')
if ($task) {
    $expectedExe = Join-Path $PSHOME 'powershell.exe'
    $expectedArgs = '-NoLogo -NoProfile -NonInteractive -ExecutionPolicy RemoteSigned -File "' + (Join-Path $root 'Broker.ps1') + '" -Sid ' + $Sid
    if (@($task.Actions).Count -ne 1 -or $task.Actions[0].Execute -ine $expectedExe -or
        $task.Actions[0].Arguments -cne $expectedArgs -or $task.Principal.UserId -notin @('SYSTEM', 'NT AUTHORITY\SYSTEM', 'S-1-5-18')) {
        throw 'TASK_IDENTITY_MISMATCH'
    }
    $null = Disable-ScheduledTask -TaskPath '\' -TaskName $taskName
}
try {
    $stageCode = 13
    foreach ($entry in @(@{ Name = 'VssPolicy.psm1'; Value = $request.policy }, @{ Name = 'Broker.ps1'; Value = $request.broker }, @{ Name = 'Native.cs'; Value = $request.native })) {
        $path = Join-Path $root $entry.Name
        $bytes = [Convert]::FromBase64String([string]$entry.Value)
        if (Test-Path -LiteralPath $path) { Assert-VssPlainPath $path }
        $stage = $path + '.new'
        if (Test-Path -LiteralPath $stage) { throw 'STAGING_REQUIRES_REVIEW' }
        $file = [IO.File]::Open($stage, 'CreateNew', 'Write', 'None')
        try { $file.Write($bytes, 0, $bytes.Length) } finally { $file.Dispose() }
        if ([IO.File]::Exists($path)) { [IO.File]::Replace($stage, $path, [NullString]::Value) }
        else { [IO.File]::Move($stage, $path) }
        $fileAcl = New-Object Security.AccessControl.FileSecurity
        $fileAcl.SetAccessRuleProtection($true, $false)
        $fileAcl.SetOwner((New-Object Security.Principal.SecurityIdentifier('S-1-5-32-544')))
        foreach ($value in @('S-1-5-18', 'S-1-5-32-544', $Sid)) {
            $rights = [Security.AccessControl.FileSystemRights]::FullControl
            if ($value -eq $Sid) { $rights = [Security.AccessControl.FileSystemRights]::ReadAndExecute }
            $identity = New-Object Security.Principal.SecurityIdentifier($value)
            $fileAcl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($identity, $rights, 'Allow')))
        }
        Set-Acl -LiteralPath $path -AclObject $fileAcl
        Assert-VssProtectedFile $path
        $hash = [Security.Cryptography.SHA256]::Create()
        try { $expected = ([BitConverter]::ToString($hash.ComputeHash($bytes))).Replace('-', '') }
        finally { $hash.Dispose() }
        if ((Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash -ine $expected) { throw 'FILE_READBACK_FAILED' }
    }
    $null = [IO.Directory]::CreateDirectory((Join-Path $root 'sessions'))
    $powershell = Join-Path $PSHOME 'powershell.exe'
    $arguments = '-NoLogo -NoProfile -NonInteractive -ExecutionPolicy RemoteSigned -File "' + (Join-Path $root 'Broker.ps1') + '" -Sid ' + $Sid
    $action = New-ScheduledTaskAction -Execute $powershell -Argument $arguments -WorkingDirectory $root
    $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
    $settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) `
        -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
    # No triggers: only the running desktop app can ask this helper for a snapshot.
    $stageCode = 14
    $null = Register-ScheduledTask -TaskPath '\' -TaskName $taskName -Action $action -Principal $principal -Settings $settings -Description 'RClone Manager VSS' -Force
    $service = New-Object -ComObject 'Schedule.Service'
    $service.Connect()
    $registered = $service.GetFolder('\').GetTask($taskName)
    # Normal user may read/run, never replace the SYSTEM action or its files.
    $stageCode = 15
    $registered.SetSecurityDescriptor(('D:P(A;;GA;;;SY)(A;;GA;;;BA)(A;;GRGX;;;' + $Sid + ')'), 0)
    $stageCode = 16
    $readback = Get-ScheduledTask -TaskPath '\' -TaskName $taskName
    if (@($readback.Actions).Count -ne 1 -or $readback.Actions[0].Execute -ine $powershell -or
        $readback.Actions[0].Arguments -cne $arguments -or $readback.Actions[0].WorkingDirectory -ine $root -or
        @($readback.Triggers | Where-Object { $null -ne $_ }).Count -ne 0 -or $readback.Principal.UserId -notin @('SYSTEM', 'NT AUTHORITY\SYSTEM', 'S-1-5-18')) { throw 'TASK_READBACK_FAILED' }
    Assert-VssProtectedRoot $root $Sid
}
catch {
    Disable-ScheduledTask -TaskPath '\' -TaskName $taskName -ErrorAction SilentlyContinue | Out-Null
    throw
}
finally { if ($lock) { $lock.Dispose() } }
exit 0
}
catch { exit $stageCode }

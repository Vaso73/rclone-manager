#Requires -Version 5.1
Set-StrictMode -Version 2.0

function Write-VssJson {
    param([string]$Path, $Data)
    $stage = $Path + '.new'
    [IO.File]::WriteAllText($stage, ($Data | ConvertTo-Json -Depth 5 -Compress), (New-Object Text.UTF8Encoding($false)))
    if ([IO.File]::Exists($Path)) { [IO.File]::Replace($stage, $Path, [NullString]::Value) }
    else { [IO.File]::Move($stage, $Path) }
}

function Get-VssComputerBinding {
    $guid = [string](Get-ItemProperty -LiteralPath 'HKLM:\SOFTWARE\Microsoft\Cryptography' -Name MachineGuid).MachineGuid
    $hash = [Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($hash.ComputeHash([Text.Encoding]::UTF8.GetBytes($guid)))).Replace('-', '').ToLowerInvariant() }
    finally { $hash.Dispose() }
}

function Assert-VssSid {
    param([string]$Sid)
    if ($Sid -notmatch '^S-1-5-21-(\d+-){2}\d+-\d+$') { throw 'INVALID_SID' }
}

function Assert-VssPlainPath {
    param([string]$Path)
    if ($Path -notmatch '^[A-Za-z]:\\' -or $Path -match '[\x00-\x1f]') { throw 'INVALID_SOURCE' }
    $current = [IO.Path]::GetFullPath($Path)
    while ($current) {
        $item = Get-Item -LiteralPath $current -Force -ErrorAction Stop
        if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'REPARSE_PATH_REJECTED' }
        $parent = [IO.Directory]::GetParent($current)
        if ($null -eq $parent) { break }
        $current = $parent.FullName
    }
}

function Assert-VssProtectedRoot {
    param([string]$Root, [string]$Sid)
    Assert-VssSid $Sid
    Assert-VssPlainPath $Root
    $acl = Get-Acl -LiteralPath $Root
    if (-not $acl.AreAccessRulesProtected) { throw 'UNPROTECTED_ROOT' }
    if ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -notin @('S-1-5-18', 'S-1-5-32-544')) { throw 'INVALID_ROOT_OWNER' }
    foreach ($rule in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
        if ($rule.AccessControlType -eq 'Allow' -and ($rule.FileSystemRights -band 0x000D0156) -ne 0 -and
            $rule.IdentityReference.Value -notin @('S-1-5-18', 'S-1-5-32-544')) { throw 'UNSAFE_ROOT_ACCESS' }
    }
}

function Assert-VssProtectedFile {
    param([string]$Path)
    Assert-VssPlainPath $Path
    $acl = Get-Acl -LiteralPath $Path
    if ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -notin @('S-1-5-18', 'S-1-5-32-544')) { throw 'INVALID_FILE_OWNER' }
    foreach ($rule in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
        if ($rule.AccessControlType -eq 'Allow' -and ($rule.FileSystemRights -band 0x000D0156) -ne 0 -and
            $rule.IdentityReference.Value -notin @('S-1-5-18', 'S-1-5-32-544')) { throw 'UNSAFE_FILE_ACCESS' }
    }
}

function Assert-VssRequest {
    param($Request, [string]$Sid)
    Assert-VssSid $Sid
    if ($Request.Version -ne 1 -or $Request.Id -notmatch '^[0-9a-f]{32}$' -or $Request.Sid -cne $Sid) { throw 'INVALID_REQUEST' }
    $sources = @($Request.Sources)
    if ($sources.Count -lt 1 -or $sources.Count -gt 128) { throw 'INVALID_SOURCE' }
    foreach ($value in $sources) {
        $source = [string]$value
        if ($source -notmatch '^[A-Za-z]:\\' -or $source -match '^[A-Za-z]:\\\\' -or $source -match '[\x00-\x1f]' -or
            $source -match '(^|[\\/])\.\.?([\\/]|$)' -or $source.Substring(2).Contains(':')) { throw 'INVALID_SOURCE' }
        Write-Output $source
    }
}

function Assert-VssOwnership {
    param($Shadow, $Receipt, [string]$Sid)
    Assert-VssSid $Sid
    $id = [guid]::Empty
    if ($Receipt.Version -ne 1 -or $Receipt.Computer -cne (Get-VssComputerBinding) -or $Receipt.Sid -cne $Sid -or $Receipt.Id -notmatch '^[0-9a-f]{32}$' -or
        -not [guid]::TryParse([string]$Receipt.ShadowId, [ref]$id) -or $id -eq [guid]::Empty -or
        $Receipt.Volume -notmatch '^\\\\\?\\Volume\{[0-9A-Fa-f-]{36}\}\\$') { throw 'RECEIPT_REQUIRES_REVIEW' }
    if ($null -ne $Shadow -and ($Shadow.ID -ine $Receipt.ShadowId -or $Shadow.VolumeName -ine $Receipt.Volume -or
        $Shadow.DeviceObject -notmatch '^\\\\\?\\GLOBALROOT\\Device\\HarddiskVolumeShadowCopy[0-9]+$')) { throw 'SNAPSHOT_OWNERSHIP_MISMATCH' }
    if ($null -ne $Shadow -and $Receipt.Device -and $Receipt.Device -ine $Shadow.DeviceObject) { throw 'SNAPSHOT_OWNERSHIP_MISMATCH' }
    if ($Receipt.Device -and $Receipt.Device -notmatch '^\\\\\?\\GLOBALROOT\\Device\\HarddiskVolumeShadowCopy[0-9]+$') { throw 'INVALID_SNAPSHOT_DEVICE' }
}

function Get-VssShadow {
    param([string]$Id)
    $parsed = [guid]::Empty
    if (-not [guid]::TryParse($Id, [ref]$parsed) -or $parsed -eq [guid]::Empty) { throw 'INVALID_SNAPSHOT_ID' }
    $items = @(Get-CimInstance -ClassName Win32_ShadowCopy -Filter "ID = '$Id'" -ErrorAction Stop)
    if ($items.Count -gt 1) { throw 'AMBIGUOUS_SNAPSHOT' }
    if ($items.Count -eq 1) { return $items[0] }
    return $null
}

function Remove-VssOwnedSnapshot {
    param([string]$Root, $Receipt, [string]$Sid)
    # Validate the receipt before interpolating its exact ID in a CIM filter.
    Assert-VssOwnership $null $Receipt $Sid
    $shadow = Get-VssShadow $Receipt.ShadowId
    Assert-VssOwnership $shadow $Receipt $Sid
    $run = Join-Path (Join-Path $Root 'sessions') $Receipt.Id
    $link = Join-Path $run 'snapshot'
    $item = Get-Item -LiteralPath $link -Force -ErrorAction SilentlyContinue
    if ($item) {
        if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0) { throw 'INVALID_SNAPSHOT_LINK' }
        $actual = [RCloneManagerVss.NativeMethods]::GetLinkTarget($link)
        if ($actual.TrimEnd('\') -ine ([string]$Receipt.Device).TrimEnd('\')) { throw 'SNAPSHOT_LINK_MISMATCH' }
        if (-not [RCloneManagerVss.NativeMethods]::RemoveDirectory($link)) { throw 'LINK_REMOVE_FAILED' }
    }
    if ($null -ne $shadow) {
        Remove-CimInstance -InputObject $shadow -ErrorAction Stop
        if ($null -ne (Get-VssShadow $Receipt.ShadowId)) { throw 'SNAPSHOT_STILL_PRESENT' }
    }
    # Keep a tiny, protected acknowledgement for the normal user process.
    Write-VssJson (Join-Path $run 'receipt.json') ([pscustomobject]@{
        Version = 1; Id = $Receipt.Id; Sid = $Sid; ShadowId = $Receipt.ShadowId;
        Volume = $Receipt.Volume; Computer = $Receipt.Computer; Device = $Receipt.Device; Ready = $false; Removed = $true
    })
}

Export-ModuleMember -Function Write-VssJson, Get-VssComputerBinding, Assert-VssSid, Assert-VssPlainPath,
    Assert-VssProtectedRoot, Assert-VssProtectedFile, Assert-VssRequest, Assert-VssOwnership, Get-VssShadow, Remove-VssOwnedSnapshot

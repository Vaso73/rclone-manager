Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
$module = Import-Module (Join-Path $PSScriptRoot 'VssPolicy.psm1') -Force -PassThru
$script:passed = 0
function Check([bool]$Ok, [string]$Name) { if (-not $Ok) { throw ('FAIL: ' + $Name) }; $script:passed++ }
function Reject([scriptblock]$Code, [string]$Name) { $caught=$false; try { $null=& $Code } catch {$caught=$true}; Check $caught $Name }
$sid = 'S-1-5-21-123-456-789-1001'
Assert-VssSid $sid
foreach ($bad in @('', 'S-1-5-18', 'S-1-5-32-544', 'user', 'S-1-5-21-1-2-3-4;command')) { Reject { Assert-VssSid $bad } 'invalid user identity' }
$request = [pscustomobject]@{ Version=1; Id=('a'*32); Sid=$sid; Sources=@('D:\Source', 'D:\Other folder') }
Check ((@(Assert-VssRequest $request $sid)).Count -eq 2) 'valid local request'
foreach ($bad in @('D:relative','D:\\source', '\\server\share', 'D:\a\..\b', 'D:\a\..', 'D:\a:stream', "D:\a`nb", 'remote:path')) {
    $request.Sources=@($bad); Reject { Assert-VssRequest $request $sid } 'invalid source'
}
$request.Sources=@(); Reject { Assert-VssRequest $request $sid } 'empty sources'
$request.Sources=@('D:\Source'); $request.Id='../escape'; Reject { Assert-VssRequest $request $sid } 'invalid run ID'
& $module {
    function script:Get-VssComputerBinding { return 'test-machine' }
    $script:shadow=$null; $script:deletions=0
    function script:Get-VssShadow { param($Id) return $script:shadow }
    function script:Remove-CimInstance { param($InputObject, $ErrorAction) $script:deletions++; $script:shadow=$null }
}
$root = Join-Path ([IO.Path]::GetTempPath()) ('rcm-vss-helper-test-' + [guid]::NewGuid().ToString('N'))
$null=[IO.Directory]::CreateDirectory($root)
try {
    $path=Join-Path $root 'state.json'
    foreach ($revision in 1..4) {
        Write-VssJson $path ([pscustomobject]@{Revision=$revision; Text='Systémové pomôcky'})
        Check ((Get-Content -LiteralPath $path -Raw -Encoding UTF8 | ConvertFrom-Json).Revision -eq $revision) 'repeated JSON write'
        Check (-not [IO.File]::Exists($path+'.new')) 'no staging leftovers'
    }
    $id='{11111111-1111-4111-8111-111111111111}'
    $volume='\\?\Volume{22222222-2222-4222-8222-222222222222}\'
    $device='\\?\GLOBALROOT\Device\HarddiskVolumeShadowCopy123'
    function New-Receipt { return [pscustomobject]@{Version=1; Id=('a'*32); Sid=$sid; ShadowId=$id; Volume=$volume; Computer='test-machine'; Device=$device; Ready=$true; Removed=$false} }
    foreach ($scenario in @('Owned','Absent','OtherSid','OtherMachine','OtherId','OtherVolume','OtherDevice','UnknownId')) {
        $receipt=New-Receipt
        $shadow=[pscustomobject]@{ID=$id; VolumeName=$volume; DeviceObject=$device}
        switch ($scenario) {
            Absent {$shadow=$null}
            OtherSid {$receipt.Sid='S-1-5-21-123-456-789-2002'}
            OtherMachine {$receipt.Computer='other-machine'}
            OtherId {$shadow.ID='{33333333-3333-4333-8333-333333333333}'}
            OtherVolume {$shadow.VolumeName='\\?\Volume{33333333-3333-4333-8333-333333333333}\'}
            OtherDevice {$shadow.DeviceObject='\\?\GLOBALROOT\Device\HarddiskVolumeShadowCopy999'}
            UnknownId {$receipt.ShadowId=$null}
        }
        & $module {param($value) $script:shadow=$value; $script:deletions=0} $shadow
        $run=Join-Path (Join-Path $root 'sessions') $receipt.Id
        $null=[IO.Directory]::CreateDirectory($run)
        $receiptPath=Join-Path $run 'receipt.json'
        Write-VssJson $receiptPath $receipt
        if ($scenario -in @('Owned','Absent')) {
            Remove-VssOwnedSnapshot $root $receipt $sid
            Check ((Get-Content -LiteralPath $receiptPath -Raw | ConvertFrom-Json).Removed) 'exact cleanup acknowledgement'
            $expected=0; if ($scenario -eq 'Owned') {$expected=1}
            Check ((& $module {$script:deletions}) -eq $expected) 'exact cleanup count'
        } else {
            $before=(Get-FileHash -LiteralPath $receiptPath -Algorithm SHA256).Hash
            Reject { Remove-VssOwnedSnapshot $root $receipt $sid } 'foreign or ambiguous snapshot rejected'
            Check ((& $module {$script:deletions}) -eq 0) 'no foreign delete'
            Check ((Get-FileHash -LiteralPath $receiptPath -Algorithm SHA256).Hash -ceq $before) 'receipt unchanged on rejection'
        }
    }
    Add-Type -Path (Join-Path $PSScriptRoot 'Native.cs')
    Check $true 'native helper compilation'
    if ([Environment]::OSVersion.Platform -eq [PlatformID]::Win32NT) {
        $name = 'rcm-vss-unit-' + [guid]::NewGuid().ToString('N')
        $userSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
        $server = $null; $client = $null; $clientWriter = $null; $clientReader = $null; $serverReader = $null; $serverWriter = $null
        try {
            $server = [RCloneManagerVss.PipeFactory]::Create($name, $userSid)
            Reject { [RCloneManagerVss.PipeFactory]::Create($name, $userSid) } 'native pipe cannot replace an existing instance'
            $waiting = $server.BeginWaitForConnection($null, $null)
            $client = New-Object IO.Pipes.NamedPipeClientStream('.', $name, [IO.Pipes.PipeDirection]::InOut, [IO.Pipes.PipeOptions]::Asynchronous, [Security.Principal.TokenImpersonationLevel]::Identification)
            $client.Connect(3000)
            $server.EndWaitForConnection($waiting)
            $clientWriter = New-Object IO.StreamWriter($client, (New-Object Text.UTF8Encoding($false)))
            $clientWriter.AutoFlush = $true
            $serverReader = New-Object IO.StreamReader($server, (New-Object Text.UTF8Encoding($false)))
            $clientWriter.WriteLine('bounded message')
            Check ([RCloneManagerVss.PipeFactory]::ReadLine($serverReader, 100) -ceq 'bounded message') 'native pipe reads its authenticated message'
            Check ([RCloneManagerVss.PipeFactory]::ClientSid($server) -ceq $userSid) 'native pipe identifies caller after the read'
            $serverWriter = New-Object IO.StreamWriter($server, (New-Object Text.UTF8Encoding($false)))
            $serverWriter.AutoFlush = $true
            $clientReader = New-Object IO.StreamReader($client, (New-Object Text.UTF8Encoding($false)))
            $serverWriter.WriteLine('acknowledged')
            Check ($clientReader.ReadLine() -ceq 'acknowledged') 'native pipe replies over the same lease'
        }
        finally {
            foreach ($resource in @($serverWriter,$serverReader,$clientWriter,$clientReader,$client,$server)) {
                if ($resource) { $resource.Dispose() }
            }
        }
    }
    $reader=New-Object IO.StringReader('short')
    # ReadLine requires StreamReader; use an in-memory byte stream for bounded protocol tests.
    $memory=New-Object IO.MemoryStream(,[Text.Encoding]::UTF8.GetBytes("hello`n"))
    $streamReader=New-Object IO.StreamReader($memory)
    Check ([RCloneManagerVss.PipeFactory]::ReadLine($streamReader,10) -ceq 'hello') 'bounded protocol line'
    $streamReader.Dispose(); $reader.Dispose()
    $memory=New-Object IO.MemoryStream(,[Text.Encoding]::UTF8.GetBytes('oversized'))
    $streamReader=New-Object IO.StreamReader($memory)
    Reject {[RCloneManagerVss.PipeFactory]::ReadLine($streamReader,3)} 'oversized protocol rejected'
    $streamReader.Dispose()
    foreach ($file in Get-ChildItem -LiteralPath $PSScriptRoot -File | Where-Object {$_.Extension -in @('.ps1','.psm1')}) {
        $tokens=$null; $errors=$null
        $null=[Management.Automation.Language.Parser]::ParseFile($file.FullName,[ref]$tokens,[ref]$errors)
        Check ($errors.Count -eq 0) ('parser ' + $file.Name)
    }
}
finally {Remove-Item -LiteralPath $root -Recurse -Force}
Write-Host ('PASS: '+$script:passed+' VSS helper checks. Native Windows privileges/pipe/VSS pending.')

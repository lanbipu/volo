# Set (or clear) a client machine's LOCAL zen cache directory.
#
# Node-pure: runs locally on the target (shipped + executed via SSH -File),
# as uecm-svc (admin) — NOT as the UE runtime user.
#
# Why registry, not just the env var (UE 5.8 ZenServerInterface.cpp
# DetermineDataPath priority: -ZenDataPath cmdline > UE-ZenSubprocessDataPath
# env > HKCU Epic Games\Zen\DataPath registry > UE-ZenDataPath env >
# follow-local-DDC > config default):
#   Writing only the Machine env var over SSH (session 0) never reaches the
#   interactive desktop session — WM_SETTINGCHANGE does not cross sessions, so
#   Explorer / Epic Launcher keep their stale environment block and every
#   editor launched from the desktop inherits it. "重启 UE 编辑器" then has no
#   effect until a full logoff/reboot. The HKCU registry tier (same channel the
#   in-editor cache migration uses) is read directly from the registry at every
#   editor launch, so an editor restart is enough.
#
# What this script does:
#   set (DataPath non-empty):
#     1. create the directory + icacls grant RuntimeUser full control
#        (UE validates writability and silently skips the tier otherwise)
#     2. write HKU\<RuntimeUser SID>\Software\Epic Games\Zen  DataPath
#        (skipped with registry_written=false when the user's hive isn't
#        loaded, i.e. the user is not logged on — the env var below still
#        takes effect at that user's NEXT logon)
#     3. write Machine env var UE-ZenDataPath (fallback tier + keeps the
#        legacy channel consistent instead of contradicting the registry)
#   clear (DataPath empty): remove the registry value AND the env var.
#
# stdin JSON: { "RuntimeUser": "...", "DataPath": "D:\\UE_DDC\\Zen" | "" }
# Output JSON: { ok, message, registry_written: bool }
#
# Rust caller: commands::zen::zen_set_local_datapath (Tauri) /
#              `volo zen set-local-datapath` (CLI).

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
chcp 65001 | Out-Null

$ErrorActionPreference = 'Stop'

try {
    $p = [Console]::In.ReadLine() | ConvertFrom-Json
    $RuntimeUser = if ($p.RuntimeUser) { "$($p.RuntimeUser)" } else { '' }
    $DataPath    = if ($p.DataPath)    { "$($p.DataPath)".Trim() } else { '' }

    if ([string]::IsNullOrWhiteSpace($RuntimeUser)) {
        throw "RuntimeUser is required"
    }
    if ($RuntimeUser -match '[\\/:\*\?"<>\|]' -or $RuntimeUser.Contains('..')) {
        throw "RuntimeUser contains invalid characters: $RuntimeUser"
    }
    if ($DataPath -ne '' -and $DataPath -notmatch '^[A-Za-z]:\\') {
        throw "DataPath must be an absolute Windows path (got '$DataPath')"
    }

    # Microsoft-account-linked local users can fail the bare NTAccount lookup
    # ("未能转换部分或所有标识引用") — retry machine-qualified before giving up.
    try {
        $sid = (New-Object System.Security.Principal.NTAccount($RuntimeUser)).Translate(
            [System.Security.Principal.SecurityIdentifier]).Value
    } catch {
        $sid = (New-Object System.Security.Principal.NTAccount($env:COMPUTERNAME, $RuntimeUser)).Translate(
            [System.Security.Principal.SecurityIdentifier]).Value
    }
    $zenKey = "Registry::HKEY_USERS\$sid\Software\Epic Games\Zen"
    $hiveLoaded = Test-Path -LiteralPath "Registry::HKEY_USERS\$sid"

    $registryWritten = $false
    $notes = @()

    if ($DataPath -ne '') {
        # 1. Directory: create + grant the runtime user. UE's ValidateDataPath
        #    does a writability test as that user and silently falls through to
        #    the next tier on failure — provisioning here removes the ambiguity.
        if (-not (Test-Path -LiteralPath $DataPath -PathType Container)) {
            New-Item -ItemType Directory -Path $DataPath -Force | Out-Null
        }
        icacls $DataPath /grant "${RuntimeUser}:(OI)(CI)F" /C | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "icacls grant $RuntimeUser on $DataPath failed" }

        # 2. Registry (primary channel — effective on next editor launch)
        if ($hiveLoaded) {
            if (-not (Test-Path -LiteralPath $zenKey)) {
                New-Item -Path $zenKey -Force | Out-Null
            }
            Set-ItemProperty -LiteralPath $zenKey -Name 'DataPath' -Value $DataPath -Type String
            $rb = (Get-ItemProperty -LiteralPath $zenKey).DataPath
            if ($rb -ne $DataPath) { throw "registry verify failed: read '$rb', expected '$DataPath'" }
            $registryWritten = $true
        } else {
            $notes += "user '$RuntimeUser' is not logged on (hive not loaded) - registry not written; the env var takes effect at that user's next logon"
        }

        # 3. Machine env var (fallback tier; also keeps any legacy value consistent)
        [System.Environment]::SetEnvironmentVariable('UE-ZenDataPath', $DataPath, 'Machine')
        $erb = [System.Environment]::GetEnvironmentVariable('UE-ZenDataPath', 'Machine')
        if ($erb -ne $DataPath) { throw "env var verify failed: read '$erb', expected '$DataPath'" }

        $msg = "set zen data path to $DataPath"
    }
    else {
        # clear: both channels, so no ghost source survives
        if ($hiveLoaded) {
            if (Test-Path -LiteralPath $zenKey) {
                Remove-ItemProperty -LiteralPath $zenKey -Name 'DataPath' -ErrorAction SilentlyContinue
            }
            $registryWritten = $true
        } elseif (Test-Path -LiteralPath $zenKey) {
            $notes += "user '$RuntimeUser' is not logged on (hive not loaded) - a registry DataPath override may remain; re-run clear while the user is logged on"
        }
        [System.Environment]::SetEnvironmentVariable('UE-ZenDataPath', '', 'Machine')
        $erb = [System.Environment]::GetEnvironmentVariable('UE-ZenDataPath', 'Machine')
        if ($null -ne $erb -and $erb -ne '') { throw "env var clear verify failed: still '$erb'" }
        $msg = "cleared zen data path"
    }

    if ($notes.Count -gt 0) { $msg = $msg + ' (' + ($notes -join '; ') + ')' }
    @{ ok = $true; message = $msg; registry_written = $registryWritten } | ConvertTo-Json -Compress
}
catch {
    @{ ok = $false; message = "$($_.Exception.Message)"; registry_written = $false } | ConvertTo-Json -Compress
    exit 0
}

# Read a client machine's LOCAL zen runcontext — the editor-launched zen's
# last-known launch record at:
#   C:\Users\<RuntimeUser>\AppData\Local\UnrealEngine\Common\Zen\Install\zenserver.runcontext
#
# Purpose (Cache · ZenServer 客户端「本地 Zen 缓存目录」真实回读):
#   UE resolves the local zen data path through a priority chain
#   (-ZenDataPath cmdline > HKCU Epic Games\Zen\DataPath registry >
#   UE-ZenDataPath env var > follow-local-DDC > %LOCALAPPDATA% default —
#   see UE 5.8 ZenServerInterface.cpp DetermineDataPath). Volo configures
#   the env-var tier, but a higher tier can silently win, so the UI must
#   show the ACTUAL last-used path (this file's DataPath) next to the
#   configured value instead of trusting the env var.
#
# Parameters (stdin JSON):
#   -RuntimeUser <string>  Windows username whose profile hosts the runcontext
#                          (machines.ue_runtime_user — same precondition as
#                          the 用户全局 UserEngine.ini write path).
#
# Output (single JSON object on stdout):
#   { "ok": true, "found": false,
#     "registry_data_path": null }                          — file absent (editor
#                                                             never launched zen)
#   { "ok": true, "found": true,
#     "data_path": "D:/Unreal Projects/DDC/Zen",
#     "executable": "C:/Users/x/.../zenserver.exe",
#     "commandline_arguments": "--port 8558 ...",
#     "running": true,
#     "registry_data_path": null }                          — running = a zenserver
#                                                             process with this exact
#                                                             executable is alive now
#
# registry_data_path: the user's HKCU\Software\Epic Games\Zen DataPath override
# (written by in-editor cache migration; it BEATS the UE-ZenDataPath env var in
# UE's priority chain). Read via HKU\<SID> — best-effort: only readable while
# that user's registry hive is loaded (user logged on); null = absent OR unreadable.
#
# Rust parser: commands::zen::zen_read_local_runcontext (Tauri).

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
chcp 65001 | Out-Null

$ErrorActionPreference = 'Stop'

$p = [Console]::In.ReadLine() | ConvertFrom-Json
$RuntimeUser = if ($p.RuntimeUser) { "$($p.RuntimeUser)" } else { '' }

try {
    if ([string]::IsNullOrWhiteSpace($RuntimeUser)) {
        throw "RuntimeUser is required"
    }
    # The username lands in a filesystem path — reject separators / traversal
    # so a corrupt DB row can't read outside C:\Users\<user>.
    if ($RuntimeUser -match '[\\/:\*\?"<>\|]' -or $RuntimeUser.Contains('..')) {
        throw "RuntimeUser contains invalid characters: $RuntimeUser"
    }
    $profileDir = "C:\Users\$RuntimeUser"
    if (-not (Test-Path -LiteralPath $profileDir -PathType Container)) {
        throw "user profile not found: $profileDir (is ue_runtime_user correct?)"
    }
    # HKCU Zen\DataPath override for that user, via HKU\<SID>. Wrapped so a
    # failed SID translate / unloaded hive degrades to null, never to an error.
    $regDataPath = $null
    try {
        # Microsoft-account-linked local users can fail the bare NTAccount
        # lookup — retry machine-qualified before degrading to null.
        try {
            $sid = (New-Object System.Security.Principal.NTAccount($RuntimeUser)).Translate(
                [System.Security.Principal.SecurityIdentifier]).Value
        } catch {
            $sid = (New-Object System.Security.Principal.NTAccount($env:COMPUTERNAME, $RuntimeUser)).Translate(
                [System.Security.Principal.SecurityIdentifier]).Value
        }
        $zenKey = "Registry::HKEY_USERS\$sid\Software\Epic Games\Zen"
        if (Test-Path -LiteralPath $zenKey) {
            $regDataPath = (Get-ItemProperty -LiteralPath $zenKey -ErrorAction SilentlyContinue).DataPath
            if ([string]::IsNullOrWhiteSpace($regDataPath)) { $regDataPath = $null }
        }
    } catch { $regDataPath = $null }

    $rcPath = "$profileDir\AppData\Local\UnrealEngine\Common\Zen\Install\zenserver.runcontext"
    if (-not (Test-Path -LiteralPath $rcPath -PathType Leaf)) {
        @{ ok = $true; found = $false; registry_data_path = $regDataPath } | ConvertTo-Json -Compress
        exit 0
    }
    $rc = Get-Content -LiteralPath $rcPath -Raw | ConvertFrom-Json

    # Is that exact zen binary running right now? (Filters out the SHARED
    # ZenServer service's zenserver.exe on co-located machines — different
    # executable path.)
    $running = $false
    $rcExe = "$($rc.Executable)" -replace '/', '\'
    if (-not [string]::IsNullOrWhiteSpace($rcExe)) {
        $procs = Get-CimInstance Win32_Process -Filter "Name='zenserver.exe'" -ErrorAction SilentlyContinue
        foreach ($proc in @($procs)) {
            if ($null -ne $proc.ExecutablePath -and
                ($proc.ExecutablePath -replace '/', '\') -ieq $rcExe) {
                $running = $true
                break
            }
        }
    }

    @{
        ok = $true
        found = $true
        data_path = "$($rc.DataPath)"
        executable = "$($rc.Executable)"
        commandline_arguments = "$($rc.CommandlineArguments)"
        running = $running
        registry_data_path = $regDataPath
    } | ConvertTo-Json -Compress
}
catch {
    @{ ok = $false; message = "$($_.Exception.Message)" } | ConvertTo-Json -Compress
    exit 0
}

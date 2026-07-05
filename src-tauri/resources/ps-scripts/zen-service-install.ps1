# Plan 7 T2.4 sidecar - install zen as a Windows service.
#
# Purpose:
#   Register the UE in-tree zenserver.exe as a Windows service via sc.exe.
#   Does NOT use `zen.exe service install` — direct sc.exe create gives full
#   control over the service name, account, and ImagePath, matching Epic's
#   official "Zenserver as Shared DDC" deployment guide and avoiding the
#   hardcoded "ZenServer" name that collides with UE's built-in service
#   management (ConditionalUpdateSystemServiceInstall in ZenServerInterface.cpp).
#
#   2026-07-02: reverted the 2026-07-01 `--config=`-only launch args BACK to
#   explicit CLI flags. That revision trusted Epic's "Set up Zen Storage
#   Server as Shared DDC" guide (flat dotted-key lua), but zenserver 5.8.13
#   does NOT parse that lua form — a service launched with `--config=` alone
#   silently fell back to ALL defaults (cache data landed in
#   C:\ProgramData\Epic\Zen\Data instead of the operator-chosen data dir,
#   and GC settings never applied). Empirically verified via zen's own
#   `--write-config` dump + probe runs (see core::zen::lua_config module
#   docs): the lua file only reliably carries `server = { datadir = ... }`,
#   while `--port` / `--data-dir` / `--http` / `--gc-*` are real flags
#   (hidden from --help; UE 5.8 itself launches its local zen with them).
#   So the ImagePath now carries ALL runtime settings as flags, with
#   `--config=` kept as a redundant datadir carrier rendered from the same
#   DB row (the two can never disagree).
#
# Parameters:
#   -ZenExePath   <string>  absolute path to zen.exe (the sibling
#                           zenserver.exe is resolved from this).
#   -ServiceName  <string>  Windows service name. Default "UECMZenServer".
#   -ConfigPath   <string>  absolute path to zen_config.lua (written by
#                           zen-write-lua-config.ps1 beforehand — this script
#                           only references it, never writes it).
#   -Port             <int>     zenserver listen port (`--port`). Required.
#   -DataDir          <string>  zen persistence root (`--data-dir`). Required.
#                               Also icacls-granted read+write when ServiceUser
#                               is non-builtin (ZenInstall gets read+execute).
#   -HttpServerClass  <string>  `--http` value: "httpsys" | "asio". Required.
#   -GcIntervalSeconds            <int> optional → `--gc-interval-seconds`.
#   -GcLightweightIntervalSeconds <int> optional → `--gc-lightweight-interval-seconds`.
#   -GcCacheDurationSeconds       <int> optional → `--gc-cache-duration-seconds`.
#   -ServiceUser      <string>  optional service account (default: LocalService).
#                               A gMSA account (trailing '$') needs no password.
#   -ServicePassword  <string>  optional password for non-built-in, non-gMSA accounts.
#   -PatchArgsOnly    <bool>    optional. When true, only rewrite the EXISTING
#                               service's ImagePath args (config/port/data-dir/
#                               http/gc flags) in place — no sc create, no
#                               account handling, no icacls. Used by the GC
#                               settings update flow, which doesn't know the
#                               service account and must not touch it. The
#                               caller restarts the service afterwards.
#
# Output (single JSON object on stdout):
#   {
#     "ok": true,
#     "service_name": "UECMZenServer",
#     "binpath": "\"...\\zenserver.exe\" --config=\"...\\zen_config.lua\"",
#     "message": "service 'UECMZenServer' created successfully"
#   }
#
# Rust parser: core::zen::service::parse_install_response (T2.5).

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
chcp 65001 | Out-Null

$ErrorActionPreference = 'Stop'

# Resolve the service binary (exe) from an SCM ImagePath / Win32_Service
# PathName. The first token can take three shapes:
#   - double-quoted:           "D:\Program Files\...\zenserver.exe" --config=...
#   - unquoted WITH spaces:    D:\Program Files\...\zenserver.exe --config=...
#   - unquoted without spaces: C:\Users\...\Install\zenserver.exe --config=...
# Bug A (2026-06-05 lanPC E2E): zen registers the service with the in-tree exe
# path UNQUOTED, and once Bug 4 moved resolution to the in-tree copy that path
# lives under `D:\Program Files\Epic Games\...` (spaces). A naive whitespace
# split took token[0] = 'D:\Program', so Normalize-ZenExe produced
# 'd:\zenserver.exe' and every idempotent re-install / drift-repair falsely
# reported 'different ZenExePath'. Reconstruct up to the first '.exe' boundary
# instead of splitting on whitespace.
function Resolve-ServiceExe([string]$imagePath) {
    if ([string]::IsNullOrWhiteSpace($imagePath)) { return $null }
    $s = $imagePath.Trim()
    if ($s.StartsWith('"')) {
        $end = $s.IndexOf('"', 1)
        if ($end -gt 1) { return $s.Substring(1, $end - 1) }
        return $s.Substring(1)
    }
    # Unquoted: take everything up to and including the first '.exe' that is
    # followed by whitespace or end-of-string, so a parent directory literally
    # named '...\foo.exe\...' doesn't truncate the real binary.
    $m = [regex]::Match($s, '^(.*?\.exe)(\s|$)',
        [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)
    if ($m.Success) { return $m.Groups[1].Value }
    # Fallback: first whitespace-delimited token.
    return ($s -split '\s+', 2)[0]
}

# Quote-aware ImagePath tokenizer: collapses `--config="path"` to a single
# `--config=path` token and keeps quoted spaced values intact.
function Split-ImagePathTokens([string]$imagePath) {
    $tokens = New-Object System.Collections.ArrayList
    if ([string]::IsNullOrWhiteSpace($imagePath)) { return ,$tokens }
    $current = ''
    $inQuote = $false
    foreach ($ch in $imagePath.ToCharArray()) {
        if ($ch -eq '"') {
            $inQuote = -not $inQuote
            continue
        }
        if ((-not $inQuote) -and ($ch -eq ' ' -or $ch -eq "`t")) {
            if ($current.Length -gt 0) {
                [void]$tokens.Add($current)
                $current = ''
            }
        } else {
            $current += $ch
        }
    }
    if ($current.Length -gt 0) { [void]$tokens.Add($current) }
    return ,$tokens
}

# Parse the runtime args out of an existing ImagePath into a hashtable
# (config / port / datadir / http / gc-interval / gc-lightweight / gc-duration;
# absent flags stay $null). Accepts both `--flag value` and `--flag=value`
# forms — this script's own builder emits the space form for value flags and
# `=` for --config, but a hand-edited ImagePath may use either.
function Get-ZenImagePathArgs([string]$imagePath) {
    $out = @{
        config = $null; port = $null; datadir = $null; http = $null
        gcinterval = $null; gclightweight = $null; gcduration = $null
    }
    $flagMap = @{
        '--config' = 'config'; '--port' = 'port'; '--data-dir' = 'datadir'
        '--http' = 'http'; '--gc-interval-seconds' = 'gcinterval'
        '--gc-lightweight-interval-seconds' = 'gclightweight'
        '--gc-cache-duration-seconds' = 'gcduration'
    }
    $tokens = Split-ImagePathTokens $imagePath
    for ($i = 0; $i -lt $tokens.Count; $i++) {
        $t = $tokens[$i].ToString()
        foreach ($flag in $flagMap.Keys) {
            if ($t -ieq $flag -and ($i + 1) -lt $tokens.Count) {
                $out[$flagMap[$flag]] = $tokens[$i + 1].ToString()
                break
            }
            if ($t -match ('^' + [regex]::Escape($flag) + '=(.*)$')) {
                $out[$flagMap[$flag]] = $Matches[1]
                break
            }
        }
    }
    return $out
}

# Canonical ImagePath builder — the single source of the service command
# line for fresh installs AND drift repair. zen 5.8.13 only honors
# `server = { datadir = ... }` from zen_config.lua; port / http class / GC
# retention MUST ride the command line (empirically verified 2026-07-02:
# unknown flags dump usage while these don't, and `--port 9877` logged
# "starting on port 9877" — see core::zen::lua_config module docs).
# GC values are optional strings; $null/'' omits the flag so zenserver
# falls back to its compiled-in default.
function Build-ZenImagePath(
    [string]$exe, [string]$configPath, [string]$port, [string]$dataDir,
    [string]$http, [string]$gcInterval, [string]$gcLightweight, [string]$gcDuration
) {
    $p = '"' + ([System.IO.Path]::GetFullPath($exe).TrimEnd('\')) + '"'
    $p += ' --config="' + $configPath + '"'
    $p += " --port $port"
    $p += ' --data-dir "' + ([System.IO.Path]::GetFullPath($dataDir).TrimEnd('\')) + '"'
    $p += " --http $http"
    if (-not [string]::IsNullOrWhiteSpace($gcInterval)) { $p += " --gc-interval-seconds $gcInterval" }
    if (-not [string]::IsNullOrWhiteSpace($gcLightweight)) { $p += " --gc-lightweight-interval-seconds $gcLightweight" }
    if (-not [string]::IsNullOrWhiteSpace($gcDuration)) { $p += " --gc-cache-duration-seconds $gcDuration" }
    return $p
}

# Normalize helpers for field comparison.
function Normalize-PathField([string]$p) {
    if ([string]::IsNullOrWhiteSpace($p)) { return $null }
    try { return [System.IO.Path]::GetFullPath($p).TrimEnd('\').ToLowerInvariant() }
    catch { return $p.TrimEnd('\').ToLowerInvariant() }
}
function Normalize-ValueField([string]$v) {
    if ([string]::IsNullOrWhiteSpace($v)) { return $null }
    return $v.Trim().ToLowerInvariant()
}

# --- Test seam ---------------------------------------------------------------
# When dot-sourced with UECM_PS_DEFINE_ONLY=1, the pure helper functions defined
# ABOVE this line are made available and the script returns before reading stdin
# or touching the SCM, so __tests__\zen-service-install.tests.ps1 can unit-test
# them. Production (run via -File over the WinRM/SSH transport) never sets this
# env var, so this is a no-op there.
if ($env:UECM_PS_DEFINE_ONLY -eq '1') { return }

# Read named parameters from stdin (JSON). Bound here BEFORE the pre-try
# `--full` hard-block so that block still inspects the real values. The
# mandatory ZenExePath / ConfigPath get a null-guard; ServiceName falls back to
# its old default; ServiceUser / ServicePassword default to empty string
# (zen keeps its hardcoded NT AUTHORITY\LocalService when both are empty).
# ServicePassword is a SECRET — never interpolate it into any error / log line.
$p = [Console]::In.ReadToEnd() | ConvertFrom-Json
if ([string]::IsNullOrWhiteSpace($p.ZenExePath)) {
    @{ ok = $false; message = "ZenExePath is required" } | ConvertTo-Json -Compress
    exit 0
}
if ([string]::IsNullOrWhiteSpace($p.ConfigPath)) {
    @{ ok = $false; message = "ConfigPath is required" } | ConvertTo-Json -Compress
    exit 0
}
$ZenExePath = $p.ZenExePath
$ServiceName = if ($p.ServiceName) { $p.ServiceName } else { 'ZenServer' }
$ConfigPath = $p.ConfigPath
$ServiceUser = if ($p.ServiceUser) { $p.ServiceUser } else { '' }
$ServicePassword = if ($p.ServicePassword) { $p.ServicePassword } else { '' }
$DataDir = if ($p.DataDir) { $p.DataDir } else { '' }
# Runtime flags baked into the service ImagePath — zen_config.lua cannot
# carry these on zen 5.8 (see header). Port/DataDir/HttpServerClass are
# required; GC values optional (absent → zen compiled-in defaults).
$Port = if ($null -ne $p.Port) { "$($p.Port)" } else { '' }
$HttpServerClass = if ($p.HttpServerClass) { $p.HttpServerClass } else { '' }
$GcIntervalSeconds = if ($null -ne $p.GcIntervalSeconds) { "$($p.GcIntervalSeconds)" } else { '' }
$GcLightweightIntervalSeconds = if ($null -ne $p.GcLightweightIntervalSeconds) { "$($p.GcLightweightIntervalSeconds)" } else { '' }
$GcCacheDurationSeconds = if ($null -ne $p.GcCacheDurationSeconds) { "$($p.GcCacheDurationSeconds)" } else { '' }
$PatchArgsOnly = ($p.PatchArgsOnly -eq $true)
if ([string]::IsNullOrWhiteSpace($Port) -or [string]::IsNullOrWhiteSpace($DataDir) -or [string]::IsNullOrWhiteSpace($HttpServerClass)) {
    @{ ok = $false; message = "Port, DataDir and HttpServerClass are required (they ride the service ImagePath as zenserver CLI flags — zen 5.8 does not read them from zen_config.lua)" } | ConvertTo-Json -Compress
    exit 0
}
if ($Port -notmatch '^\d+$') {
    @{ ok = $false; message = "Port must be a positive integer, got: $Port" } | ConvertTo-Json -Compress
    exit 0
}
if (@('httpsys', 'asio') -notcontains $HttpServerClass.Trim().ToLowerInvariant()) {
    @{ ok = $false; message = "HttpServerClass must be 'httpsys' or 'asio', got: $HttpServerClass" } | ConvertTo-Json -Compress
    exit 0
}
foreach ($gcPair in @(@('GcIntervalSeconds', $GcIntervalSeconds), @('GcLightweightIntervalSeconds', $GcLightweightIntervalSeconds), @('GcCacheDurationSeconds', $GcCacheDurationSeconds))) {
    if (-not [string]::IsNullOrWhiteSpace($gcPair[1]) -and $gcPair[1] -notmatch '^\d+$') {
        @{ ok = $false; message = "$($gcPair[0]) must be a positive integer, got: $($gcPair[1])" } | ConvertTo-Json -Compress
        exit 0
    }
}

# ----------------------------------------------------------------------------
# Helpers (script scope so both the idempotency path and the post-install
# `sc.exe config` path can reuse them).
# ----------------------------------------------------------------------------

# Built-in account name normalization: SCM stores LocalSystem as
# `LocalSystem`, LocalService as `NT AUTHORITY\LocalService`, NetworkService
# as `NT AUTHORITY\NetworkService`. Operator input may use either short or
# long form; normalize both sides for equality checks.
function Normalize-Account([string]$a) {
    if ([string]::IsNullOrWhiteSpace($a)) { return '' }
    $t = $a.Trim().ToLowerInvariant()
    switch -Regex ($t) {
        '^(localsystem|nt authority\\system|nt authority\\localsystem|\.\\localsystem)$' { 'localsystem' }
        '^(localservice|nt authority\\localservice|\.\\localservice)$' { 'localservice' }
        '^(networkservice|nt authority\\networkservice|\.\\networkservice)$' { 'networkservice' }
        default { $t -replace '^\.\\', '' }
    }
}

# Read a service's `StartName` (account it runs as) with CIM first and a
# registry fallback. Hosts that have WMI/CIM disabled by policy still need
# to be supported for both idempotency checks AND post-`sc.exe config`
# verification — without the fallback we'd misread null and trip rollback
# even when sc.exe succeeded.
function Get-ServiceAccount([string]$Name) {
    try {
        $cim = Get-CimInstance -ClassName Win32_Service `
            -Filter "Name='$Name'" -ErrorAction Stop
        if ($null -ne $cim -and $null -ne $cim.StartName) {
            return $cim.StartName
        }
    } catch { }
    try {
        $regPath = "HKLM:\SYSTEM\CurrentControlSet\Services\$Name"
        return (Get-ItemProperty -LiteralPath $regPath `
            -Name 'ObjectName' -ErrorAction Stop).ObjectName
    } catch { }
    return $null
}

# Bug 2 (2026-06-05 lanPC E2E): UECM hands `zen service install` the CLI
# `zen.exe`, but zen registers the sibling `zenserver.exe` as the SCM service
# binary (zen/cmds/service_cmd.cpp:431-437). So the requested ZenExePath
# (zen.exe) and the existing service's ImagePath token0 (zenserver.exe) never
# compare equal by raw path, and even a config-correct re-install was misjudged
# as `different ZenExePath`. Normalize both to "<dir>\zenserver.exe" so the
# idempotency / drift check treats them as the same install when co-located.
function Normalize-ZenExe([string]$p) {
    if ([string]::IsNullOrWhiteSpace($p)) { return $null }
    $full = $p
    try { $full = [System.IO.Path]::GetFullPath($p) } catch { }
    $dir = $null
    try { $dir = [System.IO.Path]::GetDirectoryName($full) } catch { }
    if ([string]::IsNullOrEmpty($dir)) { return $full.TrimEnd('\').ToLowerInvariant() }
    return (Join-Path $dir 'zenserver.exe').TrimEnd('\').ToLowerInvariant()
}

try {
    # --- Validate ZenExePath -------------------------------------------------
    if ([string]::IsNullOrWhiteSpace($ZenExePath)) {
        throw "ZenExePath must be non-empty"
    }
    if (-not (Test-Path -LiteralPath $ZenExePath -PathType Leaf)) {
        throw "ZenExePath not found or not a file: $ZenExePath"
    }

    # --- Validate ServiceName ------------------------------------------------
    if ([string]::IsNullOrWhiteSpace($ServiceName)) {
        throw "ServiceName must be non-empty"
    }
    # Reject wildcards in the service identifier — defense in depth even
    # though zen.exe itself would likely refuse `*` / `?`.
    if ($ServiceName -match '[\*\?\[\]]') {
        throw "ServiceName must be a literal name (no wildcards `*` `?` `[` `]`), got: $ServiceName"
    }

    # --- Validate ServiceUser / ServicePassword ------------------------------
    # Codex P2: move this check BEFORE `zen service install` so a missing
    # password on a non-built-in account doesn't leave a half-installed
    # service behind. Without this, retries see the orphan LocalService
    # install and refuse on account mismatch until manual uninstall.
    if (-not [string]::IsNullOrWhiteSpace($ServiceUser)) {
        $normalizedUserUpfront = Normalize-Account $ServiceUser
        $isBuiltinUpfront = @('localsystem', 'localservice', 'networkservice') -contains $normalizedUserUpfront
        # gMSA accounts (trailing '$') are AD-managed and never take a
        # password — mirrors the $isGmsa check later in this script (the
        # actual sc-create branch that skips `password=` for them). Without
        # this exemption here, every gMSA install fails this upfront gate
        # before ever reaching that branch.
        $isGmsaUpfront = $ServiceUser.TrimEnd().EndsWith('$')
        if (-not $isBuiltinUpfront -and -not $isGmsaUpfront -and [string]::IsNullOrEmpty($ServicePassword)) {
            throw ("ServiceUser '{0}' is not a built-in account or a gMSA (trailing '$'); " +
                   "ServicePassword is required (built-in accounts: LocalSystem / LocalService / " +
                   "NetworkService).") `
                  -f $ServiceUser
        }
    }

    # --- Validate ConfigPath --------------------------------------------------
    if ([string]::IsNullOrWhiteSpace($ConfigPath)) {
        throw "ConfigPath must be non-empty"
    }
    # Same fully-qualified-path requirement as zen-write-lua-config.ps1's
    # DestPath: `IsPathRooted` accepts drive-relative (`D:zen_config.lua`) and
    # root-relative (`\zen_config.lua`) paths that `GetFullPath` would resolve
    # against whatever the remote session's CWD happens to be.
    $configPathTrim = $ConfigPath.Trim()
    if ($configPathTrim -match '^\\\\[\?\.]\\' -or $configPathTrim -match '^//[\?\.]/') {
        throw ("ConfigPath must not use the Win32 device namespace prefix " +
               "(\\?\ / \\.\); got: $ConfigPath")
    }
    $isDriveAbsolute = $configPathTrim -match '^[A-Za-z]:[\\/]'
    $isUnc = ($configPathTrim.StartsWith('\\') -or $configPathTrim.StartsWith('//')) -and
             -not ($configPathTrim -match '^\\\\[\?\.]\\') -and
             -not ($configPathTrim -match '^//[\?\.]/')
    if (-not ($isDriveAbsolute -or $isUnc)) {
        throw ("ConfigPath must be a fully-qualified absolute path " +
               "(e.g. 'D:\ZenData\zen_config.lua' or '\\host\share\zen_config.lua'); " +
               "drive-relative or root-relative paths are not accepted. Got: $ConfigPath")
    }
    $normalizedConfigPath = [System.IO.Path]::GetFullPath($configPathTrim)
    # zen-write-lua-config.ps1 (apply-config) must have already written this
    # file — the service can't start with `--config=` pointing at nothing.
    if (-not (Test-Path -LiteralPath $normalizedConfigPath -PathType Leaf)) {
        throw ("ConfigPath '$normalizedConfigPath' does not exist — run zen-apply-config " +
               "(zen_apply_config) first to render and write zen_config.lua")
    }

    # --- PatchArgsOnly: rewrite the existing service's ImagePath args ---------
    # Used by the GC-settings update flow: it knows the desired runtime args
    # but NOT the service account, so it must never run the account-matching
    # install logic below (which would false-refuse on e.g. a LocalSystem
    # service). ImagePath and the service account are independent — patching
    # one never touches the other. The caller restarts the service afterwards.
    if ($PatchArgsOnly) {
        $svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
        if ($null -eq $svc) {
            @{
                ok = $false
                service_name = $ServiceName
                message = "PatchArgsOnly: service '$ServiceName' is not installed — run service install first"
            } | ConvertTo-Json -Compress
            exit 0
        }
        $regPath = "HKLM:\SYSTEM\CurrentControlSet\Services\$ServiceName"
        $curBin = (Get-ItemProperty -LiteralPath $regPath -Name 'ImagePath' -ErrorAction Stop).ImagePath
        $existingExeRaw = Resolve-ServiceExe $curBin
        # Identity guard: refuse to rewrite the ImagePath of a service whose
        # binary isn't the zenserver.exe this endpoint's row points at.
        if ((Normalize-ZenExe $existingExeRaw) -ne (Normalize-ZenExe $ZenExePath)) {
            @{
                ok = $false
                service_name = $ServiceName
                existing_path_name = $curBin
                message = ("PatchArgsOnly: service '{0}' runs a different binary ('{1}') than " +
                           "this endpoint's zenserver.exe ('{2}') — refusing to rewrite its args.") `
                          -f $ServiceName, $existingExeRaw, $ZenExePath
            } | ConvertTo-Json -Compress
            exit 0
        }
        $newBin = Build-ZenImagePath $existingExeRaw $normalizedConfigPath $Port $DataDir $HttpServerClass `
            $GcIntervalSeconds $GcLightweightIntervalSeconds $GcCacheDurationSeconds
        Set-ItemProperty -LiteralPath $regPath -Name 'ImagePath' -Value $newBin -ErrorAction Stop
        @{
            ok = $true
            service_name = $ServiceName
            patched = $true
            existing_path_name = $curBin
            new_path_name = $newBin
            message = "patched ImagePath args on service '$ServiceName'; restart the service to apply."
        } | ConvertTo-Json -Compress -Depth 4
        exit 0
    }

    # --- Legacy service name migration -------------------------------------------
    # UECM previously used "ZenServer" as the service name. UE's built-in
    # ConditionalUpdateSystemServiceInstall() hardcodes that exact name and
    # triggers update/uninstall/relaunch dialogs when the ImagePath doesn't
    # match the running UE version's expectations. Renamed to "UECMZenServer"
    # to avoid multi-version UE conflicts. Auto-migrate: if the old service
    # exists, stop and remove it so the port is freed for the new name.
    $legacyServiceName = 'ZenServer'
    if ($ServiceName -ne $legacyServiceName) {
        $legacySvc = Get-Service -Name $legacyServiceName -ErrorAction SilentlyContinue
        if ($null -ne $legacySvc) {
            if ($legacySvc.Status -eq 'Running') {
                Stop-Service -Name $legacyServiceName -Force -ErrorAction SilentlyContinue
                Start-Sleep -Seconds 2
            }
            & sc.exe delete $legacyServiceName 2>&1 | Out-Null
            Start-Sleep -Seconds 1
        }
    }

    # --- Handle an already-installed service ----------------------------------
    # `zen service install` (without --full, which Plan §12 forbids) is a
    # no-op when the service is already registered: it exits 0 without
    # changing the existing service's binary path / command line / config.
    # We split the cases:
    #
    # - Existing service with the SAME ZenExePath + same `--config` →
    #   idempotent no-op, ok=true with `already_installed=true`. Lets
    #   `zen enable` retries succeed when the service is already in the
    #   desired state.
    # - Existing service with a DIFFERENT path or config → refuse with
    #   a clear error pointing the operator at `service uninstall`. Telling
    #   the caller ok=true here would silently leave UECM thinking the
    #   desired config is live when actually the prior config is.
    #   `commands::zen::zen_service_install` (Rust) string-matches this
    #   refusal's "Refusing to re-install without --full" wording to
    #   auto-uninstall + retry once — keep that phrase in sync if it changes.
    $existingSvc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
    if ($null -ne $existingSvc) {
        $existingPathName = $null
        $existingStartName = $null
        try {
            $cim = Get-CimInstance -ClassName Win32_Service `
                -Filter "Name='$ServiceName'" -ErrorAction Stop
            if ($null -ne $cim) {
                $existingPathName = $cim.PathName
                $existingStartName = $cim.StartName
            }
        } catch {
            # Fallback to registry if CIM is unavailable (rare).
            # Codex P3: read both ImagePath AND ObjectName — without
            # ObjectName the account comparison sees `null` vs the
            # requested account and flags drift even when the service is
            # already in the desired state.
            try {
                $regPath = "HKLM:\SYSTEM\CurrentControlSet\Services\$ServiceName"
                $regProps = Get-ItemProperty -LiteralPath $regPath -ErrorAction Stop
                $existingPathName = $regProps.ImagePath
                $existingStartName = $regProps.ObjectName
            } catch {
                # We'll fall through with $null; mismatch defaults to refuse.
            }
        }

        # Parse the existing PathName's runtime args and field-compare against
        # the requested set (config / port / data-dir / http / gc flags).
        # Substring matching is unsafe because `D:\zen_config.lua` is a
        # substring of `D:\zen_config.lua.bak`, which would falsely report
        # idempotent no-op while the SCM actually points at a different file.
        $matchesExpected = $false
        $exeMatches = $false
        $argsDiff = @()
        if ($null -ne $existingPathName -and $existingPathName.Length -gt 0) {
            $expectedExe = Normalize-ZenExe $ZenExePath
            # The service binary is the FIRST element of the ImagePath, but it
            # can be an unquoted path containing spaces (Bug A) — so reconstruct
            # it with Resolve-ServiceExe rather than trusting token[0]. Normalize
            # both sides to "<dir>\zenserver.exe" (Bug 2) so the zen.exe we were
            # handed compares equal to the registered zenserver.exe sibling.
            $existingExe = Normalize-ZenExe (Resolve-ServiceExe $existingPathName)
            $exeMatches = ($existingExe -eq $expectedExe)

            $existing = Get-ZenImagePathArgs $existingPathName
            $desired = @{
                config = Normalize-PathField $normalizedConfigPath
                port = Normalize-ValueField $Port
                datadir = Normalize-PathField $DataDir
                http = Normalize-ValueField $HttpServerClass
                gcinterval = Normalize-ValueField $GcIntervalSeconds
                gclightweight = Normalize-ValueField $GcLightweightIntervalSeconds
                gcduration = Normalize-ValueField $GcCacheDurationSeconds
            }
            foreach ($field in @('config', 'port', 'datadir', 'http', 'gcinterval', 'gclightweight', 'gcduration')) {
                $ex = if ($field -eq 'config' -or $field -eq 'datadir') {
                    Normalize-PathField $existing[$field]
                } else {
                    Normalize-ValueField $existing[$field]
                }
                if ($ex -ne $desired[$field]) {
                    $argsDiff += ("{0}: '{1}' -> '{2}'" -f $field, $ex, $desired[$field])
                }
            }
            $matchesExpected = $exeMatches -and ($argsDiff.Count -eq 0)
        }

        # Codex P2: ServiceUser must match too. Without this an
        # idempotent-no-op path would return ok=true on existing service
        # while the requested account (e.g. LocalSystem) doesn't get
        # applied — the entire point of the new --service-user flag.
        # Uses the script-scope `Normalize-Account` helper above.
        $requestedAccount = if ([string]::IsNullOrWhiteSpace($ServiceUser)) {
            # zen's default — what the install would land as when no -u
            # supplied. Defaulted here so the comparison is meaningful.
            'localservice'
        } else {
            Normalize-Account $ServiceUser
        }
        $existingAccount = Normalize-Account $existingStartName
        $userMatches = ($requestedAccount -eq $existingAccount)

        if ($matchesExpected -and $userMatches) {
            @{
                ok = $true
                service_name = $ServiceName
                already_installed = $true
                existing_status = "$($existingSvc.Status)"
                existing_path_name = $existingPathName
                existing_service_account = $existingStartName
                message = "service '$ServiceName' already installed with matching config (no-op)"
            } | ConvertTo-Json -Compress -Depth 4
            exit 0
        }

        # exe + account match and only the runtime args drifted (config path,
        # port, data-dir, http class, or GC flags — e.g. GC settings changed,
        # or the service predates the flags-on-ImagePath form). Patch the SCM
        # ImagePath in place and report repaired=true. This is the same
        # surgical registry edit the fresh-install path does below, NOT `zen
        # service install --full`, so it stays on the right side of the Plan 7
        # §12 red line. The running process keeps its old command line until a
        # stop+start.
        if ($exeMatches -and $userMatches -and ($argsDiff.Count -gt 0)) {
            try {
                # DataDir may be exactly what drifted (a deploy-config change,
                # not just GC settings) — unlike the fresh-install branch
                # below, this in-place patch never creates the directory or
                # grants a non-builtin account access to it. Do that here too,
                # BEFORE the patched ImagePath goes live, so a dedicated-account
                # service doesn't come back up unable to read/write its own
                # data dir once the caller stops+starts it.
                if (-not [string]::IsNullOrWhiteSpace($DataDir)) {
                    if (-not (Test-Path -LiteralPath $DataDir -PathType Container)) {
                        New-Item -ItemType Directory -Path $DataDir -Force | Out-Null
                    }
                    $repairAccount = Normalize-Account $existingStartName
                    $repairIsBuiltin = @('localsystem', 'localservice', 'networkservice') -contains $repairAccount
                    if (-not $repairIsBuiltin -and -not [string]::IsNullOrWhiteSpace($existingStartName)) {
                        $repairIcaclsOutput = (icacls $DataDir /grant "${existingStartName}:(OI)(CI)M" 2>&1 | Out-String)
                        if ($LASTEXITCODE -ne 0) {
                            @{
                                ok = $false
                                service_name = $ServiceName
                                message = "icacls grant on DataDir failed while repairing ImagePath drift (exit $LASTEXITCODE): $repairIcaclsOutput"
                            } | ConvertTo-Json -Compress -Depth 4
                            exit 0
                        }
                    }
                }
                $regPath = "HKLM:\SYSTEM\CurrentControlSet\Services\$ServiceName"
                $curBin = (Get-ItemProperty -LiteralPath $regPath -Name 'ImagePath' -ErrorAction Stop).ImagePath
                $newBin = Build-ZenImagePath (Resolve-ServiceExe $curBin) $normalizedConfigPath $Port $DataDir $HttpServerClass `
                    $GcIntervalSeconds $GcLightweightIntervalSeconds $GcCacheDurationSeconds
                Set-ItemProperty -LiteralPath $regPath -Name 'ImagePath' -Value $newBin -ErrorAction Stop
                @{
                    ok = $true
                    service_name = $ServiceName
                    repaired = $true
                    existing_status = "$($existingSvc.Status)"
                    existing_path_name = $existingPathName
                    new_path_name = $newBin
                    existing_service_account = $existingStartName
                    message = ("patched ImagePath drift on existing service '{0}' ({1}); run " +
                               "'zen service stop' then 'start' to apply.") `
                              -f $ServiceName, ($argsDiff -join '; ')
                } | ConvertTo-Json -Compress -Depth 4
                exit 0
            } catch {
                @{
                    ok = $false
                    service_name = $ServiceName
                    message = "failed to patch ImagePath drift on '$ServiceName': $($_.Exception.Message)"
                } | ConvertTo-Json -Compress -Depth 4
                exit 0
            }
        }

        $reason = if (-not $userMatches) {
            "different service account (existing: '$existingStartName', requested: '$ServiceUser')"
        } elseif (-not $exeMatches) {
            'different ZenExePath'
        } elseif ($argsDiff.Count -gt 0) {
            "different ImagePath args ($($argsDiff -join '; '))"
        } else {
            'unknown drift'
        }
        @{
            ok = $false
            message = ("Service '{0}' is already installed (status: {1}) with {2}. " +
                       "Refusing to re-install without --full (Plan 7 §12 red line). " +
                       "Run zen-service-uninstall.ps1 first to change ConfigPath / zen.exe path / service account.") `
                      -f $ServiceName, $existingSvc.Status, $reason
            existing_service_account = $existingStartName
            service_name = $ServiceName
            existing_status = "$($existingSvc.Status)"
            existing_path_name = $existingPathName
        } | ConvertTo-Json -Compress -Depth 4
        exit 0
    }

    # --- Register service via sc.exe create -----------------------------------
    # Direct sc.exe create instead of `zen.exe service install`. Benefits:
    #   - No dependency on zen.exe for service management
    #   - Full control over service name (avoids the "ZenServer" default that
    #     collides with UE's ConditionalUpdateSystemServiceInstall)
    #   - Sets the correct ImagePath from the start (no post-install patch)
    #   - Sets the service account at creation time (no separate sc config)
    #   - Matches Epic's official "Zenserver as Shared DDC" deployment guide
    #
    # Resolve zenserver.exe from the zen.exe path (sibling binary).
    $zenserverExe = Normalize-ZenExe $ZenExePath
    if (-not (Test-Path -LiteralPath $zenserverExe -PathType Leaf)) {
        throw "zenserver.exe not found at $zenserverExe (expected sibling of $ZenExePath)"
    }

    # Build the ImagePath with ALL runtime settings as CLI flags — zen 5.8
    # does not read port / data-dir / http / GC from zen_config.lua (see
    # header). `--config=` stays as a redundant datadir carrier rendered
    # from the same DB row.
    $binpath = Build-ZenImagePath $zenserverExe $normalizedConfigPath $Port $DataDir $HttpServerClass `
        $GcIntervalSeconds $GcLightweightIntervalSeconds $GcCacheDurationSeconds

    # Determine the service account. Default to LocalService (same as zen.exe's
    # hardcoded default). Canonicalize built-in account names for sc.exe.
    $effectiveUser = 'NT AUTHORITY\LocalService'
    $isBuiltin = $true
    if (-not [string]::IsNullOrWhiteSpace($ServiceUser)) {
        $normalizedUser = Normalize-Account $ServiceUser
        $isBuiltin = @('localsystem', 'localservice', 'networkservice') -contains $normalizedUser
        $effectiveUser = switch ($normalizedUser) {
            'localsystem'     { 'LocalSystem' }
            'localservice'    { 'NT AUTHORITY\LocalService' }
            'networkservice'  { 'NT AUTHORITY\NetworkService' }
            default           { $ServiceUser }
        }
    }
    # gMSA accounts (trailing '$', e.g. "CONTOSO\zen-svc$") are AD-managed —
    # sc.exe never takes a password for one; the domain controller grants the
    # target computer's machine account permission to retrieve it directly.
    # Not independently verified against a real AD domain in this repo (no
    # domain environment available to test against); follows Microsoft's
    # published gMSA + Windows-service documentation.
    $isGmsa = $effectiveUser.TrimEnd().EndsWith('$')

    # Non-builtin accounts (dedicated local or domain, including gMSA) need
    # explicit grants `sc create obj=` alone doesn't provide: read access to
    # {ZenInstall} (this exe's directory) so the account can even launch the
    # binary, and read+write access to {ZenData} so it can use the cache.
    # `sc create obj=`/`password=` itself grants "log on as a service"
    # automatically as a side effect of the Win32 CreateService call, so that
    # right doesn't need a separate grant here.
    if (-not $isBuiltin) {
        $zenInstallDir = [System.IO.Path]::GetDirectoryName([System.IO.Path]::GetFullPath($zenserverExe))
        $icaclsInstallOutput = (icacls $zenInstallDir /grant "${effectiveUser}:(OI)(CI)RX" 2>&1 | Out-String)
        if ($LASTEXITCODE -ne 0) {
            @{
                ok = $false
                message = "icacls grant on ZenInstall dir failed (exit $LASTEXITCODE): $icaclsInstallOutput"
                service_name = $ServiceName
            } | ConvertTo-Json -Compress -Depth 4
            exit 0
        }
        if (-not [string]::IsNullOrWhiteSpace($DataDir)) {
            if (-not (Test-Path -LiteralPath $DataDir -PathType Container)) {
                New-Item -ItemType Directory -Path $DataDir -Force | Out-Null
            }
            $icaclsDataOutput = (icacls $DataDir /grant "${effectiveUser}:(OI)(CI)M" 2>&1 | Out-String)
            if ($LASTEXITCODE -ne 0) {
                @{
                    ok = $false
                    message = "icacls grant on DataDir failed (exit $LASTEXITCODE): $icaclsDataOutput"
                    service_name = $ServiceName
                } | ConvertTo-Json -Compress -Depth 4
                exit 0
            }
        }
    }

    # sc.exe create with account set at creation time (no separate config step).
    # PowerShell splatting (@scArgs) double-escapes $binpath's inner quotes →
    # sc.exe exit 1639. Route through cmd /c so cmd.exe sees the raw string
    # with backslash-escaped inner quotes, exactly as in the registry format.
    $scBinpath = '"' + $binpath.Replace('"', '\"') + '"'
    $scCmd = "sc create `"$ServiceName`" binpath= $scBinpath start= auto obj= `"$effectiveUser`""
    if (-not $isBuiltin -and -not $isGmsa) {
        $scCmd += " password= `"$ServicePassword`""
    }
    $scOutput = (cmd /c $scCmd 2>&1 | Out-String)
    $scExit = [int]$LASTEXITCODE

    if ($scExit -ne 0) {
        @{
            ok = $false
            message = "sc create failed (exit $scExit)"
            service_name = $ServiceName
            sc_exit_code = $scExit
            sc_output = $scOutput
        } | ConvertTo-Json -Compress -Depth 4
        exit 0
    }

    # Configure failure recovery: auto-restart after 60 seconds on crash.
    & sc.exe failure $ServiceName reset= 60 actions= restart/60000 2>&1 | Out-Null

    # Verify the account landed correctly.
    $actualStartName = Get-ServiceAccount $ServiceName
    $verifyAccount = if ($null -ne $actualStartName) { Normalize-Account $actualStartName } else { '' }
    $expectedNorm = if (-not [string]::IsNullOrWhiteSpace($ServiceUser)) { Normalize-Account $ServiceUser } else { 'localservice' }
    if ($verifyAccount -ne $expectedNorm) {
        # Rollback: remove the service so a retry doesn't hit the
        # existing-service drift refusal.
        & sc.exe delete $ServiceName 2>&1 | Out-Null
        @{
            ok = $false
            message = ("sc create succeeded but service account mismatch " +
                       "(expected '{0}', got '{1}'); service rolled back.") `
                      -f $effectiveUser, $actualStartName
            service_name = $ServiceName
            sc_exit_code = $scExit
            sc_output = $scOutput
            actual_service_account = $actualStartName
        } | ConvertTo-Json -Compress -Depth 4
        exit 0
    }

    $payload = @{
        ok = $true
        service_name = $ServiceName
        service_account = $actualStartName
        binpath = $binpath
        message = "service '$ServiceName' created successfully"
    }
    $payload | ConvertTo-Json -Compress -Depth 4
}
catch {
    @{ ok = $false; message = "$($_.Exception.Message)" } | ConvertTo-Json -Compress
    exit 0
}

# F4 sidecar - gracefully shut down an editor sponsor zenserver on a port.
#
# Parameters (stdin JSON):
#   -ZenExePath  <string>  zen.exe to run `down --port` with.
#   -Port        <int>     port the sponsor zenserver is squatting.
#   -ServiceName <string>  installed service name to compare against. Default "ZenServer".
#   -DryRun      <bool>    when true, report identity but do NOT shut down.
#
# Identity guard (Codex #2): refuse if the listener PID is the installed
# ZenServer service, or the listener is not a zenserver.exe.
#
# Output envelope: { ok, nothing_attached?, refused?, is_installed_service?,
#                    listener_pid?, listener_path?, would_stop?, message }

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
chcp 65001 | Out-Null
$ErrorActionPreference = 'Stop'

try {
    $p = [Console]::In.ReadToEnd() | ConvertFrom-Json
    if ([string]::IsNullOrWhiteSpace($p.ZenExePath)) { @{ ok=$false; message="ZenExePath is required" } | ConvertTo-Json -Compress; exit 0 }
    if ([string]::IsNullOrWhiteSpace($p.Port))       { @{ ok=$false; message="Port is required" } | ConvertTo-Json -Compress; exit 0 }
    $ZenExePath  = $p.ZenExePath
    $Port        = [int]$p.Port
    $ServiceName = if ($p.ServiceName) { $p.ServiceName } else { 'ZenServer' }
    $DryRun      = [bool]$p.DryRun

    # 1. Who is listening on the port?
    $conn = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
            Select-Object -First 1
    if ($null -eq $conn) {
        @{ ok=$true; nothing_attached=$true; message="no listener on port $Port" } | ConvertTo-Json -Compress
        exit 0
    }
    $listenerPid = [int]$conn.OwningProcess
    $listenerPath = $null
    try { $listenerPath = (Get-Process -Id $listenerPid -ErrorAction Stop).Path } catch { }

    # 2. Is that PID the installed ZenServer service? (only Running has a PID)
    $svcPid = $null
    try {
        $cim = Get-CimInstance -ClassName Win32_Service -Filter "Name='$ServiceName'" -ErrorAction Stop
        if ($null -ne $cim -and $cim.ProcessId -gt 0) { $svcPid = [int]$cim.ProcessId }
    } catch { }

    if ($null -ne $svcPid -and $svcPid -eq $listenerPid) {
        @{
            ok=$false; refused=$true; is_installed_service=$true
            listener_pid=$listenerPid; listener_path=$listenerPath
            message="port $Port is served by the installed '$ServiceName' service (pid $listenerPid), not an editor sponsor; use ``zen service stop``"
        } | ConvertTo-Json -Compress -Depth 4
        exit 0
    }

    # 3. Identity could not be confirmed (path unreadable / process gone) → fail-closed.
    if ($null -eq $listenerPath) {
        @{
            ok=$false; refused=$true; path_unresolved=$true; is_installed_service=$false
            listener_pid=$listenerPid
            message="cannot verify process on port $Port (pid $listenerPid): path unresolved; refusing to shut down an unidentified listener"
        } | ConvertTo-Json -Compress -Depth 4
        exit 0
    }

    # 4. Sanity: the listener should be a zenserver.exe.
    if ($listenerPath -notmatch 'zenserver\.exe$') {
        @{
            ok=$false; refused=$true; is_installed_service=$false
            listener_pid=$listenerPid; listener_path=$listenerPath
            message="port $Port is held by a non-zenserver process ($listenerPath, pid $listenerPid); refusing to shut down"
        } | ConvertTo-Json -Compress -Depth 4
        exit 0
    }

    # 5. dry-run: report identity, do not stop.
    if ($DryRun) {
        @{
            ok=$true; would_stop=$true; is_installed_service=$false
            listener_pid=$listenerPid; listener_path=$listenerPath
            message="[dry-run] would shut down sponsor zenserver pid $listenerPid on port $Port"
        } | ConvertTo-Json -Compress -Depth 4
        exit 0
    }

    # 6. shut it down.
    $out = (& $ZenExePath down --port $Port 2>&1 | Out-String)
    $code = [int]$LASTEXITCODE
    @{
        ok = ($code -eq 0)
        is_installed_service=$false
        listener_pid=$listenerPid; listener_path=$listenerPath
        zen_exit_code=$code
        message=$out.Trim()
    } | ConvertTo-Json -Compress -Depth 4
}
catch {
    @{ ok=$false; message="sponsor-down failed: $($_.Exception.Message)" } | ConvertTo-Json -Compress
    exit 0
}

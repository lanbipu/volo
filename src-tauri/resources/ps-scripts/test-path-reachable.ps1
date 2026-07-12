# Tests whether a filesystem path (typically a UNC share, e.g. \\host\share) is
# currently reachable from this machine -- backs the "路径失效" badge on the
# 共享 DDC 配置通道 panel (a channel value that WAS written but whose target
# share has since been torn down / renamed / gone offline). Node-pure (SSH -File).
#
# A bare Test-Path against a UNC path can hang far longer than the outer SSH
# ConnectTimeout would suggest -- that timeout only bounds the SSH handshake,
# not SMB/DNS retries once the remote script is already running. Wrapped in a
# background job with a hard timeout so one dead/powered-off share doesn't
# stall a whole "刷新状态" fan-out (which probes every distinct configured
# path across every machine) with no client-side way to cancel it.
#
# stdin: JSON { "Path": "\\\\host\\share" }
# Output: JSON { ok: true, reachable: bool, message: string }
#         { ok: false, message: "..." }  -- missing/invalid Path param only;
#                                            an unreachable path is NOT an error,
#                                            it's ok:true, reachable:false.
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
chcp 65001 | Out-Null
$ErrorActionPreference = 'Stop'

$TimeoutSeconds = 8

try {
    $p = [Console]::In.ReadLine() | ConvertFrom-Json
    $Path = if ($p.Path) { "$($p.Path)" } else { '' }
    if ([string]::IsNullOrWhiteSpace($Path)) { throw "Path is required" }

    $job = Start-Job -ScriptBlock { param($TargetPath) Test-Path -LiteralPath $TargetPath -ErrorAction Stop } -ArgumentList $Path
    try {
        if (Wait-Job -Job $job -Timeout $TimeoutSeconds) {
            $ok = Receive-Job -Job $job -ErrorAction Stop
            @{ ok = $true; reachable = [bool]$ok; message = "Test-Path returned $ok" } | ConvertTo-Json -Compress
        } else {
            @{ ok = $true; reachable = $false; message = "Test-Path timed out after ${TimeoutSeconds}s (host unreachable)" } | ConvertTo-Json -Compress
        }
    } catch {
        @{ ok = $true; reachable = $false; message = "$($_.Exception.Message)" } | ConvertTo-Json -Compress
    } finally {
        Stop-Job -Job $job -ErrorAction SilentlyContinue | Out-Null
        Remove-Job -Job $job -Force -ErrorAction SilentlyContinue | Out-Null
    }
}
catch {
    @{ ok = $false; message = "$($_.Exception.Message)" } | ConvertTo-Json -Compress
    exit 1
}

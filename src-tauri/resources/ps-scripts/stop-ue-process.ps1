# Force-stops a process by PID on the target.
#
# Node-pure: runs locally on the target (shipped + executed via SSH -File).
# stdin: JSON { "TargetPid": <int> }
# Output: JSON { ok, killed, message }
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; chcp 65001 | Out-Null
$ErrorActionPreference = 'Stop'

try {
    $p = [Console]::In.ReadLine() | ConvertFrom-Json
    $TargetPid = [int]$p.TargetPid
    try {
        Stop-Process -Id $TargetPid -Force -ErrorAction Stop
        @{ ok = $true; killed = $true; message = "stopped pid $TargetPid" } | ConvertTo-Json -Compress
    }
    catch {
        @{ ok = $true; killed = $false; message = "$($_.Exception.Message)" } | ConvertTo-Json -Compress
    }
}
catch {
    @{ ok = $false; killed = $false; message = "$($_.Exception.Message)" } | ConvertTo-Json -Compress
    exit 1
}

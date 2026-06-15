# Sets a system-level (Machine) environment variable on the target.
#
# Node-pure: runs locally on the target (shipped + executed via SSH -File).
# stdin: JSON { "Name": "...", "Value": "..." }
# Output: JSON { ok: bool, message: string }
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; chcp 65001 | Out-Null
# set + verify with explicit throw on mismatch -> Stop is appropriate here.
$ErrorActionPreference = 'Stop'

try {
    $p = [Console]::In.ReadToEnd() | ConvertFrom-Json
    [System.Environment]::SetEnvironmentVariable($p.Name, $p.Value, 'Machine')
    $readback = [System.Environment]::GetEnvironmentVariable($p.Name, 'Machine')
    if ($readback -ne $p.Value) { throw "verify failed: read '$readback', expected '$($p.Value)'" }
    @{ ok = $true; message = "set $($p.Name)" } | ConvertTo-Json -Compress
}
catch {
    @{ ok = $false; message = $_.Exception.Message } | ConvertTo-Json -Compress
    exit 1
}

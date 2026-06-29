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
    # Clearing a Machine var (Value="") deletes it, so readback comes back $null.
    # Normalize $null and "" to the same thing before comparing, otherwise
    # `$null -ne ""` is $true and the "leave / undeploy" path always fails verify.
    $expected = if ($null -eq $p.Value) { '' } else { "$($p.Value)" }
    $actual   = if ($null -eq $readback) { '' } else { "$readback" }
    if ($actual -ne $expected) { throw "verify failed: read '$actual', expected '$expected'" }
    @{ ok = $true; message = "set $($p.Name)" } | ConvertTo-Json -Compress
}
catch {
    @{ ok = $false; message = $_.Exception.Message } | ConvertTo-Json -Compress
    exit 1
}

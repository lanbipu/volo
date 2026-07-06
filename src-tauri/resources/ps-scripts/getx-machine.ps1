# Reads a system-level (Machine) environment variable on the target.
#
# Node-pure: runs locally on the target (shipped + executed via SSH -File).
# stdin: JSON { "Name": "..." }
# Output: JSON { ok: bool, value: string|null, message: string }
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; chcp 65001 | Out-Null
$ErrorActionPreference = 'Stop'

try {
    $p = [Console]::In.ReadLine() | ConvertFrom-Json
    $value = [System.Environment]::GetEnvironmentVariable($p.Name, 'Machine')
    if ($null -eq $value) {
        @{ ok = $true; value = $null; message = "not set" } | ConvertTo-Json -Compress
    } else {
        @{ ok = $true; value = "$value"; message = "" } | ConvertTo-Json -Compress
    }
}
catch {
    @{ ok = $false; value = $null; message = $_.Exception.Message } | ConvertTo-Json -Compress
    exit 1
}

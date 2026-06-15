# Creates the local DDC directory with permissive ACLs so both the operator
# account and SYSTEM (RenderStream Service) can read/write.
#
# Node-pure: runs locally on the target (shipped + executed via SSH -File).
# stdin: JSON { "LocalPath": "...", "ServiceAccount": "..."|null }
# Output: JSON { ok, message, path }
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; chcp 65001 | Out-Null
# Create-must-succeed: New-Item/Get-Item should fail-hard -> ok:false (icacls is a
# native exe and won't throw regardless), so Stop is appropriate here.
$ErrorActionPreference = 'Stop'

try {
    $p = [Console]::In.ReadToEnd() | ConvertFrom-Json
    $LocalPath = $p.LocalPath
    $ServiceAccount = $p.ServiceAccount

    if (-not (Test-Path -LiteralPath $LocalPath)) {
        New-Item -ItemType Directory -Path $LocalPath -Force | Out-Null
    }
    # SYSTEM full control (RenderStream / Windows service contexts)
    icacls $LocalPath /grant 'SYSTEM:(OI)(CI)F' /T /C | Out-Null
    icacls $LocalPath /grant 'Administrators:(OI)(CI)F' /T /C | Out-Null
    if ($ServiceAccount) {
        icacls $LocalPath /grant "${ServiceAccount}:(OI)(CI)F" /T /C | Out-Null
    }
    $info = Get-Item -LiteralPath $LocalPath
    @{ ok = $true; message = "created $($info.FullName)"; path = $info.FullName } | ConvertTo-Json -Compress
}
catch {
    @{ ok = $false; message = $_.Exception.Message } | ConvertTo-Json -Compress
    exit 1
}

# Probe whether a named SMB share exists on this host (node-pure over SSH).
# stdin: JSON { "ShareName": "volo-dir-d-projects" }
# Output: JSON { ok, exists, path, message }
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; chcp 65001 | Out-Null
$ErrorActionPreference = 'Stop'

try {
    $p = [Console]::In.ReadToEnd() | ConvertFrom-Json
    $name = $p.ShareName
    if ([string]::IsNullOrWhiteSpace($name)) { throw 'ShareName is required' }
    $share = Get-SmbShare -Name $name -ErrorAction SilentlyContinue | Select-Object -First 1
    $exists = $null -ne $share
    $path = if ($exists) { $share.Path } else { '' }
    $message = if ($exists) { "share exists: $path" } else { "share not found: $name" }
    @{ ok = $true; exists = $exists; path = "$path"; message = $message } | ConvertTo-Json -Compress
}
catch {
    @{ ok = $false; exists = $false; path = ''; message = "$($_.Exception.Message)" } | ConvertTo-Json -Compress
    exit 1
}

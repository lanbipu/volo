# Return the node's NetBIOS / computer name for cross-machine SMB auth (HOST\user).
#
# Node-pure: runs locally on the target (shipped + executed via SSH -File).
# stdin: ignored (empty JSON object is fine)
# Output: JSON { ok, name }
[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; chcp 65001 | Out-Null
$ErrorActionPreference = 'Stop'

try {
    $null = [Console]::In.ReadToEnd()
    @{ ok = $true; name = "$($env:COMPUTERNAME)" } | ConvertTo-Json -Compress
}
catch {
    @{ ok = $false; name = ""; message = "$($_.Exception.Message)" } | ConvertTo-Json -Compress
    exit 1
}

# Reads an entire INI file and returns its sections + keys with line numbers.
#
# Node-pure: runs locally on the target (shipped + executed via SSH -File).
# stdin: JSON { "FilePath": "<path>" }
# Output: JSON { ok, found, sections: [{ name, keys: [{ name, value, line_number }] }], message }
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; chcp 65001 | Out-Null
$ErrorActionPreference = 'Continue'

try {
    $p = [Console]::In.ReadToEnd() | ConvertFrom-Json
    $FilePath = $p.FilePath

    if (-not (Test-Path $FilePath)) {
        @{ ok = $true; found = $false; sections = @(); message = "" } | ConvertTo-Json -Compress -Depth 6
        return
    }
    # -ErrorAction Stop so an existing-but-unreadable file (ACL/lock) becomes ok:false
    # (the catch), not a silent found=true with empty sections.
    $lines = Get-Content -LiteralPath $FilePath -Encoding UTF8 -ErrorAction Stop
    $sections = New-Object System.Collections.ArrayList
    $current = $null
    $lineNo = 0
    foreach ($line in $lines) {
        $lineNo++
        $trim = $line.Trim()
        if ($trim.StartsWith('[') -and $trim.EndsWith(']') -and $trim.Length -gt 2) {
            if ($current -ne $null) { [void]$sections.Add($current) }
            $current = @{
                name = $trim.Substring(1, $trim.Length - 2)
                keys = New-Object System.Collections.ArrayList
            }
            continue
        }
        if ($current -eq $null) { continue }
        if ([string]::IsNullOrEmpty($trim)) { continue }
        if ($trim.StartsWith(';') -or $trim.StartsWith('#') -or $trim.StartsWith('//')) { continue }
        $eq = $trim.IndexOf('=')
        if ($eq -gt 0) {
            $name = $trim.Substring(0, $eq).Trim()
            $value = $trim.Substring($eq + 1).Trim()
            [void]$current.keys.Add([PSCustomObject]@{
                name        = $name
                value       = $value
                line_number = $lineNo
            })
        }
    }
    if ($current -ne $null) { [void]$sections.Add($current) }

    @{ ok = $true; found = $true; sections = @($sections); message = "" } | ConvertTo-Json -Compress -Depth 6
}
catch {
    @{ ok = $false; found = $false; sections = @(); message = $_.Exception.Message } | ConvertTo-Json -Compress
    exit 1
}

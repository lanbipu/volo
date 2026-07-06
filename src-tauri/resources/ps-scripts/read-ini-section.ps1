# Reads a single [section] from an INI file. Node-pure (shipped + executed via SSH -File).
# stdin: JSON { "FilePath": "...", "Section": "..." }
# Output: JSON { ok: bool, keys: [{ name, value }], message: string }
[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; chcp 65001 | Out-Null
$ErrorActionPreference = 'Stop'

try {
    $p = [Console]::In.ReadLine() | ConvertFrom-Json
    $FilePath = $p.FilePath
    $Section = $p.Section

    if (-not (Test-Path $FilePath)) { throw "file not found: $FilePath" }
    $lines = Get-Content -Path $FilePath -Encoding UTF8
    $inSection = $false
    $sectionPattern = "[$Section]"
    $result = @()
    foreach ($line in $lines) {
        $trim = $line.Trim()
        if ($trim -eq $sectionPattern) { $inSection = $true; continue }
        if ($inSection -and $trim.StartsWith('[') -and $trim.EndsWith(']')) { break }
        if ($inSection -and $trim -and -not $trim.StartsWith(';') -and -not $trim.StartsWith('#')) {
            $eq = $trim.IndexOf('=')
            if ($eq -gt 0) {
                $name = $trim.Substring(0, $eq).Trim()
                $value = $trim.Substring($eq + 1).Trim()
                $result += [PSCustomObject]@{ name = $name; value = $value }
            }
        }
    }
    @{ ok = $true; keys = @($result); message = "" } | ConvertTo-Json -Compress -Depth 4
}
catch {
    @{ ok = $false; keys = @(); message = $_.Exception.Message } | ConvertTo-Json -Compress
    exit 1
}

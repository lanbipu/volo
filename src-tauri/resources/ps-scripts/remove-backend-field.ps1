# Removes a field from a struct-style INI backend node, e.g. NodeName=(Key=Val,...).
# Inverse of set-backend-field.ps1; rolls back the join's Shared.Path / Shared.EnvPathOverride.
# Idempotent: a missing file / section / node / field is ok=true (nothing to remove).
# stdin: JSON { "FilePath","SectionName","NodeName","FieldName" }
# Output: JSON { ok, message }
[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; chcp 65001 | Out-Null
$ErrorActionPreference = 'Stop'
try {
    $p = [Console]::In.ReadToEnd() | ConvertFrom-Json
    $FilePath = $p.FilePath; $SectionName = $p.SectionName; $NodeName = $p.NodeName; $FieldName = $p.FieldName
    if (-not (Test-Path -LiteralPath $FilePath)) {
        @{ ok = $true; message = "file absent: $FilePath" } | ConvertTo-Json -Compress
        exit 0
    }
    $lines = Get-Content -LiteralPath $FilePath
    $inSection = $false
    $changed = $false
    $out = New-Object System.Collections.Generic.List[string]
    foreach ($line in $lines) {
        $trim = $line.Trim()
        if ($trim.StartsWith('[') -and $trim.EndsWith(']')) {
            $inSection = ($trim.Trim('[',']') -ieq $SectionName)
            $out.Add($line); continue
        }
        if ($inSection -and -not $changed) {
            $eq = $line.IndexOf('=')
            if ($eq -gt 0) {
                $name = $line.Substring(0, $eq).Trim()
                $rest = $line.Substring($eq + 1).TrimStart()
                # LastIndexOf(')') (not EndsWith) so a line with trailing whitespace
                # or an inline comment still matches — mirrors the Rust loopback
                # parse_node (rfind(')')); else remote leave silently rolls back nothing.
                $close = $rest.LastIndexOf(')')
                if (($name -ieq $NodeName) -and $rest.StartsWith('(') -and $close -gt 0) {
                    $body = $rest.Substring(1, $close - 1)
                    $orderedKeys = New-Object System.Collections.Generic.List[string]
                    $fields = @{}
                    foreach ($pair in $body -split ',') {
                        $q = $pair.Trim()
                        if (-not $q) { continue }
                        $peq = $q.IndexOf('=')
                        if ($peq -lt 0) { continue }
                        $k = $q.Substring(0, $peq).Trim()
                        $v = $q.Substring($peq + 1).Trim()
                        if (-not $fields.ContainsKey($k)) { $orderedKeys.Add($k) }
                        $fields[$k] = $v
                    }
                    if (($orderedKeys | Where-Object { $_ -ieq $FieldName } | Select-Object -First 1)) {
                        $kept = @($orderedKeys | Where-Object { $_ -ine $FieldName })
                        $parts = foreach ($k in $kept) { "$k=$($fields[$k])" }
                        $out.Add("$NodeName=($([string]::Join(', ', $parts)))")
                        $changed = $true
                        continue
                    }
                }
            }
        }
        $out.Add($line)
    }
    if ($changed) {
        Set-Content -LiteralPath $FilePath -Value $out -Encoding UTF8
        @{ ok = $true; message = "removed $NodeName.$FieldName" } | ConvertTo-Json -Compress
    } else {
        @{ ok = $true; message = "$NodeName.$FieldName not present" } | ConvertTo-Json -Compress
    }
}
catch {
    @{ ok = $false; message = $_.Exception.Message } | ConvertTo-Json -Compress
    exit 1
}

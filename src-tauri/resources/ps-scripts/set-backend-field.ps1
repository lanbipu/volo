# Sets a field inside a struct-style INI backend node, e.g. NodeName=(Key=Val,...). Node-pure (SSH -File).
# stdin: JSON { "FilePath","SectionName","NodeName","FieldName","FieldValue" }
# Output: JSON { ok, message }
[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; chcp 65001 | Out-Null
$ErrorActionPreference = 'Stop'
try {
    $p = [Console]::In.ReadToEnd() | ConvertFrom-Json
    $FilePath = $p.FilePath; $SectionName = $p.SectionName; $NodeName = $p.NodeName
    $FieldName = $p.FieldName; $FieldValue = $p.FieldValue
    if (-not (Test-Path -LiteralPath $FilePath)) { throw "file not found: $FilePath" }
    $lines = Get-Content -LiteralPath $FilePath
    $inSection = $false
    $handled = $false
    $out = New-Object System.Collections.Generic.List[string]
    foreach ($line in $lines) {
        $trim = $line.Trim()
        if ($trim.StartsWith('[') -and $trim.EndsWith(']')) {
            $inSection = ($trim.Trim('[',']') -ieq $SectionName)
            $out.Add($line); continue
        }
        if ($inSection -and -not $handled) {
            $eq = $line.IndexOf('=')
            if ($eq -gt 0) {
                $name = $line.Substring(0, $eq).Trim()
                $rest = $line.Substring($eq + 1).TrimStart()
                if (($name -ieq $NodeName) -and $rest.StartsWith('(') -and $rest.EndsWith(')')) {
                    $body = $rest.Substring(1, $rest.Length - 2)
                    $orderedKeys = New-Object System.Collections.Generic.List[string]
                    $fields = @{}
                    foreach ($pair in $body -split ',') {
                        $p = $pair.Trim()
                        if (-not $p) { continue }
                        $peq = $p.IndexOf('=')
                        if ($peq -lt 0) { continue }
                        $k = $p.Substring(0, $peq).Trim()
                        $v = $p.Substring($peq + 1).Trim()
                        if (-not $fields.ContainsKey($k)) { $orderedKeys.Add($k) }
                        $fields[$k] = $v
                    }
                    if ($fields.ContainsKey($FieldName)) {
                        $fields[$FieldName] = $FieldValue
                    } else {
                        $orderedKeys.Add($FieldName)
                        $fields[$FieldName] = $FieldValue
                    }
                    $parts = foreach ($k in $orderedKeys) { "$k=$($fields[$k])" }
                    $out.Add("$NodeName=($([string]::Join(', ', $parts)))")
                    $handled = $true
                    continue
                }
            }
        }
        $out.Add($line)
    }
    if (-not $handled) { throw "section [$SectionName] node $NodeName not found" }
    Set-Content -LiteralPath $FilePath -Value $out -Encoding UTF8
    @{ ok = $true; message = "set $NodeName.$FieldName=$FieldValue" } | ConvertTo-Json -Compress
}
catch {
    @{ ok = $false; message = $_.Exception.Message } | ConvertTo-Json -Compress
    exit 1
}

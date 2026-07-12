# Sets a field inside a struct-style INI backend node, e.g. NodeName=(Key=Val,...). Node-pure (SSH -File).
# Creates the node / section / file when any of them don't exist yet (a project's
# DefaultEngine.ini commonly has no [DerivedDataBackendGraph] override at all until
# the first join/edit) -- mirrors write-ini-key.ps1's CreateIfMissing behavior for
# the sibling ini-key channel, so the shared-DDC config panel's "设置" button works
# on a project that has never had this node before.
# stdin: JSON { "FilePath","SectionName","NodeName","FieldName","FieldValue" }
# Output: JSON { ok, message }
[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; chcp 65001 | Out-Null
$ErrorActionPreference = 'Stop'
try {
    $p = [Console]::In.ReadLine() | ConvertFrom-Json
    $FilePath = $p.FilePath; $SectionName = $p.SectionName; $NodeName = $p.NodeName
    $FieldName = $p.FieldName; $FieldValue = $p.FieldValue
    $freshNodeLine = "$NodeName=($FieldName=$FieldValue)"

    if (-not (Test-Path -LiteralPath $FilePath)) {
        $parent = Split-Path -Path $FilePath -Parent
        if ($parent -and -not (Test-Path -LiteralPath $parent)) {
            New-Item -ItemType Directory -Path $parent -Force | Out-Null
        }
        Set-Content -LiteralPath $FilePath -Value @("[$SectionName]", $freshNodeLine) -Encoding UTF8
        @{ ok = $true; message = "created $FilePath with $NodeName.$FieldName=$FieldValue" } | ConvertTo-Json -Compress
        exit 0
    }

    $lines = Get-Content -LiteralPath $FilePath
    $inSection = $false
    $sectionSeen = $false
    $handled = $false
    $out = New-Object System.Collections.Generic.List[string]
    foreach ($line in $lines) {
        $trim = $line.Trim()
        if ($trim.StartsWith('[') -and $trim.EndsWith(']')) {
            # Leaving our target section without having found the node -- append
            # it as the section's last line before the next section header.
            if ($inSection -and -not $handled) {
                $out.Add($freshNodeLine)
                $handled = $true
            }
            $inSection = ($trim.Trim('[',']') -ieq $SectionName)
            if ($inSection) { $sectionSeen = $true }
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
    # Our target section was the last one in the file (loop ended still inside it).
    if ($inSection -and -not $handled) {
        $out.Add($freshNodeLine)
        $handled = $true
    }
    # Section never appeared at all -- append a fresh [SectionName] + node block.
    if (-not $handled) {
        if ($out.Count -gt 0 -and $out[$out.Count - 1].Trim() -ne '') { $out.Add('') }
        $out.Add("[$SectionName]")
        $out.Add($freshNodeLine)
    }
    Set-Content -LiteralPath $FilePath -Value $out -Encoding UTF8
    @{ ok = $true; message = "set $NodeName.$FieldName=$FieldValue" } | ConvertTo-Json -Compress
}
catch {
    @{ ok = $false; message = $_.Exception.Message } | ConvertTo-Json -Compress
    exit 1
}

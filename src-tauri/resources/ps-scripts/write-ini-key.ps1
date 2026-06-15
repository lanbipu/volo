# Sets or removes a key in an INI [section] (with .bak backup). Node-pure (SSH -File).
# stdin: JSON { "FilePath","Section","Name","Value","Remove" }
# Output: JSON { ok, backup_path, message }
[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; chcp 65001 | Out-Null
$ErrorActionPreference = 'Stop'
try {
    $p = [Console]::In.ReadToEnd() | ConvertFrom-Json
    $FilePath = $p.FilePath; $Section = $p.Section; $Name = $p.Name
    $Value = if ($null -ne $p.Value) { "$($p.Value)" } else { "" }
    $Remove = [bool]$p.Remove
    $CreateIfMissing = if ($null -ne $p.CreateIfMissing) { [bool]$p.CreateIfMissing } else { $false }
    if (-not (Test-Path $FilePath)) {
        if ($CreateIfMissing -and (-not $Remove)) {
            $dir = Split-Path -Parent $FilePath
            if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
            New-Item -ItemType File -Path $FilePath -Force | Out-Null
        } elseif ($Remove) {
            # Nothing to remove — file absent is success for a remove op.
            @{ ok = $true; backup_path = ""; message = "file absent, nothing to remove" } | ConvertTo-Json -Compress
            exit 0
        } else {
            throw "file not found: $FilePath"
        }
    }
        $backup = "$FilePath.bak.$(Get-Date -UFormat '%Y%m%d-%H%M%S')"
        Copy-Item -Path $FilePath -Destination $backup -Force
        $lines = Get-Content -Path $FilePath -Encoding UTF8
        $out = New-Object System.Collections.ArrayList
        $inSection = $false
        $sectionSeen = $false
        $written = $false
        $bracket = "[$Section]"
        foreach ($line in $lines) {
            $trim = $line.Trim()
            if ($trim -eq $bracket) { $inSection = $true; $sectionSeen = $true; [void]$out.Add($line); continue }
            if ($inSection -and $trim.StartsWith('[') -and $trim.EndsWith(']')) {
                if (-not $Remove -and -not $written) {
                    [void]$out.Add("$Name=$Value"); $written = $true
                }
                $inSection = $false
                [void]$out.Add($line)
                continue
            }
            if ($inSection -and $trim -match "^\s*$([regex]::Escape($Name))\s*=") {
                if ($Remove) { continue }
                [void]$out.Add("$Name=$Value"); $written = $true; continue
            }
            [void]$out.Add($line)
        }
        if (-not $Remove -and -not $written -and $inSection) {
            [void]$out.Add("$Name=$Value")
            $written = $true
        }
        # Section never appeared: append it (with the key) so callers can
        # create new sections instead of silently writing the file unchanged.
        # The pre-Plan-4 behavior of write-ini-key.ps1 had this fallback;
        # restore it. Skip in -RemoveKey mode (nothing to remove).
        if (-not $Remove -and -not $sectionSeen) {
            if ($out.Count -gt 0) {
                $last = [string]$out[$out.Count - 1]
                if ($last.Trim().Length -ne 0) { [void]$out.Add("") }
            }
            [void]$out.Add($bracket)
            [void]$out.Add("$Name=$Value")
            $written = $true
        }
        Set-Content -Path $FilePath -Value $out -Encoding UTF8
    @{ ok = $true; backup_path = "$backup"; message = "wrote $Name in [$Section]" } | ConvertTo-Json -Compress
}
catch {
    @{ ok = $false; backup_path = ""; message = $_.Exception.Message } | ConvertTo-Json -Compress
    exit 1
}

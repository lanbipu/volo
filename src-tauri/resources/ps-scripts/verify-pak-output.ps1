# Verifies the generated DDC pak (.ddp) exists and is non-empty.
#
# Node-pure: runs locally on the target (shipped + executed via SSH -File).
# stdin: JSON { "ProjectDir": "..." }
# Output: JSON { ok, found, path, size, last_write }
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; chcp 65001 | Out-Null
$ErrorActionPreference = 'Continue'

try {
    $p = [Console]::In.ReadToEnd() | ConvertFrom-Json
    $ProjectDir = $p.ProjectDir

    $found = $false; $path = ""; $size = "0"; $lastWrite = $null
    $cand = Join-Path -Path $ProjectDir -ChildPath "DerivedDataCache\DDC.ddp"
    if (Test-Path -LiteralPath $cand) {
        $item = Get-Item -LiteralPath $cand
        if ($item.Length -gt 0) {
            $found = $true; $path = "$cand"; $size = "$($item.Length)"
            $lastWrite = "$($item.LastWriteTimeUtc.ToString('o'))"
        }
    }
    @{ ok = $true; found = $found; path = $path; size = $size; last_write = $lastWrite } | ConvertTo-Json -Compress
}
catch {
    @{ ok = $false; message = "$($_.Exception.Message)" } | ConvertTo-Json -Compress
    exit 1
}

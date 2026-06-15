# Verifies the generated DDC pak (.ddp) exists and is non-empty.
#
# Node-pure: runs locally on the target (shipped + executed via SSH -File).
# stdin: JSON { "ProjectDir": "..." }
# Output: JSON { ok, found, path, size }
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; chcp 65001 | Out-Null
$ErrorActionPreference = 'Continue'

try {
    $p = [Console]::In.ReadToEnd() | ConvertFrom-Json
    $ProjectDir = $p.ProjectDir

    $found = $false; $path = ""; $size = "0"
    foreach ($name in @('Compressed.ddp', 'DDC.ddp')) {
        $cand = Join-Path -Path $ProjectDir -ChildPath "DerivedDataCache\$name"
        if (Test-Path -LiteralPath $cand) {
            $sz = (Get-Item -LiteralPath $cand).Length
            if ($sz -gt 0) { $found = $true; $path = "$cand"; $size = "$sz"; break }
        }
    }
    @{ ok = $true; found = $found; path = $path; size = $size } | ConvertTo-Json -Compress
}
catch {
    @{ ok = $false; message = "$($_.Exception.Message)" } | ConvertTo-Json -Compress
    exit 1
}

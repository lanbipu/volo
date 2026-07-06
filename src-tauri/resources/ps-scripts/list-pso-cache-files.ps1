# List PSO cache files under a project's Saved\CollectedPSOs dir.
#
# Node-pure: runs locally on the target (shipped + executed via SSH -File).
# stdin: JSON { "ProjectDir" }
# Output: JSON { ok, items: [{ file_path, file_name, size, last_write }], count, [message] }
[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; chcp 65001 | Out-Null
$ErrorActionPreference = 'Stop'

try {
    $p = [Console]::In.ReadLine() | ConvertFrom-Json
    $ProjectDir = $p.ProjectDir
    if ([string]::IsNullOrWhiteSpace($ProjectDir)) { throw "ProjectDir is required" }

    $dir = Join-Path -Path $ProjectDir -ChildPath 'Saved\CollectedPSOs'
    # ArrayList (not Generic.List) so ConvertTo-Json serialises cleanly on PS5.1.
    $out = New-Object System.Collections.ArrayList
    if (Test-Path -LiteralPath $dir) {
        $files = Get-ChildItem -LiteralPath $dir -File -ErrorAction SilentlyContinue | Where-Object {
            $_.Extension -eq '.upipelinecache' -or $_.Name -like '*.stablepc.csv'
        }
        foreach ($f in $files) {
            [void]$out.Add(@{
                file_path  = "$($f.FullName)"
                file_name  = "$($f.Name)"
                size       = "$($f.Length)"
                last_write = "$($f.LastWriteTimeUtc.ToString('o'))"
            })
        }
    }
    @{ ok = $true; items = @($out); count = $out.Count } | ConvertTo-Json -Depth 6 -Compress
}
catch {
    @{ ok = $false; items = @(); count = 0; message = "$($_.Exception.Message)" } | ConvertTo-Json -Compress
    exit 1
}

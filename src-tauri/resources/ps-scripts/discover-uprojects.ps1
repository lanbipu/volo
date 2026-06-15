# Discovers .uproject files under the given search roots.
#
# Node-pure: runs locally on the target (shipped + executed via SSH -File).
# stdin: JSON { "Roots": ["C:\\Projects", ...], "MaxDepth": 6 }
# Output: JSON { ok, items: [{uproject_filename, uproject_path, abs_path, engine_association}], count }
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; chcp 65001 | Out-Null
$ErrorActionPreference = 'Continue'

try {
    $p = [Console]::In.ReadToEnd() | ConvertFrom-Json
    $Roots = $p.Roots
    $MaxDepth = if ($null -ne $p.MaxDepth) { [int]$p.MaxDepth } else { 6 }

    $found = @()
    foreach ($root in $Roots) {
        if (-not (Test-Path -LiteralPath $root)) { continue }
        try {
            $uprojects = Get-ChildItem -LiteralPath $root -Filter '*.uproject' -Recurse -Depth $MaxDepth -File -ErrorAction SilentlyContinue
            foreach ($u in $uprojects) {
                # FileInfo.DirectoryName: avoids `Split-Path -LiteralPath -Parent`
                # which is an invalid parameter-set combo on Windows PowerShell 5.1.
                $abs = $u.DirectoryName
                $engineAssociation = $null
                try {
                    $json = Get-Content -LiteralPath $u.FullName -Raw -ErrorAction SilentlyContinue | ConvertFrom-Json -ErrorAction SilentlyContinue
                    if ($json -and $json.EngineAssociation) { $engineAssociation = "$($json.EngineAssociation)" }
                } catch {}
                $found += @{
                    uproject_filename  = "$($u.Name)"
                    uproject_path      = "$($u.FullName)"
                    abs_path           = "$abs"
                    engine_association = $engineAssociation
                }
            }
        } catch {}
    }

    $list = @($found)
    @{ ok = $true; items = $list; count = $list.Count } | ConvertTo-Json -Depth 6 -Compress
}
catch {
    @{ ok = $false; items = @(); count = 0; message = "$($_.Exception.Message)" } | ConvertTo-Json -Depth 6 -Compress
    exit 1
}

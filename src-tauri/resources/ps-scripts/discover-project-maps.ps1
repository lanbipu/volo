# Discovers UE maps (*.umap) under a project Content/ tree and returns Unreal
# package paths for PSO traversal map_path (e.g. /Game/InCamVFXBP/Maps/LED_CurvedStage).
#
# Conversion must stay in sync with Rust content_umap_to_game_path
# (crates/cache-core/src/core/pso_warmup.rs).
#
# Node-pure: runs locally on the target (shipped + executed via SSH -File).
# stdin: JSON { "ProjectRoot": "E:\\projects\\foo" }
# Output: JSON { ok, paths: string[], message? }
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; chcp 65001 | Out-Null
$ErrorActionPreference = 'Continue'

function Convert-UmapToGamePath([string]$projectRoot, [string]$umapFull) {
    $full = $umapFull -replace '/', '\'
    $root = $projectRoot.TrimEnd('\', '/') -replace '/', '\'
    if ($full.Length -lt ($root.Length + 1)) { return $null }
    if (-not $full.StartsWith($root, [StringComparison]::OrdinalIgnoreCase)) { return $null }
    $marker = '\Content\'
    $idx = $full.IndexOf($marker, [StringComparison]::OrdinalIgnoreCase)
    if ($idx -lt 0) { return $null }
    $after = $full.Substring($idx + $marker.Length)
    if (-not $after.EndsWith('.umap', [StringComparison]::OrdinalIgnoreCase)) { return $null }
    $rel = $after.Substring(0, $after.Length - 5)
    if ([string]::IsNullOrWhiteSpace($rel)) { return $null }
    return '/Game/' + ($rel -replace '\\', '/')
}

try {
    $p = [Console]::In.ReadLine() | ConvertFrom-Json
    $root = $p.ProjectRoot
    if ([string]::IsNullOrWhiteSpace($root) -or -not (Test-Path -LiteralPath $root)) {
        @{ ok = $false; paths = @(); message = "ProjectRoot missing or not found: $root" } | ConvertTo-Json -Compress
        exit 1
    }

    $content = Join-Path $root 'Content'
    $out = New-Object System.Collections.Generic.List[string]
    if (Test-Path -LiteralPath $content) {
        Get-ChildItem -LiteralPath $content -Recurse -Filter '*.umap' -File -ErrorAction SilentlyContinue |
            ForEach-Object {
                $game = Convert-UmapToGamePath $root $_.FullName
                if ($null -ne $game) { [void]$out.Add($game) }
            }
    }

    $paths = @($out | Sort-Object -Unique)
    @{ ok = $true; paths = $paths } | ConvertTo-Json -Compress -Depth 4
}
catch {
    @{ ok = $false; paths = @(); message = "$($_.Exception.Message)" } | ConvertTo-Json -Compress
    exit 1
}

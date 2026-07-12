# Discovers nDisplay configs under a UE project root for PSO prerun settings.
#
# 1) Existing *.ndisplay files (skips heavy UE dirs: Saved / Intermediate / DDC / Binaries)
# 2) Content/**/nDisplay_*.uasset — extracts embedded ConfigExport JSON and materializes
#    {ProjectRoot}\Saved\Volo\ndisplay\{name}.ndisplay (UE -dc_cfg only accepts .ndisplay JSON)
#
# Algorithm must stay in sync with Rust extract_ndisplay_json_from_uasset_bytes
# (crates/cache-core/src/core/pso_warmup.rs): marker {"nDisplay": → brace depth → require "version".
#
# Node-pure: runs locally on the target (shipped + executed via SSH -File).
# stdin: JSON { "ProjectRoot": "E:\\projects\\foo" }
# Output: JSON { ok, paths: string[], message? }
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; chcp 65001 | Out-Null
$ErrorActionPreference = 'Continue'

function Extract-NDisplayJson([byte[]]$bytes) {
    $ascii = [Text.Encoding]::ASCII.GetString($bytes)
    $marker = '{"nDisplay":'
    $start = $ascii.IndexOf($marker)
    if ($start -lt 0) { return $null }
    $depth = 0
    $end = -1
    for ($i = $start; $i -lt $ascii.Length; $i++) {
        $ch = $ascii[$i]
        if ($ch -eq '{') { $depth++ }
        elseif ($ch -eq '}') {
            $depth--
            if ($depth -eq 0) { $end = $i; break }
        }
    }
    if ($end -lt 0) { return $null }
    $json = $ascii.Substring($start, $end - $start + 1)
    if ($json -notmatch '"version"') { return $null }
    return $json
}

try {
    $p = [Console]::In.ReadLine() | ConvertFrom-Json
    $root = $p.ProjectRoot
    if ([string]::IsNullOrWhiteSpace($root) -or -not (Test-Path -LiteralPath $root)) {
        @{ ok = $false; paths = @(); message = "ProjectRoot missing or not found: $root" } | ConvertTo-Json -Compress
        exit 1
    }

    $skipDirs = @{
        Saved = $true
        Intermediate = $true
        DerivedDataCache = $true
        Binaries = $true
        '.git' = $true
    }

    $out = New-Object System.Collections.Generic.List[string]

    # Existing .ndisplay — walk with directory pruning (avoid Saved/DDC/etc.)
    $stack = New-Object System.Collections.Generic.Stack[string]
    $stack.Push($root)
    while ($stack.Count -gt 0) {
        $dir = $stack.Pop()
        Get-ChildItem -LiteralPath $dir -File -Filter '*.ndisplay' -ErrorAction SilentlyContinue |
            ForEach-Object { [void]$out.Add($_.FullName) }
        Get-ChildItem -LiteralPath $dir -Directory -ErrorAction SilentlyContinue | ForEach-Object {
            if (-not $skipDirs.ContainsKey($_.Name)) { $stack.Push($_.FullName) }
        }
    }

    $content = Join-Path $root 'Content'
    if (Test-Path -LiteralPath $content) {
        $exportDir = Join-Path $root 'Saved\Volo\ndisplay'
        New-Item -ItemType Directory -Force -Path $exportDir | Out-Null
        Get-ChildItem -LiteralPath $content -Recurse -Filter 'nDisplay_*.uasset' -File -ErrorAction SilentlyContinue |
            ForEach-Object {
                try {
                    $json = Extract-NDisplayJson ([IO.File]::ReadAllBytes($_.FullName))
                    if ($null -eq $json) { return }
                    $dest = Join-Path $exportDir ($_.BaseName + '.ndisplay')
                    $write = $true
                    if (Test-Path -LiteralPath $dest) {
                        $existing = Get-Content -LiteralPath $dest -Raw -ErrorAction SilentlyContinue
                        if ($existing -eq $json) { $write = $false }
                    }
                    if ($write) {
                        [IO.File]::WriteAllText($dest, $json, (New-Object Text.UTF8Encoding $false))
                    }
                    [void]$out.Add($dest)
                } catch {}
            }
    }

    $paths = @($out | Sort-Object -Unique)
    @{ ok = $true; paths = $paths } | ConvertTo-Json -Compress -Depth 4
}
catch {
    @{ ok = $false; paths = @(); message = "$($_.Exception.Message)" } | ConvertTo-Json -Compress
    exit 1
}

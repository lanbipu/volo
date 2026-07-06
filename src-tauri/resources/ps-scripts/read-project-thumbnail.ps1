# Resolves a UE project's thumbnail: same-name PNG next to the .uproject,
# falling back to Saved\AutoScreenshot.png, then Saved\autosequence_shot.png.
# Returns the file base64-encoded so the operator's Volo instance can render
# it without a mounted share. Also measures the project directory's total
# size (size_bytes) in the same SSH round-trip.
#
# Node-pure: runs locally on the target (shipped + executed via SSH -File).
# stdin: JSON { "ProjectDir": "...", "UprojectStem": "Aurora" }
# Output: JSON { ok, found, path, base64, from, mtime, size_bytes, message }
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; chcp 65001 | Out-Null
$ErrorActionPreference = 'Continue'

# Skip (not error) an oversized candidate — a thumbnail this large is almost
# certainly not a thumbnail, and base64-inflating it over the SSH stdout pipe
# would be wasteful.
$MaxBytes = 8MB

try {
    $p = [Console]::In.ReadLine() | ConvertFrom-Json
    $ProjectDir = $p.ProjectDir
    $UprojectStem = $p.UprojectStem

    $candidates = @(
        @{ path = (Join-Path -Path $ProjectDir -ChildPath "$UprojectStem.png"); from = "uproject_same_name" },
        @{ path = (Join-Path -Path $ProjectDir -ChildPath "Saved\AutoScreenshot.png"); from = "saved_auto_screenshot" },
        @{ path = (Join-Path -Path $ProjectDir -ChildPath "Saved\autosequence_shot.png"); from = "saved_autosequence" }
    )

    # Total on-disk size of the project folder. .NET enumeration (not
    # Get-ChildItem pipeline) to keep large projects (10^5+ files) tolerable;
    # unreadable subtrees make the total unknowable -> size_bytes = null,
    # never a partial number presented as truth.
    $sizeBytes = $null
    try {
        $acc = [long]0
        foreach ($f in [System.IO.Directory]::EnumerateFiles($ProjectDir, '*', [System.IO.SearchOption]::AllDirectories)) {
            $acc += ([System.IO.FileInfo]::new($f)).Length
        }
        $sizeBytes = $acc
    } catch { $sizeBytes = $null }

    foreach ($c in $candidates) {
        if (Test-Path -LiteralPath $c.path -PathType Leaf) {
            $item = Get-Item -LiteralPath $c.path
            if ($item.Length -gt 0 -and $item.Length -le $MaxBytes) {
                $bytes = [System.IO.File]::ReadAllBytes($c.path)
                $b64 = [Convert]::ToBase64String($bytes)
                @{ ok = $true; found = $true; path = "$($c.path)"; base64 = $b64; from = $c.from; mtime = "$($item.LastWriteTimeUtc.ToString('o'))"; size_bytes = $sizeBytes } | ConvertTo-Json -Compress
                exit 0
            }
        }
    }
    @{ ok = $true; found = $false; path = ""; base64 = ""; from = ""; size_bytes = $sizeBytes } | ConvertTo-Json -Compress
}
catch {
    @{ ok = $false; found = $false; path = ""; base64 = ""; from = ""; message = "$($_.Exception.Message)" } | ConvertTo-Json -Compress
    exit 1
}

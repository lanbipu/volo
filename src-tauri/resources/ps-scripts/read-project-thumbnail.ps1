# Resolves a UE project's thumbnail: same-name PNG next to the .uproject,
# falling back to Saved\autosequence_shot.png. Returns the file base64-encoded
# so the operator's Volo instance can render it without a mounted share.
#
# Node-pure: runs locally on the target (shipped + executed via SSH -File).
# stdin: JSON { "ProjectDir": "...", "UprojectStem": "Aurora" }
# Output: JSON { ok, found, path, base64, from, mtime, message }
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; chcp 65001 | Out-Null
$ErrorActionPreference = 'Continue'

# Skip (not error) an oversized candidate — a thumbnail this large is almost
# certainly not a thumbnail, and base64-inflating it over the SSH stdout pipe
# would be wasteful.
$MaxBytes = 8MB

try {
    $p = [Console]::In.ReadToEnd() | ConvertFrom-Json
    $ProjectDir = $p.ProjectDir
    $UprojectStem = $p.UprojectStem

    $candidates = @(
        @{ path = (Join-Path -Path $ProjectDir -ChildPath "$UprojectStem.png"); from = "uproject_same_name" },
        @{ path = (Join-Path -Path $ProjectDir -ChildPath "Saved\autosequence_shot.png"); from = "saved_autosequence" }
    )

    foreach ($c in $candidates) {
        if (Test-Path -LiteralPath $c.path -PathType Leaf) {
            $item = Get-Item -LiteralPath $c.path
            if ($item.Length -gt 0 -and $item.Length -le $MaxBytes) {
                $bytes = [System.IO.File]::ReadAllBytes($c.path)
                $b64 = [Convert]::ToBase64String($bytes)
                @{ ok = $true; found = $true; path = "$($c.path)"; base64 = $b64; from = $c.from; mtime = "$($item.LastWriteTimeUtc.ToString('o'))" } | ConvertTo-Json -Compress
                exit 0
            }
        }
    }
    @{ ok = $true; found = $false; path = ""; base64 = ""; from = "" } | ConvertTo-Json -Compress
}
catch {
    @{ ok = $false; found = $false; path = ""; base64 = ""; from = ""; message = "$($_.Exception.Message)" } | ConvertTo-Json -Compress
    exit 1
}

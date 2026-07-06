# Deletes the generated DDC pak (.ddp) if present.
#
# Node-pure: runs locally on the target (shipped + executed via SSH -File).
# stdin: JSON { "ProjectDir": "..." }
# Output: JSON { ok, deleted, path }
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; chcp 65001 | Out-Null
$ErrorActionPreference = 'Continue'

try {
    $p = [Console]::In.ReadLine() | ConvertFrom-Json
    $ProjectDir = $p.ProjectDir

    $deleted = $false; $path = ""
    $cand = Join-Path -Path $ProjectDir -ChildPath "DerivedDataCache\DDC.ddp"
    if (Test-Path -LiteralPath $cand) {
        Remove-Item -LiteralPath $cand -Force -ErrorAction SilentlyContinue
        # $ErrorActionPreference='Continue' 上面：Remove-Item 权限不足/文件被占用时只产生
        # non-terminating error，不会跳进 catch，必须回读 Test-Path 才知道是否真的删掉了。
        if (-not (Test-Path -LiteralPath $cand)) { $deleted = $true; $path = "$cand" }
    }
    @{ ok = $true; deleted = $deleted; path = $path } | ConvertTo-Json -Compress
}
catch {
    @{ ok = $false; message = "$($_.Exception.Message)" } | ConvertTo-Json -Compress
    exit 1
}

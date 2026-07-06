# Move a Zen data directory's contents when the operator changes data_dir and
# opts into migration during a redeploy.
#
# Caller contract: the ZenServer Windows service must already be stopped
# before this runs (Rust caller does a best-effort zen-down.ps1 first) so
# robocopy never races an open file handle in the old data dir.
#
# Parameters (stdin JSON):
#   OldDataDir <string>  the previously-configured data_dir.
#   NewDataDir <string>  the newly-configured data_dir.
#
# Output (single JSON object on stdout):
#   { ok: true, migrated: true/false, message: "..." }
#   { ok: false, message: "..." }

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
chcp 65001 | Out-Null

$ErrorActionPreference = 'Stop'

try {
    $p = [Console]::In.ReadLine() | ConvertFrom-Json
    $OldDataDir = $p.OldDataDir
    $NewDataDir = $p.NewDataDir
    if ([string]::IsNullOrWhiteSpace($OldDataDir)) {
        @{ ok = $false; message = "OldDataDir is required" } | ConvertTo-Json -Compress
        exit 0
    }
    if ([string]::IsNullOrWhiteSpace($NewDataDir)) {
        @{ ok = $false; message = "NewDataDir is required" } | ConvertTo-Json -Compress
        exit 0
    }

    $oldFull = [System.IO.Path]::GetFullPath($OldDataDir).TrimEnd('\')
    $newFull = [System.IO.Path]::GetFullPath($NewDataDir).TrimEnd('\')

    if ($oldFull -ieq $newFull) {
        @{ ok = $true; migrated = $false; message = "旧/新数据目录相同，无需迁移" } | ConvertTo-Json -Compress
        exit 0
    }
    if (-not (Test-Path -LiteralPath $oldFull -PathType Container)) {
        @{ ok = $true; migrated = $false; message = "旧数据目录不存在，无需迁移" } | ConvertTo-Json -Compress
        exit 0
    }
    $oldItems = @(Get-ChildItem -LiteralPath $oldFull -Force -ErrorAction SilentlyContinue)
    if ($oldItems.Count -eq 0) {
        @{ ok = $true; migrated = $false; message = "旧数据目录为空，无需迁移" } | ConvertTo-Json -Compress
        exit 0
    }

    if (Test-Path -LiteralPath $newFull -PathType Container) {
        $newItems = @(Get-ChildItem -LiteralPath $newFull -Force -ErrorAction SilentlyContinue)
        if ($newItems.Count -gt 0) {
            @{
                ok = $false
                message = "新数据目录 $newFull 已存在且非空，为避免覆盖/合并歧义已中止迁移——请先清空该目录或改用其它路径"
            } | ConvertTo-Json -Compress
            exit 0
        }
    } else {
        New-Item -ItemType Directory -Path $newFull -Force | Out-Null
    }

    # robocopy /MOVE = copy then delete from source (files AND directories) —
    # moves the whole tree and leaves the (now-empty) old dir behind. /E
    # includes empty subdirectories; /R:2 /W:2 keeps retry backoff short so a
    # transient lock doesn't hang the SSH round-trip.
    $logFile = [System.IO.Path]::GetTempFileName()
    & robocopy $oldFull $newFull /E /MOVE /R:2 /W:2 /NFL /NDL /NP /LOG:$logFile | Out-Null
    $rcExit = [int]$LASTEXITCODE
    Remove-Item -LiteralPath $logFile -ErrorAction SilentlyContinue

    # robocopy exit codes 0-7 are all "success" (bitmask of what happened,
    # e.g. 1 = files copied); 8+ means at least one failure category.
    if ($rcExit -ge 8) {
        @{
            ok = $false
            message = "robocopy 迁移失败（exit $rcExit）——旧目录数据可能部分残留，请手动核对 $oldFull 与 $newFull"
        } | ConvertTo-Json -Compress
        exit 0
    }

    @{
        ok = $true
        migrated = $true
        robocopy_exit = $rcExit
        old_dir = $oldFull
        new_dir = $newFull
        message = "已将缓存数据从 $oldFull 迁移到 $newFull"
    } | ConvertTo-Json -Compress -Depth 4
}
catch {
    @{ ok = $false; message = "$($_.Exception.Message)" } | ConvertTo-Json -Compress
    exit 0
}

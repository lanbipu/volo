# Returns total/free bytes for the disk volume containing a given path.
#
# Node-pure: runs locally on the target (shipped + executed via SSH -File).
# stdin: JSON { "Path": "D:\ZenData" }
# Output: JSON { ok, drive, total_bytes, free_bytes }
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; chcp 65001 | Out-Null
$ErrorActionPreference = 'Continue'

try {
    $p = [Console]::In.ReadLine() | ConvertFrom-Json
    $path = $p.Path
    if ([string]::IsNullOrEmpty($path)) { throw "empty Path" }
    $drive = [System.IO.Path]::GetPathRoot($path).TrimEnd('\')
    if ([string]::IsNullOrEmpty($drive)) { throw "cannot resolve drive from path '$path'" }
    $info = [System.IO.DriveInfo]::new($drive)
    if (-not $info.IsReady) { throw "drive $drive not ready" }
    @{
        ok          = $true
        drive       = $drive
        total_bytes = [int64]$info.TotalSize
        free_bytes  = [int64]$info.AvailableFreeSpace
    } | ConvertTo-Json -Compress
}
catch {
    @{ ok = $false; message = $_.Exception.Message } | ConvertTo-Json -Compress
    exit 1
}

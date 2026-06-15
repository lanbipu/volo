# Reads a window of a log file from a byte offset (incremental tail).
#
# Node-pure: runs locally on the target (shipped + executed via SSH -File).
# stdin: JSON { "LogPath","LastReadOffset",["MaxBytes"] }
# Output: JSON { ok, exists, new_offset, new_text }
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; chcp 65001 | Out-Null
$ErrorActionPreference = 'Stop'

try {
    $p = [Console]::In.ReadToEnd() | ConvertFrom-Json
    $LogPath = $p.LogPath
    $LastReadOffset = [long]$p.LastReadOffset
    $MaxBytes = if ($null -ne $p.MaxBytes) { [int]$p.MaxBytes } else { 65536 }

    if (-not (Test-Path -LiteralPath $LogPath)) {
        @{ ok = $true; exists = $false; new_offset = "0"; new_text = "" } | ConvertTo-Json -Compress
        return
    }
    $size = (Get-Item -LiteralPath $LogPath).Length
    if ($size -le $LastReadOffset) {
        @{ ok = $true; exists = $true; new_offset = "$size"; new_text = "" } | ConvertTo-Json -Compress
        return
    }
    $start = $LastReadOffset
    $count = [int][Math]::Min([long]$MaxBytes, ($size - $start))
    $stream = [System.IO.File]::Open($LogPath, 'Open', 'Read', 'ReadWrite')
    try {
        $stream.Seek($start, 'Begin') | Out-Null
        $buf = New-Object byte[] $count
        $read = $stream.Read($buf, 0, $count)
        $text = [System.Text.Encoding]::UTF8.GetString($buf, 0, $read)
    }
    finally {
        $stream.Dispose()
    }
    @{ ok = $true; exists = $true; new_offset = "$($start + $read)"; new_text = "$text" } | ConvertTo-Json -Compress
}
catch {
    @{ ok = $false; message = "$($_.Exception.Message)" } | ConvertTo-Json -Compress
    exit 1
}

# Sidecar test script. Echoes input back as JSON for the bridge test.
# Usage: powershell.exe -NoProfile -ExecutionPolicy Bypass -File test-echo.ps1 "<input>"

param(
    [string]$Message = "hello"
)

[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; chcp 65001 | Out-Null

$result = @{
    received = $Message
    timestamp = (Get-Date).ToString("yyyy-MM-ddTHH:mm:ss")
    machine = $env:COMPUTERNAME
}

$result | ConvertTo-Json -Compress

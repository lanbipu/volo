# Discovers any RenderStream-related Windows services on a host and reports
# their StartName (the account they run as), State, and StartMode.
#
# Node-pure: runs locally on the target (shipped + executed via SSH -File).
# Takes no args. Output: JSON { ok, services: [...] }
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; chcp 65001 | Out-Null
$ErrorActionPreference = 'Continue'

try {
    $patterns = @(
        'd3service*',
        '*RenderStream*',
        '*disguise*',
        '*Cluster*Render*'
    )
    # ArrayList (not Generic.List): PS 5.1 ConvertTo-Json throws on a live
    # Generic.List of pscustomobjects. [void] on Add to keep the index off stdout.
    $found = New-Object System.Collections.ArrayList
    foreach ($p in $patterns) {
        $svcs = Get-CimInstance Win32_Service -Filter "Name LIKE '$($p.Replace('*','%'))'" -ErrorAction SilentlyContinue
        foreach ($svc in $svcs) {
            if ($found.Where({ $_.Name -eq $svc.Name }).Count -gt 0) { continue }
            [void]$found.Add([pscustomobject]@{
                Name        = $svc.Name
                DisplayName = $svc.DisplayName
                StartName   = $svc.StartName
                State       = $svc.State
                StartMode   = $svc.StartMode
                PathName    = $svc.PathName
            })
        }
    }
    @{ ok = $true; services = @($found) } | ConvertTo-Json -Compress -Depth 4
}
catch {
    @{ ok = $false; message = $_.Exception.Message; services = @() } | ConvertTo-Json -Compress
    exit 1
}

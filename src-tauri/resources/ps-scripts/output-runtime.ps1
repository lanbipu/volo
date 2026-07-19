# nDisplay output node runtime. One compact JSON request is read from stdin.
$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

function Reply([bool]$Ok, [string]$Message, [bool]$ClusterConnected = $false) {
    @{ ok = $Ok; message = $Message; cluster_connected = $ClusterConnected } |
        ConvertTo-Json -Compress -Depth 8
}

function Write-VoloUtf8FileAtomically {
    param(
        [Parameter(Mandatory = $true)][string]$Destination,
        [Parameter(Mandatory = $true)][string]$Content
    )
    $parent = Split-Path -Parent $Destination
    if (-not [string]::IsNullOrWhiteSpace($parent)) {
        New-Item -ItemType Directory -Force -Path $parent | Out-Null
    }
    $temp = "$Destination.tmp"
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($temp, $Content, $utf8NoBom)
    Move-Item -LiteralPath $temp -Destination $Destination -Force
}

function Grant-VoloUsersModify {
    param([Parameter(Mandatory = $true)][string]$Path)
    # SSH / admin-created files under ProgramData default to Users:RX only.
    # The interactive launcher runs as the console user with RunLevel Limited, so
    # it must be able to rewrite GUS before Start-Process.
    try {
        $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
        if ($item.PSIsContainer) {
            & icacls.exe $Path /grant '*S-1-5-32-545:(OI)(CI)M' /T /C /Q 2>$null | Out-Null
        } else {
            & icacls.exe $Path /grant '*S-1-5-32-545:M' /C /Q 2>$null | Out-Null
        }
    } catch {}
}

function Clear-VoloOutputOverlay {
    param(
        [Parameter(Mandatory = $true)][string]$ProjectDir,
        [Parameter(Mandatory = $true)][string]$NodeId
    )
    # Signal backdrop watchers to exit, then force-kill leftover helpers so
    # stop / re-start never leaves a residual black TOPMOST window.
    $marker = Join-Path $ProjectDir ("backdrop-{0}.marker" -f $NodeId)
    try {
        $parent = Split-Path -Parent $marker
        if ($parent) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
        Set-Content -LiteralPath $marker -Value 'done' -Encoding ASCII
    } catch {}
    $backdropNeedle = "backdrop-$NodeId.ps1"
    $pinNeedle = "pin-window-$NodeId.ps1"
    Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue |
        Where-Object {
            $_.CommandLine -and (
                $_.CommandLine.IndexOf($backdropNeedle, [StringComparison]::OrdinalIgnoreCase) -ge 0 -or
                $_.CommandLine.IndexOf($pinNeedle, [StringComparison]::OrdinalIgnoreCase) -ge 0
            )
        } |
        ForEach-Object {
            Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
        }
    try {
        Add-Type -TypeDefinition @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class VoloOverlayCleanup {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll")] public static extern bool DestroyWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
  public static void CloseByTitle(string title) {
    EnumWindows((h, l) => {
      int len = GetWindowTextLength(h);
      if (len <= 0) return true;
      var sb = new StringBuilder(len + 1);
      GetWindowText(h, sb, sb.Capacity);
      if (string.Equals(sb.ToString(), title, StringComparison.OrdinalIgnoreCase)) {
        PostMessage(h, 0x0010, IntPtr.Zero, IntPtr.Zero); // WM_CLOSE
        DestroyWindow(h);
      }
      return true;
    }, IntPtr.Zero);
  }
}
"@ -ErrorAction SilentlyContinue
        [VoloOverlayCleanup]::CloseByTitle(("VoloBlackBackdrop-{0}" -f $NodeId))
    } catch {}
    Start-Sleep -Milliseconds 120
    Remove-Item -LiteralPath $marker -Force -ErrorAction SilentlyContinue
}

function Write-VoloGameUserSettings {
    param(
        [Parameter(Mandatory = $true)][string]$ProjectDir,
        [Parameter(Mandatory = $true)][int]$WinX,
        [Parameter(Mandatory = $true)][int]$WinY,
        [Parameter(Mandatory = $true)][int]$WinW,
        [Parameter(Mandatory = $true)][int]$WinH,
        [int]$DisplayIndex = -1
    )
    $gusDirs = @(
        (Join-Path $ProjectDir 'Saved\Config\WindowsEditor'),
        (Join-Path $ProjectDir 'Saved\Config\Windows'),
        (Join-Path $ProjectDir 'Saved\Config\WindowsNoEditor')
    )
    $gusLines = @(
        '[/Script/Engine.GameUserSettings]',
        # 2 = EWindowMode::Windowed (0 Fullscreen, 1 WindowedFullscreen)
        'FullscreenMode=2',
        'LastConfirmedFullscreenMode=2',
        # 0 = exclusive fullscreen preference; 1 would steer r.FullScreenMode toward
        # WindowedFullscreen which always recenters onto a monitor DisplayRect via
        # SceneViewport::ResizeFrame — unusable for a secondary LED wall.
        'PreferredFullscreenMode=0',
        ('ResolutionSizeX={0}' -f $WinW),
        ('ResolutionSizeY={0}' -f $WinH),
        ('LastUserConfirmedResolutionSizeX={0}' -f $WinW),
        ('LastUserConfirmedResolutionSizeY={0}' -f $WinH),
        ('DesiredScreenWidth={0}' -f $WinW),
        'bUseDesiredScreenHeight=True',
        ('DesiredScreenHeight={0}' -f $WinH),
        ('WindowPosX={0}' -f $WinX),
        ('WindowPosY={0}' -f $WinY),
        ('WindowPositions=(X={0},Y={1})' -f $WinX, $WinY),
        'bUseVSync=False',
        'bUseDynamicResolution=False',
        'Version=5'
    )
    if ($DisplayIndex -ge 0) {
        $gusLines += @(
            ('DisplayIndex={0}' -f $DisplayIndex),
            ('LastUserConfirmedDisplayIndex={0}' -f $DisplayIndex)
        )
    }
    $gusBody = ($gusLines -join "`r`n") + "`r`n"
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    foreach ($gusDir in $gusDirs) {
        New-Item -ItemType Directory -Force -Path $gusDir | Out-Null
        Grant-VoloUsersModify -Path $gusDir
        $gusPath = Join-Path $gusDir 'GameUserSettings.ini'
        if (Test-Path -LiteralPath $gusPath) {
            try {
                $existing = Get-Item -LiteralPath $gusPath -Force
                if ($existing.IsReadOnly) { $existing.IsReadOnly = $false }
            } catch {}
            Grant-VoloUsersModify -Path $gusPath
        }
        [System.IO.File]::WriteAllText($gusPath, $gusBody, $utf8NoBom)
        Grant-VoloUsersModify -Path $gusPath
    }
}

try {
    $line = [Console]::In.ReadLine()
    if ([string]::IsNullOrWhiteSpace($line)) { throw "missing JSON request" }
    $request = $line | ConvertFrom-Json
    $action = [string]$request.action

    if ($action -eq "preflight") {
        $missing = @()
        foreach ($item in @(
            @{ Name = "UnrealEditor"; Path = [string]$request.editor_path }
        )) {
            if (-not (Test-Path -LiteralPath $item.Path -PathType Leaf)) { $missing += "$($item.Name): $($item.Path)" }
        }
        if ($missing.Count -gt 0) { throw "missing runtime files: $($missing -join '; ')" }

        $projectDir = Split-Path -Parent ([string]$request.project_path)
        $manifestDir = Split-Path -Parent ([string]$request.manifest_path)
        New-Item -ItemType Directory -Force -Path $projectDir | Out-Null
        if (-not [string]::IsNullOrWhiteSpace($manifestDir)) { New-Item -ItemType Directory -Force -Path $manifestDir | Out-Null }
        New-Item -ItemType Directory -Force -Path ([string]$request.image_dir) | Out-Null
        # ProductVersion reads like "++UE5+Release-5.8-CL-55116800" so prefix checks fail;
        # the authoritative source is Engine/Build/Build.version (JSON, Major/Minor).
        $engineRoot = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent ([string]$request.editor_path)))
        $buildFile = Join-Path $engineRoot "Build\Build.version"
        if (-not (Test-Path -LiteralPath $buildFile -PathType Leaf)) { throw "cannot determine UE version: missing $buildFile" }
        $build = Get-Content -LiteralPath $buildFile -Raw | ConvertFrom-Json
        $version = "$($build.MajorVersion).$($build.MinorVersion).$($build.PatchVersion)"
        if (-not $version.StartsWith("5.8")) {
            throw "unsupported Unreal Engine $version; VoloOutput Blueprint was saved by UE 5.8 and Phase 1 requires UE 5.8"
        }
        $running = @(Get-CimInstance Win32_Process -Filter "Name='UnrealEditor.exe'" |
            Where-Object { $_.CommandLine } |
            ForEach-Object {
                $summary = ([string]$_.CommandLine -replace '\s+', ' ').Trim()
                if ($summary.Length -gt 180) { $summary = $summary.Substring(0, 180) + '...' }
                "UnrealEditor.exe PID=$($_.ProcessId) command=$summary"
            })
        $warning = if ($running.Count -gt 0) { "; warning: running UE process(es): $($running -join ' | ')" } else { '' }
        Reply $true "preflight passed; UE $version$warning"
        exit 0
    }

    if ($action -eq "prepare_deploy") {
        $projectDir = Split-Path -Parent ([string]$request.project_path)
        @(
            $projectDir,
            (Join-Path $projectDir "Config"),
            (Join-Path $projectDir "Content\VoloOutput"),
            (Split-Path -Parent ([string]$request.config_path)),
            (Split-Path -Parent ([string]$request.manifest_path)),
            ([string]$request.image_dir)
        ) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | ForEach-Object {
            New-Item -ItemType Directory -Force -Path $_ | Out-Null
        }
        Reply $true "deployment directories ready"
        exit 0
    }

    if ($action -eq "publish_text") {
        Write-VoloUtf8FileAtomically -Destination ([string]$request.config_path) -Content ([string]$request.content)
        Reply $true "nDisplay config deployed"
        exit 0
    }

    if ($action -eq "launch") {
        $project = [string]$request.project_path
        $nodeId = [string]$request.node_id
        $projectDir = Split-Path -Parent $project
        $asset = Join-Path $projectDir "Content\VoloOutput\BP_VoloOutput.uasset"
        foreach ($item in @(
            @{ Name = "project"; Path = $project },
            @{ Name = "nDisplay config"; Path = [string]$request.config_path },
            @{ Name = "Blueprint asset"; Path = $asset }
        )) {
            if (-not (Test-Path -LiteralPath $item.Path -PathType Leaf)) { throw "start gate missing $($item.Name): $($item.Path)" }
        }
        # Optional clear-manifest publish folded into launch (saves a per-node SSH hop).
        # Must happen before UE starts so LastRevision=-1 does not flash a stale show.
        if ($null -ne $request.clear_manifest_json -and -not [string]::IsNullOrWhiteSpace([string]$request.clear_manifest_json)) {
            Write-VoloUtf8FileAtomically -Destination ([string]$request.manifest_path) -Content ([string]$request.clear_manifest_json)
        }
        $logDir = Join-Path (Split-Path -Parent $project) "Saved\Logs"
        New-Item -ItemType Directory -Force -Path $logDir | Out-Null
        $logPath = Join-Path $logDir "VoloOutput-$nodeId.log"
        $existing = @(Get-CimInstance Win32_Process -Filter "Name='UnrealEditor.exe'" |
            Where-Object { $_.CommandLine -and $_.CommandLine.IndexOf($project, [StringComparison]::OrdinalIgnoreCase) -ge 0 })
        if ($existing.Count -gt 0) {
            $pids = ($existing | ForEach-Object { $_.ProcessId }) -join ', '
            throw "VoloOutput project is already running (PID=$pids); stop it before starting again: $project"
        }
        # Drop any leftover black backdrop / pin helper from a prior run.
        Clear-VoloOutputOverlay -ProjectDir $projectDir -NodeId $nodeId
        $arguments = @(
            ('"{0}"' -f $project),
            '-game', '-messaging', '-dc_cluster', '-dc_dev_mono',
            ('-dc_cfg="{0}"' -f ([string]$request.config_path)),
            ('-dc_node={0}' -f $nodeId),
            '-windowed',
            ('-ResX={0}' -f [int]$request.window_width),
            ('-ResY={0}' -f [int]$request.window_height),
            # UE only reads .ndisplay window x/y through a launcher (Switchboard
            # passes -WinX/-WinY); the engine itself ignores them in -game mode.
            # -ForceRes only prevents ConditionallyOverrideSettings from clamping
            # ResX/ResY to the *primary* monitor size (GameEngine.cpp). It does
            # NOT stop a later SceneViewport::ResizeFrame from re-centering the
            # window onto the primary work area when size appears to change
            # (common after nDisplay GameStart → Create viewport manager).
            # Dual-node start waits up to GameStartBarrierTimeout (180s), so that
            # late recenter is far more visible than single-node. Position is
            # therefore also pinned from the interactive launcher (see below).
            ('-WinX={0}' -f [int]$request.window_x),
            ('-WinY={0}' -f [int]$request.window_y),
            '-forceres',
            '-RemoteControlIsHeadless', '-RCWebControlEnable', '-ClusterForceApplyResponse',
            # dc_dev_mono marks views as stereo views; the engine then draws the
            # "StereoView / Stereo rendering method" on-screen debug lines
            # (SceneRendering.cpp, !UE_BUILD_SHIPPING). Not acceptable on an LED wall.
            '-NoScreenMessages',
            # Kill the white UE splash; Phase A2' black backdrop still covers any
            # residual first-present / mode-switch flash on the target Bounds.
            '-nosplash',
            ('-abslog="{0}"' -f $logPath)
        )
        # SSH runs as a network logon (session 0): Start-Process there has no desktop
        # and D3D12 device creation fails with DXGI_ERROR_NOT_CURRENTLY_AVAILABLE.
        # Launch through an Interactive-logon scheduled task instead (the verified
        # technique from start-ue-interactive.ps1 / PSO warmup).
        $consoleUser = (Get-CimInstance Win32_ComputerSystem).UserName
        if ([string]::IsNullOrWhiteSpace($consoleUser)) {
            throw "no interactive console user logged on (required for -game rendering)"
        }
        Remove-Item -LiteralPath $logPath -Force -ErrorAction SilentlyContinue
        $winX = [int]$request.window_x
        $winY = [int]$request.window_y
        $winW = [int]$request.window_width
        $winH = [int]$request.window_height
        # Stale GUS (especially FullscreenMode=1 WindowedFullscreen) makes
        # ApplySettings(false) rebind onto the primary monitor after GameStart.
        # Seed now from SSH; the interactive launcher rewrites with a live
        # DisplayIndex once monitor enumeration sees the real desktop.
        Write-VoloGameUserSettings -ProjectDir $projectDir -WinX $winX -WinY $winY -WinW $winW -WinH $winH
        # The task action is a small launcher running IN the interactive session.
        # It rewrites GUS with the resolved monitor index, starts a black backdrop
        # (Phase A1), starts UE, then detaches a pin watchdog (Phase A2'): UE may
        # show early under the cover; backdrop lifts only after render evidence.
        $launcherPath = Join-Path $projectDir "launch-$nodeId.ps1"
        $pinPath = Join-Path $projectDir "pin-window-$nodeId.ps1"
        $backdropPath = Join-Path $projectDir "backdrop-$nodeId.ps1"
        $backdropMarker = Join-Path $projectDir "backdrop-$nodeId.marker"
        $backdropTitle = "VoloBlackBackdrop-$nodeId"
        $exeQ = ([string]$request.editor_path) -replace "'", "''"
        $argQ = ($arguments -join ' ') -replace "'", "''"
        $projectDirQ = $projectDir -replace "'", "''"
        $pinPathQ = $pinPath -replace "'", "''"
        $backdropPathQ = $backdropPath -replace "'", "''"
        $backdropMarkerQ = $backdropMarker -replace "'", "''"
        $logPathQ = $logPath -replace "'", "''"
        $backdropTitleQ = $backdropTitle -replace "'", "''"
        # ethernet_barrier: HWND overlay (backdrop/pin/burst SetWindowPos) races the
        # first WaitForFrameCompletion and leaves the secondary node off
        # present_barrier. Auto-skip overlay for that sync policy; `none` keeps A1/A2'.
        $forceSkipOverlay = $false
        try {
            $cfgRaw = Get-Content -LiteralPath ([string]$request.config_path) -Raw -ErrorAction Stop
            if ($cfgRaw -match '"type"\s*:\s*"ethernet_barrier"') { $forceSkipOverlay = $true }
        } catch {}
        # Pin for process lifetime (cap 600s). Phase A2': UE may SW_SHOW early
        # (needed for D3D present) but stays HWND_NOTOPMOST under a black TOPMOST
        # backdrop until abslog evidence + grace — never SW_HIDE (that exposed the
        # desktop when backdrop lost Z-order). FullscreenMode stays 2.
        $pinBody = @'
param(
  [Parameter(Mandatory=$true)][int]$UePid,
  [int]$WinX, [int]$WinY, [int]$WinW, [int]$WinH,
  [string]$LogPath = '',
  [string]$BackdropMarker = '',
  # Finisher mode (ethernet_barrier): no backdrop/cover placement at all —
  # only wait for render evidence, then the one-shot A3 promote below.
  [switch]$FinisherOnly
)
Add-Type -TypeDefinition @"
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class VoloWin {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int n);
  [DllImport("user32.dll")] public static extern int SetWindowLong(IntPtr h, int n, int v);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int w, int hh, uint f);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr v);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L; public int T; public int R; public int B; }
  public static List<IntPtr> FindGameHwnds(uint pid) {
    var list = new List<IntPtr>();
    EnumWindows((h, l) => {
      uint wpid = 0;
      GetWindowThreadProcessId(h, out wpid);
      if (wpid != pid) return true;
      RECT wr; GetWindowRect(h, out wr);
      int ow = wr.R - wr.L, oh = wr.B - wr.T;
      if (ow < 64 || oh < 64) return true;
      // Skip IME / tool / our own backdrop; keep splash / game HWNDs.
      int len = GetWindowTextLength(h);
      if (len > 0) {
        var sb = new StringBuilder(len + 1);
        GetWindowText(h, sb, sb.Capacity);
        string t = sb.ToString();
        if (t.IndexOf("IME", StringComparison.OrdinalIgnoreCase) >= 0) return true;
        if (t.IndexOf("MSCTF", StringComparison.OrdinalIgnoreCase) >= 0) return true;
        if (t.IndexOf("VoloBlackBackdrop", StringComparison.OrdinalIgnoreCase) >= 0) return true;
      }
      list.Add(h);
      return true;
    }, IntPtr.Zero);
    return list;
  }
}
"@
[VoloWin]::SetProcessDpiAwarenessContext([IntPtr](-4)) | Out-Null
$deadline = (Get-Date).AddSeconds(600)
$t0 = Get-Date
$log = Join-Path $PSScriptRoot ('pin-window-{0}.log' -f $UePid)
('pin start A2prime pid={0} target={1},{2} {3}x{4} log={5} finisherOnly={6}' -f $UePid, $WinX, $WinY, $WinW, $WinH, $LogPath, [bool]$FinisherOnly) | Set-Content -LiteralPath $log -Encoding ASCII
$script:firstPlaced = $false
$script:revealed = $false
$script:evidenceAt = $null
$script:evidenceSeen = $false
$script:lastEvidenceCheck = [DateTime]::MinValue
$script:lastTopmost = Get-Date
$script:lastCoverZ = [DateTime]::MinValue
$script:pinFrozen = $false
$script:revealedAt = $null
# A3 one-shot promote: UE clamps the -ResY window to the monitor work area and
# never sets WS_EX_TOPMOST, while Shell_TrayWnd IS topmost — without a final
# promote the taskbar keeps a strip over the wall. Wait well past the first
# presents (the ethernet_barrier-sensitive window) before the single SetWindowPos.
$script:promoteGraceMs = 10000
# Lift cover ASAP after Create viewport manager. ethernet_barrier does
# WaitForFrameCompletion+SyncOnBarrier on the first present; hammering
# SetWindowPos / TOPMOST during that window left LanNode stuck on the GPU
# fence while Node1 waited alone at present_barrier (~60s → EngineExit).
$script:revealGraceMs = 0
function Test-VoloRenderEvidence {
    if ($script:evidenceSeen) { return $true }
    if ([string]::IsNullOrWhiteSpace($LogPath)) { return $false }
    # Window pin loops at 1-8ms; only rescan the UE log every 250ms.
    if (((Get-Date) - $script:lastEvidenceCheck).TotalMilliseconds -lt 250) { return $false }
    $script:lastEvidenceCheck = Get-Date
    if (-not (Test-Path -LiteralPath $LogPath)) { return $false }
    $match = Select-String -LiteralPath $LogPath -Pattern 'LogDisplayClusterGame:.*Create viewport manager' -CaseSensitive:$false |
        Select-Object -Last 1
    if ($null -ne $match) { $script:evidenceSeen = $true; return $true }
    return $false
}
function Signal-VoloBackdropDone {
    if ([string]::IsNullOrWhiteSpace($BackdropMarker)) { return }
    try {
        Set-Content -LiteralPath $BackdropMarker -Value 'done' -Encoding ASCII
    } catch {}
}
function Apply-VoloBorderless([IntPtr]$Hwnd) {
    $GWL_STYLE = -16
    # Chrome bits to clear (caption/thickframe/sysmenu/minmax/border/dlgframe).
    $chrome = [int]0x00CF0000
    $WS_POPUP = [int]0x80000000
    $WS_VISIBLE = [int]0x10000000
    $WS_CLIPCHILDREN = [int]0x02000000
    $WS_CLIPSIBLINGS = [int]0x04000000
    $style = [VoloWin]::GetWindowLong($Hwnd, $GWL_STYLE)
    $hadChrome = (($style -band $chrome) -ne 0)
    $keepVisible = ($style -band $WS_VISIBLE)
    $newStyle = [int](($style -band (-bnot $chrome)) -bor $WS_POPUP -bor $WS_CLIPCHILDREN -bor $WS_CLIPSIBLINGS -bor $keepVisible)
    if ($newStyle -ne $style) {
        [void][VoloWin]::SetWindowLong($Hwnd, $GWL_STYLE, $newStyle)
    }
    return ($hadChrome -or ($newStyle -ne $style))
}
function Place-VoloWindow([IntPtr]$Hwnd, [bool]$Initial, [bool]$Covered) {
    $rect = New-Object VoloWin+RECT
    [void][VoloWin]::GetWindowRect($Hwnd, [ref]$rect)
    $ow = $rect.R - $rect.L; $oh = $rect.B - $rect.T
    $cr = New-Object VoloWin+RECT
    [void][VoloWin]::GetClientRect($Hwnd, [ref]$cr)
    $cw = $cr.R - $cr.L; $ch = $cr.B - $cr.T
    $styleChanged = Apply-VoloBorderless $Hwnd
    $posBad = ($rect.L -ne $WinX) -or ($rect.T -ne $WinY) -or ($ow -ne $WinW) -or ($oh -ne $WinH)
    $clientBad = ($cw -ne $WinW) -or ($ch -ne $WinH)
    $vis = [VoloWin]::IsWindowVisible($Hwnd)
    if (-not ($Initial -or $styleChanged -or $posBad -or $clientBad -or (-not $vis))) {
        return $false
    }
    # A2': always show (UE needs a visible HWND to present). While Covered, park
    # under the black TOPMOST backdrop via HWND_NOTOPMOST — never SW_HIDE.
    # 0x0060 = SWP_FRAMECHANGED|SWP_SHOWWINDOW; insertAfter -2=HWND_NOTOPMOST, -1=TOPMOST
    if ($Covered) {
        [void][VoloWin]::SetWindowPos($Hwnd, [IntPtr](-2), $WinX, $WinY, $WinW, $WinH, 0x0060)
        [void][VoloWin]::ShowWindow($Hwnd, 5) # SW_SHOW
    } else {
        [void][VoloWin]::SetWindowPos($Hwnd, [IntPtr](-1), $WinX, $WinY, $WinW, $WinH, 0x0060)
        [void][VoloWin]::ShowWindow($Hwnd, 5)
    }
    ('{0:o} place outer ({1},{2}) {3}x{4} client {5}x{6} initial={7} style={8} covered={9} -> ({10},{11}) {12}x{13}' -f `
        (Get-Date), $rect.L, $rect.T, $ow, $oh, $cw, $ch, $Initial, $styleChanged, $Covered, $WinX, $WinY, $WinW, $WinH) |
        Add-Content -LiteralPath $log -Encoding ASCII
    return $true
}
function Promote-VoloTopmost {
    $hwnds = [VoloWin]::FindGameHwnds([uint32]$UePid)
    if ($hwnds.Count -eq 0) { return $false }
    foreach ($hwnd in $hwnds) {
        [void](Apply-VoloBorderless $hwnd)
        # 0x0060 = SWP_FRAMECHANGED|SWP_SHOWWINDOW; -1 = HWND_TOPMOST.
        [void][VoloWin]::SetWindowPos($hwnd, [IntPtr](-1), $WinX, $WinY, $WinW, $WinH, 0x0060)
        [void][VoloWin]::ShowWindow($hwnd, 5)
        ('{0:o} promote A3 topmost hwnd={1} -> ({2},{3}) {4}x{5}' -f (Get-Date), $hwnd, $WinX, $WinY, $WinW, $WinH) |
            Add-Content -LiteralPath $log -Encoding ASCII
    }
    return $true
}
while ((Get-Date) -lt $deadline) {
    try { $proc = Get-Process -Id $UePid -ErrorAction Stop } catch { Signal-VoloBackdropDone; exit 0 }
    if ($proc.HasExited) { Signal-VoloBackdropDone; exit 0 }
    $hwnds = [VoloWin]::FindGameHwnds([uint32]$UePid)
    try {
        $proc.Refresh()
        if ($proc.MainWindowHandle -ne [IntPtr]::Zero -and -not ($hwnds -contains $proc.MainWindowHandle)) {
            $hwnds.Add($proc.MainWindowHandle)
        }
    } catch {}

    if (-not $script:revealed) {
        $forceReveal = ((Get-Date) - $t0).TotalSeconds -ge 240
        if ($hwnds.Count -gt 0 -and ((Test-VoloRenderEvidence) -or $forceReveal)) {
            if ($null -eq $script:evidenceAt) {
                $script:evidenceAt = Get-Date
                ('{0:o} evidence seen force={1}' -f (Get-Date), $forceReveal) |
                    Add-Content -LiteralPath $log -Encoding ASCII
            }
            if ($forceReveal -or (((Get-Date) - $script:evidenceAt).TotalMilliseconds -ge $script:revealGraceMs)) {
                # Drop cover ONLY — do not SetWindowPos/SetForeground here.
                # Reveal used to promote TOPMOST at Create-viewport time; that
                # coincides with ethernet_barrier's first WaitForFrameCompletion
                # and left LanNode off the present_barrier (~60s timeout).
                $script:revealed = $true
                $script:pinFrozen = $true
                $script:revealedAt = Get-Date
                ('{0:o} reveal A2prime evidence={1} force={2} hwnds={3} graceMs={4} pinFrozen (no SetWindowPos)' -f `
                    (Get-Date), (-not $forceReveal), $forceReveal, $hwnds.Count, $script:revealGraceMs) |
                    Add-Content -LiteralPath $log -Encoding ASCII
                Start-Sleep -Milliseconds 50
                Signal-VoloBackdropDone
            }
        }
    }

    # Critical: do not touch HWND during first ethernet_barrier presents.
    if ($script:pinFrozen) {
        if (((Get-Date) - $script:revealedAt).TotalMilliseconds -ge $script:promoteGraceMs) {
            if (Promote-VoloTopmost) { exit 0 }
        }
        Start-Sleep -Milliseconds 250
        continue
    }

    foreach ($hwnd in $hwnds) {
        # Finisher mode never touches the HWND before evidence + grace.
        if ($FinisherOnly) { break }
        if (-not $script:revealed) {
            $isInitial = -not $script:firstPlaced
            if (Place-VoloWindow $hwnd $isInitial $true) {
                $script:firstPlaced = $true
            } elseif (((Get-Date) - $script:lastCoverZ).TotalMilliseconds -ge 500) {
                # Stay shown + NOTOPMOST under backdrop — at most 2 Hz (was every 8ms).
                [void][VoloWin]::SetWindowPos($hwnd, [IntPtr](-2), 0, 0, 0, 0, 0x0013)
                $script:lastCoverZ = Get-Date
            }
        }
        # After reveal: pin stays frozen (no Place / TOPMOST refresh).
    }
    $elapsed = ((Get-Date) - $t0).TotalSeconds
    $sleepMs = if ($FinisherOnly) { 250 } elseif (-not $script:firstPlaced) { 1 } elseif (-not $script:revealed) { 8 } elseif ($elapsed -lt 120) { 50 } else { 100 }
    Start-Sleep -Milliseconds $sleepMs
}
Signal-VoloBackdropDone
'@
        $backdropBody = @'
param(
  [Parameter(Mandatory=$true)][int]$WinX,
  [Parameter(Mandatory=$true)][int]$WinY,
  [Parameter(Mandatory=$true)][int]$WinW,
  [Parameter(Mandatory=$true)][int]$WinH,
  [Parameter(Mandatory=$true)][string]$MarkerPath,
  [Parameter(Mandatory=$true)][string]$Title
)
$ErrorActionPreference = 'Continue'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class VoloBackdropNative {
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr v);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int w, int hh, uint f);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
}
"@
[VoloBackdropNative]::SetProcessDpiAwarenessContext([IntPtr](-4)) | Out-Null
$bdLog = ($MarkerPath -replace '\.marker$', '.log')
try {
  $parent = Split-Path -Parent $MarkerPath
  if ($parent) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
  Set-Content -LiteralPath $MarkerPath -Value 'starting' -Encoding ASCII
  ('{0:o} backdrop start bounds={1},{2} {3}x{4} title={5}' -f (Get-Date), $WinX, $WinY, $WinW, $WinH, $Title) |
    Set-Content -LiteralPath $bdLog -Encoding ASCII
} catch {}
$form = New-Object System.Windows.Forms.Form
$form.Text = $Title
$form.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::None
$form.ShowInTaskbar = $false
$form.TopMost = $true
$form.ControlBox = $false
$form.BackColor = [System.Drawing.Color]::Black
$form.StartPosition = [System.Windows.Forms.FormStartPosition]::Manual
$form.Bounds = New-Object System.Drawing.Rectangle($WinX, $WinY, $WinW, $WinH)
# Show without stealing focus from the upcoming UE launch.
$form.Show()
[void][VoloBackdropNative]::ShowWindow($form.Handle, 4) # SW_SHOWNOACTIVATE
# HWND_TOPMOST every tick — UE splash / game also fight for Z-order.
[void][VoloBackdropNative]::SetWindowPos($form.Handle, [IntPtr](-1), $WinX, $WinY, $WinW, $WinH, 0x0040)
try {
  Set-Content -LiteralPath $MarkerPath -Value 'ready' -Encoding ASCII
  ('{0:o} backdrop ready hwnd={1}' -f (Get-Date), $form.Handle) | Add-Content -LiteralPath $bdLog -Encoding ASCII
} catch {}
$deadline = (Get-Date).AddSeconds(600)
while ((Get-Date) -lt $deadline) {
  $state = ''
  if (Test-Path -LiteralPath $MarkerPath) {
    try { $state = (Get-Content -LiteralPath $MarkerPath -Raw -ErrorAction SilentlyContinue) } catch {}
    if ($state -match 'done') { break }
  } else {
    break
  }
  if ($form.IsDisposed) { break }
  # Reassert TOPMOST every loop (~40ms). A1 failed when UE briefly stole Z-order
  # between 1s reasserts and the white flash was visible above the cover.
  [void][VoloBackdropNative]::SetWindowPos($form.Handle, [IntPtr](-1), $WinX, $WinY, $WinW, $WinH, 0x0013)
  $form.TopMost = $true
  [System.Windows.Forms.Application]::DoEvents()
  Start-Sleep -Milliseconds 40
}
try { ('{0:o} backdrop exit state={1}' -f (Get-Date), $state) | Add-Content -LiteralPath $bdLog -Encoding ASCII } catch {}
try { $form.Hide(); $form.Close(); $form.Dispose() } catch {}
Remove-Item -LiteralPath $MarkerPath -Force -ErrorAction SilentlyContinue
'@
        # ASCII / UTF8-no-BOM: Windows PowerShell -Encoding UTF8 writes a BOM that
        # breaks `param()` as the first token of the generated pin script.
        $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
        [System.IO.File]::WriteAllText($pinPath, $pinBody, $utf8NoBom)
        [System.IO.File]::WriteAllText($backdropPath, $backdropBody, $utf8NoBom)
        $launcherLines = @(
            # GUS rewrite is best-effort: SSH-seeded files under ProgramData may be
            # Administrators-owned (Users:RX). Never block Start-Process on that.
            '$ErrorActionPreference = ''Continue''',
            'Add-Type -AssemblyName System.Windows.Forms',
            'Add-Type -TypeDefinition ''using System; using System.Runtime.InteropServices; public class VoloWin { [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr v); }''',
            '[VoloWin]::SetProcessDpiAwarenessContext([IntPtr](-4)) | Out-Null',
            ('$WinX = {0}; $WinY = {1}; $WinW = {2}; $WinH = {3}' -f $winX, $winY, $winW, $winH),
            '$pinX = $WinX; $pinY = $WinY; $pinW = $WinW; $pinH = $WinH',
            '$displayIndex = -1',
            '$screens = @([System.Windows.Forms.Screen]::AllScreens)',
            '$idx = 0',
            'foreach ($screen in $screens) {',
            '    $b = $screen.Bounds',
            '    if (($WinX -ge $b.X) -and ($WinX -lt ($b.X + $b.Width)) -and ($WinY -ge $b.Y) -and ($WinY -lt ($b.Y + $b.Height))) {',
            '        $displayIndex = $idx',
            '        $pinX = $b.X; $pinY = $b.Y; $pinW = $b.Width; $pinH = $b.Height',
            '        break',
            '    }',
            '    $idx++',
            '}',
            # Single-monitor nodes (LanPC→ASUS): if origin missed every Bounds
            # (DPI / virtual-display oddities), pin the only real screen.
            'if (($displayIndex -lt 0) -and ($screens.Count -eq 1)) {',
            '    $b = $screens[0].Bounds',
            '    $displayIndex = 0',
            '    $pinX = $b.X; $pinY = $b.Y; $pinW = $b.Width; $pinH = $b.Height',
            '}',
            ('$projectDir = ''{0}''' -f $projectDirQ),
            ('$backdropPath = ''{0}''' -f $backdropPathQ),
            ('$backdropMarker = ''{0}''' -f $backdropMarkerQ),
            ('$backdropTitle = ''{0}''' -f $backdropTitleQ),
            ('$logPath = ''{0}''' -f $logPathQ),
            '$gusDirs = @(',
            '    (Join-Path $projectDir ''Saved\Config\WindowsEditor''),',
            '    (Join-Path $projectDir ''Saved\Config\Windows''),',
            '    (Join-Path $projectDir ''Saved\Config\WindowsNoEditor'')',
            ')',
            '$gusLines = @(',
            '    ''[/Script/Engine.GameUserSettings]'',',
            '    ''FullscreenMode=2'',',
            '    ''LastConfirmedFullscreenMode=2'',',
            '    ''PreferredFullscreenMode=0'',',
            '    (''ResolutionSizeX={0}'' -f $pinW),',
            '    (''ResolutionSizeY={0}'' -f $pinH),',
            '    (''LastUserConfirmedResolutionSizeX={0}'' -f $pinW),',
            '    (''LastUserConfirmedResolutionSizeY={0}'' -f $pinH),',
            '    (''DesiredScreenWidth={0}'' -f $pinW),',
            '    ''bUseDesiredScreenHeight=True'',',
            '    (''DesiredScreenHeight={0}'' -f $pinH),',
            '    (''WindowPosX={0}'' -f $pinX),',
            '    (''WindowPosY={0}'' -f $pinY),',
            '    (''WindowPositions=(X={0},Y={1})'' -f $pinX, $pinY),',
            '    ''bUseVSync=False'',',
            '    ''bUseDynamicResolution=False'',',
            '    ''Version=5''',
            ')',
            'if ($displayIndex -ge 0) {',
            '    $gusLines += @(',
            '        (''DisplayIndex={0}'' -f $displayIndex),',
            '        (''LastUserConfirmedDisplayIndex={0}'' -f $displayIndex)',
            '    )',
            '}',
            '$gusBody = ($gusLines -join "`r`n") + "`r`n"',
            '$utf8NoBom = New-Object System.Text.UTF8Encoding($false)',
            'foreach ($gusDir in $gusDirs) {',
            '    try {',
            '        New-Item -ItemType Directory -Force -Path $gusDir | Out-Null',
            '        $gusPath = Join-Path $gusDir ''GameUserSettings.ini''',
            '        if (Test-Path -LiteralPath $gusPath) {',
            '            try { $g = Get-Item -LiteralPath $gusPath -Force; if ($g.IsReadOnly) { $g.IsReadOnly = $false } } catch {}',
            '            icacls.exe $gusPath /grant ''*S-1-5-32-545:M'' /C /Q 2>$null | Out-Null',
            '        }',
            '        [System.IO.File]::WriteAllText($gusPath, $gusBody, $utf8NoBom)',
            '    } catch {',
            '        # Keep going — SSH seed + -WinX/-WinY/-ForceRes still apply.',
            '    }',
            '}',
            # Skip black backdrop + pin when: ethernet_barrier (auto), env, or flag.
            # Set VOL_SKIP_NDISPLAY_OVERLAY=1 in the interactive launch environment.
            ('$skipOverlay = {0} -or ($env:VOL_SKIP_NDISPLAY_OVERLAY -eq ''1'') -or (Test-Path -LiteralPath ''C:\ProgramData\UECM\ndisplay-output\session\skip-overlay.flag'')' -f ($(if ($forceSkipOverlay) { '$true' } else { '$false' }))),
            'if ($skipOverlay) { Write-Output ''skip-overlay: backdrop+pin+burst disabled (ethernet_barrier or flag/env)'' }',
            'if (-not $skipOverlay) {',
            # Phase A1: black TOPMOST backdrop on target Bounds BEFORE Start-Process.
            # Wait until marker=ready so the cover is painted before UE can flash.
            'Remove-Item -LiteralPath $backdropMarker -Force -ErrorAction SilentlyContinue',
            'Remove-Item -LiteralPath ($backdropMarker -replace ''\.marker$'', ''.log'') -Force -ErrorAction SilentlyContinue',
            '$bdArgs = ''-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "{0}" -WinX {1} -WinY {2} -WinW {3} -WinH {4} -MarkerPath "{5}" -Title "{6}"'' -f $backdropPath, $pinX, $pinY, $pinW, $pinH, $backdropMarker, $backdropTitle',
            'Start-Process -FilePath ''powershell.exe'' -ArgumentList $bdArgs -WindowStyle Hidden | Out-Null',
            '$bdWait = (Get-Date).AddSeconds(5)',
            '$bdReady = $false',
            'while ((Get-Date) -lt $bdWait) {',
            '    if (Test-Path -LiteralPath $backdropMarker) {',
            '        $st = ''''',
            '        try { $st = Get-Content -LiteralPath $backdropMarker -Raw -ErrorAction SilentlyContinue } catch {}',
            '        if ($st -match ''ready'') { $bdReady = $true; break }',
            '    }',
            '    Start-Sleep -Milliseconds 40',
            '}',
            # Even if marker race fails, give the form one frame to paint.
            'if (-not $bdReady) { Start-Sleep -Milliseconds 200 }',
            '} else { Write-Output ''VOL_SKIP_NDISPLAY_OVERLAY=1: skipping backdrop'' }',
            ('$p = Start-Process -FilePath ''{0}'' -ArgumentList ''{1}'' -PassThru' -f $exeQ, $argQ),
            'if (-not $p) { throw ''Start-Process UnrealEditor returned no process'' }',
            'if (-not $skipOverlay) {',
            # Detached pin: A2' — show UE under backdrop (NOTOPMOST), lift cover after evidence.
            ('$pinArgs = ''-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "{0}" -UePid '' + $p.Id + '' -WinX '' + $pinX + '' -WinY '' + $pinY + '' -WinW '' + $pinW + '' -WinH '' + $pinH + '' -LogPath "{1}" -BackdropMarker "{2}"''' -f $pinPathQ, $logPathQ, $backdropMarkerQ),
            'Start-Process -FilePath ''powershell.exe'' -ArgumentList $pinArgs -WindowStyle Hidden | Out-Null',
            'Add-Type -TypeDefinition ''using System; using System.Collections.Generic; using System.Runtime.InteropServices; public class VoloBurst { public delegate bool EnumProc(IntPtr h, IntPtr l); [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l); [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid); [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r); [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int n); [DllImport("user32.dll")] public static extern int SetWindowLong(IntPtr h, int n, int v); [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int w, int hh, uint f); [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd); [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h); [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L; public int T; public int R; public int B; } }''',
            '$burstEnd = (Get-Date).AddSeconds(5)',
            '$uePidBurst = [uint32]$p.Id',
            'while ((Get-Date) -lt $burstEnd) {',
            '    try { if ((Get-Process -Id $p.Id -ErrorAction Stop).HasExited) { break } } catch { break }',
            '    $script:burstHwnds = New-Object System.Collections.Generic.List[IntPtr]',
            '    $cb = [VoloBurst+EnumProc]{',
            '        param([IntPtr]$h, [IntPtr]$l)',
            '        $wpid = [uint32]0',
            '        [void][VoloBurst]::GetWindowThreadProcessId($h, [ref]$wpid)',
            '        if ($wpid -ne $uePidBurst) { return $true }',
            '        $wr = New-Object VoloBurst+RECT',
            '        [void][VoloBurst]::GetWindowRect($h, [ref]$wr)',
            '        if ((($wr.R - $wr.L) -lt 64) -or (($wr.B - $wr.T) -lt 64)) { return $true }',
            '        $script:burstHwnds.Add($h)',
            '        return $true',
            '    }',
            '    [void][VoloBurst]::EnumWindows($cb, [IntPtr]::Zero)',
            '    foreach ($h in $script:burstHwnds) {',
            '        $st = [VoloBurst]::GetWindowLong($h, -16)',
            '        $chrome = [int]0x00CF0000',
            '        # Strip chrome; keep/force visible under backdrop (A2'' — no SW_HIDE).',
            '        $ns = [int](($st -band (-bnot $chrome)) -bor [int]0x80000000 -bor [int]0x02000000 -bor [int]0x04000000 -bor [int]0x10000000)',
            '        if ($ns -ne $st) { [void][VoloBurst]::SetWindowLong($h, -16, $ns) }',
            '        $wr = New-Object VoloBurst+RECT',
            '        [void][VoloBurst]::GetWindowRect($h, [ref]$wr)',
            '        $onTarget = ($wr.L -ge $pinX) -and ($wr.T -ge $pinY) -and ($wr.R -le ($pinX + $pinW)) -and ($wr.B -le ($pinY + $pinH))',
            '        $sizeOk = (($wr.R - $wr.L) -eq $pinW) -and (($wr.B - $wr.T) -eq $pinH)',
            '        if ((-not $onTarget) -or (-not $sizeOk) -or (($st -band $chrome) -ne 0)) {',
            '            # HWND_NOTOPMOST + SHOW — stay under VoloBlackBackdrop.',
            '            [void][VoloBurst]::SetWindowPos($h, [IntPtr](-2), $pinX, $pinY, $pinW, $pinH, 0x0060)',
            '            [void][VoloBurst]::ShowWindow($h, 5)',
            '        }',
            '    }',
            '    Start-Sleep -Milliseconds 1',
            '}',
            '} else {',
            'Write-Output (''skip-overlay: skipping backdrop+pin+burst for PID={0}'' -f $p.Id)',
            # ethernet_barrier still needs the A3 promote: UE clamps -ResY to the
            # work area and never sets WS_EX_TOPMOST, so the TOPMOST taskbar keeps
            # a strip over the wall. FinisherOnly waits for render evidence +10s
            # (well past the barrier-sensitive first presents) then does ONE
            # SetWindowPos. Escape hatch: skip-finisher.flag.
            'if (-not (Test-Path -LiteralPath ''C:\ProgramData\UECM\ndisplay-output\session\skip-finisher.flag'')) {',
            ('$finArgs = ''-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "{0}" -UePid '' + $p.Id + '' -WinX '' + $pinX + '' -WinY '' + $pinY + '' -WinW '' + $pinW + '' -WinH '' + $pinH + '' -LogPath "{1}" -FinisherOnly''' -f $pinPathQ, $logPathQ),
            'Start-Process -FilePath ''powershell.exe'' -ArgumentList $finArgs -WindowStyle Hidden | Out-Null',
            '}',
            '}'
        )
        Set-Content -LiteralPath $launcherPath -Value $launcherLines -Encoding ASCII
        $taskName = "VoloOutput-$nodeId-$([guid]::NewGuid().ToString('N').Substring(0, 8))"
        $act = New-ScheduledTaskAction -Execute "powershell.exe" -Argument ('-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "{0}"' -f $launcherPath)
        $prn = New-ScheduledTaskPrincipal -UserId $consoleUser -LogonType Interactive -RunLevel Limited
        $set = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Hours 12) -AllowStartIfOnBatteries
        Register-ScheduledTask -TaskName $taskName -Action $act -Principal $prn -Settings $set -Force | Out-Null
        $t0 = Get-Date
        Start-ScheduledTask -TaskName $taskName
        $process = $null
        $deadline = (Get-Date).AddSeconds(90)
        $pollMs = 200
        while ((Get-Date) -lt $deadline) {
            Start-Sleep -Milliseconds $pollMs
            $pollMs = 300
            $process = Get-CimInstance Win32_Process -Filter "Name='UnrealEditor.exe'" |
                Where-Object {
                    $_.CommandLine -and
                    $_.CommandLine.IndexOf($project, [StringComparison]::OrdinalIgnoreCase) -ge 0 -and
                    $_.CreationDate -ge $t0.AddSeconds(-5)
                } |
                Select-Object -First 1
            if ($process) { break }
        }
        if (-not $process) {
            Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
            Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
            Clear-VoloOutputOverlay -ProjectDir $projectDir -NodeId $nodeId
            throw "UnrealEditor did not appear within 90s of task start (task instance stopped); log=$logPath"
        }
        Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
        Reply $true "launched PID=$($process.ProcessId); log=$logPath"
        exit 0
    }

    if ($action -eq "wait_evidence") {
        $project = [string]$request.project_path
        $nodeId = [string]$request.node_id
        $logDir = Join-Path (Split-Path -Parent $project) "Saved\Logs"
        $logPath = Join-Path $logDir "VoloOutput-$nodeId.log"
        # Create viewport manager is emitted only after the GameStart barrier has
        # passed. Keep older connection patterns as fallbacks for engine variants.
        $deadline = (Get-Date).AddSeconds(240)
        $evidence = $null
        $patterns = @(
            'LogDisplayClusterGame:.*Create viewport manager',
            'LogDisplayClusterCluster:.*(connected|connection established|joined|synchronization)',
            'LogDisplayClusterNetwork:.*(connected|connection established)',
            'LogDisplayClusterCluster:.*barrier.*(activated|synchronized)'
        )
        while ((Get-Date) -lt $deadline) {
            if (Test-Path -LiteralPath $logPath) {
                $match = Select-String -LiteralPath $logPath -Pattern $patterns -CaseSensitive:$false | Select-Object -Last 1
                if ($null -ne $match) { $evidence = $match.Line.Trim(); break }
            }
            $process = @(Get-CimInstance Win32_Process -Filter "Name='UnrealEditor.exe'" |
                Where-Object {
                    $_.CommandLine -and
                    $_.CommandLine.IndexOf($project, [StringComparison]::OrdinalIgnoreCase) -ge 0 -and
                    $_.CommandLine.IndexOf("-dc_node=$nodeId", [StringComparison]::OrdinalIgnoreCase) -ge 0
                }) | Select-Object -First 1
            if ($null -eq $process) { throw "UE exited before cluster render evidence; log=$logPath" }
            Start-Sleep -Milliseconds 500
        }
        if ($null -eq $evidence) { throw "timeout after 240s waiting for cluster render evidence; log=$logPath" }
        Reply $true "$evidence; log=$logPath" $true
        exit 0
    }

    if ($action -eq "wait_log") {
        $project = [string]$request.project_path
        $nodeId = [string]$request.node_id
        $pattern = [string]$request.pattern
        $timeoutSecs = [int]$request.timeout_secs
        if ([string]::IsNullOrWhiteSpace($pattern)) { throw "wait_log requires pattern" }
        if ($timeoutSecs -le 0) { $timeoutSecs = 60 }
        $logDir = Join-Path (Split-Path -Parent $project) "Saved\Logs"
        $logPath = Join-Path $logDir "VoloOutput-$nodeId.log"
        $deadline = (Get-Date).AddSeconds($timeoutSecs)
        $evidence = $null
        while ((Get-Date) -lt $deadline) {
            if (Test-Path -LiteralPath $logPath) {
                # Escape so callers can pass literal "VoloOutput: sequence done rev=N"
                $escaped = [regex]::Escape($pattern)
                $match = Select-String -LiteralPath $logPath -Pattern $escaped -CaseSensitive:$false |
                    Select-Object -Last 1
                if ($null -ne $match) { $evidence = $match.Line.Trim(); break }
            }
            Start-Sleep -Milliseconds 400
        }
        if ($null -eq $evidence) {
            throw "timeout after ${timeoutSecs}s waiting for log pattern '$pattern'; log=$logPath"
        }
        Reply $true "$evidence; log=$logPath"
        exit 0
    }

    if ($action -eq "stop") {
        $project = [string]$request.project_path
        $nodeId = [string]$request.node_id
        $projectDir = Split-Path -Parent $project
        # Always tear down Phase A overlay helpers first so stop/re-start never
        # leaves a residual black TOPMOST window on the LED wall.
        if (-not [string]::IsNullOrWhiteSpace($nodeId)) {
            Clear-VoloOutputOverlay -ProjectDir $projectDir -NodeId $nodeId
        }
        $processes = @(Get-CimInstance Win32_Process -Filter "Name='UnrealEditor.exe'" |
            Where-Object { $_.CommandLine -and $_.CommandLine.IndexOf($project, [StringComparison]::OrdinalIgnoreCase) -ge 0 })
        foreach ($process in $processes) { Stop-Process -Id $process.ProcessId -Force -ErrorAction Stop }
        # Second pass after UE death — pin may still be exiting.
        if (-not [string]::IsNullOrWhiteSpace($nodeId)) {
            Clear-VoloOutputOverlay -ProjectDir $projectDir -NodeId $nodeId
        }
        Reply $true "stopped $($processes.Count) matching UE process(es)"
        exit 0
    }

    if ($action -eq "publish") {
        Write-VoloUtf8FileAtomically -Destination ([string]$request.manifest_path) -Content ([string]$request.manifest_json)
        Reply $true "manifest atomically replaced"
        exit 0
    }

    throw "unsupported action: $action"
} catch {
    Reply $false $_.Exception.Message
    exit 1
}

# Reads installed Unreal Engine versions from registry.
# Designed to run as a node-pure script over SSH (JSON args via stdin),
# but also runnable standalone for local testing.
# Output: JSON array of { version, install_path }, e.g.
#   [{"version":"5.4","install_path":"C:\\Program Files\\Epic Games\\UE_5.4"}]

[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; chcp 65001 | Out-Null

$ErrorActionPreference = 'SilentlyContinue'

$results = @()

$keys = @(
    'HKLM:\SOFTWARE\EpicGames\Unreal Engine',
    'HKLM:\SOFTWARE\WOW6432Node\EpicGames\Unreal Engine'
)

foreach ($keyPath in $keys) {
    if (Test-Path $keyPath) {
        Get-ChildItem $keyPath | ForEach-Object {
            $version = $_.PSChildName
            $installedDir = (Get-ItemProperty $_.PSPath -Name 'InstalledDirectory' -ErrorAction SilentlyContinue).InstalledDirectory
            if ($installedDir) {
                # Reject Epic Games Launcher stub entries (e.g. WOW6432Node "4.0")
                # by requiring an actual editor binary on disk. UE 5.x ships
                # UnrealEditor.exe; UE 4.x ships UE4Editor.exe. Accept either -
                # presence of one proves this is a real engine install.
                $ue5Editor = Join-Path -Path $installedDir -ChildPath 'Engine\Binaries\Win64\UnrealEditor.exe'
                $ue4Editor = Join-Path -Path $installedDir -ChildPath 'Engine\Binaries\Win64\UE4Editor.exe'
                if ((Test-Path -LiteralPath $ue5Editor) -or (Test-Path -LiteralPath $ue4Editor)) {
                    $results += [PSCustomObject]@{
                        version = $version
                        install_path = $installedDir
                    }
                }
            }
        }
    }
}

# Deduplicate by (version, install_path). Wrap in @() so that an empty
# pipeline does not collapse to $null - `ConvertTo-Json @($null)` is not
# guaranteed to emit "[]" across PowerShell 5.x / 7.x, and a non-array
# payload makes the Rust side fail to deserialize as Vec<DetectedUe>,
# which would short-circuit refresh_machine before stale-row cleanup runs.
$results = @($results | Sort-Object version, install_path -Unique)

# Always emit valid JSON, even for empty
ConvertTo-Json -InputObject @($results) -Compress

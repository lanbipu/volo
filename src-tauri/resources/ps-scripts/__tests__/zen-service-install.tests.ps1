# Manual: run on a Windows box. Throws on failure, prints "OK".
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File zen-service-install.tests.ps1
#
# Unit-tests the pure `Resolve-ServiceExe` helper in zen-service-install.ps1 by
# dot-sourcing the script with UECM_PS_DEFINE_ONLY=1 (defines helpers, returns
# before reading stdin / touching the SCM).

$env:UECM_PS_DEFINE_ONLY = '1'
try {
    . "$PSScriptRoot\..\zen-service-install.ps1"
} finally {
    Remove-Item Env:\UECM_PS_DEFINE_ONLY -ErrorAction SilentlyContinue
}

function Assert-Exe($imagePath, $expected, $label) {
    $got = Resolve-ServiceExe $imagePath
    if ($got -ne $expected) {
        throw "[$label] expected exe '$expected' but got '$got' from ImagePath '$imagePath'"
    }
}

# Bug A (2026-06-05 lanPC E2E): zen writes the in-tree exe path UNQUOTED, and it
# contains spaces (D:\Program Files\Epic Games\...). The old token[0] whitespace
# split returned 'D:\Program', so Normalize-ZenExe produced 'd:\zenserver.exe'
# and every idempotent re-install / drift-repair falsely reported
# 'different ZenExePath'.
Assert-Exe `
    'D:\Program Files\Epic Games\UE_5.8\Engine\Binaries\Win64\zenserver.exe --data-dir F:\Epic\DDC\Zen --port 8558 --http asio' `
    'D:\Program Files\Epic Games\UE_5.8\Engine\Binaries\Win64\zenserver.exe' `
    'unquoted-with-spaces'

# Quoted exe path (what the script's own binpath-patch path writes).
Assert-Exe `
    '"D:\Program Files\Epic Games\UE_5.8\Engine\Binaries\Win64\zenserver.exe" --data-dir F:\Epic\DDC\Zen --port 8558 --http asio' `
    'D:\Program Files\Epic Games\UE_5.8\Engine\Binaries\Win64\zenserver.exe' `
    'quoted-with-spaces'

# Unquoted, no spaces (the user-private AppData install copy — prior layout that
# happened to tokenize fine).
Assert-Exe `
    'C:\Users\lanPC\AppData\Local\UnrealEngine\Common\Zen\Install\zenserver.exe --data-dir D:\ZenData' `
    'C:\Users\lanPC\AppData\Local\UnrealEngine\Common\Zen\Install\zenserver.exe' `
    'unquoted-no-spaces'

# A parent directory literally containing '.exe' must not truncate the binary
# (anchor the match on the FIRST '.exe' followed by whitespace / end).
Assert-Exe `
    'D:\weird.exe\Win64\zenserver.exe --port 8558' `
    'D:\weird.exe\Win64\zenserver.exe' `
    'dir-with-dot-exe'

# Bare exe with no trailing args.
Assert-Exe `
    'D:\Program Files\Epic Games\UE_5.8\Engine\Binaries\Win64\zenserver.exe' `
    'D:\Program Files\Epic Games\UE_5.8\Engine\Binaries\Win64\zenserver.exe' `
    'bare-no-args'

function Assert-Patched($curImagePath, $dataDir, $port, $http, $expected, $label) {
    $got = Build-PatchedImagePath $curImagePath $dataDir $port $http
    if ($got -ne $expected) {
        throw "[$label] expected '$expected' but got '$got'"
    }
}

# Bug 1 repair reconstruction (2026-06-05 lanPC E2E): the drifted ImagePath has
# the exe UNQUOTED with spaces and is missing --port/--http. Rebuild it with the
# exe re-quoted and the runtime args restored. The old code did
# `$curBin.TrimStart('"').Split('"')[0]` which returned the WHOLE string for an
# unquoted path, so GetFullPath threw "path format not supported".
Assert-Patched `
    'D:\Program Files\Epic Games\UE_5.8\Engine\Binaries\Win64\zenserver.exe --data-dir F:\Epic\DDC\Zen' `
    'F:\Epic\DDC\Zen' '8558' 'asio' `
    '"D:\Program Files\Epic Games\UE_5.8\Engine\Binaries\Win64\zenserver.exe" --data-dir "F:\Epic\DDC\Zen" --port 8558 --http asio' `
    'repair-unquoted-drift'

# Already-quoted exe input rebuilds the same way.
Assert-Patched `
    '"C:\Users\lanPC\AppData\Local\UnrealEngine\Common\Zen\Install\zenserver.exe" --data-dir D:\ZenData' `
    'D:\ZenData' '8558' 'asio' `
    '"C:\Users\lanPC\AppData\Local\UnrealEngine\Common\Zen\Install\zenserver.exe" --data-dir "D:\ZenData" --port 8558 --http asio' `
    'repair-quoted'

"OK"

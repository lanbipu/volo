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
    'D:\Program Files\Epic Games\UE_5.8\Engine\Binaries\Win64\zenserver.exe --config="D:\ZenData\zen_config.lua"' `
    'D:\Program Files\Epic Games\UE_5.8\Engine\Binaries\Win64\zenserver.exe' `
    'unquoted-with-spaces'

# Quoted exe path (what the script's own binpath-patch path writes).
Assert-Exe `
    '"D:\Program Files\Epic Games\UE_5.8\Engine\Binaries\Win64\zenserver.exe" --config="D:\ZenData\zen_config.lua"' `
    'D:\Program Files\Epic Games\UE_5.8\Engine\Binaries\Win64\zenserver.exe' `
    'quoted-with-spaces'

# Unquoted, no spaces (the user-private AppData install copy — prior layout that
# happened to tokenize fine).
Assert-Exe `
    'C:\Users\lanPC\AppData\Local\UnrealEngine\Common\Zen\Install\zenserver.exe --config="D:\ZenData\zen_config.lua"' `
    'C:\Users\lanPC\AppData\Local\UnrealEngine\Common\Zen\Install\zenserver.exe' `
    'unquoted-no-spaces'

# A parent directory literally containing '.exe' must not truncate the binary
# (anchor the match on the FIRST '.exe' followed by whitespace / end).
Assert-Exe `
    'D:\weird.exe\Win64\zenserver.exe --config="D:\ZenData\zen_config.lua"' `
    'D:\weird.exe\Win64\zenserver.exe' `
    'dir-with-dot-exe'

# Bare exe with no trailing args.
Assert-Exe `
    'D:\Program Files\Epic Games\UE_5.8\Engine\Binaries\Win64\zenserver.exe' `
    'D:\Program Files\Epic Games\UE_5.8\Engine\Binaries\Win64\zenserver.exe' `
    'bare-no-args'

# --- Build-ZenImagePath: canonical ImagePath with runtime flags ---------------
# zen 5.8 doesn't read port/data-dir/http/gc from zen_config.lua (verified
# 2026-07-02, see zen-service-install.ps1 header) — they must ride the
# command line. Exe UNQUOTED-with-spaces input gets re-quoted (Bug 1 lineage).
function Assert-Built($args_, $expected, $label) {
    $got = Build-ZenImagePath @args_
    if ($got -ne $expected) {
        throw "[$label] expected '$expected' but got '$got'"
    }
}

Assert-Built `
    @('D:\Program Files\Epic Games\UE_5.8\Engine\Binaries\Win64\zenserver.exe',
      'F:\Epic\DDC\Zen\zen_config.lua', '8558', 'D:\ZenData', 'httpsys', '', '', '') `
    ('"D:\Program Files\Epic Games\UE_5.8\Engine\Binaries\Win64\zenserver.exe"' +
     ' --config="F:\Epic\DDC\Zen\zen_config.lua" --port 8558 --data-dir "D:\ZenData" --http httpsys') `
    'build-no-gc'

Assert-Built `
    @('C:\Users\lanPC\AppData\Local\UnrealEngine\Common\Zen\Install\zenserver.exe',
      'D:\ZenData\zen_config.lua', '8558', 'D:\ZenData', 'asio', '21600', '3600', '1209600') `
    ('"C:\Users\lanPC\AppData\Local\UnrealEngine\Common\Zen\Install\zenserver.exe"' +
     ' --config="D:\ZenData\zen_config.lua" --port 8558 --data-dir "D:\ZenData" --http asio' +
     ' --gc-interval-seconds 21600 --gc-lightweight-interval-seconds 3600 --gc-cache-duration-seconds 1209600') `
    'build-with-gc'

# --- Get-ZenImagePathArgs: parse runtime args back out of an ImagePath --------
function Assert-ParsedField($imagePath, $field, $expected, $label) {
    $got = (Get-ZenImagePathArgs $imagePath)[$field]
    if ($got -ne $expected) {
        throw "[$label] field '$field': expected '$expected' but got '$got'"
    }
}

# Round-trip: what Build-ZenImagePath emits must parse back field-for-field.
$rt = Build-ZenImagePath 'D:\Program Files\Epic Games\UE_5.8\Engine\Binaries\Win64\zenserver.exe' `
    'D:\ZenData\zen_config.lua' '8558' 'D:\ZenData' 'httpsys' '21600' '' '1209600'
Assert-ParsedField $rt 'config' 'D:\ZenData\zen_config.lua' 'roundtrip-config'
Assert-ParsedField $rt 'port' '8558' 'roundtrip-port'
Assert-ParsedField $rt 'datadir' 'D:\ZenData' 'roundtrip-datadir'
Assert-ParsedField $rt 'http' 'httpsys' 'roundtrip-http'
Assert-ParsedField $rt 'gcinterval' '21600' 'roundtrip-gcinterval'
Assert-ParsedField $rt 'gclightweight' $null 'roundtrip-gclightweight-absent'
Assert-ParsedField $rt 'gcduration' '1209600' 'roundtrip-gcduration'

# Hand-edited `=`-form values must parse too (defense-in-depth).
Assert-ParsedField 'c:\zen\zenserver.exe --config=C:\ZenServer\zen_config.lua --port=8559 --data-dir=D:\ZenData --http=asio' `
    'port' '8559' 'eq-form-port'
Assert-ParsedField 'c:\zen\zenserver.exe --config=C:\ZenServer\zen_config.lua --port=8559 --data-dir=D:\ZenData --http=asio' `
    'datadir' 'D:\ZenData' 'eq-form-datadir'

# A config-only legacy ImagePath (the 2026-07-01..02 broken form) parses with
# all runtime fields absent — the field-compare then reports drift and the
# install path patches it to the flags form.
Assert-ParsedField '"c:\zenserver\zenserver.exe" --config="C:\ZenServer\zen_config.lua"' `
    'config' 'C:\ZenServer\zen_config.lua' 'legacy-config'
Assert-ParsedField '"c:\zenserver\zenserver.exe" --config="C:\ZenServer\zen_config.lua"' `
    'port' $null 'legacy-port-absent'

"OK"

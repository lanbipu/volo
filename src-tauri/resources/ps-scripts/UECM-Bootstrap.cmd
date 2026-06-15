@echo off
REM UECM SSH Bootstrap -- one-click entry point.
REM Double-click this file. If not running elevated, it relaunches itself
REM with UAC; once elevated it runs enable-ssh.ps1 with all the switches UECM
REM expects (OpenSSH + authorize uecm.pub + node prep + PsExec64).

REM Admin check via fltmc.exe -- native Windows tool that needs admin token but
REM does NOT depend on the Server / LanmanServer service. (NET SESSION would
REM falsely report non-zero when LanmanServer is stopped, which is exactly the
REM state -EnableSmbServer is meant to fix -> that would cause an infinite UAC
REM relaunch loop.)
fltmc >nul 2>&1
if %errorlevel% NEQ 0 (
    echo Requesting administrator privileges...
    powershell.exe -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
    exit /b
)

REM Force UTF-8 console so the PowerShell script's JSON / Chinese log lines render correctly.
chcp 65001 >nul

setlocal
set "SCRIPT_DIR=%~dp0"

REM ====== UECM local admin account (required for remote management) ======
REM  To let UECM manage this machine over SSH, it needs a local admin account
REM  it can log in as (always uecm-svc). Put a strong password below (leave
REM  empty = only enable SSH/SMB/WMI, do NOT create an account).
REM  Afterwards, register the SAME uecm-svc password as a credential in UECM.
REM  Avoid % " ^ in the password (cmd parsing); letters + digits are safest.
set "UECM_LOCAL_ADMIN=uecm-svc"
set "UECM_LOCAL_ADMIN_PASSWORD=UecmRender@2026"
REM =======================================================================

REM The SSH service account is ALWAYS uecm-svc (SshExecutor logs in as uecm-svc).
REM Hardcode it so enable-ssh.ps1 (which rejects any other name) never gets a
REM mismatched account.
set "SSH_ADMIN_ARGS="
if not "%UECM_LOCAL_ADMIN_PASSWORD%"=="" set SSH_ADMIN_ARGS=-CreateLocalAdmin -LocalAdminName "uecm-svc" -LocalAdminPassword "%UECM_LOCAL_ADMIN_PASSWORD%"

REM ====== SSH transport onboarding (the UECM transport) ======
REM machine refresh / env / ini / zen all connect over SSH, so SSH onboarding is
REM required: a missing uecm.pub or a failed enable-ssh.ps1 must fail the bootstrap.
REM Capture the exit code at top level so %ERRORLEVEL% expands AFTER the run
REM (setting it inside an if-block hits the delayed-expansion trap).
set "SSH_PS1=%SCRIPT_DIR%enable-ssh.ps1"
set "STAGING_DIR=%SCRIPT_DIR:~0,-1%"
set "UECM_PUB=%SCRIPT_DIR%uecm.pub"
set "SSH_EXIT=0"
if not exist "%SSH_PS1%" set "SSH_EXIT=9"
if not exist "%UECM_PUB%" set "SSH_EXIT=9"
if not "%SSH_EXIT%"=="0" goto ssh_done
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%SSH_PS1%" -PublicKeyPath "%UECM_PUB%" -StagingSourceDir "%STAGING_DIR%" -EnableSmbServer -EnableWmi -EnableLongPaths -PowerProfile HighPerformance -SetExecutionPolicy RemoteSigned %SSH_ADMIN_ARGS%
set "SSH_EXIT=%ERRORLEVEL%"
:ssh_done

set "OVERALL=0"
if not "%SSH_EXIT%"=="0" set "OVERALL=1"

echo.
if "%OVERALL%"=="0" (
    echo ================================================================
    echo.
    echo     [ OK ]  UECM bootstrap SUCCEEDED - this machine is ready.
    echo.
    echo     The JSON above is machine-readable status; you can ignore it.
    echo     If a password was set, register the same uecm-svc credential
    echo     in UECM on the operator side.
    echo.
    echo ================================================================
) else (
    echo ================================================================
    echo.
    echo     [ FAILED ]  UECM bootstrap did not complete.
    echo     SSH onboarding exit %SSH_EXIT%.
    echo     SSH_EXIT=9 means enable-ssh.ps1 or uecm.pub was missing next to this .cmd.
    echo     Check the JSON 'message' / 'missing_critical' fields above.
    echo.
    echo ================================================================
)
echo.
REM Auto-close so unattended / scripted runs don't hang on a key press.
REM A real key press still closes it immediately; no /nobreak on purpose.
REM 2>nul: if stdin is redirected (non-interactive) timeout errors out and we
REM just fall through to exit instead of blocking like pause did.
echo This window auto-closes in 20s. Press any key to close now...
timeout /t 20 >nul 2>nul
exit /b %OVERALL%

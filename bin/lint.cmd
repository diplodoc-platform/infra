@echo off
setlocal
set SCRIPT_DIR=%~dp0
set SCRIPT_PATH=%SCRIPT_DIR%lint
REM Try to find bash in common locations or PATH
if exist "C:\Program Files\Git\bin\bash.exe" (
    "C:\Program Files\Git\bin\bash.exe" "%SCRIPT_PATH%" %*
) else if exist "C:\Program Files (x86)\Git\bin\bash.exe" (
    "C:\Program Files (x86)\Git\bin\bash.exe" "%SCRIPT_PATH%" %*
) else (
    where bash >nul 2>&1
    if %ERRORLEVEL% EQU 0 (
        bash "%SCRIPT_PATH%" %*
    ) else (
        REM Fallback: try sh (which might be available via Git or WSL)
        where sh >nul 2>&1
        if %ERRORLEVEL% EQU 0 (
            sh "%SCRIPT_PATH%" %*
        ) else (
            echo Error: bash or sh not found. Please install Git Bash or ensure bash/sh is in PATH.
            exit /b 1
        )
    )
)


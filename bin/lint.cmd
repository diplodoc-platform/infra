@echo off
setlocal
REM Get the directory where this .cmd file is located
set CMD_DIR=%~dp0
REM Resolve the path to the actual lint script
REM npm creates wrapper in node_modules/.bin/, so we need to go up and find the package
set SCRIPT_PATH=%CMD_DIR%..\@diplodoc\lint\bin\lint
REM Normalize path separators
set SCRIPT_PATH=%SCRIPT_PATH:\=/%
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


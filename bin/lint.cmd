@echo off
setlocal
set SCRIPT_DIR=%~dp0
set SCRIPT_PATH=%SCRIPT_DIR%lint
if exist "C:\Program Files\Git\bin\bash.exe" (
    "C:\Program Files\Git\bin\bash.exe" "%SCRIPT_PATH%" %*
) else if exist "C:\Program Files (x86)\Git\bin\bash.exe" (
    "C:\Program Files (x86)\Git\bin\bash.exe" "%SCRIPT_PATH%" %*
) else (
    where bash >nul 2>&1
    if %ERRORLEVEL% EQU 0 (
        bash "%SCRIPT_PATH%" %*
    ) else (
        echo Error: bash not found. Please install Git Bash or ensure bash is in PATH.
        exit /b 1
    )
)


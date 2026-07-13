@echo off
REM ---------------------------------------------------------------------------
REM run-ghidra.cmd — Windows launcher for the GhidraMCP Python bridge
REM ---------------------------------------------------------------------------
setlocal enabledelayedexpansion

set "SCRIPT_DIR=%~dp0"
set "BRIDGE_SCRIPT=%SCRIPT_DIR%bridge_mcp_ghidra.py"
set "VENV_DIR=%SCRIPT_DIR%.venv-ghidra"

if not exist "%BRIDGE_SCRIPT%" (
    echo Error: bridge script not found at %BRIDGE_SCRIPT% >&2
    exit /b 1
)

if not exist "%VENV_DIR%\Scripts\python.exe" (
    echo [mcp-ghidra] Setting up Python venv... >&2

    REM Find python3 or python
    set "PY="
    for %%p in (python3 python) do (
        where %%p >nul 2>&1 && set "PY=%%p" && goto :found_py
    )
    echo Error: No Python found. Install Python 3.10+ and try again. >&2
    exit /b 1
    :found_py

    "!PY!" -m venv "%VENV_DIR%"

    echo [mcp-ghidra] Installing mcp package... >&2
    "%VENV_DIR%\Scripts\pip" install --quiet "mcp>=1.2.0,<2"
    echo [mcp-ghidra] Ready. >&2
)

"%VENV_DIR%\Scripts\python" "%BRIDGE_SCRIPT%" %*
exit /b %ERRORLEVEL%

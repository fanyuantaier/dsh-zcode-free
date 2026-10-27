@echo off
rem Start the ZCode free-quota bridge (OpenAI-compatible, 127.0.0.1:11451).
rem node.exe is auto-detected: common install locations, then PATH.
setlocal EnableDelayedExpansion
cd /d "%~dp0"
set "NODE_EXE="
if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
if exist "%ProgramFiles(x86)%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles(x86)%\nodejs\node.exe"
if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE_EXE=%LOCALAPPDATA%\Programs\nodejs\node.exe"
if exist "%APPDATA%\npm\node.exe" set "NODE_EXE=%APPDATA%\npm\node.exe"
if exist "%LOCALAPPDATA%\pnpm\node.exe" set "NODE_EXE=%LOCALAPPDATA%\pnpm\node.exe"
if not defined NODE_EXE for /f "usebackq delims=" %%N in (`where node.exe 2^>nul`) do if not defined NODE_EXE set "NODE_EXE=%%N"
if not defined NODE_EXE (
  echo dsh-zcode-free: cannot find node.exe. Checked PATH and common install locations.
  echo Install Node.js or add it to PATH, then re-run.
  exit /b 2
)
echo dsh-zcode-free using !NODE_EXE!
"!NODE_EXE!" "bin\zcode-free-serve.mjs" --port 11451 --log all
endlocal

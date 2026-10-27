# Start the ZCode free-quota bridge (OpenAI-compatible, 127.0.0.1:11451).
# node.exe is auto-detected: PATH first, then common install locations.
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $here

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) {
  $pf86 = "$env:ProgramFiles (x86)"
  $candidates = @(
    (Join-Path (Join-Path $env:ProgramFiles 'nodejs') 'node.exe'),
    (Join-Path (Join-Path $pf86 'nodejs') 'node.exe'),
    (Join-Path (Join-Path (Join-Path $env:LOCALAPPDATA 'Programs') 'nodejs') 'node.exe'),
    (Join-Path (Join-Path $env:APPDATA 'npm') 'node.exe'),
    (Join-Path (Join-Path $env:LOCALAPPDATA 'pnpm') 'node.exe')
  )
  foreach ($candidate in $candidates) {
    if ($candidate -and (Test-Path $candidate)) { $node = $candidate; break }
  }
}
if (-not $node) {
  Write-Error 'dsh-zcode-free: cannot find node.exe. Checked PATH and common install locations. Install Node.js or add it to PATH, then re-run.'
  exit 2
}
Write-Host ('dsh-zcode-free using ' + $node)
& $node 'bin/zcode-free-serve.mjs' --port 11451 --log all

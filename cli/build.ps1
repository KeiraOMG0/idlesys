# Build idlesys.exe via PyInstaller
# Run from the cli/ directory:  .\build.ps1
#
# Uses the local venv if present (preferred), else falls back to PyManager Python.
# To set up venv from scratch:
#   python -m venv venv
#   venv\Scripts\pip install -r requirements.txt

$ErrorActionPreference = "Stop"

$VENV_PY = ".\venv\Scripts\python.exe"
$SYS_PY  = "C:\Program Files\PyManager\python.exe"

if (Test-Path $VENV_PY) {
    $PY = $VENV_PY
    Write-Host "Using venv Python: $VENV_PY"
} elseif (Test-Path $SYS_PY) {
    $PY = $SYS_PY
    Write-Host "Venv not found - using system Python: $SYS_PY"
    Write-Host "Installing dependencies..."
    & $PY -m pip install -r requirements.txt --quiet
} else {
    $PY = "python"
    Write-Host "Falling back to PATH python"
    & $PY -m pip install -r requirements.txt --quiet
}

Write-Host "Building idlesys.exe..."
& $PY -m PyInstaller `
    --onefile `
    --name idlesys `
    --console `
    --clean `
    idlesys_cli.py

if (Test-Path dist\idlesys.exe) {
    $size = [math]::Round((Get-Item dist\idlesys.exe).Length / 1MB, 1)
    Write-Host ""
    Write-Host "Done: dist\idlesys.exe  ($($size) MB)"
    $destDir = "..\dist"
    if (-not (Test-Path $destDir)) { New-Item -ItemType Directory -Force $destDir | Out-Null }
    Copy-Item -Force dist\idlesys.exe "$destDir\idlesys.exe"
    Write-Host "Copied to $destDir\idlesys.exe"
    Write-Host "Run /admin release in Discord to post."
} else {
    Write-Error "Build failed - dist\idlesys.exe not found"
}

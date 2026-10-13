$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$python = Join-Path $projectRoot "venv\Scripts\python.exe"
$iscc = Get-Command "ISCC.exe" -ErrorAction SilentlyContinue

if (-not (Test-Path $python)) {
    throw "Python environment not found. Create venv and install requirements-packaging.txt first."
}
if (-not $iscc) {
    throw "Inno Setup 6 is required to create the Windows installer. Install it and ensure ISCC.exe is on PATH."
}

Push-Location $projectRoot
try {
    & $python -m PyInstaller --noconfirm --clean packaging\StockNSales.spec
    if ($LASTEXITCODE -ne 0) {
        throw "PyInstaller failed with exit code $LASTEXITCODE."
    }

    & $iscc.Source packaging\windows.iss
    if ($LASTEXITCODE -ne 0) {
        throw "Inno Setup failed with exit code $LASTEXITCODE."
    }
} finally {
    Pop-Location
}

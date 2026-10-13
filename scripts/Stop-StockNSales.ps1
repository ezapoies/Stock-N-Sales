$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$stateDirectory = Join-Path $env:LOCALAPPDATA "StockNSales"
$stoppedProcesses = @()

foreach ($name in @("frontend", "backend")) {
    $pidPath = Join-Path $stateDirectory "$name.pid"
    if (-not (Test-Path $pidPath)) {
        continue
    }

    $processId = 0
    $validId = [int]::TryParse(
        (Get-Content $pidPath -Raw).Trim(),
        [ref]$processId
    )

    if ($validId) {
        $process = Get-CimInstance Win32_Process `
            -Filter "ProcessId = $processId" `
            -ErrorAction SilentlyContinue

        if (
            $process -and
            $process.CommandLine -and
            $process.CommandLine.Contains($projectRoot)
        ) {
            Stop-Process -Id $processId -ErrorAction SilentlyContinue
            $stoppedProcesses += $name
        }
    }

    Remove-Item -LiteralPath $pidPath -Force
}

Add-Type -AssemblyName System.Windows.Forms
if ($stoppedProcesses.Count -gt 0) {
    $message = "Stopped: " + ($stoppedProcesses -join " and ") + "."
} else {
    $message = "No Stock N Sales processes started by the launcher were running."
}

[System.Windows.Forms.MessageBox]::Show(
    $message,
    "Stock N Sales",
    [System.Windows.Forms.MessageBoxButtons]::OK,
    [System.Windows.Forms.MessageBoxIcon]::Information
) | Out-Null

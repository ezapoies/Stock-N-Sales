$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$python = Join-Path $projectRoot "venv\Scripts\python.exe"
$backendScript = Join-Path $projectRoot "backend\app.py"
$stateDirectory = Join-Path $env:LOCALAPPDATA "StockNSales"
$frontendUrl = "http://127.0.0.1:5500"
$backendUrl = "http://127.0.0.1:5000/api/test"
$startedProcesses = @()

New-Item -ItemType Directory -Path $stateDirectory -Force | Out-Null

function Test-PortInUse([int]$Port) {
    $listener = New-Object System.Net.Sockets.TcpClient
    try {
        $pending = $listener.BeginConnect("127.0.0.1", $Port, $null, $null)
        return $pending.AsyncWaitHandle.WaitOne(250) -and $listener.Connected
    } catch {
        return $false
    } finally {
        $listener.Close()
    }
}

function Test-BackendReady {
    try {
        $result = Invoke-RestMethod -Uri $backendUrl -TimeoutSec 2
        return $result.backend -eq "working" -and $result.database -eq "connected"
    } catch {
        return $false
    }
}

function Test-FrontendReady {
    try {
        $result = Invoke-WebRequest -Uri $frontendUrl -UseBasicParsing -TimeoutSec 2
        return $result.StatusCode -eq 200 -and $result.Content.Contains("Stock N Sales")
    } catch {
        return $false
    }
}

function Start-AppProcess(
    [string]$Name,
    [string]$Executable,
    [string[]]$Arguments
) {
    $stdout = Join-Path $stateDirectory "$Name.log"
    $stderr = Join-Path $stateDirectory "$Name-error.log"
    $process = Start-Process `
        -FilePath $Executable `
        -ArgumentList $Arguments `
        -WorkingDirectory $projectRoot `
        -WindowStyle Hidden `
        -RedirectStandardOutput $stdout `
        -RedirectStandardError $stderr `
        -PassThru

    $pidPath = Join-Path $stateDirectory "$Name.pid"
    Set-Content -Path $pidPath -Value $process.Id
    $script:startedProcesses += [PSCustomObject]@{
        Name = $Name
        Id = $process.Id
        PidPath = $pidPath
    }
    return $process
}

function Show-StartupError([string]$Message) {
    $logPath = Join-Path $stateDirectory "backend-error.log"
    if (Test-Path $logPath) {
        $details = Get-Content $logPath -Tail 12 -ErrorAction SilentlyContinue
        if ($details) {
            $Message += "`r`n`r`nBackend details:`r`n" + ($details -join "`r`n")
        }
    }

    Add-Type -AssemblyName System.Windows.Forms
    [System.Windows.Forms.MessageBox]::Show(
        $Message,
        "Stock N Sales",
        [System.Windows.Forms.MessageBoxButtons]::OK,
        [System.Windows.Forms.MessageBoxIcon]::Error
    ) | Out-Null
}

try {
    if (-not (Test-Path $python)) {
        throw "The project Python environment was not found. Expected:`r`n$python"
    }

    if (-not (Test-BackendReady)) {
        if (Test-PortInUse 5000) {
            throw "Port 5000 is already in use by another app. Close that app and try again."
        }

        $backendArguments = @("-u", ('"{0}"' -f $backendScript))
        $null = Start-AppProcess "backend" $python $backendArguments
    }

    if (-not (Test-FrontendReady)) {
        if (Test-PortInUse 5500) {
            throw "Port 5500 is already in use by another app. Close that app and try again."
        }

        $null = Start-AppProcess "frontend" $python @(
            "-m", "http.server", "5500",
            "--bind", "127.0.0.1",
            "--directory", ('"{0}"' -f $projectRoot)
        )
    }

    $deadline = (Get-Date).AddSeconds(60)
    do {
        $backendReady = Test-BackendReady
        $frontendReady = Test-FrontendReady
        if ($backendReady -and $frontendReady) {
            Start-Process $frontendUrl
            exit 0
        }

        foreach ($processInfo in $startedProcesses) {
            $process = Get-Process -Id $processInfo.Id -ErrorAction SilentlyContinue
            if (-not $process) {
                throw "$($processInfo.Name) stopped during startup. Check its logs in:`r`n$stateDirectory"
            }
        }

        Start-Sleep -Milliseconds 500
    } while ((Get-Date) -lt $deadline)

    throw "The app did not finish starting. Check the logs in:`r`n$stateDirectory"
} catch {
    foreach ($processInfo in $startedProcesses) {
        Stop-Process -Id $processInfo.Id -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $processInfo.PidPath -Force -ErrorAction SilentlyContinue
    }

    Show-StartupError $_.Exception.Message
    exit 1
}

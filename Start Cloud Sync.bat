@echo off
setlocal

set "PROJECT_DIR=%~dp0"
set "ENV_FILE=%PROJECT_DIR%.env"
set "VENV_PYTHON=%PROJECT_DIR%venv\Scripts\python.exe"

if not exist "%ENV_FILE%" (
    echo Missing .env file in:
    echo %PROJECT_DIR%
    echo Configure MONGO_URI and a persistent SECRET_KEY before starting cloud sync.
    pause
    exit /b 1
)

if not exist "%VENV_PYTHON%" (
    where.exe python >nul 2>&1
    if errorlevel 1 (
        echo Python was not found. Install Python or create the project's venv.
        pause
        exit /b 1
    )
    set "PYTHON=python"
) else (
    set "PYTHON=%VENV_PYTHON%"
)

where.exe cloudflared >nul 2>&1
if errorlevel 1 (
    echo cloudflared was not found on PATH.
    echo Install cloudflared, then run this file again.
    pause
    exit /b 1
)

call :port_open 5000
if not errorlevel 1 goto backend_ready

echo Starting the Flask backend...
start "Stock N Sales cloud sync - backend" /D "%PROJECT_DIR%" "%PYTHON%" -u -m backend.app

set /a attempts=0
:wait_backend
timeout /t 1 /nobreak >nul
call :port_open 5000
if not errorlevel 1 goto backend_ready
set /a attempts+=1
if %attempts% lss 30 goto wait_backend

echo The backend did not start listening on port 5000.
echo Check the backend window for errors, including missing MONGO_URI or dependencies.
pause
exit /b 1

:backend_ready
echo Backend is listening at http://127.0.0.1:5000
echo Starting the temporary Cloudflare HTTPS tunnel...
start "Stock N Sales cloud sync - Cloudflare tunnel" /D "%PROJECT_DIR%" cloudflared tunnel --url http://127.0.0.1:5000
echo.
echo Copy the https://...trycloudflare.com URL shown in the tunnel window
echo into the phone app's Connect cloud screen. Do not add /api.
echo Keep both windows open while syncing.
pause
exit /b 0

:port_open
powershell.exe -NoProfile -Command "$client = New-Object System.Net.Sockets.TcpClient; try { $client.Connect('127.0.0.1', %~1); exit 0 } catch { exit 1 } finally { $client.Dispose() }" >nul 2>&1
exit /b %errorlevel%

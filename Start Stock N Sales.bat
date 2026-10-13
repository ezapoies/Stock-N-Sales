@echo off
set "LAUNCHER=%~dp0scripts\Start-StockNSales.ps1"
powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%LAUNCHER%"

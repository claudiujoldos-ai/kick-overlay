@echo off
chcp 65001 >nul
title LiveLayer
cd /d "%~dp0"

if not exist "package.json" (
  echo [EROARE] Nu gasesc fisierele aplicatiei.
  echo Dezarhiveaza mai intai ZIP-ul: click dreapta pe kick-overlay.zip - Extract All / Extrage tot,
  echo apoi porneste Porneste.bat din folderul dezarhivat.
  echo.
  pause
  exit /b
)

where node >nul 2>nul
if errorlevel 1 goto nonode
where npm >nul 2>nul
if errorlevel 1 goto nonode

echo Node.js gasit:
node -v
echo.

if exist "node_modules\electron-updater" goto start
echo Prima pornire: instalez componentele, dureaza 1-3 minute...
call npm install
if errorlevel 1 (
  echo.
  echo [EROARE] Instalarea a esuat. Fa o poza la mesajele de mai sus si trimite-mi-o.
  pause
  exit /b
)

:start
echo Inchid orice copie veche a aplicatiei ramasa pornita...
taskkill /F /IM electron.exe >nul 2>nul
taskkill /F /IM "Kick Overlay.exe" >nul 2>nul
taskkill /F /IM "LiveLayer.exe" >nul 2>nul
timeout /t 1 /nobreak >nul
echo Pornesc LiveLayer... Fereastra aceasta poate ramane deschisa sau minimizata.
call npm start
echo.
echo Aplicatia s-a inchis.
pause
exit /b

:nonode
echo [EROARE] Node.js nu este instalat sau nu este gasit.
echo 1. Descarca Node.js LTS de pe https://nodejs.org si instaleaza-l.
echo 2. Reporneste calculatorul sau macar inchide si redeschide folderul.
echo 3. Porneste din nou Porneste.bat.
echo.
pause
exit /b

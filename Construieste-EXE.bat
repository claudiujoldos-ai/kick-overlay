@echo off
chcp 65001 >nul
title LiveLayer - construiesc EXE

rem Construirea .exe are nevoie de drepturi de administrator (altfel: "Cannot create symbolic link")
net session >nul 2>&1
if errorlevel 1 (
  echo Cer drepturi de administrator... apasa "Da" in fereastra Windows.
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)

cd /d "%~dp0"

where npm >nul 2>nul
if errorlevel 1 (
  echo [EROARE] Node.js nu este instalat. Descarca-l de pe https://nodejs.org si incearca din nou.
  pause
  exit /b
)

rem Datele aplicatiei Kick: daca le-ai introdus din aplicatie, le iau de acolo
if not exist "google-app.json" if exist "%APPDATA%\kick-overlay\google-app.json" copy /Y "%APPDATA%\kick-overlay\google-app.json" "google-app.json" >nul
if not exist "kick-app.json" if exist "%APPDATA%\kick-overlay\kick-app.json" copy /Y "%APPDATA%\kick-overlay\kick-app.json" "kick-app.json" >nul
if not exist "kick-app.json" (
  echo [ATENTIE] Nu am gasit datele aplicatiei Kick ^(kick-app.json^).
  echo Fara ele, fiecare om care descarca aplicatia va trebui sa-si inregistreze singur aplicatia la Kick.
  echo Ca sa le incluzi: porneste aplicatia, completeaza pasii de la Conexiune, apoi ruleaza din nou acest fisier.
  echo.
  choice /C DN /M "Continui oricum"
  if errorlevel 2 exit /b
)

echo ================================================
echo   Pasul 1/2: instalez componentele...
echo ================================================
call npm install
if errorlevel 1 goto fail

echo.
echo ================================================
echo   Pasul 2/2: construiesc installer-ul .exe...
echo   (prima data dureaza cateva minute)
echo ================================================
call npm run dist
if errorlevel 1 goto fail

echo.
echo ================================================
echo   GATA! Fisierele sunt in folderul "dist":
echo     - LiveLayer-Setup-X.X.X.exe   (installer-ul)
echo     - LiveLayer-Setup-X.X.X.exe.blockmap
echo     - latest.yml
echo   Pe GitHub urci TOATE cele 3 fisiere.
echo ================================================
start "" "%~dp0dist"
pause
exit /b

:fail
echo.
echo [EROARE] Ceva nu a mers.
echo Daca vezi "Cannot create symbolic link": inchide fereastra,
echo click dreapta pe Construieste-EXE.bat - "Run as administrator" si incearca din nou.
echo Altfel, fa o poza la mesajele de mai sus si trimite-mi-o.
pause

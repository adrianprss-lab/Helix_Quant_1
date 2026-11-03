@echo off
chcp 65001 >nul
title HELIX QUANT Bridge
cd /d "%~dp0"
set "PY=python"
where python >nul 2>&1
if errorlevel 1 (
  where py >nul 2>&1
  if errorlevel 1 (
    echo.
    echo   [FEHLER] Python nicht gefunden.
    echo   Installieren: https://www.python.org/downloads/
    echo   WICHTIG: Haken bei "Add python.exe to PATH" setzen.
    echo.
    pause
    exit /b 1
  )
  set "PY=py -3"
)

:menu
cls
echo.
echo   ==============================================
echo     HELIX QUANT  ·  Bridge Steuerung
echo   ==============================================
echo     [1] Bridge starten
echo     [2] Server-URL aendern
echo     [3] Selbsttest (verbindet nichts)
echo     [4] Bridge-Code vom Server aktualisieren
echo     [5] Beenden
echo   ==============================================
set "choice="
set /p choice="  Auswahl: "
if "%choice%"=="1" goto start
if "%choice%"=="2" goto seturl
if "%choice%"=="3" goto test
if "%choice%"=="4" goto update
if "%choice%"=="5" exit /b 0
goto menu

:seturl
echo.
set /p newurl="  Neue OMS-URL (aus dem Execution-Tab, blaues Feld): "
powershell -NoProfile -Command "$p='helix_config.ini'; $u='%newurl%'.Trim(); $utf8=New-Object System.Text.UTF8Encoding($false); if(-not (Test-Path $p)){ [System.IO.File]::WriteAllText($p, ('[bridge]'+[Environment]::NewLine+'server = '+$u), $utf8) } else { $t=[System.IO.File]::ReadAllText($p); if($t -match '(?m)^server\s*='){ $t=[regex]::Replace($t,'(?m)^server\s*=.*',('server = '+$u)) } else { $t=$t+[Environment]::NewLine+'server = '+$u }; [System.IO.File]::WriteAllText($p,$t,$utf8) }"
echo.
echo   [OK] URL gespeichert. Auswahl 1 startet die Bridge damit.
echo.
pause
goto menu

:start
echo.
echo   Pruefe Pakete ...
%PY% -m pip install --quiet --disable-pip-version-check MetaTrader5
%PY% helix_bridge.py
echo.
echo   Bridge beendet.
pause
goto menu

:test
%PY% helix_bridge.py --test
pause
goto menu

:update
powershell -NoProfile -Command "$m=(Select-String -Path 'helix_config.ini' -Pattern '(?m)^server\s*=' | Select-Object -First 1); if(-not $m){ Write-Host '  Erst Server-URL setzen (Auswahl 2).'; exit 1 }; $u=$m.Line -replace '^server\s*=' ; $u=$u.Trim(); try { Invoke-WebRequest -UseBasicParsing ($u+'/mt5/helix_bridge.py') -OutFile 'helix_bridge.py'; Write-Host '  [OK] Bridge-Code aktualisiert.' } catch { Write-Host ('  [FEHLER] '+$_.Exception.Message) }"
pause
goto menu

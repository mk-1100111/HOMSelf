@echo off
setlocal
cd /d "%~dp0"
if errorlevel 1 goto failed
set "PYTHONUTF8=1"
if not exist ".venv\Scripts\python.exe" py -3 -m venv ".venv"
if not exist ".venv\Scripts\python.exe" goto failed
".venv\Scripts\python.exe" -m pip install -r "%~dp0requirements.txt"
if errorlevel 1 goto failed
if not exist "config.json" copy /y "config.example.json" "config.json" >nul
if not exist "config.json" goto failed
if not exist "selectors.json" copy /y "selectors.auto.example.json" "selectors.json" >nul
if not exist "selectors.json" goto failed
echo Setup complete. Read README_KO.md and configure the server connection.
echo Existing config, selectors and runtime records were preserved.
pause
exit /b 0
:failed
echo Setup failed. Check the error above. Python 3 and network access are required.
pause
exit /b 1

@echo off
setlocal
cd /d "%~dp0"
if errorlevel 1 exit /b 1
set "PYTHONUTF8=1"
if not exist ".venv\Scripts\python.exe" goto missing
echo LIVE MODE: This can submit a real HOMS release after operator confirmation.
".venv\Scripts\python.exe" worker.py --live
set "RESULT=%ERRORLEVEL%"
pause
exit /b %RESULT%
:missing
echo Python environment is missing. Run setup.cmd first.
pause
exit /b 1

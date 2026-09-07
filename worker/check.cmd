@echo off
setlocal
cd /d "%~dp0"
if errorlevel 1 exit /b 1
set "PYTHONUTF8=1"
if not exist ".venv\Scripts\python.exe" goto missing
".venv\Scripts\python.exe" worker.py
set "RESULT=%ERRORLEVEL%"
pause
exit /b %RESULT%
:missing
echo Python environment is missing. Run setup.cmd first.
pause
exit /b 1

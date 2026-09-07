@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
set "PYTHONUTF8=1"

if not exist ".venv\Scripts\python.exe" (
  echo [1회 설치] Python 가상환경과 Selenium을 설치합니다.
  call setup.cmd
  if errorlevel 1 exit /b 1
)

if "%HOMSELF_WORKER_TOKEN%"=="" (
  echo HOMSELF_WORKER_TOKEN 환경변수가 없습니다.
  echo 기존 Render WORKER_TOKEN과 같은 값을 Windows 환경변수에 설정한 뒤 다시 실행하세요.
  pause
  exit /b 1
)

echo.
echo HOMSelf 회사 PC 일괄 자동불출을 시작합니다.
echo Chrome에 관리자 탭과 HOMS 탭이 열립니다.
echo 1. HOMS 로그인은 직접 진행합니다.
echo 2. 관리자 화면에서 필요한 요청들을 각각 승인합니다.
echo 3. 승인건 일괄 불출 버튼을 누르면 그 시점의 승인건만 순서대로 자동불출합니다.
echo 종료하려면 이 창에서 Ctrl+C를 누르세요.
echo.

".venv\Scripts\python.exe" worker.py --live
set "RESULT=%ERRORLEVEL%"
echo.
echo HOMSelf 자동불출이 종료되었습니다.
pause
exit /b %RESULT%

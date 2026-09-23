@echo off
chcp 65001 >nul
setlocal EnableExtensions
cd /d "%~dp0"

set "REPO_URL=https://github.com/mk-1100111/HOMSelf.git"
set "BRANCH=master"
set "AUTO_MODE=0"
if /I "%~1"=="--auto" set "AUTO_MODE=1"

where git >nul 2>nul
if errorlevel 1 (
  echo [오류] Git이 설치되어 있지 않습니다.
  echo Git for Windows 설치 후 다시 실행하세요.
  if "%AUTO_MODE%"=="0" pause
  exit /b 1
)

echo.
echo HOMSelf 회사 PC 업데이트를 시작합니다.
echo worker\config.json, worker\selectors.json, worker\runtime, worker\.venv 는 Git 관리 대상이 아니므로 유지됩니다.
echo Git 관리 프로그램 파일은 원격 %BRANCH% 기준으로 자동 복구/덮어쓰기됩니다.
if "%AUTO_MODE%"=="0" echo 실행 중인 HOMSelf 자동불출 창이 있다면 먼저 Ctrl+C로 종료한 뒤 업데이트하세요.
echo.

if not exist ".git\" (
  echo [최초 1회] 현재 HOMSelf 폴더를 Git 저장소로 연결합니다.
  git init
  if errorlevel 1 goto failed
  git remote remove origin >nul 2>nul
  git remote add origin "%REPO_URL%"
  if errorlevel 1 goto failed
  git fetch origin "%BRANCH%"
  if errorlevel 1 goto failed
  git reset --hard "origin/%BRANCH%"
  if errorlevel 1 goto failed
  git branch -M "%BRANCH%"
  if errorlevel 1 goto failed
  git branch --set-upstream-to="origin/%BRANCH%" "%BRANCH%" >nul 2>nul
) else (
  git remote set-url origin "%REPO_URL%"
  if errorlevel 1 goto failed
  git fetch origin "%BRANCH%"
  if errorlevel 1 goto failed

  echo Git 관리 파일을 원격 %BRANCH% 버전으로 동기화합니다.
  git reset --hard "origin/%BRANCH%"
  if errorlevel 1 goto failed
  git branch --set-upstream-to="origin/%BRANCH%" "%BRANCH%" >nul 2>nul
)

echo.
echo Python 의존성을 최신 requirements.txt 기준으로 확인합니다.
if exist "worker\.venv\Scripts\python.exe" (
  "worker\.venv\Scripts\python.exe" -m pip install -r "worker\requirements.txt"
  if errorlevel 1 goto failed
) else (
  echo .venv가 없습니다. worker\setup.cmd 를 1회 실행합니다.
  call "worker\setup.cmd"
  if errorlevel 1 goto failed
)

echo.
echo 업데이트 완료.
git log -1 --oneline
if "%AUTO_MODE%"=="0" (
  echo.
  echo 이제 worker\HOMSelf_회사PC.cmd 를 실행하세요.
  pause
)
exit /b 0

:failed
echo.
echo [실패] HOMSelf 업데이트가 완료되지 않았습니다.
echo config.json / selectors.json / runtime 기록은 삭제하지 마세요.
if "%AUTO_MODE%"=="0" pause
exit /b 1

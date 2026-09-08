@echo off
chcp 65001 >nul
cd /d "%~dp0.."
echo HOMSelf 일반 Worker를 먼저 종료한 뒤 실행하세요.
echo HOMS 로그인 상태의 기존 Chrome 프로필을 사용합니다.
echo.
if not exist "worker\.venv\Scripts\python.exe" (
  echo worker\.venv가 없습니다. 먼저 worker setup을 실행하세요.
  pause
  exit /b 1
)
"worker\.venv\Scripts\python.exe" "worker\homs_catalog_crawler.py"
echo.
pause

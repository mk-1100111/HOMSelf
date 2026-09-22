@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0.."
if not exist "UPDATE_HOMSELF.cmd" (
  echo UPDATE_HOMSELF.cmd 를 찾을 수 없습니다.
  echo HOMSelf 저장소 루트 구성을 확인하세요.
  pause
  exit /b 1
)
call "UPDATE_HOMSELF.cmd"
exit /b %ERRORLEVEL%

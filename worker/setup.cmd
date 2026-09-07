@echo off
chcp 65001 >nul
cd /d "%~dp0"
py -3 -m venv .venv
if errorlevel 1 goto failed
.venv\Scripts\python.exe -m pip install -r requirements.txt
if errorlevel 1 goto failed
if not exist config.json copy config.example.json config.json
if not exist selectors.json copy selectors.example.json selectors.json
echo 설치 완료. README_KO.md를 읽고 config.json 및 인증 환경변수를 설정하세요.
pause
exit /b 0
:failed
echo 설치 실패. 위 오류를 확인하세요.
pause
exit /b 1

@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo 주의: 실제 HOMS 불출 모드입니다. 현장 선택자 검증 및 관리자 승인이 필요합니다.
.venv\Scripts\python.exe worker.py --live
pause

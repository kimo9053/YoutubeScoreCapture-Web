@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo.
echo  Youtube Score Capture (PWA)
echo  -----------------------------
echo  PC:     http://localhost:8765
echo  휴대폰: 같은 Wi-Fi라도 http://IP 는 PWA 설치가 안 됩니다.
echo          (https 또는 localhost만 secure context)
echo  갤럭시/아이패드 설치는 PC에서 확인 후,
echo  나중에 https로 올리거나 터널(ngrok 등)을 쓰면 됩니다.
echo.
echo  종료: Ctrl+C
echo.
where py >nul 2>nul
if %errorlevel%==0 (
  start "" http://localhost:8765
  py -m http.server 8765
  goto :eof
)
where python >nul 2>nul
if %errorlevel%==0 (
  start "" http://localhost:8765
  python -m http.server 8765
  goto :eof
)
echo Python이 없습니다. npx로 실행합니다...
start "" http://localhost:8765
npx --yes serve -l 8765 .

@echo off
chcp 65001 >nul
cd /d "%~dp0"
title PDF vers Mail - serveur local
echo.
echo  PDF vers Mail est lance.
echo.
echo  Sur ce PC   : http://localhost:8080
echo  Sur l'iPad  (meme Wi-Fi), tapez dans Safari :
for /f "tokens=2 delims=:" %%a in ('ipconfig ^| findstr /c:"IPv4"') do for /f "tokens=* delims= " %%b in ("%%a") do echo               http://%%b:8080
echo.
echo  Laissez cette fenetre ouverte pendant l'utilisation. Fermez-la pour arreter.
echo.
start "" http://localhost:8080
where python >nul 2>nul && (python -m http.server 8080 & goto :eof)
where py >nul 2>nul && (py -m http.server 8080 & goto :eof)
where node >nul 2>nul && (npx --yes http-server -p 8080 -c-1 & goto :eof)
echo  Python ou Node.js est necessaire pour ce mode.
echo  Sinon : double-cliquez simplement sur index.html pour l'utiliser sur ce PC.
pause

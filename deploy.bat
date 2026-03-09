@echo off
:: FubzLifts deploy — stamps version and pushes to GitHub Pages

:: Generate ISO timestamp
for /f "tokens=*" %%i in ('powershell -command "[DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ssZ')"') do set TIMESTAMP=%%i

:: Update version.js
echo // Auto-updated on deploy — do not edit manually> js\version.js
echo export const BUILD_TIME = '%TIMESTAMP%';>> js\version.js

:: Stage, commit, push
git add -A
git commit -m "deploy: %TIMESTAMP%"
git push origin master

echo.
echo Deployed! BUILD_TIME = %TIMESTAMP%
pause

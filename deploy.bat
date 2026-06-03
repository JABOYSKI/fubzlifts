@echo off
:: FubzLifts deploy - stamps build files and pushes to GitHub Pages.

:: ISO-8601 UTC timestamp for this deploy.
for /f "tokens=*" %%i in ('powershell -NoProfile -Command "[DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ssZ')"') do set TIMESTAMP=%%i

:: Stamp version.js, sw.js and index.html (?v= cache-bust + inline build time).
:: Delegated to a real .ps1 so the regex stamps are reliable -- the old inline
:: cmd-escaped version silently stopped stamping index.html and the splash date
:: froze. The script verifies its own work and exits non-zero on failure.
powershell -NoProfile -ExecutionPolicy Bypass -File "tools\stamp-build.ps1" -Timestamp "%TIMESTAMP%"
if errorlevel 1 (
  echo.
  echo Build stamping FAILED - aborting deploy. Nothing was committed or pushed.
  pause
  exit /b 1
)

:: Stage, commit, push. v2 deploys to the 'v2' branch on the same repo as v1.1;
:: v1.1 stays on 'master' untouched, so rollback is just toggling the GitHub Pages
:: source branch in repo Settings - no force-push, no destructive ops.
git add -A
git commit -m "deploy v2: %TIMESTAMP%"
git push origin master:v2

echo.
echo Deployed v2! BUILD_TIME = %TIMESTAMP%
echo Live at jaboyski.github.io/fubzlifts (GitHub Pages source = 'v2').
pause

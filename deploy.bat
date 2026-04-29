@echo off
:: FubzLifts deploy — stamps version and pushes to GitHub Pages

:: Generate ISO timestamp
for /f "tokens=*" %%i in ('powershell -NoProfile -Command "[DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ssZ')"') do set TIMESTAMP=%%i

:: Update version.js
echo // Auto-updated on deploy — do not edit manually> js\version.js
echo export const BUILD_TIME = '%TIMESTAMP%';>> js\version.js

:: Stamp SW cache name so browser detects new worker on deploy.
:: Replaces the entire single-quoted value: 'fubzlifts-...' -> 'fubzlifts-<timestamp>'
:: We pass TIMESTAMP via env var to dodge cmd's quoting rules around the regex.
set FUBZ_TS=%TIMESTAMP%
powershell -NoProfile -Command "$ts = $env:FUBZ_TS; $sw = Get-Content 'sw.js' -Raw; $sw = [regex]::Replace($sw, \"'fubzlifts-[^']*'\", \"'fubzlifts-$ts'\"); Set-Content -Path 'sw.js' -Value $sw -NoNewline -Encoding UTF8"
set FUBZ_TS=

:: Stage, commit, push.
:: v2 deploys to the 'v2' branch on the same repo as v1.1. v1.1 stays on
:: 'master' untouched, so rollback is just toggling the GitHub Pages source
:: branch in repo Settings — no force-push, no destructive ops.
git add -A
git commit -m "deploy v2: %TIMESTAMP%"
git push origin master:v2

echo.
echo Deployed v2! BUILD_TIME = %TIMESTAMP%
echo Live at jaboyski.github.io/fubzlifts once GitHub Pages source is set to 'v2'.
pause

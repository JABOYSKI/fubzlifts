# FubzLifts build stamper. Called by deploy.bat with the deploy timestamp.
# Stamps the build time / cache-bust token into the three files that need it:
#   - js/version.js : export const BUILD_TIME (module-import fallback)
#   - sw.js         : CACHE name (so the browser detects a new service worker)
#   - index.html    : every ?v= query (HTTP cache-bust) AND the inline
#                     window.FUBZ_BUILD_TIME (the login splash's "updated" line)
#
# Why this is a real .ps1 instead of inline `powershell -Command` in the .bat:
# the old inline version relied on cmd-escaped nested quotes for the regexes,
# which silently stopped stamping index.html and sw.js (the splash date froze on
# 2026-04-30). Native PowerShell with explicit UTF-8 file IO is reliable, and
# this script verifies every stamp landed so a broken deploy can't ship quietly.
param([Parameter(Mandatory = $true)][string]$Timestamp)
$ErrorActionPreference = 'Stop'

$enc  = New-Object System.Text.UTF8Encoding($false)        # UTF-8, no BOM
$root = Split-Path -Parent $PSScriptRoot                   # repo root (script lives in tools/)

function Read-Text($rel)        { [System.IO.File]::ReadAllText((Join-Path $root $rel), $enc) }
function Write-Text($rel, $txt) { [System.IO.File]::WriteAllText((Join-Path $root $rel), $txt, $enc) }

# version.js -- full overwrite. Keep this file ASCII-only (no em-dash) so the
# script's own source encoding can never corrupt it.
Write-Text 'js/version.js' "// Auto-updated on deploy - do not edit manually`r`nexport const BUILD_TIME = '$Timestamp';`r`n"

# sw.js -- cache name.
$sw = Read-Text 'sw.js'
$sw = [regex]::Replace($sw, "'fubzlifts-[^']*'", "'fubzlifts-$Timestamp'")
Write-Text 'sw.js' $sw

# index.html -- ?v= cache-bust on every script/link tag + the inline build time.
$h = Read-Text 'index.html'
$h = [regex]::Replace($h, '\?v=[^"''\s>]*', "?v=$Timestamp")
$h = [regex]::Replace($h, "window\.FUBZ_BUILD_TIME = '[^']*'", "window.FUBZ_BUILD_TIME = '$Timestamp'")
Write-Text 'index.html' $h

# Verify every stamp actually landed -- fail loud so deploy.bat aborts before commit.
$fail = @()
if ($sw -notmatch [regex]::Escape("'fubzlifts-$Timestamp'"))                { $fail += 'sw.js CACHE' }
if ($h  -notmatch [regex]::Escape("?v=$Timestamp"))                         { $fail += 'index.html ?v=' }
if ($h  -notmatch [regex]::Escape("window.FUBZ_BUILD_TIME = '$Timestamp'")) { $fail += 'index.html FUBZ_BUILD_TIME' }
if ($fail.Count) { Write-Error ("Build stamp FAILED for: " + ($fail -join ', ')); exit 1 }

Write-Host "Stamped build $Timestamp into version.js, sw.js, index.html (verified)."

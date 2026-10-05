# Uninstall the Vivaldi Workspace Sync mod on Windows. Run in PowerShell.
#
# Reverses install-windows.ps1:
#   1. Removes the mod script injection from main.html (and window.html if present)
#   2. Removes the copied mod script from the Vivaldi resources dir
#
# Your sync DATA lives in Vivaldi Notes and is deliberately NOT touched
# here - deleting notes behind a running browser would corrupt the Notes store.
# To remove it, delete the "VivaSync" folder in the Notes panel.
#
# KEEP THIS FILE PURE ASCII. Windows PowerShell 5.1 reads a file without a BOM
# in the ANSI code page, and a UTF-8 em dash ends up as the curly quote " there
# - which PowerShell honours as a string delimiter, so one dash in a comment
# terminates a string further down and the whole script fails to parse.

$ErrorActionPreference = "Stop"

# Locate main.html (same search as install-windows.ps1)
$AppDir = Join-Path $env:LOCALAPPDATA "Vivaldi\Application"
$MainHtml = Get-ChildItem -Path $AppDir -Recurse -Filter "main.html" -ErrorAction SilentlyContinue |
            Where-Object { $_.FullName -like "*resources\vivaldi\main.html" } |
            Sort-Object FullName -Descending | Select-Object -First 1

# 1 + 2. Remove mod injection and copied script from Vivaldi resources
if ($MainHtml) {
    $ResDir = Split-Path $MainHtml.FullName

    # main.html
    $html = Get-Content $MainHtml.FullName -Raw
    if ($html -match "vivasync-mod\.js") {
        $cleaned = ($html -split "`r?`n" | Where-Object { $_ -notmatch "vivasync-mod\.js" }) -join "`r`n"
        Set-Content -Encoding UTF8 $MainHtml.FullName $cleaned
        Write-Host ">> removed mod injection from $($MainHtml.FullName)"
    } else {
        Write-Host ">> main.html: no injection found (already clean)"
    }

    # window.html (the mod never belongs there; remove it if found)
    $WindowHtml = Join-Path $ResDir "window.html"
    if (Test-Path $WindowHtml) {
        $wh = Get-Content $WindowHtml -Raw
        if ($wh -match "vivasync-mod\.js") {
            $cleaned = ($wh -split "`r?`n" | Where-Object { $_ -notmatch "vivasync-mod\.js" }) -join "`r`n"
            Set-Content -Encoding UTF8 $WindowHtml $cleaned
            Write-Host ">> removed a mod injection from window.html"
        }
    }

    # copied mod script
    $ModCopy = Join-Path $ResDir "vivasync-mod.js"
    if (Test-Path $ModCopy) {
        Remove-Item -Force $ModCopy
        Write-Host ">> removed $ModCopy"
    }
} else {
    Write-Warning "Could not locate main.html under $AppDir - skipping mod removal."
    Write-Warning 'Remove the <script src="vivasync-mod.js"> line manually if Vivaldi is installed elsewhere.'
}

Write-Host ""
Write-Host "Done. Restart Vivaldi to complete removal."
Write-Host ""
Write-Host "Sync data was NOT deleted: it lives in the 'VivaSync' folder in Vivaldi Notes."
Write-Host "Delete that folder in the Notes panel to remove it - this propagates to every"
Write-Host "device via Vivaldi Sync."

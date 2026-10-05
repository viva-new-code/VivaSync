# Install the Vivaldi Workspace Sync mod on Windows. Run in PowerShell.
# Best-effort; the maintainer developed/tested on Linux, so verify paths for
# your Vivaldi install. Re-run after every Vivaldi update (updates overwrite
# main.html and undo the injection).
#
# No Python, no native host, no companion extension: the mod is the whole
# install. Sync documents are notes in the "VivaSync" folder of Vivaldi Notes,
# carried between devices by Vivaldi Sync itself.
#
# KEEP THIS FILE PURE ASCII. Windows PowerShell 5.1 reads a file without a BOM
# in the ANSI code page, and a UTF-8 em dash ends up as the curly quote " there
# - which PowerShell honours as a string delimiter, so one dash in a comment
# terminates a string further down and the whole script fails to parse.

$ErrorActionPreference = "Stop"
$Repo = Split-Path -Parent $MyInvocation.MyCommand.Path

# Mod injection into main.html (the "Vivaldi core" that loads bundle.js;
# window.html is only a render shell). Find the active Application build.
$AppDir = Join-Path $env:LOCALAPPDATA "Vivaldi\Application"
$MainHtml = Get-ChildItem -Path $AppDir -Recurse -Filter "main.html" -ErrorAction SilentlyContinue |
            Where-Object { $_.FullName -like "*resources\vivaldi\main.html" } |
            Sort-Object FullName -Descending | Select-Object -First 1
if (-not $MainHtml) {
    Write-Warning "Could not locate main.html under $AppDir. Inject the script tag manually."
} else {
    $ResDir = Split-Path $MainHtml.FullName
    Copy-Item -Force (Join-Path $Repo "mod\vivasync-mod.js") (Join-Path $ResDir "vivasync-mod.js")
    # The mod never belongs in window.html (a render shell with no JS context);
    # strip an injection there if one is found.
    $WindowHtml = Join-Path $ResDir "window.html"
    if (Test-Path $WindowHtml) {
        $wh = Get-Content $WindowHtml -Raw
        if ($wh -match "vivasync-mod\.js") {
            ($wh -split "`r?`n" | Where-Object { $_ -notmatch "vivasync-mod\.js" }) -join "`r`n" |
                Set-Content -Encoding UTF8 $WindowHtml
            Write-Host ">> removed a mod injection from window.html"
        }
    }
    $html = Get-Content $MainHtml.FullName -Raw
    if ($html -notmatch "vivasync-mod\.js") {
        $html = $html.Replace("</body>", "  <script src=`"vivasync-mod.js`"></script>`r`n</body>")
        Set-Content -Encoding UTF8 $MainHtml.FullName $html
        Write-Host ">> injected mod into $($MainHtml.FullName)"
    } else {
        Write-Host ">> mod already injected"
    }
}

Write-Host ""
Write-Host "Done. Restart Vivaldi, then:"
Write-Host "  1. Enable Vivaldi Sync with NOTES included - notes are the transport."
Write-Host "  2. Click the '<->' button in the status bar and tick workspaces to sync."
Write-Host "  3. Verify in the core devtools (vivaldi://inspect/#apps -> main.html):"
Write-Host "       VivaSync.introspect()"
Write-Host "       VivaSync.diagNotes()"

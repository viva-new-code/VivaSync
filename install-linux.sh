#!/usr/bin/env bash
# Install the Vivaldi Workspace Sync mod on Linux.
#
# What it does:
#   1. Copies the mod into the Vivaldi resources dir
#   2. Injects a <script> tag into main.html (needs sudo)
#
# That is the whole install: there is no native host, no companion extension
# and no config file. Sync documents are notes in the "VivaSync" folder of
# Vivaldi Notes, carried between devices by Vivaldi Sync itself.
#
# Re-run after every Vivaldi update — updates overwrite main.html and undo the
# injection.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VIV_RES="${VIVALDI_RES:-/opt/vivaldi/resources/vivaldi}"

echo ">> Vivaldi resources : $VIV_RES"

# The UI logic + chrome.* APIs live in main.html (the "Vivaldi core" that loads
# bundle.js). window.html is only a per-window render shell, so the mod MUST be
# injected into main.html.
if [ ! -d "$VIV_RES" ]; then
  echo "!! Vivaldi resources dir not found at $VIV_RES" >&2
  echo "   set VIVALDI_RES=/path/to/resources/vivaldi and re-run." >&2
  exit 1
fi
TARGET="$VIV_RES/main.html"
SUDO=""
[ -w "$TARGET" ] || SUDO="sudo"
$SUDO install -m 644 "$REPO/mod/vivasync-mod.js" "$VIV_RES/vivasync-mod.js"
# The mod never belongs in window.html (a render shell with no JS context);
# remove an injection there if one is found.
if [ -f "$VIV_RES/window.html" ] && $SUDO grep -q 'vivasync-mod\.js' "$VIV_RES/window.html"; then
  $SUDO sed -i '/vivasync-mod\.js/d' "$VIV_RES/window.html"
  echo ">> removed a mod injection from window.html"
fi
if $SUDO grep -q 'vivasync-mod\.js' "$TARGET"; then
  echo ">> mod already injected in main.html"
else
  $SUDO sed -i 's#</body>#  <script src="vivasync-mod.js"></script>\n</body>#' "$TARGET"
  echo ">> injected <script src=\"vivasync-mod.js\"> into main.html"
fi

cat <<EOF

Done. Restart Vivaldi, then:

  1. Enable Vivaldi Sync and make sure NOTES are included in the synced data.
     Notes are the transport — without them nothing crosses devices.

  2. Click the "⇄" button in the status bar and tick the workspaces to sync.
     (Equivalently: edit the "VivaSync/sync.config" note in the Notes panel and
     run VivaSync.reloadConfig().)

  3. To verify, open the core devtools — vivaldi://inspect/#apps, inspect the
     main.html entry — and run:
        VivaSync.introspect()   # device name, notes folder, workspaces, tabs
        VivaSync.diagNotes()    # every sync document and its age
EOF

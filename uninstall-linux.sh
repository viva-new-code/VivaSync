#!/usr/bin/env bash
# Uninstall the Vivaldi Workspace Sync mod on Linux.
#
# Reverses install-linux.sh:
#   1. Removes the mod script injection from main.html (and window.html if present)
#   2. Removes the copied mod script from the Vivaldi resources dir
#
# Your sync DATA lives in Vivaldi Notes and is deliberately NOT touched
# here — deleting notes behind a running browser would corrupt the Notes store.
# To remove it, delete the "VivaSync" folder in the Notes panel.
set -euo pipefail

VIV_RES="${VIVALDI_RES:-/opt/vivaldi/resources/vivaldi}"

SUDO=""
if [ -d "$VIV_RES" ] && [ ! -w "$VIV_RES" ]; then
  SUDO="sudo"
fi

# 1 + 2. Remove mod injection from main.html and the copied script
TARGET="$VIV_RES/main.html"
if [ -d "$VIV_RES" ]; then
  if [ -f "$TARGET" ] && $SUDO grep -q 'vivasync-mod\.js' "$TARGET"; then
    $SUDO sed -i '/vivasync-mod\.js/d' "$TARGET"
    echo ">> removed mod injection from main.html"
  else
    echo ">> main.html: no injection found (already clean)"
  fi
  if [ -f "$VIV_RES/window.html" ] && $SUDO grep -q 'vivasync-mod\.js' "$VIV_RES/window.html"; then
    $SUDO sed -i '/vivasync-mod\.js/d' "$VIV_RES/window.html"
    echo ">> removed a mod injection from window.html"
  fi
  MOD_COPY="$VIV_RES/vivasync-mod.js"
  if [ -f "$MOD_COPY" ]; then
    $SUDO rm -f "$MOD_COPY"
    echo ">> removed $MOD_COPY"
  fi
else
  echo ">> Vivaldi resources dir not found at $VIV_RES — skipping mod removal"
  echo "   (set VIVALDI_RES=/path/to/resources/vivaldi if installed elsewhere)"
fi

cat <<EOF

Done. Restart Vivaldi to complete removal.

Sync data was NOT deleted: it lives in the "VivaSync" folder in Vivaldi Notes.
Delete that folder in the Notes panel to remove it — and note that doing so
propagates to every device via Vivaldi Sync.
EOF

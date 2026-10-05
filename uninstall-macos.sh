#!/usr/bin/env bash
# Uninstall the Vivaldi Workspace Sync mod on macOS.
#
# Reverses install-macos.sh:
#   1. Removes the mod script injection from main.html (and window.html if present)
#   2. Removes the copied mod script from the Vivaldi resources dir
#   3. Re-signs the app bundle ad-hoc, because 1 and 2 change it again
#
# Every versioned framework in the bundle is cleaned, not just the current one:
# a Vivaldi update leaves the previous version directory in place with the
# injection still in it, and that copy comes back the moment macOS rolls the
# app back to it.
#
# Your sync DATA lives in Vivaldi Notes and is deliberately NOT touched
# here — deleting notes behind a running browser would corrupt the Notes store.
# To remove it, delete the "VivaSync" folder in the Notes panel.
#
#   ./uninstall-macos.sh [--no-resign]
#
# Overrides: VIVALDI_APP=/path/to/Vivaldi.app, or VIVALDI_RES=/path/to/resources/vivaldi
set -euo pipefail

RESIGN=1
# ("$@" is only expanded when there is something to expand: macOS ships bash 3.2,
# where an empty "$@" under `set -u` is an unbound variable.)
if [ "$#" -gt 0 ]; then
  for arg in "$@"; do
    case "$arg" in
      --no-resign) RESIGN=0 ;;
      -h|--help) sed -n '2,20p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
      *) echo "!! unknown argument: $arg" >&2; exit 2 ;;
    esac
  done
fi

APP="${VIVALDI_APP:-}"
if [ -z "$APP" ]; then
  for cand in "/Applications/Vivaldi.app" "$HOME/Applications/Vivaldi.app" \
              "/Applications/Vivaldi Snapshot.app" "$HOME/Applications/Vivaldi Snapshot.app"; do
    if [ -d "$cand" ]; then APP="$cand"; break; fi
  done
fi

# Every resources dir in the bundle (each framework version has its own), plus
# an explicit VIVALDI_RES if one was given.
# A newline-separated list, not an array: macOS ships bash 3.2, where expanding
# an EMPTY array under `set -u` is an unbound-variable error.
RES_DIRS=""
if [ -n "${VIVALDI_RES:-}" ]; then
  RES_DIRS="$VIVALDI_RES"
elif [ -n "$APP" ]; then
  FW="$APP/Contents/Frameworks/Vivaldi Framework.framework"
  # Versions/Current is a symlink to one of the version dirs listed beside it,
  # so it is dropped rather than cleaned twice.
  RES_DIRS="$(ls -d "$FW"/Versions/*/Resources/vivaldi 2>/dev/null | grep -v '/Versions/Current/' || true)"
fi

TMP="$(mktemp "${TMPDIR:-/tmp}/vivasync.XXXXXX")"
trap 'rm -f "$TMP"' EXIT

# 1 + 2. Remove mod injection from main.html and the copied script
TOUCHED=0
if [ -z "$RES_DIRS" ]; then
  echo ">> Vivaldi resources dir not found under ${APP:-/Applications/Vivaldi.app} — skipping mod removal"
  echo "   (set VIVALDI_APP=/path/to/Vivaldi.app or VIVALDI_RES=... if installed elsewhere)"
else
  while IFS= read -r VIV_RES; do
    [ -n "$VIV_RES" ] && [ -d "$VIV_RES" ] || continue
    SUDO=""
    [ -w "$VIV_RES" ] || SUDO="sudo"
    echo ">> $VIV_RES"

    TARGET="$VIV_RES/main.html"
    if [ -f "$TARGET" ] && $SUDO grep -q 'vivasync-mod\.js' "$TARGET"; then
      $SUDO sed '/vivasync-mod\.js/d' "$TARGET" > "$TMP"
      $SUDO cp "$TMP" "$TARGET"
      TOUCHED=1
      echo "   removed mod injection from main.html"
    else
      echo "   main.html: no injection found (already clean)"
    fi

    if [ -f "$VIV_RES/window.html" ] && $SUDO grep -q 'vivasync-mod\.js' "$VIV_RES/window.html"; then
      $SUDO sed '/vivasync-mod\.js/d' "$VIV_RES/window.html" > "$TMP"
      $SUDO cp "$TMP" "$VIV_RES/window.html"
      TOUCHED=1
      echo "   removed a mod injection from window.html"
    fi

    MOD_COPY="$VIV_RES/vivasync-mod.js"
    if [ -f "$MOD_COPY" ]; then
      $SUDO rm -f "$MOD_COPY"
      TOUCHED=1
      echo "   removed $MOD_COPY"
    fi
  done <<EOF
$RES_DIRS
EOF
fi

# 3. Re-sign, for the same reason the installer does: the bundle has changed
# again, and a bundle whose signature does not match its contents may refuse to
# launch. Only when something was actually edited.
if [ "$TOUCHED" = "1" ] && [ "$RESIGN" = "1" ] && [ -n "$APP" ]; then
  if command -v codesign >/dev/null 2>&1; then
    SUDO=""
    [ -w "$APP" ] || SUDO="sudo"
    echo ">> re-signing $APP ad-hoc"
    if $SUDO codesign --force --deep --sign - "$APP" >/dev/null 2>&1; then
      echo ">> re-signed"
    else
      echo "!! codesign failed — Vivaldi may refuse to launch." >&2
      echo "   try manually: sudo codesign --force --deep --sign - \"$APP\"" >&2
    fi
  else
    echo "!! codesign not found — run: codesign --force --deep --sign - \"$APP\"" >&2
  fi
fi

cat <<EOF

Done. Quit Vivaldi completely (Cmd-Q) and start it again to complete removal.

Sync data was NOT deleted: it lives in the "VivaSync" folder in Vivaldi Notes.
Delete that folder in the Notes panel to remove it — and note that doing so
propagates to every device via Vivaldi Sync.
EOF

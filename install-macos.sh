#!/usr/bin/env bash
# Install the Vivaldi Workspace Sync mod on macOS.
#
# What it does:
#   1. Copies the mod into the Vivaldi resources dir (inside the app bundle)
#   2. Injects a <script> tag into main.html
#   3. Re-signs the app bundle ad-hoc, because 1 and 2 break Apple's signature
#
# That is the whole install: there is no native host, no companion extension
# and no config file. Sync documents are notes in the "VivaSync" folder of
# Vivaldi Notes, carried between devices by Vivaldi Sync itself.
#
# Re-run after every Vivaldi update — an update installs a NEW versioned
# framework and the injection goes with the old one.
#
#   ./install-macos.sh              # install and re-sign
#   ./install-macos.sh --no-resign  # skip the codesign step (see below)
#
# Overrides: VIVALDI_APP=/path/to/Vivaldi.app, or VIVALDI_RES=/path/to/resources/vivaldi
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
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

# --- locate the app and its resources ---------------------------------------
# On macOS the UI documents live inside the versioned framework of the app
# bundle, not in a system directory:
#   Vivaldi.app/Contents/Frameworks/Vivaldi Framework.framework/
#     Versions/<build>/Resources/vivaldi/main.html
APP="${VIVALDI_APP:-}"
if [ -z "$APP" ]; then
  for cand in "/Applications/Vivaldi.app" "$HOME/Applications/Vivaldi.app" \
              "/Applications/Vivaldi Snapshot.app" "$HOME/Applications/Vivaldi Snapshot.app"; do
    if [ -d "$cand" ]; then APP="$cand"; break; fi
  done
fi

VIV_RES="${VIVALDI_RES:-}"
if [ -z "$VIV_RES" ]; then
  if [ -z "$APP" ]; then
    echo "!! Vivaldi.app not found in /Applications or ~/Applications" >&2
    echo "   set VIVALDI_APP=/path/to/Vivaldi.app (or VIVALDI_RES=...) and re-run." >&2
    exit 1
  fi
  FW="$APP/Contents/Frameworks/Vivaldi Framework.framework"
  # "Current" is the symlink the framework maintains; the newest version
  # directory by modification time is the fallback when it is missing.
  for base in "$FW/Versions/Current/Resources/vivaldi" "$FW/Resources/vivaldi"; do
    if [ -d "$base" ]; then VIV_RES="$base"; break; fi
  done
  if [ -z "$VIV_RES" ]; then
    VIV_RES="$(ls -dt "$FW"/Versions/*/Resources/vivaldi 2>/dev/null | head -1 || true)"
  fi
fi

echo ">> Vivaldi app       : ${APP:-(not resolved)}"
echo ">> Vivaldi resources : ${VIV_RES:-(not found)}"

# The UI logic + chrome.* APIs live in main.html (the "Vivaldi core" that loads
# bundle.js). window.html is only a per-window render shell, so the mod MUST be
# injected into main.html.
if [ -z "$VIV_RES" ] || [ ! -d "$VIV_RES" ]; then
  echo "!! Vivaldi resources dir not found" >&2
  echo "   set VIVALDI_RES=/path/to/resources/vivaldi and re-run." >&2
  exit 1
fi
TARGET="$VIV_RES/main.html"
if [ ! -f "$TARGET" ]; then
  echo "!! $TARGET does not exist — is VIVALDI_RES right?" >&2
  exit 1
fi

SUDO=""
[ -w "$TARGET" ] || SUDO="sudo"

# BSD sed's -i wants an argument and its replacements cannot spell "\n", so
# every edit here goes through a temp file and is copied back over the original
# (which keeps the file's owner and mode).
TMP="$(mktemp "${TMPDIR:-/tmp}/vivasync.XXXXXX")"
trap 'rm -f "$TMP"' EXIT

$SUDO install -m 644 "$REPO/mod/vivasync-mod.js" "$VIV_RES/vivasync-mod.js"

# The mod never belongs in window.html (a render shell with no JS context);
# remove an injection there if one is found.
if [ -f "$VIV_RES/window.html" ] && $SUDO grep -q 'vivasync-mod\.js' "$VIV_RES/window.html"; then
  $SUDO sed '/vivasync-mod\.js/d' "$VIV_RES/window.html" > "$TMP"
  $SUDO cp "$TMP" "$VIV_RES/window.html"
  echo ">> removed a mod injection from window.html"
fi

if $SUDO grep -q 'vivasync-mod\.js' "$TARGET"; then
  echo ">> mod already injected in main.html"
else
  $SUDO sed 's#</body>#  <script src="vivasync-mod.js"></script>\'$'\n''</body>#' "$TARGET" > "$TMP"
  $SUDO cp "$TMP" "$TARGET"
  echo ">> injected <script src=\"vivasync-mod.js\"> into main.html"
fi

# --- re-sign ----------------------------------------------------------------
# Editing anything inside the bundle invalidates Apple's code signature. An
# unsigned-but-modified Vivaldi may refuse to start ("damaged and can't be
# opened"), lose access to its Keychain items, or be killed at launch. An
# ad-hoc signature ("-") is what makes the modified bundle launchable again;
# it is the same thing every macOS Vivaldi mod has to do.
if [ "$RESIGN" = "1" ]; then
  if ! command -v codesign >/dev/null 2>&1; then
    echo "!! codesign not found (install the Xcode command line tools: xcode-select --install)" >&2
    echo "   Vivaldi may refuse to launch until the bundle is re-signed." >&2
  elif [ -z "$APP" ]; then
    echo "!! app bundle not resolved — skipping the re-sign" >&2
    echo "   run: codesign --force --deep --sign - /path/to/Vivaldi.app" >&2
  else
    echo ">> re-signing $APP ad-hoc (the edit above invalidated Apple's signature)"
    if $SUDO codesign --force --deep --sign - "$APP" >/dev/null 2>&1; then
      echo ">> re-signed"
    else
      echo "!! codesign failed — Vivaldi may refuse to launch." >&2
      echo "   try manually: sudo codesign --force --deep --sign - \"$APP\"" >&2
    fi
  fi
else
  echo ">> --no-resign: signature left invalid (Vivaldi may refuse to launch)"
fi

cat <<EOF

Done. Restart Vivaldi — quit it completely (Cmd-Q) rather than closing the
window, so the modified main.html is actually re-read. Then:

  1. Enable Vivaldi Sync and make sure NOTES are included in the synced data.
     Notes are the transport — without them nothing crosses devices.

  2. Click the "⇄" button in the status bar and tick the workspaces to sync.
     (Equivalently: edit the "VivaSync/sync.config" note in the Notes panel and
     run VivaSync.reloadConfig().)

  3. To verify, open the core devtools — vivaldi://inspect/#apps, inspect the
     main.html entry — and run:
        VivaSync.introspect()   # device name, notes folder, workspaces, tabs
        VivaSync.diagNotes()    # every sync document and its age

If macOS says Vivaldi "is damaged and can't be opened", the signature is the
reason: re-run this script (it re-signs), or run it by hand —
  sudo codesign --force --deep --sign - "${APP:-/Applications/Vivaldi.app}"
EOF

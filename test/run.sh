#!/usr/bin/env bash
# Run the whole offline suite. Each test gets its own node process: the mod is
# an IIFE that guards on window.__vivasyncLoaded and installs global state, so it
# can only be loaded once per process.
#
#   ./test/run.sh            # all tests
#   ./test/run.sh 03         # only files whose name starts with 03
#
# Requires node (>=18) and nothing else — no npm install, no dependencies.
set -u

cd "$(dirname "${BASH_SOURCE[0]}")"
FILTER="${1:-}"

if ! command -v node >/dev/null 2>&1; then
  echo "!! node not found on PATH" >&2
  exit 1
fi

pass=0
fail=0
failed_files=()

for f in [0-9][0-9]-*.js; do
  [ -e "$f" ] || continue
  if [ -n "$FILTER" ] && [[ "$f" != "$FILTER"* ]]; then continue; fi
  echo "=============================================================="
  echo "  $f"
  echo "=============================================================="
  # 02 sleeps through the 5s note-write throttle, so allow generous time.
  if timeout 120 node "$f"; then
    pass=$((pass + 1))
  else
    fail=$((fail + 1))
    failed_files+=("$f")
  fi
  echo
done

echo "=============================================================="
if [ "$fail" -eq 0 ]; then
  echo "  ALL SUITES PASSED ($pass files)"
else
  echo "  $fail SUITE(S) FAILED: ${failed_files[*]}"
fi
echo "=============================================================="
exit "$fail"

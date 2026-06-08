#!/usr/bin/env bash
# Runs every numbered E2E test in order. Smoke test is free; live tests
# require CAP_E2E_LIVE=1 (they skip otherwise).

set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
PASS=0
FAIL=0
SKIP=0
FAILED_TESTS=()

for script in "$HERE"/[0-9]*.sh; do
  name=$(basename "$script")
  echo
  echo "════════════════════════════════════════════════════════════════"
  echo "  RUN: $name"
  echo "════════════════════════════════════════════════════════════════"
  output=$(mktemp)
  if bash "$script" 2>&1 | tee "$output"; then
    if grep -q "^SKIP:" "$output"; then
      SKIP=$((SKIP+1))
    else
      PASS=$((PASS+1))
    fi
  else
    FAIL=$((FAIL+1))
    FAILED_TESTS+=("$name")
  fi
  rm -f "$output"
done

echo
echo "════════════════════════════════════════════════════════════════"
echo "  SUMMARY: $PASS passed, $FAIL failed, $SKIP skipped"
if [ "$FAIL" -gt 0 ]; then
  echo "  Failed:"
  for t in "${FAILED_TESTS[@]}"; do echo "    - $t"; done
  exit 1
fi
echo "════════════════════════════════════════════════════════════════"

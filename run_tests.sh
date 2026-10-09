#!/usr/bin/env bash
# run_tests.sh — unit tests for video-convert-893. No AWS, no ffmpeg, no deploy.
# Usage: ./run_tests.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

RED='\033[0;31m'; GREEN='\033[0;32m'
CYAN='\033[0;36m'; BOLD='\033[1m'; RESET='\033[0m'

separator() { printf '%s\n' "────────────────────────────────────────────────"; }

fail() {
  echo -e "${RED}error: $*${RESET}" >&2
  exit 1
}

if ! command -v node >/dev/null 2>&1; then
  fail "node not found. Install Node.js 20+ and try again."
fi
if ! command -v python3 >/dev/null 2>&1; then
  fail "python3 not found."
fi
if ! command -v npm >/dev/null 2>&1; then
  fail "npm not found. Install Node.js 20+ and try again."
fi

START_JOB="$SCRIPT_DIR/backend/lambda/startJob"
if [ ! -d "$START_JOB/node_modules" ]; then
  echo "Installing startJob dependencies (AWS SDK, needed to load handler.mjs)…"
  (cd "$START_JOB" && npm ci --omit=dev) || fail "npm ci failed in backend/lambda/startJob"
fi

echo ""
echo -e "${BOLD}${CYAN}video-convert-893 tests${RESET}"
separator
echo "  Node:    $(node --version)"
echo "  Python:  $(python3 --version)"
separator
echo ""

START_TIME=$(date +%s)
FAILED=0

run_step() {
  local name="$1"
  shift
  echo -e "${BOLD}${name}${RESET}"
  if "$@"; then
    echo -e "${GREEN}passed${RESET}  ${name}"
  else
    echo -e "${RED}failed${RESET}  ${name}"
    FAILED=1
  fi
  echo ""
}

run_step "startJob ready-key" \
  node --test backend/lambda/startJob/parseReadyKey.test.mjs
run_step "uploadApi paths" \
  node --test backend/lambda/uploadApi/paths.test.mjs
run_step "worker convert" \
  python3 backend/worker/convert_test.py
run_step "disc detect" \
  python3 backend/scripts/test_detect.py

ELAPSED=$(( $(date +%s) - START_TIME ))
separator
if [ "$FAILED" -eq 0 ]; then
  echo -e "${GREEN}${BOLD}All test files passed${RESET}  (${ELAPSED}s)"
  exit 0
fi
echo -e "${RED}${BOLD}One or more test files failed${RESET}  (${ELAPSED}s)"
exit 1

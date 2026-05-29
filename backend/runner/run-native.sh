#!/usr/bin/env bash
# Run the Playwright Runner natively on your host machine.
# Use this instead of Docker when the target site is behind
# IP/VPN restrictions that Docker's bridge network can't reach.
#
# Prerequisites (one-time):
#   pip install -r backend/runner/requirements.txt
#   playwright install chromium
#
# Usage:
#   ./backend/runner/run-native.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BACKEND_DIR="$(dirname "$SCRIPT_DIR")"

export PORT="${PORT:-8001}"
export LOG_LEVEL="${LOG_LEVEL:-INFO}"
export ARTIFACTS_DIR="${ARTIFACTS_DIR:-$SCRIPT_DIR/artifacts}"
export PYTHONPATH="$BACKEND_DIR"

mkdir -p "$ARTIFACTS_DIR"

echo "==================================="
echo " Autotest Playwright Runner (native)"
echo "==================================="
echo " Port:       $PORT"
echo " Artifacts:  $ARTIFACTS_DIR"
echo " PYTHONPATH: $PYTHONPATH"
echo "==================================="
echo ""

# Stop the Docker runner if it's running, to free port 8001
docker stop autotest-runner 2>/dev/null && echo "Stopped Docker runner container." || true

cd "$BACKEND_DIR"
exec python -m uvicorn runner.main:app --host 0.0.0.0 --port "$PORT"

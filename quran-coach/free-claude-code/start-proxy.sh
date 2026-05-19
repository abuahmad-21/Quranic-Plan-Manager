#!/usr/bin/env bash
set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

if [ -f ".env" ]; then
  echo "[Claude Proxy] Loading .env from $SCRIPT_DIR/.env"
  set -a; source .env; set +a
fi

echo "[Claude Proxy] Starting on port 8082 with provider: ${FCC_PROVIDER:-nvidia_nim}"
exec uv run uvicorn server:app --host 0.0.0.0 --port 8082 --timeout-graceful-shutdown 5

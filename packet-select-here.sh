#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$SCRIPT_DIR"

# Load .env from the repo root if present
if [[ -f "$REPO_ROOT/.env" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$REPO_ROOT/.env"
  set +a
fi

NODE_OPTIONS_EXTRA=""
if [[ -n "${PACKET_SELECT_MAX_OLD_SPACE_MB:-}" ]]; then
  NODE_OPTIONS_EXTRA="--max-old-space-size=${PACKET_SELECT_MAX_OLD_SPACE_MB}"
elif [[ -n "${GENERIC_MAX_OLD_SPACE_MB:-}" ]]; then
  NODE_OPTIONS_EXTRA="--max-old-space-size=${GENERIC_MAX_OLD_SPACE_MB}"
fi

if [[ -n "$NODE_OPTIONS_EXTRA" ]]; then
  node $NODE_OPTIONS_EXTRA "$REPO_ROOT/bin/packet-select.js" "$@"
else
  node "$REPO_ROOT/bin/packet-select.js" "$@"
fi

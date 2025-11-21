#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="${1:-$(pwd)}"
OUTPUT="${OUTPUT:-project-overview.txt}"

cd "$ROOT_DIR"

IGNORES=(
  ".git"
  "node_modules"
  "dist"
  ".venv"
  "__pycache__"
  ".DS_Store"
  ".vscode"
)

should_skip() {
  local path="$1"
  for ignore in "${IGNORES[@]}"; do
    if [[ "$path" == *"/$ignore"* || "$path" == "$ignore" ]]; then
      return 0
    fi
  done
  return 1
}

echo "# Project overview for $ROOT_DIR" > "$OUTPUT"
echo "# Generated $(date -Is)" >> "$OUTPUT"
echo "" >> "$OUTPUT"

while IFS= read -r -d '' entry; do
  rel="${entry#./}"
  if should_skip "$rel"; then
    continue
  fi
  if [[ -f "$entry" ]]; then
    echo "FILE $rel" >> "$OUTPUT"
  elif [[ -d "$entry" ]]; then
    echo "DIR  $rel" >> "$OUTPUT"
  fi
  # Optional preview for small text files
  if [[ -f "$entry" && $(stat -c%s "$entry") -le 4096 ]]; then
    echo "----- BEGIN $rel -----" >> "$OUTPUT"
    sed -e 's/^/    /' "$entry" >> "$OUTPUT" || true
    echo "----- END $rel -----" >> "$OUTPUT"
  fi
  echo "" >> "$OUTPUT"
done < <(find . -print0 | sort -z)

#!/usr/bin/env bash
set -euo pipefail

SRC_ROOT=""
DEST_ROOT=""
INPUT=""
MIN=1
MAX=1

while [[ $# -gt 0 ]]; do
  case "$1" in
    --src-root)
      SRC_ROOT="$2"; shift 2;;
    --dest-root)
      DEST_ROOT="$2"; shift 2;;
    --input)
      INPUT="$2"; shift 2;;
    --min)
      MIN="$2"; shift 2;;
    --max)
      MAX="$2"; shift 2;;
    *)
      echo "Unknown argument: $1" >&2
      exit 1;;
  esac
done

if [[ -z "$SRC_ROOT" || -z "$DEST_ROOT" || -z "$INPUT" ]]; then
  echo "Usage: $0 --src-root <dir> --dest-root <dir> --input <tsv> [--min N] [--max N]" >&2
  exit 1
fi

if [[ ! -f "$INPUT" ]]; then
  echo "Input TSV not found: $INPUT" >&2
  exit 1
fi

mkdir -p "$DEST_ROOT"

declare -a COUNTS
declare -a PATHS

while IFS=$'\t' read -r count path; do
  if [[ "$count" == "count" || -z "$path" ]]; then
    continue
  fi
  COUNTS+=("$count")
  PATHS+=("$path")
done < "$INPUT"

pad_bucket() {
  printf "gte%02d" "$1"
}

for ((threshold=MIN; threshold<=MAX; threshold++)); do
  bucket_dir="$DEST_ROOT/$(pad_bucket "$threshold")"
  mkdir -p "$bucket_dir"
  for idx in "${!COUNTS[@]}"; do
    count="${COUNTS[$idx]}"
    path="${PATHS[$idx]}"
    if (( count < threshold )); then
      continue
    fi
    src_path="$SRC_ROOT/$path"
    dest_path="$bucket_dir/$path"
    if [[ ! -f "$src_path" ]]; then
      echo "WARN: missing source file $src_path" >&2
      continue
    fi
    mkdir -p "$(dirname "$dest_path")"
    cp -a "$src_path" "$dest_path"
  done
  echo "Built bucket $bucket_dir" >&2
done

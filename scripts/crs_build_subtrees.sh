#!/usr/bin/env bash
# Filename: crs_build_subtrees.sh
#
# Purpose:
#   Build frequency "subtrees" (gteNN) that mirror a source project tree,
#   copying only files whose frequency >= a threshold. Frequencies and
#   file specs come from an external TSV file.
#
# Requirements:
#   - bash (macOS Bash 3.x compatible)
#   - standard POSIX tools: find, cp, dirname
#
# Data file format (TSV):
#   <count>\t<relative-or-pattern-path>
#   - Optional header row is allowed (non-numeric first field).
#   - Blank lines and lines starting with '#' are ignored.
#   - Path may be quoted with "..." (quotes will be stripped).
#   - Relative paths are interpreted under --src-root.
#   - "..." in a path is treated as a fuzzy region and becomes "*".
#   - Shell wildcards (* ? [..]) are supported.
#   - An extension-only spec like ".m4a" matches every *.m4a under src.
#
# Usage examples:
#   # Minimal (auto-detect min/max from data), buckets under PWD:
#   bash crs_build_subtrees.sh \
#     --src-root "/Users/jburkart/Library/Mobile Documents/com~apple~CloudDocs/Teams/CRS" \
#     --input "/path/to/file-frequency.tsv"
#
#   # Custom destination, only buckets gte03..gte07:
#   bash crs_build_subtrees.sh \
#     -s "/path/to/src" -i "./freq.tsv" -o "/path/to/dest" --min 3 --max 7
#
#   # See what would be copied without writing:
#   bash crs_build_subtrees.sh -s "/path/to/src" -i "./freq.tsv" --dry-run
#
# Exit codes:
#   0 success; non-zero on error.
#
# Notes:
#   - Buckets are named "<prefix><padded-threshold>", default prefix "gte".
#     Padding width adapts to the largest threshold (e.g., 01..09 or 001..123).
#   - Existing files are not overwritten; timestamps are preserved (-p).
#   - Logs (WARN / COPIED) go to stderr.

set -euo pipefail

# ---------- cli & config -----------------------------------------------------

SRC_ROOT=""
DEST_ROOT="${PWD}"
DATA_FILE=""
MIN_FREQ=""
MAX_FREQ=""
BUCKET_PREFIX="gte"
DRY_RUN=0

usage() {
  cat <<'USAGE'
Usage:
  crs_build_subtrees.sh --src-root <dir> --input <tsv> [options]

Required:
  -s, --src-root DIR     Source project root to mirror (where real files live)
  -i, --input TSV        TSV file with frequency data (count<TAB>path/pattern)

Optional:
  -o, --dest-root DIR    Destination root (default: current directory)
      --min N            Lowest threshold to create (default: min in data)
      --max N            Highest threshold to create (default: max in data)
      --prefix STR       Bucket name prefix (default: "gte")
      --dry-run          Print actions; do not copy files
  -h, --help             Show this help

Data rules:
  • TSV: two columns (count<TAB>path). Header line allowed.
  • Lines starting with "#" and blank lines are ignored.
  • Leading "./" in paths is OK; it will be trimmed.
  • "..." in a path → "*" (fuzzy).
  • Wildcards (* ? [..]) are matched against paths under --src-root.
  • A spec like ".m4a" means "all *.m4a under --src-root".
USAGE
}

# basic manual option parser (Bash 3 compatible)
if [[ $# -eq 0 ]]; then usage; exit 1; fi
while [[ $# -gt 0 ]]; do
  case "$1" in
    -s|--src-root) SRC_ROOT="${2:-}"; shift 2 ;;
    -o|--dest-root) DEST_ROOT="${2:-}"; shift 2 ;;
    -i|--input) DATA_FILE="${2:-}"; shift 2 ;;
    --min) MIN_FREQ="${2:-}"; shift 2 ;;
    --max) MAX_FREQ="${2:-}"; shift 2 ;;
    --prefix) BUCKET_PREFIX="${2:-}"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *)  # allow positional DATA_FILE if not set
        if [[ -z "$DATA_FILE" && -f "$1" ]]; then
          DATA_FILE="$1"; shift
        else
          printf 'ERROR: unknown argument: %s\n' "$1" >&2
          usage; exit 2
        fi
        ;;
  esac
done

# allow env default for SRC_ROOT
SRC_ROOT="${SRC_ROOT:-${CRS_SRC_ROOT:-}}"

# normalize and validate
if [[ -z "${SRC_ROOT}" || ! -d "${SRC_ROOT}" ]]; then
  printf 'ERROR: --src-root not found: %s\n' "${SRC_ROOT:-<empty>}" >&2
  exit 1
fi
if [[ -z "${DATA_FILE}" || ! -f "${DATA_FILE}" ]]; then
  printf 'ERROR: --input TSV not found: %s\n' "${DATA_FILE:-<empty>}" >&2
  exit 1
fi

# trim trailing slashes
SRC_ROOT="${SRC_ROOT%/}"
DEST_ROOT="${DEST_ROOT%/}"

# ---------- helpers ----------------------------------------------------------

log() { printf '%s\n' "$*" >&2; }

# Copy a matched file into the bucket, preserving relative path under SRC_ROOT.
copy_preserving_tree() {
  local src="$1" bucket_dir="$2"
  local rel="${src#$SRC_ROOT/}"
  local dest="$bucket_dir/$rel"
  local dest_dir; dest_dir=$(dirname "$dest")
  if [[ "$DRY_RUN" -eq 0 ]]; then
    mkdir -p "$dest_dir"
  fi
  if [[ -f "$dest" ]]; then
    # already present; skip silently to keep logs readable
    return 0
  fi
  if [[ "$DRY_RUN" -eq 1 ]]; then
    log "DRYRUN: would copy $rel -> ${bucket_dir##*/}"
  else
    cp -p "$src" "$dest"
    log "COPIED:  $rel -> ${bucket_dir##*/}"
  fi
}

# Resolve one spec (literal, wildcard, extension-only, or with "...")
# into zero or more absolute files under SRC_ROOT, and copy to bucket.
resolve_and_copy_spec() {
  local spec="$1" bucket_dir="$2"

  # Trim whitespace
  spec="${spec#"${spec%%[![:space:]]*}"}"   # ltrim
  spec="${spec%"${spec##*[![:space:]]}"}"   # rtrim
  # Trim optional quotes
  spec="${spec%\"}"; spec="${spec#\"}"
  spec="${spec%\'}"; spec="${spec#\'}"
  # Trim leading "./"
  spec="${spec#./}"
  [[ -z "$spec" ]] && return 0

  # Map literal "..." to "*"
  local pattern="$spec"
  if [[ "$pattern" == *"..."* ]]; then
    pattern="${pattern//.../*}"
  fi

  local -a matches=()

  # Extension-only spec like ".m4a" or ".wav"
  if [[ "$pattern" == .* && "$pattern" != */* ]]; then
    local ext="${pattern#.}"
    if [[ -n "$ext" ]]; then
      while IFS= read -r -d '' f; do matches+=("$f"); done \
        < <(find "$SRC_ROOT" -type f -name "*.${ext}" -print0)
    fi

  # Contains shell wildcards -> use -path against SRC_ROOT
  elif [[ "$pattern" == *'*'* || "$pattern" == *'?'* || "$pattern" == *'['* ]]; then
    while IFS= read -r -d '' f; do matches+=("$f"); done \
      < <(find "$SRC_ROOT" -type f -path "$SRC_ROOT/$pattern" -print0)

  else
    # Try exact relative path first
    local candidate="$SRC_ROOT/$pattern"
    if [[ -f "$candidate" ]]; then
      matches+=("$candidate")
    else
      # Fallback: basename search (may return multiple)
      local base="${pattern##*/}"
      while IFS= read -r -d '' f; do matches+=("$f"); done \
        < <(find "$SRC_ROOT" -type f -name "$base" -print0)
    fi
  fi

  if ((${#matches[@]} == 0)); then
    log "WARN: no match for spec '$spec' (pattern '$pattern')"
    return 0
  fi

  local src
  for src in "${matches[@]}"; do
    copy_preserving_tree "$src" "$bucket_dir"
  done
}

# Determine min/max from the TSV if not provided
discover_range_from_data() {
  local min="" max=""
  while IFS=$'\t' read -r c p _; do
    # Skip comments/blank lines
    [[ -z "${c// }" ]] && continue
    [[ "${c:0:1}" == "#" ]] && continue
    # If first field isn't numeric, treat it as header and skip
    if [[ ! "$c" =~ ^[0-9]+$ ]]; then
      continue
    fi
    # track min/max
    if [[ -z "$min" || "$c" -lt "$min" ]]; then min="$c"; fi
    if [[ -z "$max" || "$c" -gt "$max" ]]; then max="$c"; fi
  done < "$DATA_FILE"

  if [[ -z "$min" || -z "$max" ]]; then
    printf 'ERROR: could not detect numeric frequencies in %s\n' "$DATA_FILE" >&2
    exit 1
  fi

  echo "$min $max"
}

# ---------- main -------------------------------------------------------------

log "Source root:      $SRC_ROOT"
log "Destination root: $DEST_ROOT"
log "Data file:        $DATA_FILE"

# Discover frequency bounds if not provided
if [[ -z "$MIN_FREQ" || -z "$MAX_FREQ" ]]; then
  read -r detected_min detected_max < <(discover_range_from_data)
  MIN_FREQ="${MIN_FREQ:-$detected_min}"
  MAX_FREQ="${MAX_FREQ:-$detected_max}"
fi

# Sanity: numeric
if ! [[ "$MIN_FREQ" =~ ^[0-9]+$ && "$MAX_FREQ" =~ ^[0-9]+$ ]]; then
  printf 'ERROR: --min/--max must be integers; got min=%s max=%s\n' "$MIN_FREQ" "$MAX_FREQ" >&2
  exit 1
fi
if (( MIN_FREQ > MAX_FREQ )); then
  printf 'ERROR: --min (%d) > --max (%d)\n' "$MIN_FREQ" "$MAX_FREQ" >&2
  exit 1
fi

log "Frequency range:  >=${MIN_FREQ}..>=${MAX_FREQ}"
log "Bucket prefix:    $BUCKET_PREFIX"
[[ "$DRY_RUN" -eq 1 ]] && log "Mode:             DRY RUN (no files will be copied)"
log ""

# Compute padding width from highest threshold
PAD_WIDTH=${#MAX_FREQ}

# Create bucket directories (e.g., gte06, gte05, ... gte01)
for ((freq=MAX_FREQ; freq>=MIN_FREQ; freq--)); do
  bucket_name=$(printf '%s%0*d' "$BUCKET_PREFIX" "$PAD_WIDTH" "$freq")
  bucket_dir="$DEST_ROOT/$bucket_name"
  if [[ "$DRY_RUN" -eq 0 ]]; then
    mkdir -p "$bucket_dir"
  fi
  log "Created bucket:   $bucket_dir"
done
log ""

# Fill buckets: for each threshold, copy all specs with count >= threshold
for ((threshold=MAX_FREQ; threshold>=MIN_FREQ; threshold--)); do
  bucket_name=$(printf '%s%0*d' "$BUCKET_PREFIX" "$PAD_WIDTH" "$threshold")
  bucket_dir="$DEST_ROOT/$bucket_name"
  log "---- Filling bucket $bucket_name (files with freq >= $threshold) ----"

  while IFS=$'\t' read -r count relpath _; do
    # Ignore comments and blanks
    [[ -z "${count// }" ]] && continue
    [[ "${count:0:1}" == "#" ]] && continue

    # Skip header or non-numeric first column
    if ! [[ "$count" =~ ^[0-9]+$ ]]; then
      continue
    fi

    if (( count >= threshold )); then
      resolve_and_copy_spec "$relpath" "$bucket_dir"
    fi
  done < "$DATA_FILE"

  log ""
done

log "Done. Buckets created under: $DEST_ROOT"

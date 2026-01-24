#!/usr/bin/env bash
##############################################################################
# generate-overview.sh
#
# Generates a text-based overview of the project and saves the result to
# 'project-overview.txt'. It includes:
#   1. A directory structure overview (via 'tree' or 'ls -R')
#   2. A single-pass approach to display textual contents of files:
#      - PDFs extracted as text, using pdftotext or OCR fallback.
#      - Word .docx files (when pandoc is available) converted to Markdown
#        via pandoc with track changes & comments preserved, then shown as text.
#      - Plain text or JSON/XML files shown in full, except:
#         * 'generatedOutputs.json' and 'evaluationResults.json' get summarized.
#         * 'whisper.json' is partially stripped: keep first 3 & last 3 segments
#           if they exist, remove large numeric fields, handle tokens carefully,
#           and optionally shorten .text.
#         * For other JSON, we keep the overall shape but truncate arrays >15.
#           If transform yields empty, we fallback to original.
#      - Binary files noted but not shown in raw form.
#   3. Skips certain known directories and file patterns:
#      - .git, node_modules, dist, .venv, project-overview*, etc.
#   4. Concludes with a basic system report and optional Ollama models listing.
#   5. GLOBAL LINE LIMIT (MAX_TOTAL_LINES): stops writing once we exceed it.
#
# Usage:
#   ./scripts/generate-overview.sh
#
# Requirements:
#   - tree (optional, for nicer directory listing)
#   - pdftotext (Poppler) or Xpdf (for PDF text extraction)
#   - tesseract (optional, for OCR fallback if PDF has no embedded text)
#   - ollama (optional, to list installed local models)
#   - jq (for JSON processing)
#   - pandoc (optional, for converting .docx files to Markdown with tracked changes & comments)
#   - coreutils / gshuf (optional, for random sampling in summarizing large logs)
#
# WARNING:
#   This script can expose sensitive data in 'project-overview.txt'.
#   Handle the resulting file with care!
#
# Version history:
#   2025-11-25 (v1.1.1)
#     - Sample large CSV files with header + head/tail lines to avoid oversized
#       overview output while keeping small CSVs fully dumped.
#   2025-11-24 (v1.1.0)
#     - Add pandoc-based handling for .docx files: convert to Markdown via
#       pandoc with --track-changes=all so tracked changes & comments are
#       preserved in the text dump when pandoc is available.
#   (Earlier versions prior to v1.1.0 are not recorded here; see git history.)
##############################################################################

##############################################################################
# DEBUG_LOGGING: set DEBUG_OVERVIEW=1 to see verbose debug lines in console.
##############################################################################
DEBUG_LOGGING=${DEBUG_OVERVIEW:-0}

debug_msg() {
  if [ "$DEBUG_LOGGING" = "1" ]; then
    # Print to stderr
    echo "DEBUG: $*" >&2
  fi
}

##############################################################################
# Resolve project name from parent directory
#
# Explanation:
#   If your script is in "myProject/scripts/generate-overview.sh",
#   then parent dir is "myProject". We capture that name as the project name.
##############################################################################
# If you typically run this script from the project root, you can do:
#   PROJECT_ROOT="$(pwd)"
#   PROJECT_NAME="$(basename "$PROJECT_ROOT")"
# Instead.
##############################################################################

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"   # go up one level from script location
PROJECT_NAME="$(basename "$PROJECT_ROOT")"

OUTPUT_FILE="project-overview.txt"
MAX_TOTAL_LINES="${MAX_TOTAL_LINES:-3000}"
CSV_SAMPLE_LINES="${CSV_SAMPLE_LINES:-5}"
CSV_LARGE_BYTES="${CSV_LARGE_BYTES:-10485760}"

CURRENT_LINE_COUNT=0
STOP_OUTPUT=false

##############################################################################
# safe_echo: prints lines to $OUTPUT_FILE but stops if we exceed $MAX_TOTAL_LINES
##############################################################################
safe_echo() {
  if [ "$STOP_OUTPUT" = true ]; then
    return
  fi

  while IFS= read -r line; do
    #if [ $((CURRENT_LINE_COUNT + 1)) -gt "$MAX_TOTAL_LINES" ]; then
    #  echo "(Truncated - reached max lines limit of $MAX_TOTAL_LINES.)" >> "$OUTPUT_FILE"
    #  STOP_OUTPUT=true
    #  return
    #fi
    echo "$line" >> "$OUTPUT_FILE"
    CURRENT_LINE_COUNT=$((CURRENT_LINE_COUNT + 1))
  done <<< "$1"
}

##############################################################################
# safe_print_command: like safe_echo but reads from stdin
##############################################################################
safe_print_command() {
  if [ "$STOP_OUTPUT" = true ]; then
    return
  fi

  while IFS= read -r line; do
    #if [ $((CURRENT_LINE_COUNT + 1)) -gt "$MAX_TOTAL_LINES" ]; then
    #  echo "(Truncated - reached max lines limit of $MAX_TOTAL_LINES.)" >> "$OUTPUT_FILE"
    #  STOP_OUTPUT=true
    #  return
    #fi
    echo "$line" >> "$OUTPUT_FILE"
    CURRENT_LINE_COUNT=$((CURRENT_LINE_COUNT + 1))
  done
}

##############################################################################
# dump_csv_file: dumps CSV fully or samples head/tail for large files
##############################################################################
dump_csv_file() {
  local filePath="$1"
  local fileSize
  fileSize=$(stat -c%s "$filePath" 2>/dev/null || stat -f%z "$filePath" 2>/dev/null || wc -c < "$filePath")

  if [ "$fileSize" -le "$CSV_LARGE_BYTES" ]; then
    while IFS= read -r line; do
      if [ "$STOP_OUTPUT" = true ]; then break; fi
      safe_echo "$line"
    done < "$filePath"
    return
  fi

  safe_echo "(Large CSV; truncating content dump. Showing header + first $CSV_SAMPLE_LINES lines and last $CSV_SAMPLE_LINES lines. Size: $fileSize bytes.)"
  head -n "$((CSV_SAMPLE_LINES + 1))" "$filePath" | safe_print_command
  safe_echo "... truncated ..."
  tail -n "$CSV_SAMPLE_LINES" "$filePath" | safe_print_command
}

# Start fresh
rm -f "$OUTPUT_FILE"
touch "$OUTPUT_FILE"
CURRENT_LINE_COUNT=0

##############################################################################
# For general JSON, we keep arrays up to length 15 as-is; if length>15,
# keep first 5, placeholder, last 5. Recurse for nested arrays.
##############################################################################
truncate_large_json_with_jq_script='
def partial_array:
  if type == "array" then
    if length > 15 then
      .[0:5] + ["... plus \((length - 10)) omitted ..."] + .[-5:]
    else
      .
    end
  elif type == "object" then
    with_entries(.value |= partial_array)
  else
    .
  end
;
partial_array
'

##############################################################################
# For whisper.json specifically, do more advanced logic:
# - keep first 3 + last 3 segments if total >6
# - remove large numeric fields if present (temperature, avg_logprob, etc.)
# - if .tokens exists and is an array, we partially truncate it
# - partial .text (first 400 chars) if .text is large
##############################################################################
truncate_whisper_json_with_jq_script='
def partial_segments:
  if .segments == null or (.segments | type) != "array" then
    .
  else
    .segments |= (
      if length <= 6 then
        # Keep all segments
        map(
          if (has("tokens") and (.tokens | type) == "array") then
            .tokens |= (
              if (length > 1) then
                [.[0]] + ["... plus \((length - 1)) omitted ..."]
              else
                .
              end
            )
          else
            .
          end
          | del(.temperature?)
          | del(.avg_logprob?)
          | del(.compression_ratio?)
          | del(.no_speech_prob?)
        )
      else
        # Keep first 3, last 3
        (.[0:3] + .[-3:]) | map(
          if (has("tokens") and (.tokens | type) == "array") then
            .tokens |= (
              if (length > 1) then
                [.[0]] + ["... plus \((length - 1)) omitted ..."]
              else
                .
              end
            )
          else
            .
          end
          | del(.temperature?)
          | del(.avg_logprob?)
          | del(.compression_ratio?)
          | del(.no_speech_prob?)
        )
      end
    )
  end
;

def partial_text:
  if (.text? | type) == "string" then
    .text |= (
      if (length > 400) then
        .[0:400] + " ... plus \((length - 400)) chars omitted ..."
      else
        .
      end
    )
  else
    .
  end
;

partial_segments | partial_text
'

##############################################################################
# Helper function to run a jq filter. Captures exit code and stderr for debugging
##############################################################################
run_jq_filter() {
  local filter_script="$1"
  local filePath="$2"

  debug_msg "run_jq_filter: filter_script length=${#filter_script}, file=$filePath"
  local jq_stderr
  local output
  # Use process substitution to capture stderr
  jq_stderr="$( { output="$(jq -M -e -f <(echo "$filter_script") "$filePath" 2>&1 )"; } 2>&1 )"
  local exit_code=$?

  debug_msg "declare -- jq_stderr=\"$jq_stderr\""
  debug_msg "run_jq_filter: exit_code=$exit_code"

  # Return outputs via global variables (not elegant, but quick)
  RUN_JQ_STDERR="$jq_stderr"
  RUN_JQ_EXIT_CODE="$exit_code"
  RUN_JQ_OUTPUT="$output"
}

##############################################################################
# Summaries for large logs
##############################################################################
summarize_generated_outputs() {
  local filePath="$1"

  safe_echo "### Summaries for $filePath"
  safe_echo ""

  if ! command -v jq >/dev/null 2>&1; then
    safe_echo "(jq not installed. Cannot provide advanced summary. Only file note.)"
    return
  fi

  local fileSize
  fileSize=$(stat -c%s "$filePath" 2>/dev/null || stat -f%z "$filePath" 2>/dev/null)
  safe_echo "File size (bytes): $fileSize"

  local totalCount
  totalCount=$(jq '. | length' "$filePath" 2>/dev/null)
  safe_echo "Total JSON objects in $filePath: $totalCount"
  safe_echo ""

  if [ "$totalCount" = "null" ] || [ -z "$totalCount" ] || [ "$totalCount" -eq 0 ] 2>/dev/null; then
    safe_echo "(File is empty or not valid JSON.)"
    return
  fi

  safe_echo "#### modelName distribution (sorted by count desc):"
  jq '
    group_by(.modelName)
    | map({modelName:.[0].modelName, count:length})
    | sort_by(.count) | reverse
  ' "$filePath" | safe_print_command
  safe_echo ""

  safe_echo "#### stage distribution (sorted by count desc):"
  jq '
    group_by(.stage)
    | map({stage:.[0].stage, count:length})
    | sort_by(.count) | reverse
  ' "$filePath" | safe_print_command
  safe_echo ""

  safe_echo "#### timestamp range:"
  local minTimestamp
  local maxTimestamp
  minTimestamp=$(jq 'min_by(.timestamp) | .timestamp' "$filePath")
  maxTimestamp=$(jq 'max_by(.timestamp) | .timestamp' "$filePath")
  safe_echo "Min timestamp: $minTimestamp"
  safe_echo "Max timestamp: $maxTimestamp"
  safe_echo ""

  local sampleSize=1
  if [ "$totalCount" -lt "$sampleSize" ]; then
    sampleSize="$totalCount"
  fi

  safe_echo "#### Sample $sampleSize object(s) from $filePath:"
  if command -v gshuf >/dev/null 2>&1; then
    jq -c '.[]' "$filePath" | gshuf -n "$sampleSize" | jq -s '.' | safe_print_command
  else
    safe_echo "(gshuf not found, fallback last $sampleSize items.)"
    jq --arg c "$sampleSize" '. | (.[-($c|tonumber):])' "$filePath" | safe_print_command
  fi
  safe_echo ""
}

##############################################################################
# 1) Directory Structure
##############################################################################
safe_echo "# Project Overview"
safe_echo "Generated on: $(date)"
safe_echo ""
safe_echo "This script produces a comprehensive snapshot of all files in the ${PROJECT_NAME} project."
safe_echo "---"
safe_echo ""

safe_echo "## 1. Directory Structure"
safe_echo ""

if command -v tree >/dev/null 2>&1; then
  safe_echo "Below is the tree of files/folders (excluding .git, node_modules, dist, .venv, project-overview*):"
  safe_echo '```'
  tree -a -I ".git|node_modules|dist|.venv|project-overview*|.DS_Store" . | safe_print_command
  safe_echo '```'
else
  safe_echo "Below is the 'ls -R' style listing (excluding .git, node_modules, dist, .venv, project-overview*)."
  safe_echo "Install 'tree' for a more visual directory listing."
  safe_echo '```'
  find . \
    -path "*/.git" -prune -o \
    -path "*/node_modules" -prune -o \
    -path "*/dist" -prune -o \
    -path "*/.venv" -prune -o \
    -path "*/project-overview*" -prune -o \
    -name ".DS_Store" -prune -o \
    -print | safe_print_command
  safe_echo '```'
fi

safe_echo ""
safe_echo "---"
safe_echo ""

##############################################################################
# 2) Single-Pass: Full Content Dump
##############################################################################
safe_echo "## 2. Full Content Dump"
safe_echo "This section provides a textual representation of each file, skipping certain directories/file patterns."
safe_echo ""

SKIP_DIRS=(.git node_modules dist .vscode .venv scripts skip open-data "Jamie working with ChatGPT")
SKIP_FILES=("*.lock" ".env" "yarn.lock" "package-lock.json" "project-overview*" "generate-overview.sh" ".DS_Store")

FIND_CMD=(find .)

for dir in "${SKIP_DIRS[@]}"; do
  FIND_CMD+=( -path "*/$dir" -prune -o )
done

FIND_CMD+=( -type f )

for pattern in "${SKIP_FILES[@]}"; do
  FIND_CMD+=( \( -iname "$pattern" \) -prune -o )
done

FIND_CMD+=( -print )

mapfile -t ALL_FILES < <("${FIND_CMD[@]}" 2>/dev/null)

debug_msg "Found ${#ALL_FILES[@]} files after pruning."

if [ ${#ALL_FILES[@]} -eq 0 ]; then
  safe_echo "No files found based on skip rules."
else
  for file in "${ALL_FILES[@]}"; do
    if [ "$STOP_OUTPUT" = true ]; then
      break
    fi

    debug_msg "Processing file: $file"
    MIME_TYPE=$(file --mime-type -b "$file" 2>/dev/null)
    debug_msg "Detected MIME type: $MIME_TYPE for $file"

    basename_file=$(basename "$file")

    # Summaries for large logs
    if [[ "$basename_file" == "generatedOutputs.json" || "$basename_file" == "evaluationResults.json" ]]; then
      debug_msg "Handling as large logs summary..."
      safe_echo "### File: $file"
      safe_echo '```'
      safe_echo "(Instead of a raw dump, providing summary & sample...)"
      safe_echo '```'
      safe_echo ""
      summarize_generated_outputs "$file"
      continue
    fi

    # Whisper JSON special handling
    if [[ "$basename_file" == "whisper.json" ]]; then
      debug_msg "Attempting whisper.json transform with truncate_whisper_json_with_jq_script..."
      safe_echo "### File: $file"
      safe_echo '```'
      safe_echo "(Processing whisper.json with segment & text truncation...)"
      safe_echo '```'
      safe_echo ""

      if command -v jq >/dev/null 2>&1; then
        run_jq_filter "$truncate_whisper_json_with_jq_script" "$file"
        local_exit_code="$RUN_JQ_EXIT_CODE"
        local_stderr="$RUN_JQ_STDERR"
        local_output="$RUN_JQ_OUTPUT"

        debug_msg "whisper.json transform exit_code=$local_exit_code"
        debug_msg "whisper.json transform output (first 200 chars): ${local_output:0:200}"

        # If exit_code is non-zero or output is empty, fallback
        if [ -n "$local_stderr" ]; then
          debug_msg "run_jq_filter: stderr was: $local_stderr"
        fi

        if [ -z "$local_exit_code" ] || [ "$local_exit_code" -ne 0 ] || [ -z "$local_output" ]; then
          safe_echo "(Warning: Could not parse or transform whisper.json. Showing head/tail...)"
          safe_echo '```'
          head -n 40 "$file" | safe_print_command
          safe_echo "...(omitted)..."
          tail -n 30 "$file" | safe_print_command
          safe_echo '```'
          safe_echo ""
        else
          # Output the transformed JSON
          while IFS= read -r line; do
            if [ "$STOP_OUTPUT" = true ]; then break; fi
            safe_echo "$line"
          done <<< "$local_output"
        fi
      else
        debug_msg "jq not installed."
        safe_echo "(jq not installed; partial head/tail only...)"
        safe_echo '```'
        head -n 40 "$file" | safe_print_command
        safe_echo "...(omitted)..."
        tail -n 30 "$file" | safe_print_command
        safe_echo '```'
        safe_echo ""
      fi
      continue
    fi

    # Otherwise handle normal file
    debug_msg "Handling as $( [[ $MIME_TYPE == text/* || $MIME_TYPE == application/xml ]] && echo 'text' || echo 'JSON/binary/other' )..."
    safe_echo "### File: $file"
    safe_echo '```'

    case "$MIME_TYPE" in
      application/pdf)
        if command -v pdftotext >/dev/null 2>&1; then
          PDF_CONTENT=$(pdftotext "$file" - 2>/dev/null)
          if [ -n "$PDF_CONTENT" ]; then
            while IFS= read -r line; do
              if [ "$STOP_OUTPUT" = true ]; then break; fi
              safe_echo "$line"
            done <<< "$PDF_CONTENT"
          else
            safe_echo "(No embedded text found. Attempting OCR with tesseract...)"
            if command -v tesseract >/dev/null 2>&1; then
              TEMP_TXT=$(mktemp /tmp/ocr.XXXXXX)
              tesseract "$file" "$TEMP_TXT" 2>/dev/null
              if [ -f "${TEMP_TXT}.txt" ]; then
                while IFS= read -r line; do
                  if [ "$STOP_OUTPUT" = true ]; then break; fi
                  safe_echo "$line"
                done < "${TEMP_TXT}.txt"
                rm -f "${TEMP_TXT}.txt"
              else
                safe_echo "(Tesseract failed or produced no output.)"
              fi
            else
              safe_echo "(Tesseract not installed, cannot OCR scanned PDFs.)"
            fi
          fi
        else
          safe_echo "(pdftotext not installed, skipping PDF extraction...)"
        fi
        ;;
      application/json|text/json)
        if command -v jq >/dev/null 2>&1; then
          debug_msg "Handling as JSON..."
          # Check if valid JSON
          if jq empty "$file" 2>/dev/null; then
            # Attempt truncation
            run_jq_filter "$truncate_large_json_with_jq_script" "$file"
            local_exit_code="$RUN_JQ_EXIT_CODE"
            local_stderr="$RUN_JQ_STDERR"
            local_output="$RUN_JQ_OUTPUT"
            debug_msg "JSON transform exit_code=$local_exit_code"
            debug_msg "JSON transform output (first 200 chars or entire if short): ${local_output:0:200}"

            if [ -n "$local_stderr" ]; then
              debug_msg "run_jq_filter: stderr is: $local_stderr"
            fi

            if [ -z "$local_exit_code" ] || [ "$local_exit_code" -ne 0 ] || [ -z "$local_output" ] || [ "$local_output" = "null" ]; then
              safe_echo "(Warning: Our truncation filter returned empty or errored. Showing entire JSON...)"
              cat "$file" | safe_print_command
            else
              while IFS= read -r line; do
                if [ "$STOP_OUTPUT" = true ]; then break; fi
                safe_echo "$line"
              done <<< "$local_output"
            fi
          else
            safe_echo "(File claims to be JSON but 'jq empty' failed. Showing head/tail...)"
            head -n 40 "$file" | safe_print_command
            safe_echo "...(omitted)..."
            tail -n 30 "$file" | safe_print_command
          fi
        else
          safe_echo "(jq not installed; partial head/tail only...)"
          head -n 40 "$file" | safe_print_command
          safe_echo "...(omitted)..."
          tail -n 30 "$file" | safe_print_command
        fi
        ;;
      text/csv)
        dump_csv_file "$file"
        ;;
      text/*|application/xml)
        if [[ "$file" == *.csv || "$file" == *.CSV ]]; then
          dump_csv_file "$file"
        else
          # Print plain text or XML fully
          while IFS= read -r line; do
            if [ "$STOP_OUTPUT" = true ]; then break; fi
            safe_echo "$line"
          done < "$file"
        fi
        ;;
      *)
        case "$file" in
          *.docx|*.DOCX)
            if command -v pandoc >/dev/null 2>&1; then
              safe_echo "(Converted from .docx via pandoc --track-changes=all; showing Markdown with tracked changes & comments where present.)"
              pandoc --track-changes=all "$file" -t markdown 2>/dev/null | safe_print_command
            else
              safe_echo "(pandoc not installed; cannot convert .docx to text. File type is $MIME_TYPE — skipping raw dump.)"
            fi
            ;;
          *)
            safe_echo "(File type is $MIME_TYPE — skipping raw dump.)"
            ;;
        esac
        ;;
    esac

    safe_echo '```'
    safe_echo ""
  done
fi

safe_echo ""
safe_echo "---"
safe_echo ""

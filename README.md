# packet-select

`packet-select` compresses large project trees into frequency-ranked packets by simulating LLM-driven curator meetings. Each run produces meeting minutes, decisions, aggregated vote data, and optional subtrees containing files that were consistently chosen.

## Installation

```bash
npm install
```

## Usage

```bash
packet-select \
  --src-root /path/to/project \
  --prompt-file ./prompts/context.txt \
  --curators "Curator One, Curator Two" \
  --sample-size 4 \
  --model gpt-4.1-mini \
  --out-dir ./packet-select-out
```

Key flags:

- `--src-root` (required): Project root to curate.
- `--prompt-file` or `--prompt` (required): Curatorial instructions.
- `--curators` (required): Comma-separated curator names.
- `--sample-size`: Number of simulated meetings (default 8).
- `--workers`: Max meetings to run concurrently (default 1).
- `--model`: OpenAI model (default `gpt-4.1-mini`).
- `--overview-file`: Provide an existing overview instead of generating one.
- `--build-subtrees-bin`: Path to subtree builder script (default `<repo-root>/scripts/crs_build_subtrees.sh`; relative paths are resolved from the repo root).
- `--no-build-subtrees`: Skip subtree generation.
- `--no-bucket-overviews`: Skip generating `project-overview.txt` inside buckets.
- `--api-key`: OpenAI API key (or set `OPENAI_API_KEY`).
- `--verbose`: Print progress logs.

## Configuring the OpenAI API key

`packet-select` looks for an OpenAI API key in this order:

1. `--api-key` on the command line.
2. The `OPENAI_API_KEY` environment variable (if already exported in the shell).
3. `OPENAI_API_KEY` from a `.env` file in the `packet-select` repo root (loaded automatically at startup).

You can set the environment variable directly:

```bash
export OPENAI_API_KEY=sk-your-openai-api-key
```

Or rely on the repo’s `.env` file:

```bash
cp .env.example .env
$EDITOR .env  # edit OPENAI_API_KEY
# No need to export manually; packet-select will read this file on startup.
```

After that, run `packet-select` (or `node ./bin/packet-select.js`) from any directory and the tool will use the key from `.env` unless
you override it with a shell variable or `--api-key`.

## Example: running against a CRS tree

Suppose your CRS project lives here:

```bash
/Users/jburkart/Library/Mobile Documents/com~apple~CloudDocs/Teams/CRS
```

and you want the `packet-select` output to be written under a date-specific working directory, e.g.:

```bash
/Users/jburkart/Library/Mobile Documents/com~apple~CloudDocs/Teams/CRS/2025-11-21/crs-subtrees
```

One way to run `packet-select` is:

```bash
# From the packet-select repo (once):
npm install

# Configure your API key (once):
cp .env.example .env
$EDITOR .env  # set OPENAI_API_KEY; packet-select loads this automatically

# From your CRS working directory:
cd "/Users/jburkart/Library/Mobile Documents/com~apple~CloudDocs/Teams/CRS/2025-11-21/crs-subtrees"

# Run packet-select against the CRS root, writing outputs into the current directory
node /path/to/packet-select/bin/packet-select.js \
  --src-root "/Users/jburkart/Library/Mobile Documents/com~apple~CloudDocs/Teams/CRS" \
  --prompt-file "/path/to/your/crs-brief.txt" \
  --curators "Curator One, Curator Two" \
  --sample-size 8 \
  --workers 4 \
  --model gpt-4.1-mini \
  --out-dir "$(pwd)"
```

This will:

- Treat `/Users/jburkart/Library/Mobile Documents/com~apple~CloudDocs/Teams/CRS` as the project tree to curate.
- Write all outputs (minutes, decisions, `data/file-frequency.tsv`, `run.json`, and `subtrees/gteNN/...`) under the current `crs-subtrees` directory.
- Use the OpenAI API key from `OPENAI_API_KEY` in your environment.

If you have `packet-select` on your PATH (e.g. via `npm link`), you can replace the `node /path/to/packet-select/bin/packet-select.js` line with:

```bash
packet-select \
  --src-root "/Users/jburkart/Library/Mobile Documents/com~apple~CloudDocs/Teams/CRS" \
  --prompt-file "/path/to/your/crs-brief.txt" \
  --curators "Curator One, Curator Two" \
  --sample-size 8 \
  --workers 4 \
  --model gpt-4.1-mini \
  --out-dir "$(pwd)"
```

Alternatively, you can call the included wrapper script from any directory and let it handle `.env` loading:

```bash
/path/to/packet-select/packet-select-here.sh \
  --src-root "/Users/jburkart/Library/Mobile Documents/com~apple~CloudDocs/Teams/CRS" \
  --prompt-file "/path/to/your/crs-brief.txt" \
  --curators "Curator One, Curator Two" \
  --sample-size 8 \
  --workers 4 \
  --model gpt-4.1-mini \
  --out-dir "$(pwd)"
```

The wrapper defaults to the subtree builder bundled in the repo. If you run `packet-select` directly from another working directory, relative `--build-subtrees-bin` paths are still resolved from the repo root.

## What it produces

A typical run writes files into `--out-dir`:

- `minutes/meeting-XXX.json` and `decisions/decisions-XXX.json` for each meeting.
- `data/file-frequency.tsv` and `data/file-votes.json` summarizing selections.
- `run.json` with metadata about the invocation.
- `subtrees/gteNN/` directories (unless disabled) built from the frequency table.
- Optional per-bucket `project-overview.txt` files if overview generation is available.

## Scripts

Two helper scripts are included:

- `scripts/generate-overview.sh`: Generates a simple `project-overview.txt` with a file listing and short previews.
- `scripts/crs_build_subtrees.sh`: Materializes `gteNN` subtrees using a frequency TSV.

Both scripts are invoked automatically when present (the subtree builder defaults to `<repo-root>/scripts/crs_build_subtrees.sh`; if missing, subtree generation is skipped with a warning), but can also be run directly.

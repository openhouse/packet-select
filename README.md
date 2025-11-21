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
- `--build-subtrees-bin`: Path to subtree builder script (default `./scripts/crs_build_subtrees.sh`).
- `--no-build-subtrees`: Skip subtree generation.
- `--no-bucket-overviews`: Skip generating `project-overview.txt` inside buckets.
- `--api-key`: OpenAI API key (or set `OPENAI_API_KEY`).
- `--verbose`: Print progress logs.

## Configuring the OpenAI API key

`packet-select` looks for an OpenAI API key in one of two places:

- `--api-key` on the command line, or
- the `OPENAI_API_KEY` environment variable.

You can set the environment variable directly:

```bash
export OPENAI_API_KEY=sk-your-openai-api-key
```

Or use the provided `.env.example` file:

```bash
cp .env.example .env
$EDITOR .env  # edit OPENAI_API_KEY
set -a; source .env; set +a
```

After that, run `packet-select` (or `node ./bin/packet-select.js`) and the tool will use the key from the environment.

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

# Configure your API key (once per shell):
cp .env.example .env
$EDITOR .env  # set OPENAI_API_KEY
set -a; source .env; set +a

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

Both scripts are invoked automatically when present, but can also be run directly.

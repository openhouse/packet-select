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

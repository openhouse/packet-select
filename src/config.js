import { parseArgs } from "node:util";
import path from "node:path";

function required(value, message) {
  if (!value) {
    throw new Error(message);
  }
  return value;
}

export function loadConfig(argv) {
  const {
    values,
  } = parseArgs({
    args: argv,
    options: {
      "src-root": { type: "string", short: "s" },
      "prompt-file": { type: "string", short: "p" },
      prompt: { type: "string" },
      curators: { type: "string" },
      "sample-size": { type: "string", short: "n" },
      samples: { type: "string" },
      workers: { type: "string", short: "w" },
      model: { type: "string", short: "m" },
      "out-dir": { type: "string", short: "o" },
      "overview-file": { type: "string" },
      "build-subtrees-bin": { type: "string" },
      "no-build-subtrees": { type: "boolean" },
      "no-bucket-overviews": { type: "boolean" },
      "no-overview-subtrees": { type: "boolean" },
      "api-key": { type: "string" },
      verbose: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: true,
  });

  if (values.help) {
    return { help: true };
  }

  const srcRoot = values["src-root"] ? path.resolve(values["src-root"]) : null;
  const promptText = values.prompt || null;
  const promptFile = values["prompt-file"] ? path.resolve(values["prompt-file"]) : null;
  const curatorsRaw = values.curators || null;
  const curators = curatorsRaw ? curatorsRaw.split(/,\s*/).filter(Boolean) : [];
  const sampleSize = Number(values["sample-size"] || values.samples || 8);
  const workers = Number(values.workers || 1);
  const model = values.model || "gpt-4.1-mini";
  const outDir = path.resolve(values["out-dir"] || "./packet-select-out");
  const overviewFile = values["overview-file"] ? path.resolve(values["overview-file"]) : null;
  const buildSubtreesBin = values["build-subtrees-bin"] || path.resolve("./scripts/crs_build_subtrees.sh");
  const noBuildSubtrees = Boolean(values["no-build-subtrees"]);
  const noBucketOverviews = Boolean(values["no-bucket-overviews"] || values["no-overview-subtrees"]);
  const apiKey = values["api-key"] || process.env.OPENAI_API_KEY || "";
  const verbose = Boolean(values.verbose);

  required(srcRoot, "--src-root is required");
  if (!promptText && !promptFile) {
    throw new Error("Exactly one of --prompt or --prompt-file is required");
  }
  if (promptText && promptFile) {
    throw new Error("Use only one of --prompt or --prompt-file");
  }
  required(curatorsRaw, "--curators is required");
  if (!Number.isInteger(sampleSize) || sampleSize < 1) {
    throw new Error("--sample-size must be a positive integer");
  }
  if (!Number.isInteger(workers) || workers < 1) {
    throw new Error("--workers must be a positive integer");
  }
  if (!apiKey) {
    throw new Error("An OpenAI API key is required via --api-key or OPENAI_API_KEY");
  }

  return {
    help: false,
    srcRoot,
    promptText,
    promptFile,
    curators,
    sampleSize,
    workers: Math.min(workers, sampleSize),
    model,
    outDir,
    overviewFile,
    buildSubtreesBin,
    noBuildSubtrees,
    noBucketOverviews,
    apiKey,
    verbose,
  };
}

export function usage() {
  return `packet-select \n\
  --src-root <dir> \n\
  (--prompt-file <file> | --prompt <text>) \n\
  --curators "Name1, Name2" \n\
  [--sample-size <int>] [--workers <int>] [--model <id>] \n\
  [--out-dir <dir>] [--overview-file <file>] [--build-subtrees-bin <path>] \n\
  [--no-build-subtrees] [--no-bucket-overviews] [--api-key <key>] [--verbose]`;
}

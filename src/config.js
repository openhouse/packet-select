import { parseArgs } from "node:util";
import path from "node:path";

function required(value, message) {
  if (!value) {
    throw new Error(message);
  }
  return value;
}

export const MODEL_PROFILES = {
  "gpt-5.4": { maxInputTokens: 400000, maxOutputTokens: 128000, highReasoningReserve: 65536 },
  "gpt-5": { maxInputTokens: 400000, maxOutputTokens: 128000, highReasoningReserve: 65536 },
};

function resolveModelProfile(model) {
  const exact = MODEL_PROFILES[model];
  if (exact) return exact;
  if (typeof model === "string" && model.startsWith("gpt-5")) return MODEL_PROFILES["gpt-5"];
  return { maxInputTokens: 200000, maxOutputTokens: 32768, highReasoningReserve: 16384 };
}

export function normalizeReasoningEffort(model, requested) {
  const isGpt5 = typeof model === "string" && model.startsWith("gpt-5");
  if (!isGpt5) return null;
  if (requested === "auto") return "high";
  if (requested === "minimal") return "low";
  return requested;
}

export function deriveOutputReserve({ requestedReasoningEffort, reasoningEffort, reserveOutputTokens, maxOutputTokens, model }) {
  const profile = resolveModelProfile(model);
  if (reserveOutputTokens != null) return reserveOutputTokens;
  if (maxOutputTokens != null) return Math.max(maxOutputTokens, reasoningEffort === "high" || requestedReasoningEffort === "high" ? profile.highReasoningReserve : Math.min(profile.maxOutputTokens, 8192));
  if (reasoningEffort === "high" || requestedReasoningEffort === "high") return profile.highReasoningReserve;
  return 8192;
}

export function loadConfig(argv) {
  const ALLOWED_REASONING_EFFORTS = ["minimal", "low", "medium", "high", "auto", "none"];

  const { values } = parseArgs({
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
      "meeting-size": { type: "string" },
      "build-subtrees-bin": { type: "string" },
      "no-build-subtrees": { type: "boolean" },
      "no-bucket-overviews": { type: "boolean" },
      "no-overview-subtrees": { type: "boolean" },
      "api-key": { type: "string" },
      "cross-pollinate": { type: "boolean" },
      "reasoning-effort": { type: "string" },
      "max-input-tokens": { type: "string" },
      "target-input-tokens": { type: "string" },
      "max-overview-tokens": { type: "string" },
      "reserve-output-tokens": { type: "string" },
      "max-output-tokens": { type: "string" },
      "tpm-limit": { type: "string" },
      "tpm-budget": { type: "string" },
      "max-tokens-per-minute": { type: "string" },
      "max-requests-per-minute": { type: "string" },
      "scheduler-utilization": { type: "string" },
      "request-timeout-ms": { type: "string" },
      "timeout-ms": { type: "string" },
      "max-retries": { type: "string" },
      "dry-run": { type: "boolean" },
      "prompt-cache-key": { type: "string" },
      "prompt-cache-retention": { type: "string" },
      "no-prompt-cache": { type: "boolean" },
      verbose: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: true,
  });

  if (values.help) return { help: true };

  const srcRoot = values["src-root"] ? path.resolve(values["src-root"]) : null;
  const promptText = values.prompt || null;
  const promptFile = values["prompt-file"] ? path.resolve(values["prompt-file"]) : null;
  const curatorsRaw = values.curators || null;
  const curators = curatorsRaw ? curatorsRaw.split(/,\s*/).filter(Boolean) : [];
  const sampleSize = Number(values["sample-size"] || values.samples || 8);
  const meetingSize = values["meeting-size"] !== undefined ? Number(values["meeting-size"]) : undefined;
  const workers = Number(values.workers || 1);
  const model = values.model || "gpt-5.4";
  const profile = resolveModelProfile(model);
  const outDir = path.resolve(values["out-dir"] || "./packet-select-out");
  const overviewFile = values["overview-file"] ? path.resolve(values["overview-file"]) : null;
  const buildSubtreesBin = values["build-subtrees-bin"] || null;
  const noBuildSubtrees = Boolean(values["no-build-subtrees"]);
  const noBucketOverviews = Boolean(values["no-bucket-overviews"] || values["no-overview-subtrees"]);
  const apiKey = values["api-key"] || process.env.OPENAI_API_KEY || "";
  const verbose = Boolean(values.verbose);
  const requestedReasoningEffort = values["reasoning-effort"] || "high";
  const reasoningEffort = normalizeReasoningEffort(model, requestedReasoningEffort);
  const crossPollinate = Boolean(values["cross-pollinate"]);
  const maxInputTokens = Number(values["max-input-tokens"] || values["target-input-tokens"] || profile.maxInputTokens);
  const maxOverviewTokens = values["max-overview-tokens"] !== undefined ? Number(values["max-overview-tokens"]) : null;
  const configuredMaxOutputTokens = values["max-output-tokens"] !== undefined ? Number(values["max-output-tokens"]) : null;
  const configuredReserveOutputTokens = values["reserve-output-tokens"] !== undefined ? Number(values["reserve-output-tokens"]) : null;
  const reserveOutputTokens = deriveOutputReserve({ requestedReasoningEffort, reasoningEffort, reserveOutputTokens: configuredReserveOutputTokens, maxOutputTokens: configuredMaxOutputTokens, model });
  const maxOutputTokens = configuredMaxOutputTokens ?? Math.min(profile.maxOutputTokens, reserveOutputTokens);
  const tpmLimit = values["tpm-limit"] || values["tpm-budget"] || values["max-tokens-per-minute"] || process.env.OPENAI_TPM_LIMIT || null;
  const rpmLimit = values["max-requests-per-minute"] || process.env.OPENAI_RPM_LIMIT || null;
  const schedulerUtilization = Number(values["scheduler-utilization"] || process.env.PACKET_SELECT_SCHEDULER_UTILIZATION || 0.8);
  const requestTimeoutMs = Number(values["request-timeout-ms"] || values["timeout-ms"] || 900000);
  const maxRetries = Number(values["max-retries"] || 5);
  const dryRun = Boolean(values["dry-run"]);
  const promptCacheKey = values["prompt-cache-key"] || process.env.PACKET_SELECT_PROMPT_CACHE_KEY || null;
  const promptCacheRetention = values["prompt-cache-retention"] || process.env.PACKET_SELECT_PROMPT_CACHE_RETENTION || null;
  const noPromptCache = Boolean(values["no-prompt-cache"]);

  required(srcRoot, "--src-root is required");
  if (!promptText && !promptFile) throw new Error("Exactly one of --prompt or --prompt-file is required");
  if (promptText && promptFile) throw new Error("Use only one of --prompt or --prompt-file");
  required(curatorsRaw, "--curators is required");
  if (!Number.isInteger(sampleSize) || sampleSize < 1) throw new Error("--sample-size must be a positive integer");
  if (meetingSize !== undefined && (!Number.isInteger(meetingSize) || meetingSize < 1)) throw new Error("--meeting-size must be a positive integer");
  if (!Number.isInteger(workers) || workers < 1) throw new Error("--workers must be a positive integer");
  if (!apiKey && !dryRun) throw new Error("An OpenAI API key is required via --api-key or OPENAI_API_KEY unless --dry-run is used");
  if (!ALLOWED_REASONING_EFFORTS.includes(requestedReasoningEffort)) {
    throw new Error(`Invalid --reasoning-effort "${requestedReasoningEffort}". Expected one of: ${ALLOWED_REASONING_EFFORTS.join(", ")}.`);
  }
  if (crossPollinate && curators.length < 2) throw new Error("--cross-pollinate requires at least two curators");
  if (crossPollinate) {
    const k = meetingSize ?? 2;
    if (k < 2) throw new Error("--meeting-size must be at least 2 when using --cross-pollinate");
    if (k > curators.length) throw new Error(`--meeting-size (${k}) cannot exceed number of curators (${curators.length})`);
  }
  for (const [name, value] of [["--max-input-tokens", maxInputTokens], ["--reserve-output-tokens", reserveOutputTokens], ["--max-output-tokens", maxOutputTokens], ["--request-timeout-ms", requestTimeoutMs], ["--max-retries", maxRetries], ["--scheduler-utilization", schedulerUtilization]]) {
    if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be a non-negative number`);
  }
  if (maxOverviewTokens !== null && (!Number.isFinite(maxOverviewTokens) || maxOverviewTokens < 0)) throw new Error("--max-overview-tokens must be a non-negative number");
  if (schedulerUtilization <= 0 || schedulerUtilization > 1) throw new Error("--scheduler-utilization must be between 0 and 1");

  return {
    help: false,
    srcRoot,
    promptText,
    promptFile,
    curators,
    sampleSize,
    workers,
    model,
    modelProfile: profile,
    outDir,
    overviewFile,
    buildSubtreesBin,
    noBuildSubtrees,
    noBucketOverviews,
    apiKey,
    verbose,
    crossPollinate,
    meetingSize,
    reasoningEffort,
    requestedReasoningEffort,
    maxInputTokens,
    maxOverviewTokens,
    reserveOutputTokens,
    maxOutputTokens,
    tpmLimit: tpmLimit === null ? null : Number(tpmLimit),
    rpmLimit: rpmLimit === null ? null : Number(rpmLimit),
    schedulerUtilization,
    requestTimeoutMs,
    maxRetries,
    dryRun,
    promptCacheKey,
    promptCacheRetention,
    noPromptCache,
  };
}

export function usage() {
  return `packet-select \n\
  --src-root <dir> \n\
  (--prompt-file <file> | --prompt <text>) \n\
  --curators "Name1, Name2" \n\
  [--sample-size <int>] [--meeting-size <int>] [--workers <int>] [--model <id>] \n\
  [--out-dir <dir>] [--overview-file <file>] [--build-subtrees-bin <path>] \n\
  [--no-build-subtrees] [--no-bucket-overviews] [--api-key <key>] [--verbose] \n\
  [--cross-pollinate] [--reasoning-effort <none|minimal|low|medium|high|auto>] \n\
  [--max-input-tokens <int>] [--max-overview-tokens <int>] [--reserve-output-tokens <int>] [--max-output-tokens <int>] \n\
  [--tpm-limit <int>] [--max-requests-per-minute <int>] [--scheduler-utilization <0-1>] [--request-timeout-ms <int>] [--max-retries <int>] [--dry-run] \n\
  [--prompt-cache-key <string>] [--prompt-cache-retention <ttl>] [--no-prompt-cache]`;
}

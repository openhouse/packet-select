import fs from "node:fs/promises";
import path from "node:path";
import { normalizeRelativePath, padIndex, logInfo, logWarn } from "./utils.js";
import { computeBackoffDelayMs, sleep } from "./rateLimiter.js";
import { estimateTokens } from "./contextBudget.js";

const OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["curators", "run_index", "sample_size", "summary", "minutes", "decisions"],
  properties: {
    curators: { type: "array", items: { type: "string" } },
    run_index: { type: "number" },
    sample_size: { type: "number" },
    summary: { type: "string" },
    minutes: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["speaker", "text"],
        properties: { speaker: { type: "string" }, text: { type: "string" } },
      },
    },
    decisions: {
      type: "object",
      additionalProperties: false,
      required: ["packet_summary", "keep"],
      properties: {
        packet_summary: { type: "string" },
        keep: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["path", "reason"],
            properties: { path: { type: "string" }, reason: { type: "string" } },
          },
        },
      },
    },
  },
};

export function buildMeetingInput({ curators, promptText, overviewText, manifestText, srcRoot, sampleSize, runIndex, fileCount, round, meetingMode, meetingSize }) {
  const instructions = [
    "You are moderating a round-table discussion among curator panelists.",
    "Return concise structured JSON only.",
    `All file paths must be relative to ${srcRoot} and must come from the provided manifest. Do not invent paths.`,
    "Keep minutes brief and selection reasons specific.",
  ].join(" ");

  const curatorBrief = [
    "Curatorial brief:",
    promptText.trim(),
    "",
    `Project root: ${srcRoot}`,
    `Total known files: ${fileCount}`,
    "Project manifest (JSONL; full file list):",
    manifestText.trim(),
    "",
    "Project overview digest:",
    overviewText.trim(),
    "",
    `Meeting mode: ${meetingMode}`,
    `Meeting size: ${meetingSize || curators.length}`,
    `Run index: ${runIndex}/${sampleSize}`,
    `Round: ${round}`,
    `Curators: ${curators.join(", ")}`,
  ].join("\n");

  return {
    instructions,
    input: [{ role: "user", content: [{ type: "input_text", text: curatorBrief }] }],
  };
}

export async function estimateRequestTokens({ client, model, input, maxOutputTokens, verbose }) {
  if (typeof client.responses?.countTokens === "function") {
    const result = await client.responses.countTokens({ model, input, max_output_tokens: maxOutputTokens });
    return { inputTokens: result.input_tokens, method: "exact" };
  }
  logWarn("Exact token counting API unavailable in this SDK/runtime; falling back to heuristic token estimates.");
  const serialized = JSON.stringify({ model, input, max_output_tokens: maxOutputTokens });
  return { inputTokens: estimateTokens(serialized), method: "heuristic", warning: true };
}

function getRetryAfterMs(error) {
  const header = error?.headers?.["retry-after"] || error?.response?.headers?.get?.("retry-after") || null;
  if (!header) return null;
  const seconds = Number(header);
  return Number.isFinite(seconds) ? seconds * 1000 : null;
}

function isRetryableError(error) {
  const status = error?.status || error?.response?.status || null;
  return status === 408 || status === 409 || status === 429 || status >= 500 || error?.code === "ETIMEDOUT" || /timeout|timed out|ECONNRESET|socket hang up/i.test(error?.message || "");
}

export async function runMeeting({
  client,
  model,
  curators,
  promptText,
  overviewText,
  manifestText,
  srcRoot,
  sampleSize,
  runIndex,
  meetingMode = "group",
  round = 1,
  meetingSize = null,
  fileSet,
  minutesDir,
  decisionsDir,
  errorsDir,
  verbose,
  reasoningEffort,
  maxOutputTokens,
  requestTimeoutMs,
  maxRetries,
  estimatedInputTokens,
  promptCacheKey,
}) {
  const request = buildMeetingInput({ curators, promptText, overviewText, manifestText, srcRoot, sampleSize, runIndex, fileCount: fileSet.size, round, meetingMode, meetingSize });
  logInfo(verbose, `Starting meeting ${runIndex}/${sampleSize}`);

  let response;
  let attempt = 0;
  while (attempt <= maxRetries) {
    attempt += 1;
    try {
      response = await client.responses.create({
        model,
        store: false,
        max_output_tokens: maxOutputTokens,
        instructions: request.instructions,
        input: request.input,
        text: {
          format: {
            type: "json_schema",
            name: "packet_select_meeting",
            schema: OUTPUT_SCHEMA,
            strict: true,
          },
        },
        ...(reasoningEffort && reasoningEffort !== "none" ? { reasoning: { effort: reasoningEffort } } : {}),
        ...(promptCacheKey ? { prompt_cache_key: promptCacheKey, prompt_cache_retention: "24h" } : {}),
      }, { timeout: requestTimeoutMs });
      break;
    } catch (error) {
      if (attempt > maxRetries || !isRetryableError(error)) throw error;
      const delayMs = computeBackoffDelayMs({ attempt, retryAfterMs: getRetryAfterMs(error) });
      logWarn(`Meeting ${runIndex} retrying in ${delayMs}ms after attempt ${attempt} (${error.message})`);
      await sleep(delayMs);
    }
  }

  const outputText = response.output_text || "";
  let parsed;
  try {
    parsed = JSON.parse(outputText);
  } catch (error) {
    await fs.mkdir(errorsDir, { recursive: true });
    const errorPath = path.join(errorsDir, `meeting-${padIndex(runIndex, 3)}.txt`);
    await fs.writeFile(errorPath, outputText, "utf8");
    throw new Error(`Failed to parse JSON for meeting ${runIndex}: ${error.message}`);
  }

  const keepEntries = (parsed.decisions?.keep || []).map((item) => ({
    path: normalizeRelativePath(item.path),
    reason: item.reason || "",
  })).filter((item) => item.path);

  const filteredKeep = [];
  for (const entry of keepEntries) {
    if (!fileSet.has(entry.path)) {
      logWarn(`Meeting ${runIndex} referenced unknown path: ${entry.path}`);
      continue;
    }
    filteredKeep.push(entry);
  }

  const usage = response.usage || {};
  const responseId = response.id || null;
  const minutesPayload = {
    meetingIndex: runIndex,
    sampleSize,
    round,
    mode: meetingMode,
    meetingSize: meetingSize || curators.length,
    curators,
    prompt: "[omitted inline]",
    summary: parsed.summary || "",
    minutes: parsed.minutes || [],
    request: {
      id: responseId,
      estimatedInputTokens,
      inputTokens: usage.input_tokens || null,
      cachedTokens: usage.input_tokens_details?.cached_tokens || null,
      outputTokens: usage.output_tokens || null,
      retries: Math.max(0, attempt - 1),
      timeoutMs: requestTimeoutMs,
    },
  };

  const decisionsPayload = {
    meetingIndex: runIndex,
    sampleSize,
    round,
    mode: meetingMode,
    meetingSize: meetingSize || curators.length,
    curators,
    packetSummary: parsed.decisions?.packet_summary || "",
    keep: filteredKeep,
  };

  await fs.mkdir(minutesDir, { recursive: true });
  await fs.mkdir(decisionsDir, { recursive: true });
  const indexStr = padIndex(runIndex, Math.max(3, String(sampleSize).length));
  await fs.writeFile(path.join(minutesDir, `meeting-${indexStr}.json`), JSON.stringify(minutesPayload, null, 2));
  await fs.writeFile(path.join(decisionsDir, `decisions-${indexStr}.json`), JSON.stringify(decisionsPayload, null, 2));

  logInfo(verbose, `Finished meeting ${runIndex} with ${filteredKeep.length} keep decisions (request ${responseId || "n/a"})`);
  return { minutesPayload, decisionsPayload, usage, responseId };
}

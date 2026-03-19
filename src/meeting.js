import fs from "node:fs/promises";
import path from "node:path";
import { normalizeRelativePath, canonicalizeRelativePath, findNearestManifestMatches, padIndex, logInfo, logWarn } from "./utils.js";
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

const OUTPUT_RETRY_LADDER = [8192, 16384, 32768, 65536, 98304, 128000];

export class MeetingIncompleteError extends Error {
  constructor(message, diagnostics = {}) {
    super(message);
    this.name = "MeetingIncompleteError";
    this.diagnostics = diagnostics;
    this.deterministic = true;
    this.isDeterministicIncomplete = true;
  }
}

export function buildMeetingInput({ curators, promptText, overviewText, manifestText, srcRoot, sampleSize, runIndex, fileCount, round, meetingMode, meetingSize }) {
  const instructions = [
    "You are moderating a round-table discussion among curator panelists.",
    "Return concise structured JSON only.",
    `All file paths must be relative to ${srcRoot} and must come from the provided manifest. Do not invent paths.`,
    "Keep minutes terse and selection reasons specific.",
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

export function buildMeetingRequest({ model, request, maxOutputTokens, reasoningEffort, promptCache }) {
  const payload = {
    model,
    store: false,
    max_output_tokens: maxOutputTokens,
    instructions: request.instructions,
    input: request.input,
    text: {
      verbosity: "low",
      format: {
        type: "json_schema",
        name: "packet_select_meeting",
        schema: OUTPUT_SCHEMA,
        strict: true,
      },
    },
    ...(reasoningEffort && reasoningEffort !== "none" ? { reasoning: { effort: reasoningEffort } } : {}),
  };

  if (promptCache?.key) {
    payload.prompt_cache_key = promptCache.key;
    if (promptCache.retention) payload.prompt_cache_retention = promptCache.retention;
  }

  return payload;
}

async function countViaHttpFallback({ payload, apiKey, baseUrl, fetchImpl }) {
  if (!apiKey || typeof fetchImpl !== "function") return null;
  const response = await fetchImpl(`${baseUrl || "https://api.openai.com"}/v1/responses/input_tokens`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Responses input-token fallback failed (${response.status}): ${text || response.statusText}`);
  }
  const data = await response.json();
  return { inputTokens: data.input_tokens, method: "exact_rest_fallback" };
}

export async function estimateRequestTokens({ client, model, request, maxOutputTokens, reasoningEffort, promptCache, verbose, apiKey = null, baseUrl = null, fetchImpl = globalThis.fetch }) {
  const payload = buildMeetingRequest({ model, request, maxOutputTokens, reasoningEffort, promptCache });
  if (typeof client.responses?.inputTokens?.count === "function") {
    const result = await client.responses.inputTokens.count(payload);
    logInfo(verbose, "Token counting mode: exact SDK Responses input-token count");
    return { inputTokens: result.input_tokens, method: "exact_sdk" };
  }
  try {
    const fallback = await countViaHttpFallback({ payload, apiKey, baseUrl, fetchImpl });
    if (fallback) {
      logInfo(verbose, "Token counting mode: exact REST Responses input-token count fallback");
      return fallback;
    }
  } catch (error) {
    logWarn(`${error.message}; falling back to heuristic token estimate.`);
  }
  logWarn("Exact Responses input-token counting unavailable in this SDK/runtime; falling back to heuristic token estimates.");
  const serialized = JSON.stringify(payload);
  return { inputTokens: estimateTokens(serialized), method: "heuristic", warning: true, serializedBytes: Buffer.byteLength(serialized, "utf8") };
}

function getRetryAfterMs(error) {
  const header = error?.headers?.["retry-after"] || error?.response?.headers?.get?.("retry-after") || null;
  if (!header) return null;
  const seconds = Number(header);
  return Number.isFinite(seconds) ? seconds * 1000 : null;
}

export function isRetryableError(error) {
  const status = error?.status || error?.response?.status || null;
  return status === 408 || status === 409 || status === 429 || status >= 500 || error?.code === "ETIMEDOUT" || /timeout|timed out|ECONNRESET|socket hang up/i.test(error?.message || "");
}

export function isDeterministicRequestError(error) {
  const status = error?.status || error?.response?.status || null;
  if (status !== 400 && status !== 422) return false;
  const message = String(error?.message || "");
  return /prompt_cache_key|prompt_cache_retention|invalid.+schema|invalid.+request|invalid.+param|json_schema|validation/i.test(message);
}

export function isDeterministicIncompleteError(error) {
  return Boolean(error?.isDeterministicIncomplete);
}

function buildResponseDiagnostics({ runIndex, response, outputText, maxOutputTokens, reasoningEffort, parseError = null, retryCount = 0, tokenCountMethod = null, promptCache = null }) {
  const usage = response?.usage || {};
  const outputItems = Array.isArray(response?.output)
    ? response.output.map((item) => ({ id: item?.id || null, type: item?.type || null, status: item?.status || null }))
    : [];
  return {
    meetingIndex: runIndex,
    responseId: response?.id || null,
    status: response?.status || null,
    incomplete_details: response?.incomplete_details || null,
    error: response?.error || null,
    maxOutputTokens,
    reasoningEffort,
    usage,
    reasoningTokens: usage?.output_tokens_details?.reasoning_tokens ?? null,
    outputTextLength: outputText.length,
    outputTextBytes: Buffer.byteLength(outputText, "utf8"),
    outputPreviewStart: outputText.slice(0, 1000),
    outputPreviewEnd: outputText.slice(-1000),
    outputItems,
    retryCount,
    tokenCountMethod,
    promptCache,
    parseError: parseError ? { message: parseError.message, name: parseError.name } : null,
  };
}

async function writeDiagnosticsArtifacts({ errorsDir, runIndex, response, outputText, diagnostics }) {
  await fs.mkdir(errorsDir, { recursive: true });
  const indexStr = padIndex(runIndex, 3);
  await fs.writeFile(path.join(errorsDir, `meeting-${indexStr}.response.json`), JSON.stringify(response, null, 2), "utf8");
  await fs.writeFile(path.join(errorsDir, `meeting-${indexStr}.output.txt`), outputText, "utf8");
  await fs.writeFile(path.join(errorsDir, `meeting-${indexStr}.diagnostic.json`), JSON.stringify(diagnostics, null, 2), "utf8");
}

export function nextOutputTokenBudget(current, ladder = OUTPUT_RETRY_LADDER) {
  return ladder.find((value) => value > current) || null;
}

export async function parseMeetingResponse({ response, runIndex, errorsDir, maxOutputTokens, reasoningEffort, retryCount = 0, tokenCountMethod = null, promptCache = null }) {
  const outputText = response?.output_text || "";
  const status = response?.status || null;
  if (status && status !== "completed") {
    const diagnostics = buildResponseDiagnostics({ runIndex, response, outputText, maxOutputTokens, reasoningEffort, retryCount, tokenCountMethod, promptCache });
    await writeDiagnosticsArtifacts({ errorsDir, runIndex, response, outputText, diagnostics });
    const reason = response?.incomplete_details?.reason || response?.incomplete_details?.code || status;
    throw new MeetingIncompleteError(`Response incomplete before JSON parse (likely max_output_tokens exhaustion). Meeting ${runIndex}: ${reason}`, diagnostics);
  }

  try {
    return { parsed: JSON.parse(outputText), outputText, diagnostics: buildResponseDiagnostics({ runIndex, response, outputText, maxOutputTokens, reasoningEffort, retryCount, tokenCountMethod, promptCache }) };
  } catch (error) {
    const diagnostics = buildResponseDiagnostics({ runIndex, response, outputText, maxOutputTokens, reasoningEffort, parseError: error, retryCount, tokenCountMethod, promptCache });
    await writeDiagnosticsArtifacts({ errorsDir, runIndex, response, outputText, diagnostics });
    throw new Error(`Failed to parse JSON for meeting ${runIndex}: ${error.message}`);
  }
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
  canonicalFileMap = null,
  minutesDir,
  decisionsDir,
  errorsDir,
  verbose,
  reasoningEffort,
  maxOutputTokens,
  requestTimeoutMs,
  maxRetries,
  estimatedInputTokens,
  promptCache,
  tokenCountMethod = null,
  outputRetryLadder = OUTPUT_RETRY_LADDER,
}) {
  const request = buildMeetingInput({ curators, promptText, overviewText, manifestText, srcRoot, sampleSize, runIndex, fileCount: fileSet.size, round, meetingMode, meetingSize });
  logInfo(verbose, `Starting meeting ${runIndex}/${sampleSize}`);

  let response;
  let attempt = 0;
  let activeMaxOutputTokens = maxOutputTokens;
  let outputBudgetRetries = 0;
  while (true) {
    const payload = buildMeetingRequest({ model, request, maxOutputTokens: activeMaxOutputTokens, reasoningEffort, promptCache });
    attempt = 0;
    while (attempt <= maxRetries) {
      attempt += 1;
      try {
        response = await client.responses.create(payload, { timeout: requestTimeoutMs });
        break;
      } catch (error) {
        if (attempt > maxRetries || !isRetryableError(error)) throw error;
        const delayMs = computeBackoffDelayMs({ attempt, retryAfterMs: getRetryAfterMs(error) });
        logWarn(`Meeting ${runIndex} retrying in ${delayMs}ms after attempt ${attempt} (${error.message})`);
        await sleep(delayMs);
      }
    }

    try {
      const { parsed, diagnostics } = await parseMeetingResponse({ response, runIndex, errorsDir, maxOutputTokens: activeMaxOutputTokens, reasoningEffort, retryCount: outputBudgetRetries, tokenCountMethod, promptCache });
      const keepEntries = (parsed.decisions?.keep || []).map((item) => ({
        path: normalizeRelativePath(item.path),
        reason: item.reason || "",
      })).filter((item) => item.path);

      const filteredKeep = [];
      for (const entry of keepEntries) {
        const canonical = canonicalizeRelativePath(entry.path);
        const resolvedPath = fileSet.has(entry.path)
          ? entry.path
          : (canonicalFileMap?.get(canonical) || null);
        if (!resolvedPath) {
          const matches = findNearestManifestMatches(entry.path, fileSet, canonicalFileMap).join(", ");
          logWarn(`Meeting ${runIndex} referenced unknown path: ${entry.path}${matches ? ` (nearest: ${matches})` : ""}`);
          continue;
        }
        filteredKeep.push({ ...entry, path: resolvedPath });
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
          reasoningTokens: usage.output_tokens_details?.reasoning_tokens || null,
          status: response.status || null,
          incompleteDetails: response.incomplete_details || null,
          retries: Math.max(0, attempt - 1) + outputBudgetRetries,
          timeoutMs: requestTimeoutMs,
          tokenCountMethod,
          promptCache: promptCache?.key ? { enabled: true, retention: promptCache.retention || null, status: usage.input_tokens_details?.cached_tokens ? "hit_or_partial_hit" : "miss_or_unknown" } : { enabled: false },
        },
        parseOutcome: "completed",
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
        response: {
          id: responseId,
          status: response.status || null,
          incompleteDetails: response.incomplete_details || null,
          usage,
          outputTextLength: diagnostics.outputTextLength,
          promptCacheUsed: Boolean(promptCache?.key),
          retries: outputBudgetRetries,
        },
      };

      await fs.mkdir(minutesDir, { recursive: true });
      await fs.mkdir(decisionsDir, { recursive: true });
      const indexStr = padIndex(runIndex, Math.max(3, String(sampleSize).length));
      await fs.writeFile(path.join(minutesDir, `meeting-${indexStr}.json`), JSON.stringify(minutesPayload, null, 2));
      await fs.writeFile(path.join(decisionsDir, `decisions-${indexStr}.json`), JSON.stringify(decisionsPayload, null, 2));

      logInfo(verbose, `Finished meeting ${runIndex} with ${filteredKeep.length} keep decisions (request ${responseId || "n/a"})`);
      return { minutesPayload, decisionsPayload, usage, responseId, maxOutputTokens: activeMaxOutputTokens, retries: outputBudgetRetries };
    } catch (error) {
      const reason = error?.diagnostics?.incomplete_details?.reason || error?.diagnostics?.incomplete_details?.code || null;
      const nextBudget = reason && /max[_-]?output|max[_-]?tokens?/i.test(reason) ? nextOutputTokenBudget(activeMaxOutputTokens, outputRetryLadder) : null;
      if (error instanceof MeetingIncompleteError && nextBudget) {
        logWarn(`Meeting ${runIndex} incomplete with ${activeMaxOutputTokens} max_output_tokens; retrying with ${nextBudget}.`);
        activeMaxOutputTokens = nextBudget;
        outputBudgetRetries += 1;
        continue;
      }
      throw error;
    }
  }
}

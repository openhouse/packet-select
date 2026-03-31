import fs from "node:fs/promises";
import path from "node:path";
import { createReadStream } from "node:fs";
import { materializeMeetingResponse, buildMeetingInput, buildMeetingRequest } from "./meeting.js";
import { padIndex } from "./utils.js";

export const BATCH_LIMITS = {
  maxRequestsPerShard: 45000,
  maxBytesPerShard: 180 * 1024 * 1024,
};

const TERMINAL_BATCH_STATUSES = new Set(["completed", "failed", "expired", "cancelled"]);
const ACTIVE_BATCH_STATUSES = new Set(["validating", "in_progress", "finalizing", "cancelling"]);

export function buildCustomId({ meetingIndex, attempt = 0, width = 6 }) {
  return `meeting-${padIndex(meetingIndex, width)}-attempt-${attempt}`;
}

export function parseCustomId(customId) {
  const match = String(customId || "").match(/^meeting-(\d+)-attempt-(\d+)$/);
  if (!match) return null;
  return { meetingIndex: Number(match[1]), attempt: Number(match[2]) };
}

export function buildBatchRequestLine({ customId, payload }) {
  return { custom_id: customId, method: "POST", url: "/v1/responses", body: payload };
}

export function encodeJsonlLine(line) {
  return `${JSON.stringify(line)}\n`;
}

export function shardBatchRequests(lines, limits = BATCH_LIMITS) {
  const shards = [];
  let current = [];
  let currentBytes = 0;

  for (const line of lines) {
    const encoded = encodeJsonlLine(line);
    const bytes = Buffer.byteLength(encoded, "utf8");
    if (bytes > limits.maxBytesPerShard) {
      throw new Error(`Single batch request exceeds shard byte limit: custom_id=${line.custom_id}, lineBytes=${bytes}, maxShardBytes=${limits.maxBytesPerShard}`);
    }
    const wouldExceedCount = current.length >= limits.maxRequestsPerShard;
    const wouldExceedBytes = currentBytes + bytes > limits.maxBytesPerShard;
    if (current.length > 0 && (wouldExceedCount || wouldExceedBytes)) {
      shards.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(line);
    currentBytes += bytes;
  }
  if (current.length > 0) shards.push(current);
  return shards;
}

export async function writeBatchInputJsonl({ outDir, shards }) {
  const batchDir = path.join(outDir, "batch");
  const requestsDir = path.join(batchDir, "requests");
  await fs.mkdir(requestsDir, { recursive: true });
  const files = [];
  for (let i = 0; i < shards.length; i += 1) {
    const shardIndex = i + 1;
    const filePath = path.join(requestsDir, `input-${padIndex(shardIndex, 3)}.jsonl`);
    const content = shards[i].map((line) => encodeJsonlLine(line)).join("");
    await fs.writeFile(filePath, content, "utf8");
    files.push({ shardIndex, filePath, requestCount: shards[i].length, bytes: Buffer.byteLength(content, "utf8") });
  }
  return files;
}

export async function stageBatchRequests({ meetings, sampleSize, buildArgs, limits = BATCH_LIMITS, outDir }) {
  const width = Math.max(3, String(sampleSize).length);
  const meetingMap = {};
  const lines = meetings.map((meeting) => {
    const customId = buildCustomId({ meetingIndex: meeting.index, attempt: 0, width });
    const request = buildMeetingInput({
      curators: meeting.curators,
      promptText: buildArgs.promptText,
      overviewText: buildArgs.overviewText,
      manifestText: buildArgs.manifestText,
      srcRoot: buildArgs.srcRoot,
      sampleSize,
      runIndex: meeting.index,
      fileCount: buildArgs.fileCount,
      round: meeting.round,
      meetingMode: buildArgs.meetingMode,
      meetingSize: meeting.meetingSize,
    });
    const payload = buildMeetingRequest({
      model: buildArgs.model,
      request,
      maxOutputTokens: buildArgs.maxOutputTokens,
      reasoningEffort: buildArgs.reasoningEffort,
      promptCache: buildArgs.promptCache,
    });
    meetingMap[customId] = {
      meetingIndex: meeting.index,
      round: meeting.round,
      meetingMode: buildArgs.meetingMode,
      meetingSize: meeting.meetingSize,
      curators: meeting.curators,
      estimatedInputTokens: buildArgs.estimatedInputTokens,
      tokenCountMethod: buildArgs.tokenCountMethod,
      requestedMaxOutputTokens: buildArgs.maxOutputTokens,
    };
    return buildBatchRequestLine({ customId, payload });
  });

  const totalInputBytes = lines.reduce((sum, line) => sum + Buffer.byteLength(encodeJsonlLine(line), "utf8"), 0);
  const shards = shardBatchRequests(lines, limits);
  const files = await writeBatchInputJsonl({ outDir, shards });

  const batchDir = path.join(outDir, "batch");
  await fs.mkdir(batchDir, { recursive: true });
  const mapPath = path.join(batchDir, "meeting-map.json");
  await fs.writeFile(mapPath, JSON.stringify(meetingMap, null, 2), "utf8");

  return { lines, meetingMap, shards, files, mapPath, totalInputBytes };
}

export async function writeBatchState({ statePath, state }) {
  await fs.mkdir(path.dirname(statePath), { recursive: true });
  await fs.writeFile(statePath, JSON.stringify(state, null, 2), "utf8");
}

export async function loadBatchState(statePath) {
  const content = await fs.readFile(statePath, "utf8");
  return JSON.parse(content);
}

export async function submitBatchShards({ client, statePath, stagedFiles, model, metadata = {}, dryRun = false }) {
  const now = new Date().toISOString();
  const baseState = {
    version: 1,
    model,
    createdAt: now,
    updatedAt: now,
    shards: stagedFiles.map((file) => ({ ...file, inputFileId: null, batchId: null, status: "staged", outputFileId: null, errorFileId: null })),
  };
  await writeBatchState({ statePath, state: baseState });
  if (dryRun) return baseState;

  for (const shard of baseState.shards) {
    const uploaded = await client.files.create({ file: createReadStream(shard.filePath), purpose: "batch" });
    shard.inputFileId = uploaded.id;
    shard.status = "uploaded";
    await writeBatchState({ statePath, state: { ...baseState, updatedAt: new Date().toISOString(), metadata } });

    const batch = await client.batches.create({ input_file_id: uploaded.id, endpoint: "/v1/responses", completion_window: "24h", metadata: { ...metadata, shardIndex: String(shard.shardIndex) } });
    shard.batchId = batch.id;
    shard.status = batch.status;
    await writeBatchState({ statePath, state: { ...baseState, updatedAt: new Date().toISOString(), metadata } });
  }

  return { ...baseState, metadata, updatedAt: new Date().toISOString() };
}

export async function refreshBatchState({ client, state }) {
  for (const shard of state.shards) {
    if (!shard.batchId) continue;
    const batch = await client.batches.retrieve(shard.batchId);
    shard.status = batch.status;
    shard.outputFileId = batch.output_file_id || null;
    shard.errorFileId = batch.error_file_id || null;
    shard.requestCounts = batch.request_counts || null;
    shard.usage = batch.usage || null;
    shard.completedAt = batch.completed_at || null;
  }
  state.updatedAt = new Date().toISOString();
  return state;
}

export function isBatchTerminal(status) {
  return TERMINAL_BATCH_STATUSES.has(status);
}

export function isBatchActive(status) {
  return ACTIVE_BATCH_STATUSES.has(status);
}

export async function downloadBatchShardOutputs({ client, outDir, state }) {
  const resultsDir = path.join(outDir, "batch", "results");
  await fs.mkdir(resultsDir, { recursive: true });

  for (const shard of state.shards) {
    const shardName = `shard-${padIndex(shard.shardIndex, 3)}`;
    if (shard.outputFileId) {
      const outputFile = await client.files.content(shard.outputFileId);
      const outputText = await outputFile.text();
      shard.outputPath = path.join(resultsDir, `${shardName}.output.jsonl`);
      await fs.writeFile(shard.outputPath, outputText, "utf8");
    }
    if (shard.errorFileId) {
      const errorFile = await client.files.content(shard.errorFileId);
      const errorText = await errorFile.text();
      shard.errorPath = path.join(resultsDir, `${shardName}.error.jsonl`);
      await fs.writeFile(shard.errorPath, errorText, "utf8");
    }
  }
  return state;
}

export function parseBatchOutputJsonl(text) {
  return String(text || "").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

export async function reconcileBatchResults({
  outDir,
  state,
  meetingMap,
  fileSet,
  canonicalFileMap,
  minutesDir,
  decisionsDir,
  errorsDir,
  sampleSize,
  verbose,
  reasoningEffort,
  requestTimeoutMs,
  promptCache,
  maxOutputTokens,
}) {
  const successes = new Set();
  const failures = new Set();
  await fs.mkdir(errorsDir, { recursive: true });

  for (const shard of state.shards) {
    if (shard.outputPath) {
      const lines = parseBatchOutputJsonl(await fs.readFile(shard.outputPath, "utf8"));
      for (const line of lines) {
        const customId = line.custom_id;
        const context = meetingMap[customId];
        if (!context) continue;
        const response = line.response?.body || null;
        if (!response) {
          failures.add(customId);
          continue;
        }
        try {
          await materializeMeetingResponse({
            response,
            runIndex: context.meetingIndex,
            sampleSize,
            round: context.round,
            meetingMode: context.meetingMode,
            meetingSize: context.meetingSize,
            curators: context.curators,
            fileSet,
            canonicalFileMap,
            minutesDir,
            decisionsDir,
            errorsDir,
            verbose,
            reasoningEffort,
            maxOutputTokens: context.requestedMaxOutputTokens || maxOutputTokens,
            estimatedInputTokens: context.estimatedInputTokens,
            requestTimeoutMs,
            promptCache,
            tokenCountMethod: context.tokenCountMethod,
            retryCount: context.attempt || 0,
            transport: "batch",
            batch: {
              batchId: shard.batchId,
              customId,
              inputFileId: shard.inputFileId,
              attempt: context.attempt || 0,
              statusCode: line.response?.status_code || null,
              requestId: response.id || null,
            },
          });
          successes.add(customId);
        } catch (error) {
          failures.add(customId);
          const p = path.join(errorsDir, `meeting-${padIndex(context.meetingIndex, Math.max(3, String(sampleSize).length))}.error.log`);
          await fs.writeFile(p, `${error?.stack || error?.message || error}\n`, "utf8");
        }
      }
    }

    if (shard.errorPath) {
      const lines = parseBatchOutputJsonl(await fs.readFile(shard.errorPath, "utf8"));
      for (const line of lines) {
        const customId = line.custom_id;
        const context = meetingMap[customId];
        if (!context) continue;
        failures.add(customId);
        const p = path.join(errorsDir, `meeting-${padIndex(context.meetingIndex, Math.max(3, String(sampleSize).length))}.error.log`);
        await fs.writeFile(p, JSON.stringify(line.error || line, null, 2) + "\n", "utf8");
      }
    }
  }

  for (const [customId, context] of Object.entries(meetingMap)) {
    if (successes.has(customId) || failures.has(customId)) continue;
    failures.add(customId);
    const p = path.join(errorsDir, `meeting-${padIndex(context.meetingIndex, Math.max(3, String(sampleSize).length))}.error.log`);
    await fs.writeFile(p, `Missing batch result for ${customId}\n`, "utf8");
  }

  return { successes: successes.size, failures: failures.size, missing: [...failures].filter((id) => !successes.has(id) && !Object.values(state.shards).some((s) => s.errorPath)).length };
}

export async function pollBatch({ client, state, statePath, pollIntervalMs, verbose }) {
  while (true) {
    await refreshBatchState({ client, state });
    await writeBatchState({ statePath, state });
    const statuses = state.shards.map((s) => s.status);
    if (statuses.every((s) => isBatchTerminal(s))) return state;
    if (verbose) console.error(`packet-select: batch statuses ${statuses.join(", ")}; polling again in ${pollIntervalMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
}

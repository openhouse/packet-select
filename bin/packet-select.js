#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import OpenAI from "openai";
import { loadConfig, usage } from "../src/config.js";
import { resolveOverview, deriveOverviewBudget } from "../src/overview.js";
import { listProjectFiles, logInfo, padIndex, ensureTrailingNewline, buildCanonicalFileMap } from "../src/utils.js";
import { runMeeting, buildMeetingInput, estimateRequestTokens, isDeterministicRequestError, isDeterministicIncompleteError } from "../src/meeting.js";
import {
  stageBatchRequests,
  submitBatchShards,
  loadBatchState,
  writeBatchState,
  refreshBatchState,
  isBatchActive,
  pollBatch,
  downloadBatchShardOutputs,
  reconcileBatchResults,
} from "../src/batch.js";
import { aggregateDecisions, writeAggregationOutputs } from "../src/aggregate.js";
import { buildSubtrees, generateBucketOverviews } from "../src/subtrees.js";
import { buildCrossPollinateMeetings } from "../src/crossPollinate.js";
import { RollingWindowScheduler } from "../src/rateLimiter.js";
import { buildPromptCacheKey, sanitizePromptCacheKey, validatePromptCacheKey, DEFAULT_PROMPT_CACHE_RETENTION } from "../src/promptCache.js";

const require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");

dotenv.config({ path: path.join(repoRoot, ".env") });

function resolveBuildSubtreesBin(buildSubtreesBin) {
  if (!buildSubtreesBin) return path.join(repoRoot, "scripts", "crs_build_subtrees.sh");
  if (path.isAbsolute(buildSubtreesBin)) return buildSubtreesBin;
  return path.join(repoRoot, buildSubtreesBin);
}

function buildMeetingPlan({ curators, sampleSize, crossPollinate, meetingSize }) {
  if (!crossPollinate) {
    const meetingSizeResolved = curators.length;
    return {
      meetings: Array.from({ length: sampleSize }, (_, i) => ({ index: i + 1, round: 1, curators, meetingSize: meetingSizeResolved })),
      groupsPerRound: 1,
      meetingSize: meetingSizeResolved,
    };
  }
  return buildCrossPollinateMeetings({ curators, sampleSize, meetingSize });
}

function getOpenAiSdkVersion() {
  try {
    return require("openai/package.json").version;
  } catch {
    return "unknown";
  }
}

function resolvePromptCache(config, { srcRoot, model, promptText, manifestText, overviewText, verbose }) {
  if (config.noPromptCache) {
    logInfo(verbose, "Prompt caching: disabled (--no-prompt-cache)");
    return { enabled: false, source: "disabled", key: null, retention: null, keyLength: 0 };
  }

  const explicitKey = config.promptCacheKey ? sanitizePromptCacheKey(config.promptCacheKey) : null;
  const key = explicitKey || buildPromptCacheKey({
    enabled: true,
    srcRoot,
    model,
    promptText,
    manifestText,
    overviewText,
  });
  const validation = validatePromptCacheKey(key);
  if (!validation.valid) {
    throw new Error(`Invalid prompt cache key during preflight: ${validation.reason}`);
  }
  const retention = config.promptCacheRetention || DEFAULT_PROMPT_CACHE_RETENTION;
  const promptCache = { enabled: Boolean(key), source: explicitKey ? "explicit" : "derived", key, retention, keyLength: key?.length || 0 };
  logInfo(verbose, `Prompt caching: ${promptCache.enabled ? promptCache.source : "disabled"}${promptCache.enabled ? ` (key length ${promptCache.keyLength}, retention ${retention})` : ""}`);
  return promptCache;
}

async function writePreflight({ outDir, overview, preflight, totalMeetings, tpmLimit, rpmLimit, requestedWorkers, workerCount, schedulerUtilization, promptCache, plan, sdkVersion, executionMode = "sync", batch = null }) {
  const lines = [
    `openai_sdk_version=${sdkVersion}`,
    `overview_bytes=${Buffer.byteLength(overview.archivalOverviewText, "utf8")}`,
    `overview_chars=${overview.archivalOverviewText.length}`,
    `llm_overview_tokens=${overview.overviewStats.approxTokens}`,
    `manifest_records=${overview.manifestRecords.length}`,
    `manifest_bytes=${Buffer.byteLength(overview.manifestText, "utf8")}`,
    `estimated_input_tokens=${preflight.inputTokens}`,
    `token_count_method=${preflight.method}`,
    `fixed_request_tokens=${plan.fixedRequestTokens}`,
    `reserve_output_tokens=${plan.reserveOutputTokens}`,
    `remaining_overview_budget=${plan.availableOverviewBudget}`,
    `input_headroom=${plan.inputHeadroom}`,
    `long_context=${preflight.inputTokens >= 128000 ? "yes" : "no"}`,
    `total_meetings=${totalMeetings}`,
    `estimated_total_input_tokens=${preflight.inputTokens * totalMeetings}`,
    `tpm_limit=${tpmLimit ?? "unset"}`,
    `rpm_limit=${rpmLimit ?? "unset"}`,
    `scheduler_utilization=${schedulerUtilization}`,
    `requested_workers=${requestedWorkers}`,
    `effective_workers=${workerCount}`,
    `prompt_cache=${promptCache.enabled ? promptCache.source : "disabled"}`,
    `prompt_cache_key_length=${promptCache.keyLength}`,
    `prompt_cache_retention=${promptCache.retention ?? "unset"}`,
    `execution_mode=${executionMode}`,
    ...(batch ? [
      `batch_total_input_bytes=${batch.totalInputBytes}`,
      `batch_planned_shards=${batch.plannedShards}`,
      `batch_max_requests_per_shard=${batch.maxRequestsPerShard}`,
      `batch_max_bytes_per_shard=${batch.maxBytesPerShard}`,
      `workers_ignored=${executionMode === "batch" ? "yes" : "no"}`,
    ] : []),
  ];
  const text = ensureTrailingNewline(lines.join("\n"));
  await fs.writeFile(path.join(outDir, "preflight.txt"), text, "utf8");
  console.error(text.trim());
}

async function main() {
  let config;
  try {
    config = loadConfig(process.argv.slice(2));
  } catch (error) {
    console.error(`packet-select: ${error.message}`);
    console.error(usage());
    process.exit(1);
  }
  if (config.help) {
    console.log(usage());
    process.exit(0);
  }

  const {
    srcRoot, promptText, promptFile, curators, sampleSize, meetingSize, workers, model, outDir, overviewFile,
    buildSubtreesBin: configuredBuildSubtreesBin, noBuildSubtrees, noBucketOverviews, apiKey, verbose,
    crossPollinate, reasoningEffort, maxInputTokens, maxOverviewTokens, reserveOutputTokens, maxOutputTokens,
    tpmLimit, rpmLimit, requestTimeoutMs, maxRetries, dryRun, schedulerUtilization,
    executionMode, batchSubmitOnly, batchWait, batchPollIntervalMs, batchStateFile, resumeBatchId, batchCollectOnly,
  } = config;

  const sdkVersion = getOpenAiSdkVersion();
  logInfo(verbose, `OpenAI SDK version: ${sdkVersion}`);

  const buildSubtreesBin = resolveBuildSubtreesBin(configuredBuildSubtreesBin);
  const buildSubtreesBinWasProvided = Boolean(configuredBuildSubtreesBin);

  if (batchCollectOnly) {
    const client = new OpenAI({ apiKey, timeout: requestTimeoutMs });
    const resolvedOutDir = path.resolve(outDir);
    const minutesDir = path.join(resolvedOutDir, "minutes");
    const decisionsDir = path.join(resolvedOutDir, "decisions");
    const errorsDir = path.join(resolvedOutDir, "errors");
    await Promise.all([fs.mkdir(minutesDir, { recursive: true }), fs.mkdir(decisionsDir, { recursive: true }), fs.mkdir(errorsDir, { recursive: true })]);
    const loadedState = await loadBatchState(batchStateFile);
    const state = await refreshBatchState({ client, state: loadedState });
    await writeBatchState({ statePath: batchStateFile, state });
    const activeStatuses = state.shards.filter((s) => isBatchActive(s.status)).map((s) => `${s.shardIndex}:${s.status}`);
    if (activeStatuses.length > 0) {
      console.error(`packet-select: batch shards still active (${activeStatuses.join(", ")})`);
      process.exit(0);
    }
    await downloadBatchShardOutputs({ client, outDir: resolvedOutDir, state });
    await writeBatchState({ statePath: batchStateFile, state });
    const effectiveSrcRoot = state.srcRoot;
    const fileList = await listProjectFiles(effectiveSrcRoot, { excludedRoots: new Set(["batch"]) });
    const fileSet = new Set(fileList);
    const canonicalFileMap = buildCanonicalFileMap(fileList);
    const reconciliation = await reconcileBatchResults({
      outDir: resolvedOutDir,
      state,
      meetingMap: state.meetingMap || {},
      fileSet,
      canonicalFileMap,
      minutesDir,
      decisionsDir,
      errorsDir,
      sampleSize: state.totalMeetings || sampleSize,
      verbose,
      reasoningEffort: state.reasoningEffort || reasoningEffort,
      requestTimeoutMs,
      promptCache: state.promptCache || null,
      maxOutputTokens: state.maxOutputTokens || maxOutputTokens,
    });
    const { votes, records, maxCount, frequencyTsv, decisionsFiles } = await aggregateDecisions({ decisionsDir, fileSet, sampleSize: state.totalMeetings || sampleSize });
    const completedMeetings = decisionsFiles.length;
    const projectOverviewsDir = null;
    await writeAggregationOutputs({
      outDir: resolvedOutDir,
      votes,
      frequencyTsv,
      maxCount,
      records,
      meta: {
        srcRoot: effectiveSrcRoot,
        model: state.model,
        openAiSdkVersion: sdkVersion,
        sampleSize: state.sampleSize || sampleSize,
        totalMeetings: state.totalMeetings || sampleSize,
        workers,
        effectiveWorkers: 0,
        curators: state.curators || [],
        overviewPath: state.overviewPath || null,
        promptPath: state.promptPath || null,
        totalFiles: fileSet.size,
        decisionsFiles,
        completedMeetings,
        failedMeetings: Math.max(0, (state.totalMeetings || sampleSize) - completedMeetings),
        reasoningEffort: state.reasoningEffort,
        crossPollinate: state.crossPollinate,
        pairsPerRound: state.pairsPerRound,
        groupsPerRound: state.groupsPerRound,
        meetingSize: state.meetingSize,
        projectOverviewsDir,
        apiMode: "batch-collect",
        executionMode: "batch",
        batchStateFile,
        batchShards: state.shards?.length || 0,
        batchIds: state.shards?.map((s) => s.batchId).filter(Boolean) || [],
      },
    });
    console.error(`packet-select: batch collect complete (${reconciliation.successes} successes, ${reconciliation.failures} failures)`);
    process.exit(reconciliation.failures > 0 ? 1 : 0);
  }

  await fs.mkdir(outDir, { recursive: true });
  const minutesDir = path.join(outDir, "minutes");
  const decisionsDir = path.join(outDir, "decisions");
  const errorsDir = path.join(outDir, "errors");
  await Promise.all([fs.mkdir(minutesDir, { recursive: true }), fs.mkdir(decisionsDir, { recursive: true }), fs.mkdir(errorsDir, { recursive: true })]);

  const promptTextResolved = promptText || await fs.readFile(promptFile, "utf8");
  const promptPath = promptFile || "inline-prompt";
  const overview = await resolveOverview({ srcRoot, overviewFileFlag: overviewFile, verbose, maxOverviewTokens: null, outDir, promptText: promptTextResolved });
  const fileList = await listProjectFiles(srcRoot, { excludedRoots: overview.excludedRoots });
  await fs.writeFile(path.join(outDir, "files.txt"), fileList.join("\n") + "\n", "utf8");
  const fileSet = new Set(fileList);
  const canonicalFileMap = buildCanonicalFileMap(fileList);
  const client = dryRun ? { responses: {} } : new OpenAI({ apiKey, timeout: requestTimeoutMs });
  const promptCache = resolvePromptCache(config, {
    srcRoot,
    model,
    promptText: promptTextResolved,
    manifestText: overview.manifestText,
    overviewText: overview.overviewText,
    verbose,
  });

  const { meetings, groupsPerRound, meetingSize: plannedMeetingSize } = buildMeetingPlan({ curators, sampleSize, crossPollinate, meetingSize });
  const totalMeetings = meetings.length;
  const padWidth = Math.max(3, String(totalMeetings).length);
  const pairsPerRound = crossPollinate ? (curators.length * (curators.length - 1)) / 2 : null;
  const sampleMeeting = meetings[0];

  const skeletonRequest = buildMeetingInput({
    curators: sampleMeeting.curators,
    promptText: promptTextResolved,
    overviewText: "",
    manifestText: overview.manifestText,
    srcRoot,
    sampleSize: totalMeetings,
    runIndex: sampleMeeting.index,
    fileCount: fileSet.size,
    round: sampleMeeting.round,
    meetingMode: crossPollinate ? "cross-pollinate" : "group",
    meetingSize: sampleMeeting.meetingSize,
  });
  const scaffoldEstimate = await estimateRequestTokens({ client, model, request: skeletonRequest, maxOutputTokens, reasoningEffort, promptCache, verbose, apiKey });
  const availableOverviewBudget = deriveOverviewBudget({
    maxInputTokens,
    fixedRequestTokens: scaffoldEstimate.inputTokens,
    reserveOutputTokens,
    maxOverviewTokens,
  });
  const refitOverview = await resolveOverview({ srcRoot, overviewFileFlag: overviewFile, verbose, maxOverviewTokens: availableOverviewBudget, outDir, promptText: promptTextResolved });

  const sampleRequest = buildMeetingInput({
    curators: sampleMeeting.curators,
    promptText: promptTextResolved,
    overviewText: refitOverview.overviewText,
    manifestText: refitOverview.manifestText,
    srcRoot,
    sampleSize: totalMeetings,
    runIndex: sampleMeeting.index,
    fileCount: fileSet.size,
    round: sampleMeeting.round,
    meetingMode: crossPollinate ? "cross-pollinate" : "group",
    meetingSize: sampleMeeting.meetingSize,
  });
  const preflight = await estimateRequestTokens({ client, model, request: sampleRequest, maxOutputTokens, reasoningEffort, promptCache, verbose, apiKey });
  const inputHeadroom = maxInputTokens - preflight.inputTokens - reserveOutputTokens;
  if (inputHeadroom < 0) {
    throw new Error(`Planned request exceeds safe budget: input=${preflight.inputTokens}, reserve=${reserveOutputTokens}, max_input=${maxInputTokens}.`);
  }
  if (reasoningEffort === "high" && preflight.inputTokens >= 150000 && maxOutputTokens < 8192) {
    throw new Error(`Configured --max-output-tokens ${maxOutputTokens} is too small for high-reasoning long-context runs. Use at least 8192 and prefer 32768+.`);
  }

  const safeWorkersByTpm = tpmLimit ? Math.max(1, Math.floor((tpmLimit * schedulerUtilization) / Math.max(1, preflight.inputTokens + reserveOutputTokens))) : workers;
  const safeWorkersByRpm = rpmLimit ? Math.max(1, Math.floor(rpmLimit * schedulerUtilization)) : workers;
  const workerCount = Math.max(1, Math.min(workers, totalMeetings, safeWorkersByTpm, safeWorkersByRpm));
  await writePreflight({
    outDir,
    overview: refitOverview,
    preflight,
    totalMeetings,
    tpmLimit,
    rpmLimit,
    requestedWorkers: workers,
    workerCount,
    schedulerUtilization,
    promptCache,
    plan: { fixedRequestTokens: scaffoldEstimate.inputTokens, reserveOutputTokens, availableOverviewBudget, inputHeadroom },
    sdkVersion,
    executionMode,
  });

  if (crossPollinate) {
    logInfo(verbose, "packet-select: cross-pollinate mode");
    logInfo(verbose, `  curators: ${curators.length}`);
    logInfo(verbose, `  meeting size: ${plannedMeetingSize}`);
    logInfo(verbose, `  groups per round: ${groupsPerRound}`);
    logInfo(verbose, `  pairs per round: ${pairsPerRound}`);
    logInfo(verbose, `  rounds (sample-size): ${sampleSize}`);
    logInfo(verbose, `  total meetings planned: ${totalMeetings}`);
  } else {
    logInfo(verbose, `packet-select: planning ${totalMeetings} meetings (group mode)`);
  }
  logInfo(verbose, `Estimated tokens per meeting: ${preflight.inputTokens} (${preflight.method})`);
  logInfo(verbose, `Effective worker count after rate budgeting: ${workerCount}`);

  if (executionMode === "batch") {
    const staged = await stageBatchRequests({
      meetings,
      sampleSize: totalMeetings,
      buildArgs: {
        promptText: promptTextResolved,
        overviewText: refitOverview.overviewText,
        manifestText: refitOverview.manifestText,
        srcRoot,
        fileCount: fileSet.size,
        meetingMode: crossPollinate ? "cross-pollinate" : "group",
        model,
        maxOutputTokens,
        reasoningEffort,
        promptCache,
        estimatedInputTokens: preflight.inputTokens,
        tokenCountMethod: preflight.method,
      },
      outDir,
    });
    await writePreflight({
      outDir,
      overview: refitOverview,
      preflight,
      totalMeetings,
      tpmLimit,
      rpmLimit,
      requestedWorkers: workers,
      workerCount,
      schedulerUtilization,
      promptCache,
      plan: { fixedRequestTokens: scaffoldEstimate.inputTokens, reserveOutputTokens, availableOverviewBudget, inputHeadroom },
      sdkVersion,
      executionMode,
      batch: {
        totalInputBytes: staged.totalInputBytes,
        plannedShards: staged.shards.length,
        maxRequestsPerShard: 45000,
        maxBytesPerShard: 180 * 1024 * 1024,
      },
    });
    const state = await submitBatchShards({
      client,
      statePath: batchStateFile,
      stagedFiles: staged.files,
      model,
      metadata: { srcRoot, outDir, executionMode, sampleSize: totalMeetings },
      dryRun,
    });
    state.meetingMap = staged.meetingMap;
    state.totalMeetings = totalMeetings;
    state.sampleSize = sampleSize;
    state.srcRoot = srcRoot;
    state.model = model;
    state.maxOutputTokens = maxOutputTokens;
    state.reasoningEffort = reasoningEffort;
    state.promptCache = promptCache;
    state.curators = curators;
    state.crossPollinate = crossPollinate;
    state.meetingSize = plannedMeetingSize;
    state.groupsPerRound = crossPollinate ? groupsPerRound : null;
    state.pairsPerRound = pairsPerRound;
    state.overviewPath = refitOverview.archivalOverviewPath || "fallback-listing";
    state.promptPath = promptPath;
    state.batchStateFile = batchStateFile;
    state.submittedAt = new Date().toISOString();
    await writeBatchState({ statePath: batchStateFile, state });

    if (dryRun) {
      console.error("packet-select: dry-run enabled; staged batch request files only");
      process.exit(0);
    }

    console.error(`packet-select: submitted ${state.shards.length} batch shard(s)`);
    if (resumeBatchId) console.error(`packet-select: --resume-batch-id provided (${resumeBatchId}) but automatic shard mapping from state is used`);
    if (batchSubmitOnly && !batchWait) process.exit(0);

    if (batchWait) {
      await pollBatch({ client, state, statePath: batchStateFile, pollIntervalMs: batchPollIntervalMs, verbose });
      await downloadBatchShardOutputs({ client, outDir, state });
      await writeBatchState({ statePath: batchStateFile, state });
      const reconciliation = await reconcileBatchResults({
        outDir,
        state,
        meetingMap: state.meetingMap || {},
        fileSet,
        canonicalFileMap,
        minutesDir,
        decisionsDir,
        errorsDir,
        sampleSize: totalMeetings,
        verbose,
        reasoningEffort,
        requestTimeoutMs,
        promptCache,
        maxOutputTokens,
      });
      console.error(`packet-select: batch wait/collect complete (${reconciliation.successes} successes, ${reconciliation.failures} failures)`);
    } else {
      process.exit(0);
    }
  }

  if (dryRun) {
    console.error("packet-select: dry-run enabled; exiting before API calls");
    process.exit(0);
  }

  let errors = 0;
  let fatalError = null;
  let deterministicIncompleteCount = 0;

  async function runMeetingIndex(meeting, scheduler) {
    let reservation = null;
    try {
      reservation = await scheduler.reserve({ tokens: preflight.inputTokens + reserveOutputTokens });
      await runMeeting({
        client,
        model,
        curators: meeting.curators,
        promptText: promptTextResolved,
        overviewText: refitOverview.overviewText,
        manifestText: refitOverview.manifestText,
        srcRoot,
        sampleSize: totalMeetings,
        runIndex: meeting.index,
        fileSet,
        canonicalFileMap,
        minutesDir,
        decisionsDir,
        errorsDir,
        verbose,
        reasoningEffort,
        maxOutputTokens,
        requestTimeoutMs,
        maxRetries,
        meetingMode: crossPollinate ? "cross-pollinate" : "group",
        round: meeting.round,
        meetingSize: meeting.meetingSize,
        estimatedInputTokens: preflight.inputTokens,
        promptCache,
        tokenCountMethod: preflight.method,
      });
    } catch (err) {
      errors += 1;
      if (reservation && isDeterministicRequestError(err)) reservation.release();
      const message = err?.message || String(err);
      console.error(`packet-select: meeting ${meeting.index} failed: ${message}`);
      if (isDeterministicRequestError(err)) {
        fatalError = err;
      }
      if (isDeterministicIncompleteError(err)) {
        deterministicIncompleteCount += 1;
        if (deterministicIncompleteCount >= Math.min(workerCount, meetings.length)) fatalError = err;
      }
      const errorPath = path.join(errorsDir, `meeting-${padIndex(meeting.index, padWidth)}.error.log`);
      await fs.writeFile(errorPath, `${err?.stack || message}\n`, "utf8");
    }
  }

  if (executionMode === "sync") {
    const scheduler = new RollingWindowScheduler({ tpmLimit, rpmLimit, utilization: schedulerUtilization });
    let nextIndex = 0;
    async function workerLoop() {
      while (!fatalError) {
        const index = nextIndex++;
        if (index >= meetings.length) return;
        await runMeetingIndex(meetings[index], scheduler);
      }
    }
    await Promise.all(Array.from({ length: workerCount }, () => workerLoop()));
    if (fatalError) {
      const category = isDeterministicIncompleteError(fatalError) ? "deterministic incomplete response" : "deterministic request failure";
      console.error(`packet-select: aborting run after ${category}: ${fatalError.message}`);
      process.exit(1);
    }
    if (errors === totalMeetings) {
      console.error("packet-select: All meetings failed");
      process.exit(1);
    }
  }

  const { votes, records, maxCount, frequencyTsv, decisionsFiles } = await aggregateDecisions({ decisionsDir, fileSet, sampleSize: totalMeetings });
  const completedMeetings = decisionsFiles.length;
  const projectOverviewsDir = !noBuildSubtrees && !noBucketOverviews && maxCount > 0 ? path.join(outDir, "project-overviews") : null;
  const { frequencyPath } = await writeAggregationOutputs({
    outDir,
    votes,
    frequencyTsv,
    maxCount,
    records,
    meta: {
      srcRoot,
      model,
      openAiSdkVersion: sdkVersion,
      sampleSize,
      totalMeetings,
      workers,
      effectiveWorkers: workerCount,
      curators,
      overviewPath: refitOverview.archivalOverviewPath || "fallback-listing",
      llmOverviewPath: refitOverview.llmOverviewPath,
      manifestPath: refitOverview.manifestPath,
      promptPath,
      totalFiles: fileSet.size,
      decisionsFiles,
      completedMeetings,
      failedMeetings: errors,
      reasoningEffort,
      crossPollinate,
      pairsPerRound,
      groupsPerRound: crossPollinate ? groupsPerRound : null,
      meetingSize: plannedMeetingSize,
      projectOverviewsDir,
      maxInputTokens,
      maxOverviewTokens,
      maxOutputTokens,
      reserveOutputTokens,
      tpmLimit,
      rpmLimit,
      schedulerUtilization,
      requestTimeoutMs,
      promptCache: { enabled: promptCache.enabled, source: promptCache.source, retention: promptCache.retention, keyLength: promptCache.keyLength },
      tokenCountMethod: preflight.method,
      fixedRequestTokens: scaffoldEstimate.inputTokens,
      availableOverviewBudget,
      executionMode,
      apiMode: executionMode === "batch" ? "batch-submit" : "sync",
      workersIgnored: executionMode === "batch",
      batchStateFile: executionMode === "batch" ? batchStateFile : null,
      batchShards: executionMode === "batch" ? undefined : null,
    },
  });

  if (!noBuildSubtrees && maxCount > 0) {
    const subtreesRoot = await buildSubtrees({ srcRoot, outDir, frequencyPath, buildSubtreesBin, buildSubtreesBinWasProvided, min: 1, max: maxCount, verbose });
    if (subtreesRoot && !noBucketOverviews) {
      const overviewScript = refitOverview.archivalOverviewPath && refitOverview.archivalOverviewPath.endsWith("project-overview.txt")
        ? path.join(path.dirname(refitOverview.archivalOverviewPath), "scripts", "generate-overview.sh")
        : path.resolve("scripts", "generate-overview.sh");
      if (await fs.stat(overviewScript).catch(() => null)) {
        const overviewCollectionDir = projectOverviewsDir || path.join(outDir, "project-overviews");
        await generateBucketOverviews({ subtreesRoot, overviewScriptPath: overviewScript, verbose, overviewCollectionDir });
      } else {
        logInfo(verbose, "No generate-overview.sh found to run inside buckets");
      }
    }
  }

  if (errors > 0) console.error(`packet-select: complete with ${completedMeetings}/${totalMeetings} meetings succeeded (${errors} failed)`);
  else console.error(`packet-select: complete (${completedMeetings}/${totalMeetings} meetings succeeded)`);
}

main().catch((error) => {
  console.error(`packet-select: ${error?.stack || error?.message || error}`);
  process.exit(1);
});

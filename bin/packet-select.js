#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import OpenAI from "openai";
import { loadConfig, usage } from "../src/config.js";
import { resolveOverview } from "../src/overview.js";
import { listProjectFiles, logInfo, padIndex, ensureTrailingNewline } from "../src/utils.js";
import { runMeeting, buildMeetingInput, estimateRequestTokens } from "../src/meeting.js";
import { aggregateDecisions, writeAggregationOutputs } from "../src/aggregate.js";
import { buildSubtrees, generateBucketOverviews } from "../src/subtrees.js";
import { buildCrossPollinateMeetings } from "../src/crossPollinate.js";
import { RollingWindowScheduler } from "../src/rateLimiter.js";

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

async function writePreflight({ outDir, overview, preflight, totalMeetings, tpmLimit, rpmLimit, requestedWorkers, workerCount }) {
  const lines = [
    `overview_bytes=${Buffer.byteLength(overview.archivalOverviewText, "utf8")}`,
    `overview_chars=${overview.archivalOverviewText.length}`,
    `llm_overview_tokens=${overview.overviewStats.approxTokens}`,
    `manifest_records=${overview.manifestRecords.length}`,
    `manifest_bytes=${Buffer.byteLength(overview.manifestText, "utf8")}`,
    `estimated_input_tokens=${preflight.inputTokens}`,
    `token_count_method=${preflight.method}`,
    `long_context=${preflight.inputTokens >= 128000 ? "yes" : "no"}`,
    `total_meetings=${totalMeetings}`,
    `estimated_total_input_tokens=${preflight.inputTokens * totalMeetings}`,
    `tpm_limit=${tpmLimit ?? "unset"}`,
    `rpm_limit=${rpmLimit ?? "unset"}`,
    `requested_workers=${requestedWorkers}`,
    `effective_workers=${workerCount}`,
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
    tpmLimit, rpmLimit, requestTimeoutMs, maxRetries, dryRun,
  } = config;

  const buildSubtreesBin = resolveBuildSubtreesBin(configuredBuildSubtreesBin);
  const buildSubtreesBinWasProvided = Boolean(configuredBuildSubtreesBin);

  await fs.mkdir(outDir, { recursive: true });
  const minutesDir = path.join(outDir, "minutes");
  const decisionsDir = path.join(outDir, "decisions");
  const errorsDir = path.join(outDir, "errors");
  await Promise.all([fs.mkdir(minutesDir, { recursive: true }), fs.mkdir(decisionsDir, { recursive: true }), fs.mkdir(errorsDir, { recursive: true })]);

  const promptTextResolved = promptText || await fs.readFile(promptFile, "utf8");
  const promptPath = promptFile || "inline-prompt";
  const fileList = await listProjectFiles(srcRoot);
  await fs.writeFile(path.join(outDir, "files.txt"), fileList.join("\n") + "\n", "utf8");
  const fileSet = new Set(fileList);

  const overview = await resolveOverview({ srcRoot, overviewFileFlag: overviewFile, verbose, maxOverviewTokens, outDir, promptText: promptTextResolved });
  const client = new OpenAI({ apiKey, timeout: requestTimeoutMs });

  const { meetings, groupsPerRound, meetingSize: plannedMeetingSize } = buildMeetingPlan({ curators, sampleSize, crossPollinate, meetingSize });
  const totalMeetings = meetings.length;
  const padWidth = Math.max(3, String(totalMeetings).length);
  const pairsPerRound = crossPollinate ? (curators.length * (curators.length - 1)) / 2 : null;
  const sampleRequest = buildMeetingInput({
    curators: meetings[0].curators,
    promptText: promptTextResolved,
    overviewText: overview.overviewText,
    manifestText: overview.manifestText,
    srcRoot,
    sampleSize: totalMeetings,
    runIndex: meetings[0].index,
    fileCount: fileSet.size,
    round: meetings[0].round,
    meetingMode: crossPollinate ? "cross-pollinate" : "group",
    meetingSize: meetings[0].meetingSize,
  });
  const preflight = await estimateRequestTokens({ client, model, input: sampleRequest.input, maxOutputTokens });
  if (preflight.inputTokens + reserveOutputTokens > maxInputTokens) {
    throw new Error(`Estimated request size ${preflight.inputTokens} input tokens plus ${reserveOutputTokens} reserved output tokens exceeds --max-input-tokens ${maxInputTokens}. Reduce overview budget or manifest size.`);
  }

  const safeWorkersByTpm = tpmLimit ? Math.max(1, Math.floor((tpmLimit * 0.8) / Math.max(1, preflight.inputTokens + reserveOutputTokens))) : workers;
  const safeWorkersByRpm = rpmLimit ? Math.max(1, Math.floor(rpmLimit * 0.8)) : workers;
  const workerCount = Math.max(1, Math.min(workers, totalMeetings, safeWorkersByTpm, safeWorkersByRpm));
  await writePreflight({ outDir, overview, preflight, totalMeetings, tpmLimit, rpmLimit, requestedWorkers: workers, workerCount });

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

  if (dryRun) {
    console.error("packet-select: dry-run enabled; exiting before API calls");
    process.exit(0);
  }

  const scheduler = new RollingWindowScheduler({ tpmLimit, rpmLimit });
  let nextIndex = 0;
  let errors = 0;

  async function runMeetingIndex(meeting) {
    try {
      await scheduler.reserve({ tokens: preflight.inputTokens + reserveOutputTokens });
      await runMeeting({
        client,
        model,
        curators: meeting.curators,
        promptText: promptTextResolved,
        overviewText: overview.overviewText,
        manifestText: overview.manifestText,
        srcRoot,
        sampleSize: totalMeetings,
        runIndex: meeting.index,
        fileSet,
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
        promptCacheKey: `${path.basename(srcRoot)}:${model}:${promptPath}:${overview.llmOverviewPath}`,
      });
    } catch (err) {
      errors += 1;
      const message = err?.message || String(err);
      console.error(`packet-select: meeting ${meeting.index} failed: ${message}`);
      const errorPath = path.join(errorsDir, `meeting-${padIndex(meeting.index, padWidth)}.error.log`);
      await fs.writeFile(errorPath, `${err?.stack || message}\n`, "utf8");
    }
  }

  async function workerLoop() {
    while (true) {
      const index = nextIndex++;
      if (index >= meetings.length) return;
      await runMeetingIndex(meetings[index]);
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => workerLoop()));
  if (errors === totalMeetings) {
    console.error("packet-select: All meetings failed");
    process.exit(1);
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
      sampleSize,
      totalMeetings,
      workers,
      effectiveWorkers: workerCount,
      curators,
      overviewPath: overview.archivalOverviewPath || "fallback-listing",
      llmOverviewPath: overview.llmOverviewPath,
      manifestPath: overview.manifestPath,
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
      requestTimeoutMs,
    },
  });

  if (!noBuildSubtrees && maxCount > 0) {
    const subtreesRoot = await buildSubtrees({ srcRoot, outDir, frequencyPath, buildSubtreesBin, buildSubtreesBinWasProvided, min: 1, max: maxCount, verbose });
    if (subtreesRoot && !noBucketOverviews) {
      const overviewScript = overview.archivalOverviewPath && overview.archivalOverviewPath.endsWith("project-overview.txt")
        ? path.join(path.dirname(overview.archivalOverviewPath), "scripts", "generate-overview.sh")
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
  console.error(`packet-select: fatal error: ${error.message}`);
  process.exit(1);
});

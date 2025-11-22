#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import OpenAI from "openai";
import { loadConfig, usage } from "../src/config.js";
import { resolveOverview } from "../src/overview.js";
import { listProjectFiles, logInfo, padIndex } from "../src/utils.js";
import { runMeeting } from "../src/meeting.js";
import { aggregateDecisions, writeAggregationOutputs } from "../src/aggregate.js";
import { buildSubtrees, generateBucketOverviews } from "../src/subtrees.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");

function resolveBuildSubtreesBin(buildSubtreesBin) {
  if (!buildSubtreesBin) {
    return path.join(repoRoot, "scripts", "crs_build_subtrees.sh");
  }
  if (path.isAbsolute(buildSubtreesBin)) {
    return buildSubtreesBin;
  }
  return path.join(repoRoot, buildSubtreesBin);
}

// Load .env from the packet-select repo root if present
dotenv.config({ path: path.join(repoRoot, ".env") });

function buildMeetingPlan({ curators, sampleSize, crossPollinate }) {
  if (!crossPollinate) {
    return Array.from({ length: sampleSize }, (_, i) => ({
      index: i + 1,
      round: 1,
      curators,
    }));
  }

  const pairs = [];
  for (let i = 0; i < curators.length; i++) {
    for (let j = i + 1; j < curators.length; j++) {
      pairs.push([curators[i], curators[j]]);
    }
  }

  const meetings = [];
  for (let round = 1; round <= sampleSize; round++) {
    for (const pair of pairs) {
      meetings.push({
        index: meetings.length + 1,
        round,
        curators: pair,
      });
    }
  }

  return meetings;
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
    srcRoot,
    promptText,
    promptFile,
    curators,
    sampleSize,
    workers,
    model,
    outDir,
    overviewFile,
    buildSubtreesBin: configuredBuildSubtreesBin,
    noBuildSubtrees,
    noBucketOverviews,
    apiKey,
    verbose,
    crossPollinate,
    reasoningEffort,
  } = config;

  const buildSubtreesBin = resolveBuildSubtreesBin(configuredBuildSubtreesBin);
  const buildSubtreesBinWasProvided = Boolean(configuredBuildSubtreesBin);

  await fs.mkdir(outDir, { recursive: true });
  const minutesDir = path.join(outDir, "minutes");
  const decisionsDir = path.join(outDir, "decisions");
  const errorsDir = path.join(outDir, "errors");

  await Promise.all([
    fs.mkdir(minutesDir, { recursive: true }),
    fs.mkdir(decisionsDir, { recursive: true }),
    fs.mkdir(errorsDir, { recursive: true }),
  ]);

  const promptTextResolved = promptText || await fs.readFile(promptFile, "utf8");
  const promptPath = promptFile || "inline-prompt";

  const fileList = await listProjectFiles(srcRoot);
  await fs.writeFile(path.join(outDir, "files.txt"), fileList.join("\n") + "\n", "utf8");
  const fileSet = new Set(fileList);

  const { overviewPath, overviewText } = await resolveOverview({ srcRoot, overviewFileFlag: overviewFile, verbose });

  const client = new OpenAI({ apiKey });

  const meetings = buildMeetingPlan({ curators, sampleSize, crossPollinate });
  const totalMeetings = meetings.length;
  const workerCount = Math.min(workers, totalMeetings);
  const padWidth = Math.max(3, String(totalMeetings).length);
  const pairsPerRound = crossPollinate ? (curators.length * (curators.length - 1)) / 2 : null;
  let nextIndex = 0;
  let errors = 0;

  if (crossPollinate) {
    logInfo(verbose, "packet-select: cross-pollinate mode");
    logInfo(verbose, `  curators: ${curators.length}`);
    logInfo(verbose, `  pairs per round: ${pairsPerRound}`);
    logInfo(verbose, `  rounds (sample-size): ${sampleSize}`);
    logInfo(verbose, `  total meetings planned: ${totalMeetings}`);
  } else {
    logInfo(verbose, `packet-select: planning ${totalMeetings} meetings (group mode)`);
  }

  async function runMeetingIndex(meeting) {
    try {
      await runMeeting({
        client,
        model,
        curators: meeting.curators,
        promptText: promptTextResolved,
        overviewText,
        srcRoot,
        sampleSize: totalMeetings,
        runIndex: meeting.index,
        fileSet,
        minutesDir,
        decisionsDir,
        errorsDir,
        verbose,
        reasoningEffort,
        meetingMode: crossPollinate ? "cross-pollinate" : "group",
        round: meeting.round,
      });
    } catch (err) {
      errors++;
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
  const projectOverviewsDir = !noBuildSubtrees && !noBucketOverviews && maxCount > 0
    ? path.join(outDir, "project-overviews")
    : null;

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
      curators,
      overviewPath: overviewPath || "fallback-listing",
      promptPath,
      totalFiles: fileSet.size,
      decisionsFiles,
      completedMeetings,
      failedMeetings: errors,
      reasoningEffort,
      crossPollinate,
      pairsPerRound,
      projectOverviewsDir,
    },
  });

  if (!noBuildSubtrees && maxCount > 0) {
    const subtreesRoot = await buildSubtrees({
      srcRoot,
      outDir,
      frequencyPath,
      buildSubtreesBin,
      buildSubtreesBinWasProvided,
      min: 1,
      max: maxCount,
      verbose,
    });
    if (subtreesRoot && !noBucketOverviews) {
      const overviewScript = overviewPath && overviewPath.endsWith("project-overview.txt")
        ? path.join(path.dirname(overviewPath), "scripts", "generate-overview.sh")
        : path.resolve("scripts", "generate-overview.sh");
      if (await fs.stat(overviewScript).catch(() => null)) {
        const overviewCollectionDir = projectOverviewsDir || path.join(outDir, "project-overviews");
        await generateBucketOverviews({ subtreesRoot, overviewScriptPath: overviewScript, verbose, overviewCollectionDir });
      } else {
        logInfo(verbose, `No generate-overview.sh found to run inside buckets`);
      }
    }
  }

  if (errors > 0) {
    console.error(`packet-select: complete with ${completedMeetings}/${totalMeetings} meetings succeeded (${errors} failed)`);
  } else {
    console.error(`packet-select: complete (${completedMeetings}/${totalMeetings} meetings succeeded)`);
  }
}

main().catch((error) => {
  console.error(`packet-select: fatal error: ${error.message}`);
  process.exit(1);
});

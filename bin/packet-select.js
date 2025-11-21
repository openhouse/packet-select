#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import OpenAI from "openai";
import { loadConfig, usage } from "../src/config.js";
import { resolveOverview } from "../src/overview.js";
import { listProjectFiles, logInfo } from "../src/utils.js";
import { runMeeting } from "../src/meeting.js";
import { aggregateDecisions, writeAggregationOutputs } from "../src/aggregate.js";
import { buildSubtrees, generateBucketOverviews } from "../src/subtrees.js";

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
    buildSubtreesBin,
    noBuildSubtrees,
    noBucketOverviews,
    apiKey,
    verbose,
  } = config;

  await fs.mkdir(outDir, { recursive: true });
  const minutesDir = path.join(outDir, "minutes");
  const decisionsDir = path.join(outDir, "decisions");
  const errorsDir = path.join(outDir, "errors");

  const promptTextResolved = promptText || await fs.readFile(promptFile, "utf8");
  const promptPath = promptFile || "inline-prompt";

  const fileList = await listProjectFiles(srcRoot);
  await fs.writeFile(path.join(outDir, "files.txt"), fileList.join("\n") + "\n", "utf8");
  const fileSet = new Set(fileList);

  const { overviewPath, overviewText } = await resolveOverview({ srcRoot, overviewFileFlag: overviewFile, verbose });

  const client = new OpenAI({ apiKey });

  const tasks = [];
  let nextIndex = 1;
  let active = 0;
  let errors = 0;

  const enqueue = () => {
    while (active < workers && nextIndex <= sampleSize) {
      const index = nextIndex++;
      active++;
      const task = runMeeting({
        client,
        model,
        curators,
        promptText: promptTextResolved,
        overviewText,
        srcRoot,
        sampleSize,
        runIndex: index,
        fileSet,
        minutesDir,
        decisionsDir,
        errorsDir,
        verbose,
      }).catch((err) => {
        errors++;
        console.error(`packet-select: meeting ${index} failed: ${err.message}`);
      }).finally(() => {
        active--;
        enqueue();
      });
      tasks.push(task);
    }
  };

  enqueue();
  await Promise.all(tasks);

  if (errors === sampleSize) {
    console.error("packet-select: All meetings failed");
    process.exit(1);
  }

  const { votes, records, maxCount, frequencyTsv, decisionsFiles } = await aggregateDecisions({ decisionsDir, fileSet, sampleSize });
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
      workers,
      curators,
      overviewPath: overviewPath || "fallback-listing",
      promptPath,
      totalFiles: fileSet.size,
      decisionsFiles,
    },
  });

  if (!noBuildSubtrees && maxCount > 0) {
    const subtreesRoot = await buildSubtrees({
      srcRoot,
      outDir,
      frequencyPath,
      buildSubtreesBin,
      min: 1,
      max: maxCount,
      verbose,
    });
    if (!noBucketOverviews) {
      const overviewScript = overviewPath && overviewPath.endsWith("project-overview.txt")
        ? path.join(path.dirname(overviewPath), "scripts", "generate-overview.sh")
        : path.resolve("scripts", "generate-overview.sh");
      if (await fs.stat(overviewScript).catch(() => null)) {
        await generateBucketOverviews({ subtreesRoot, overviewScriptPath: overviewScript, verbose });
      } else {
        logInfo(verbose, `No generate-overview.sh found to run inside buckets`);
      }
    }
  }

  console.error("packet-select: complete");
}

main().catch((error) => {
  console.error(`packet-select: fatal error: ${error.message}`);
  process.exit(1);
});

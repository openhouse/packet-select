import fs from "node:fs/promises";
import path from "node:path";
import { normalizeRelativePath, logWarn } from "./utils.js";

async function readJson(filePath) {
  const content = await fs.readFile(filePath, "utf8");
  return JSON.parse(content);
}

export async function aggregateDecisions({ decisionsDir, fileSet, sampleSize }) {
  const decisionsFiles = (await fs.readdir(decisionsDir)).filter((f) => f.endsWith(".json"));
  const votes = {};
  for (const file of decisionsFiles) {
    const full = path.join(decisionsDir, file);
    const data = await readJson(full);
    const meetingIndex = data.meetingIndex || data.run_index || null;
    const keep = Array.isArray(data.keep) ? data.keep : [];
    for (const entry of keep) {
      const rel = normalizeRelativePath(entry.path);
      if (!rel) continue;
      if (!fileSet.has(rel)) {
        logWarn(`Aggregation skipping unknown path (decision ignored for frequency): ${rel}`);
        continue;
      }
      if (!votes[rel]) {
        votes[rel] = { rawCount: 0, runs: [] };
      }
      votes[rel].rawCount += 1;
      votes[rel].runs.push({ runIndex: meetingIndex, reason: entry.reason || "" });
    }
  }

  const records = Object.entries(votes).map(([p, info]) => ({ path: p, count: info.rawCount }));
  records.sort((a, b) => b.count - a.count || a.path.localeCompare(b.path));

  const maxCount = records.length ? records[0].count : 0;
  const frequencyTsv = ["count\tpath", ...records.map((r) => `${r.count}\t${r.path}`)].join("\n");
  return { votes, records, maxCount, frequencyTsv, decisionsFiles };
}

export async function writeAggregationOutputs({ outDir, votes, frequencyTsv, maxCount, records, meta }) {
  const dataDir = path.join(outDir, "data");
  await fs.mkdir(dataDir, { recursive: true });
  const frequencyPath = path.join(dataDir, "file-frequency.tsv");
  const votesPath = path.join(dataDir, "file-votes.json");
  await fs.writeFile(frequencyPath, frequencyTsv + "\n", "utf8");
  await fs.writeFile(votesPath, JSON.stringify(votes, null, 2));

  const completedMeetings = meta.completedMeetings ?? meta.decisionsFiles?.length ?? 0;
  const plannedMeetings = meta.totalMeetings ?? meta.sampleSize ?? completedMeetings;
  const failedMeetings = meta.failedMeetings ?? Math.max(0, plannedMeetings - completedMeetings);
  const meetingMode = meta.crossPollinate ? "cross-pollinate" : "group";

  const runManifest = {
    srcRoot: meta.srcRoot,
    outDir,
    model: meta.model,
    sampleSize: meta.sampleSize,
    totalMeetings: plannedMeetings,
    meetingMode,
    pairsPerRound: meta.pairsPerRound ?? null,
    groupsPerRound: meta.groupsPerRound ?? null,
    meetingSize: meta.meetingSize ?? null,
    crossPollinate: Boolean(meta.crossPollinate),
    workers: meta.workers,
    curators: meta.curators,
    overviewPath: meta.overviewPath,
    promptPath: meta.promptPath,
    totalFiles: meta.totalFiles,
    maxCount,
    uniqueFiles: records.length,
    completedMeetings,
    failedMeetings,
    reasoningEffort: meta.reasoningEffort,
    createdAt: new Date().toISOString(),
    frequencyTsv: frequencyPath,
    votesJson: votesPath,
    decisionsFiles: meta.decisionsFiles,
    projectOverviewsDir: meta.projectOverviewsDir || null,
  };
  await fs.writeFile(path.join(outDir, "run.json"), JSON.stringify(runManifest, null, 2));

  return { frequencyPath, votesPath };
}

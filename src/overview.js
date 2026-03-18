import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { listProjectFiles, ensureTrailingNewline, logInfo } from "./utils.js";
import { fitOverviewToTokenBudget, writeContextArtifacts } from "./contextBudget.js";
import { buildProjectManifest, formatManifestJsonl } from "./manifest.js";

async function fileExists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function runScript(scriptPath, cwd) {
  await new Promise((resolve, reject) => {
    const child = spawn("bash", [scriptPath], { cwd, stdio: "inherit" });
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Script ${scriptPath} exited with code ${code}`));
    });
    child.on("error", reject);
  });
}

export async function resolveOverview({ srcRoot, overviewFileFlag, verbose, maxOverviewTokens, outDir, promptText }) {
  const defaultOverview = path.join(srcRoot, "project-overview.txt");
  let overviewPath = null;
  let archivalOverviewText = null;

  if (overviewFileFlag) {
    overviewPath = overviewFileFlag;
    archivalOverviewText = await fs.readFile(overviewFileFlag, "utf8");
    logInfo(verbose, `Using overview from ${overviewFileFlag}`);
  } else if (await fileExists(defaultOverview)) {
    overviewPath = defaultOverview;
    archivalOverviewText = await fs.readFile(defaultOverview, "utf8");
    logInfo(verbose, `Using existing overview at ${defaultOverview}`);
  } else {
    const scriptInRoot = path.join(srcRoot, "scripts", "generate-overview.sh");
    const scriptVendored = path.resolve("scripts", "generate-overview.sh");
    const scriptPath = (await fileExists(scriptInRoot)) ? scriptInRoot : (await fileExists(scriptVendored) ? scriptVendored : null);
    if (scriptPath) {
      logInfo(verbose, `Generating overview using ${scriptPath}`);
      await runScript(scriptPath, srcRoot);
      if (await fileExists(defaultOverview)) {
        overviewPath = defaultOverview;
        archivalOverviewText = await fs.readFile(defaultOverview, "utf8");
      }
    }
  }

  if (!archivalOverviewText) {
    logInfo(verbose, "Falling back to simple file listing overview");
    const files = await listProjectFiles(srcRoot);
    archivalOverviewText = [
      `Simple file listing for ${srcRoot}`,
      "",
      ...files.map((f) => `### File: ${f}\nFILE ${f}`),
    ].join("\n\n");
  }

  const manifestRecords = await buildProjectManifest(srcRoot);
  const manifestText = formatManifestJsonl(manifestRecords);
  const { text: overviewText, stats } = fitOverviewToTokenBudget({
    overviewText: archivalOverviewText,
    promptText,
    manifestRecords,
    maxOverviewTokens,
  });

  const llmOverviewPath = path.join(outDir, "project-overview.llm.txt");
  const manifestPath = path.join(outDir, "project-manifest.jsonl");
  await fs.writeFile(llmOverviewPath, ensureTrailingNewline(overviewText), "utf8");
  await fs.writeFile(manifestPath, manifestText, "utf8");
  await writeContextArtifacts({ outDir, overviewText, stats: { ...stats, overviewPath, manifestPath } });

  return {
    overviewPath,
    archivalOverviewPath: overviewPath,
    archivalOverviewText: ensureTrailingNewline(archivalOverviewText),
    overviewText,
    llmOverviewPath,
    manifestPath,
    manifestRecords,
    manifestText,
    overviewStats: stats,
  };
}

import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { listProjectFiles, ensureTrailingNewline, logInfo } from "./utils.js";

const MAX_OVERVIEW_CHARS = 80000;

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

export async function resolveOverview({ srcRoot, overviewFileFlag, verbose }) {
  const defaultOverview = path.join(srcRoot, "project-overview.txt");
  let overviewPath = null;
  let overviewText = null;

  if (overviewFileFlag) {
    overviewPath = overviewFileFlag;
    overviewText = await fs.readFile(overviewFileFlag, "utf8");
    logInfo(verbose, `Using overview from ${overviewFileFlag}`);
  } else if (await fileExists(defaultOverview)) {
    overviewPath = defaultOverview;
    overviewText = await fs.readFile(defaultOverview, "utf8");
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
        overviewText = await fs.readFile(defaultOverview, "utf8");
      }
    }
  }

  if (!overviewText) {
    logInfo(verbose, "Falling back to simple file listing overview");
    const files = await listProjectFiles(srcRoot);
    overviewText = [
      `Simple file listing for ${srcRoot}`,
      "",
      ...files.map((f) => `FILE ${f}`),
    ].join("\n");
  }

  if (overviewText.length > MAX_OVERVIEW_CHARS) {
    overviewText = `${overviewText.slice(0, MAX_OVERVIEW_CHARS)}\n[NOTE: overview truncated to ${MAX_OVERVIEW_CHARS} characters for model context.]`;
  }

  overviewText = ensureTrailingNewline(overviewText);
  return { overviewPath, overviewText };
}

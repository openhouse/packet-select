import fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { logInfo } from "./utils.js";

async function pathExists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function executableExists(p) {
  try {
    await fs.access(p, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export async function buildSubtrees({
  srcRoot,
  outDir,
  frequencyPath,
  buildSubtreesBin,
  buildSubtreesBinWasProvided = false,
  min,
  max,
  verbose,
}) {
  const builderIsUsable = await executableExists(buildSubtreesBin);

  if (!builderIsUsable) {
    const message = `Subtree builder not found or not executable at ${buildSubtreesBin}`;
    if (buildSubtreesBinWasProvided) {
      throw new Error(`${message}\n  - To disable subtree generation, pass --no-build-subtrees\n  - To specify a script, pass --build-subtrees-bin /path/to/crs_build_subtrees.sh`);
    }
    console.warn(
      `packet-select WARN: ${message}; skipping subtree generation. ` +
      "Pass --build-subtrees-bin /path/to/script or --no-build-subtrees to silence this."
    );
    return null;
  }
  if (!(await pathExists(frequencyPath))) {
    throw new Error(`Frequency TSV missing at ${frequencyPath}`);
  }
  const destRoot = path.join(outDir, "subtrees");
  await fs.mkdir(destRoot, { recursive: true });
  const args = [
    "--src-root", srcRoot,
    "--dest-root", destRoot,
    "--input", frequencyPath,
    "--min", String(min),
    "--max", String(max),
  ];
  logInfo(verbose, `Running subtree builder: ${buildSubtreesBin} ${args.join(" ")}`);
  await new Promise((resolve, reject) => {
    const child = spawn(buildSubtreesBin, args, { stdio: "inherit" });
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Subtree builder exited with ${code}`));
    });
    child.on("error", reject);
  });
  return destRoot;
}

export async function generateBucketOverviews({ subtreesRoot, overviewScriptPath, verbose, overviewCollectionDir }) {
  if (!(await pathExists(subtreesRoot))) return [];
  const entries = await fs.readdir(subtreesRoot, { withFileTypes: true });
  const buckets = entries.filter((e) => e.isDirectory() && e.name.startsWith("gte"));
  const generated = [];
  if (overviewCollectionDir) {
    await fs.mkdir(overviewCollectionDir, { recursive: true });
  }
  for (const bucket of buckets) {
    const bucketDir = path.join(subtreesRoot, bucket.name);
    const scriptsDir = path.join(bucketDir, "scripts");
    await fs.mkdir(scriptsDir, { recursive: true });
    const destScript = path.join(scriptsDir, "generate-overview.sh");
    await fs.copyFile(overviewScriptPath, destScript);
    await fs.chmod(destScript, 0o755);
    logInfo(verbose, `Generating overview for ${bucketDir}`);
    await new Promise((resolve, reject) => {
      const child = spawn("bash", [destScript], { cwd: bucketDir, stdio: "inherit" });
      child.on("exit", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`generate-overview.sh exited with ${code} for ${bucketDir}`));
      });
      child.on("error", reject);
    });
    const overviewPath = path.join(bucketDir, "project-overview.txt");
    generated.push(overviewPath);
    if (overviewCollectionDir) {
      try {
        await fs.access(overviewPath);
        const dest = path.join(overviewCollectionDir, `${bucket.name}-project-overview.txt`);
        await fs.copyFile(overviewPath, dest);
        logInfo(verbose, `Copied bucket overview to ${dest}`);
      } catch {
        logInfo(verbose, `Skipping missing overview for ${bucketDir}`);
      }
    }
  }
  return generated;
}

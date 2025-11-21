import path from "node:path";
import fs from "node:fs/promises";

export const IGNORE_DIRS = new Set([
  ".git",
  "node_modules",
  ".venv",
  "__pycache__",
  ".DS_Store",
  "dist",
  ".vscode",
  "coverage",
]);

export function normalizeRelativePath(p) {
  if (!p) return "";
  let normalized = p.replace(/\\/g, "/");
  normalized = normalized.replace(/^\.\//, "");
  normalized = normalized.replace(/^\//, "");
  return normalized.trim();
}

export async function listProjectFiles(root) {
  const results = [];
  async function walk(current) {
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      if (IGNORE_DIRS.has(entry.name)) continue;
      const full = path.join(current, entry.name);
      const rel = path.relative(root, full) || entry.name;
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        results.push(rel.split(path.sep).join("/"));
      }
    }
  }
  await walk(root);
  return results.sort();
}

export function ensureTrailingNewline(text) {
  return text.endsWith("\n") ? text : `${text}\n`;
}

export function padIndex(index, width) {
  return String(index).padStart(width, "0");
}

export function logInfo(verbose, message) {
  if (verbose) {
    console.error(`packet-select: ${message}`);
  }
}

export function logWarn(message) {
  console.error(`packet-select WARN: ${message}`);
}

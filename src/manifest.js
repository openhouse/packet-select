import fs from "node:fs/promises";
import path from "node:path";
import { ensureTrailingNewline, IGNORE_DIRS, normalizeRelativePath } from "./utils.js";

function detectType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if ([".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".py", ".rb", ".go", ".rs", ".java"].includes(ext)) return "text/code";
  if ([".md", ".txt", ".rst"].includes(ext)) return "text/plain";
  if ([".json"].includes(ext)) return "application/json";
  if ([".yaml", ".yml"].includes(ext)) return "application/yaml";
  if ([".html", ".css"].includes(ext)) return "text/web";
  if ([".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp", ".heic"].includes(ext)) return "image";
  if ([".pdf"].includes(ext)) return "application/pdf";
  if ([".mp3", ".m4a", ".wav", ".aac"].includes(ext)) return "audio";
  if ([".mp4", ".mov", ".avi"].includes(ext)) return "video";
  return ext ? `file/${ext.slice(1)}` : "application/octet-stream";
}

export async function buildProjectManifest(srcRoot, { excludedRoots = new Set() } = {}) {
  const records = [];
  const shouldExcludePath = (rel) => [...excludedRoots].some((root) => rel === root || rel.startsWith(`${root}/`));
  async function walk(current) {
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      if (IGNORE_DIRS.has(entry.name)) continue;
      const full = path.join(current, entry.name);
      const rel = normalizeRelativePath(path.relative(srcRoot, full).split(path.sep).join("/"));
      if (shouldExcludePath(rel)) continue;
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      const stat = await fs.stat(full);
      records.push({ path: rel, size: stat.size, mtimeMs: stat.mtimeMs, mtime: stat.mtime.toISOString(), type: detectType(rel) });
    }
  }
  await walk(srcRoot);
  return records.sort((a, b) => a.path.localeCompare(b.path));
}

export function formatManifestJsonl(records) {
  return ensureTrailingNewline(records.map((record) => JSON.stringify({ path: record.path, size: record.size, mtime: record.mtime, type: record.type })).join("\n"));
}

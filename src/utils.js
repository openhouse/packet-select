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

const DEFAULT_OUTPUT_ARTIFACT_DIRS = ["minutes", "decisions", "errors", "data", "subtrees", "project-overviews"];

export function normalizeRelativePath(p) {
  if (!p) return "";
  let normalized = p.normalize("NFKC").replace(/\\/g, "/");
  normalized = normalized.replace(/^\.\//, "");
  normalized = normalized.replace(/^\//, "");
  normalized = normalized.replace(/%20/g, " ");
  normalized = normalized.replace(/[?#].*$/, "");
  normalized = normalized.replace(/\s+/g, " ");
  return normalized.trim();
}

export function canonicalizeRelativePath(p) {
  return normalizeRelativePath(decodeURIComponentSafe(p))
    .toLowerCase()
    .replace(/\.(md|markdown|txt|pdf)$/g, "")
    .replace(/[^a-z0-9/]+/g, "")
    .replace(/\/+/g, "/");
}

function decodeURIComponentSafe(value) {
  try {
    return decodeURIComponent(value || "");
  } catch {
    return value || "";
  }
}

export function buildExcludedRoots({ srcRoot, outDir }) {
  const excluded = new Set();
  if (!srcRoot || !outDir) return excluded;
  const relativeOut = path.relative(srcRoot, outDir);
  if (relativeOut && !relativeOut.startsWith("..") && !path.isAbsolute(relativeOut)) {
    const normalized = normalizeRelativePath(relativeOut);
    excluded.add(normalized);
    for (const name of DEFAULT_OUTPUT_ARTIFACT_DIRS) {
      excluded.add(normalizeRelativePath(path.posix.join(normalized, name)));
    }
  }
  for (const name of DEFAULT_OUTPUT_ARTIFACT_DIRS) excluded.add(name);
  return excluded;
}

function shouldExcludePath(rel, excludedRoots) {
  if (!excludedRoots?.size) return false;
  return [...excludedRoots].some((root) => rel === root || rel.startsWith(`${root}/`));
}

export async function listProjectFiles(root, { excludedRoots = new Set() } = {}) {
  const results = [];
  async function walk(current) {
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      if (IGNORE_DIRS.has(entry.name)) continue;
      const full = path.join(current, entry.name);
      const rel = normalizeRelativePath(path.relative(root, full) || entry.name);
      if (shouldExcludePath(rel, excludedRoots)) continue;
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        results.push(rel);
      }
    }
  }
  await walk(root);
  return results.sort();
}

export function buildCanonicalFileMap(paths) {
  const map = new Map();
  for (const filePath of paths) {
    const canonical = canonicalizeRelativePath(filePath);
    if (canonical && !map.has(canonical)) map.set(canonical, filePath);
  }
  return map;
}

export function findNearestManifestMatches(candidate, fileSet, canonicalFileMap = buildCanonicalFileMap(fileSet)) {
  const normalized = normalizeRelativePath(candidate);
  const canonical = canonicalizeRelativePath(normalized);
  const matches = [];
  if (canonicalFileMap.has(canonical)) matches.push(canonicalFileMap.get(canonical));
  for (const filePath of fileSet) {
    if (matches.length >= 3) break;
    const lower = filePath.toLowerCase();
    if (lower.includes(normalized.toLowerCase()) || canonicalizeRelativePath(filePath).includes(canonical) || canonical.includes(canonicalizeRelativePath(filePath))) {
      if (!matches.includes(filePath)) matches.push(filePath);
    }
  }
  return matches.slice(0, 3);
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

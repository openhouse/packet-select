import fs from "node:fs/promises";
import path from "node:path";
import { ensureTrailingNewline, normalizeRelativePath } from "./utils.js";

const DEFAULT_CHARS_PER_TOKEN = 4;

export function estimateTokens(text) {
  if (!text) return 0;
  return Math.ceil(text.length / DEFAULT_CHARS_PER_TOKEN);
}

function parseDirectorySection(text) {
  const fileHeaderMatch = text.match(/^### File:/m);
  if (!fileHeaderMatch) {
    return text.trim() ? text.trim() : "";
  }
  return text.slice(0, fileHeaderMatch.index).trim();
}

function extractFileBlocks(text) {
  const regex = /^### File:\s+(.+)$/gm;
  const matches = [...text.matchAll(regex)];
  return matches.map((match, index) => {
    const start = match.index;
    const end = index + 1 < matches.length ? matches[index + 1].index : text.length;
    const block = text.slice(start, end).trim();
    const filePath = normalizeRelativePath(match[1]);
    return { filePath, block, index };
  });
}

function buildPathTerms(promptText = "") {
  return new Set((promptText.toLowerCase().match(/[a-z0-9_.\-/]+/g) || []).filter((term) => term.length >= 3));
}

function fileImportanceScore(filePath) {
  const lower = filePath.toLowerCase();
  let score = 0;
  if (/readme|package\.json|tsconfig|pyproject|cargo\.toml|makefile|dockerfile/.test(lower)) score += 8;
  if (/src\//.test(lower)) score += 5;
  if (/test|spec/.test(lower)) score += 3;
  if (/docs\//.test(lower)) score += 2;
  if (/\.md$|\.json$|\.ya?ml$|\.toml$|\.js$|\.ts$|\.py$/.test(lower)) score += 2;
  return score;
}

function relevanceScore(filePath, promptTerms) {
  const lower = filePath.toLowerCase();
  let score = 0;
  for (const term of promptTerms) {
    if (lower.includes(term)) score += term.length > 8 ? 4 : 2;
  }
  return score;
}

function balancedOrder(sections) {
  if (sections.length <= 2) return sections;
  const result = [];
  let left = 0;
  let right = sections.length - 1;
  while (left <= right) {
    result.push(sections[right]);
    if (left !== right) result.push(sections[left]);
    left += 1;
    right -= 1;
  }
  return result;
}

export function fitOverviewToTokenBudget({ overviewText, promptText, manifestRecords = [], maxOverviewTokens, reservedTokens = 0 }) {
  const directorySection = parseDirectorySection(overviewText);
  const fileBlocks = extractFileBlocks(overviewText);
  const promptTerms = buildPathTerms(promptText);
  const manifestMap = new Map(manifestRecords.map((record) => [record.path, record]));

  const scoredSections = fileBlocks.map((section, idx) => {
    const meta = manifestMap.get(section.filePath);
    const recency = meta?.mtimeMs || 0;
    const relevance = relevanceScore(section.filePath, promptTerms);
    const importance = fileImportanceScore(section.filePath);
    return {
      ...section,
      recency,
      relevance,
      importance,
      tokens: estimateTokens(section.block),
      ordinal: idx,
    };
  });

  let candidates;
  if (scoredSections.some((section) => section.recency > 0 || section.relevance > 0 || section.importance > 0)) {
    candidates = [...scoredSections].sort((a, b) => (
      (b.recency - a.recency) ||
      (b.relevance - a.relevance) ||
      (b.importance - a.importance) ||
      (a.ordinal - b.ordinal)
    ));
  } else {
    candidates = balancedOrder(scoredSections);
  }

  const omissionNotice = "[NOTE: Overview is token-budgeted. Additional sections were omitted; use the manifest for the full file list.]";
  const parts = [];
  let usedTokens = 0;
  const selectedPaths = [];
  const addPart = (text) => {
    const normalized = text.trim();
    if (!normalized) return false;
    const tokens = estimateTokens(normalized);
    if (usedTokens + tokens > maxOverviewTokens) return false;
    parts.push(normalized);
    usedTokens += tokens;
    return true;
  };

  addPart(directorySection || "Project overview digest unavailable.");
  for (const section of candidates) {
    if (usedTokens + section.tokens + estimateTokens(omissionNotice) + reservedTokens > maxOverviewTokens) {
      continue;
    }
    if (addPart(section.block)) {
      selectedPaths.push(section.filePath);
    }
  }
  addPart(omissionNotice);

  const text = ensureTrailingNewline(parts.join("\n\n"));
  return {
    text,
    stats: {
      selectedPaths,
      selectedSections: selectedPaths.length,
      totalSections: fileBlocks.length,
      directoryIncluded: Boolean(directorySection),
      omittedSections: Math.max(0, fileBlocks.length - selectedPaths.length),
      approxTokens: estimateTokens(text),
    },
  };
}

export async function writeContextArtifacts({ outDir, overviewText, stats }) {
  await fs.writeFile(path.join(outDir, "context-selected.txt"), ensureTrailingNewline(overviewText), "utf8");
  await fs.writeFile(path.join(outDir, "context-stats.json"), JSON.stringify(stats, null, 2));
}

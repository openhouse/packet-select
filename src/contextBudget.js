import fs from "node:fs/promises";
import path from "node:path";
import { ensureTrailingNewline, normalizeRelativePath } from "./utils.js";

const DEFAULT_CHARS_PER_TOKEN = 4;
const BINARY_EXTENSION_PATTERN = /\.(mp3|m4a|wav|aac|mp4|mov|avi|jpg|jpeg|png|gif|webp|heic|zip|bin)$/i;
const VOICE_SPECIMEN_PATTERN = /(transcript|otter|minutes|meeting|notes?|email|letter|memo|chat|slack|whatsapp|signal|telegram|conversation|interview|call|remarks|statement|draft|vtt|ocr)/i;
const REFERENCE_PATTERN = /(policy|legal|ordinance|statute|resolution|compliance|governance|report|brief|readme|manifest)/i;

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

function fileImportanceScore(filePath, meta = {}) {
  const lower = filePath.toLowerCase();
  const type = String(meta.type || "").toLowerCase();
  let score = 0;
  if (REFERENCE_PATTERN.test(lower)) score += 10;
  if (/readme|package\.json|tsconfig|pyproject|cargo\.toml|makefile|dockerfile/.test(lower)) score += 8;
  if (/docs\//.test(lower)) score += 4;
  if (/src\//.test(lower)) score += 5;
  if (VOICE_SPECIMEN_PATTERN.test(lower)) score += 14;
  if (/\.md$|\.txt$|\.json$|\.ya?ml$|\.toml$|\.js$|\.ts$|\.py$|\.pdf$/.test(lower)) score += 4;
  if (BINARY_EXTENSION_PATTERN.test(lower)) score -= 24;
  if (/audio|video|image|binary/.test(type)) score -= 18;
  if (/pdf|markdown|text|json|yaml|toml|javascript|typescript|python/.test(type)) score += 4;
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

function representativenessScore(section, sections) {
  const dir = section.filePath.split("/")[0] || "";
  const sameDir = sections.filter((candidate) => candidate.filePath.startsWith(`${dir}/`) || candidate.filePath === dir).length;
  return Math.min(8, sameDir);
}

function genreForSection(section, meta = {}) {
  const lower = section.filePath.toLowerCase();
  const type = String(meta.type || "").toLowerCase();
  if (BINARY_EXTENSION_PATTERN.test(lower) || /audio|video|image|binary/.test(type)) return "binary";
  if (VOICE_SPECIMEN_PATTERN.test(lower)) return "voice";
  if (REFERENCE_PATTERN.test(lower)) return "reference";
  if (/src\//.test(lower)) return "code";
  return "general";
}

export function fitOverviewToTokenBudget({ overviewText, promptText, manifestRecords = [], maxOverviewTokens, reservedTokens = 0 }) {
  const directorySection = parseDirectorySection(overviewText);
  const fileBlocks = extractFileBlocks(overviewText);
  const promptTerms = buildPathTerms(promptText);
  const manifestMap = new Map(manifestRecords.map((record) => [record.path, record]));

  const scoredSections = fileBlocks.map((section, idx, all) => {
    const meta = manifestMap.get(section.filePath);
    const recency = meta?.mtimeMs || 0;
    const relevance = relevanceScore(section.filePath, promptTerms);
    const importance = fileImportanceScore(section.filePath, meta);
    const genre = genreForSection(section, meta);
    const representativeness = representativenessScore(section, all);
    const voice = genre === "voice" ? 12 : 0;
    const centrality = (relevance > 0 ? 4 : 0) + representativeness;
    return {
      ...section,
      recency,
      relevance,
      importance,
      genre,
      representativeness,
      voice,
      centrality,
      tokens: estimateTokens(section.block),
      ordinal: idx,
      score: importance + relevance + voice + centrality + Math.min(6, Math.floor(recency / 1_000_000_000)),
    };
  });

  const candidates = [...scoredSections].sort((a, b) => (
    (b.score - a.score) ||
    (b.voice - a.voice) ||
    (b.relevance - a.relevance) ||
    (b.recency - a.recency) ||
    (a.ordinal - b.ordinal)
  ));

  const omissionNotice = "[NOTE: Overview is token-budgeted. Additional sections were omitted; use the manifest for the full file list.]";
  const parts = [];
  let usedTokens = 0;
  const selectedPaths = [];
  const genreCounts = new Map();
  const targetVoiceSelections = Math.max(1, Math.min(6, Math.ceil(fileBlocks.length * 0.2)));

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

  const ordered = [
    ...candidates.filter((section) => section.genre === "voice"),
    ...candidates.filter((section) => section.genre !== "voice"),
  ];

  for (const section of ordered) {
    const currentGenreCount = genreCounts.get(section.genre) || 0;
    const hasVoiceQuota = (genreCounts.get("voice") || 0) < targetVoiceSelections;
    const shouldPrioritize = section.genre === "voice" || currentGenreCount === 0 || !hasVoiceQuota;
    const neededReserve = estimateTokens(omissionNotice) + reservedTokens;
    if (!shouldPrioritize && section.genre === "binary") continue;
    if (usedTokens + section.tokens + neededReserve > maxOverviewTokens) continue;
    if (addPart(section.block)) {
      selectedPaths.push(section.filePath);
      genreCounts.set(section.genre, currentGenreCount + 1);
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
      genreCounts: Object.fromEntries(genreCounts),
    },
  };
}

export async function writeContextArtifacts({ outDir, overviewText, stats }) {
  await fs.writeFile(path.join(outDir, "context-selected.txt"), ensureTrailingNewline(overviewText), "utf8");
  await fs.writeFile(path.join(outDir, "context-stats.json"), JSON.stringify(stats, null, 2));
}

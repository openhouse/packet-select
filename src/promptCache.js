import crypto from "node:crypto";

export const MAX_PROMPT_CACHE_KEY_LENGTH = 64;
const DEFAULT_PROMPT_CACHE_PREFIX = "ps:v1:";
const PROMPT_CACHE_KEY_PATTERN = /^[\x20-\x7E]+$/;

function hashText(value) {
  return crypto.createHash("sha256").update(value || "", "utf8").digest("hex");
}

export function sanitizePromptCacheKey(value, { prefix = DEFAULT_PROMPT_CACHE_PREFIX } = {}) {
  if (value == null) return null;
  const trimmed = String(value).trim();
  if (!trimmed) return null;
  const ascii = trimmed.replace(/[^\x20-\x7E]/g, "_");
  if (ascii.length <= MAX_PROMPT_CACHE_KEY_LENGTH && PROMPT_CACHE_KEY_PATTERN.test(ascii)) return ascii;
  const digest = hashText(trimmed);
  return `${prefix}${digest}`.slice(0, MAX_PROMPT_CACHE_KEY_LENGTH);
}

export function validatePromptCacheKey(value) {
  if (value == null) return { valid: true };
  if (typeof value !== "string" || !value.trim()) return { valid: false, reason: "prompt cache key must be a non-empty string" };
  if (!PROMPT_CACHE_KEY_PATTERN.test(value)) return { valid: false, reason: "prompt cache key must contain printable ASCII characters only" };
  if (value.length > MAX_PROMPT_CACHE_KEY_LENGTH) return { valid: false, reason: `prompt cache key must be <= ${MAX_PROMPT_CACHE_KEY_LENGTH} characters` };
  return { valid: true };
}

export function buildPromptCacheKey({ enabled = true, explicitKey = null, srcRoot, model, promptText = "", manifestText = "", overviewText = "", version = "v1" }) {
  if (!enabled) return null;
  if (explicitKey != null) return sanitizePromptCacheKey(explicitKey, { prefix: `ps:${version}:` });
  const canonical = JSON.stringify({
    version,
    root: srcRoot ? String(srcRoot).split(/[\\/]/).filter(Boolean).at(-1) || "root" : "root",
    model,
    promptDigest: hashText(promptText),
    manifestDigest: hashText(manifestText),
    overviewDigest: hashText(overviewText),
  });
  return `ps:${version}:${hashText(canonical).slice(0, 40)}`;
}

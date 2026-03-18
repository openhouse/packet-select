import { test } from "node:test";
import { strict as assert } from "node:assert";
import { buildMeetingInput, buildMeetingRequest, estimateRequestTokens, isDeterministicRequestError } from "../src/meeting.js";
import { buildPromptCacheKey, sanitizePromptCacheKey } from "../src/promptCache.js";

test("buildMeetingInput places shared manifest and overview before meeting-specific curator info", () => {
  const built = buildMeetingInput({
    curators: ["A", "B"],
    promptText: "Choose wisely",
    overviewText: "OVERVIEW",
    manifestText: '{"path":"src/index.js"}',
    srcRoot: "/tmp/project",
    sampleSize: 3,
    runIndex: 1,
    fileCount: 1,
    round: 1,
    meetingMode: "cross-pollinate",
    meetingSize: 2,
  });
  const body = built.input[0].content[0].text;
  assert.ok(body.indexOf("Project manifest") < body.indexOf("Curators:"));
  assert.ok(body.indexOf("Project overview digest") < body.indexOf("Curators:"));
});

test("derived prompt cache key stays short, stable, and path-independent", () => {
  const params = {
    srcRoot: "/abs/very/long/root/path/project-alpha",
    model: "gpt-4.1-mini",
    promptText: "Prompt body",
    manifestText: '{"path":"docs/policy.md"}',
    overviewText: "Overview body",
  };
  const one = buildPromptCacheKey(params);
  const two = buildPromptCacheKey({ ...params, srcRoot: "/different/machine/path/project-alpha" });
  assert.ok(one.length <= 64);
  assert.equal(one, two);
  assert.doesNotMatch(one, /\/abs\/|different\/machine|project-overview\.llm\.txt/);
});

test("derived prompt cache key changes when prompt or overview changes", () => {
  const base = {
    srcRoot: "/repo/root/project-alpha",
    model: "gpt-4.1-mini",
    promptText: "Prompt A",
    manifestText: '{"path":"docs/policy.md"}',
    overviewText: "Overview A",
  };
  const original = buildPromptCacheKey(base);
  assert.notEqual(original, buildPromptCacheKey({ ...base, promptText: "Prompt B" }));
  assert.notEqual(original, buildPromptCacheKey({ ...base, overviewText: "Overview B" }));
});

test("long user prompt cache key is sanitized safely", () => {
  const input = "/very/long/path/".repeat(20);
  const key = sanitizePromptCacheKey(input);
  assert.ok(key.length <= 64);
  assert.match(key, /^ps:/);
});

test("buildMeetingRequest omits cache fields when prompt cache is disabled", () => {
  const request = buildMeetingInput({
    curators: ["A"],
    promptText: "Choose wisely",
    overviewText: "OVERVIEW",
    manifestText: '{"path":"src/index.js"}',
    srcRoot: "/tmp/project",
    sampleSize: 1,
    runIndex: 1,
    fileCount: 1,
    round: 1,
    meetingMode: "group",
    meetingSize: 1,
  });
  const payload = buildMeetingRequest({ model: "gpt-4.1-mini", request, maxOutputTokens: 1000, reasoningEffort: null, promptCache: null });
  assert.equal("prompt_cache_key" in payload, false);
  assert.equal("prompt_cache_retention" in payload, false);
});

test("estimateRequestTokens includes instructions in heuristic payload", async () => {
  const request = buildMeetingInput({
    curators: ["A"],
    promptText: "Choose wisely",
    overviewText: "OVERVIEW",
    manifestText: '{"path":"src/index.js"}',
    srcRoot: "/tmp/project",
    sampleSize: 1,
    runIndex: 1,
    fileCount: 1,
    round: 1,
    meetingMode: "group",
    meetingSize: 1,
  });
  const client = { responses: {} };
  const base = await estimateRequestTokens({ client, model: "gpt-4.1-mini", request, maxOutputTokens: 1000, reasoningEffort: null, promptCache: null });
  const larger = await estimateRequestTokens({ client, model: "gpt-4.1-mini", request: { ...request, instructions: `${request.instructions} Additional instruction text that should count.` }, maxOutputTokens: 1000, reasoningEffort: null, promptCache: null });
  assert.equal(base.method, "heuristic");
  assert.ok(larger.inputTokens > base.inputTokens);
});

test("deterministic validation 400s are classified for global abort", () => {
  assert.equal(isDeterministicRequestError({ status: 400, message: "Invalid 'prompt_cache_key': string too long" }), true);
  assert.equal(isDeterministicRequestError({ status: 400, message: "bad request" }), false);
  assert.equal(isDeterministicRequestError({ status: 429, message: "rate limited" }), false);
});

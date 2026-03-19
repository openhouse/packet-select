import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { buildMeetingInput, buildMeetingRequest, estimateRequestTokens, isDeterministicRequestError, parseMeetingResponse, runMeeting, MeetingIncompleteError } from "../src/meeting.js";
import { buildPromptCacheKey, sanitizePromptCacheKey, DEFAULT_PROMPT_CACHE_RETENTION } from "../src/promptCache.js";

function makeRequest() {
  return buildMeetingInput({
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
}

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
    model: "gpt-5.4",
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

test("long user prompt cache key is sanitized safely", () => {
  const input = "/very/long/path/".repeat(20);
  const key = sanitizePromptCacheKey(input);
  assert.ok(key.length <= 64);
  assert.match(key, /^ps:/);
});

test("prompt cache default retention is 24h", () => {
  assert.equal(DEFAULT_PROMPT_CACHE_RETENTION, "24h");
});

test("buildMeetingRequest omits cache fields when prompt cache is disabled", () => {
  const payload = buildMeetingRequest({ model: "gpt-5.4", request: makeRequest(), maxOutputTokens: 1000, reasoningEffort: null, promptCache: null });
  assert.equal("prompt_cache_key" in payload, false);
  assert.equal("prompt_cache_retention" in payload, false);
  assert.equal(payload.text.verbosity, "low");
});

test("estimateRequestTokens uses exact SDK path when available", async () => {
  const client = { responses: { inputTokens: { count: async () => ({ input_tokens: 321 }) } } };
  const result = await estimateRequestTokens({ client, model: "gpt-5.4", request: makeRequest(), maxOutputTokens: 1000, reasoningEffort: "high", promptCache: null });
  assert.equal(result.method, "exact_sdk");
  assert.equal(result.inputTokens, 321);
});

test("estimateRequestTokens uses REST fallback when SDK helper is unavailable", async () => {
  const client = { responses: {} };
  const fetchImpl = async () => ({ ok: true, json: async () => ({ input_tokens: 654 }) });
  const result = await estimateRequestTokens({ client, model: "gpt-5.4", request: makeRequest(), maxOutputTokens: 1000, reasoningEffort: "high", promptCache: null, apiKey: "test", fetchImpl, baseUrl: "https://api.openai.com" });
  assert.equal(result.method, "exact_rest_fallback");
  assert.equal(result.inputTokens, 654);
});

test("estimateRequestTokens falls back to heuristic when exact counting is unavailable", async () => {
  const client = { responses: {} };
  const base = await estimateRequestTokens({ client, model: "gpt-5.4", request: makeRequest(), maxOutputTokens: 1000, reasoningEffort: null, promptCache: null, fetchImpl: null });
  const larger = await estimateRequestTokens({ client, model: "gpt-5.4", request: { ...makeRequest(), instructions: `${makeRequest().instructions} Additional instruction text that should count.` }, maxOutputTokens: 1000, reasoningEffort: null, promptCache: null, fetchImpl: null });
  assert.equal(base.method, "heuristic");
  assert.ok(larger.inputTokens > base.inputTokens);
});

test("parseMeetingResponse handles incomplete max_output_tokens before JSON.parse and writes diagnostics", async () => {
  const errorsDir = await fs.mkdtemp(path.join(os.tmpdir(), "packet-select-errors-"));
  await assert.rejects(
    () => parseMeetingResponse({
      response: {
        id: "resp_1",
        status: "incomplete",
        incomplete_details: { reason: "max_output_tokens" },
        output_text: '{"summary":"partial"',
        usage: { input_tokens: 10, output_tokens: 20, output_tokens_details: { reasoning_tokens: 11 } },
      },
      runIndex: 1,
      errorsDir,
      maxOutputTokens: 4096,
      reasoningEffort: "high",
    }),
    (error) => {
      assert.equal(error instanceof MeetingIncompleteError, true);
      assert.match(error.message, /incomplete before JSON parse/i);
      return true;
    },
  );
  const diagnostic = JSON.parse(await fs.readFile(path.join(errorsDir, "meeting-001.diagnostic.json"), "utf8"));
  assert.equal(diagnostic.status, "incomplete");
  assert.equal(diagnostic.incomplete_details.reason, "max_output_tokens");
  assert.equal(diagnostic.reasoningTokens, 11);
  assert.equal(await fs.readFile(path.join(errorsDir, "meeting-001.output.txt"), "utf8"), '{"summary":"partial"');
});

test("parse failure with completed status writes diagnostics with usage metadata", async () => {
  const errorsDir = await fs.mkdtemp(path.join(os.tmpdir(), "packet-select-errors-"));
  await assert.rejects(
    () => parseMeetingResponse({
      response: { id: "resp_2", status: "completed", output_text: '{"broken":', usage: { input_tokens: 100, output_tokens: 30 } },
      runIndex: 2,
      errorsDir,
      maxOutputTokens: 8192,
      reasoningEffort: "high",
    }),
    /Failed to parse JSON/,
  );
  const diagnostic = JSON.parse(await fs.readFile(path.join(errorsDir, "meeting-002.diagnostic.json"), "utf8"));
  assert.equal(diagnostic.status, "completed");
  assert.equal(diagnostic.usage.input_tokens, 100);
  assert.equal(diagnostic.parseError.name, "SyntaxError");
});

test("runMeeting auto-escalates output budget before succeeding", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "packet-select-run-"));
  let createCalls = 0;
  const client = {
    responses: {
      create: async (payload) => {
        createCalls += 1;
        if (createCalls === 1) {
          assert.equal(payload.max_output_tokens, 8192);
          return { id: "resp_incomplete", status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output_text: '{"summary":"partial"', usage: { output_tokens_details: { reasoning_tokens: 2000 } } };
        }
        assert.equal(payload.max_output_tokens, 16384);
        return {
          id: "resp_complete",
          status: "completed",
          output_text: JSON.stringify({ curators: ["A"], run_index: 1, sample_size: 1, summary: "ok", minutes: [], decisions: { packet_summary: "done", keep: [{ path: "docs/recording notes.md", reason: "voice" }] } }),
          usage: { input_tokens: 120, output_tokens: 220, input_tokens_details: { cached_tokens: 10 }, output_tokens_details: { reasoning_tokens: 30 } },
        };
      },
    },
  };
  const result = await runMeeting({
    client,
    model: "gpt-5.4",
    curators: ["A"],
    promptText: "Choose wisely",
    overviewText: "OVERVIEW",
    manifestText: '{"path":"docs/recording notes.md"}',
    srcRoot: "/tmp/project",
    sampleSize: 1,
    runIndex: 1,
    fileSet: new Set(["docs/recording notes.md"]),
    canonicalFileMap: new Map([["docsrecordingnotes", "docs/recording notes.md"]]),
    minutesDir: path.join(tempDir, "minutes"),
    decisionsDir: path.join(tempDir, "decisions"),
    errorsDir: path.join(tempDir, "errors"),
    verbose: false,
    reasoningEffort: "high",
    maxOutputTokens: 8192,
    requestTimeoutMs: 10,
    maxRetries: 0,
    estimatedInputTokens: 500,
    promptCache: { key: "abc", retention: "24h" },
    tokenCountMethod: "exact_sdk",
  });
  assert.equal(result.maxOutputTokens, 16384);
  assert.equal(result.retries, 1);
  assert.equal(createCalls, 2);
});

test("deterministic validation 400s are classified for global abort", () => {
  assert.equal(isDeterministicRequestError({ status: 400, message: "Invalid 'prompt_cache_key': string too long" }), true);
  assert.equal(isDeterministicRequestError({ status: 400, message: "bad request" }), false);
  assert.equal(isDeterministicRequestError({ status: 429, message: "rate limited" }), false);
});

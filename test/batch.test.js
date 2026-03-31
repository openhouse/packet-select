import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { strict as assert } from "node:assert";
import {
  buildBatchRequestLine,
  buildCustomId,
  shardBatchRequests,
  parseBatchOutputJsonl,
  reconcileBatchResults,
} from "../src/batch.js";
import { buildMeetingInput, buildMeetingRequest, extractResponseOutputText } from "../src/meeting.js";

function samplePayload() {
  const request = buildMeetingInput({
    curators: ["A"],
    promptText: "Choose",
    overviewText: "Overview",
    manifestText: '{"path":"src/a.js"}',
    srcRoot: "/tmp/project",
    sampleSize: 2,
    runIndex: 1,
    fileCount: 1,
    round: 1,
    meetingMode: "group",
    meetingSize: 1,
  });
  return buildMeetingRequest({ model: "gpt-5.4", request, maxOutputTokens: 4096, reasoningEffort: "high", promptCache: null });
}

test("batch line wraps existing request body unchanged", () => {
  const payload = samplePayload();
  const line = buildBatchRequestLine({ customId: "meeting-001-attempt-0", payload });
  assert.equal(line.url, "/v1/responses");
  assert.deepEqual(line.body, payload);
});

test("custom ids are deterministic and unique", () => {
  const one = buildCustomId({ meetingIndex: 1, attempt: 0, width: 3 });
  const two = buildCustomId({ meetingIndex: 2, attempt: 0, width: 3 });
  assert.equal(one, "meeting-001-attempt-0");
  assert.equal(two, "meeting-002-attempt-0");
  assert.notEqual(one, two);
});

test("shardBatchRequests chunks by request count and byte size", () => {
  const lines = Array.from({ length: 5 }, (_, i) => buildBatchRequestLine({ customId: `meeting-00${i + 1}-attempt-0`, payload: samplePayload() }));
  const shardsByCount = shardBatchRequests(lines, { maxRequestsPerShard: 2, maxBytesPerShard: 10_000_000 });
  assert.equal(shardsByCount.length, 3);

  const shardsByBytes = shardBatchRequests(lines, { maxRequestsPerShard: 10, maxBytesPerShard: 2000 });
  assert.ok(shardsByBytes.length >= 2);
});

test("extractResponseOutputText supports raw batch response bodies", () => {
  const text = extractResponseOutputText({
    output: [{ content: [{ type: "output_text", text: '{"curators":["A"],"run_index":1,"sample_size":1,"summary":"ok","minutes":[],"decisions":{"packet_summary":"x","keep":[]}}' }] }],
  });
  assert.match(text, /"curators"/);
});

test("reconcileBatchResults handles out-of-order output and error lines idempotently", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "packet-select-batch-"));
  const minutesDir = path.join(dir, "minutes");
  const decisionsDir = path.join(dir, "decisions");
  const errorsDir = path.join(dir, "errors");
  await fs.mkdir(path.join(dir, "batch", "results"), { recursive: true });

  const okBody = {
    id: "resp_1",
    status: "completed",
    output: [{ content: [{ type: "output_text", text: JSON.stringify({ curators: ["A"], run_index: 1, sample_size: 2, summary: "ok", minutes: [], decisions: { packet_summary: "done", keep: [{ path: "src/a.js", reason: "needed" }] } }) }] }],
    usage: { input_tokens: 10, output_tokens: 20 },
  };
  const outputPath = path.join(dir, "batch", "results", "shard-001.output.jsonl");
  const errorPath = path.join(dir, "batch", "results", "shard-001.error.jsonl");
  await fs.writeFile(outputPath, `${JSON.stringify({ custom_id: "meeting-002-attempt-0", response: { status_code: 200, body: okBody } })}\n`);
  await fs.writeFile(errorPath, `${JSON.stringify({ custom_id: "meeting-001-attempt-0", error: { code: "bad_request", message: "boom" } })}\n`);

  const state = { shards: [{ shardIndex: 1, batchId: "batch_1", inputFileId: "file_1", outputPath, errorPath }] };
  const meetingMap = {
    "meeting-001-attempt-0": { meetingIndex: 1, round: 1, meetingMode: "group", meetingSize: 1, curators: ["A"], estimatedInputTokens: 10, tokenCountMethod: "heuristic", requestedMaxOutputTokens: 4096 },
    "meeting-002-attempt-0": { meetingIndex: 2, round: 1, meetingMode: "group", meetingSize: 1, curators: ["A"], estimatedInputTokens: 10, tokenCountMethod: "heuristic", requestedMaxOutputTokens: 4096 },
  };
  const fileSet = new Set(["src/a.js"]);
  const canonicalFileMap = new Map([["srcajs", "src/a.js"]]);

  const first = await reconcileBatchResults({ outDir: dir, state, meetingMap, fileSet, canonicalFileMap, minutesDir, decisionsDir, errorsDir, sampleSize: 2, verbose: false, reasoningEffort: "high", requestTimeoutMs: 1000, promptCache: null, maxOutputTokens: 4096 });
  const second = await reconcileBatchResults({ outDir: dir, state, meetingMap, fileSet, canonicalFileMap, minutesDir, decisionsDir, errorsDir, sampleSize: 2, verbose: false, reasoningEffort: "high", requestTimeoutMs: 1000, promptCache: null, maxOutputTokens: 4096 });

  assert.equal(first.successes, 1);
  assert.equal(first.failures, 1);
  assert.equal(second.successes, 1);
  assert.equal(second.failures, 1);
  const minutes = JSON.parse(await fs.readFile(path.join(minutesDir, "meeting-002.json"), "utf8"));
  assert.equal(minutes.transport, "batch");
  const err = await fs.readFile(path.join(errorsDir, "meeting-001.error.log"), "utf8");
  assert.match(err, /bad_request/);

  const parsed = parseBatchOutputJsonl(await fs.readFile(outputPath, "utf8"));
  assert.equal(parsed.length, 1);
});

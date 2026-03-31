import { test } from "node:test";
import { strict as assert } from "node:assert";
import { loadConfig } from "../src/config.js";

const BASE = [
  "--src-root", "/tmp/project",
  "--prompt", "hi",
  "--curators", "A,B",
  "--api-key", "k",
];

test("loadConfig parses batch execution flags", () => {
  const cfg = loadConfig([...BASE, "--execution-mode", "batch", "--batch-submit-only", "--batch-poll-interval-ms", "31000"]);
  assert.equal(cfg.executionMode, "batch");
  assert.equal(cfg.batchSubmitOnly, true);
  assert.equal(cfg.batchPollIntervalMs, 31000);
  assert.match(cfg.batchStateFile, /batch\/state\.json$/);
});

test("batch collect mode can parse without core planning flags", () => {
  const cfg = loadConfig(["--batch-collect", "--batch-state-file", "/tmp/out/batch/state.json", "--api-key", "k"]);
  assert.equal(cfg.batchCollectOnly, true);
  assert.equal(cfg.executionMode, "batch");
});

test("loadConfig no longer exposes resumeBatchId", () => {
  const cfg = loadConfig([...BASE]);
  assert.equal("resumeBatchId" in cfg, false);
});

import { test } from "node:test";
import { strict as assert } from "node:assert";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { aggregateDecisions } from "../src/aggregate.js";

async function writeJson(filePath, data) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(data, null, 2));
}

test("aggregateDecisions tallies keep votes", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "packet-select-test-"));
  const decisionsDir = path.join(tmpDir, "decisions");

  await writeJson(path.join(decisionsDir, "decisions-001.json"), {
    meetingIndex: 1,
    keep: [
      { path: "docs/a.txt", reason: "" },
      { path: "docs/b.txt", reason: "" },
    ],
  });

  await writeJson(path.join(decisionsDir, "decisions-002.json"), {
    meetingIndex: 2,
    keep: [
      { path: "docs/a.txt", reason: "again" },
      { path: "docs/c.txt", reason: "" },
    ],
  });

  const fileSet = new Set(["docs/a.txt", "docs/b.txt", "docs/c.txt"]);
  const { votes, records, maxCount, frequencyTsv } = await aggregateDecisions({
    decisionsDir,
    fileSet,
    sampleSize: 2,
  });

  assert.equal(maxCount, 2);
  assert.deepEqual(records.map((r) => r.path), ["docs/a.txt", "docs/b.txt", "docs/c.txt"]);
  assert.equal(votes["docs/a.txt"].rawCount, 2);
  assert.equal(votes["docs/b.txt"].rawCount, 1);
  assert.equal(votes["docs/c.txt"].rawCount, 1);
  assert.ok(frequencyTsv.includes("2\tdocs/a.txt"));
});

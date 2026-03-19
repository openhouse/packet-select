import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { fitOverviewToTokenBudget } from "../src/contextBudget.js";
import { deriveOverviewBudget, resolveOverview } from "../src/overview.js";

const overviewText = `Project digest
Directory tree
- src/
- docs/

### File: docs/old.md
old notes

### File: src/core.js
important code

### File: docs/new.md
latest notes`;

const manifest = [
  { path: "docs/old.md", mtimeMs: 100, size: 10, mtime: "2024-01-01T00:00:00.000Z", type: "text/plain" },
  { path: "src/core.js", mtimeMs: 200, size: 10, mtime: "2024-02-01T00:00:00.000Z", type: "text/code" },
  { path: "docs/new.md", mtimeMs: 300, size: 10, mtime: "2024-03-01T00:00:00.000Z", type: "text/plain" },
];

test("fitOverviewToTokenBudget keeps directory section and omission note without blind prefix slicing", () => {
  const { text, stats } = fitOverviewToTokenBudget({
    overviewText,
    promptText: "Focus on docs/new.md and core behavior",
    manifestRecords: manifest,
    maxOverviewTokens: 80,
  });

  assert.match(text, /Directory tree/);
  assert.match(text, /omitted/i);
  assert.match(text, /### File: docs\/new.md/);
  assert.ok(stats.selectedSections >= 1);
  assert.equal(stats.directoryIncluded, true);
});

test("voice-bearing text artifacts remain eligible even when filenames mention recording or chat", () => {
  const text = `Digest

### File: chats/whatsapp-2025.txt
chat voice

### File: media/audio-call.mp3
audio

### File: docs/policy-memo.pdf
policy

### File: meetings/recording_notes.md
minutes`;
  const manifestRecords = [
    { path: "chats/whatsapp-2025.txt", mtimeMs: 400, type: "text/plain" },
    { path: "media/audio-call.mp3", mtimeMs: 500, type: "audio/mpeg" },
    { path: "docs/policy-memo.pdf", mtimeMs: 100, type: "application/pdf" },
    { path: "meetings/recording_notes.md", mtimeMs: 200, type: "text/markdown" },
  ];
  const { stats } = fitOverviewToTokenBudget({
    overviewText: text,
    promptText: "Summarize the archive with voice",
    manifestRecords,
    maxOverviewTokens: 70,
  });
  assert.ok(stats.selectedPaths.includes("chats/whatsapp-2025.txt"));
  assert.ok(stats.selectedPaths.includes("meetings/recording_notes.md"));
  assert.ok(!stats.selectedPaths.includes("media/audio-call.mp3"));
});

test("deriveOverviewBudget allocates remaining budget after scaffold and reserve", () => {
  const budget = deriveOverviewBudget({
    maxInputTokens: 100000,
    fixedRequestTokens: 20000,
    reserveOutputTokens: 32000,
    safetyMarginTokens: 1000,
    maxOverviewTokens: 60000,
  });
  assert.equal(budget, 47000);
});

test("resolveOverview excludes self-ingested output directories nested under srcRoot", async () => {
  const srcRoot = await fs.mkdtemp(path.join(os.tmpdir(), "packet-select-src-"));
  await fs.mkdir(path.join(srcRoot, "packet-select-out", "minutes"), { recursive: true });
  await fs.mkdir(path.join(srcRoot, "docs"), { recursive: true });
  await fs.writeFile(path.join(srcRoot, "docs", "note.md"), "hello");
  await fs.writeFile(path.join(srcRoot, "packet-select-out", "minutes", "meeting-001.json"), "{}", "utf8");
  const outDir = path.join(srcRoot, "packet-select-out");
  const result = await resolveOverview({ srcRoot, outDir, promptText: "Find notes", verbose: false, overviewFileFlag: null, maxOverviewTokens: 1000 });
  assert.ok(result.manifestRecords.some((record) => record.path === "docs/note.md"));
  assert.ok(result.manifestRecords.every((record) => !record.path.startsWith("packet-select-out/")));
});

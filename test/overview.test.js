import { test } from "node:test";
import { strict as assert } from "node:assert";
import { fitOverviewToTokenBudget } from "../src/contextBudget.js";

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

test("fitOverviewToTokenBudget prefers policy and legal docs over chats and media by default", () => {
  const text = `Digest\n\n### File: chats/whatsapp-2025.txt\nchat\n\n### File: media/audio-call.mp3\naudio\n\n### File: docs/policy-memo.pdf\npolicy\n\n### File: meetings/city-council-minutes.md\nminutes`;
  const manifestRecords = [
    { path: "chats/whatsapp-2025.txt", mtimeMs: 400, type: "text/plain" },
    { path: "media/audio-call.mp3", mtimeMs: 500, type: "audio/mpeg" },
    { path: "docs/policy-memo.pdf", mtimeMs: 100, type: "application/pdf" },
    { path: "meetings/city-council-minutes.md", mtimeMs: 200, type: "text/markdown" },
  ];
  const { stats } = fitOverviewToTokenBudget({
    overviewText: text,
    promptText: "Summarize the archive",
    manifestRecords,
    maxOverviewTokens: 40,
  });
  assert.equal(stats.selectedPaths[0], "docs/policy-memo.pdf");
  assert.ok(!stats.selectedPaths.includes("chats/whatsapp-2025.txt") || stats.selectedPaths.indexOf("docs/policy-memo.pdf") < stats.selectedPaths.indexOf("chats/whatsapp-2025.txt"));
  assert.ok(!stats.selectedPaths.includes("media/audio-call.mp3"));
});

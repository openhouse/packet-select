import { test } from "node:test";
import { strict as assert } from "node:assert";
import { fitOverviewToTokenBudget } from "../src/contextBudget.js";

const overviewText = `Project digest\nDirectory tree\n- src/\n- docs/\n\n### File: docs/old.md\nold notes\n\n### File: src/core.js\nimportant code\n\n### File: docs/new.md\nlatest notes`;

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

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { buildMeetingInput } from "../src/meeting.js";

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

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { buildCoveringDesignForOneRound, buildCrossPollinateMeetings } from "../src/crossPollinate.js";

function assertPairCoverage(groups, n, k) {
  for (const group of groups) {
    assert.equal(group.length, k, `expected group length ${k}`);
    const unique = new Set(group);
    assert.equal(unique.size, group.length, "group contains duplicate curators");
  }

  const covered = new Set();
  const key = (i, j) => (i < j ? `${i}:${j}` : `${j}:${i}`);

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      covered.add(key(i, j));
    }
  }

  for (const group of groups) {
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        covered.delete(key(group[i], group[j]));
      }
    }
  }

  assert.equal(covered.size, 0, "not all pairs were covered");
}

test("buildCoveringDesignForOneRound covers all pairs for small n and k", () => {
  const sizes = [2, 3, 4];
  for (let n = 4; n <= 8; n++) {
    for (const k of sizes) {
      if (k > n) continue;
      const groups = buildCoveringDesignForOneRound(n, k);
      assertPairCoverage(groups, n, k);
    }
  }
});

test("k=2 reduces to all unordered pairs exactly once", () => {
  const n = 6;
  const expectedPairs = (n * (n - 1)) / 2;
  const groups = buildCoveringDesignForOneRound(n, 2);

  assert.equal(groups.length, expectedPairs);
  const seen = new Set(groups.map(([a, b]) => (a < b ? `${a}:${b}` : `${b}:${a}`)));
  assert.equal(seen.size, expectedPairs, "duplicate pairs detected");
  assertPairCoverage(groups, n, 2);
});

test("cross-pollinate scheduling defaults to pairs when meeting size omitted", () => {
  const curators = ["a", "b", "c", "d"];
  const sampleSize = 2;
  const { meetings, groupsPerRound, meetingSize } = buildCrossPollinateMeetings({ curators, sampleSize });

  const expectedGroupsPerRound = (curators.length * (curators.length - 1)) / 2;
  assert.equal(groupsPerRound, expectedGroupsPerRound);
  assert.equal(meetingSize, 2);
  assert.equal(meetings.length, sampleSize * expectedGroupsPerRound);
  meetings.forEach((m) => assert.equal(m.curators.length, 2));

  for (let round = 1; round <= sampleSize; round++) {
    const roundMeetings = meetings.filter((m) => m.round === round);
    const pairGroups = roundMeetings.map((m) => m.curators.map((name) => curators.indexOf(name)));
    assertPairCoverage(pairGroups, curators.length, 2);
  }
});

test("cross-pollinate scheduling builds covering k-person groups", () => {
  const curators = ["a", "b", "c", "d", "e"]; // n = 5
  const sampleSize = 3;
  const meetingSize = 3;
  const { meetings, groupsPerRound, meetingSize: resolvedSize } = buildCrossPollinateMeetings({
    curators,
    sampleSize,
    meetingSize,
  });

  assert.equal(resolvedSize, meetingSize);
  assert.equal(meetings.length, sampleSize * groupsPerRound);
  meetings.forEach((m) => assert.equal(m.curators.length, meetingSize));

  for (let round = 1; round <= sampleSize; round++) {
    const roundMeetings = meetings.filter((m) => m.round === round);
    const groupIndices = roundMeetings.map((m) => m.curators.map((name) => curators.indexOf(name)));
    assertPairCoverage(groupIndices, curators.length, meetingSize);
  }
});

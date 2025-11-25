export function buildCoveringDesignForOneRound(n, k) {
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`Invalid curator count n=${n}`);
  }
  if (!Number.isInteger(k) || k < 2 || k > n) {
    throw new Error(`Invalid meeting size k=${k} for n=${n}`);
  }

  const uncovered = new Set();
  const key = (i, j) => (i < j ? `${i}:${j}` : `${j}:${i}`);

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      uncovered.add(key(i, j));
    }
  }

  const groups = [];

  while (uncovered.size > 0) {
    const [anchor] = uncovered.values();
    const [iStr, jStr] = anchor.split(":");
    const group = [Number(iStr), Number(jStr)];

    while (group.length < k) {
      let bestCandidate = null;
      let bestScore = -1;

      for (let c = 0; c < n; c++) {
        if (group.includes(c)) continue;

        let score = 0;
        for (const p of group) {
          if (uncovered.has(key(c, p))) {
            score++;
          }
        }

        if (score > bestScore) {
          bestScore = score;
          bestCandidate = c;
        }
      }

      if (bestCandidate === null) {
        break;
      }

      group.push(bestCandidate);
    }

    group.sort((a, b) => a - b);
    groups.push(group);

    for (let x = 0; x < group.length; x++) {
      for (let y = x + 1; y < group.length; y++) {
        uncovered.delete(key(group[x], group[y]));
      }
    }
  }

  return groups;
}

export function buildCrossPollinateMeetings({ curators, sampleSize, meetingSize }) {
  const n = curators.length;
  const k = meetingSize ?? 2;

  if (!Number.isInteger(k)) {
    throw new Error("--meeting-size must be an integer");
  }
  if (k < 2) {
    throw new Error("--meeting-size must be at least 2 when using --cross-pollinate");
  }
  if (k > n) {
    throw new Error(`--meeting-size cannot exceed the number of curators (got ${k} > ${n})`);
  }

  const baseGroups = buildCoveringDesignForOneRound(n, k);
  const meetings = [];
  let meetingIndex = 1;

  for (let round = 1; round <= sampleSize; round++) {
    for (const group of baseGroups) {
      meetings.push({
        index: meetingIndex++,
        round,
        curators: group.map((idx) => curators[idx]),
        meetingSize: k,
      });
    }
  }

  return { meetings, groupsPerRound: baseGroups.length, meetingSize: k };
}

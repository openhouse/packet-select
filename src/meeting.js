import fs from "node:fs/promises";
import path from "node:path";
import OpenAI from "openai";
import { normalizeRelativePath, padIndex, logInfo, logWarn } from "./utils.js";

function buildMessages({ curators, promptText, overviewText, srcRoot, sampleSize, runIndex, fileCount }) {
  const system = `You are moderating a round-table discussion among curator panelists. Curators: ${curators.join(", ")}. \n` +
    `Return ONLY JSON matching this schema: { "curators": [names], "run_index": <number>, "sample_size": <number>, "summary": <string>, ` +
    `"minutes": [{"speaker": <name>, "text": <discussion>}], "decisions": {"packet_summary": <string>, "keep": [{"path": <relative path>, "reason": <string>}] } } \n` +
    `All file paths must be relative to ${srcRoot} and must come from the provided overview or file listing. Do not invent paths. Do not include Markdown or code fences.`;

  const user = `Curatorial prompt:\n${promptText}\n\nProject root: ${srcRoot}\nTotal known files: ${fileCount}.\nProject overview:\n${overviewText}\n` +
    `Please simulate a concise meeting among the named curators and output the JSON object described in the system message.`;

  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

function extractDecisions(parsed) {
  if (Array.isArray(parsed.decisions)) {
    return parsed.decisions;
  }
  if (parsed.decisions && Array.isArray(parsed.decisions.keep)) {
    return parsed.decisions.keep;
  }
  return [];
}

export async function runMeeting({
  client,
  model,
  curators,
  promptText,
  overviewText,
  srcRoot,
  sampleSize,
  runIndex,
  meetingMode = "group",
  round = 1,
  meetingSize = null,
  fileSet,
  minutesDir,
  decisionsDir,
  errorsDir,
  verbose,
  reasoningEffort,
}) {
  const messages = buildMessages({ curators, promptText, overviewText, srcRoot, sampleSize, runIndex, fileCount: fileSet.size });
  logInfo(verbose, `Starting meeting ${runIndex}/${sampleSize}`);

  const isGpt5 = typeof model === "string" && model.startsWith("gpt-5");
  const shouldSendReasoningEffort = isGpt5 && reasoningEffort && reasoningEffort !== "auto";

  const response = await client.chat.completions.create({
    model,
    messages,
    temperature: 1,
    response_format: { type: "json_object" },
    ...(shouldSendReasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
  });

  const content = response.choices?.[0]?.message?.content || "";
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    await fs.mkdir(errorsDir, { recursive: true });
    const errorPath = path.join(errorsDir, `meeting-${padIndex(runIndex, 3)}.txt`);
    await fs.writeFile(errorPath, content, "utf8");
    throw new Error(`Failed to parse JSON for meeting ${runIndex}: ${error.message}`);
  }

  const keepEntries = extractDecisions(parsed).map((item) => ({
    path: normalizeRelativePath(item.path),
    reason: item.reason || "",
  })).filter((item) => item.path);

  const filteredKeep = [];
  for (const entry of keepEntries) {
    if (!fileSet.has(entry.path)) {
      logWarn(`Meeting ${runIndex} referenced unknown path: ${entry.path}`);
      continue;
    }
    filteredKeep.push(entry);
  }

  const minutesPayload = {
    meetingIndex: runIndex,
    sampleSize,
    round,
    mode: meetingMode,
    meetingSize: meetingSize || curators.length,
    curators,
    prompt: "[omitted inline]",
    summary: parsed.summary || "",
    minutes: parsed.minutes || [],
  };

  const decisionsPayload = {
    meetingIndex: runIndex,
    sampleSize,
    round,
    mode: meetingMode,
    meetingSize: meetingSize || curators.length,
    curators,
    packetSummary: parsed.decisions?.packet_summary || "",
    keep: filteredKeep,
  };

  await fs.mkdir(minutesDir, { recursive: true });
  await fs.mkdir(decisionsDir, { recursive: true });

  const indexStr = padIndex(runIndex, Math.max(3, String(sampleSize).length));
  await fs.writeFile(path.join(minutesDir, `meeting-${indexStr}.json`), JSON.stringify(minutesPayload, null, 2));
  await fs.writeFile(path.join(decisionsDir, `decisions-${indexStr}.json`), JSON.stringify(decisionsPayload, null, 2));

  logInfo(verbose, `Finished meeting ${runIndex} with ${filteredKeep.length} keep decisions`);

  return { minutesPayload, decisionsPayload };
}

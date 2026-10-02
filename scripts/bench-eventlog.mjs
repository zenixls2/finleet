import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import inspector from "node:inspector";
import { EventLog, projectHistory } from "../packages/finleet-core/dist/domain.js";

const rounds = 9;
const sizes = [100, 1_000, 5_000];
const median = (values) => [...values].sort((left, right) => left - right)[Math.floor(values.length / 2)];
const legacySealCheck = (events) => {
  let validSeals = 0;
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    if (event.kind !== "BackgroundAgentBatchSealed") continue;
    if (events.slice(0, index).some((candidate) => candidate.sessionId === event.sessionId && (candidate.kind === "ProviderTurnFinished" || candidate.kind === "ProviderTurnFailed") && candidate.data.providerCallId === event.data.parentProviderCallId)) validSeals += 1;
  }
  return validSeals;
};
const indexedSealCheck = (events) => {
  const terminalProviderCalls = new Set();
  let validSeals = 0;
  for (const event of events) {
    if (event.kind === "ProviderTurnFinished" || event.kind === "ProviderTurnFailed") terminalProviderCalls.add(`${event.sessionId}:${event.data.providerCallId}`);
    if (event.kind === "BackgroundAgentBatchSealed" && terminalProviderCalls.has(`${event.sessionId}:${event.data.parentProviderCallId}`)) validSeals += 1;
  }
  return validSeals;
};
const root = mkdtempSync(join(tmpdir(), "finleet-eventlog-bench-"));
const profileSession = new inspector.Session();
profileSession.connect();
const profileCommand = (method) => new Promise((resolve, reject) => {
  profileSession.post(method, (error, result) => error === null ? resolve(result) : reject(error));
});

try {
  for (const size of sizes) {
    const log = new EventLog(join(root, `${size}.jsonl`));
    for (let index = 0; index < size; index += 1) {
      log.append("benchmark-session", {
        kind: "ProviderText",
        data: { providerCallId: `provider-${index}`, text: `bounded benchmark response ${index}`, truncated: false },
      });
    }

    const initial = log.read();
    if (!initial.ok) throw new Error(`Unable to read generated benchmark journal: ${initial.error.message}`);
    const readSamples = [];
    const projectionSamples = [];
    let observed = initial.value.length;

    for (let round = 0; round < rounds + 2; round += 1) {
      let started = performance.now();
      const result = log.read();
      const readElapsed = performance.now() - started;
      if (!result.ok) throw new Error(`Benchmark read failed: ${result.error.message}`);
      observed += result.value.length;

      started = performance.now();
      observed += projectHistory(result.value, "benchmark-session").length;
      const projectionElapsed = performance.now() - started;

      if (round >= 2) {
        readSamples.push(readElapsed);
        projectionSamples.push(projectionElapsed);
      }
    }

    if (size === sizes.at(-1)) {
      await profileCommand("Profiler.enable");
      await profileCommand("Profiler.start");
      for (let round = 0; round < 50; round += 1) {
        const result = log.read();
        if (!result.ok) throw new Error(`Profile read failed: ${result.error.message}`);
        projectHistory(result.value, "benchmark-session");
      }
      const { profile } = await profileCommand("Profiler.stop");
      const hotFunctions = profile.nodes
        .filter((node) => node.hitCount > 0 && node.callFrame.url.includes("finleet-core/dist/domain.js"))
        .map((node) => ({ function: node.callFrame.functionName, line: node.callFrame.lineNumber + 1, samples: node.hitCount }))
        .sort((left, right) => right.samples - left.samples)
        .slice(0, 10);
      console.log(JSON.stringify({ profileEvents: size, profileRounds: 50, hotFunctions }));
      await profileCommand("Profiler.disable");
    }

    console.log(JSON.stringify({
      events: size,
      readMedianMs: Number(median(readSamples).toFixed(3)),
      projectHistoryMedianMs: Number(median(projectionSamples).toFixed(3)),
      observed,
    }));
  }

  const sealCount = 1_000;
  const sealLog = new EventLog(join(root, "batch-seals.jsonl"));
  for (let index = 0; index < sealCount; index += 1) {
    const batchId = `batch-${index}`;
    const agentId = `agent-${index}`;
    const providerCallId = `provider-${index}`;
    sealLog.append("benchmark-session", {
      kind: "BackgroundAgentCreated",
      data: {
        agentId,
        parentSessionId: "benchmark-session",
        parentToolCallId: `tool-${index}`,
        profile: "read-only-research",
        childSessionId: `child-${index}`,
        contextMode: "fresh",
        provider: "fake",
        model: "fake/finleet",
        timeoutMs: 1,
        maxTurns: 1,
        task: "benchmark batch-seal validation",
        mode: "async",
        callbackId: `callback-${index}`,
        batchId,
        parentProviderCallId: providerCallId,
        parentAssistantMessageId: `run-${index}`,
      },
    });
    sealLog.append("benchmark-session", {
      kind: "ProviderTurnFinished",
      data: { providerCallId, finishReason: "stop", inputTokens: 0, outputTokens: 0 },
    });
    sealLog.append("benchmark-session", {
      kind: "BackgroundAgentBatchSealed",
      data: { batchId, parentProviderCallId: providerCallId, parentAssistantMessageId: `run-${index}`, agentIds: [agentId] },
    });
  }

  const sealSamples = [];
  const legacyCheckSamples = [];
  const indexedCheckSamples = [];
  for (let round = 0; round < rounds + 2; round += 1) {
    const started = performance.now();
    const result = sealLog.read();
    const elapsed = performance.now() - started;
    if (!result.ok) throw new Error(`Batch-seal benchmark read failed: ${result.error.message}`);
    if (round >= 2) sealSamples.push(elapsed);
    const legacyStarted = performance.now();
    const legacyCount = legacySealCheck(result.value);
    const legacyElapsed = performance.now() - legacyStarted;
    const indexedStarted = performance.now();
    const indexedCount = indexedSealCheck(result.value);
    const indexedElapsed = performance.now() - indexedStarted;
    if (legacyCount !== sealCount || indexedCount !== sealCount) throw new Error("Batch-seal comparison produced an invalid seal count");
    if (round >= 2) {
      legacyCheckSamples.push(legacyElapsed);
      indexedCheckSamples.push(indexedElapsed);
    }
  }
  console.log(JSON.stringify({ batchSeals: sealCount, events: sealCount * 3, readMedianMs: Number(median(sealSamples).toFixed(3)), legacySealCheckMedianMs: Number(median(legacyCheckSamples).toFixed(3)), indexedSealCheckMedianMs: Number(median(indexedCheckSamples).toFixed(3)) }));
} finally {
  profileSession.disconnect();
  rmSync(root, { recursive: true, force: true });
}

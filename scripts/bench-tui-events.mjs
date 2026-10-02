import inspector from "node:inspector";
import { performance } from "node:perf_hooks";
import { cacheSessionEvent, promptBoards, sessionEventsFromCache } from "../packages/finleet-tui/dist/tui.js";

const rounds = 7;
const sizes = [100, 300, 600, 1_000];
const sessionId = "benchmark-session";
const median = (values) => [...values].sort((left, right) => left - right)[Math.floor(values.length / 2)];
const makeEvents = (size) => [
  { schemaVersion: 1, id: "prompt-1", sessionId, kind: "PromptAdmitted", at: "2026-01-01T00:00:00.000Z", data: { promptId: "prompt-1", prompt: "benchmark", delivery: "queue" } },
  ...Array.from({ length: size }, (_, index) => ({
    schemaVersion: 1,
    id: `text-${index}`,
    sessionId,
    kind: "ProviderText",
    at: "2026-01-01T00:00:00.000Z",
    data: { providerCallId: "provider-1", text: "bounded stream chunk ".repeat(4), truncated: false },
  })),
];
const measureCache = (events) => {
  const cache = new Map();
  const started = performance.now();
  for (const event of events) cacheSessionEvent(cache, event);
  return { elapsed: performance.now() - started, cache };
};
const measureRepeatedProjection = (events) => {
  const cache = new Map();
  const started = performance.now();
  for (const event of events) {
    cacheSessionEvent(cache, event);
    promptBoards(sessionEventsFromCache(cache, sessionId), sessionId);
  }
  return performance.now() - started;
};
const measureCoalescedProjection = (events) => {
  const cache = new Map();
  const started = performance.now();
  for (const event of events) cacheSessionEvent(cache, event);
  const boards = promptBoards(sessionEventsFromCache(cache, sessionId), sessionId);
  return { elapsed: performance.now() - started, boardCount: boards.length };
};

const profile = new inspector.Session();
profile.connect();
const profileCommand = (method) => new Promise((resolve, reject) => {
  profile.post(method, (error, result) => error === null ? resolve(result) : reject(error));
});

try {
  await profileCommand("Profiler.enable");
  for (const size of sizes) {
    const events = makeEvents(size);
    const encoded = events.map((event) => JSON.stringify(event));
    const serializedBytes = encoded.reduce((total, text) => total + Buffer.byteLength(text), 0);
    const decoded = encoded.map((text) => JSON.parse(text));
    const cacheSamples = [];
    const projectionSamples = [];
    const endToEndSamples = [];
    const coalescedSamples = [];
    let result;
    for (let round = 0; round < rounds + 2; round += 1) {
      const cacheRun = measureCache(events);
      result = cacheRun;
      const projectionStarted = performance.now();
      promptBoards(events, sessionId);
      const projectionElapsed = performance.now() - projectionStarted;
      const repeatedElapsed = measureRepeatedProjection(events);
      const coalesced = measureCoalescedProjection(events);
      if (round >= 2) {
        cacheSamples.push(cacheRun.elapsed);
        projectionSamples.push(projectionElapsed);
        endToEndSamples.push(repeatedElapsed);
        coalescedSamples.push(coalesced.elapsed);
      }
    }
    console.log(JSON.stringify({
      events: size + 1,
      encodedBytes: serializedBytes,
      cacheAppendMedianMs: Number(median(cacheSamples).toFixed(3)),
      oneBoardProjectionMedianMs: Number(median(projectionSamples).toFixed(3)),
      perEventCacheAndProjectionMedianMs: Number(median(endToEndSamples).toFixed(3)),
      cacheAndFrameCoalescedProjectionMedianMs: Number(median(coalescedSamples).toFixed(3)),
      wireEncodeDecodeMedianMs: Number(median(Array.from({ length: rounds }, () => {
        const started = performance.now();
        for (const text of encoded) JSON.parse(text);
        return performance.now() - started;
      })).toFixed(3)),
      boardCount: promptBoards(sessionEventsFromCache(result.cache, sessionId), sessionId).length,
      decodedCount: decoded.length,
    }));
    if (size === sizes.at(-1)) {
      await profileCommand("Profiler.start");
      for (let round = 0; round < 5; round += 1) measureRepeatedProjection(events);
      const { profile: cpuProfile } = await profileCommand("Profiler.stop");
      const hotFunctions = cpuProfile.nodes
        .filter((node) => node.hitCount > 0 && node.callFrame.url.includes("finleet-tui/dist/tui.js"))
        .map((node) => ({ function: node.callFrame.functionName, line: node.callFrame.lineNumber + 1, samples: node.hitCount }))
        .sort((left, right) => right.samples - left.samples)
        .slice(0, 12);
      console.log(JSON.stringify({ profileEvents: size + 1, profileRounds: 5, hotFunctions }));
    }
  }
} finally {
  profile.disconnect();
}

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { execute } from "./cli.js";
import { admissionLockPath, digest, EventLog, fail, FileAdmissionLockFactory, FixturePaperExchange, materializeReadyBackgroundAgentBatchCallbacks, MAX_EVENT_PREVIEW, MAX_EVENT_TEXT, MAX_TOOL_RESULT, projectHistory, projectSessions, redactJson, sealBackgroundAgentBatches, type AdmissionLockFactory, type EventOfKind, type GraphPlanDraft, type Permission } from "./domain.js";
import { defaultPlan, effectiveDurableResultLimit, FakeProvider, FileSessionLeaseFactory, financeContext, formatLocalTimestamp, hasUnsettledGraphRun, publishPlan, quoteTool, recordedRunForAdmission, replay, Runner, sessionLeasePath, splitProviderText, ToolRegistry, type PermissionRequest, type Provider, type ProviderEvent, type ProviderRequest, type ToolDefinition } from "./runtime.js";
import { RPC_MAX_BYTES } from "./rpc-protocol.js";

const journal = (): string => join(mkdtempSync(join(tmpdir(), "finleet-")), "journal.jsonl");
const tools = (): ToolRegistry => new ToolRegistry(new Map([["paper_quote", quoteTool(new FixturePaperExchange())]]));
const draft = (nodes: GraphPlanDraft["nodes"] = [{ nodeId: "finish", kind: "finish", config: {} }]): GraphPlanDraft => ({ planId: "p", version: 1, sessionScope: "local", entryNode: "finish", activationState: "active", nodes, edges: [], limits: { maxTurns: 1, maxCost: 0, maxParallelism: 1, timeoutMs: 1 } });

test("versioned events reject malformed payloads and admission retries conflict exactly", () => {
  const path = journal(); writeFileSync(path, `${JSON.stringify({ schemaVersion: 1, id: "x", sessionId: "s", kind: "PromptAdmitted", at: "now", data: { promptId: "p", prompt: 4, delivery: "queue" } })}\n`);
  assert.equal(new EventLog(path).read().ok, false);
  const log = new EventLog(journal()); const first = log.admit({ sessionId: "s", promptId: "p", prompt: "hello", delivery: "queue" }); const retry = log.admit({ sessionId: "s", promptId: "p", prompt: "hello", delivery: "queue" }); const conflict = log.admit({ sessionId: "other", promptId: "p", prompt: "hello", delivery: "queue" });
  assert.equal(first.ok, true); assert.equal(retry.ok, true); assert.equal(conflict.ok, false); if (first.ok && retry.ok) assert.equal(first.value.id, retry.value.id);
});

test("ToolSucceeded durable results accept the per-tool maximum, reject larger journal input, and redact secrets", () => {
  const log = new EventLog(journal());
  const appended = log.append("s", { kind: "ToolSucceeded", data: { callId: "call", preview: "preview", truncated: false, result: "x".repeat(MAX_TOOL_RESULT), resultTruncated: false } });
  assert.equal(appended.kind, "ToolSucceeded");
  if (appended.kind !== "ToolSucceeded") return;
  assert.equal(appended.data.result?.length, MAX_TOOL_RESULT);
  const read = log.read();
  assert.equal(read.ok, true);
  if (read.ok) assert.equal(read.value[0]?.kind === "ToolSucceeded" && read.value[0].data.result?.length, MAX_TOOL_RESULT);
  assert.ok(Buffer.byteLength(JSON.stringify(appended), "utf8") < RPC_MAX_BYTES);
  const redacted = log.append("s", { kind: "ToolSucceeded", data: { callId: "secret", preview: "preview", truncated: false, result: `api_key=top-secret;${"測".repeat(1_000)}`, resultTruncated: false } });
  assert.equal(redacted.kind, "ToolSucceeded");
  if (redacted.kind !== "ToolSucceeded") return;
  assert.equal(redacted.data.result?.includes("top-secret"), false);
  assert.ok((redacted.data.result?.length ?? 0) > MAX_EVENT_TEXT);
  const oversizedPath = journal();
  writeFileSync(oversizedPath, `${JSON.stringify({ schemaVersion: 1, id: "oversized", sessionId: "s", kind: "ToolSucceeded", at: "now", data: { callId: "call", preview: "preview", truncated: false, result: "x".repeat(MAX_TOOL_RESULT + 1), resultTruncated: false } })}\n`);
  assert.equal(new EventLog(oversizedPath).read().ok, false);
});

test("durable result limit normalization fails closed for invalid values and clamps opt-ins", () => {
  assert.equal(effectiveDurableResultLimit(undefined), MAX_EVENT_TEXT);
  assert.equal(effectiveDurableResultLimit(256), 256);
  assert.equal(effectiveDurableResultLimit(Number.NaN), MAX_EVENT_TEXT);
  assert.equal(effectiveDurableResultLimit(-1), MAX_EVENT_TEXT);
  assert.equal(effectiveDurableResultLimit(0), MAX_EVENT_TEXT);
  assert.equal(effectiveDurableResultLimit(1.5), MAX_EVENT_TEXT);
  assert.equal(effectiveDurableResultLimit(MAX_TOOL_RESULT + 1), MAX_TOOL_RESULT);
});

test("local timestamp formatting includes seconds, a numeric offset, and an IANA zone", () => {
  assert.equal(formatLocalTimestamp(new Date("2026-06-01T12:34:56.789Z"), "UTC"), "2026-06-01T12:34:56+00:00 [UTC]");
  assert.equal(formatLocalTimestamp(new Date("2026-01-01T12:34:56.789Z"), "America/New_York"), "2026-01-01T07:34:56-05:00 [America/New_York]");
  assert.throws(() => formatLocalTimestamp(new Date("2026-01-01T00:00:00.000Z"), "Invalid/Zone"), /Invalid IANA time zone/);
});

test("legacy numeric continuation policy fields decode as the unbounded marker", () => {
  const path = journal();
  const plan = defaultPlan();
  const legacyPlan = { ...plan, limits: { ...plan.limits, continuationPolicy: { maxAdditionalWindows: 3, maxTotalTurns: 32 } } };
  writeFileSync(path, `${JSON.stringify({ schemaVersion: 1, id: "legacy-plan", sessionId: "s", kind: "GraphPlanPublished", at: "now", data: { plan: legacyPlan } })}\n`);
  const events = new EventLog(path).read();
  assert.equal(events.ok, true, events.ok ? "" : events.error.message);
  if (events.ok) {
    const published = events.value[0];
    assert.equal(published?.kind, "GraphPlanPublished");
    if (published?.kind === "GraphPlanPublished") assert.deepEqual(published.data.plan.limits.continuationPolicy, {});
  }
});

test("credential-shaped prompt retries canonicalize before durability and comparison", () => {
  const promptPairs: readonly (readonly [string, string])[] = [["apiKey=first-secret", "apiKey=second-secret"], ["access_token=first-secret", "access_token=second-secret"], ["client-secret=first-secret", "client-secret=second-secret"]];
  for (const [index, [firstPrompt, retryPrompt]] of promptPairs.entries()) {
    const log = new EventLog(journal()); const first = log.admit({ sessionId: "s", promptId: `p-${index}`, prompt: firstPrompt, delivery: "queue" }); const retry = log.admit({ sessionId: "s", promptId: `p-${index}`, prompt: retryPrompt, delivery: "queue" });
    assert.equal(first.ok, true); assert.equal(retry.ok, true); if (first.ok && retry.ok && first.value.kind === "PromptAdmitted") { assert.equal(first.value.id, retry.value.id); assert.equal(first.value.data.prompt.includes("[REDACTED]"), true); }
  }
});

test("admission atomically fails closed while a journal-side reservation is held", () => {
  const path = journal(); const factory = new FileAdmissionLockFactory(); const held = factory.acquire(path);
  assert.equal(held.ok, true); const contended = new EventLog(path, () => "2026-01-01T00:00:00.000Z", factory).admit({ sessionId: "s", promptId: "p", prompt: "hello", delivery: "queue" });
  assert.equal(contended.ok, false); if (!contended.ok) assert.equal(contended.error.code, "ADMISSION_BUSY");
  if (held.ok) held.value.release(); const admitted = new EventLog(path, () => "2026-01-01T00:00:01.000Z", factory).admit({ sessionId: "s", promptId: "p", prompt: "hello", delivery: "queue" });
  assert.equal(admitted.ok, true); assert.equal(existsSync(admissionLockPath(path)), false);
});

test("admission validation observes locked history, leaves rejected prompts durable-free, and skips exact retries", () => {
  const log = new EventLog(journal());
  const first = log.admit({ sessionId: "s", promptId: "first", prompt: "first", delivery: "queue" });
  assert.equal(first.ok, true);
  let validationCalls = 0;
  const rejected = log.admit({ sessionId: "s", promptId: "rejected", prompt: "second", delivery: "queue" }, (events) => {
    validationCalls += 1;
    assert.equal(events.filter((event) => event.kind === "PromptAdmitted").length, 1);
    return fail("CONTEXT_OVERFLOW", "Projected request exceeds the catalog context limit before durable admission");
  });
  assert.equal(rejected.ok, false);
  if (!rejected.ok) assert.equal(rejected.error.code, "CONTEXT_OVERFLOW");
  const afterRejected = log.read();
  assert.equal(afterRejected.ok, true);
  if (afterRejected.ok) assert.equal(afterRejected.value.filter((event) => event.kind === "PromptAdmitted").length, 1);
  const retry = log.admit({ sessionId: "s", promptId: "first", prompt: "first", delivery: "queue" }, () => {
    validationCalls += 1;
    return fail("CONTEXT_OVERFLOW", "must not run for an exact retry");
  });
  assert.equal(retry.ok, true);
  assert.equal(validationCalls, 1);
});

test("admission locks recover only dead owners and surface cleanup failures", () => {
  const path = journal(); writeFileSync(admissionLockPath(path), JSON.stringify({ pid: 1, createdAt: "2026-01-01T00:00:00.000Z" }));
  const recovered = new EventLog(path, () => "2026-01-01T00:00:01.000Z", new FileAdmissionLockFactory(() => false)).admit({ sessionId: "s", promptId: "p", prompt: "hello", delivery: "queue" }); assert.equal(recovered.ok, true);
  const livePath = journal(); writeFileSync(admissionLockPath(livePath), JSON.stringify({ pid: process.pid, createdAt: "2026-01-01T00:00:00.000Z" })); const live = new EventLog(livePath, () => "2026-01-01T00:00:01.000Z", new FileAdmissionLockFactory(() => true)).admit({ sessionId: "s", promptId: "p", prompt: "hello", delivery: "queue" }); assert.equal(live.ok, false); if (!live.ok) assert.equal(live.error.code, "ADMISSION_BUSY");
  const cleanupFailure: AdmissionLockFactory = { acquire: () => ({ ok: true, value: { release: () => fail("ADMISSION_LOCK_RELEASE_FAILED", "Admission lock cleanup failed") } }) }; const cleanup = new EventLog(journal(), () => "2026-01-01T00:00:01.000Z", cleanupFailure).admit({ sessionId: "s", promptId: "p", prompt: "hello", delivery: "queue" }); assert.equal(cleanup.ok, false); if (!cleanup.ok) assert.equal(cleanup.error.code, "ADMISSION_LOCK_RELEASE_FAILED");
});

test("bearer and multi-token authorization text is redacted without changing ordinary prompts", () => {
  const log = new EventLog(journal()); const secret = "Authorization: Bearer top-secret second-token";
  const admitted = log.admit({ sessionId: "s", promptId: "secret", prompt: secret, delivery: "queue" }); const ordinary = log.admit({ sessionId: "s", promptId: "ordinary", prompt: "Explain bearer tokens", delivery: "queue" });
  assert.equal(admitted.ok, true); assert.equal(ordinary.ok, true); const events = log.read(); assert.equal(events.ok, true);
  if (events.ok) { const prompts = events.value.filter((event) => event.kind === "PromptAdmitted").map((event) => event.data.prompt); assert.equal(prompts.some((prompt) => prompt.includes("top-secret") || prompt.includes("second-token")), false); assert.equal(prompts.includes("Explain bearer tokens"), true); }
});

test("credential-shaped durable IDs are rejected and bearer matching is case-insensitive", () => {
  const log = new EventLog(journal()); const secretSession = log.admit({ sessionId: "authorization: Bearer secret", promptId: "p", prompt: "hello", delivery: "queue" }); const secretPrompt = log.admit({ sessionId: "s", promptId: "bearer secret", prompt: "hello", delivery: "queue" }); const prompt = log.admit({ sessionId: "stable-session", promptId: "stable-prompt", prompt: "bearer TOP-SECRET", delivery: "queue" });
  assert.equal(secretSession.ok, false); assert.equal(secretPrompt.ok, false); if (!secretSession.ok) assert.equal(secretSession.error.code, "ADMISSION_ID_INVALID"); if (!secretPrompt.ok) assert.equal(secretPrompt.error.code, "ADMISSION_ID_INVALID"); assert.equal(prompt.ok, true); const events = log.read(); assert.equal(events.ok, true); if (events.ok) { const admitted = events.value.find((event) => event.kind === "PromptAdmitted"); if (admitted?.kind === "PromptAdmitted") { assert.equal(admitted.sessionId, "stable-session"); assert.equal(admitted.data.promptId, "stable-prompt"); assert.equal(admitted.data.prompt.includes("TOP-SECRET"), false); } }
});

test("shared coordinator serializes steer before queue with durable promotions", async () => {
  const log = new EventLog(journal()); log.admit({ sessionId: "s", promptId: "q", prompt: "queue", delivery: "queue" }); log.admit({ sessionId: "s", promptId: "t", prompt: "steer", delivery: "steer" });
  const first = new Runner(log, new FakeProvider(), tools()); const second = new Runner(log, new FakeProvider(), tools()); const results = await Promise.all([first.run("s"), second.run("s")]);
  assert.equal(results.every((result) => result.ok), true, JSON.stringify(results)); const events = log.read(); assert.equal(events.ok, true); if (events.ok) { assert.deepEqual(events.value.filter((event) => event.kind === "InputPromoted").map((event) => event.data.promptId), ["t", "q"]); assert.deepEqual(projectHistory(events.value, "s").map((message) => message.content), ["steer", "Fake provider response: steer", "queue", "Fake provider response: queue"]); }
});

test("durably records one concise quote intent without routine lifecycle thinking", async () => {
  const log = new EventLog(journal());
  const provider: Provider & { calls: number } = {
    providerId: "quote-test", mode: "fake", calls: 0,
    async *stream(): AsyncIterable<ProviderEvent> {
      this.calls += 1;
      if (this.calls === 1) {
        yield { type: "local_tool_call", callId: "quote-1", name: "paper_quote", arguments: { symbol: "FIN" } };
        yield { type: "finished", finishReason: "tool-calls", usage: { inputTokens: 1, outputTokens: 1 } };
        return;
      }
      yield { type: "text", text: "The FIN quote is ready." };
      yield { type: "finished", finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1 } };
    },
  };
  const admitted = log.admit({ sessionId: "s", promptId: "p", prompt: "quote FIN", delivery: "queue" });
  assert.equal(admitted.ok, true);
  const result = await new Runner(log, provider, tools(), undefined, undefined, undefined, undefined, undefined, async () => ({ decision: "allow-once" })).run("s");
  assert.equal(result.ok, true, JSON.stringify(result));
  const events = log.read();
  assert.equal(events.ok, true, events.ok ? "" : JSON.stringify(events.error));
  if (!events.ok) return;
  const kinds = events.value.map((event) => event.kind);
  const planIndex = kinds.indexOf("GraphPlanPublished");
  const runIndex = kinds.indexOf("GraphRunStarted");
  const transitionIndex = kinds.lastIndexOf("GraphTransition");
  const conclusionIndex = kinds.lastIndexOf("TaskConclusion");
  assert.ok(planIndex >= 0 && planIndex < runIndex);
  const thinking = events.value.filter((event): event is EventOfKind<"HarnessThinking"> => event.kind === "HarnessThinking");
  assert.equal(thinking.length, 1);
  assert.equal(thinking[0]?.data.step, "Read a deterministic paper-market quote");
  assert.equal(thinking[0]?.data.text, "The model selected this action to gather evidence for the response.");
  assert.equal(events.value.some((event) => event.kind === "ToolCalled"), true);
  assert.equal(thinking.every((event) => !["input", "continuation", "tool"].includes(event.data.step) && !/^turn-\d+$/.test(event.data.step)), true);
  assert.ok(transitionIndex >= 0 && transitionIndex < conclusionIndex);
  assert.equal(events.value[conclusionIndex]?.kind, "TaskConclusion");
  if (events.value[conclusionIndex]?.kind === "TaskConclusion") assert.equal(events.value[conclusionIndex].data.outcome, "finished");
});

test("tool intent titles stay concise when a registered description is verbose", async () => {
  const description = `Inspect the complete evidence set before deciding on the next response ${"carefully ".repeat(20)}`;
  const provider: Provider = {
    providerId: "intent-title", mode: "fake",
    async *stream(): AsyncIterable<ProviderEvent> {
      yield { type: "local_tool_call", callId: "inspect-1", name: "inspect", arguments: { value: "ok" } };
      yield { type: "finished", finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1 } };
    },
  };
  const inspect: ToolDefinition<{ value: "ok" }, { ok: true }> = {
    advertisement: { name: "inspect", description, inputSchema: { type: "object" } },
    decode: (input) => typeof input === "object" && input !== null && "value" in input && input.value === "ok" ? { ok: true, value: { value: "ok" } } : fail("TOOL_ARGUMENT_INVALID", "Invalid inspect input"),
    authorize: () => ({ ok: true, value: undefined }),
    execute: () => ({ ok: true, value: { ok: true } }),
    encode: (value) => value,
  };
  const log = new EventLog(journal());
  assert.equal(log.admit({ sessionId: "s", promptId: "p", prompt: "inspect", delivery: "queue" }).ok, true);
  const result = await new Runner(log, provider, new ToolRegistry(new Map([["inspect", inspect]]))).run("s");
  assert.equal(result.ok, true, JSON.stringify(result));
  const events = log.read();
  assert.equal(events.ok, true);
  if (events.ok) {
    const thinking = events.value.find((event): event is EventOfKind<"HarnessThinking"> => event.kind === "HarnessThinking");
    assert.notEqual(thinking, undefined);
    if (thinking === undefined) return;
    assert.equal(thinking.data.step.length <= 80, true);
    assert.equal(thinking.data.step.endsWith("…"), true);
    assert.equal(thinking.data.text, "The model selected this action to gather evidence for the response.");
  }
});

test("provider text events are split without losing chunks or surrogate pairs", async () => {
  const firstText = `${"a".repeat(511)}😀${"b".repeat(700)}`;
  const secondText = ` second event ${"c".repeat(700)}`;
  const text = firstText + secondText;
  assert.equal(splitProviderText(text).join(""), text);
  assert.equal(splitProviderText(text).every((chunk) => chunk.length <= 512), true);
  const provider: Provider = { providerId: "long-text", mode: "fake", async *stream(): AsyncIterable<ProviderEvent> { yield { type: "text", text: firstText }; yield { type: "text", text: secondText }; yield { type: "finished", finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1 } }; } };
  const log = new EventLog(journal());
  assert.equal(log.admit({ sessionId: "s", promptId: "p", prompt: "long", delivery: "queue" }).ok, true);
  const result = await new Runner(log, provider, tools()).run("s");
  assert.equal(result.ok, true, JSON.stringify(result));
  const events = log.read(); assert.equal(events.ok, true);
  if (events.ok) {
    const chunks = events.value.filter((event): event is EventOfKind<"ProviderText"> => event.kind === "ProviderText");
    assert.equal(chunks.map((event) => event.data.text).join(""), text);
    assert.equal(chunks.every((event) => !event.data.truncated), true);
    assert.equal(projectHistory(events.value, "s").filter((message) => message.role === "assistant").map((message) => message.content).join(""), text);
  }
});

class ThrowingProvider implements Provider { readonly providerId = "fake"; readonly mode = "fake" as const; calls = 0; async *stream(_request: ProviderRequest): AsyncIterable<ProviderEvent> { this.calls += 1; throw new Error("token: secret"); } }
class CallbackProvider implements Provider {
  readonly providerId = "fake";
  readonly mode = "fake" as const;
  readonly requests: ProviderRequest[] = [];
  async *stream(request: ProviderRequest): AsyncIterable<ProviderEvent> { this.requests.push(request); yield { type: "text", text: "callback handled" }; yield { type: "finished", finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1 } }; }
}

const appendReadyBatch = (log: EventLog, suffix: string): string => {
  const batchId = `batch-${suffix}`;
  const agentId = `agent-${suffix}`;
  const toolCallId = `spawn-${suffix}`;
  const providerCallId = `turn-${suffix}`;
  log.append("parent", { kind: "BackgroundAgentCreated", data: { agentId, parentSessionId: "parent", parentToolCallId: toolCallId, profile: "read-only-research", childSessionId: `child-${suffix}`, contextMode: "fresh", provider: "fake", model: "fake/finleet", timeoutMs: 1, maxTurns: 1, task: "research", mode: "async", callbackId: `callback-${suffix}`, batchId, parentProviderCallId: providerCallId, parentAssistantMessageId: "run" } });
  log.append("parent", { kind: "ToolCalled", data: { callId: toolCallId, name: "spawn_agent", argumentsDigest: "digest" } });
  log.append("parent", { kind: "ToolSucceeded", data: { callId: toolCallId, preview: "spawned", truncated: false, result: "spawned", resultTruncated: false } });
  log.append("parent", { kind: "BackgroundAgentStatus", data: { agentId, status: "completed", output: "evidence", outputPreview: "evidence", outputTruncated: false } });
  log.append("parent", { kind: "BackgroundAgentCallback", data: { agentId, callbackId: `callback-${suffix}`, parentToolCallId: toolCallId, envelope: { trust: "untrusted-data", status: "completed", output: "evidence", outputTruncated: false } } });
  log.append("parent", { kind: "ProviderTurnFinished", data: { providerCallId, finishReason: "tool-calls", inputTokens: 1, outputTokens: 1 } });
  assert.equal(sealBackgroundAgentBatches(log, "parent", providerCallId).ok, true);
  const materialized = materializeReadyBackgroundAgentBatchCallbacks(log, "parent"); assert.equal(materialized.ok, true); if (!materialized.ok || materialized.value[0] === undefined) throw new Error("batch callback was not materialized");
  return materialized.value[0].data.callbackId;
};

test("active callback delivery sends synthetic tool history once and durably acknowledges it", async () => {
  const log = new EventLog(journal());
  log.append("parent", { kind: "BackgroundAgentCreated", data: { agentId: "agent-callback", parentSessionId: "parent", parentToolCallId: "spawn-callback", profile: "read-only-research", childSessionId: "child-callback", contextMode: "fresh", provider: "fake", model: "fake/finleet", timeoutMs: 1, maxTurns: 1, task: "research", mode: "async", callbackId: "callback-active" } });
  log.append("parent", { kind: "BackgroundAgentStatus", data: { agentId: "agent-callback", status: "completed", output: "done", outputPreview: "done", outputTruncated: false } });
  log.append("parent", { kind: "ToolCalled", data: { callId: "spawn-callback", name: "spawn_agent", argumentsDigest: "digest" } });
  log.append("parent", { kind: "ToolSucceeded", data: { callId: "spawn-callback", preview: "spawned", truncated: false, result: "spawned", resultTruncated: false } });
  log.append("parent", { kind: "BackgroundAgentCallback", data: { agentId: "agent-callback", callbackId: "callback-active", parentToolCallId: "spawn-callback", envelope: { trust: "untrusted-data", status: "completed", output: "done", outputTruncated: false } } });
  const provider = new CallbackProvider(); const runner = new Runner(log, provider, tools(), undefined, undefined, undefined, "Callback instructions", undefined, undefined, undefined, { now: () => new Date("2042-02-03T04:05:06.000Z"), timeZone: "UTC" });
  const first = await runner.runBackgroundCallback("parent", "callback-active"); const second = await runner.runBackgroundCallback("parent", "callback-active");
  assert.equal(first.ok, true); assert.equal(second.ok, true); assert.equal(provider.requests.length, 1);
  assert.equal(provider.requests[0]?.messages.some((message) => message.role === "tool" && message.toolName === "background_agent_callback" && message.toolCallId === "callback-active"), true);
  assert.equal(provider.requests[0]?.system, "Callback instructions\n\nMarket provenance: FIN 101.25 USD as-of 2026-01-01T00:00:00.000Z\n\nRequest-local timestamp: 2042-02-03T04:05:06+00:00 [UTC]. This timestamp was fetched for this request and applies to the latest/final message in the current messages array.");
  const events = log.read(); assert.equal(events.ok, true); if (events.ok) assert.equal(events.value.filter((event) => event.kind === "BackgroundAgentCallbackDelivered").length, 1);
});

test("callback synthesis persists every chunk of a long provider response", async () => {
  const firstText = `${"synthesis ".repeat(80)}😀`;
  const secondText = `${" second synthesis".repeat(80)}`;
  const text = firstText + secondText;
  const log = new EventLog(journal());
  log.append("parent", { kind: "BackgroundAgentCreated", data: { agentId: "agent-long-callback", parentSessionId: "parent", parentToolCallId: "spawn-long-callback", profile: "read-only-research", childSessionId: "child-long-callback", contextMode: "fresh", provider: "fake", model: "fake/finleet", timeoutMs: 1, maxTurns: 1, task: "research", mode: "async", callbackId: "callback-long" } });
  log.append("parent", { kind: "BackgroundAgentStatus", data: { agentId: "agent-long-callback", status: "completed", output: "evidence", outputPreview: "evidence", outputTruncated: false } });
  log.append("parent", { kind: "ToolCalled", data: { callId: "spawn-long-callback", name: "spawn_agent", argumentsDigest: "digest" } });
  log.append("parent", { kind: "ToolSucceeded", data: { callId: "spawn-long-callback", preview: "spawned", truncated: false, result: "spawned", resultTruncated: false } });
  log.append("parent", { kind: "BackgroundAgentCallback", data: { agentId: "agent-long-callback", callbackId: "callback-long", parentToolCallId: "spawn-long-callback", envelope: { trust: "untrusted-data", status: "completed", output: "evidence", outputTruncated: false } } });
  const provider: Provider = { providerId: "long-callback", mode: "fake", async *stream(): AsyncIterable<ProviderEvent> { yield { type: "text", text: firstText }; yield { type: "text", text: secondText }; yield { type: "finished", finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1 } }; } };
  const result = await new Runner(log, provider, tools()).runBackgroundCallback("parent", "callback-long");
  assert.equal(result.ok, true, JSON.stringify(result));
  const events = log.read(); assert.equal(events.ok, true);
  if (events.ok) {
    const chunks = events.value.filter((event): event is EventOfKind<"ProviderText"> => event.kind === "ProviderText" && event.data.providerCallId.startsWith("callback-"));
    assert.equal(chunks.map((event) => event.data.text).join(""), text);
    assert.equal(chunks.every((event) => !event.data.truncated), true);
  }
});

test("active batch delivery fans in all members into exactly one provider synthesis request", async () => {
  const log = new EventLog(journal());
  const batchId = "batch-active";
  for (const [agentId, toolCallId] of [["agent-first", "spawn-first"], ["agent-second", "spawn-second"]] as const) {
    log.append("parent", { kind: "BackgroundAgentCreated", data: { agentId, parentSessionId: "parent", parentToolCallId: toolCallId, profile: "read-only-research", childSessionId: `child-${agentId}`, contextMode: "fresh", provider: "fake", model: "fake/finleet", timeoutMs: 1, maxTurns: 1, task: "research", mode: "async", callbackId: `callback-${agentId}`, batchId, parentProviderCallId: "turn-active", parentAssistantMessageId: "run" } });
    log.append("parent", { kind: "ToolCalled", data: { callId: toolCallId, name: "spawn_agent", argumentsDigest: "digest" } });
    log.append("parent", { kind: "ToolSucceeded", data: { callId: toolCallId, preview: "spawned", truncated: false, result: "spawned", resultTruncated: false } });
    log.append("parent", { kind: "BackgroundAgentStatus", data: { agentId, status: "completed", output: `${agentId} evidence`, outputPreview: `${agentId} evidence`, outputTruncated: false } });
    log.append("parent", { kind: "BackgroundAgentCallback", data: { agentId, callbackId: `callback-${agentId}`, parentToolCallId: toolCallId, envelope: { trust: "untrusted-data", status: "completed", output: `${agentId} evidence`, outputTruncated: false } } });
  }
  log.append("parent", { kind: "ProviderTurnFinished", data: { providerCallId: "turn-active", finishReason: "tool-calls", inputTokens: 1, outputTokens: 1 } });
  assert.equal(sealBackgroundAgentBatches(log, "parent", "turn-active").ok, true);
  const materialized = materializeReadyBackgroundAgentBatchCallbacks(log, "parent"); assert.equal(materialized.ok, true); if (!materialized.ok) return;
  const callbackId = materialized.value[0]?.data.callbackId; assert.notEqual(callbackId, undefined); if (callbackId === undefined) return;
  const provider = new CallbackProvider();
  const [first, second] = await Promise.all([new Runner(log, provider, tools()).runBackgroundCallback("parent", callbackId), new Runner(log, provider, tools()).runBackgroundCallback("parent", callbackId)]);
  assert.equal(first.ok, true); assert.equal(second.ok, true); assert.equal(provider.requests.length, 1);
  const request = provider.requests[0];
  assert.equal(request?.messages.filter((message) => message.toolName === "background_agent_batch_callback").length, 1);
  assert.equal(request?.messages.some((message) => message.content.includes("Synthesize one answer from all members")), true);
  const events = log.read(); assert.equal(events.ok, true); if (events.ok) {
    assert.equal(events.value.filter((event) => event.kind === "BackgroundAgentBatchCallbackDelivered").length, 1);
    assert.equal(events.value.filter((event) => event.kind === "ProviderTurnStarted" && event.data.providerCallId.startsWith("callback-")).length, 1);
  }
  const replay = await new Runner(log, provider, tools()).runBackgroundCallback("parent", callbackId);
  assert.equal(replay.ok, true); assert.equal(provider.requests.length, 1);
});

test("normal provider turns acknowledge included batch callbacks exactly once", async () => {
  const log = new EventLog(journal());
  const batchId = "batch-normal-turn";
  log.append("parent", { kind: "BackgroundAgentCreated", data: { agentId: "agent-normal-turn", parentSessionId: "parent", parentToolCallId: "spawn-normal-turn", profile: "read-only-research", childSessionId: "child-normal-turn", contextMode: "fresh", provider: "fake", model: "fake/finleet", timeoutMs: 1, maxTurns: 1, task: "research", mode: "async", callbackId: "callback-normal-turn", batchId, parentProviderCallId: "turn-normal", parentAssistantMessageId: "run" } });
  log.append("parent", { kind: "ToolCalled", data: { callId: "spawn-normal-turn", name: "spawn_agent", argumentsDigest: "digest" } });
  log.append("parent", { kind: "ToolSucceeded", data: { callId: "spawn-normal-turn", preview: "spawned", truncated: false, result: "spawned", resultTruncated: false } });
  log.append("parent", { kind: "BackgroundAgentStatus", data: { agentId: "agent-normal-turn", status: "completed", output: "evidence", outputPreview: "evidence", outputTruncated: false } });
  log.append("parent", { kind: "BackgroundAgentCallback", data: { agentId: "agent-normal-turn", callbackId: "callback-normal-turn", parentToolCallId: "spawn-normal-turn", envelope: { trust: "untrusted-data", status: "completed", output: "evidence", outputTruncated: false } } });
  log.append("parent", { kind: "ProviderTurnFinished", data: { providerCallId: "turn-normal", finishReason: "tool-calls", inputTokens: 1, outputTokens: 1 } });
  assert.equal(sealBackgroundAgentBatches(log, "parent", "turn-normal").ok, true);
  assert.equal(materializeReadyBackgroundAgentBatchCallbacks(log, "parent").ok, true);
  const provider = new CallbackProvider();
  for (const promptId of ["first", "second"]) {
    assert.equal(log.admit({ sessionId: "parent", promptId, prompt: promptId, delivery: "queue" }).ok, true);
    assert.equal((await new Runner(log, provider, tools()).run("parent")).ok, true);
  }
  assert.equal(provider.requests.every((request) => request.messages.some((message) => message.toolName === "background_agent_batch_callback")), true);
  const events = log.read(); assert.equal(events.ok, true); if (events.ok) assert.equal(events.value.filter((event) => event.kind === "BackgroundAgentBatchCallbackDelivered").length, 1);
});

test("a recorded callback provider failure retries with a fresh durable effect", async () => {
  const log = new EventLog(journal()); const callbackId = appendReadyBatch(log, "retry");
  const provider: Provider & { calls: number } = {
    providerId: "fake", mode: "fake", calls: 0,
    async *stream(): AsyncIterable<ProviderEvent> { this.calls += 1; if (this.calls === 1) throw new Error("first attempt failed"); yield { type: "text", text: "final synthesis" }; yield { type: "finished", finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1 } }; },
  };
  const runner = new Runner(log, provider, tools());
  const first = await runner.runBackgroundCallback("parent", callbackId); assert.equal(first.ok, false);
  let events = log.read(); assert.equal(events.ok, true); if (events.ok) { assert.equal(events.value.filter((event) => event.kind === "EffectRecorded" && event.data.state === "failed").length, 1); assert.equal(events.value.some((event) => event.kind === "BackgroundAgentBatchCallbackDelivered"), false); }
  const second = await runner.runBackgroundCallback("parent", callbackId); assert.equal(second.ok, true); assert.equal(provider.calls, 2);
  events = log.read(); assert.equal(events.ok, true); if (events.ok) { assert.equal(events.value.filter((event) => event.kind === "EffectClaimed" && event.data.effectId.includes("callback-")).length, 2); assert.equal(events.value.filter((event) => event.kind === "BackgroundAgentBatchCallbackDelivered").length, 1); }
});

test("an ambiguous callback provider claim fails closed without duplicate dispatch", async () => {
  const log = new EventLog(journal()); const callbackId = appendReadyBatch(log, "ambiguous");
  const runId = `callback-${digest(`parent:${callbackId}`).slice(0, 16)}`;
  log.append("parent", { kind: "EffectClaimed", data: { effectId: `${runId}:provider:1`, kind: "provider", requestDigest: "request", retryPolicy: "recorded-outcome" } });
  const provider = new CallbackProvider(); const result = await new Runner(log, provider, tools()).runBackgroundCallback("parent", callbackId);
  assert.equal(result.ok, false); if (!result.ok) assert.equal(result.error.code, "BACKGROUND_CALLBACK_RECOVERY_REQUIRED"); assert.equal(provider.requests.length, 0);
  const events = log.read(); assert.equal(events.ok, true); if (events.ok) assert.equal(events.value.some((event) => event.kind === "BackgroundAgentBatchCallbackDelivered"), false);
});

test("a successful callback effect missing only its acknowledgment is reconciled without redispatch", async () => {
  const log = new EventLog(journal()); const callbackId = appendReadyBatch(log, "reconcile");
  const runId = `callback-${digest(`parent:${callbackId}`).slice(0, 16)}`; const effectId = `${runId}:provider:1`; const providerCallId = `${runId}:turn-1`;
  log.append("parent", { kind: "EffectClaimed", data: { effectId, kind: "provider", requestDigest: "request", retryPolicy: "recorded-outcome" } });
  log.append("parent", { kind: "ProviderTurnStarted", data: { provider: "fake", model: "fake/finleet", providerCallId, effectId } });
  log.append("parent", { kind: "ProviderTurnFinished", data: { providerCallId, finishReason: "stop", inputTokens: 1, outputTokens: 1 } });
  log.append("parent", { kind: "EffectRecorded", data: { effectId, state: "succeeded", resultDigest: "result" } });
  const provider = new CallbackProvider(); const result = await new Runner(log, provider, tools()).runBackgroundCallback("parent", callbackId);
  assert.equal(result.ok, true); assert.equal(provider.requests.length, 0);
  const events = log.read(); assert.equal(events.ok, true); if (events.ok) assert.equal(events.value.filter((event) => event.kind === "BackgroundAgentBatchCallbackDelivered").length, 1);
});

test("a failed normal provider turn leaves an included batch available for callback synthesis", async () => {
  const log = new EventLog(journal()); const callbackId = appendReadyBatch(log, "normal-failure");
  assert.equal(log.admit({ sessionId: "parent", promptId: "prompt", prompt: "continue", delivery: "queue" }).ok, true);
  assert.equal((await new Runner(log, new ThrowingProvider(), tools()).run("parent")).ok, false);
  let events = log.read(); assert.equal(events.ok, true); if (events.ok) assert.equal(events.value.some((event) => event.kind === "BackgroundAgentBatchCallbackDelivered"), false);
  const provider = new CallbackProvider(); assert.equal((await new Runner(log, provider, tools()).runBackgroundCallback("parent", callbackId)).ok, true); assert.equal(provider.requests.length, 1);
  events = log.read(); assert.equal(events.ok, true); if (events.ok) assert.equal(events.value.filter((event) => event.kind === "BackgroundAgentBatchCallbackDelivered").length, 1);
});

test("a failed tool continuation leaves an included batch available for callback synthesis", async () => {
  const log = new EventLog(journal()); const callbackId = appendReadyBatch(log, "continuation-failure");
  assert.equal(log.admit({ sessionId: "parent", promptId: "prompt", prompt: "continue", delivery: "queue" }).ok, true);
  const provider: Provider & { calls: number } = {
    providerId: "fake", mode: "fake", calls: 0,
    async *stream(): AsyncIterable<ProviderEvent> {
      this.calls += 1;
      if (this.calls === 1) {
        yield { type: "local_tool_call", callId: "quote", name: "paper_quote", arguments: { symbol: "FIN" } };
        yield { type: "finished", finishReason: "tool-calls", usage: { inputTokens: 1, outputTokens: 1 } };
        return;
      }
      throw new Error("continuation failed");
    },
  };
  assert.equal((await new Runner(log, provider, tools()).run("parent")).ok, false);
  let events = log.read(); assert.equal(events.ok, true); if (events.ok) assert.equal(events.value.some((event) => event.kind === "BackgroundAgentBatchCallbackDelivered"), false);
  const callbackProvider = new CallbackProvider(); assert.equal((await new Runner(log, callbackProvider, tools()).runBackgroundCallback("parent", callbackId)).ok, true); assert.equal(callbackProvider.requests.length, 1);
  events = log.read(); assert.equal(events.ok, true); if (events.ok) assert.equal(events.value.filter((event) => event.kind === "BackgroundAgentBatchCallbackDelivered").length, 1);
});

test("a successful normal synthesis missing only its acknowledgment is reconciled without redispatch", async () => {
  const log = new EventLog(journal()); const callbackId = appendReadyBatch(log, "normal-reconcile");
  const effectId = "run-normal-reconcile:provider:1"; const providerCallId = "run-normal-reconcile:turn-1";
  log.append("parent", { kind: "EffectClaimed", data: { effectId, kind: "provider", requestDigest: "request", retryPolicy: "recorded-outcome" } });
  log.append("parent", { kind: "ProviderTurnStarted", data: { provider: "fake", model: "fake/finleet", providerCallId, effectId } });
  log.append("parent", { kind: "ProviderText", data: { providerCallId, text: "final synthesis", truncated: false } });
  log.append("parent", { kind: "ProviderTurnFinished", data: { providerCallId, finishReason: "stop", inputTokens: 1, outputTokens: 1 } });
  log.append("parent", { kind: "EffectRecorded", data: { effectId, state: "succeeded", resultDigest: "result" } });
  const provider = new CallbackProvider(); const result = await new Runner(log, provider, tools()).runBackgroundCallback("parent", callbackId);
  assert.equal(result.ok, true); assert.equal(provider.requests.length, 0);
  const events = log.read(); assert.equal(events.ok, true); if (events.ok) assert.equal(events.value.filter((event) => event.kind === "BackgroundAgentBatchCallbackDelivered").length, 1);
});
class AbortWaitingProvider implements Provider {
  readonly providerId = "fake";
  readonly mode = "fake" as const;
  readonly started: Promise<void>;
  private markStarted!: () => void;
  constructor() { this.started = new Promise((resolve) => { this.markStarted = resolve; }); }
  async *stream(request: ProviderRequest): AsyncIterable<ProviderEvent> {
    this.markStarted();
    await new Promise<void>((resolve) => {
      if (request.signal?.aborted === true) resolve();
      else request.signal?.addEventListener("abort", () => resolve(), { once: true });
    });
  }
}
test("caller cancellation aborts provider work and durably settles the run", async () => {
  const log = new EventLog(journal()); log.admit({ sessionId: "cancel", promptId: "p", prompt: "wait", delivery: "queue" }); const provider = new AbortWaitingProvider(); const controller = new AbortController(); const running = new Runner(log, provider, tools(), undefined, undefined, undefined, "", process.cwd(), undefined, controller.signal).run("cancel");
  await provider.started; controller.abort(); const result = await running;
  assert.equal(result.ok, false); if (!result.ok) assert.equal(result.error.code, "EXECUTION_ABORTED"); const events = log.read(); assert.equal(events.ok, true); if (events.ok) { assert.equal(events.value.some((event) => event.kind === "ProviderTurnFailed" && event.data.code === "EXECUTION_ABORTED"), true); assert.equal(events.value.some((event) => event.kind === "EffectRecorded" && event.data.state === "failed"), true); assert.equal(hasUnsettledGraphRun(events.value, "cancel"), false); }
});
test("provider exceptions settle failed lifecycle and effect records", async () => {
  const log = new EventLog(journal()); log.admit({ sessionId: "s", promptId: "p", prompt: "status", delivery: "queue" }); const provider = new ThrowingProvider(); const result = await new Runner(log, provider, tools()).run("s");
  assert.equal(result.ok, false); const events = log.read(); assert.equal(events.ok, true); if (events.ok) { assert.equal(events.value.some((event) => event.kind === "ProviderTurnFailed"), true); assert.equal(events.value.some((event) => event.kind === "EffectRecorded" && event.data.state === "failed"), true); }
});

test("session projection reports failures and recovery-required effects", async () => {
  const log = new EventLog(journal()); log.admit({ sessionId: "failed", promptId: "p", prompt: "status", delivery: "queue" }); await new Runner(log, new ThrowingProvider(), tools()).run("failed");
  log.admit({ sessionId: "recovery", promptId: "r", prompt: "recover", delivery: "queue" }); log.append("recovery", { kind: "EffectClaimed", data: { effectId: "unknown", kind: "provider", requestDigest: "request", retryPolicy: "recorded-outcome" } });
  const events = log.read(); assert.equal(events.ok, true); if (events.ok) { const sessions = projectSessions(events.value); assert.equal(sessions.find((session) => session.sessionId === "failed")?.status, "failed"); assert.equal(sessions.find((session) => session.sessionId === "failed")?.latestGraphRunOutcome, "failed"); assert.equal(sessions.find((session) => session.sessionId === "recovery")?.status, "recovery_required"); }
});

test("filesystem lease fails closed under contention and releases after a provider failure", async () => {
  const log = new EventLog(journal()); log.admit({ sessionId: "s", promptId: "p", prompt: "status", delivery: "queue" }); const factory = new FileSessionLeaseFactory(); const held = factory.acquire(log, "s"); assert.equal(held.ok, true);
  const blocked = await new Runner(log, new FakeProvider(), tools()).run("s"); assert.equal(blocked.ok, false); if (!blocked.ok) assert.equal(blocked.error.code, "SESSION_BUSY"); const blockedEvents = log.read(); assert.equal(blockedEvents.ok, true); if (blockedEvents.ok) assert.equal(blockedEvents.value.some((event) => event.kind === "InputPromoted"), false); if (held.ok) held.value.release();
  const failing = await new Runner(log, new ThrowingProvider(), tools()).run("s"); assert.equal(failing.ok, false); assert.equal(existsSync(sessionLeasePath(log.path, "s")), false);
});

test("stale leases with unknown claimed effects require reconciliation", async () => {
  const log = new EventLog(journal()); log.admit({ sessionId: "s", promptId: "p", prompt: "status", delivery: "queue" }); log.append("s", { kind: "EffectClaimed", data: { effectId: "unknown", kind: "provider", requestDigest: "request", retryPolicy: "recorded-outcome" } }); writeFileSync(sessionLeasePath(log.path, "s"), JSON.stringify({ sessionId: "s", pid: 1, createdAt: "2026-01-01T00:00:00.000Z" }));
  const provider = new ThrowingProvider(); const result = await new Runner(log, provider, tools(), new Set(["market:read"]), undefined, new FileSessionLeaseFactory(() => false)).run("s"); assert.equal(result.ok, false); if (!result.ok) assert.equal(result.error.code, "SESSION_RECOVERY_REQUIRED"); assert.equal(provider.calls, 0);
});

test("unrecorded effects block a fresh lease before any promotion", async () => {
  const log = new EventLog(journal()); log.admit({ sessionId: "s", promptId: "p", prompt: "status", delivery: "queue" }); log.append("s", { kind: "EffectClaimed", data: { effectId: "unknown", kind: "provider", requestDigest: "request", retryPolicy: "recorded-outcome" } });
  const provider = new ThrowingProvider(); const result = await new Runner(log, provider, tools()).run("s"); assert.equal(result.ok, false); if (!result.ok) assert.equal(result.error.code, "SESSION_RECOVERY_REQUIRED"); assert.equal(provider.calls, 0);
  const events = log.read(); assert.equal(events.ok, true); if (events.ok) assert.equal(events.value.some((event) => event.kind === "InputPromoted"), false);
});

test("a promoted input without a terminal graph run requires recovery and is not rerun", async () => {
  const log = new EventLog(journal()); const admitted = log.admit({ sessionId: "crashed", promptId: "p", prompt: "status", delivery: "queue" }); assert.equal(admitted.ok, true);
  if (!admitted.ok) return; const plan = defaultPlan(); log.append("crashed", { kind: "GraphRunStarted", data: { runId: "crashed-run", planId: plan.planId, planVersion: plan.version, planDigest: plan.contentDigest, status: "running", inputEventId: admitted.value.id } }); log.append("crashed", { kind: "InputPromoted", data: { promptId: "p", delivery: "queue", reason: "queue-idle" } });
  const provider = new ThrowingProvider(); const result = await new Runner(log, provider, tools()).run("crashed"); assert.equal(result.ok, false); if (!result.ok) assert.equal(result.error.code, "SESSION_RECOVERY_REQUIRED"); assert.equal(provider.calls, 0);
  const events = log.read(); assert.equal(events.ok, true); if (events.ok) assert.equal(projectSessions(events.value).find((session) => session.sessionId === "crashed")?.status, "recovery_required");
});

class MalformedToolProvider implements Provider { readonly providerId = "fake"; readonly mode = "fake" as const; closed = false; async *stream(_request: ProviderRequest): AsyncIterable<ProviderEvent> { try { yield { type: "local_tool_call", callId: "bad", name: "spy", arguments: { symbol: 7 } }; yield { type: "finished", finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1 } }; } finally { this.closed = true; } } }
test("malformed tool input is settled as failed without execution", async () => {
  let executed = false; const spy: ToolDefinition<{ symbol: string }, { ok: boolean }> = { advertisement: { name: "spy", description: "test", inputSchema: {} }, decode: () => fail("TOOL_ARGUMENT_INVALID", "bad input"), authorize: () => ({ ok: true, value: undefined }), execute: () => { executed = true; return { ok: true, value: { ok: true } }; }, encode: (value) => value };
  const log = new EventLog(journal()); log.admit({ sessionId: "s", promptId: "p", prompt: "tool", delivery: "queue" }); const provider = new MalformedToolProvider(); const result = await new Runner(log, provider, new ToolRegistry(new Map([["spy", spy]]))).run("s"); assert.equal(result.ok, false, JSON.stringify(result)); assert.equal(executed, false); assert.equal(provider.closed, true); const events = log.read(); assert.equal(events.ok, true); if (events.ok) assert.equal(events.value.some((event) => event.kind === "ToolFailed" && event.data.code === "TOOL_ARGUMENT_INVALID"), true);
});

class PermissionToolProvider implements Provider {
  readonly providerId = "fake";
  readonly mode = "fake" as const;
  async *stream(_request: ProviderRequest): AsyncIterable<ProviderEvent> {
    yield { type: "local_tool_call", callId: "permission-call", name: "protected", arguments: { value: "ok" } };
    yield { type: "finished", finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1 } };
  }
}

test("permission approver runs after preparation and reject durably prevents execution", async () => {
  let executions = 0;
  let approvals = 0;
  const protectedTool: ToolDefinition<{ value: string }, { ok: boolean }> = {
    advertisement: { name: "protected", description: "permission test", requiredPermission: "shell:read", inputSchema: { type: "object" } },
    decode: (input) => typeof input === "object" && input !== null && "value" in input && input.value === "ok" ? { ok: true, value: { value: "ok" } } : fail("TOOL_ARGUMENT_INVALID", "invalid"),
    authorize: () => ({ ok: true, value: undefined }),
    execute: () => { executions += 1; return { ok: true, value: { ok: true } }; },
    encode: (value) => value,
  };
  const log = new EventLog(journal());
  const admitted = log.admit({ sessionId: "permission", promptId: "p", prompt: "inspect", delivery: "queue" });
  assert.equal(admitted.ok, true);
  const result = await new Runner(log, new PermissionToolProvider(), new ToolRegistry(new Map([["protected", protectedTool]])), undefined, undefined, undefined, "", process.cwd(), async (request) => {
    approvals += 1;
    assert.equal(request.requiredPermission, "shell:read");
    assert.equal(request.admissionId, admitted.ok ? admitted.value.id : "");
    assert.equal(request.scope, "tool:protected");
    assert.equal(typeof request.arguments === "object" && request.arguments !== null && !Array.isArray(request.arguments) ? request.arguments.value : undefined, "ok");
    return { decision: "reject", feedback: "not now" };
  }).run("permission");
  assert.equal(result.ok, false);
  assert.equal(approvals, 1);
  assert.equal(executions, 0);
  const events = log.read();
  assert.equal(events.ok, true);
  if (events.ok) {
    assert.equal(events.value.some((event) => event.kind === "ToolFailed" && event.data.code === "TOOL_PERMISSION_REJECTED"), true);
    assert.equal(events.value.some((event) => event.kind === "ToolSucceeded"), false);
  }
});

test("write permissions are distinct and are not default runner grants", () => {
  const writePermissions: Permission[] = ["market:write", "web:write", "shell:write"];
  const defaultPermissions = new Set<Permission>(["market:read", "web:read", "shell:read"]);
  assert.deepEqual(writePermissions, ["market:write", "web:write", "shell:write"]);
  for (const permission of writePermissions) assert.equal(defaultPermissions.has(permission), false);
});

test("non-interactive tool requirements do not prompt when an approver exists", async () => {
  let executions = 0;
  let approvals = 0;
  const workspaceTool: ToolDefinition<{ value: string }, { ok: boolean }> = {
    advertisement: { name: "protected", description: "workspace permission test", requiredPermission: "shell:read", inputSchema: { type: "object" } },
    decode: () => ({ ok: true, value: { value: "ok" } }),
    authorize: () => ({ ok: true, value: undefined }),
    permissionRequirement: () => ({ ok: true, value: { requiredPermission: "shell:read", scope: "workspace:test" } }),
    execute: () => { executions += 1; return { ok: true, value: { ok: true } }; },
    encode: (value) => value,
  };
  const log = new EventLog(journal());
  log.admit({ sessionId: "workspace-permission", promptId: "p", prompt: "inspect", delivery: "queue" });
  const result = await new Runner(log, new PermissionToolProvider(), new ToolRegistry(new Map([["protected", workspaceTool]])), undefined, undefined, undefined, "", process.cwd(), async () => {
    approvals += 1;
    return { decision: "reject" };
  }).run("workspace-permission");
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(approvals, 0);
  assert.equal(executions, 1);
});

class DuplicateToolProvider implements Provider { readonly providerId = "fake"; readonly mode = "fake" as const; async *stream(_request: ProviderRequest): AsyncIterable<ProviderEvent> { yield { type: "local_tool_call", callId: "same", name: "spy", arguments: { symbol: "FIN" } }; yield { type: "local_tool_call", callId: "same", name: "spy", arguments: { symbol: "FIN" } }; yield { type: "finished", finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1 } }; } }
test("duplicate local tool call identity uses the recorded outcome without a second invocation", async () => {
  let executions = 0; const spy: ToolDefinition<{ symbol: string }, { ok: boolean }> = { advertisement: { name: "spy", description: "test", inputSchema: {} }, decode: () => ({ ok: true, value: { symbol: "FIN" } }), authorize: () => ({ ok: true, value: undefined }), execute: () => { executions += 1; return { ok: true, value: { ok: true } }; }, encode: (value) => value };
  const log = new EventLog(journal()); log.admit({ sessionId: "s", promptId: "p", prompt: "tool", delivery: "queue" }); const result = await new Runner(log, new DuplicateToolProvider(), new ToolRegistry(new Map([["spy", spy]]))).run("s");
  assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(executions, 1); const events = log.read(); assert.equal(events.ok, true); if (events.ok) assert.equal(events.value.filter((event) => event.kind === "EffectClaimed" && event.data.effectId.startsWith("tool:")).length, 1);
});

class ConflictingToolProvider implements Provider { readonly providerId = "fake"; readonly mode = "fake" as const; async *stream(_request: ProviderRequest): AsyncIterable<ProviderEvent> { yield { type: "local_tool_call", callId: "same", name: "spy", arguments: { symbol: "FIN" } }; yield { type: "local_tool_call", callId: "same", name: "spy", arguments: { symbol: "OTHER" } }; yield { type: "finished", finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1 } }; } }
test("conflicting local tool arguments fail closed for a reused effect identity", async () => {
  const spy: ToolDefinition<{ symbol: string }, { ok: boolean }> = { advertisement: { name: "spy", description: "test", inputSchema: {} }, decode: () => ({ ok: true, value: { symbol: "FIN" } }), authorize: () => ({ ok: true, value: undefined }), execute: () => ({ ok: true, value: { ok: true } }), encode: (value) => value };
  const log = new EventLog(journal()); log.admit({ sessionId: "s", promptId: "p", prompt: "tool", delivery: "queue" }); const result = await new Runner(log, new ConflictingToolProvider(), new ToolRegistry(new Map([["spy", spy]]))).run("s");
  assert.equal(result.ok, false); if (!result.ok) assert.equal(result.error.code, "TOOL_EFFECT_CONFLICT");
});

class ThrowingToolProvider implements Provider { readonly providerId = "fake"; readonly mode = "fake" as const; async *stream(_request: ProviderRequest): AsyncIterable<ProviderEvent> { yield { type: "local_tool_call", callId: "throws", name: "spy", arguments: { symbol: "FIN" } }; yield { type: "finished", finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1 } }; } }
test("throwing local tools are durably settled as failures", async () => {
  const spy: ToolDefinition<{ symbol: string }, { ok: boolean }> = { advertisement: { name: "spy", description: "test", inputSchema: {} }, decode: () => ({ ok: true, value: { symbol: "FIN" } }), authorize: () => ({ ok: true, value: undefined }), execute: () => { throw new Error("secret failure"); }, encode: (value) => value };
  const log = new EventLog(journal()); log.admit({ sessionId: "s", promptId: "p", prompt: "tool", delivery: "queue" }); const result = await new Runner(log, new ThrowingToolProvider(), new ToolRegistry(new Map([["spy", spy]]))).run("s");
  assert.equal(result.ok, false); const events = log.read(); assert.equal(events.ok, true); if (events.ok) { assert.equal(events.value.some((event) => event.kind === "ToolFailed" && event.data.code === "TOOL_EXCEPTION"), true); assert.equal(events.value.some((event) => event.kind === "EffectRecorded" && event.data.effectId.startsWith("tool:")), true); }
 });

class FailedCommandJustificationProvider implements Provider {
  readonly providerId = "fake";
  readonly mode = "fake" as const;
  readonly requests: ProviderRequest[] = [];
  async *stream(request: ProviderRequest): AsyncIterable<ProviderEvent> {
    this.requests.push(request);
    if (this.requests.length === 1) {
      yield { type: "local_tool_call", callId: "command-1", name: "command", arguments: { command: "exit 7" } };
      yield { type: "finished", finishReason: "tool-calls", usage: { inputTokens: 1, outputTokens: 1 } };
      return;
    }
    yield { type: "text", text: "The command failed and needs user attention." };
    yield { type: "finished", finishReason: "stop", usage: { inputTokens: 2, outputTokens: 2 } };
  }
}

test("failed local commands are projected into the justification turn", async () => {
  const command: ToolDefinition<{ command: string }, { output: string }> = {
    advertisement: { name: "command", description: "test command", inputSchema: { type: "object" } },
    decode: () => ({ ok: true, value: { command: "exit 7" } }),
    authorize: () => ({ ok: true, value: undefined }),
    execute: () => fail("TOOL_COMMAND_FAILED", "Command exited with status 7; stderr: safe diagnostic"),
    encode: (value) => value,
  };
  const log = new EventLog(journal()); log.admit({ sessionId: "s", promptId: "p", prompt: "run command", delivery: "queue" });
  const provider = new FailedCommandJustificationProvider();
  const plan = { ...draft(), limits: { ...draft().limits, timeoutMs: 1_000, continuationPolicy: {} } };
  const result = await new Runner(log, provider, new ToolRegistry(new Map([["command", command]])), undefined, undefined, undefined, "", process.cwd(), undefined, undefined, { plan }).run("s");
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(provider.requests.length, 2);
  const toolMessage = provider.requests[1]?.messages.find((message) => message.role === "tool");
  assert.equal(toolMessage?.toolCallId, "command-1");
  assert.match(toolMessage?.content ?? "", /TOOL_COMMAND_FAILED/);
  assert.match(toolMessage?.content ?? "", /safe diagnostic/);
});

test("failed local tools feed their durable error back after a stop response", async () => {
  class StopAfterFailedToolProvider implements Provider {
    readonly providerId = "fake";
    readonly mode = "fake" as const;
    readonly requests: ProviderRequest[] = [];
    async *stream(request: ProviderRequest): AsyncIterable<ProviderEvent> {
      this.requests.push(request);
      if (this.requests.length === 1) {
        yield { type: "local_tool_call", callId: "blocked-1", name: "blocked", arguments: {} };
        yield { type: "finished", finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1 } };
        return;
      }
      yield { type: "text", text: "I could not use that tool because permission was rejected." };
      yield { type: "finished", finishReason: "stop", usage: { inputTokens: 2, outputTokens: 2 } };
    }
  }
  const blocked: ToolDefinition<Record<string, never>, { ok: boolean }> = {
    advertisement: { name: "blocked", description: "test blocked tool", inputSchema: { type: "object" } },
    decode: () => ({ ok: true, value: {} }),
    authorize: () => fail("TOOL_PERMISSION_REJECTED", "Permission request rejected; feedback: user denied this action"),
    execute: () => ({ ok: true, value: { ok: true } }),
    encode: (value) => value,
  };
  const log = new EventLog(journal());
  log.admit({ sessionId: "s", promptId: "p", prompt: "run blocked tool", delivery: "queue" });
  const provider = new StopAfterFailedToolProvider();
  const result = await new Runner(log, provider, new ToolRegistry(new Map([["blocked", blocked]]))).run("s");
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(provider.requests.length, 2);
  const toolMessage = provider.requests[1]?.messages.find((message) => message.role === "tool");
  assert.equal(toolMessage?.toolCallId, "blocked-1");
  assert.match(toolMessage?.content ?? "", /TOOL_PERMISSION_REJECTED/);
  assert.match(toolMessage?.content ?? "", /user denied this action/);
  const events = log.read();
  assert.equal(events.ok, true, JSON.stringify(events));
  if (events.ok) assert.equal(events.value.some((event) => event.kind === "TaskConclusion" && event.data.outcome === "finished"), true);
});

test("orphan deferred failures do not suppress feedback for a later local failure", async () => {
  class MixedFailureProvider implements Provider {
    readonly providerId = "fake";
    readonly mode = "fake" as const;
    readonly requests: ProviderRequest[] = [];
    async *stream(request: ProviderRequest): AsyncIterable<ProviderEvent> {
      this.requests.push(request);
      if (this.requests.length === 1) {
        yield { type: "provider_tool_call", callId: "provider-owned-1", name: "remote", arguments: {}, execution: "provider" };
        yield { type: "local_tool_call", callId: "allowed-1", name: "allowed", arguments: {} };
        yield { type: "finished", finishReason: "tool-calls", usage: { inputTokens: 1, outputTokens: 1 } };
        return;
      }
      if (this.requests.length === 2) {
        yield { type: "local_tool_call", callId: "blocked-1", name: "blocked", arguments: {} };
        yield { type: "finished", finishReason: "stop", usage: { inputTokens: 2, outputTokens: 1 } };
        return;
      }
      yield { type: "text", text: "The local tool was unavailable, so I used the available evidence." };
      yield { type: "finished", finishReason: "stop", usage: { inputTokens: 3, outputTokens: 2 } };
    }
  }
  const allowed: ToolDefinition<Record<string, never>, { ok: boolean }> = {
    advertisement: { name: "allowed", description: "test allowed tool", inputSchema: { type: "object" } },
    decode: () => ({ ok: true, value: {} }),
    authorize: () => ({ ok: true, value: undefined }),
    execute: () => ({ ok: true, value: { ok: true } }),
    encode: (value) => value,
  };
  const blocked: ToolDefinition<Record<string, never>, { ok: boolean }> = {
    advertisement: { name: "blocked", description: "test blocked tool", inputSchema: { type: "object" } },
    decode: () => ({ ok: true, value: {} }),
    authorize: () => fail("TOOL_PERMISSION_REJECTED", "Permission request rejected; feedback: user denied this action"),
    execute: () => ({ ok: true, value: { ok: true } }),
    encode: (value) => value,
  };
  const log = new EventLog(journal());
  log.admit({ sessionId: "s", promptId: "p", prompt: "run mixed tools", delivery: "queue" });
  const provider = new MixedFailureProvider();
  const result = await new Runner(log, provider, new ToolRegistry(new Map([["allowed", allowed], ["blocked", blocked]]))).run("s");
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(provider.requests.length, 3);
  const feedback = provider.requests[2]?.messages.find((message) => message.role === "tool" && message.toolCallId === "blocked-1");
  assert.match(feedback?.content ?? "", /TOOL_PERMISSION_REJECTED/);
  assert.match(feedback?.content ?? "", /user denied this action/);
});

test("a repeated failed local tool call stops after its error feedback turn", async () => {
  class RepeatedFailedToolProvider implements Provider {
    readonly providerId = "fake";
    readonly mode = "fake" as const;
    readonly requests: ProviderRequest[] = [];
    async *stream(request: ProviderRequest): AsyncIterable<ProviderEvent> {
      this.requests.push(request);
      yield { type: "local_tool_call", callId: "blocked-1", name: "blocked", arguments: {} };
      yield { type: "finished", finishReason: "tool-calls", usage: { inputTokens: this.requests.length, outputTokens: 1 } };
    }
  }
  const blocked: ToolDefinition<Record<string, never>, { ok: boolean }> = {
    advertisement: { name: "blocked", description: "test blocked tool", inputSchema: { type: "object" } },
    decode: () => ({ ok: true, value: {} }),
    authorize: () => fail("TOOL_PERMISSION_REJECTED", "Permission request rejected"),
    execute: () => ({ ok: true, value: { ok: true } }),
    encode: (value) => value,
  };
  const log = new EventLog(journal());
  log.admit({ sessionId: "s", promptId: "p", prompt: "run blocked tool", delivery: "queue" });
  const provider = new RepeatedFailedToolProvider();
  const result = await new Runner(log, provider, new ToolRegistry(new Map([["blocked", blocked]]))).run("s");
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "TOOL_PERMISSION_REJECTED");
  assert.equal(provider.requests.length, 2);
  const toolMessage = provider.requests[1]?.messages.find((message) => message.role === "tool");
  assert.match(toolMessage?.content ?? "", /TOOL_PERMISSION_REJECTED/);
  const events = log.read();
  assert.equal(events.ok, true, JSON.stringify(events));
  if (events.ok) {
    assert.equal(events.value.filter((event) => event.kind === "ToolFailed" && event.data.callId === "blocked-1").length, 1);
    assert.equal(events.value.filter((event) => event.kind === "ProviderTurnFinished").length, 1);
  }
});

test("deferred tool failures are not projected as orphan tool results", () => {
  const log = new EventLog(journal());
  log.admit({ sessionId: "s", promptId: "p", prompt: "tool", delivery: "queue" });
  log.append("s", { kind: "ToolCalled", data: { callId: "deferred-1", name: "command", argumentsDigest: "digest", arguments: "{}" } });
  log.append("s", { kind: "ToolSucceeded", data: { callId: "deferred-1", preview: "ok", truncated: false, result: "ok", resultTruncated: false } });
  log.append("s", { kind: "ToolFailed", data: { callId: "deferred-1", code: "PROVIDER_TOOL_DEFERRED", message: "Provider-owned tool was not locally dispatched" } });
  const events = log.read(); assert.equal(events.ok, true, JSON.stringify(events));
  if (events.ok) assert.equal(projectHistory(events.value, "s").filter((message) => message.role === "tool").length, 1);
});

class DeferredToolProvider implements Provider { readonly providerId = "deferred"; readonly mode = "deferred" as const; async *stream(_request: ProviderRequest): AsyncIterable<ProviderEvent> { yield { type: "local_tool_call", callId: "deferred-call", name: "spy", arguments: { symbol: "FIN" } }; yield { type: "finished", finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1 } }; } }
test("non-fake providers record local tool dispatch as deferred without registry execution", async () => {
  let executions = 0; const spy: ToolDefinition<{ symbol: string }, { ok: boolean }> = { advertisement: { name: "spy", description: "test", inputSchema: {} }, decode: () => ({ ok: true, value: { symbol: "FIN" } }), authorize: () => ({ ok: true, value: undefined }), execute: () => { executions += 1; return { ok: true, value: { ok: true } }; }, encode: (value) => value };
  const log = new EventLog(journal()); log.admit({ sessionId: "s", promptId: "p", prompt: "tool", delivery: "queue" }); const result = await new Runner(log, new DeferredToolProvider(), new ToolRegistry(new Map([["spy", spy]]))).run("s"); assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(executions, 0); const events = log.read(); assert.equal(events.ok, true); if (events.ok) assert.equal(events.value.some((event) => event.kind === "ToolFailed" && event.data.code === "LOCAL_TOOL_DISPATCH_DEFERRED"), true);
});

class LocalFetchContinuationProvider implements Provider {
  readonly providerId = "responses-test";
  readonly mode = "deferred" as const;
  readonly requests: ProviderRequest[] = [];
  async *stream(request: ProviderRequest): AsyncIterable<ProviderEvent> {
    this.requests.push(request);
    if (this.requests.length === 1) {
      yield { type: "provider_tool_call", callId: "fetch-1", name: "fetch_page", arguments: { url: "https://example.test/page" }, execution: "local" };
      yield { type: "finished", finishReason: "tool-calls", usage: { inputTokens: 1, outputTokens: 1 } };
      return;
    }
    yield { type: "text", text: "Fetched page summary" };
    yield { type: "finished", finishReason: "stop", usage: { inputTokens: 2, outputTokens: 2 } };
  }
}

test("local provider fetch calls settle durably and continue once with the original call ID", async () => {
  const fetchPage: ToolDefinition<{ url: string }, { body: string; token: string }> = {
    advertisement: { name: "fetch_page", description: "Fetch a page", inputSchema: { type: "object" } },
    decode: (input) => typeof input === "object" && input !== null && "url" in input && typeof input.url === "string" ? { ok: true, value: { url: input.url } } : fail("TOOL_ARGUMENT_INVALID", "Invalid fetch request"),
    authorize: () => ({ ok: true, value: undefined }), execute: () => ({ ok: true, value: { body: "x".repeat(600), token: "private-token" } }), encode: (value) => value,
  };
  const log = new EventLog(journal()); const provider = new LocalFetchContinuationProvider();
  log.admit({ sessionId: "s", promptId: "p", prompt: "fetch", delivery: "queue" });
  const result = await new Runner(log, provider, new ToolRegistry(new Map([["fetch_page", fetchPage]]))).run("s");
  assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(provider.requests.length, 2);
  assert.deepEqual(provider.requests[1]?.messages.filter((message) => message.role === "tool").map((message) => [message.toolCallId, message.content.includes("private-token")]), [["fetch-1", false]]);
  assert.equal(replay(log, "s").ok, true); assert.equal(provider.requests.length, 2);
  const events = log.read(); assert.equal(events.ok, true); if (events.ok) { const success = events.value.find((event) => event.kind === "ToolSucceeded"); assert.equal(success?.kind, "ToolSucceeded"); if (success?.kind === "ToolSucceeded") { assert.equal(success.data.result?.includes("private-token"), false); assert.equal((success.data.result?.length ?? 0) > 0, true); } assert.equal(events.value.filter((event) => event.kind === "EffectClaimed" && event.data.effectId.includes(":provider:")).length, 2); }
});

test("provider timestamps are fresh per continuation, ordered after stable context, and excluded from replay state", async () => {
  const provider: Provider & { requests: ProviderRequest[] } = {
    providerId: "timestamp-test", mode: "fake", requests: [],
    async *stream(request: ProviderRequest): AsyncIterable<ProviderEvent> {
      this.requests.push(request);
      if (this.requests.length === 1) {
        yield { type: "local_tool_call", callId: "quote", name: "paper_quote", arguments: { symbol: "FIN" } };
        yield { type: "finished", finishReason: "tool-calls", usage: { inputTokens: 1, outputTokens: 1 } };
        return;
      }
      yield { type: "text", text: "Fresh timestamp answer" };
      yield { type: "finished", finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1 } };
    },
  };
  const timestamps = [new Date("2041-01-02T03:04:05.000Z"), new Date("2041-01-02T03:04:06.000Z")];
  const log = new EventLog(journal());
  assert.equal(log.admit({ sessionId: "timestamp", promptId: "p", prompt: "quote", delivery: "queue" }).ok, true);
  const runner = new Runner(log, provider, tools(), undefined, undefined, undefined, "Stable instructions", undefined, undefined, undefined, { now: () => {
    const timestamp = timestamps.shift();
    if (timestamp === undefined) throw new Error("Clock called too many times");
    return timestamp;
  }, timeZone: "UTC" });
  const result = await runner.run("timestamp");
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(provider.requests.length, 2);
  const prefix = "Stable instructions\n\nMarket provenance: FIN 101.25 USD as-of 2026-01-01T00:00:00.000Z\n\nRequest-local timestamp: ";
  assert.equal(provider.requests[0]?.system.startsWith(prefix), true);
  assert.match(provider.requests[0]?.system ?? "", /2041-01-02T03:04:05\+00:00 \[UTC\]/);
  assert.match(provider.requests[1]?.system ?? "", /2041-01-02T03:04:06\+00:00 \[UTC\]/);
  assert.equal(provider.requests.every((request) => request.system.includes("applies to the latest/final message in the current messages array")), true);
  const events = log.read();
  assert.equal(events.ok, true);
  if (events.ok) {
    assert.equal(JSON.stringify(events.value).includes("2041-01-02T03:04"), false);
    assert.equal(JSON.stringify(projectHistory(events.value, "timestamp")).includes("2041-01-02T03:04"), false);
  }
  const replayed = replay(log, "timestamp");
  assert.equal(replayed.ok, true);
  assert.equal(provider.requests.length, 2);
});

test("Runner keeps ordinary results at 512 and preserves an opted-in durable result with a 256-character preview", async () => {
  const provider: Provider & { calls: number } = {
    providerId: "durable-result-test", mode: "fake", calls: 0,
    async *stream(): AsyncIterable<ProviderEvent> {
      this.calls += 1;
      if (this.calls === 1) {
        yield { type: "local_tool_call", callId: "result-call", name: "result_tool", arguments: {} };
        yield { type: "finished", finishReason: "tool-calls", usage: { inputTokens: 1, outputTokens: 1 } };
        return;
      }
      yield { type: "text", text: "done" };
      yield { type: "finished", finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1 } };
    },
  };
  const runFor = async (durableResultLimit: number | undefined): Promise<EventOfKind<"ToolSucceeded">> => {
    const tool: ToolDefinition<Record<string, never>, { payload: string }> = {
      advertisement: { name: "result_tool", description: "Return test output", inputSchema: {} },
      ...(durableResultLimit === undefined ? {} : { durableResultLimit }),
      decode: (input) => typeof input === "object" && input !== null && Object.keys(input).length === 0 ? { ok: true, value: {} } : fail("TOOL_ARGUMENT_INVALID", "Expected empty input"),
      authorize: () => ({ ok: true, value: undefined }),
      execute: () => ({ ok: true, value: { payload: "x".repeat(32_768), api_key: "hidden-secret" } }),
      encode: (value) => value,
    };
    const log = new EventLog(journal());
    assert.equal(log.admit({ sessionId: "s", promptId: "p", prompt: "result", delivery: "queue" }).ok, true);
    provider.calls = 0;
    const run = await new Runner(log, provider, new ToolRegistry(new Map([["result_tool", tool]]))).run("s");
    assert.equal(run.ok, true, JSON.stringify(run));
    const events = log.read();
    assert.equal(events.ok, true);
    if (!events.ok) throw new Error("Expected journal events");
    const success = events.value.find((event): event is EventOfKind<"ToolSucceeded"> => event.kind === "ToolSucceeded");
    if (success === undefined) throw new Error("Expected ToolSucceeded");
    return success;
  };
  const ordinary = await runFor(undefined);
  assert.equal(ordinary.data.result?.length, MAX_EVENT_TEXT);
  assert.equal(ordinary.data.resultTruncated, true);
  assert.ok((ordinary.data.preview.length) <= MAX_EVENT_PREVIEW);
  const optedIn = await runFor(MAX_TOOL_RESULT);
  assert.ok((optedIn.data.result?.length ?? 0) > 16_384);
  assert.equal(optedIn.data.resultTruncated, false);
  assert.ok(optedIn.data.preview.length <= MAX_EVENT_PREVIEW);
  assert.equal(JSON.parse(optedIn.data.result ?? "{}").api_key, "[REDACTED]");
});

class ThreeTurnFetchProvider implements Provider {
  readonly providerId = "responses-test";
  readonly mode = "deferred" as const;
  readonly requests: ProviderRequest[] = [];
  async *stream(request: ProviderRequest): AsyncIterable<ProviderEvent> {
    this.requests.push(request);
    if (this.requests.length < 3) {
      yield { type: "provider_tool_call", callId: `fetch-${this.requests.length}`, name: "fetch_page", arguments: { url: "https://example.test/page" }, execution: "local" };
      yield { type: "finished", finishReason: "tool-calls", usage: { inputTokens: 1, outputTokens: 1 } };
      return;
    }
    yield { type: "text", text: "Latest price: $123.45" };
    yield { type: "finished", finishReason: "stop", usage: { inputTokens: 3, outputTokens: 2 } };
  }
}

test("local tools may use two bounded continuations before the final answer", async () => {
  let executions = 0;
  const fetchPage: ToolDefinition<{ url: string }, { body: string }> = {
    advertisement: { name: "fetch_page", description: "Fetch a page", inputSchema: { type: "object" } },
    durableResultLimit: MAX_TOOL_RESULT,
    decode: (input) => typeof input === "object" && input !== null && "url" in input && typeof input.url === "string" ? { ok: true, value: { url: input.url } } : fail("TOOL_ARGUMENT_INVALID", "Invalid fetch request"),
    authorize: () => ({ ok: true, value: undefined }),
    execute: () => { executions += 1; return { ok: true, value: { body: `chart-start:${"x".repeat(32_768)}:chart-end` } }; },
    encode: (value) => value,
  };
  const log = new EventLog(journal());
  const provider = new ThreeTurnFetchProvider();
  log.admit({ sessionId: "s", promptId: "three-turns", prompt: "fetch", delivery: "queue" });
  const result = await new Runner(log, provider, new ToolRegistry(new Map([["fetch_page", fetchPage]]))).run("s");
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(provider.requests.length, 3);
  assert.equal(executions, 2);
  assert.match(JSON.stringify(provider.requests[2]?.messages), /chart-end/);
  if (result.ok) assert.match(JSON.stringify(result.value.history), /Latest price/);
});

test("fake local tool calls continue through a durable handoff after the window is exhausted", async () => {
  let executions = 0;
  const provider: Provider & { calls: number } = {
    providerId: "fake", mode: "fake", calls: 0,
    async *stream(): AsyncIterable<ProviderEvent> {
      this.calls += 1;
      if (this.calls <= 8) {
        yield { type: "local_tool_call", callId: `tool-${this.calls}`, name: "spy", arguments: { value: "ok" } };
        yield { type: "finished", finishReason: "tool-calls", usage: { inputTokens: 1, outputTokens: 1 } };
        return;
      }
      yield { type: "text", text: "Final answer after fake handoff" };
      yield { type: "finished", finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1 } };
    },
  };
  const spy: ToolDefinition<{ value: string }, { ok: true }> = {
    advertisement: { name: "spy", description: "Spy", inputSchema: { type: "object" } },
    decode: (input) => typeof input === "object" && input !== null && "value" in input && (input as { value?: unknown }).value === "ok" ? { ok: true, value: { value: "ok" } } : fail("TOOL_ARGUMENT_INVALID", "Invalid spy input"),
    authorize: () => ({ ok: true, value: undefined }),
    permissionRequirement: () => ({ ok: true, value: { requiredPermission: "shell:read", scope: "continuation-spy", interactiveRequired: true } }),
    execute: () => { executions += 1; return { ok: true, value: { ok: true } }; },
    encode: (value) => value,
  };
  const log = new EventLog(journal());
  const admitted = log.admit({ sessionId: "s", promptId: "p", prompt: "work", delivery: "queue" });
  assert.equal(admitted.ok, true);
  const approvals: string[] = [];
  const result = await new Runner(log, provider, new ToolRegistry(new Map([["spy", spy]])), undefined, undefined, undefined, "", process.cwd(), async (request) => {
    approvals.push(request.admissionId);
    return { decision: "allow-once" };
  }).run("s");
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(provider.calls, 9);
  assert.equal(executions, 8);
  assert.deepEqual(approvals, Array.from({ length: 8 }, () => admitted.ok ? admitted.value.id : ""));
  const events = log.read();
  assert.equal(events.ok, true);
  if (events.ok) {
    assert.equal(events.value.filter((event) => event.kind === "ContinuationWindowOpened").length, 1);
    assert.equal(events.value.filter((event) => event.kind === "TaskConclusion" && event.data.outcome === "finished").length, 1);
  }
});

test("durable continuation runs beyond 32 turns with stable lineage and no retry", async () => {
  const requests: ProviderRequest[] = [];
  const provider: Provider = {
    providerId: "responses-test",
    mode: "deferred",
    async *stream(request: ProviderRequest): AsyncIterable<ProviderEvent> {
       requests.push(request);
       if (requests.length <= 32) {
         yield { type: "provider_tool_call", callId: `loop-${requests.length}`, name: "fetch_page", arguments: { url: "https://example.test/page" }, execution: "local" };
         yield { type: "finished", finishReason: "tool-calls", usage: { inputTokens: 1, outputTokens: 1 } };
       } else {
         yield { type: "text", text: "Long-running job complete" };
         yield { type: "finished", finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1 } };
       }
    },
  };
  const fetchPage: ToolDefinition<{ url: string }, { body: string }> = {
    advertisement: { name: "fetch_page", description: "Fetch a page", inputSchema: { type: "object" } },
    decode: (input) => typeof input === "object" && input !== null && "url" in input && typeof input.url === "string" ? { ok: true, value: { url: input.url } } : fail("TOOL_ARGUMENT_INVALID", "Invalid fetch request"),
    authorize: () => ({ ok: true, value: undefined }), execute: () => ({ ok: true, value: { body: "page" } }), encode: (value) => value,
  };
  const log = new EventLog(journal());
  log.admit({ sessionId: "s", promptId: "limit", prompt: "fetch", delivery: "queue" });
   const result = await new Runner(log, provider, new ToolRegistry(new Map([["fetch_page", fetchPage]]))).run("s");
   assert.equal(result.ok, true, JSON.stringify(result));
  const events = log.read();
  assert.equal(events.ok, true, events.ok ? "" : JSON.stringify(events.error));
  if (events.ok) {
     const handoffs = events.value.filter((event): event is EventOfKind<"ContinuationWindowOpened"> => event.kind === "ContinuationWindowOpened");
     assert.equal(handoffs.length, 4);
     const rootRunId = handoffs[0]?.data.parentRunId.split(":continuation-", 1)[0];
     assert.equal(rootRunId !== undefined, true);
     if (rootRunId !== undefined) assert.deepEqual(handoffs.map((event) => event.data.continuationRunId), [1, 2, 3, 4].map((index) => `${rootRunId}:continuation-${index}`));
    const claims = events.value.filter((event): event is EventOfKind<"EffectClaimed"> => event.kind === "EffectClaimed" && event.data.kind === "provider");
    const records = events.value.filter((event): event is EventOfKind<"EffectRecorded"> => event.kind === "EffectRecorded" && event.data.effectId.startsWith("run-"));
     assert.equal(claims.length, 33);
     assert.equal(records.length, 33);
     assert.equal(events.value.some((event) => event.kind === "TaskConclusion" && event.data.outcome === "finished"), true);
  }
  const retry = await new Runner(log, provider, new ToolRegistry(new Map([["fetch_page", fetchPage]]))).run("s");
   assert.equal(retry.ok, false);
   if (!retry.ok) assert.equal(retry.error.code, "INBOX_EMPTY");
   assert.equal(requests.length, 33);
});

class DelayedLocalToolProvider implements Provider {
  readonly providerId = "responses-test";
  readonly mode = "deferred" as const;
  readonly requests: ProviderRequest[] = [];
  async *stream(request: ProviderRequest): AsyncIterable<ProviderEvent> {
    this.requests.push(request);
    if (this.requests.length === 1) {
      yield { type: "provider_tool_call", callId: "delayed-fetch", name: "fetch_page", arguments: { url: "https://example.test/page" }, execution: "local" };
      yield { type: "finished", finishReason: "tool-calls", usage: { inputTokens: 1, outputTokens: 1 } };
      return;
    }
    yield { type: "text", text: "Delayed fetch completed" };
    yield { type: "finished", finishReason: "stop", usage: { inputTokens: 2, outputTokens: 2 } };
  }
}

test("a local tool completing after the old five-second budget still reaches continuation", async () => {
  const fetchPage: ToolDefinition<{ url: string }, { body: string }> = {
    advertisement: { name: "fetch_page", description: "Fetch a page", inputSchema: { type: "object" } },
    decode: (input) => typeof input === "object" && input !== null && "url" in input && typeof input.url === "string" ? { ok: true, value: { url: input.url } } : fail("TOOL_ARGUMENT_INVALID", "Invalid fetch request"),
    authorize: () => ({ ok: true, value: undefined }),
    execute: () => { const started = Date.now(); while (Date.now() - started < 5_100) { /* emulate a slow browser fetch */ } return { ok: true, value: { body: "page" } }; },
    encode: (value) => value,
  };
  const log = new EventLog(journal()); const provider = new DelayedLocalToolProvider();
  log.admit({ sessionId: "s", promptId: "slow-fetch", prompt: "fetch", delivery: "queue" });
  const result = await new Runner(log, provider, new ToolRegistry(new Map([["fetch_page", fetchPage]]))).run("s");
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(provider.requests.length, 2);
});

test("finance context is permission scoped and bounded", () => {
  const denied = financeContext(new FixturePaperExchange(), new Set<Permission>(), 100); const market = financeContext(new FixturePaperExchange(), new Set<Permission>(["market:read"]), 24);
  assert.equal(denied.ok, false); assert.equal(market.ok, true); if (market.ok) { assert.equal(market.value.text.includes("Account:"), false); assert.equal(market.value.text.length, 24); }
});

test("plan digest is internal and full same-version material cannot mutate", () => {
  const log = new EventLog(journal()); const first = publishPlan(log, "s", draft()); const changed = publishPlan(log, "s", draft([{ nodeId: "different", kind: "finish", config: {} }])); assert.equal(first.ok, true); assert.equal(changed.ok, false); if (first.ok) assert.notEqual(first.value.contentDigest, digest(JSON.stringify("not caller supplied"))); const events = log.read(); assert.equal(events.ok, true); if (events.ok) { const plan = events.value.find((event) => event.kind === "GraphPlanPublished"); if (plan?.kind === "GraphPlanPublished") assert.equal(plan.data.plan.nodes[0]?.nodeId, "finish"); }
});

test("plan publication rejects fractional turn limits before journaling", () => {
  const log = new EventLog(journal());
  const result = publishPlan(log, "s", { ...draft(), limits: { ...draft().limits, maxTurns: 2.5 } });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "PLAN_LIMIT_INVALID");
  const events = log.read();
  assert.equal(events.ok, true);
  if (events.ok) assert.equal(events.value.some((event) => event.kind === "GraphPlanPublished"), false);
});

test("structured credential key variants are redacted and provider payload is bounded", () => {
  const log = new EventLog(journal()); const secretDraft = draft([{ nodeId: "finish", kind: "finish", config: { apiKey: "secret-one", nested: { accessToken: "secret-two", client_secret: "secret-three", clientSecret: "secret-four", "api-key": "secret-five" } } }]); publishPlan(log, "s", secretDraft); log.append("s", { kind: "ProviderText", data: { providerCallId: "c", text: "x".repeat(512), truncated: false } }); const events = log.read(); assert.equal(events.ok, true); if (events.ok) { const plan = events.value.find((event) => event.kind === "GraphPlanPublished"); if (plan?.kind === "GraphPlanPublished") assert.deepEqual(plan.data.plan.nodes[0]?.config, { apiKey: "[REDACTED]", nested: { accessToken: "[REDACTED]", client_secret: "[REDACTED]", clientSecret: "[REDACTED]", "api-key": "[REDACTED]" } }); assert.equal(events.value.find((event) => event.kind === "ProviderText")?.kind, "ProviderText"); }
});

test("quoted JSON credential values are redacted", () => {
  const value = JSON.stringify({ apiKey: "quoted-secret", nested: { access_token: "another-secret" } });
  const redacted = JSON.stringify(redactJson(value));
  assert.equal(redacted.includes("quoted-secret"), false);
  assert.equal(redacted.includes("another-secret"), false);
  const escaped = JSON.stringify({ apiKey: "secret with \\\" quote" });
  assert.equal(JSON.stringify(redactJson(escaped)).includes("secret with"), false);
});

test("shell credential assignments and PEM blocks are redacted everywhere", () => {
  const value = "AWS_ACCESS_KEY_ID=access AWS_SECRET_ACCESS_KEY:secret PRIVATE_KEY=private SECRET_KEY=secret -----BEGIN RSA PRIVATE KEY-----\nmaterial\n-----END RSA PRIVATE KEY-----";
  const redacted = JSON.stringify(redactJson(value));
  assert.equal(redacted.includes("access"), false);
  assert.equal(redacted.includes("secret"), false);
  assert.equal(redacted.includes("private"), false);
  assert.equal(redacted.includes("material"), false);
  assert.match(redacted, /REDACTED/);
});

test("credential assignment redaction is idempotent for both separators", () => {
  for (const value of ["API_KEY=secret", "API_KEY: secret", "openAiApiKey=secret", "openAiApiKey: secret", "'API_KEY'='secret'", "'API_KEY':'secret'"]) {
    const once = redactJson(value);
    const twice = redactJson(once);
    assert.equal(twice, once);
    assert.equal(String(twice).includes("secret"), false);
  }
});

test("durable tool results remain parseable after repeated credential redaction", () => {
  for (const value of [
    JSON.stringify({ API_KEY: "secret-equals" }),
    JSON.stringify({ API_KEY: "secret-colon" }).replace(":", ": "),
  ]) {
    const log = new EventLog(journal());
    const alreadyRedacted = redactJson(value);
    assert.equal(typeof alreadyRedacted, "string");
    log.append("redaction", { kind: "ToolSucceeded", data: { callId: "call", preview: "ok", truncated: false, result: String(alreadyRedacted) } });
    const events = log.read();
    assert.equal(events.ok, true, JSON.stringify(events));
    if (events.ok) {
      const event = events.value.find((candidate) => candidate.kind === "ToolSucceeded");
      assert.equal(event?.kind, "ToolSucceeded");
      if (event?.kind === "ToolSucceeded") {
        assert.doesNotThrow(() => JSON.parse(event.data.result ?? ""));
        assert.equal(event.data.result?.includes("secret-"), false);
      }
    }
  }
});

test("permission review steps are redacted before approvers receive them", async () => {
  const log = new EventLog(journal());
  const tool: ToolDefinition<{ value: string }, { ok: true }> = {
    advertisement: { name: "protected", description: "test", inputSchema: { type: "object" }, requiredPermission: "shell:read" },
    decode: () => ({ ok: true, value: { value: "safe" } }),
    authorize: () => ({ ok: true, value: undefined }),
    permissionRequirement: () => ({ ok: true, value: { requiredPermission: "shell:write", scope: "tool:protected", interactiveRequired: true, reviewSteps: ["apiKey=REVIEW_SECRET", "-----BEGIN RSA PRIVATE KEY-----\\nreview-material\\n-----END RSA PRIVATE KEY-----"] } }),
    execute: () => ({ ok: true, value: { ok: true } }),
    encode: (value) => value,
  };
  const requests: PermissionRequest[] = [];
  const provider = new PermissionToolProvider();
  log.admit({ sessionId: "review", promptId: "review-prompt", prompt: "review", delivery: "queue" });
  const result = await new Runner(log, provider, new ToolRegistry(new Map([["protected", tool]])), undefined, undefined, undefined, "", process.cwd(), async (request) => { requests.push(request); return { decision: "reject" }; }).run("review");
  assert.equal(result.ok, false);
  assert.equal(requests.length, 1);
  const reviewText = requests[0]?.reviewSteps.join(" ") ?? "";
  assert.doesNotMatch(reviewText, /REVIEW_SECRET|review-material|BEGIN RSA/);
});

test("durable event session IDs cannot retain terminal controls", () => {
  const log = new EventLog(journal());
  const event = log.append("session\u001b]2;owned\u0007", { kind: "ProviderText", data: { providerCallId: "call", text: "safe", truncated: false } });
  assert.equal(event.sessionId, "session");
  const events = log.read();
  assert.equal(events.ok, true);
  if (events.ok) assert.equal(events.value[0]?.sessionId, "session");
});

test("recorded-outcome replay does not call a provider", async () => {
  const log = new EventLog(journal()); log.admit({ sessionId: "s", promptId: "p", prompt: "status", delivery: "queue" }); const provider = new ThrowingProvider(); await new Runner(log, provider, tools()).run("s"); const calls = provider.calls; const result = replay(log, "s"); assert.equal(result.ok, true); assert.equal(provider.calls, calls);
});

test("CLI supports delivery/session/prompt ID and recorded replay", async () => {
  const path = journal(); const run = await execute(["agent", "run", "--provider", "fake", "--exchange", "paper", "--prompt", "hello", "--delivery", "steer", "--session", "cli-s", "--prompt-id", "cli-p", "--journal", path, "--format", "json"]); const replayed = await execute(["replay", "--journal", path, "--session", "cli-s", "--format", "json"]);
  assert.equal(run.exitCode, 0, JSON.stringify(run.body)); assert.equal(replayed.exitCode, 0, JSON.stringify(replayed.body));
});

test("CLI sessions list sorts, limits, and exposes queue and steer metadata", async () => {
  const path = journal(); const log = new EventLog(path);
  log.admit({ sessionId: "older", promptId: "o", prompt: "older title", delivery: "queue" }); log.admit({ sessionId: "newer", promptId: "nq", prompt: "newer title", delivery: "queue" }); log.admit({ sessionId: "newer", promptId: "ns", prompt: "steer title", delivery: "steer" });
  const response = await execute(["sessions", "list", "--journal", path, "--limit", "1", "--format", "json"]);
  assert.equal(response.exitCode, 0, JSON.stringify(response.body)); const body = response.body as { sessions: { sessionId: string; pendingQueueCount: number; pendingSteerCount: number; titlePreview: string }[]; limit: number };
  assert.equal(body.limit, 1); assert.deepEqual(body.sessions.map((session) => session.sessionId), ["newer"]); assert.equal(body.sessions[0]?.pendingQueueCount, 1); assert.equal(body.sessions[0]?.pendingSteerCount, 1);
  const invalid = await execute(["sessions", "list", "--journal", path, "--limit", "0", "--format", "json"]); assert.equal(invalid.exitCode, 2);
});

test("session show is recorded-outcome read-only", async () => {
  const path = journal(); const log = new EventLog(path); log.admit({ sessionId: "shown", promptId: "p", prompt: "hello", delivery: "queue" }); const provider = new ThrowingProvider(); await new Runner(log, provider, tools()).run("shown"); const calls = provider.calls;
  const shown = await execute(["session", "show", "shown", "--journal", path, "--format", "json"]); assert.equal(shown.exitCode, 0, JSON.stringify(shown.body)); assert.equal(provider.calls, calls);
});

test("exec creates a session and resume appends durable history including --last", async () => {
  const path = journal(); const first = await execute(["exec", "first", "--provider", "fake", "--exchange", "paper", "--journal", path, "--session", "exec-s", "--format", "json"]); assert.equal(first.exitCode, 0, JSON.stringify(first.body));
  const resumed = await execute(["exec", "resume", "exec-s", "second", "--provider", "fake", "--exchange", "paper", "--journal", path, "--format", "json"]); assert.equal(resumed.exitCode, 0, JSON.stringify(resumed.body));
  const newest = new EventLog(path, () => "2099-01-01T00:00:00.000Z"); newest.admit({ sessionId: "last-s", promptId: "seed", prompt: "seed", delivery: "queue" }); newest.append("last-s", { kind: "InputPromoted", data: { promptId: "seed", delivery: "queue", reason: "queue-idle" } });
  const last = await execute(["resume", "--last", "third", "--provider", "fake", "--exchange", "paper", "--journal", path, "--format", "json"]); assert.equal(last.exitCode, 0, JSON.stringify(last.body));
  const lastBody = last.body as { sessionId: string }; assert.equal(lastBody.sessionId, "last-s"); const events = new EventLog(path).read(); assert.equal(events.ok, true); if (events.ok) { assert.deepEqual(projectHistory(events.value, "exec-s").filter((message) => message.role === "user").map((message) => message.content), ["first", "second"]); assert.deepEqual(projectHistory(events.value, "last-s").filter((message) => message.role === "user").map((message) => message.content), ["seed", "third"]); }
});

test("resume rejects unknown sessions and stdin prompts are bounded", async () => {
  const path = journal(); const unknown = await execute(["resume", "missing", "hello", "--provider", "fake", "--exchange", "paper", "--journal", path, "--format", "json"]); assert.equal(unknown.exitCode, 2); assert.match(JSON.stringify(unknown.body), /SESSION_UNKNOWN/);
  const stdin = (async function* (): AsyncIterable<string> { yield "from stdin"; })(); const accepted = await execute(["exec", "-", "--provider", "fake", "--exchange", "paper", "--journal", path, "--format", "json"], { stdin }); assert.equal(accepted.exitCode, 0, JSON.stringify(accepted.body));
  const oversized = (async function* (): AsyncIterable<string> { yield "x".repeat(513); })(); const rejected = await execute(["exec", "-", "--provider", "fake", "--exchange", "paper", "--journal", path, "--format", "json"], { stdin: oversized }); assert.equal(rejected.exitCode, 2); assert.match(JSON.stringify(rejected.body), /PROMPT_TOO_LARGE/);
});

test("exact exec, resume, and compatibility retries return recorded completion", async () => {
  const path = journal(); const base = ["--provider", "fake", "--exchange", "paper", "--journal", path, "--session", "s", "--format", "json"];
  const execArgs = ["exec", "first", ...base, "--prompt-id", "exec-p"]; const execFirst = await execute(execArgs); const execRetry = await execute(execArgs);
  const resumeArgs = ["resume", "s", "second", ...base, "--prompt-id", "resume-p"]; const resumeFirst = await execute(resumeArgs); const resumeRetry = await execute(resumeArgs);
  const aliasArgs = ["agent", "run", "--provider", "fake", "--exchange", "paper", "--prompt", "third", "--delivery", "queue", "--session", "s", "--prompt-id", "alias-p", "--journal", path, "--format", "json"]; const aliasFirst = await execute(aliasArgs); const aliasRetry = await execute(aliasArgs);
  for (const response of [execFirst, execRetry, resumeFirst, resumeRetry, aliasFirst, aliasRetry]) assert.equal(response.exitCode, 0, JSON.stringify(response.body));
  for (const response of [execRetry, resumeRetry, aliasRetry]) assert.equal((response.body as { alreadyComplete?: boolean }).alreadyComplete, true);
  const events = new EventLog(path).read(); assert.equal(events.ok, true); if (events.ok) assert.equal(events.value.filter((event) => event.kind === "InputPromoted").length, 3);
});

test("recorded retry remains fail-closed for recovery and returns typed failure for a settled failed run", async () => {
  const path = journal(); const log = new EventLog(path); const admitted = log.admit({ sessionId: "s", promptId: "failed-prompt", prompt: "failed", delivery: "queue" }); assert.equal(admitted.ok, true); if (!admitted.ok) return; const plan = defaultPlan(); log.append("s", { kind: "GraphRunStarted", data: { runId: "failed-run", planId: plan.planId, planVersion: plan.version, planDigest: plan.contentDigest, status: "running", inputEventId: admitted.value.id } }); log.append("s", { kind: "InputPromoted", data: { promptId: "failed-prompt", delivery: "queue", reason: "queue-idle" } }); log.append("s", { kind: "GraphTransition", data: { runId: "failed-run", planId: plan.planId, planVersion: plan.version, nodeId: "turn", sequence: 1, outcome: "failed", inputDigest: "failure" } });
  const failed = await execute(["exec", "failed", "--provider", "fake", "--exchange", "paper", "--journal", path, "--session", "s", "--prompt-id", "failed-prompt", "--format", "json"]); assert.equal(failed.exitCode, 2); const failedBody = failed.body as { alreadyComplete?: boolean; recordedOutcome?: string; error?: { code: string } }; assert.equal(failedBody.alreadyComplete, true); assert.equal(failedBody.recordedOutcome, "failed"); assert.equal(failedBody.error?.code, "RECORDED_RUN_FAILED");
  log.append("s", { kind: "EffectClaimed", data: { effectId: "unknown", kind: "provider", requestDigest: "request", retryPolicy: "recorded-outcome" } }); const recovery = await execute(["exec", "failed", "--provider", "fake", "--exchange", "paper", "--journal", path, "--session", "s", "--prompt-id", "failed-prompt", "--format", "json"]); assert.equal(recovery.exitCode, 2); assert.match(JSON.stringify(recovery.body), /SESSION_RECOVERY_REQUIRED/);
});

test("CLI normalizes stdin and filesystem exceptions into typed JSON failures", async () => {
  const brokenInput = (async function* (): AsyncIterable<string> { throw new Error("stdin failed"); })(); const stdinFailure = await execute(["exec", "-", "--provider", "fake", "--exchange", "paper", "--journal", journal(), "--format", "json"], { stdin: brokenInput });
  assert.equal(stdinFailure.exitCode, 2); assert.deepEqual(stdinFailure.body, { error: { code: "CLI_IO_FAILED", message: "A filesystem or input operation failed" } });
  const directoryJournal = mkdtempSync(join(tmpdir(), "finleet-directory-journal-")); const filesystemFailure = await execute(["exec", "hello", "--provider", "fake", "--exchange", "paper", "--journal", directoryJournal, "--format", "json"]);
  assert.equal(filesystemFailure.exitCode, 2); assert.deepEqual(filesystemFailure.body, { error: { code: "CLI_IO_FAILED", message: "A filesystem or input operation failed" } }); assert.equal(existsSync(admissionLockPath(directoryJournal)), false);
});

test("CLI catalog and connector inspection commands remain offline and deferred", async () => {
  const cache = join(mkdtempSync(join(tmpdir(), "finleet-cli-")), "catalog.json"); writeFileSync(cache, JSON.stringify({ models: [{ provider: "fake", model: "finleet", displayName: "Fake" }] }));
  const sync = await execute(["models", "sync", "--cache", cache, "--format", "json"]); const agents = await execute(["agents", "list", "--cache", cache, "--format", "json"]); const connectors = await execute(["connectors", "list", "--agent", "paper-primary", "--format", "json"]);
  assert.equal(sync.exitCode, 0, JSON.stringify(sync.body)); assert.equal(agents.exitCode, 0, JSON.stringify(agents.body)); assert.equal(connectors.exitCode, 0, JSON.stringify(connectors.body));
});

class EightToolTurnsThenTextProvider implements Provider {
  readonly providerId = "responses-test";
  readonly mode = "deferred" as const;
  calls = 0;
  async *stream(_request: ProviderRequest): AsyncIterable<ProviderEvent> {
    this.calls += 1;
    if (this.calls <= 8) { yield { type: "provider_tool_call", callId: `window-tool-${this.calls}`, name: "fetch_page", arguments: { url: "https://example.test/page" }, execution: "local" }; yield { type: "finished", finishReason: "tool-calls", usage: { inputTokens: 1, outputTokens: 1 } }; return; }
    yield { type: "text", text: "Final answer after handoff" };
    yield { type: "finished", finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1 } };
  }
}

test("eight recorded local tool turns open one durable window and finish through its child run", async () => {
  let executions = 0;
  const fetchPage: ToolDefinition<{ url: string }, { body: string }> = { advertisement: { name: "fetch_page", description: "Fetch", inputSchema: { type: "object" } }, decode: (input) => typeof input === "object" && input !== null && "url" in input && typeof input.url === "string" ? { ok: true, value: { url: input.url } } : fail("TOOL_ARGUMENT_INVALID", "Invalid fetch"), authorize: () => ({ ok: true, value: undefined }), execute: () => { executions += 1; return { ok: true, value: { body: "page" } }; }, encode: (value) => value };
  const log = new EventLog(journal()); const admitted = log.admit({ sessionId: "s", promptId: "p", prompt: "fetch", delivery: "queue" }); assert.equal(admitted.ok, true);
  const provider = new EightToolTurnsThenTextProvider(); const result = await new Runner(log, provider, new ToolRegistry(new Map([["fetch_page", fetchPage]]))).run("s");
  assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(provider.calls, 9); assert.equal(executions, 8);
  const events = log.read(); assert.equal(events.ok, true); if (events.ok && admitted.ok && result.ok) { const handoff = events.value.find((event) => event.kind === "ContinuationWindowOpened"); assert.equal(handoff?.kind, "ContinuationWindowOpened"); if (handoff?.kind === "ContinuationWindowOpened") { assert.equal(handoff.data.turnsUsedBeforeHandoff, 8); assert.equal(handoff.data.originalInputEventId, admitted.value.id); assert.equal(handoff.data.continuationRunId, result.value.runId); } assert.equal(events.value.filter((event) => event.kind === "InputPromoted").length, 1); const recorded = recordedRunForAdmission(log, "s", admitted.value.id); assert.equal(recorded.ok, true); if (recorded.ok) assert.equal(recorded.value?.runId, result.value.runId); }
});

test("a later session publishes its plan locally before resuming past a durable window", async () => {
  let executions = 0;
  const fetchPage: ToolDefinition<{ url: string }, { body: string }> = { advertisement: { name: "fetch_page", description: "Fetch", inputSchema: { type: "object" } }, decode: (input) => typeof input === "object" && input !== null && "url" in input && typeof input.url === "string" ? { ok: true, value: { url: input.url } } : fail("TOOL_ARGUMENT_INVALID", "Invalid fetch"), authorize: () => ({ ok: true, value: undefined }), execute: () => { executions += 1; return { ok: true, value: { body: "page" } }; }, encode: (value) => value };
  const log = new EventLog(journal());
  assert.equal(publishPlan(log, "earlier-session", defaultPlan()).ok, true);
  const admitted = log.admit({ sessionId: "later-session", promptId: "p", prompt: "fetch", delivery: "queue" });
  assert.equal(admitted.ok, true);
  const provider = new EightToolTurnsThenTextProvider();
  const result = await new Runner(log, provider, new ToolRegistry(new Map([["fetch_page", fetchPage]]))).run("later-session");
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(provider.calls, 9);
  assert.equal(executions, 8);
  const events = log.read();
  assert.equal(events.ok, true);
  if (events.ok) {
    assert.equal(events.value.filter((event) => event.kind === "GraphPlanPublished" && event.sessionId === "later-session").length, 1);
    assert.equal(events.value.filter((event) => event.kind === "ContinuationWindowOpened" && event.sessionId === "later-session").length, 1);
    assert.equal(events.value.filter((event) => event.kind === "TaskConclusion" && event.sessionId === "later-session" && event.data.outcome === "finished").length, 1);
  }
});

test("a fully recorded pending handoff resumes its untouched child without another input promotion", async () => {
  const log = new EventLog(journal()); const admitted = log.admit({ sessionId: "s", promptId: "p", prompt: "fetch", delivery: "queue" }); assert.equal(admitted.ok, true); if (!admitted.ok) return;
  const plan = defaultPlan(); const parentRunId = "parent"; const childRunId = "parent:continuation-1"; const providerEffectId = "parent:provider:8"; const toolEffectId = "tool:stable";
  log.append("s", { kind: "GraphPlanPublished", data: { plan } }); log.append("s", { kind: "GraphRunStarted", data: { runId: parentRunId, planId: plan.planId, planVersion: plan.version, planDigest: plan.contentDigest, status: "running", inputEventId: admitted.value.id } }); log.append("s", { kind: "InputPromoted", data: { promptId: "p", delivery: "queue", reason: "queue-idle" } });
   for (const effectId of [providerEffectId, toolEffectId]) { log.append("s", { kind: "EffectClaimed", data: { effectId, kind: effectId === providerEffectId ? "provider" : "tool", requestDigest: "request", retryPolicy: "recorded-outcome" } }); log.append("s", { kind: "EffectRecorded", data: { effectId, state: "succeeded", resultDigest: "result" } }); }
  log.append("s", { kind: "ProviderTurnStarted", data: { provider: "responses-test", model: "test", providerCallId: "parent:turn-8", effectId: providerEffectId } });
  log.append("s", { kind: "ContinuationWindowOpened", data: { parentRunId, continuationRunId: childRunId, originalInputEventId: admitted.value.id, planId: plan.planId, planVersion: plan.version, planDigest: plan.contentDigest, windowIndex: 1, turnsUsedBeforeHandoff: 8, providerEffectId, providerCallId: "parent:turn-8", triggerToolEffectId: toolEffectId, reason: "provider-tool-continuation" } });
  const beforeResume = log.read(); assert.equal(beforeResume.ok, true); if (beforeResume.ok) assert.equal(projectSessions(beforeResume.value).find((session) => session.sessionId === "s")?.status, "running");
  const provider: Provider = { providerId: "responses-test", mode: "deferred", async *stream(): AsyncIterable<ProviderEvent> { yield { type: "text", text: "Recovered continuation" }; yield { type: "finished", finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1 } }; } };
  const result = await new Runner(log, provider, tools()).run("s"); assert.equal(result.ok, true, JSON.stringify(result)); const events = log.read(); assert.equal(events.ok, true); if (events.ok) assert.equal(events.value.filter((event) => event.kind === "InputPromoted").length, 1);
});

test("an unrecorded handoff effect remains recovery-required and is never rerun", async () => {
  const log = new EventLog(journal()); const admitted = log.admit({ sessionId: "s", promptId: "p", prompt: "fetch", delivery: "queue" }); assert.equal(admitted.ok, true); if (!admitted.ok) return;
  const plan = defaultPlan(); const parentRunId = "parent"; const childRunId = "parent:continuation-1"; const providerEffectId = "parent:provider:8"; const toolEffectId = "tool:stable";
  log.append("s", { kind: "GraphPlanPublished", data: { plan } }); log.append("s", { kind: "GraphRunStarted", data: { runId: parentRunId, planId: plan.planId, planVersion: plan.version, planDigest: plan.contentDigest, status: "running", inputEventId: admitted.value.id } }); log.append("s", { kind: "InputPromoted", data: { promptId: "p", delivery: "queue", reason: "queue-idle" } });
   log.append("s", { kind: "EffectClaimed", data: { effectId: toolEffectId, kind: "tool", requestDigest: "request", retryPolicy: "recorded-outcome" } }); log.append("s", { kind: "EffectRecorded", data: { effectId: toolEffectId, state: "succeeded", resultDigest: "result" } }); log.append("s", { kind: "EffectClaimed", data: { effectId: providerEffectId, kind: "provider", requestDigest: "request", retryPolicy: "recorded-outcome" } });
  log.append("s", { kind: "ProviderTurnStarted", data: { provider: "responses-test", model: "test", providerCallId: "parent:turn-8", effectId: providerEffectId } });
  log.append("s", { kind: "ContinuationWindowOpened", data: { parentRunId, continuationRunId: childRunId, originalInputEventId: admitted.value.id, planId: plan.planId, planVersion: plan.version, planDigest: plan.contentDigest, windowIndex: 1, turnsUsedBeforeHandoff: 8, providerEffectId, providerCallId: "parent:turn-8", triggerToolEffectId: toolEffectId, reason: "provider-tool-continuation" } });
  const provider = new ThrowingProvider(); const result = await new Runner(log, provider, tools()).run("s"); assert.equal(result.ok, false); if (!result.ok) assert.equal(result.error.code, "SESSION_RECOVERY_REQUIRED"); assert.equal(provider.calls, 0);
});

test("continuation window events are schema validated", () => {
  const path = journal(); writeFileSync(path, `${JSON.stringify({ schemaVersion: 1, id: "bad", sessionId: "s", kind: "ContinuationWindowOpened", at: "now", data: { parentRunId: "p" } })}\n`);
  assert.equal(new EventLog(path).read().ok, false);
});

test("provider terminal error settles the provider effect as failed", async () => {
  const log = new EventLog(journal()); const admitted = log.admit({ sessionId: "s", promptId: "p", prompt: "hello", delivery: "queue" }); assert.equal(admitted.ok, true);
  const provider: Provider = { providerId: "responses-test", mode: "deferred", async *stream(): AsyncIterable<ProviderEvent> { yield { type: "finished", finishReason: "error", usage: { inputTokens: 1, outputTokens: 0 } }; } };
  const result = await new Runner(log, provider, tools()).run("s"); assert.equal(result.ok, false); if (!result.ok) assert.equal(result.error.code, "PROVIDER_TERMINAL_ERROR");
  const events = log.read(); assert.equal(events.ok, true); if (events.ok) { const claims = events.value.filter((event) => event.kind === "EffectClaimed"); const records = events.value.filter((event) => event.kind === "EffectRecorded"); assert.equal(claims.length, 1); assert.equal(records.length, 1); assert.equal(records[0]?.data.state, "failed"); }
});

test("provider completion without visible text or a local tool fails instead of reporting success", async () => {
  for (const text of [undefined, "\n  \t"] as const) {
    const log = new EventLog(journal());
    log.admit({ sessionId: "s", promptId: "p", prompt: "hello", delivery: "queue" });
    const provider: Provider = {
      providerId: "responses-test",
      mode: "deferred",
      async *stream(): AsyncIterable<ProviderEvent> {
        if (text !== undefined) yield { type: "text", text };
        yield { type: "finished", finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1 } };
      },
    };
    const result = await new Runner(log, provider, tools()).run("s");
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, "PROVIDER_EMPTY_RESPONSE");
    const events = log.read();
    assert.equal(events.ok, true);
    if (events.ok) {
      assert.equal(events.value.some((event) => event.kind === "ProviderTurnFinished"), false);
      assert.equal(events.value.some((event) => event.kind === "ProviderTurnFailed" && event.data.code === "PROVIDER_EMPTY_RESPONSE"), true);
      assert.equal(events.value.some((event) => event.kind === "TaskConclusion" && event.data.outcome === "finished"), false);
    }
  }
});

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { backgroundAgentTools, BackgroundAgentScheduler, BACKGROUND_AGENT_PROFILE, type BackgroundAgentHostDriver } from "./background.js";
import { EventLog, MAX_EVENT_TEXT, materializeReadyBackgroundAgentBatchCallbacks, projectHistory, projectLiveBackgroundAgents, sealBackgroundAgentBatches, type NewEvent, type Permission } from "./domain.js";
import { ToolRegistry, type PermissionApprover, type Provider, type ProviderEvent, type ProviderRequest } from "./runtime.js";

const journal = (): string => join(mkdtempSync(join(tmpdir(), "finleet-background-")), "journal.jsonl");
const parent = (toolCallId = "spawn-1") => ({ sessionId: "parent", agentId: "paper-agent", assistantMessageId: "run", providerCallId: "turn", toolCallId, permissions: new Set<Permission>(["market:read"]) });
const tick = async (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

class DelayedProvider implements Provider {
  readonly providerId = "fake";
  readonly modelId = "fake/finleet";
  readonly mode = "fake" as const;
  started = 0;
  readonly systems: string[] = [];
  release!: () => void;
  readonly unblock = new Promise<void>((resolve) => { this.release = resolve; });
  async *stream(request: ProviderRequest): AsyncIterable<ProviderEvent> {
    this.started += 1;
    this.systems.push(request.system);
    await Promise.race([this.unblock, new Promise<void>((resolve) => request.signal?.addEventListener("abort", () => resolve(), { once: true }))]);
    if (request.signal?.aborted !== true) yield { type: "text", text: "result token=hidden" };
    yield { type: "finished", finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1 } };
  }
}

const scheduler = (log: EventLog, provider: Provider, approver?: PermissionApprover, agentContext = "") => new BackgroundAgentScheduler(log, provider, new ToolRegistry(new Map()), approver, agentContext);

class RecordingHostDriver implements BackgroundAgentHostDriver {
  readonly deliveries: Array<{ parentSessionId: string; callbackId: string }> = [];
  failures = 0;
  async deliver(parentSessionId: string, callbackId: string): Promise<void> {
    this.deliveries.push({ parentSessionId, callbackId });
    if (this.failures > 0) { this.failures -= 1; throw new Error("driver unavailable"); }
  }
}

class TerminalStatusFailingLog extends EventLog {
  override append(sessionId: string, input: NewEvent) {
    if (input.kind === "BackgroundAgentStatus" && ["completed", "failed", "cancelled", "recovery_required"].includes(input.data.status)) throw new Error("terminal persistence unavailable");
    return super.append(sessionId, input);
  }
}

class CallbackFailingLog extends EventLog {
  private failed = false;
  override append(sessionId: string, input: NewEvent) {
    if (input.kind === "BackgroundAgentCallback" && !this.failed) { this.failed = true; throw new Error("callback persistence unavailable"); }
    return super.append(sessionId, input);
  }
}

const appendBatchAgent = (log: EventLog, agentId: string, toolCallId: string, providerCallId: string, status: "completed" | "failed" = "completed"): void => {
  const batchId = `batch-${providerCallId}`;
  log.append("parent", { kind: "BackgroundAgentCreated", data: { agentId, parentSessionId: "parent", parentToolCallId: toolCallId, profile: BACKGROUND_AGENT_PROFILE, childSessionId: `child-${agentId}`, contextMode: "fresh", provider: "fake", model: "fake/finleet", timeoutMs: 1, maxTurns: 1, task: "research", mode: "async", callbackId: `callback-${agentId}`, batchId, parentProviderCallId: providerCallId, parentAssistantMessageId: "run" } });
  log.append("parent", { kind: "ToolCalled", data: { callId: toolCallId, name: "spawn_agent", argumentsDigest: "digest" } });
  log.append("parent", { kind: "ToolSucceeded", data: { callId: toolCallId, preview: "spawned", truncated: false, result: "spawned", resultTruncated: false } });
  if (status === "completed") {
    log.append("parent", { kind: "BackgroundAgentStatus", data: { agentId, status, output: `${agentId} result`, outputPreview: `${agentId} result`, outputTruncated: false } });
    log.append("parent", { kind: "BackgroundAgentCallback", data: { agentId, callbackId: `callback-${agentId}`, parentToolCallId: toolCallId, envelope: { trust: "untrusted-data", status, output: `${agentId} result`, outputTruncated: false } } });
  } else {
    log.append("parent", { kind: "BackgroundAgentStatus", data: { agentId, status, errorCode: "CHILD_FAILED", errorMessage: `${agentId} failed` } });
    log.append("parent", { kind: "BackgroundAgentCallback", data: { agentId, callbackId: `callback-${agentId}`, parentToolCallId: toolCallId, envelope: { trust: "untrusted-data", status, error: { code: "CHILD_FAILED", message: `${agentId} failed` } } } });
  }
};

test("background spawn inherits system context, is durable and idempotent, and produces bounded redacted output", async () => {
  const log = new EventLog(journal()); const provider = new DelayedProvider(); const control = scheduler(log, provider, undefined, "Layered agent instructions");
  const first = control.spawn(parent(), { task: "Research token=secret", profile: BACKGROUND_AGENT_PROFILE });
  assert.equal(first.ok, true); if (!first.ok) return;
  const duplicate = control.spawn(parent(), { task: "different task" });
  assert.equal(duplicate.ok, true); if (duplicate.ok) assert.equal(duplicate.value.agentId, first.value.agentId);
  assert.equal(provider.started, 0);
  await tick(); assert.equal(provider.started, 1);
  assert.equal(provider.systems[0]?.startsWith("Layered agent instructions\n\nMarket provenance:"), true);
  provider.release(); await tick(); await tick();
  const output = control.read("parent", first.value.agentId);
  assert.equal(output.ok, true); if (output.ok) { assert.equal(output.value.agent.status, "completed"); assert.equal(output.value.output.includes("hidden"), false); }
  const events = log.read(); assert.equal(events.ok, true); if (events.ok) { const created = events.value.find((event) => event.kind === "BackgroundAgentCreated"); const status = events.value.filter((event) => event.kind === "BackgroundAgentStatus").at(-1); assert.equal(created?.kind === "BackgroundAgentCreated" && created.data.task.includes("secret"), false); assert.equal(status?.kind === "BackgroundAgentStatus" && status.data.output?.includes("hidden"), false); }
});

test("background snapshots are admission-time bounded and fresh children exclude parent history", () => {
  const log = new EventLog(journal());
  log.admit({ sessionId: "parent", promptId: "p", prompt: "parent history", delivery: "queue" });
  log.append("parent", { kind: "InputPromoted", data: { promptId: "p", delivery: "queue", reason: "queue-idle" } });
  const control = scheduler(log, new DelayedProvider());
  const snapshot = control.spawn(parent("snapshot"), { task: "research", contextMode: "parent_snapshot", contextWindow: 32 });
  const fresh = control.spawn(parent("fresh"), { task: "research", contextMode: "fresh" });
  assert.equal(snapshot.ok, true); assert.equal(fresh.ok, true);
  const events = log.read(); assert.equal(events.ok, true); if (events.ok) { const created = events.value.filter((event) => event.kind === "BackgroundAgentCreated"); assert.equal(created.find((event) => event.data.parentToolCallId === "snapshot")?.data.contextSnapshot?.includes("parent history"), true); assert.equal(created.find((event) => event.data.parentToolCallId === "fresh")?.data.contextSnapshot, undefined); }
});

test("same-parent agents wait in the queue until an active slot opens", async () => {
  const log = new EventLog(journal()); const provider = new DelayedProvider(); const control = scheduler(log, provider);
  const first = control.spawn(parent("first"), { task: "first" });
  const second = control.spawn(parent("second"), { task: "second" });
  const third = control.spawn(parent("third"), { task: "third" });
  assert.equal(first.ok, true); assert.equal(second.ok, true); assert.equal(third.ok, true);
  if (!third.ok) return;
  assert.equal(third.value.status, "queued");
  await tick(); assert.equal(provider.started, 2);
  provider.release(); await tick(); await tick(); await tick();
  assert.equal(provider.started, 3);
  const completed = await control.wait("parent", third.value.agentId);
  assert.equal(completed.ok, true); if (completed.ok) assert.equal(completed.value.status, "completed");
});

test("a saturated parent does not block another parent's queued agent", async () => {
  const log = new EventLog(journal()); const provider = new DelayedProvider(); const control = scheduler(log, provider);
  assert.equal(control.spawn(parent("first"), { task: "first" }).ok, true);
  assert.equal(control.spawn(parent("second"), { task: "second" }).ok, true);
  assert.equal(control.spawn(parent("third"), { task: "third" }).ok, true);
  assert.equal(control.spawn({ ...parent("other"), sessionId: "other-parent" }, { task: "other" }).ok, true);
  await tick(); assert.equal(provider.started, 3);
  provider.release(); await tick(); await tick(); await tick();
});

test("cancelling an approval-waiting agent releases its slot", async () => {
  const log = new EventLog(journal()); let approvals = 0;
  const provider: Provider = { providerId: "fake", modelId: "fake/finleet", mode: "fake", async *stream(): AsyncIterable<ProviderEvent> { yield { type: "local_tool_call", callId: "approval-call", name: "protected", arguments: {} }; yield { type: "finished", finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1 } }; } };
  const protectedTool = new ToolRegistry(new Map([["protected", { advertisement: { name: "protected", description: "protected", inputSchema: {}, requiredPermission: "web:read" as const }, decode: (input: unknown) => ({ ok: true as const, value: input }), authorize: () => ({ ok: true as const, value: undefined }), permissionRequirement: () => ({ ok: true as const, value: { requiredPermission: "web:read" as const, scope: "child:test", interactiveRequired: true } }), execute: () => ({ ok: true as const, value: "ok" }), encode: (value: unknown) => String(value) }]]));
  const control = new BackgroundAgentScheduler(log, provider, protectedTool, async () => { approvals += 1; return new Promise<never>(() => undefined); });
  const first = control.spawn(parent("first"), { task: "first" }); const second = control.spawn(parent("second"), { task: "second" }); const third = control.spawn(parent("third"), { task: "third" });
  assert.equal(first.ok, true); assert.equal(second.ok, true); assert.equal(third.ok, true); if (!first.ok || !second.ok || !third.ok) return;
  await tick(); await tick(); assert.equal(approvals, 2);
  assert.equal(control.cancel("parent", first.value.agentId).ok, true);
  await tick(); await tick(); await tick(); assert.equal(approvals, 3);
  assert.equal(control.cancel("parent", second.value.agentId).ok, true); assert.equal(control.cancel("parent", third.value.agentId).ok, true);
  await tick(); await tick();
});

test("background policy rejects untrusted profiles, provider settings, and parent ownership violations", () => {
  const log = new EventLog(journal()); const control = scheduler(log, new DelayedProvider());
  for (const input of [{ task: "x", profile: "writer" }, { task: "x", provider: "other" }, { task: "x", reasoningEffort: "high" }, { task: "x", maxTurns: 2 }]) assert.equal(control.spawn(parent(`invalid-${JSON.stringify(input)}`), input).ok, false);
  const spawned = control.spawn(parent("owned"), { task: "x" }); assert.equal(spawned.ok, true); if (spawned.ok) assert.equal(control.get("other-parent", spawned.value.agentId).ok, false);
});

test("background controls fail closed on malformed journals and failed child admission creates no agent", () => {
  const malformedPath = journal(); writeFileSync(malformedPath, "not-json\n", "utf8");
  const malformed = scheduler(new EventLog(malformedPath), new DelayedProvider());
  const spawned = malformed.spawn(parent("malformed"), { task: "research" });
  assert.equal(spawned.ok, false); if (!spawned.ok) assert.equal(spawned.error.code, "JOURNAL_INVALID");

  class AdmissionFailingLog extends EventLog { override admit(): ReturnType<EventLog["admit"]> { return { ok: false, error: { code: "ADMISSION_BUSY", message: "busy" } }; } }
  const log = new AdmissionFailingLog(journal());
  const rejected = scheduler(log, new DelayedProvider()).spawn(parent("admission-failure"), { task: "research" });
  assert.equal(rejected.ok, false);
  const events = log.read(); assert.equal(events.ok, true); if (events.ok) assert.equal(events.value.some((event) => event.kind === "BackgroundAgentCreated"), false);
});

test("background cancellation and journal recovery fail closed", async () => {
  const log = new EventLog(journal()); const provider = new DelayedProvider(); const control = scheduler(log, provider);
  const spawned = control.spawn(parent(), { task: "wait" }); assert.equal(spawned.ok, true); if (!spawned.ok) return;
  await tick(); const cancelled = control.cancel("parent", spawned.value.agentId); assert.equal(cancelled.ok, true); await tick();
  const status = control.get("parent", spawned.value.agentId); assert.equal(status.ok, true); if (status.ok) assert.equal(status.value.status, "cancelled");
  const recovered = scheduler(log, new DelayedProvider()).get("parent", spawned.value.agentId); assert.equal(recovered.ok, true); if (recovered.ok) assert.equal(recovered.value.status, "cancelled");
});

test("journal recovery durably terminalizes interrupted agents", () => {
  const log = new EventLog(journal());
  log.append("parent", { kind: "BackgroundAgentCreated", data: { agentId: "agent-interrupted", parentSessionId: "parent", parentToolCallId: "spawn-interrupted", profile: BACKGROUND_AGENT_PROFILE, childSessionId: "child-interrupted", contextMode: "fresh", provider: "fake", model: "fake/finleet", timeoutMs: 1, maxTurns: 1, task: "research" } });
  log.append("parent", { kind: "BackgroundAgentStatus", data: { agentId: "agent-interrupted", status: "running" } });
  const recovered = scheduler(log, new DelayedProvider()).get("parent", "agent-interrupted");
  assert.equal(recovered.ok, true); if (recovered.ok) assert.equal(recovered.value.status, "recovery_required");
  const events = log.read(); assert.equal(events.ok, true); if (events.ok) { const status = events.value.filter((event) => event.kind === "BackgroundAgentStatus").at(-1); assert.equal(status?.kind === "BackgroundAgentStatus" && status.data.status, "recovery_required"); }
});

test("wait_agent resolves only after the child reaches a terminal state", async () => {
  const log = new EventLog(journal()); const provider = new DelayedProvider(); const control = scheduler(log, provider);
  const spawned = control.spawn(parent("wait"), { task: "wait" }); assert.equal(spawned.ok, true); if (!spawned.ok) return;
  const waiting = control.wait("parent", spawned.value.agentId);
  await tick();
  let settled = false;
  void waiting.then(() => { settled = true; });
  await tick(); assert.equal(settled, false);
  provider.release(); const result = await waiting; assert.equal(result.ok, true); if (result.ok) assert.equal(result.value.status, "completed");
});

test("approval requests carry the child identity to the main broker", async () => {
  const log = new EventLog(journal()); let received: { agentId: string | undefined; childSessionId: string | undefined } | undefined;
  const provider: Provider = { providerId: "fake", modelId: "fake/finleet", mode: "fake", async *stream(): AsyncIterable<ProviderEvent> { yield { type: "local_tool_call", callId: "approval-call", name: "protected", arguments: {} }; yield { type: "finished", finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1 } }; } };
  const approver: PermissionApprover = async (request) => { received = { agentId: request.agentId, childSessionId: request.childSessionId }; return { decision: "reject" }; };
  const protectedTool = new ToolRegistry(new Map([[
    "protected",
    { advertisement: { name: "protected", description: "protected", inputSchema: {}, requiredPermission: "web:read" }, decode: (input: unknown) => ({ ok: true, value: input }), authorize: () => ({ ok: true, value: undefined }), permissionRequirement: () => ({ ok: true, value: { requiredPermission: "web:read", scope: "child:test", interactiveRequired: true } }), execute: () => ({ ok: true, value: "ok" }), encode: (value: unknown) => String(value) },
  ]]));
  const schedulerWithTool = new BackgroundAgentScheduler(log, provider, protectedTool, approver);
  const spawned = schedulerWithTool.spawn(parent("approval"), { task: "wait" }); assert.equal(spawned.ok, true); if (!spawned.ok) return;
  await new Promise<void>((resolve) => setTimeout(resolve, 20)); assert.equal(received?.agentId, spawned.value.agentId); assert.equal(received?.childSessionId, spawned.value.childSessionId);
});

test("blocking spawn waits for a bounded terminal success envelope", async () => {
  const log = new EventLog(journal()); const provider = new DelayedProvider(); const control = scheduler(log, provider);
  const blocking = control.spawnForTool(parent("blocking-success"), { task: "research", mode: "blocking" });
  await tick(); assert.equal(provider.started, 1);
  provider.release(); const result = await blocking;
  assert.equal(result.ok, true); if (!result.ok || !("mode" in result.value) || result.value.mode !== "blocking") return; assert.equal(result.value.terminal.trust, "untrusted-data"); assert.equal(result.value.terminal.status, "completed"); if (result.value.terminal.status === "completed") assert.equal(result.value.terminal.output.includes("hidden"), false);
});

test("blocking spawn returns child failures as structured terminal payloads", async () => {
  const log = new EventLog(journal());
  const provider: Provider = { providerId: "fake", modelId: "fake/finleet", mode: "fake", async *stream(): AsyncIterable<ProviderEvent> { yield { type: "finished", finishReason: "error", usage: { inputTokens: 0, outputTokens: 0 } }; } };
  const result = await scheduler(log, provider).spawnForTool(parent("blocking-failure"), { task: "research", mode: "blocking" });
  assert.equal(result.ok, true); if (!result.ok || !("mode" in result.value) || result.value.mode !== "blocking") return; assert.equal(result.value.terminal.status, "failed"); assert.equal(result.value.terminal.error.code, "PROVIDER_TERMINAL_ERROR");
});

test("blocking spawn releases waiters with a bounded recovery envelope when terminal persistence fails", async () => {
  const log = new TerminalStatusFailingLog(journal()); const provider = new DelayedProvider(); const control = scheduler(log, provider);
  const pending = control.spawnForTool(parent("blocking-persistence-failure"), { task: "research", mode: "blocking" });
  await tick(); provider.release(); const result = await pending;
  assert.equal(result.ok, true); if (!result.ok || !("mode" in result.value) || result.value.mode !== "blocking") return;
  assert.equal(result.value.terminal.status, "recovery_required");
  if (result.value.terminal.status !== "recovery_required") return;
  assert.equal(result.value.terminal.error.code, "AGENT_TERMINAL_PERSISTENCE_FAILED");
  assert.equal(result.value.terminal.error.message.length <= MAX_EVENT_TEXT, true);
});

test("callback persistence failure retains the durable terminal status for recovery retry", async () => {
  const log = new CallbackFailingLog(journal()); const provider = new DelayedProvider(); const control = scheduler(log, provider);
  const spawned = await control.spawnForTool(parent("async-callback-persistence-failure"), { task: "research", mode: "async" });
  assert.equal(spawned.ok, true); if (!spawned.ok || !("mode" in spawned.value) || spawned.value.mode !== "async") return;
  await tick(); provider.release(); await tick(); await tick();
  const terminal = control.get("parent", spawned.value.agent.agentId);
  assert.equal(terminal.ok, true); if (terminal.ok) assert.equal(terminal.value.status, "completed");
  const beforeRetry = log.read(); assert.equal(beforeRetry.ok, true); if (beforeRetry.ok) assert.equal(beforeRetry.value.filter((event) => event.kind === "BackgroundAgentCallback").length, 0);
  scheduler(log, new DelayedProvider()).get("parent", spawned.value.agent.agentId);
  const recovered = log.read(); assert.equal(recovered.ok, true); if (recovered.ok) assert.equal(recovered.value.filter((event) => event.kind === "BackgroundAgentCallback").length, 1);
});

test("async spawn returns immediately and projects exactly one callback after its original tool result", async () => {
  const log = new EventLog(journal()); const provider = new DelayedProvider(); const control = scheduler(log, provider);
  const result = await control.spawnForTool(parent("async-success"), { task: "research", mode: "async" });
  assert.equal(result.ok, true); if (!result.ok || !("mode" in result.value) || result.value.mode !== "async") return;
  assert.equal(result.value.callbackId.startsWith("callback-"), true); assert.equal(result.value.batchId.startsWith("batch-"), true); assert.notEqual(result.value.agent.status, "completed");
  log.append("parent", { kind: "ToolCalled", data: { callId: "async-success", name: "spawn_agent", argumentsDigest: "digest" } });
  log.append("parent", { kind: "ToolSucceeded", data: { callId: "async-success", preview: "spawned", truncated: false, result: "spawned", resultTruncated: false } });
  log.append("parent", { kind: "ProviderTurnFinished", data: { providerCallId: "turn", finishReason: "tool-calls", inputTokens: 1, outputTokens: 1 } });
  assert.equal(sealBackgroundAgentBatches(log, "parent", "turn").ok, true);
  await tick(); provider.release(); await tick(); await tick();
  const replay = await control.spawnForTool(parent("async-success"), { task: "different", mode: "async" });
  assert.equal(replay.ok, true); if (replay.ok && "mode" in replay.value && replay.value.mode === "async") assert.equal(replay.value.callbackId, result.value.callbackId);
  const events = log.read(); assert.equal(events.ok, true); if (!events.ok) return;
  const callbacks = events.value.filter((event) => event.kind === "BackgroundAgentCallback"); assert.equal(callbacks.length, 1);
  const history = projectHistory(events.value, "parent"); const callbackIndex = history.findIndex((message) => message.toolName === "background_agent_batch_callback"); const spawnResultIndex = history.findIndex((message) => message.toolCallId === "async-success");
  assert.equal(callbackIndex > spawnResultIndex, true); assert.equal(history[callbackIndex - 1]?.role, "assistant"); assert.equal(history.some((message) => message.role === "user" && message.content.includes("callback")), false);
});

test("async terminal failure emits one structured callback and invalid modes fail decoding", async () => {
  const log = new EventLog(journal());
  const provider: Provider = { providerId: "fake", modelId: "fake/finleet", mode: "fake", async *stream(): AsyncIterable<ProviderEvent> { yield { type: "finished", finishReason: "error", usage: { inputTokens: 0, outputTokens: 0 } }; } };
  const control = scheduler(log, provider); const result = await control.spawnForTool(parent("async-failure"), { task: "research", mode: "async" });
  assert.equal(result.ok, true); await tick(); await tick(); const events = log.read(); assert.equal(events.ok, true); if (events.ok) { const callback = events.value.find((event) => event.kind === "BackgroundAgentCallback"); assert.equal(callback?.kind === "BackgroundAgentCallback" && callback.data.envelope.status, "failed"); }
  const tools = backgroundAgentTools(control); const spawn = tools.at(0); assert.notEqual(spawn, undefined); if (spawn !== undefined) { assert.equal(spawn[1].decode({ task: "research", mode: "later" }).ok, false); assert.deepEqual(spawn[1].advertisement.inputSchema, { type: "object", properties: { task: { type: "string" }, mode: { type: "string", enum: ["blocking", "async"] } }, required: ["task"] }); }
});

test("list_agents projects only caller-scoped live agents in creation order without sensitive fields", async () => {
  const log = new EventLog(journal());
  const append = (agentId: string, parentSessionId: string, status?: "queued" | "running" | "waiting_approval" | "completed" | "failed" | "cancelled" | "recovery_required") => {
    log.append(parentSessionId, { kind: "BackgroundAgentCreated", data: { agentId, parentSessionId, parentToolCallId: `call-${agentId}`, profile: BACKGROUND_AGENT_PROFILE, childSessionId: `child-${agentId}`, contextMode: "fresh", provider: "private-provider", model: "private-model", timeoutMs: 1, maxTurns: 1, task: "private task", contextSnapshot: "private context" } });
    if (status !== undefined) log.append(parentSessionId, { kind: "BackgroundAgentStatus", data: { agentId, status, output: "private output", errorMessage: "private error" } });
  };
  append("first", "parent", "queued"); append("settled", "parent", "completed"); append("other", "other-parent", "running"); append("second", "parent", "waiting_approval"); append("missing", "parent"); append("latest-settled", "parent", "running"); log.append("parent", { kind: "BackgroundAgentStatus", data: { agentId: "latest-settled", status: "cancelled" } });
  const events = log.read(); assert.equal(events.ok, true); if (!events.ok) return;
  assert.deepEqual(projectLiveBackgroundAgents(events.value, "parent"), [{ index: 1, agentId: "first", childSessionId: "child-first", status: "queued" }, { index: 2, agentId: "second", childSessionId: "child-second", status: "waiting_approval" }]);
  const tools = backgroundAgentTools(scheduler(log, new DelayedProvider())); const list = tools.find(([name]) => name === "list_agents"); assert.notEqual(list, undefined); if (list === undefined) return;
  assert.equal(list[1].decode([]).ok, false); assert.equal(list[1].decode({ unexpected: true }).ok, false); assert.equal(list[1].decode({}).ok, true);
  const executed = await list[1].execute({}, parent()); assert.equal(executed.ok, true); if (!executed.ok) return;
  const encoded = list[1].encode(executed.value); assert.deepEqual(encoded, [{ index: 1, agentId: "first", childSessionId: "child-first", status: "queued" }, { index: 2, agentId: "second", childSessionId: "child-second", status: "waiting_approval" }]);
  assert.equal(JSON.stringify(encoded).includes("private"), false);
});

test("async callback delivery is retried after a driver failure without duplicating the durable callback", async () => {
  const log = new EventLog(journal()); const provider = new DelayedProvider(); const driver = new RecordingHostDriver(); driver.failures = 1;
  const control = new BackgroundAgentScheduler(log, provider, new ToolRegistry(new Map()), undefined, "", process.cwd(), driver);
  const spawned = await control.spawnForTool(parent("async-driver-retry"), { task: "research", mode: "async" });
  assert.equal(spawned.ok, true); if (!spawned.ok || !("mode" in spawned.value) || spawned.value.mode !== "async") return;
  log.append("parent", { kind: "ToolCalled", data: { callId: "async-driver-retry", name: "spawn_agent", argumentsDigest: "digest" } });
  log.append("parent", { kind: "ToolSucceeded", data: { callId: "async-driver-retry", preview: "spawned", truncated: false, result: "spawned", resultTruncated: false } });
  log.append("parent", { kind: "ProviderTurnFinished", data: { providerCallId: "turn", finishReason: "tool-calls", inputTokens: 1, outputTokens: 1 } });
  assert.equal(sealBackgroundAgentBatches(log, "parent", "turn").ok, true);
  await tick(); provider.release(); await tick(); await tick();
  assert.equal(driver.deliveries.length, 1);
  control.retryPendingCallbacks("parent"); await tick();
  assert.equal(driver.deliveries.length, 2);
  const events = log.read(); assert.equal(events.ok, true); if (events.ok) assert.equal(events.value.filter((event) => event.kind === "BackgroundAgentCallback").length, 1);
});

test("callback retry reconciles async agents with missing status or callback records", async () => {
  const noStatusLog = new EventLog(journal()); const noStatusDriver = new RecordingHostDriver();
  noStatusLog.append("parent", { kind: "BackgroundAgentCreated", data: { agentId: "agent-no-status", parentSessionId: "parent", parentToolCallId: "spawn-no-status", profile: BACKGROUND_AGENT_PROFILE, childSessionId: "child-no-status", contextMode: "fresh", provider: "fake", model: "fake/finleet", timeoutMs: 1, maxTurns: 1, task: "research", mode: "async", callbackId: "callback-no-status" } });
  const noStatus = new BackgroundAgentScheduler(noStatusLog, new DelayedProvider(), new ToolRegistry(new Map()), undefined, "", process.cwd(), noStatusDriver).retryPendingCallbacks("parent");
  assert.equal(noStatus.ok, true); await tick();
  const recovered = noStatusLog.read(); assert.equal(recovered.ok, true); if (recovered.ok) { assert.equal(recovered.value.some((event) => event.kind === "BackgroundAgentStatus" && event.data.status === "recovery_required"), true); assert.equal(recovered.value.some((event) => event.kind === "BackgroundAgentCallback" && event.data.envelope.status === "recovery_required"), true); }
  assert.equal(noStatusDriver.deliveries.length, 1);

  const noCallbackLog = new EventLog(journal()); const noCallbackDriver = new RecordingHostDriver();
  noCallbackLog.append("parent", { kind: "BackgroundAgentCreated", data: { agentId: "agent-no-callback", parentSessionId: "parent", parentToolCallId: "spawn-no-callback", profile: BACKGROUND_AGENT_PROFILE, childSessionId: "child-no-callback", contextMode: "fresh", provider: "fake", model: "fake/finleet", timeoutMs: 1, maxTurns: 1, task: "research", mode: "async", callbackId: "callback-no-callback" } });
  noCallbackLog.append("parent", { kind: "BackgroundAgentStatus", data: { agentId: "agent-no-callback", status: "failed", errorCode: "CHILD_FAILED", errorMessage: "child failed" } });
  const noCallback = new BackgroundAgentScheduler(noCallbackLog, new DelayedProvider(), new ToolRegistry(new Map()), undefined, "", process.cwd(), noCallbackDriver).retryPendingCallbacks("parent");
  assert.equal(noCallback.ok, true); await tick();
  const repaired = noCallbackLog.read(); assert.equal(repaired.ok, true); if (repaired.ok) assert.equal(repaired.value.some((event) => event.kind === "BackgroundAgentCallback" && event.data.envelope.status === "failed"), true);
  assert.equal(noCallbackDriver.deliveries.length, 1);
});

test("a raced callback is projected immediately after its originating spawn result", () => {
  const log = new EventLog(journal());
  log.append("parent", { kind: "BackgroundAgentCreated", data: { agentId: "agent-race", parentSessionId: "parent", parentToolCallId: "spawn-race", profile: BACKGROUND_AGENT_PROFILE, childSessionId: "child-race", contextMode: "fresh", provider: "fake", model: "fake/finleet", timeoutMs: 1, maxTurns: 1, task: "research", mode: "async", callbackId: "callback-race" } });
  log.append("parent", { kind: "BackgroundAgentStatus", data: { agentId: "agent-race", status: "completed", output: "done", outputPreview: "done", outputTruncated: false } });
  log.append("parent", { kind: "BackgroundAgentCallback", data: { agentId: "agent-race", callbackId: "callback-race", parentToolCallId: "spawn-race", envelope: { trust: "untrusted-data", status: "completed", output: "done", outputTruncated: false } } });
  log.append("parent", { kind: "ToolCalled", data: { callId: "spawn-race", name: "spawn_agent", argumentsDigest: "digest" } });
  log.append("parent", { kind: "ToolSucceeded", data: { callId: "spawn-race", preview: "spawned", truncated: false, result: "spawned", resultTruncated: false } });
  const events = log.read(); assert.equal(events.ok, true); if (!events.ok) return;
  const history = projectHistory(events.value, "parent"); const spawnResult = history.findIndex((message) => message.toolCallId === "spawn-race"); const callbackCall = history.findIndex((message) => message.toolCalls?.[0]?.callId === "callback-race"); const callbackResult = history.findIndex((message) => message.toolCallId === "callback-race");
  assert.equal(callbackCall, spawnResult + 1); assert.equal(callbackResult, callbackCall + 1);
});

test("an already-settled callback remains before later normal history", () => {
  const log = new EventLog(journal());
  log.append("parent", { kind: "BackgroundAgentCreated", data: { agentId: "agent-chronology", parentSessionId: "parent", parentToolCallId: "spawn-chronology", profile: BACKGROUND_AGENT_PROFILE, childSessionId: "child-chronology", contextMode: "fresh", provider: "fake", model: "fake/finleet", timeoutMs: 1, maxTurns: 1, task: "research", mode: "async", callbackId: "callback-chronology" } });
  log.append("parent", { kind: "BackgroundAgentStatus", data: { agentId: "agent-chronology", status: "completed", output: "done", outputPreview: "done", outputTruncated: false } });
  log.append("parent", { kind: "ToolCalled", data: { callId: "spawn-chronology", name: "spawn_agent", argumentsDigest: "digest" } });
  log.append("parent", { kind: "ToolSucceeded", data: { callId: "spawn-chronology", preview: "spawned", truncated: false, result: "spawned", resultTruncated: false } });
  log.append("parent", { kind: "BackgroundAgentCallback", data: { agentId: "agent-chronology", callbackId: "callback-chronology", parentToolCallId: "spawn-chronology", envelope: { trust: "untrusted-data", status: "completed", output: "done", outputTruncated: false } } });
  log.append("parent", { kind: "ProviderText", data: { providerCallId: "turn-later", text: "later normal history", truncated: false } });
  const events = log.read(); assert.equal(events.ok, true); if (!events.ok) return;
  const history = projectHistory(events.value, "parent"); const callbackResult = history.findIndex((message) => message.toolCallId === "callback-chronology"); const later = history.findIndex((message) => message.content === "later normal history");
  assert.equal(callbackResult < later, true);
});

test("sealed async siblings materialize one ordered mixed-outcome callback after the last spawn result", () => {
  const log = new EventLog(journal());
  appendBatchAgent(log, "agent-first", "spawn-first", "turn-fan-in");
  appendBatchAgent(log, "agent-second", "spawn-second", "turn-fan-in", "failed");
  assert.equal(materializeReadyBackgroundAgentBatchCallbacks(log, "parent").ok, true);
  let beforeSeal = log.read(); assert.equal(beforeSeal.ok, true); if (!beforeSeal.ok) return;
  assert.equal(beforeSeal.value.some((event) => event.kind === "BackgroundAgentBatchCallback"), false);
  log.append("parent", { kind: "ProviderTurnFinished", data: { providerCallId: "turn-fan-in", finishReason: "tool-calls", inputTokens: 1, outputTokens: 1 } });
  assert.equal(sealBackgroundAgentBatches(log, "parent", "turn-fan-in").ok, true);
  assert.equal(materializeReadyBackgroundAgentBatchCallbacks(log, "parent").ok, true);
  const events = log.read(); assert.equal(events.ok, true); if (!events.ok) return;
  const batches = events.value.filter((event) => event.kind === "BackgroundAgentBatchCallback");
  assert.equal(batches.length, 1); if (batches[0]?.kind !== "BackgroundAgentBatchCallback") return;
  assert.deepEqual(batches[0].data.members.map((member) => member.agentId), ["agent-first", "agent-second"]);
  assert.deepEqual(batches[0].data.members.map((member) => member.envelope.status), ["completed", "failed"]);
  const history = projectHistory(events.value, "parent");
  const batchResult = history.findIndex((message) => message.toolName === "background_agent_batch_callback");
  const lastSpawn = history.findIndex((message) => message.toolCallId === "spawn-second");
  assert.equal(batchResult, lastSpawn + 2);
  assert.equal(history.filter((message) => message.toolName === "background_agent_callback").length, 0);
});

test("provider-call batches remain isolated and never seal an unterminated turn", () => {
  const log = new EventLog(journal());
  appendBatchAgent(log, "agent-one", "spawn-one", "turn-one");
  appendBatchAgent(log, "agent-two", "spawn-two", "turn-two");
  assert.equal(sealBackgroundAgentBatches(log, "parent", "turn-one").ok, true);
  assert.equal(materializeReadyBackgroundAgentBatchCallbacks(log, "parent").ok, true);
  let events = log.read(); assert.equal(events.ok, true); if (!events.ok) return;
  assert.equal(events.value.some((event) => event.kind === "BackgroundAgentBatchSealed"), false);
  log.append("parent", { kind: "ProviderTurnFinished", data: { providerCallId: "turn-one", finishReason: "tool-calls", inputTokens: 1, outputTokens: 1 } });
  assert.equal(sealBackgroundAgentBatches(log, "parent", "turn-one").ok, true);
  assert.equal(materializeReadyBackgroundAgentBatchCallbacks(log, "parent").ok, true);
  events = log.read(); assert.equal(events.ok, true); if (!events.ok) return;
  assert.equal(events.value.filter((event) => event.kind === "BackgroundAgentBatchSealed").length, 1);
  assert.equal(events.value.filter((event) => event.kind === "BackgroundAgentBatchCallback").length, 1);
  assert.equal(events.value.find((event) => event.kind === "BackgroundAgentBatchCallback")?.kind === "BackgroundAgentBatchCallback" && events.value.find((event) => event.kind === "BackgroundAgentBatchCallback")?.data.batchId, "batch-turn-one");
});

test("journal rejects duplicate or non-terminal async callbacks", async () => {
  const log = new EventLog(journal()); const provider = new DelayedProvider(); const control = scheduler(log, provider);
  const result = await control.spawnForTool(parent("callback-conflict"), { task: "research", mode: "async" });
  if (!result.ok || !("mode" in result.value) || result.value.mode !== "async") return;
  log.append("parent", { kind: "BackgroundAgentCallback", data: { agentId: result.value.agent.agentId, callbackId: result.value.callbackId, parentToolCallId: "callback-conflict", envelope: { trust: "untrusted-data", status: "completed", output: "premature", outputTruncated: false } } });
  assert.equal(log.read().ok, false);
  provider.release(); await tick();
});

test("journal rejects status changes after terminalization and duplicate callback acknowledgments", () => {
  const log = new EventLog(journal());
  log.append("parent", { kind: "BackgroundAgentCreated", data: { agentId: "agent-ack", parentSessionId: "parent", parentToolCallId: "spawn-ack", profile: BACKGROUND_AGENT_PROFILE, childSessionId: "child-ack", contextMode: "fresh", provider: "fake", model: "fake/finleet", timeoutMs: 1, maxTurns: 1, task: "research", mode: "async", callbackId: "callback-ack" } });
  log.append("parent", { kind: "BackgroundAgentStatus", data: { agentId: "agent-ack", status: "completed", output: "done", outputPreview: "done", outputTruncated: false } });
  log.append("parent", { kind: "BackgroundAgentCallback", data: { agentId: "agent-ack", callbackId: "callback-ack", parentToolCallId: "spawn-ack", envelope: { trust: "untrusted-data", status: "completed", output: "done", outputTruncated: false } } });
  log.append("parent", { kind: "BackgroundAgentCallbackDelivered", data: { agentId: "agent-ack", callbackId: "callback-ack", parentToolCallId: "spawn-ack" } });
  log.append("parent", { kind: "BackgroundAgentCallbackDelivered", data: { agentId: "agent-ack", callbackId: "callback-ack", parentToolCallId: "spawn-ack" } });
  assert.equal(log.read().ok, false);
  const stale = new EventLog(journal());
  stale.append("parent", { kind: "BackgroundAgentCreated", data: { agentId: "agent-stale", parentSessionId: "parent", parentToolCallId: "spawn-stale", profile: BACKGROUND_AGENT_PROFILE, childSessionId: "child-stale", contextMode: "fresh", provider: "fake", model: "fake/finleet", timeoutMs: 1, maxTurns: 1, task: "research" } });
  stale.append("parent", { kind: "BackgroundAgentStatus", data: { agentId: "agent-stale", status: "completed", output: "done", outputPreview: "done", outputTruncated: false } });
  stale.append("parent", { kind: "BackgroundAgentStatus", data: { agentId: "agent-stale", status: "running" } });
  assert.equal(stale.read().ok, false);
  const invalid = new EventLog(journal());
  invalid.append("parent", { kind: "BackgroundAgentCreated", data: { agentId: "agent-invalid", parentSessionId: "parent", parentToolCallId: "spawn-invalid", profile: BACKGROUND_AGENT_PROFILE, childSessionId: "child-invalid", contextMode: "fresh", provider: "fake", model: "fake/finleet", timeoutMs: 1, maxTurns: 1, task: "research" } });
  invalid.append("parent", { kind: "BackgroundAgentStatus", data: { agentId: "agent-invalid", status: "queued" } });
  invalid.append("parent", { kind: "BackgroundAgentStatus", data: { agentId: "agent-invalid", status: "completed" } });
  assert.equal(invalid.read().ok, false);
});

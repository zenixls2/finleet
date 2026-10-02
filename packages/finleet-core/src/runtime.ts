import { closeSync, existsSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { digest, EventLog, fail, FixturePaperExchange, MAX_EVENT_PREVIEW, MAX_EVENT_TEXT, MAX_TOOL_RESULT, nextInboxItem, projectHistory, redactJson, redactOutputText, sealBackgroundAgentBatches, type DurableEvent, type EventOfKind, type ExchangeAdapter, type FinleetError, type GraphPlan, type GraphPlanDraft, type HistoryMessage, type Json, type McpContract, type Permission, type PluginContract, type ProviderAdapter, type ProviderFinishReason, type Result } from "./domain.js";

export interface ProviderRequest { providerId: string; modelId: string; messages: readonly HistoryMessage[]; system: string; tools: readonly ToolAdvertisement[]; signal?: AbortSignal; }
export type ProviderEvent = { type: "text"; text: string } | { type: "local_tool_call"; callId: string; name: string; arguments: unknown } | { type: "provider_tool_call"; callId: string; name: string; arguments: unknown; execution: "local" | "provider" } | { type: "finished"; finishReason: ProviderFinishReason; usage: { inputTokens: number; outputTokens: number } };
export interface Provider extends ProviderAdapter { readonly modelId?: string; stream(request: ProviderRequest): AsyncIterable<ProviderEvent>; }
class ApprovalCapability {
  readonly #requirement: PermissionRequirement;
  constructor(requirement: PermissionRequirement) { this.#requirement = requirement; }
  matches(requiredPermission: Permission, scope: string): boolean { return this.#requirement.requiredPermission === requiredPermission && this.#requirement.scope === scope; }
}
export interface ToolContext { sessionId: string; agentId: string; assistantMessageId: string; providerCallId: string; toolCallId?: string; permissions: ReadonlySet<Permission>; signal?: AbortSignal; workingDirectory?: string; approvedPermission?: ApprovalCapability; }
export interface ToolAdvertisement { name: string; description: string; inputSchema: Record<string, Json>; requiredPermission?: Permission; }
export type PermissionDecision = { decision: "allow-once" } | { decision: "allow-job" } | { decision: "allow-session" } | { decision: "reject"; feedback?: string };
export interface PermissionRequirement { requiredPermission: Permission; scope: string; reviewSteps?: readonly string[]; interactiveRequired?: boolean; }
export interface PermissionRequest { toolName: string; requiredPermission: Permission; scope: string; scopeKey?: string; arguments: Json; reviewSteps: readonly string[]; admissionId?: string; agentId?: string; childSessionId?: string; }
export interface AdmittedPermissionRequest extends PermissionRequest { admissionId: string; }
export type PermissionApprover = (request: AdmittedPermissionRequest) => Promise<PermissionDecision>;
export interface ToolDefinition<I, O> { advertisement: ToolAdvertisement; durableResultLimit?: number; decode(input: unknown): Result<I>; authorize(context: ToolContext): Result<void>; permissionRequirement?(input: I, context: ToolContext): Result<PermissionRequirement> | Promise<Result<PermissionRequirement>>; execute(input: I, context: ToolContext): Result<O> | Promise<Result<O>>; encode(output: O): Json; }
export interface FinanceContext { text: string; provenance: readonly { source: string; asOf: string; digest: string }[]; usedChars: number; budgetChars: number; }
export interface RunResult { history: readonly HistoryMessage[]; promotedPromptId: string; runId: string; }
export interface RecordedRunResult extends RunResult { outcome: "finished" | "failed"; }
export interface RunnerOptions { plan?: GraphPlanDraft; agentId?: string; now?: () => Date; timeZone?: string; }

const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
export const hasApprovedPermission = (context: ToolContext, requiredPermission: Permission, scope: string): boolean => context.approvedPermission instanceof ApprovalCapability && context.approvedPermission.matches(requiredPermission, scope);
const stringField = (value: Record<string, unknown>, name: string): Result<string> => typeof value[name] === "string" ? { ok: true, value: value[name] } : fail("TOOL_ARGUMENT_INVALID", `${name} must be a string`);
const bounded = (value: string, limit: number): { value: string; truncated: boolean } => ({ value: value.slice(0, limit), truncated: value.length > limit });
const localIanaTimeZone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone;
const validatedIanaTimeZone = (timeZone: string): string => {
  try { return new Intl.DateTimeFormat("en-US", { timeZone }).resolvedOptions().timeZone; }
  catch { throw new RangeError("Invalid IANA time zone"); }
};
export function formatLocalTimestamp(value: Date, timeZone: string): string {
  if (!Number.isFinite(value.getTime())) throw new RangeError("Timestamp must be a valid Date");
  const zone = validatedIanaTimeZone(timeZone);
  const parts = new Intl.DateTimeFormat("en-CA", { calendar: "gregory", hourCycle: "h23", timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", timeZoneName: "longOffset" }).formatToParts(value);
  const fields = new Map(parts.map((part) => [part.type, part.value]));
  const offsetName = fields.get("timeZoneName");
  const offset = offsetName === "GMT" ? "+00:00" : offsetName?.replace("GMT", "");
  if (offset === undefined || !/^[+-]\d{2}:\d{2}$/.test(offset)) throw new RangeError("Invalid IANA time zone");
  return `${fields.get("year")}-${fields.get("month")}-${fields.get("day")}T${fields.get("hour")}:${fields.get("minute")}:${fields.get("second")}${offset} [${zone}]`;
}
export function effectiveDurableResultLimit(value: number | undefined): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? Math.min(value, MAX_TOOL_RESULT) : MAX_EVENT_TEXT;
}
export function splitProviderText(value: string, limit = MAX_EVENT_TEXT): readonly string[] {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError("Provider text chunk limit must be a positive integer");
  if (value.length === 0) return [""];
  const chunks: string[] = [];
  let chunk = "";
  for (const character of value) {
    if (chunk.length > 0 && chunk.length + character.length > limit) {
      chunks.push(chunk);
      chunk = "";
    }
    chunk += character;
  }
  if (chunk.length > 0) chunks.push(chunk);
  return chunks;
}
const providerFailure = (cause: unknown): FinleetError => {
  const code = cause instanceof Error ? cause.message : undefined;
  if (code === "OPENAI_RESPONSES_REQUEST_FAILED") return { code, message: "OpenAI Responses request could not be sent" };
  if (code === "OPENAI_RESPONSES_RESPONSE_INVALID") return { code, message: "OpenAI Responses returned an invalid response" };
  if (code?.startsWith("OPENAI_RESPONSES_HTTP_FAILURE:")) return { code: "OPENAI_RESPONSES_HTTP_FAILURE", message: code };
  if (code === "OPENAI_RESPONSES_HTTP_FAILURE") return { code, message: "OpenAI Responses provider failed" };
  return { code: "PROVIDER_EXCEPTION", message: "Provider execution failed" };
};
const conciseIntentTitle = (tool: ToolAdvertisement): string => {
  const source = tool.description.replace(/\s+/g, " ").trim() || `Use ${tool.name}`;
  const limit = 80;
  let title = "";
  for (const character of source) {
    if (title.length + character.length > limit - 1) return `${title}…`;
    title += character;
  }
  return title;
};
const toolEffectId = (inputEventId: string, callId: string): string => `tool:${digest(`${inputEventId}:${callId}`).slice(0, 24)}`;
const hasPriorToolFailure = (events: readonly DurableEvent[], sessionId: string, inputEventId: string): boolean => {
  const runStart = events.findIndex((event) => event.sessionId === sessionId && event.kind === "GraphRunStarted" && event.data.inputEventId === inputEventId);
  if (runStart < 0) return false;
  const localCallIds = new Set<string>();
  for (const event of events.slice(runStart + 1)) {
    if (event.sessionId !== sessionId) continue;
    if (event.kind === "ToolCalled") localCallIds.add(event.data.callId);
    if (event.kind === "ToolFailed" && localCallIds.has(event.data.callId)) {
      const effectId = toolEffectId(inputEventId, event.data.callId);
      if (events.some((candidate) => candidate.sessionId === sessionId && candidate.kind === "EffectRecorded" && candidate.data.effectId === effectId && candidate.data.state === "failed")) return true;
    }
  }
  return false;
};

export class FakeProvider implements Provider {
  readonly providerId = "fake";
  readonly modelId = "fake/finleet";
  readonly mode = "fake" as const;
  async *stream(request: ProviderRequest): AsyncIterable<ProviderEvent> {
    const lastUser = [...request.messages].reverse().find((message) => message.role === "user");
    const prompt = lastUser?.content ?? "";
    if (prompt === "quote FIN") yield { type: "local_tool_call", callId: "fake-tool-1", name: "paper_quote", arguments: { symbol: "FIN" } };
    if (prompt.startsWith("fetch ")) yield { type: "local_tool_call", callId: "fake-fetch-1", name: "fetch_page", arguments: { url: prompt.slice("fetch ".length).trim() } };
    if (prompt.startsWith("bash ")) yield { type: "local_tool_call", callId: "fake-bash-1", name: "bash", arguments: { command: prompt.slice("bash ".length).trim() } };
    yield { type: "text", text: `Fake provider response: ${prompt}` };
    yield { type: "finished", finishReason: "stop", usage: { inputTokens: request.messages.length, outputTokens: prompt.length } };
  }
}

export class ToolRegistry {
  constructor(private readonly tools: ReadonlyMap<string, ToolDefinition<unknown, unknown>>) {}
  advertised(): readonly ToolAdvertisement[] { return [...this.tools.values()].map((tool) => tool.advertisement); }
  prepare(name: string, input: unknown, context: ToolContext): Result<{ definition: ToolDefinition<unknown, unknown>; input: unknown }> { const definition = this.tools.get(name); if (definition === undefined) return fail("TOOL_UNKNOWN", `Tool ${name} is not registered`); const decoded = definition.decode(input); if (!decoded.ok) return decoded; const authorization = definition.authorize(context); if (!authorization.ok) return authorization; return { ok: true, value: { definition, input: decoded.value } }; }
  async invokePrepared(prepared: { definition: ToolDefinition<unknown, unknown>; input: unknown }, context: ToolContext): Promise<Result<Json>> {
    if (prepared.definition.permissionRequirement !== undefined) {
      const requirement = await prepared.definition.permissionRequirement(prepared.input, context);
      if (!requirement.ok) return requirement;
      if (requirement.value.interactiveRequired === true && !hasApprovedPermission(context, requirement.value.requiredPermission, requirement.value.scope)) return fail("TOOL_PERMISSION_REQUIRED", `Interactive approval is required for ${requirement.value.scope}`);
    }
    const output = await prepared.definition.execute(prepared.input, context);
    return output.ok ? { ok: true, value: prepared.definition.encode(output.value) } : output;
  }
  async invoke(name: string, input: unknown, context: ToolContext): Promise<Result<Json>> { const prepared = this.prepare(name, input, context); return prepared.ok ? this.invokePrepared(prepared.value, context) : prepared; }
}
export function quoteTool(exchange: FixturePaperExchange): ToolDefinition<{ symbol: string }, { symbol: string; price: number; currency: "USD"; asOf: string; source: "paper-fixture" }> {
  return { advertisement: { name: "paper_quote", description: "Read a deterministic paper-market quote", requiredPermission: "market:read", inputSchema: { type: "object", required: ["symbol"], additionalProperties: false } }, decode(input) { if (!record(input) || Object.keys(input).length !== 1) return fail("TOOL_ARGUMENT_INVALID", "Expected exactly { symbol: string }"); const symbol = stringField(input, "symbol"); return symbol.ok ? { ok: true, value: { symbol: symbol.value } } : symbol; }, authorize(context) { return context.permissions.has("market:read") ? { ok: true, value: undefined } : fail("TOOL_DENIED", "market:read permission is required"); }, execute(input) { return exchange.quote(input.symbol); }, encode(output) { return { symbol: output.symbol, price: output.price, currency: output.currency, asOf: output.asOf, source: output.source }; } };
}

export function financeContext(exchange: FixturePaperExchange, permissions: ReadonlySet<Permission>, budgetChars: number): Result<FinanceContext> {
  if (!permissions.has("market:read") && !permissions.has("account:read")) return fail("CONTEXT_DENIED", "No finance context permission was granted");
  const parts: string[] = []; const provenance: { source: string; asOf: string; digest: string }[] = [];
  if (permissions.has("market:read")) { const quote = exchange.quote("FIN"); if (quote.ok) { const text = `${quote.value.symbol} ${quote.value.price} ${quote.value.currency} as-of ${quote.value.asOf}`; parts.push(`Market provenance: ${text}`); provenance.push({ source: quote.value.source, asOf: quote.value.asOf, digest: digest(text) }); } }
  if (permissions.has("account:read")) { const account = exchange.account(); const text = `Account: ${account.cash} ${account.currency} (${account.mode})`; parts.push(text); provenance.push({ source: "paper-account", asOf: "2026-01-01T00:00:00.000Z", digest: digest(text) }); }
  const text = parts.join("; ").slice(0, Math.max(0, Math.min(budgetChars, MAX_EVENT_TEXT))); return { ok: true, value: { text, provenance, usedChars: text.length, budgetChars: Math.max(0, Math.min(budgetChars, MAX_EVENT_TEXT)) } };
}

export class SerialCoordinator {
  private readonly active = new Map<string, Promise<void>>();
  async run(sessionId: string, operation: () => Promise<void>): Promise<void> { const prior = this.active.get(sessionId) ?? Promise.resolve(); const current = prior.then(operation, operation); this.active.set(sessionId, current); try { await current; } finally { if (this.active.get(sessionId) === current) this.active.delete(sessionId); } }
}
const sharedCoordinator = new SerialCoordinator();
export interface SessionLease { release(): void; }
export interface SessionLeaseFactory { acquire(log: EventLog, sessionId: string): Result<SessionLease>; }
export type OwnerLiveness = (pid: number) => boolean;
interface LeaseOwner { sessionId: string; pid: number; createdAt: string; }
export function sessionLeasePath(journalPath: string, sessionId: string): string { return join(dirname(journalPath), `.${basename(journalPath)}.${digest(sessionId).slice(0, 24)}.lease`); }
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const errorCode = (value: unknown): string | undefined => isRecord(value) && typeof value.code === "string" ? value.code : undefined;
const isLeaseOwner = (value: unknown): value is LeaseOwner => isRecord(value) && typeof value.sessionId === "string" && typeof value.pid === "number" && Number.isSafeInteger(value.pid) && value.pid > 0 && typeof value.createdAt === "string";
const processIsLive: OwnerLiveness = (pid) => { try { process.kill(pid, 0); return true; } catch (cause) { return errorCode(cause) !== "ESRCH"; } };
function readLeaseOwner(path: string): LeaseOwner | undefined { try { const parsed: unknown = JSON.parse(readFileSync(path, "utf8")); return isLeaseOwner(parsed) ? parsed : undefined; } catch { return undefined; } }
export function hasUnrecordedEffects(events: readonly DurableEvent[], sessionId: string): boolean { const outstanding = new Set<string>(); for (const event of events) { if (event.sessionId !== sessionId) continue; if (event.kind === "EffectClaimed") outstanding.add(event.data.effectId); if (event.kind === "EffectRecorded") outstanding.delete(event.data.effectId); } return outstanding.size > 0; }
export function hasUnsettledGraphRun(events: readonly DurableEvent[], sessionId: string): boolean { const unsettled = new Set<string>(); for (const event of events) { if (event.sessionId !== sessionId) continue; if (event.kind === "GraphRunStarted") unsettled.add(event.data.runId); if (event.kind === "GraphTransition" && (event.data.outcome === "finished" || event.data.outcome === "failed")) unsettled.delete(event.data.runId); if (event.kind === "ContinuationWindowOpened") { unsettled.delete(event.data.parentRunId); const childStarted = events.some((candidate) => candidate.sessionId === sessionId && candidate.kind === "GraphRunStarted" && candidate.data.runId === event.data.continuationRunId); const childUntouched = !events.some((candidate) => candidate.sessionId === sessionId && candidate.kind === "ProviderTurnStarted" && candidate.data.providerCallId.startsWith(`${event.data.continuationRunId}:`)); if (childStarted && childUntouched) unsettled.delete(event.data.continuationRunId); } } return unsettled.size > 0; }
class FileSessionLease implements SessionLease { private released = false; constructor(private readonly path: string) {} release(): void { if (this.released) return; try { unlinkSync(this.path); } catch (cause) { if (errorCode(cause) !== "ENOENT") throw cause; } this.released = true; } }
export class FileSessionLeaseFactory implements SessionLeaseFactory {
  constructor(private readonly ownerIsLive: OwnerLiveness = processIsLive) {}
  acquire(log: EventLog, sessionId: string): Result<SessionLease> {
    const path = sessionLeasePath(log.path, sessionId);
    const create = (): Result<SessionLease> => { let descriptor: number | undefined; try { descriptor = openSync(path, "wx"); writeFileSync(descriptor, JSON.stringify({ sessionId, pid: process.pid, createdAt: new Date().toISOString() }), "utf8"); return { ok: true, value: new FileSessionLease(path) }; } catch (cause) { return fail(errorCode(cause) === "EEXIST" ? "SESSION_BUSY" : "SESSION_LEASE_FAILED", "Session lease could not be acquired"); } finally { if (descriptor !== undefined) closeSync(descriptor); } };
    const initial = create(); if (initial.ok || initial.error.code !== "SESSION_BUSY") return initial;
    const owner = readLeaseOwner(path); if (owner === undefined || owner.sessionId !== sessionId || this.ownerIsLive(owner.pid)) return fail("SESSION_BUSY", "Session is owned by another live or unverifiable process");
    const events = log.read(); if (!events.ok) return events; if (hasUnrecordedEffects(events.value, sessionId)) return fail("SESSION_RECOVERY_REQUIRED", "Stale ownership has unrecorded effects and requires reconciliation");
    try { unlinkSync(path); } catch (cause) { return fail("SESSION_BUSY", errorCode(cause) === "ENOENT" ? "Session lease changed while recovering" : "Session lease could not be recovered"); }
    return create();
  }
}
function stableJson(value: Json): string { if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`; if (value !== null && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key]!)}`).join(",")}}`; return JSON.stringify(value); }
function redactedConfig(config: Record<string, Json>): Record<string, Json> { const result: Record<string, Json> = {}; for (const [key, value] of Object.entries(config)) result[key] = redactJson(value, key); return result; }
function redactedDraft(draft: GraphPlanDraft): GraphPlanDraft { return { ...draft, nodes: draft.nodes.map((node) => ({ nodeId: node.nodeId, kind: node.kind, config: redactedConfig(node.config) })), edges: draft.edges.map((edge) => ({ from: edge.from, outcome: edge.outcome, to: edge.to })), limits: { ...draft.limits, ...(draft.limits.continuationPolicy === undefined ? {} : { continuationPolicy: {} }) } }; }
function planContent(draft: GraphPlanDraft): Json { return { planId: draft.planId, version: draft.version, sessionScope: draft.sessionScope, entryNode: draft.entryNode, activationState: draft.activationState, nodes: draft.nodes.map((node) => ({ nodeId: node.nodeId, kind: node.kind, config: node.config })), edges: draft.edges.map((edge) => ({ from: edge.from, outcome: edge.outcome, to: edge.to })), limits: { maxTurns: draft.limits.maxTurns, maxCost: draft.limits.maxCost, maxParallelism: draft.limits.maxParallelism, timeoutMs: draft.limits.timeoutMs, ...(draft.limits.continuationPolicy === undefined ? {} : { continuationPolicy: {} }) } }; }
export function finalizePlan(draft: GraphPlanDraft): GraphPlan { return { ...draft, contentDigest: digest(stableJson(planContent(draft))) }; }
const MAX_PROVIDER_TURNS = 8;
export function defaultPlan(): GraphPlan { return finalizePlan({ planId: "paper-tool-continuation", version: 6, sessionScope: "local", entryNode: "history", activationState: "active", nodes: [{ nodeId: "history", kind: "history_reload", config: {} }, { nodeId: "turn", kind: "provider_turn", config: {} }, { nodeId: "tool", kind: "tool_call", config: {} }, { nodeId: "finish", kind: "finish", config: {} }], edges: [{ from: "history", outcome: "loaded", to: "turn" }, { from: "turn", outcome: "tool-calls", to: "history" }, { from: "turn", outcome: "finished", to: "finish" }], limits: { maxTurns: MAX_PROVIDER_TURNS, maxCost: 0, maxParallelism: 1, timeoutMs: 60_000, continuationPolicy: {} } }); }
const planWithinBounds = (draft: GraphPlanDraft): boolean => Number.isSafeInteger(draft.limits.maxTurns) && draft.limits.maxTurns >= 1 && draft.limits.maxTurns <= MAX_PROVIDER_TURNS && draft.limits.maxParallelism === 1 && Number.isFinite(draft.limits.maxCost) && draft.limits.maxCost >= 0 && Number.isSafeInteger(draft.limits.timeoutMs) && draft.limits.timeoutMs >= 1 && draft.limits.timeoutMs <= 60_000 && (draft.limits.continuationPolicy === undefined || record(draft.limits.continuationPolicy));
export function publishPlan(log: EventLog, sessionId: string, draft: GraphPlanDraft): Result<GraphPlan> { if (!planWithinBounds(draft)) return fail("PLAN_LIMIT_INVALID", `This fake/paper runner requires at most ${MAX_PROVIDER_TURNS} turns, one parallel worker, and a finite timeout`); const plan = finalizePlan(redactedDraft(draft)); const events = log.read(); if (!events.ok) return events; const existing = events.value.find((event): event is EventOfKind<"GraphPlanPublished"> => event.sessionId === sessionId && event.kind === "GraphPlanPublished" && event.data.plan.planId === plan.planId && event.data.plan.version === plan.version); if (existing !== undefined && existing.data.plan.contentDigest !== plan.contentDigest) return fail("PLAN_IMMUTABLE", "A published plan version cannot be changed"); if (existing === undefined) log.append(sessionId, { kind: "GraphPlanPublished", data: { plan } }); return { ok: true, value: plan }; }
export function proposeImprovement(log: EventLog, sessionId: string, draft: GraphPlanDraft): Result<GraphPlan> { if (draft.activationState === "active") return fail("PROPOSAL_UNSAFE", "Proposals cannot activate plans"); if (!planWithinBounds(draft)) return fail("PLAN_LIMIT_INVALID", "Proposals must satisfy fake/paper execution limits"); const plan = finalizePlan(redactedDraft(draft)); log.append(sessionId, { kind: "ImprovementProposed", data: { plan } }); return { ok: true, value: plan }; }
function effectClaimed(events: readonly DurableEvent[], effectId: string): boolean { return events.some((event) => event.kind === "EffectClaimed" && event.data.effectId === effectId); }
function recordEffect(log: EventLog, sessionId: string, effectId: string, state: "succeeded" | "failed", payload: Json): void { log.append(sessionId, { kind: "EffectRecorded", data: { effectId, state, resultDigest: digest(stableJson(redactJson(payload))) } }); }
async function abortProviderIterator(iterator: AsyncIterator<ProviderEvent> | undefined, controller: AbortController): Promise<void> {
  controller.abort();
  if (iterator === undefined || iterator.return === undefined) return;
  await Promise.race([
    Promise.resolve().then(() => iterator.return?.()).then(() => undefined, () => undefined),
    new Promise<void>((resolve) => setTimeout(resolve, 100)),
  ]);
}

type ProviderNext = { kind: "event"; value: IteratorResult<ProviderEvent> } | { kind: "timeout" } | { kind: "aborted" };
async function nextProviderEvent(iterator: AsyncIterator<ProviderEvent>, signal: AbortSignal, remaining: number): Promise<ProviderNext> {
  if (signal.aborted) return { kind: "aborted" };
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<{ kind: "aborted" }>((resolve) => {
    onAbort = () => resolve({ kind: "aborted" });
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([
      iterator.next().then((value) => ({ kind: "event" as const, value })),
      new Promise<{ kind: "timeout" }>((resolve) => { timeout = setTimeout(() => resolve({ kind: "timeout" }), remaining); }),
      aborted,
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    if (onAbort !== undefined) signal.removeEventListener("abort", onAbort);
  }
}

interface ContinuationResume { parentRunId: string; continuationRunId: string; inputEventId: string; plan: GraphPlan; windowIndex: number; }
interface ContinuationHandoff { continuation: true; }
type ExecutionResult = RunResult | ContinuationHandoff;
function pendingContinuation(events: readonly DurableEvent[], sessionId: string): ContinuationResume | undefined {
  const handoffs = events.filter((event): event is EventOfKind<"ContinuationWindowOpened"> => event.sessionId === sessionId && event.kind === "ContinuationWindowOpened");
  const handoff = handoffs.at(-1); if (handoff === undefined) return undefined;
  const handoffIndex = events.indexOf(handoff);
  const parent = events.find((event): event is EventOfKind<"GraphRunStarted"> => event.sessionId === sessionId && event.kind === "GraphRunStarted" && event.data.runId === handoff.data.parentRunId);
  const planEvent = events.find((event): event is EventOfKind<"GraphPlanPublished"> => event.sessionId === sessionId && event.kind === "GraphPlanPublished" && event.data.plan.planId === handoff.data.planId && event.data.plan.version === handoff.data.planVersion && event.data.plan.contentDigest === handoff.data.planDigest);
  const child = events.find((event): event is EventOfKind<"GraphRunStarted"> => event.sessionId === sessionId && event.kind === "GraphRunStarted" && event.data.runId === handoff.data.continuationRunId);
  const childTerminal = events.some((event) => event.sessionId === sessionId && event.kind === "GraphTransition" && event.data.runId === handoff.data.continuationRunId && (event.data.outcome === "finished" || event.data.outcome === "failed"));
  const providerClaim = events.find((event): event is EventOfKind<"EffectClaimed"> => event.sessionId === sessionId && event.kind === "EffectClaimed" && event.data.effectId === handoff.data.providerEffectId);
  const providerRecord = events.find((event): event is EventOfKind<"EffectRecorded"> => event.sessionId === sessionId && event.kind === "EffectRecorded" && event.data.effectId === handoff.data.providerEffectId);
  const toolClaim = events.find((event): event is EventOfKind<"EffectClaimed"> => event.sessionId === sessionId && event.kind === "EffectClaimed" && event.data.effectId === handoff.data.triggerToolEffectId);
  const toolRecord = events.find((event): event is EventOfKind<"EffectRecorded"> => event.sessionId === sessionId && event.kind === "EffectRecorded" && event.data.effectId === handoff.data.triggerToolEffectId);
  const providerTurn = events.find((event): event is EventOfKind<"ProviderTurnStarted"> => event.sessionId === sessionId && event.kind === "ProviderTurnStarted" && event.data.providerCallId === handoff.data.providerCallId && event.data.effectId === handoff.data.providerEffectId);
  const referencesPrecedeHandoff = [parent, planEvent, providerClaim, providerRecord, toolClaim, toolRecord, providerTurn].every((event) => event !== undefined && events.indexOf(event) < handoffIndex);
  const parentPinned = parent?.data.planId === handoff.data.planId && parent.data.planVersion === handoff.data.planVersion && parent.data.planDigest === handoff.data.planDigest && parent.data.inputEventId === handoff.data.originalInputEventId;
  const childPinned = child === undefined || (child.data.planId === handoff.data.planId && child.data.planVersion === handoff.data.planVersion && child.data.planDigest === handoff.data.planDigest && child.data.inputEventId === handoff.data.originalInputEventId);
  const childUntouched = child === undefined || !events.some((event) => event.sessionId === sessionId && event.kind === "ProviderTurnStarted" && event.data.providerCallId.startsWith(`${handoff.data.continuationRunId}:`));
   const toolClaimIndex = toolClaim === undefined ? -1 : events.indexOf(toolClaim); const toolRecordIndex = toolRecord === undefined ? -1 : events.indexOf(toolRecord); const recoverableToolFailure = toolClaimIndex >= 0 && toolRecordIndex > toolClaimIndex && toolRecord?.data.state === "failed" && events.some((event, index) => index > toolClaimIndex && index < toolRecordIndex && event.sessionId === sessionId && event.kind === "ToolFailed");
   const effectsSettled = providerClaim?.data.kind === "provider" && providerRecord?.data.state === "succeeded" && toolClaim?.data.kind === "tool" && (toolRecord?.data.state === "succeeded" || recoverableToolFailure);
   return parent !== undefined && planEvent !== undefined && parentPinned && childPinned && !childTerminal && effectsSettled && referencesPrecedeHandoff && childUntouched ? { parentRunId: handoff.data.parentRunId, continuationRunId: handoff.data.continuationRunId, inputEventId: handoff.data.originalInputEventId, plan: planEvent.data.plan, windowIndex: handoff.data.windowIndex } : undefined;
}

export class Runner { constructor(private readonly log: EventLog, private readonly provider: Provider, private readonly tools: ToolRegistry, private readonly permissions: ReadonlySet<Permission> = new Set(["market:read", "web:read", "shell:read"]), private readonly coordinator = sharedCoordinator, private readonly leases: SessionLeaseFactory = new FileSessionLeaseFactory(), private readonly agentContext = "", private readonly workingDirectory = process.cwd(), private readonly approver?: PermissionApprover, private readonly signal?: AbortSignal, private readonly options: RunnerOptions = {}) {}
  private providerRequest(modelId: string, messages: readonly HistoryMessage[], context: FinanceContext, signal?: AbortSignal): ProviderRequest {
    const stableSystem = [this.agentContext, context.text].filter((value) => value.length > 0).join("\n\n");
    const tools = this.tools.advertised();
    const timestamp = formatLocalTimestamp((this.options.now ?? (() => new Date()))(), this.options.timeZone ?? localIanaTimeZone());
    const dynamicContext = `Request-local timestamp: ${timestamp}. This timestamp was fetched for this request and applies to the latest/final message in the current messages array.`;
    return { providerId: this.provider.providerId, modelId, messages, system: [stableSystem, dynamicContext].filter((value) => value.length > 0).join("\n\n"), tools, ...(signal === undefined ? {} : { signal }) };
  }
async run(sessionId: string): Promise<Result<RunResult>> {
  let outcome: Result<RunResult> = fail("RUNNER_UNSET", "Runner did not execute");
  await this.coordinator.run(sessionId, async () => {
    let continueExecution = true;
    while (continueExecution) {
      const lease = this.leases.acquire(this.log, sessionId);
      if (!lease.ok) { outcome = lease; return; }
      let step: Result<ExecutionResult>;
      try {
        const events = this.log.read();
        if (!events.ok) { outcome = events; return; }
        const continuation = pendingContinuation(events.value, sessionId);
        if (hasUnrecordedEffects(events.value, sessionId) || (hasUnsettledGraphRun(events.value, sessionId) && continuation === undefined)) { outcome = fail("SESSION_RECOVERY_REQUIRED", "Session has an unrecorded effect or unsettled graph run and requires reconciliation"); return; }
        step = continuation === undefined ? await this.drainOne(sessionId) : await this.resumeContinuation(sessionId, continuation);
      } finally { lease.value.release(); }
      if (!step.ok) { outcome = step; return; }
      if ("continuation" in step.value) continue;
      outcome = { ok: true, value: step.value };
      continueExecution = false;
    }
   }); return outcome;
}
  async runBackgroundCallback(sessionId: string, callbackId: string): Promise<Result<void>> {
    let outcome: Result<void> = { ok: true, value: undefined };
    await this.coordinator.run(sessionId, async () => {
      const lease = this.leases.acquire(this.log, sessionId);
      if (!lease.ok) { outcome = lease; return; }
      try {
        const events = this.log.read();
        if (!events.ok) { outcome = events; return; }
         const callback = events.value.find((event): event is EventOfKind<"BackgroundAgentCallback"> => event.sessionId === sessionId && event.kind === "BackgroundAgentCallback" && event.data.callbackId === callbackId);
         const batch = events.value.find((event): event is EventOfKind<"BackgroundAgentBatchCallback"> => event.sessionId === sessionId && event.kind === "BackgroundAgentBatchCallback" && event.data.callbackId === callbackId);
         const delivered = events.value.some((event) => (event.kind === "BackgroundAgentCallbackDelivered" || event.kind === "BackgroundAgentBatchCallbackDelivered") && event.data.callbackId === callbackId);
         const history = projectHistory(events.value, sessionId);
         if ((callback === undefined && batch === undefined) || delivered || !history.some((message) => message.role === "tool" && message.toolCallId === callbackId)) return;
         const callbackEffectPrefix = `callback-${digest(`${sessionId}:${callbackId}`).slice(0, 16)}:provider`;
         const recordedEffects = new Set(events.value.filter((event): event is EventOfKind<"EffectRecorded"> => event.sessionId === sessionId && event.kind === "EffectRecorded").map((event) => event.data.effectId));
         const ambiguousOtherEffect = events.value.some((event) => event.sessionId === sessionId && event.kind === "EffectClaimed" && !recordedEffects.has(event.data.effectId) && event.data.effectId !== callbackEffectPrefix && !event.data.effectId.startsWith(`${callbackEffectPrefix}:`));
         if (ambiguousOtherEffect) { outcome = fail("BACKGROUND_CALLBACK_RECOVERY_REQUIRED", "Background callback delivery is blocked by an ambiguous host provider effect"); return; }
         const consumed = events.value.some((event, startedIndex) => {
           if (event.sessionId !== sessionId || event.kind !== "ProviderTurnStarted") return false;
           const recorded = events.value.find((candidate): candidate is EventOfKind<"EffectRecorded"> => candidate.sessionId === sessionId && candidate.kind === "EffectRecorded" && candidate.data.effectId === event.data.effectId && candidate.data.state === "succeeded");
           if (recorded === undefined) return false;
           const finishedIndex = events.value.findIndex((candidate, index) => index > startedIndex && candidate.sessionId === sessionId && candidate.kind === "ProviderTurnFinished" && candidate.data.providerCallId === event.data.providerCallId && candidate.data.finishReason !== "tool-calls");
           if (finishedIndex < 0) return false;
           const producedText = events.value.slice(startedIndex + 1, finishedIndex).some((candidate) => candidate.sessionId === sessionId && candidate.kind === "ProviderText" && candidate.data.providerCallId === event.data.providerCallId && candidate.data.text.trim().length > 0);
           return producedText && projectHistory(events.value.slice(0, startedIndex), sessionId).some((message) => message.role === "tool" && message.toolCallId === callbackId);
         });
         if (consumed) { this.acknowledgeBackgroundCallback(sessionId, callbackId, callback, batch); return; }
         outcome = await this.executeBackgroundCallback(sessionId, callback, batch, history);
      } finally { lease.value.release(); }
    });
    return outcome;
  }
 private async drainOne(sessionId: string): Promise<Result<ExecutionResult>> {
  const plan = publishPlan(this.log, sessionId, this.options.plan ?? defaultPlan()); if (!plan.ok) return plan; const initial = this.log.read(); if (!initial.ok) return initial; const next = nextInboxItem(initial.value, sessionId); if (next === undefined) return fail("INBOX_EMPTY", "No pending admitted input exists");
    const runId = `run-${digest(`${sessionId}:${next.admittedEventId}`).slice(0, 16)}`; this.log.append(sessionId, { kind: "GraphRunStarted", data: { runId, planId: plan.value.planId, planVersion: plan.value.version, planDigest: plan.value.contentDigest, status: "running", inputEventId: next.admittedEventId } }); this.log.append(sessionId, { kind: "InputPromoted", data: { promptId: next.promptId, delivery: next.delivery, reason: next.delivery === "steer" ? "steer-priority" : "queue-idle" } }); return this.executeWindow(sessionId, plan.value, runId, next.admittedEventId, next.promptId, 0);
}
 private async resumeContinuation(sessionId: string, continuation: ContinuationResume): Promise<Result<ExecutionResult>> {
  const events = this.log.read(); if (!events.ok) return events; const admitted = events.value.find((event): event is EventOfKind<"PromptAdmitted"> => event.id === continuation.inputEventId && event.kind === "PromptAdmitted"); if (admitted === undefined) return fail("JOURNAL_INVALID", "Continuation handoff references a missing admitted input");
     if (!events.value.some((event) => event.sessionId === sessionId && event.kind === "GraphRunStarted" && event.data.runId === continuation.continuationRunId)) { this.log.append(sessionId, { kind: "GraphRunStarted", data: { runId: continuation.continuationRunId, planId: continuation.plan.planId, planVersion: continuation.plan.version, planDigest: continuation.plan.contentDigest, status: "running", inputEventId: continuation.inputEventId } }); }
  return this.executeWindow(sessionId, continuation.plan, continuation.continuationRunId, continuation.inputEventId, admitted.data.promptId, continuation.windowIndex);
}
 private async executeWindow(sessionId: string, plan: GraphPlan, runId: string, inputEventId: string, promptId: string, windowIndex: number): Promise<Result<ExecutionResult>> {
   const context = financeContext(new FixturePaperExchange(), this.permissions, 400); if (!context.ok) return this.terminalFailure(sessionId, runId, plan, "context", context.error); const modelId = this.provider.modelId ?? "fake/finleet"; let lastTurn = 0;
    let pendingToolFailure: FinleetError | undefined;
    let localToolActivityProduced = false;
    for (let turn = 1; turn <= plan.limits.maxTurns; turn += 1) {
       const current = this.log.read(); if (!current.ok) return current; const history = projectHistory(current.value, sessionId); const priorToolFailure = hasPriorToolFailure(current.value, sessionId, inputEventId); const effectId = `${runId}:provider:${turn}`; const providerCallId = `${runId}:turn-${turn}`;
    this.log.append(sessionId, { kind: "GraphTransition", data: { runId, planId: plan.planId, planVersion: plan.version, nodeId: "history", sequence: turn * 2 - 1, outcome: "loaded", inputDigest: digest(stableJson(history.map((message) => ({ role: message.role, content: message.content })))) } });
      if (effectClaimed(current.value, effectId)) return fail("EFFECT_ALREADY_CLAIMED", "A provider effect was already claimed and requires recorded replay"); this.log.append(sessionId, { kind: "EffectClaimed", data: { effectId, kind: "provider", requestDigest: digest(stableJson({ provider: this.provider.providerId, model: modelId, history: history.map((message) => message.content) })), retryPolicy: "recorded-outcome" } }); this.log.append(sessionId, { kind: "ProviderTurnStarted", data: { provider: this.provider.providerId, model: modelId, providerCallId, effectId } });
       let finished: Extract<ProviderEvent, { type: "finished" }> | undefined; let localCalls = false; let localToolCallRequested = false; let providerTextProduced = false; let toolActivityProduced = false; let triggerToolEffectId: string | undefined; const controller = new AbortController(); let iterator: AsyncIterator<ProviderEvent> | undefined; const deadline = { value: Date.now() + plan.limits.timeoutMs }; const abortFromCaller = (): void => controller.abort();
    if (this.signal?.aborted === true) controller.abort(); else this.signal?.addEventListener("abort", abortFromCaller, { once: true });
    try { iterator = this.provider.stream(this.providerRequest(modelId, history, context.value, controller.signal))[Symbol.asyncIterator](); while (true) { const remaining = deadline.value - Date.now(); if (remaining <= 0) return this.terminalFailure(sessionId, runId, plan, providerCallId, { code: "PROVIDER_TIMEOUT", message: "Provider turn exceeded the configured timeout" }, effectId); const next = await nextProviderEvent(iterator, controller.signal, remaining); if (next.kind === "aborted" || controller.signal.aborted) return this.terminalFailure(sessionId, runId, plan, providerCallId, { code: "EXECUTION_ABORTED", message: "Execution was interrupted" }, effectId); if (next.kind === "timeout") return this.terminalFailure(sessionId, runId, plan, providerCallId, { code: "PROVIDER_TIMEOUT", message: "Provider turn exceeded the configured timeout" }, effectId); if (next.value.done) break; const event = next.value.value;
        if (event.type === "text") { const textProduced = this.appendProviderText(sessionId, providerCallId, event.text); providerTextProduced ||= textProduced; }
        else if (event.type === "finished") { finished = event; break; }
          else if (event.type === "local_tool_call") { toolActivityProduced = true; if (this.provider.mode !== "fake") this.log.append(sessionId, { kind: "ToolFailed", data: { callId: event.callId, code: "LOCAL_TOOL_DISPATCH_DEFERRED", message: "Only explicitly local-owned advertised tools may be dispatched" } }); else { localToolCallRequested = true; triggerToolEffectId = toolEffectId(inputEventId, event.callId); const replayedFailure = this.hasRecordedToolFailure(current.value, inputEventId, event.callId); const tool = await this.settleTool(sessionId, inputEventId, runId, providerCallId, event, controller, deadline); if (!tool.ok) return this.terminalFailure(sessionId, runId, plan, providerCallId, tool.error, effectId); if (tool.value === "succeeded") localToolActivityProduced = true; else if (replayedFailure) return this.terminalFailure(sessionId, runId, plan, providerCallId, tool.value.error, effectId); else { pendingToolFailure = tool.value.error; localCalls = true; } } }
       else if (event.execution === "provider") { toolActivityProduced = true; this.log.append(sessionId, { kind: "ToolFailed", data: { callId: event.callId, code: "PROVIDER_TOOL_DEFERRED", message: `Provider-executed tool ${event.name} is not locally dispatched` } }); }
          else { localCalls = true; triggerToolEffectId = toolEffectId(inputEventId, event.callId); const replayedFailure = this.hasRecordedToolFailure(current.value, inputEventId, event.callId); const tool = await this.settleTool(sessionId, inputEventId, runId, providerCallId, { type: "local_tool_call", callId: event.callId, name: event.name, arguments: event.arguments }, controller, deadline); if (!tool.ok) return this.terminalFailure(sessionId, runId, plan, providerCallId, tool.error, effectId); if (tool.value !== "succeeded" && replayedFailure) return this.terminalFailure(sessionId, runId, plan, providerCallId, tool.value.error, effectId); if (tool.value !== "succeeded") pendingToolFailure = tool.value.error; }
    } } catch (cause) { return this.terminalFailure(sessionId, runId, plan, providerCallId, providerFailure(cause), effectId); } finally { this.signal?.removeEventListener("abort", abortFromCaller); await abortProviderIterator(iterator, controller); }
     if (finished === undefined) return this.terminalFailure(sessionId, runId, plan, providerCallId, { code: "PROVIDER_INCOMPLETE", message: "Provider stream ended without a terminal event" }, effectId);
         if (finished.finishReason === "error" || finished.finishReason === "other") return this.terminalFailure(sessionId, runId, plan, providerCallId, { code: "PROVIDER_TERMINAL_ERROR", message: "Provider reported a terminal error" }, effectId);
          if (finished.finishReason === "tool-calls" && localToolCallRequested) localCalls = true;
         if (!providerTextProduced && !localCalls && !toolActivityProduced && !localToolActivityProduced) return this.terminalFailure(sessionId, runId, plan, providerCallId, { code: "PROVIDER_EMPTY_RESPONSE", message: "Provider completed without assistant text or a tool call" }, effectId);
         if (!localCalls && pendingToolFailure !== undefined) pendingToolFailure = undefined;
        if (localCalls && finished.finishReason !== "tool-calls" && (pendingToolFailure === undefined || priorToolFailure)) return this.terminalFailure(sessionId, runId, plan, providerCallId, { code: "PROVIDER_TOOL_CONTINUATION_REQUIRED", message: "A local provider tool call requires a tool-calls terminal event" }, effectId);
          this.log.append(sessionId, { kind: "ProviderTurnFinished", data: { providerCallId, finishReason: finished.finishReason, inputTokens: finished.usage.inputTokens, outputTokens: finished.usage.outputTokens } }); const sealed = sealBackgroundAgentBatches(this.log, sessionId, providerCallId); if (!sealed.ok) return sealed; recordEffect(this.log, sessionId, effectId, "succeeded", { providerCallId }); lastTurn = turn;
        if (!localCalls) { if (providerTextProduced && finished.finishReason !== "tool-calls") this.ackIncludedCallbacks(sessionId, current.value, history); break; }
      if (turn === plan.limits.maxTurns) { if (plan.limits.continuationPolicy === undefined) return this.terminalFailure(sessionId, runId, plan, providerCallId, { code: "PROVIDER_CONTINUATION_DISABLED", message: "Provider requested continuation but the plan does not enable durable continuation" }); if (triggerToolEffectId === undefined) return fail("JOURNAL_INVALID", "Continuation handoff requires a recorded local tool effect"); const nextWindowIndex = windowIndex + 1; const turnsUsedBeforeHandoff = nextWindowIndex * plan.limits.maxTurns; const rootRunId = runId.split(":continuation-", 1)[0] ?? runId; const continuationRunId = `${rootRunId}:continuation-${nextWindowIndex}`; if (!Number.isSafeInteger(nextWindowIndex) || !Number.isSafeInteger(turnsUsedBeforeHandoff) || continuationRunId.length > MAX_EVENT_TEXT) return this.terminalFailure(sessionId, runId, plan, providerCallId, { code: "CONTINUATION_ID_OVERFLOW", message: "Durable continuation identity exceeded its safe representation" }); this.log.append(sessionId, { kind: "ContinuationWindowOpened", data: { parentRunId: runId, continuationRunId, originalInputEventId: inputEventId, planId: plan.planId, planVersion: plan.version, planDigest: plan.contentDigest, windowIndex: nextWindowIndex, turnsUsedBeforeHandoff, providerEffectId: effectId, providerCallId, triggerToolEffectId, reason: "provider-tool-continuation" } }); this.log.append(sessionId, { kind: "GraphRunStarted", data: { runId: continuationRunId, planId: plan.planId, planVersion: plan.version, planDigest: plan.contentDigest, status: "running", inputEventId } }); return { ok: true, value: { continuation: true } }; }
  }
   this.log.append(sessionId, { kind: "GraphTransition", data: { runId, planId: plan.planId, planVersion: plan.version, nodeId: "finish", sequence: lastTurn * 2, outcome: "finished", inputDigest: digest(runId) } }); this.log.append(sessionId, { kind: "TaskConclusion", data: { runId, outcome: "finished", summary: `Task completed after ${lastTurn} provider turn${lastTurn === 1 ? "" : "s"}` } }); const after = this.log.read(); return after.ok ? { ok: true, value: { history: projectHistory(after.value, sessionId), promotedPromptId: promptId, runId } } : after;
}
  private hasRecordedToolFailure(events: readonly DurableEvent[], inputEventId: string, callId: string): boolean {
    const effectId = toolEffectId(inputEventId, callId);
    return events.some((event) => event.kind === "EffectRecorded" && event.data.effectId === effectId && event.data.state === "failed");
  }
  private acknowledgeBackgroundCallback(sessionId: string, callbackId: string, callback: EventOfKind<"BackgroundAgentCallback"> | undefined, batch: EventOfKind<"BackgroundAgentBatchCallback"> | undefined): void {
    if (batch !== undefined) this.log.append(sessionId, { kind: "BackgroundAgentBatchCallbackDelivered", data: { batchId: batch.data.batchId, callbackId } });
    else if (callback !== undefined) this.log.append(sessionId, { kind: "BackgroundAgentCallbackDelivered", data: { agentId: callback.data.agentId, callbackId, parentToolCallId: callback.data.parentToolCallId } });
  }
  private ackIncludedCallbacks(sessionId: string, events: readonly DurableEvent[], history: readonly HistoryMessage[]): void {
    const delivered = new Set(events.filter((event) => event.kind === "BackgroundAgentCallbackDelivered" || event.kind === "BackgroundAgentBatchCallbackDelivered").map((event) => event.data.callbackId));
    const includedCallbacks = new Set(history.filter((message) => message.role === "tool" && message.toolName === "background_agent_callback" && message.toolCallId !== undefined).map((message) => message.toolCallId));
    const includedBatches = new Set(history.filter((message) => message.role === "tool" && message.toolName === "background_agent_batch_callback" && message.toolCallId !== undefined).map((message) => message.toolCallId));
    for (const event of events) if (event.sessionId === sessionId && event.kind === "BackgroundAgentCallback" && includedCallbacks.has(event.data.callbackId) && !delivered.has(event.data.callbackId)) this.log.append(sessionId, { kind: "BackgroundAgentCallbackDelivered", data: { agentId: event.data.agentId, callbackId: event.data.callbackId, parentToolCallId: event.data.parentToolCallId } });
    for (const event of events) if (event.sessionId === sessionId && event.kind === "BackgroundAgentBatchCallback" && includedBatches.has(event.data.callbackId) && !delivered.has(event.data.callbackId)) this.log.append(sessionId, { kind: "BackgroundAgentBatchCallbackDelivered", data: { batchId: event.data.batchId, callbackId: event.data.callbackId } });
  }
   private async executeBackgroundCallback(sessionId: string, callback: EventOfKind<"BackgroundAgentCallback"> | undefined, batch: EventOfKind<"BackgroundAgentBatchCallback"> | undefined, history: readonly HistoryMessage[]): Promise<Result<void>> {
    const context = financeContext(new FixturePaperExchange(), this.permissions, 400); if (!context.ok) return context;
    const modelId = this.provider.modelId ?? "fake/finleet";
     const callbackId = callback?.data.callbackId ?? batch?.data.callbackId;
     if (callbackId === undefined) return fail("BACKGROUND_CALLBACK_MISSING", "Background callback was not found");
     const runId = `callback-${digest(`${sessionId}:${callbackId}`).slice(0, 16)}`;
     const effectPrefix = `${runId}:provider`;
     const current = this.log.read(); if (!current.ok) return current;
     const claims = current.value.filter((event): event is EventOfKind<"EffectClaimed"> => event.sessionId === sessionId && event.kind === "EffectClaimed" && (event.data.effectId === effectPrefix || event.data.effectId.startsWith(`${effectPrefix}:`)));
     for (const claim of claims) {
       const recorded = current.value.find((event): event is EventOfKind<"EffectRecorded"> => event.sessionId === sessionId && event.kind === "EffectRecorded" && event.data.effectId === claim.data.effectId);
       let state = recorded?.data.state;
       if (state === undefined) {
         const started = current.value.find((event): event is EventOfKind<"ProviderTurnStarted"> => event.sessionId === sessionId && event.kind === "ProviderTurnStarted" && event.data.effectId === claim.data.effectId);
         const terminal = started === undefined ? undefined : current.value.find((event): event is EventOfKind<"ProviderTurnFinished"> | EventOfKind<"ProviderTurnFailed"> => event.sessionId === sessionId && (event.kind === "ProviderTurnFinished" || event.kind === "ProviderTurnFailed") && event.data.providerCallId === started.data.providerCallId);
         if (terminal === undefined) return fail("BACKGROUND_CALLBACK_RECOVERY_REQUIRED", "Background callback provider delivery has an ambiguous recorded effect");
         state = terminal.kind === "ProviderTurnFinished" ? "succeeded" : "failed";
         recordEffect(this.log, sessionId, claim.data.effectId, state, { providerCallId: terminal.data.providerCallId });
       }
       if (state === "succeeded") { this.acknowledgeBackgroundCallback(sessionId, callbackId, callback, batch); return { ok: true, value: undefined }; }
     }
     const attempt = claims.length + 1;
     const effectId = `${effectPrefix}:${attempt}`;
     const providerCallId = `${runId}:turn-${attempt}`;
     try {
       this.log.append(sessionId, { kind: "EffectClaimed", data: { effectId, kind: "provider", requestDigest: digest(stableJson({ provider: this.provider.providerId, model: modelId, callbackId })), retryPolicy: "recorded-outcome" } });
       this.log.append(sessionId, { kind: "ProviderTurnStarted", data: { provider: this.provider.providerId, model: modelId, providerCallId, effectId } });
       let finished: Extract<ProviderEvent, { type: "finished" }> | undefined;
       let providerTextProduced = false;
        for await (const event of this.provider.stream(this.providerRequest(modelId, history, context.value, this.signal))) {
         if (event.type === "text") { const textProduced = this.appendProviderText(sessionId, providerCallId, event.text); providerTextProduced ||= textProduced; }
         else if (event.type === "finished") { finished = event; break; }
       }
       if (finished === undefined) { this.log.append(sessionId, { kind: "ProviderTurnFailed", data: { providerCallId, code: "PROVIDER_INCOMPLETE", message: "Callback provider stream ended without a terminal event" } }); recordEffect(this.log, sessionId, effectId, "failed", { code: "PROVIDER_INCOMPLETE" }); return fail("PROVIDER_INCOMPLETE", "Callback provider stream ended without a terminal event"); }
       if (finished.finishReason === "error" || finished.finishReason === "other") { this.log.append(sessionId, { kind: "ProviderTurnFailed", data: { providerCallId, code: "PROVIDER_TERMINAL_ERROR", message: "Callback provider reported a terminal error" } }); recordEffect(this.log, sessionId, effectId, "failed", { code: "PROVIDER_TERMINAL_ERROR" }); return fail("PROVIDER_TERMINAL_ERROR", "Callback provider reported a terminal error"); }
       if (!providerTextProduced || finished.finishReason === "tool-calls") { this.log.append(sessionId, { kind: "ProviderTurnFailed", data: { providerCallId, code: "BACKGROUND_CALLBACK_SYNTHESIS_REQUIRED", message: "Callback provider completed without a final synthesis" } }); recordEffect(this.log, sessionId, effectId, "failed", { code: "BACKGROUND_CALLBACK_SYNTHESIS_REQUIRED" }); return fail("BACKGROUND_CALLBACK_SYNTHESIS_REQUIRED", "Callback provider completed without a final synthesis"); }
       this.log.append(sessionId, { kind: "ProviderTurnFinished", data: { providerCallId, finishReason: finished.finishReason, inputTokens: finished.usage.inputTokens, outputTokens: finished.usage.outputTokens } }); const sealed = sealBackgroundAgentBatches(this.log, sessionId, providerCallId); if (!sealed.ok) return sealed;
       recordEffect(this.log, sessionId, effectId, "succeeded", { providerCallId });
       this.acknowledgeBackgroundCallback(sessionId, callbackId, callback, batch);
       return { ok: true, value: undefined };
    } catch (cause) { const failure = providerFailure(cause); this.log.append(sessionId, { kind: "ProviderTurnFailed", data: { providerCallId, code: failure.code, message: failure.message } }); const sealed = sealBackgroundAgentBatches(this.log, sessionId, providerCallId); if (!sealed.ok) return sealed; recordEffect(this.log, sessionId, effectId, "failed", { code: failure.code }); return fail(failure.code, failure.message); }
  }
   private appendProviderText(sessionId: string, providerCallId: string, text: string): boolean {
     let produced = false;
     for (const chunk of splitProviderText(redactOutputText(text))) {
       produced ||= chunk.trim().length > 0;
       this.log.append(sessionId, { kind: "ProviderText", data: { providerCallId, text: chunk, truncated: false } });
     }
     return produced;
   }
  private async settleTool(sessionId: string, inputEventId: string, runId: string, providerCallId: string, event: Extract<ProviderEvent, { type: "local_tool_call" }>, controller?: AbortController, deadline?: { value: number }): Promise<Result<"succeeded" | { status: "failed"; error: FinleetError }>> {
    const effectId = toolEffectId(inputEventId, event.callId);
   const argumentDigest = digest(stableJson(record(event.arguments) ? sanitizeObject(event.arguments) : "invalid"));
   const requestDigest = digest(stableJson({ name: event.name, callId: event.callId, argumentsDigest: argumentDigest }));
   const events = this.log.read();
   if (!events.ok) return events;
   const claim = events.value.find((candidate): candidate is EventOfKind<"EffectClaimed"> => candidate.kind === "EffectClaimed" && candidate.data.effectId === effectId);
   if (claim !== undefined) {
     if (claim.data.requestDigest !== requestDigest) return fail("TOOL_EFFECT_CONFLICT", "A local tool call reused an effect identity with different arguments");
     const recorded = events.value.find((candidate): candidate is EventOfKind<"EffectRecorded"> => candidate.kind === "EffectRecorded" && candidate.data.effectId === effectId);
     if (recorded === undefined) return fail("TOOL_EFFECT_RECOVERY_REQUIRED", "A local tool effect was already claimed without a recorded outcome");
      if (recorded.data.state === "succeeded") return { ok: true, value: "succeeded" };
      const claimIndex = events.value.indexOf(claim); const recordedIndex = events.value.indexOf(recorded); const failure = events.value.find((candidate, index): candidate is EventOfKind<"ToolFailed"> => index > claimIndex && index < recordedIndex && candidate.sessionId === sessionId && candidate.kind === "ToolFailed" && candidate.data.callId === event.callId);
      return { ok: true, value: { status: "failed", error: failure === undefined ? { code: "LOCAL_TOOL_FAILED", message: "An approved local tool could not complete" } : { code: failure.data.code, message: failure.data.message } } };
   }
      const toolContext: ToolContext = { sessionId, agentId: this.options.agentId ?? "paper-agent", assistantMessageId: runId, providerCallId, toolCallId: event.callId, permissions: this.permissions, ...(controller === undefined ? {} : { signal: controller.signal }), workingDirectory: this.workingDirectory };
    let result: Result<Json> | undefined;
    let preparedTool: { definition: ToolDefinition<unknown, unknown>; input: unknown } | undefined;
    let executionContext = toolContext;
    try {
      const prepared = this.tools.prepare(event.name, event.arguments, toolContext);
      if (!prepared.ok) result = prepared;
      else {
         preparedTool = prepared.value;
          this.log.append(sessionId, { kind: "HarnessThinking", data: { runId, step: conciseIntentTitle(prepared.value.definition.advertisement), text: "The model selected this action to gather evidence for the response." } });
        const advertisedPermission = prepared.value.definition.advertisement.requiredPermission;
        const resolvedRequirement = prepared.value.definition.permissionRequirement === undefined
          ? advertisedPermission === undefined ? undefined : { ok: true as const, value: { requiredPermission: advertisedPermission, scope: `tool:${event.name}`, interactiveRequired: true } }
          : await prepared.value.definition.permissionRequirement(prepared.value.input, toolContext);
        if (resolvedRequirement !== undefined && !resolvedRequirement.ok) result = resolvedRequirement;
        else if (resolvedRequirement !== undefined) {
          const requirement = resolvedRequirement.value;
          if (this.approver === undefined && requirement.interactiveRequired === true) {
            result = fail("TOOL_PERMISSION_REQUIRED", `Interactive approval is required for ${requirement.scope}`);
          } else if (this.approver !== undefined && requirement.interactiveRequired === true) {
            const approvalStarted = Date.now();
            let decision: PermissionDecision;
            try {
                decision = await this.approver({ toolName: event.name, requiredPermission: requirement.requiredPermission, scope: redactOutputText(requirement.scope), scopeKey: digest(requirement.scope), arguments: redactJson(sanitizeValue(event.arguments)), reviewSteps: (requirement.reviewSteps ?? ["Check the tool name and capability", "Review the redacted arguments", "Confirm the request is expected"]).map((step) => redactOutputText(step)), admissionId: inputEventId, ...(this.options.agentId === undefined ? {} : { agentId: this.options.agentId, childSessionId: sessionId }) });
            } finally {
              if (deadline !== undefined) deadline.value += Math.max(0, Date.now() - approvalStarted);
            }
            if (decision.decision === "reject") {
              const feedback = decision.feedback === undefined ? "" : `; feedback: ${bounded(stableJson(redactJson(sanitizeValue(decision.feedback))), MAX_EVENT_TEXT).value}`;
              result = fail("TOOL_PERMISSION_REJECTED", `Permission request rejected${feedback}`);
            } else {
              executionContext = { ...toolContext, approvedPermission: new ApprovalCapability(requirement) };
            }
          }
        }
      }
   } catch { result = fail("TOOL_EXCEPTION", "Tool execution failed unexpectedly"); }
   this.log.append(sessionId, { kind: "ToolCalled", data: { callId: event.callId, name: event.name, argumentsDigest: argumentDigest, arguments: bounded(stableJson(redactJson(sanitizeValue(event.arguments))), MAX_EVENT_TEXT).value } });
   this.log.append(sessionId, { kind: "EffectClaimed", data: { effectId, kind: "tool", requestDigest, retryPolicy: "recorded-outcome" } });
    if (result === undefined && preparedTool !== undefined) result = await this.executePrepared(preparedTool, executionContext, controller, deadline?.value);
   if (result === undefined) result = fail("TOOL_EXCEPTION", "Tool execution failed unexpectedly");
   if (!result.ok) {
     this.log.append(sessionId, { kind: "ToolFailed", data: { callId: event.callId, code: result.error.code, message: bounded(result.error.message, MAX_EVENT_TEXT).value } });
     recordEffect(this.log, sessionId, effectId, "failed", { code: result.error.code });
      return { ok: true, value: { status: "failed", error: result.error } };
   }
   const redacted = stableJson(redactJson(result.value));
   const preview = bounded(redacted, MAX_EVENT_PREVIEW);
    const durableResult = bounded(redacted, effectiveDurableResultLimit(preparedTool?.definition.durableResultLimit));
   this.log.append(sessionId, { kind: "ToolSucceeded", data: { callId: event.callId, preview: preview.value, truncated: preview.truncated, result: durableResult.value, resultTruncated: durableResult.truncated } });
   recordEffect(this.log, sessionId, effectId, "succeeded", result.value);
   return { ok: true, value: "succeeded" };
 }
  private async executePrepared(prepared: { definition: ToolDefinition<unknown, unknown>; input: unknown }, context: ToolContext, controller?: AbortController, deadline?: number): Promise<Result<Json>> {
    try {
      if (context.signal?.aborted === true) return fail("EXECUTION_ABORTED", "Execution was interrupted");
      const execution = this.tools.invokePrepared(prepared, context);
     if (deadline === undefined) return await execution;
     const remaining = deadline - Date.now();
     if (remaining <= 0) { controller?.abort(); return fail("TOOL_TIMEOUT", "Local tool exceeded the configured turn timeout"); }
      let timeout: ReturnType<typeof setTimeout> | undefined;
      let onAbort: (() => void) | undefined;
      const aborted = new Promise<{ kind: "aborted" }>((resolve) => { onAbort = () => resolve({ kind: "aborted" }); context.signal?.addEventListener("abort", onAbort, { once: true }); });
      const raced = await Promise.race([execution.then((value) => ({ kind: "result" as const, value })), new Promise<{ kind: "timeout" }>((resolve) => { timeout = setTimeout(() => resolve({ kind: "timeout" }), remaining); }), aborted]).finally(() => { if (timeout !== undefined) clearTimeout(timeout); if (onAbort !== undefined) context.signal?.removeEventListener("abort", onAbort); });
      if (raced.kind === "timeout") { controller?.abort(); return fail("TOOL_TIMEOUT", "Local tool exceeded the configured turn timeout"); }
      if (raced.kind === "aborted") return fail("EXECUTION_ABORTED", "Execution was interrupted");
     return raced.value;
   } catch { return fail("TOOL_EXCEPTION", "Tool execution failed unexpectedly"); }
 }
 private terminalFailure(sessionId: string, runId: string, plan: GraphPlan, providerCallId: string, failure: FinleetError, effectId?: string): Result<RunResult> { this.log.append(sessionId, { kind: "ProviderTurnFailed", data: { providerCallId, code: failure.code, message: bounded(failure.message, MAX_EVENT_TEXT).value } }); const sealed = sealBackgroundAgentBatches(this.log, sessionId, providerCallId); if (!sealed.ok) return sealed; if (effectId !== undefined) recordEffect(this.log, sessionId, effectId, "failed", { code: failure.code }); const turn = /:turn-(\d+)$/.exec(providerCallId)?.[1]; const sequence = turn === undefined ? 2 : Number(turn) * 2; this.log.append(sessionId, { kind: "GraphTransition", data: { runId, planId: plan.planId, planVersion: plan.version, nodeId: "turn", sequence, outcome: "failed", inputDigest: digest(failure.code) } }); this.log.append(sessionId, { kind: "TaskConclusion", data: { runId, outcome: "failed", summary: `Task failed: ${bounded(failure.message, MAX_EVENT_TEXT).value}` } }); return { ok: false, error: failure }; } }
export function recordedRunForAdmission(log: EventLog, sessionId: string, admissionEventId: string): Result<RecordedRunResult | undefined> {
  const events = log.read(); if (!events.ok) return events;
  const runs = events.value.filter((event): event is EventOfKind<"GraphRunStarted"> => event.sessionId === sessionId && event.kind === "GraphRunStarted" && event.data.inputEventId === admissionEventId);
  const run = runs.at(-1); if (run === undefined) return { ok: true, value: undefined };
  const terminal = events.value.find((event): event is EventOfKind<"GraphTransition"> => event.sessionId === sessionId && event.kind === "GraphTransition" && event.data.runId === run.data.runId && (event.data.outcome === "finished" || event.data.outcome === "failed"));
  if (terminal === undefined) return { ok: true, value: undefined };
  const admitted = events.value.find((event): event is EventOfKind<"PromptAdmitted"> => event.id === admissionEventId && event.kind === "PromptAdmitted");
  return admitted === undefined ? fail("JOURNAL_INVALID", "A graph run references a missing admitted input") : { ok: true, value: { history: projectHistory(events.value, sessionId), promotedPromptId: admitted.data.promptId, runId: run.data.runId, outcome: terminal.data.outcome === "finished" ? "finished" : "failed" } };
}
function sanitizeValue(value: unknown): Json {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map(sanitizeValue);
  if (record(value)) { const result: Record<string, Json> = Object.create(null) as Record<string, Json>; for (const [key, nested] of Object.entries(value)) result[key] = sanitizeValue(nested); return result; }
  return "[UNSUPPORTED]";
}
function sanitizeObject(value: Record<string, unknown>): Json { return sanitizeValue(value); }
export function replay(log: EventLog, sessionId: string): Result<readonly HistoryMessage[]> { const events = log.read(); return events.ok ? { ok: true, value: projectHistory(events.value, sessionId) } : events; }
export interface CatalogModel { provider: string; model: string; displayName: string; }
export function readCatalog(path: string): Result<readonly CatalogModel[]> { let value: unknown; try { value = JSON.parse(readFileSync(path, "utf8")) as unknown; } catch { return fail("CATALOG_INVALID", "Cache must contain valid JSON"); } if (!record(value) || !Array.isArray(value.models)) return fail("CATALOG_INVALID", "Cache requires a models array"); const models: CatalogModel[] = []; for (const item of value.models) { if (!record(item) || typeof item.provider !== "string" || typeof item.model !== "string" || typeof item.displayName !== "string") return fail("CATALOG_INVALID", "Each model requires provider, model, and displayName strings"); models.push({ provider: item.provider, model: item.model, displayName: item.displayName }); } return { ok: true, value: models }; }
export const deferredExtensions: { plugins: readonly PluginContract[]; mcp: readonly McpContract[]; exchange: ExchangeAdapter; provider: ProviderAdapter } = { plugins: [], mcp: [], exchange: { exchangeId: "live-exchange", mode: "deferred" }, provider: { providerId: "live-provider", mode: "deferred" } };

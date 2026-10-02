/** Durable local execution facade. */
import {
  canonicalizePrompt,
  EventLog,
  fail,
  FixturePaperExchange,
  nextInboxItem,
  projectHistory,
  projectLiveBackgroundAgents,
  type DurableEvent,
  type EventOfKind,
  type LiveBackgroundAgent,
  type Result,
} from "./domain.js";
import {
  FakeProvider,
  hasUnrecordedEffects,
  hasUnsettledGraphRun,
  recordedRunForAdmission,
  replay,
  Runner,
  ToolRegistry,
  quoteTool,
  type PermissionApprover,
  type PermissionDecision,
  type PermissionRequest,
  type Provider,
  type ToolDefinition,
} from "./runtime.js";
import {
  CatalogProviderResolver,
  ModelCatalogService,
  OpenAIResponsesResolver,
  type CompatibleFetch,
  type Environment,
  type OpenAiFetch,
} from "./integrations.js";
import type { OAuthFetch } from "./auth.js";
import { obscuraFetchTool } from "./obscura.js";
import { bashTool } from "./bash.js";
import { loadAgentContext } from "./agent-context.js";
import {
  BackgroundAgentScheduler,
  backgroundAgentTools,
  type BackgroundAgentHostDriver,
} from "./background.js";
import type { PromptSubmission, RpcPermissionRequest } from "./rpc-protocol.js";
import { chartTool } from "./components/chart.js";

export interface ServiceResponse {
  exitCode: 0 | 2;
  body: unknown;
}

export interface CoreServiceOptions {
  args: readonly string[];
  environment: Environment;
  openAiFetch: OpenAiFetch;
  compatibleFetch: CompatibleFetch;
  oauthFetch: OAuthFetch;
  workingDirectory?: string;
  signal?: AbortSignal;
  localApprover?: PermissionApprover;
}

interface PendingPermission {
  owner: string;
  sessionId: string;
  effectiveSessionId: string;
  admissionId: string;
  request: PermissionRequest;
  resolve(decision: PermissionDecision): void;
}

interface ActiveRun {
  readonly owner: string;
  readonly generation: number;
  readonly controller: AbortController;
  readonly admissionId: string;
  abortRequested: boolean;
  completion: Promise<ServiceResponse>;
}

interface SessionControl {
  generation: number;
  active?: ActiveRun;
  pumping?: Promise<void>;
  lane?: Promise<void>;
}

const SYSTEM_CONTEXT_CHARS = 400;

const option = (args: readonly string[], name: string): string | undefined => {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
};

const failure = (message: string): ServiceResponse => ({ exitCode: 2, body: { error: message } });

const typedFailure = (code: string, message: string): ServiceResponse => ({
  exitCode: 2,
  body: { error: { code, message } },
});

const delivery = (value: string | undefined): "queue" | "steer" | undefined =>
  value === "queue" || value === "steer" ? value : undefined;

export class CoreService {
  readonly log: EventLog;

  private readonly eventListeners = new Set<(event: DurableEvent) => void>();
  private readonly permissionListeners = new Set<(request: RpcPermissionRequest, owner: string) => void>();
  private readonly pendingPermissions = new Map<string, PendingPermission>();
  private readonly sessionGrants = new Set<string>();
  private readonly jobGrants = new Set<string>();
  private readonly sessionControls = new Map<string, SessionControl>();
  private readonly admissionOwners = new Map<string, string>();
  private readonly admissionAgentContexts = new Map<string, string>();
  private readonly catalogService = new ModelCatalogService();

  constructor(private readonly options: CoreServiceOptions) {
    this.log = new EventLog(
      option(options.args, "--journal") ?? ".finleet/journal.jsonl",
      undefined,
      undefined,
      (event) => this.publishEvent(event),
    );
  }

  events(): Result<readonly DurableEvent[]> {
    return this.log.read();
  }

  listAgents(sessionId: string): Result<readonly LiveBackgroundAgent[]> {
    const events = this.log.read();
    return events.ok ? { ok: true, value: projectLiveBackgroundAgents(events.value, sessionId) } : events;
  }

  replay(sessionId: string) {
    return replay(this.log, sessionId);
  }

  subscribe(
    sessionId: string,
    listener: (event: DurableEvent) => void,
  ): Result<{ snapshot: readonly DurableEvent[]; unsubscribe: () => void }> {
    this.eventListeners.add(listener);
    const events = this.log.read();
    if (!events.ok) {
      this.eventListeners.delete(listener);
      return events;
    }

    return {
      ok: true,
      value: {
        snapshot: events.value.filter((event) => event.sessionId === sessionId),
        unsubscribe: () => this.eventListeners.delete(listener),
      },
    };
  }

  onPermission(listener: (request: RpcPermissionRequest, owner: string) => void): () => void {
    this.permissionListeners.add(listener);
    return () => this.permissionListeners.delete(listener);
  }

  respondPermission(requestId: string, owner: string, decision: PermissionDecision): boolean {
    const pending = this.pendingPermissions.get(requestId);
    if (pending === undefined || pending.owner !== owner) return false;

    this.pendingPermissions.delete(requestId);
    if (decision.decision === "allow-session") {
      this.sessionGrants.add(this.permissionGrant(pending.owner, pending.sessionId, pending.request));
    }
    if (decision.decision === "allow-job") {
      this.jobGrants.add(this.jobGrant(pending.owner, pending.effectiveSessionId, pending.admissionId));
      pending.resolve(decision);
      for (const [otherRequestId, other] of this.pendingPermissions) {
        if (other.owner !== pending.owner || other.effectiveSessionId !== pending.effectiveSessionId || other.admissionId !== pending.admissionId) continue;
        this.pendingPermissions.delete(otherRequestId);
        other.resolve({ decision: "allow-once" });
      }
      return true;
    }
    pending.resolve(decision);
    return true;
  }

  cancel(sessionId: string, owner: string): boolean {
    const active = this.sessionControls.get(sessionId)?.active;
    if (active === undefined || active.owner !== owner) return false;

    active.abortRequested = true;
    active.controller.abort();
    this.cleanupJobPermissions(owner, sessionId, active.admissionId, "Run cancelled");
    this.rejectPendingPermissions(owner, sessionId, "Run cancelled");
    return true;
  }

  closeOwner(owner: string): void {
    this.cleanupJobPermissions(owner, undefined, undefined, "Approval connection closed");
    this.rejectPendingPermissions(owner, undefined, "Approval connection closed");
    for (const [sessionId, control] of this.sessionControls) {
      if (control.active?.owner === owner) {
        control.active.abortRequested = true;
        control.active.controller.abort();
        this.rejectPendingPermissions(owner, sessionId, "Approval connection closed");
      }
    }
  }

  close(): void {
    for (const [requestId, pending] of this.pendingPermissions) {
      this.pendingPermissions.delete(requestId);
      pending.resolve({ decision: "reject", feedback: "Service closed" });
    }
    this.jobGrants.clear();
    for (const control of this.sessionControls.values()) control.active?.controller.abort();

    this.sessionControls.clear();
    this.admissionOwners.clear();
    this.admissionAgentContexts.clear();
    this.eventListeners.clear();
    this.permissionListeners.clear();
  }

  async submit(input: PromptSubmission, owner = "local"): Promise<ServiceResponse> {
    const selectedDelivery = input.delivery ?? delivery(option(this.options.args, "--delivery") ?? "queue");
    if (selectedDelivery === undefined) return failure("Prompt submission is invalid");
    const submission: PromptSubmission = { ...input, delivery: selectedDelivery };
    const control = this.control(input.sessionId);
    const decision = await this.inSubmissionLane(control, async () => {
      const existing = this.matchingAdmission(submission);
      if (existing !== undefined) {
        if (
          selectedDelivery === "steer"
          && control.active?.admissionId === existing.id
          && control.active.owner !== owner
        ) {
          return { response: typedFailure("RUN_ALREADY_ACTIVE", "A prompt is already running for this session") };
        }
        const activeSteerRetry = selectedDelivery === "steer" && control.active !== undefined;
        if (!activeSteerRetry) {
          const prior = this.log.read();
          if (!prior.ok) return { response: failure("Durable journal could not be read") };
          if (hasUnrecordedEffects(prior.value, input.sessionId) || hasUnsettledGraphRun(prior.value, input.sessionId)) {
            return { response: failure("SESSION_RECOVERY_REQUIRED: Session requires reconciliation") };
          }
        }
        const completed = this.completedAdmission(input.sessionId, existing.id);
        return { response: completed ?? this.admittedResponse(input.sessionId, existing.id) };
      }

      if (control.active !== undefined) {
        if (selectedDelivery === "queue" || control.active.owner !== owner) {
          return { response: typedFailure("RUN_ALREADY_ACTIVE", "A prompt is already running for this session") };
        }
      }

      const admitted = await this.admitSubmission(submission, control.active !== undefined);
      if (!admitted.ok) {
        const response = admitted.error.code === "FORMAT_INVALID"
          ? failure(admitted.error.message)
          : typedFailure(admitted.error.code, admitted.error.message);
        return { response };
      }
      this.admissionOwners.set(admitted.value.admission.id, owner);
      this.admissionAgentContexts.set(admitted.value.admission.id, admitted.value.agentContext);

      if (selectedDelivery === "steer" && control.active !== undefined && !control.active.abortRequested) {
        control.active.abortRequested = true;
        control.active.controller.abort();
        this.cleanupJobPermissions(owner, input.sessionId, control.active.admissionId, "Run steered");
        this.rejectPendingPermissions(owner, input.sessionId, "Run steered");
      }
      const pumping = this.pump(input.sessionId);
      if (selectedDelivery === "steer") return { response: this.admittedResponse(input.sessionId, admitted.value.admission.id) };
      return { admissionId: admitted.value.admission.id, pumping, active: control.active };
    });
    if ("response" in decision) return decision.response;

    const active = decision.active;
    if (active?.admissionId === decision.admissionId) return await active.completion;
    await decision.pumping;
    return this.completedAdmission(input.sessionId, decision.admissionId)
      ?? typedFailure("RECORDED_RUN_MISSING", "Prompt execution did not produce a recorded outcome");
  }

  private async runSubmission(
    input: PromptSubmission,
    owner: string,
    signal: AbortSignal,
    admissionId: string,
    agentContext: string,
  ): Promise<ServiceResponse> {
    const selectedDelivery = input.delivery ?? delivery(option(this.options.args, "--delivery") ?? "queue");
    const providerName = option(this.options.args, "--provider");
    if (providerName === undefined || option(this.options.args, "--exchange") !== "paper") {
      return failure("Prompt submission is invalid");
    }
    if (selectedDelivery === undefined || input.prompt.trim().length === 0) {
      return failure("Prompt submission is invalid");
    }
    if (!this.hasSupportedFormat()) return failure("--format must be text or json");

    const responses = providerName === "openai-responses";
    const compatible = providerName !== "fake" && !responses;
    if (responses && !this.hasValidOpenAiResponsesArguments()) {
      return typedFailure(
        "OPENAI_RESPONSES_ARGUMENT_INVALID",
        "OpenAI Responses model or reasoning configuration is invalid",
      );
    }

    const prior = this.log.read();
    if (!prior.ok) return failure("Durable journal could not be read");
    if (hasUnrecordedEffects(prior.value, input.sessionId) || hasUnsettledGraphRun(prior.value, input.sessionId)) {
      return failure("SESSION_RECOVERY_REQUIRED: Session requires reconciliation");
    }

    const admission = prior.value.find((event): event is EventOfKind<"PromptAdmitted"> => event.id === admissionId && event.kind === "PromptAdmitted");
    if (admission === undefined || admission.sessionId !== input.sessionId || admission.data.promptId !== input.promptId || admission.data.prompt !== canonicalizePrompt(input.prompt) || admission.data.delivery !== selectedDelivery) return typedFailure("JOURNAL_INVALID", "Run does not match its durable prompt admission");

    const resolvedProvider = await this.resolveProvider(providerName, responses, compatible);
    if (!resolvedProvider.ok) return typedFailure(resolvedProvider.error.code, resolvedProvider.error.message);

    const completed = this.completedAdmission(input.sessionId, admission.id);
    if (completed !== undefined) return completed;

    const approver = this.approver(owner, input.sessionId);
    const workingDirectory = this.options.workingDirectory ?? process.cwd();
    const entries: [string, ToolDefinition<unknown, unknown>][] = [
      ["fetch_page", obscuraFetchTool()],
      ["bash", bashTool()],
      ["render_chart", chartTool()],
    ];
    if (!responses && !compatible) {
      entries.push(["paper_quote", quoteTool(new FixturePaperExchange())]);
    }

    const childTools = new ToolRegistry(new Map<string, ToolDefinition<unknown, unknown>>([
      ["paper_quote", quoteTool(new FixturePaperExchange())],
    ]));
    let tools: ToolRegistry | undefined;
    const host: BackgroundAgentHostDriver = {
      deliver: async (sessionId, callbackId) => {
        if (tools === undefined) throw new Error("Tools unavailable");
        const callback = new Runner(
          this.log,
          resolvedProvider.value.provider,
          tools,
          undefined,
          undefined,
          undefined,
          agentContext,
          workingDirectory,
          approver,
          signal,
        );
        const result = await callback.runBackgroundCallback(sessionId, callbackId);
        if (!result.ok) throw new Error(result.error.code);
      },
    };
    const scheduler = new BackgroundAgentScheduler(
      this.log,
      resolvedProvider.value.provider,
      childTools,
      approver,
      agentContext,
      workingDirectory,
      host,
      (childSessionId) => this.cleanupJobPermissions(owner, childSessionId, undefined, "Background agent ended"),
    );
    entries.push(...backgroundAgentTools(scheduler));
    tools = new ToolRegistry(new Map(entries));

    const callbacks = scheduler.retryPendingCallbacks(input.sessionId);
    if (!callbacks.ok) return typedFailure(callbacks.error.code, callbacks.error.message);

    const runner = new Runner(
      this.log,
      resolvedProvider.value.provider,
      tools,
      undefined,
      undefined,
      undefined,
      agentContext,
      workingDirectory,
      approver,
      signal,
    );
    const run = await runner.run(input.sessionId);
    return run.ok
      ? {
        exitCode: 0,
        body: {
          admissionEventId: admission.id,
          promotedPromptId: run.value.promotedPromptId,
          history: run.value.history,
          sessionId: input.sessionId,
          mode: "paper-read-only",
        },
      }
      : typedFailure(run.error.code, run.error.message);
  }

  private async resolveProvider(
    providerName: string,
    responses: boolean,
    compatible: boolean,
  ): Promise<Result<{ provider: Provider; contextWindow?: number }>> {
    if (responses) {
      const resolved = await new OpenAIResponsesResolver(
        this.options.environment,
        this.options.openAiFetch,
        this.options.oauthFetch,
        option(this.options.args, "--auth-file"),
      ).resolve();
      return resolved.ok ? { ok: true, value: { provider: resolved.value } } : resolved;
    }
    if (!compatible) return { ok: true, value: { provider: new FakeProvider() } };

    const cache = option(this.options.args, "--cache");
    const model = option(this.options.args, "--model");
    if (cache === undefined || model === undefined || !model.startsWith(`${providerName}/`)) {
      return fail("PROVIDER_CATALOG_REQUIRED", "Catalog provider configuration is invalid");
    }
    const catalog = this.catalogService.read(cache);
    if (!catalog.ok) return catalog;
    const selected = catalog.value.models.find((item) => item.id === model && item.provider === providerName);
    if (selected?.execution === undefined || selected.contextWindow === undefined) {
      return fail("PROVIDER_MODEL_UNAVAILABLE", "Provider model is not executable");
    }
    const resolved = new CatalogProviderResolver(this.options.environment, this.options.compatibleFetch)
      .resolveCatalog(providerName, model, catalog.value);
    return resolved.ok
      ? { ok: true, value: { provider: resolved.value, contextWindow: selected.contextWindow } }
      : resolved;
  }

  private checkContextBudget(
    events: readonly DurableEvent[],
    input: PromptSubmission,
    contextWindow: number,
    agentContext: string,
  ): Result<void> {
    const historyChars = projectHistory(events, input.sessionId)
      .reduce((total, message) => total + message.content.length, 0);
    const toolArgumentChars = events
      .filter((event): event is EventOfKind<"ToolCalled"> => (
        event.sessionId === input.sessionId && event.kind === "ToolCalled"
      ))
      .reduce((total, event) => total + (event.data.arguments?.length ?? 0), 0);
    const projected = historyChars + toolArgumentChars + canonicalizePrompt(input.prompt).length
      + agentContext.length + SYSTEM_CONTEXT_CHARS;
    return projected > contextWindow
      ? fail("CONTEXT_OVERFLOW", "Projected request exceeds the catalog context limit before durable admission")
      : { ok: true, value: undefined };
  }

  private completedAdmission(sessionId: string, admissionId: string): ServiceResponse | undefined {
    const recorded = recordedRunForAdmission(this.log, sessionId, admissionId);
    if (!recorded.ok) return failure("Recorded outcome could not be read");
    if (recorded.value === undefined) return undefined;
    if (recorded.value.outcome === "failed") {
      return {
        exitCode: 2,
        body: {
          error: {
            code: "RECORDED_RUN_FAILED",
            message: "Matching prompt has a recorded failed outcome",
          },
          alreadyComplete: true,
          recordedOutcome: "failed",
        },
      };
    }
    return {
      exitCode: 0,
      body: {
        admissionEventId: admissionId,
        history: recorded.value.history,
        sessionId,
        alreadyComplete: true,
      },
    };
  }

  private admittedResponse(sessionId: string, admissionEventId: string): ServiceResponse {
    return { exitCode: 0, body: { admissionEventId, sessionId, admitted: true } };
  }

  private control(sessionId: string): SessionControl {
    let control = this.sessionControls.get(sessionId);
    if (control === undefined) {
      control = { generation: 0 };
      this.sessionControls.set(sessionId, control);
    }
    return control;
  }

  private async inSubmissionLane<T>(control: SessionControl, action: () => Promise<T>): Promise<T> {
    const prior = control.lane ?? Promise.resolve();
    let release: () => void = () => undefined;
    const holding = new Promise<void>((resolve) => { release = resolve; });
    const lane = prior.then(() => holding);
    control.lane = lane;
    await prior;
    try {
      return await action();
    } finally {
      release();
      if (control.lane === lane) delete control.lane;
    }
  }

  private matchingAdmission(input: PromptSubmission): EventOfKind<"PromptAdmitted"> | undefined {
    const events = this.log.read();
    if (!events.ok) return undefined;
    return events.value.find((event): event is EventOfKind<"PromptAdmitted"> => (
      event.kind === "PromptAdmitted"
      && event.sessionId === input.sessionId
      && event.data.promptId === input.promptId
      && event.data.prompt === canonicalizePrompt(input.prompt)
      && event.data.delivery === input.delivery
    ));
  }

  private async admitSubmission(
    input: PromptSubmission,
    allowActiveRun: boolean,
  ): Promise<Result<{ admission: EventOfKind<"PromptAdmitted">; agentContext: string }>> {
    const selectedDelivery = input.delivery;
    const providerName = option(this.options.args, "--provider");
    if (providerName === undefined || option(this.options.args, "--exchange") !== "paper" || selectedDelivery === undefined || input.prompt.trim().length === 0) return fail("PROMPT_INVALID", "Prompt submission is invalid");
    if (!this.hasSupportedFormat()) return fail("FORMAT_INVALID", "--format must be text or json");
    const responses = providerName === "openai-responses";
    const compatible = providerName !== "fake" && !responses;
    if (responses && !this.hasValidOpenAiResponsesArguments()) return fail("OPENAI_RESPONSES_ARGUMENT_INVALID", "OpenAI Responses model or reasoning configuration is invalid");
    const provider = await this.resolveProvider(providerName, responses, compatible);
    if (!provider.ok) return provider;
    const agentContext = loadAgentContext(this.options.environment, this.options.workingDirectory);
    if (!agentContext.ok) return agentContext;
    const prior = this.log.read();
    if (!prior.ok) return prior;
    if (!allowActiveRun && (hasUnrecordedEffects(prior.value, input.sessionId) || hasUnsettledGraphRun(prior.value, input.sessionId))) return fail("SESSION_RECOVERY_REQUIRED", "Session requires reconciliation");
    const admission = this.log.admit(
      { sessionId: input.sessionId, promptId: input.promptId, prompt: input.prompt, delivery: selectedDelivery },
      provider.value.contextWindow === undefined
        ? undefined
        : (events) => this.checkContextBudget(events, input, provider.value.contextWindow!, agentContext.value),
    );
    if (!admission.ok) return admission;
    return admission.value.kind === "PromptAdmitted"
      ? { ok: true, value: { admission: admission.value, agentContext: agentContext.value } }
      : fail("JOURNAL_INVALID", "Prompt admission did not produce a PromptAdmitted event");
  }

  private pump(sessionId: string): Promise<void> {
    const control = this.control(sessionId);
    if (control.pumping !== undefined) return control.pumping;
    const pumping = this.runPump(sessionId, control);
    control.pumping = pumping;
    void pumping.then(
      () => { if (control.pumping === pumping) delete control.pumping; },
      () => { if (control.pumping === pumping) delete control.pumping; },
    );
    return pumping;
  }

  private async runPump(sessionId: string, control: SessionControl): Promise<void> {
    for (;;) {
      const events = this.log.read();
      if (!events.ok || hasUnrecordedEffects(events.value, sessionId) || hasUnsettledGraphRun(events.value, sessionId)) return;
      const next = nextInboxItem(events.value, sessionId);
      if (next === undefined) return;
      const agentContext = this.admissionAgentContexts.get(next.admittedEventId);
      if (agentContext === undefined) return;
      const controller = new AbortController();
      const active: ActiveRun = {
        owner: this.admissionOwners.get(next.admittedEventId) ?? "local",
        generation: ++control.generation,
        controller,
        admissionId: next.admittedEventId,
        abortRequested: false,
        completion: Promise.resolve(typedFailure("RUN_NOT_STARTED", "Run has not started")),
      };
      control.active = active;
      const signal = this.options.signal === undefined ? controller.signal : AbortSignal.any([this.options.signal, controller.signal]);
      active.completion = this.runSubmission({ prompt: next.prompt, sessionId, promptId: next.promptId, delivery: next.delivery }, active.owner, signal, active.admissionId, agentContext)
        .finally(() => {
          this.admissionAgentContexts.delete(active.admissionId);
          this.cleanupJobPermissions(active.owner, sessionId, active.admissionId);
        });
      await active.completion;
      if (control.active === active) delete control.active;
      const settled = this.log.read();
      if (!settled.ok) return;
      const stillPending = nextInboxItem(settled.value, sessionId);
      if (stillPending?.admittedEventId === active.admissionId) return;
    }
  }

  private approver(owner: string, sessionId: string): PermissionApprover {
    return async (request) => {
      if (this.options.args.includes("--allow-all-permissions")) {
        return { decision: "allow-session" };
      }
      const effectiveSessionId = request.childSessionId ?? sessionId;
      if (this.jobGrants.has(this.jobGrant(owner, effectiveSessionId, request.admissionId))) return { decision: "allow-once" };
      if (owner === "local" && this.options.localApprover !== undefined) {
        const decision = await this.options.localApprover(request);
        if (decision.decision === "allow-job") this.jobGrants.add(this.jobGrant(owner, effectiveSessionId, request.admissionId));
        return decision;
      }
      if (this.sessionGrants.has(this.permissionGrant(owner, sessionId, request))) {
        return { decision: "allow-session" };
      }

      const requestId = crypto.randomUUID();
      const wire: RpcPermissionRequest = {
        requestId,
        admissionId: request.admissionId,
        toolName: request.toolName,
        requiredPermission: request.requiredPermission,
        scope: request.scope,
        arguments: request.arguments,
        reviewSteps: request.reviewSteps,
        ...(request.agentId === undefined ? {} : { agentId: request.agentId }),
        ...(request.childSessionId === undefined ? {} : { childSessionId: request.childSessionId }),
      };
      return new Promise((resolve) => {
        this.pendingPermissions.set(requestId, { owner, sessionId, effectiveSessionId, admissionId: request.admissionId, request, resolve });
        for (const listener of this.permissionListeners) listener(wire, owner);
      });
    };
  }

  private hasSupportedFormat(): boolean {
    const format = option(this.options.args, "--format");
    return format === undefined || format === "json" || format === "text";
  }

  private hasValidOpenAiResponsesArguments(): boolean {
    return option(this.options.args, "--model") === "gpt-5.6-luna"
      && option(this.options.args, "--reasoning-effort") === "high";
  }

  private permissionGrant(owner: string, sessionId: string, request: PermissionRequest): string {
    return JSON.stringify([owner, sessionId, request.requiredPermission, request.scopeKey ?? request.scope]);
  }

  private jobGrant(owner: string, effectiveSessionId: string, admissionId: string): string {
    return JSON.stringify([owner, effectiveSessionId, admissionId]);
  }

  private cleanupJobPermissions(owner: string, effectiveSessionId?: string, admissionId?: string, feedback = "Run ended"): void {
    for (const grant of this.jobGrants) {
      const parsed: unknown = JSON.parse(grant);
      if (!Array.isArray(parsed) || parsed[0] !== owner || (effectiveSessionId !== undefined && parsed[1] !== effectiveSessionId) || (admissionId !== undefined && parsed[2] !== admissionId)) continue;
      this.jobGrants.delete(grant);
    }
    for (const [requestId, pending] of this.pendingPermissions) {
      if (pending.owner !== owner || (effectiveSessionId !== undefined && pending.effectiveSessionId !== effectiveSessionId) || (admissionId !== undefined && pending.admissionId !== admissionId)) continue;
      this.pendingPermissions.delete(requestId);
      pending.resolve({ decision: "reject", feedback });
    }
  }

  private rejectPendingPermissions(owner: string, sessionId: string | undefined, feedback: string): void {
    for (const [requestId, pending] of this.pendingPermissions) {
      if (pending.owner !== owner || (sessionId !== undefined && pending.sessionId !== sessionId)) continue;
      this.pendingPermissions.delete(requestId);
      pending.resolve({ decision: "reject", feedback });
    }
  }

  private publishEvent(event: DurableEvent): void {
    for (const listener of this.eventListeners) listener(event);
  }
}

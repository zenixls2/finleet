/** Typed JSON-RPC client consumed by the terminal UI. */
import WebSocket from "ws";
import type { DurableEvent, LiveBackgroundAgent, LiveBackgroundAgentStatus, PromptSubmission, RpcPermissionRequest, RpcResponse } from "finleet-core";

export type TuiPermissionRequest = Omit<RpcPermissionRequest, "admissionId"> & { admissionId?: string };
export type TuiPermissionDecision =
  | { decision: "allow-once" | "allow-job" | "allow-session" }
  | { decision: "reject"; feedback?: string };

export interface TuiClient {
  subscribe(sessionId: string): Promise<readonly DurableEvent[]>;
  listAgents(sessionId: string): Promise<readonly LiveBackgroundAgent[]>;
  submit(input: PromptSubmission): Promise<{ exitCode: 0 | 2; body: unknown }>;
  cancel(sessionId: string): Promise<boolean>;
  respondPermission(requestId: string, decision: TuiPermissionDecision): Promise<void>;
  onEvent(listener: (event: DurableEvent) => void): () => void;
  onPermission(listener: (request: TuiPermissionRequest) => void): () => void;
  close(): Promise<void>;
}

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
}

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isDurableEvent = (value: unknown): value is DurableEvent =>
  record(value) && typeof value.id === "string" && typeof value.sessionId === "string" && typeof value.kind === "string";

const isLiveStatus = (value: unknown): value is LiveBackgroundAgentStatus => value === "queued" || value === "running" || value === "waiting_approval";
const isLiveBackgroundAgent = (value: unknown): value is LiveBackgroundAgent => record(value) && Object.keys(value).length === 4 && typeof value.index === "number" && Number.isSafeInteger(value.index) && value.index > 0 && typeof value.agentId === "string" && typeof value.childSessionId === "string" && isLiveStatus(value.status);

export class WebSocketTuiClient implements TuiClient {
  private readonly socket: WebSocket;
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly seenEvents = new Set<string>();
  private readonly events = new Set<(event: DurableEvent) => void>();
  private readonly permissions = new Set<(request: TuiPermissionRequest) => void>();
  private readonly subscriptionEvents = new Map<string, DurableEvent[]>();

  private constructor(url: string, token: string) {
    this.socket = new WebSocket(url, {
      headers: { "x-finleet-token": token },
      perMessageDeflate: false,
      maxPayload: 64 * 1024,
    });
    this.socket.on("message", (raw) => this.receive(raw.toString()));
    this.socket.on("close", () => this.failPending());
    this.socket.on("error", () => this.failPending());
  }

  static async connect(url: string, token: string): Promise<WebSocketTuiClient> {
    const client = new WebSocketTuiClient(url, token);
    await new Promise<void>((resolve, reject) => {
      client.socket.once("open", resolve);
      client.socket.once("error", () => reject(new Error("Local core service connection failed")));
    });
    return client;
  }

  onEvent(listener: (event: DurableEvent) => void): () => void {
    this.events.add(listener);
    return () => this.events.delete(listener);
  }

  onPermission(listener: (request: TuiPermissionRequest) => void): () => void {
    this.permissions.add(listener);
    return () => this.permissions.delete(listener);
  }

  async subscribe(sessionId: string): Promise<readonly DurableEvent[]> {
    const buffered: DurableEvent[] = [];
    this.subscriptionEvents.set(sessionId, buffered);
    let result: unknown;
    try {
      result = await this.call("session.subscribe", { sessionId });
    } finally {
      this.subscriptionEvents.delete(sessionId);
    }
    if (!record(result) || !Array.isArray(result.events)) return [];

    const snapshot = result.events.filter(isDurableEvent).filter((event) => !this.seenEvents.has(event.id));
    for (const event of snapshot) this.seenEvents.add(event.id);
    return [...snapshot, ...buffered.filter((event) => !snapshot.some((candidate) => candidate.id === event.id))];
  }

  async listAgents(sessionId: string): Promise<readonly LiveBackgroundAgent[]> {
    const result = await this.call("agent.list", { sessionId });
    return record(result) && Array.isArray(result.agents) ? result.agents.filter(isLiveBackgroundAgent) : [];
  }

  async submit(input: PromptSubmission): Promise<{ exitCode: 0 | 2; body: unknown }> {
    const result = await this.call("prompt.submit", input);
    if (!record(result) || (result.exitCode !== 0 && result.exitCode !== 2)) {
      return { exitCode: 2, body: "Prompt execution failed" };
    }
    return { exitCode: result.exitCode, body: result.body };
  }

  async cancel(sessionId: string): Promise<boolean> {
    const result = await this.call("run.cancel", { sessionId });
    return record(result) && result.cancelled === true;
  }

  async respondPermission(requestId: string, decision: TuiPermissionDecision): Promise<void> {
    await this.call("permission.respond", { requestId, ...decision });
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => {
      if (this.socket.readyState === WebSocket.CLOSED) {
        resolve();
        return;
      }
      this.socket.once("close", resolve);
      this.socket.close();
    });
  }

  private call(
    method: "session.subscribe" | "agent.list" | "prompt.submit" | "run.cancel" | "permission.respond",
    params: unknown,
  ): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }), { compress: false });
      } catch {
        this.pending.delete(id);
        reject(new Error("Local core service request failed"));
      }
    });
  }

  private receive(raw: string): void {
    let value: unknown;
    try {
      value = JSON.parse(raw) as unknown;
    } catch {
      return;
    }
    if (!record(value)) return;

    if (value.method === "event.appended" && record(value.params) && isDurableEvent(value.params.event)) {
      this.notifyEvent(value.params.event);
      return;
    }
    if (value.method === "permission.requested" && record(value.params) && typeof value.params.requestId === "string") {
      for (const listener of this.permissions) listener(value.params as unknown as TuiPermissionRequest);
      return;
    }

    const response = value as unknown as RpcResponse;
    if (typeof response.id !== "number") return;
    const pending = this.pending.get(response.id);
    if (pending === undefined) return;
    this.pending.delete(response.id);
    if (response.error !== undefined) pending.reject(new Error(response.error.message));
    else pending.resolve(response.result ?? null);
  }

  private notifyEvent(event: DurableEvent): void {
    if (this.seenEvents.has(event.id)) return;
    this.seenEvents.add(event.id);
    const buffered = this.subscriptionEvents.get(event.sessionId);
    if (buffered !== undefined) buffered.push(event);
    for (const listener of this.events) listener(event);
  }

  private failPending(): void {
    for (const pending of this.pending.values()) {
      pending.reject(new Error("Local core service connection closed"));
    }
    this.pending.clear();
  }
}

import type { DurableEvent, Json, Permission } from "./domain.js";

export const RPC_MAX_BYTES = 8 * 1024 * 1024;
const RPC_MAX_JSON_DEPTH = 64;

export type RpcId = string | number;
export type RpcMethod =
  | "session.subscribe"
  | "agent.list"
  | "prompt.submit"
  | "run.cancel"
  | "permission.respond"
  | "service.ping";

export interface RpcRequest {
  jsonrpc: "2.0";
  id: RpcId;
  method: RpcMethod;
  params?: unknown;
}

export interface RpcResponse {
  jsonrpc: "2.0";
  id: RpcId;
  result?: unknown;
  error?: { code: number; message: string };
}

export interface RpcNotification {
  jsonrpc: "2.0";
  method: "event.appended" | "permission.requested";
  params: unknown;
}

export interface RpcPermissionRequest {
  requestId: string;
  admissionId: string;
  toolName: string;
  requiredPermission: Permission;
  scope: string;
  arguments: Json;
  reviewSteps: readonly string[];
  agentId?: string;
  childSessionId?: string;
}

export interface PromptSubmission {
  prompt: string;
  sessionId: string;
  promptId: string;
  /** Omitted only for the legacy TUI producer; it defaults to queue. */
  delivery?: "queue" | "steer";
}

export interface SessionReference {
  sessionId: string;
}

const METHODS: ReadonlySet<string> = new Set([
  "session.subscribe",
  "agent.list",
  "prompt.submit",
  "run.cancel",
  "permission.respond",
  "service.ping",
]);

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const json = (value: unknown): value is Json => {
  const pending: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) break;
    const candidate = current.value;
    if (candidate === null || typeof candidate === "string" || typeof candidate === "number" || typeof candidate === "boolean") continue;
    if (!Array.isArray(candidate) && !record(candidate)) return false;
    if (current.depth >= RPC_MAX_JSON_DEPTH) return false;
    for (const child of Array.isArray(candidate) ? candidate : Object.values(candidate)) {
      pending.push({ value: child, depth: current.depth + 1 });
    }
  }
  return true;
};

const bounded = (value: unknown, limit: number): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= limit;

export function parseRpcRequest(value: unknown): RpcRequest | undefined {
  if (!record(value) || value.jsonrpc !== "2.0") return undefined;
  if (typeof value.id !== "string" && typeof value.id !== "number") return undefined;
  if (typeof value.id === "number" && !Number.isFinite(value.id)) return undefined;
  if (typeof value.method !== "string" || !METHODS.has(value.method)) return undefined;
  if (value.params !== undefined && !json(value.params)) return undefined;

  const method = value.method as RpcMethod;
  return value.params === undefined
    ? { jsonrpc: "2.0", id: value.id, method }
    : { jsonrpc: "2.0", id: value.id, method, params: value.params };
}

export function parseSubscription(value: unknown): SessionReference | undefined {
  if (!record(value) || !bounded(value.sessionId, 160)) return undefined;
  return Object.keys(value).length === 1 ? { sessionId: value.sessionId } : undefined;
}

export const parseRunCancellation = parseSubscription;
export const parseAgentList = parseSubscription;

export function parsePromptSubmission(value: unknown): PromptSubmission | undefined {
  if (!record(value)) return undefined;
  if (!bounded(value.prompt, 512) || !bounded(value.sessionId, 160) || !bounded(value.promptId, 160)) return undefined;
  if (value.delivery !== undefined && value.delivery !== "queue" && value.delivery !== "steer") return undefined;
  if (Object.keys(value).some((key) => key !== "prompt" && key !== "sessionId" && key !== "promptId" && key !== "delivery")) return undefined;
  return {
    prompt: value.prompt,
    sessionId: value.sessionId,
    promptId: value.promptId,
    ...(value.delivery === undefined ? {} : { delivery: value.delivery }),
  };
}

export function parsePermissionResponse(value: unknown): {
  requestId: string;
  decision: "allow-once" | "allow-job" | "allow-session" | "reject";
  feedback?: string;
} | undefined {
  if (!record(value) || !bounded(value.requestId, 160)) return undefined;
  if (value.decision !== "allow-once" && value.decision !== "allow-job" && value.decision !== "allow-session" && value.decision !== "reject") return undefined;
  if (Object.keys(value).some((key) => key !== "requestId" && key !== "decision" && key !== "feedback")) return undefined;
  if (value.feedback !== undefined && (!bounded(value.feedback, 160) || value.decision !== "reject")) return undefined;

  return {
    requestId: value.requestId,
    decision: value.decision,
    ...(typeof value.feedback === "string" ? { feedback: value.feedback } : {}),
  };
}

export const rpcResult = (id: RpcId, result: unknown): RpcResponse => ({ jsonrpc: "2.0", id, result });
export const rpcError = (id: RpcId, code: number, message: string): RpcResponse => ({ jsonrpc: "2.0", id, error: { code, message } });
export const eventNotification = (event: DurableEvent): RpcNotification => ({ jsonrpc: "2.0", method: "event.appended", params: { event } });

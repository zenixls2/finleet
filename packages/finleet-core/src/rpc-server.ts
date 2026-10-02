/** Loopback JSON-RPC transport for a CoreService. */
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import { CoreService } from "./core-service.js";
import {
  eventNotification,
  parseAgentList,
  parsePermissionResponse,
  parsePromptSubmission,
  parseRpcRequest,
  parseRunCancellation,
  parseSubscription,
  RPC_MAX_BYTES,
  rpcError,
  rpcResult,
  type RpcNotification,
  type RpcResponse,
} from "./rpc-protocol.js";

interface Connection {
  id: string;
  socket: WebSocket;
  subscriptions: Map<string, () => void>;
  seenEvents: Set<string>;
  queued: number;
}

const serialize = (value: RpcResponse | RpcNotification): string => JSON.stringify(value);

const loopback = (address: string | undefined): boolean =>
  address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";

const validToken = (received: string | undefined, token: string): boolean => {
  if (received === undefined) return false;
  const receivedBytes = Buffer.from(received);
  const tokenBytes = Buffer.from(token);
  return receivedBytes.length === tokenBytes.length && timingSafeEqual(receivedBytes, tokenBytes);
};

export class RpcServer {
  readonly token = randomBytes(32).toString("base64url");

  private readonly http = createServer();
  private readonly ws = new WebSocketServer({
    noServer: true,
    perMessageDeflate: false,
    maxPayload: RPC_MAX_BYTES,
  });
  private readonly connections = new Set<Connection>();
  private readonly removePermissionListener: () => void;

  constructor(readonly service: CoreService) {
    this.http.on("upgrade", (request, socket, head) => this.upgrade(request, socket, head));
    this.ws.on("connection", (socket) => this.connected(socket));
    this.removePermissionListener = service.onPermission((request, owner) => {
      const connection = [...this.connections].find((candidate) => candidate.id === owner);
      if (connection !== undefined) this.send(connection, {
        jsonrpc: "2.0",
        method: "permission.requested",
        params: request,
      });
    });
  }

  async start(): Promise<{ url: string; token: string }> {
    await new Promise<void>((resolve, reject) => {
      this.http.once("error", reject);
      this.http.listen(0, "127.0.0.1", () => {
        this.http.off("error", reject);
        resolve();
      });
    });
    const address = this.http.address();
    if (address === null || typeof address === "string") {
      throw new Error("Loopback service did not receive a TCP port");
    }
    return { url: `ws://127.0.0.1:${String(address.port)}`, token: this.token };
  }

  async close(): Promise<void> {
    this.removePermissionListener();
    for (const connection of [...this.connections]) this.closeConnection(connection);
    await new Promise<void>((resolve) => this.ws.close(() => resolve()));
    await new Promise<void>((resolve) => this.http.close(() => resolve()));
  }

  private upgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    const header = request.headers["x-finleet-token"];
    const token = typeof header === "string" ? header : undefined;
    if (!loopback(request.socket.remoteAddress) || !validToken(token, this.token)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    this.ws.handleUpgrade(request, socket, head, (connection) => {
      this.ws.emit("connection", connection, request);
    });
  }

  private connected(socket: WebSocket): void {
    const connection: Connection = {
      id: randomUUID(),
      socket,
       subscriptions: new Map(),
      seenEvents: new Set(),
      queued: 0,
    };
    this.connections.add(connection);
    socket.on("message", (raw) => this.message(connection, raw.toString()));
    socket.once("close", () => this.closeConnection(connection));
    socket.on("error", () => this.closeConnection(connection));
  }

  private send(connection: Connection, payload: RpcResponse | RpcNotification): void {
    if (connection.socket.readyState !== WebSocket.OPEN) return;
    if (connection.queued >= 128 || connection.socket.bufferedAmount > RPC_MAX_BYTES * 4) {
      connection.socket.close(1013, "Slow client");
      return;
    }

    connection.queued += 1;
    connection.socket.send(serialize(payload), { compress: false }, () => {
      connection.queued = Math.max(0, connection.queued - 1);
    });
  }

  private message(connection: Connection, raw: string): void {
    if (Buffer.byteLength(raw, "utf8") > RPC_MAX_BYTES) {
      connection.socket.close(1009, "Message too large");
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      this.send(connection, rpcError("invalid", -32700, "Invalid JSON-RPC request"));
      return;
    }
    let request;
    try {
      request = parseRpcRequest(parsed);
    } catch {
      this.send(connection, rpcError("invalid", -32600, "Invalid JSON-RPC request"));
      return;
    }
    if (request === undefined) {
      this.send(connection, rpcError("invalid", -32600, "Invalid JSON-RPC request"));
      return;
    }

    switch (request.method) {
      case "service.ping":
        this.send(connection, rpcResult(request.id, { ok: true }));
        return;
      case "session.subscribe":
        this.subscribe(connection, request.id, request.params);
        return;
      case "agent.list":
        this.listAgents(connection, request.id, request.params);
        return;
      case "prompt.submit":
        this.submit(connection, request.id, request.params);
        return;
      case "run.cancel":
        this.cancel(connection, request.id, request.params);
        return;
      case "permission.respond":
        this.respondPermission(connection, request.id, request.params);
        return;
    }
  }

  private subscribe(connection: Connection, id: string | number, params: unknown): void {
    const subscriptionParams = parseSubscription(params);
    if (subscriptionParams === undefined) {
      this.send(connection, rpcError(id, -32602, "Invalid request parameters"));
      return;
    }

    if (connection.subscriptions.has(subscriptionParams.sessionId)) {
      const events = this.service.events();
      if (!events.ok) {
        this.send(connection, rpcError(id, -32000, "Session is unavailable"));
        return;
      }
      const snapshot = events.value.filter((event) => event.sessionId === subscriptionParams.sessionId);
      for (const event of snapshot) connection.seenEvents.add(event.id);
      this.send(connection, rpcResult(id, { events: snapshot }));
      return;
    }

    const subscription = this.service.subscribe(subscriptionParams.sessionId, (event) => {
      if (event.sessionId !== subscriptionParams.sessionId || connection.seenEvents.has(event.id)) return;
      connection.seenEvents.add(event.id);
      this.send(connection, eventNotification(event));
    });
    if (!subscription.ok) {
      this.send(connection, rpcError(id, -32000, "Session is unavailable"));
      return;
    }

    connection.subscriptions.set(subscriptionParams.sessionId, subscription.value.unsubscribe);
    for (const event of subscription.value.snapshot) connection.seenEvents.add(event.id);
    this.send(connection, rpcResult(id, { events: subscription.value.snapshot }));
  }

  private listAgents(connection: Connection, id: string | number, params: unknown): void {
    const request = parseAgentList(params);
    if (request === undefined) {
      this.send(connection, rpcError(id, -32602, "Invalid request parameters"));
      return;
    }
    const agents = this.service.listAgents(request.sessionId);
    if (!agents.ok) {
      this.send(connection, rpcError(id, -32000, "Session is unavailable"));
      return;
    }
    this.send(connection, rpcResult(id, { agents: agents.value }));
  }

  private submit(connection: Connection, id: string | number, params: unknown): void {
    const submission = parsePromptSubmission(params);
    if (submission === undefined) {
      this.send(connection, rpcError(id, -32602, "Invalid request parameters"));
      return;
    }

    void this.service.submit(submission, connection.id).then(
      (response) => this.send(connection, rpcResult(id, { exitCode: response.exitCode, body: response.body })),
      () => this.send(connection, rpcError(id, -32000, "Prompt execution failed")),
    );
  }

  private cancel(connection: Connection, id: string | number, params: unknown): void {
    const cancellation = parseRunCancellation(params);
    if (cancellation === undefined) {
      this.send(connection, rpcError(id, -32602, "Invalid request parameters"));
      return;
    }
    this.send(connection, rpcResult(id, {
      cancelled: this.service.cancel(cancellation.sessionId, connection.id),
    }));
  }

  private respondPermission(connection: Connection, id: string | number, params: unknown): void {
    const response = parsePermissionResponse(params);
    if (response === undefined) {
      this.send(connection, rpcError(id, -32602, "Invalid request parameters"));
      return;
    }
    const decision = response.decision === "reject"
      ? { decision: "reject" as const, ...(response.feedback === undefined ? {} : { feedback: response.feedback }) }
      : { decision: response.decision };
    if (!this.service.respondPermission(response.requestId, connection.id, decision)) {
      this.send(connection, rpcError(id, -32602, "Unknown permission request"));
      return;
    }
    this.send(connection, rpcResult(id, { accepted: true }));
  }

  private closeConnection(connection: Connection): void {
    if (!this.connections.delete(connection)) return;
    for (const unsubscribe of connection.subscriptions.values()) unsubscribe();
    connection.subscriptions.clear();
    this.service.closeOwner(connection.id);
  }
}

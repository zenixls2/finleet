import { randomUUID } from "node:crypto";
import { createReadStream, type Stats } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, type ChildProcess } from "node:child_process";
import { WebSocket, WebSocketServer } from "ws";

const MAX_MESSAGE_BYTES = 64 * 1024;
const MAX_CLIENTS = 8;
const MAX_REQUESTS_PER_SECOND = 30;
const HANDSHAKE_BYTES = 1024;
const PUBLIC_DIR = fileURLToPath(new URL("../public/", import.meta.url));
const CONVERSATION_MODULE = fileURLToPath(new URL("./conversation.js", import.meta.url));
const CORE_CLI = fileURLToPath(new URL("../../finleet-core/dist/cli.js", import.meta.url));
export const WEB_USAGE = "Usage: finleet-web [--port <0-65535>] [--session <id>] [core serve options]";
type RpcMethod = "session.subscribe" | "agent.list" | "prompt.submit" | "run.cancel" | "permission.respond" | "service.ping";
const METHODS = new Set<RpcMethod>(["session.subscribe", "agent.list", "prompt.submit", "run.cancel", "permission.respond", "service.ping"]);
const MIME: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml" };

export interface WebOptions {
  readonly port: number;
  readonly sessionId: string;
  readonly coreArgs: readonly string[];
}

export const parseWebOptions = (args: readonly string[]): WebOptions => {
  let port = 4173;
  let sessionId: string = randomUUID();
  const coreArgs: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === undefined) continue;
    if (argument === "--port") {
      const value = Number(args[index + 1]);
      if (!Number.isInteger(value) || value < 0 || value > 65535) throw new Error("--port must be an integer from 0 to 65535");
      port = value;
      index += 1;
    } else if (argument === "--session") {
      const value = args[index + 1];
      if (value === undefined || value.length === 0 || value.length > 160) throw new Error("--session must be between 1 and 160 characters");
      sessionId = value;
      index += 1;
    } else if (argument === "--provider") {
      const value = args[index + 1];
      if (value === undefined) coreArgs.push(argument);
      else {
        coreArgs.push(argument, value === "gpt-5.6-luna" ? "openai-responses" : value);
        index += 1;
      }
    } else if (argument === "--provider=gpt-5.6-luna") {
      coreArgs.push("--provider", "openai-responses");
    } else if (argument === "--help") {
      throw new Error(WEB_USAGE);
    } else {
      coreArgs.push(argument);
    }
  }
  return { port, sessionId, coreArgs };
};

interface Endpoint { readonly url: string; readonly token: string; }
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const parseEndpoint = (line: string): Endpoint => {
  if (Buffer.byteLength(line, "utf8") > HANDSHAKE_BYTES) throw new Error("Core endpoint handshake exceeded its bound");
  const value: unknown = JSON.parse(line);
  if (!isRecord(value) || typeof value.url !== "string" || typeof value.token !== "string" || value.token.length < 32 || value.token.length > 128) throw new Error("Core emitted an invalid endpoint handshake");
  const url = new URL(value.url);
  if (url.protocol !== "ws:" || url.hostname !== "127.0.0.1" || url.port.length === 0 || url.pathname !== "/" || url.search !== "" || url.hash !== "") throw new Error("Core endpoint must be loopback-only");
  return { url: value.url, token: value.token };
};

const startCore = async (args: readonly string[]): Promise<{ endpoint: Endpoint; child: ChildProcess }> => {
  const child = spawn(process.execPath, [CORE_CLI, "serve", ...args], { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"], shell: false });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => { stderr = `${stderr}${chunk}`.slice(-4096); });
  const endpoint = await new Promise<Endpoint>((resolveEndpoint, reject) => {
    let stdout = "";
    const timeout = setTimeout(() => reject(new Error(`Core startup timed out${stderr.length ? `: ${stderr}` : ""}`)), 10_000);
    child.once("error", () => reject(new Error("Unable to start core service")));
    child.once("exit", (code) => reject(new Error(`Core exited before startup (${String(code)})${stderr.length ? `: ${stderr}` : ""}`)));
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      const newline = stdout.indexOf("\n");
      if (Buffer.byteLength(stdout, "utf8") > HANDSHAKE_BYTES || newline >= 0 && newline !== stdout.length - 1) {
        clearTimeout(timeout);
        reject(new Error("Core emitted an invalid endpoint handshake"));
      } else if (newline >= 0) {
        clearTimeout(timeout);
        try { resolveEndpoint(parseEndpoint(stdout.slice(0, newline))); } catch (error) { reject(error); }
      }
    });
  }).catch(async (error: unknown) => { child.kill("SIGTERM"); throw error; });
  return { endpoint, child };
};

const json = (response: ServerResponse, status: number, body: unknown): void => {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
  response.end(JSON.stringify(body));
};

const serveFile = async (request: IncomingMessage, response: ServerResponse, sessionId: string): Promise<void> => {
  const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
  if (pathname === "/config.js") {
    response.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'; script-src 'self'; connect-src 'self' ws://127.0.0.1:*; style-src 'self'; base-uri 'none'; frame-ancestors 'none'" });
    response.end(`window.FINLEET_CONFIG=${JSON.stringify({ sessionId }).replace(/</g, "\\u003c")};`);
    return;
  }
  const file = pathname === "/" ? "index.html" : pathname.slice(1);
  if (!new Set(["index.html", "app.js", "styles.css", "favicon.svg", "conversation.js"]).has(file)) { json(response, 404, { error: "Not found" }); return; }
  const path = file === "conversation.js" ? CONVERSATION_MODULE : resolve(PUBLIC_DIR, file);
  let info: Stats;
  try { info = await stat(path); } catch { json(response, 404, { error: "Web assets are unavailable; build finleet-web first" }); return; }
  response.writeHead(200, { "content-type": MIME[extname(path)] ?? "application/octet-stream", "content-length": info.size, "cache-control": file === "index.html" ? "no-store" : "public, max-age=3600", "x-content-type-options": "nosniff", "content-security-policy": "default-src 'self'; connect-src 'self' ws://127.0.0.1:*; object-src 'none'; base-uri 'none'; frame-ancestors 'none'" });
  if (request.method === "HEAD") response.end(); else createReadStream(path).pipe(response);
};

const sessionParams = (method: RpcMethod, params: unknown, sessionId: string): unknown => {
  if (method === "session.subscribe" || method === "agent.list" || method === "run.cancel") return { sessionId };
  if (method === "prompt.submit" && isRecord(params)) return { ...params, sessionId };
  return params;
};

export const startWebServer = async (options: WebOptions): Promise<{ close(): Promise<void>; url: string }> => {
  const attachedUrl = process.env.FINLEET_CORE_URL;
  const attachedToken = process.env.FINLEET_CORE_TOKEN;
  if ((attachedUrl !== undefined || attachedToken !== undefined) && (attachedUrl === undefined || attachedToken === undefined)) throw new Error("FINLEET_CORE_URL and FINLEET_CORE_TOKEN must be provided together");
  const owned = attachedUrl === undefined ? await startCore(options.coreArgs) : undefined;
  const endpoint = owned?.endpoint ?? parseEndpoint(JSON.stringify({ url: attachedUrl, token: attachedToken }));
  const server = createServer((request, response) => {
    if (request.method !== "GET" && request.method !== "HEAD") { json(response, 405, { error: "Method not allowed" }); return; }
    void serveFile(request, response, options.sessionId).catch(() => json(response, 500, { error: "Unable to serve web UI" }));
  });
  const webSockets = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: MAX_MESSAGE_BYTES });
  const clients = new Set<WebSocket>();
  server.on("upgrade", (request, socket, head) => {
    const origin = request.headers.origin;
    const host = request.headers.host;
    let localSameOrigin = false;
    try {
      const parsedOrigin = typeof origin === "string" ? new URL(origin) : undefined;
      localSameOrigin = parsedOrigin !== undefined && typeof host === "string" && parsedOrigin.host === host && ["127.0.0.1", "localhost", "[::1]"].includes(parsedOrigin.hostname);
    } catch { localSameOrigin = false; }
    if (request.url !== "/rpc" || !localSameOrigin) {
      socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    if (clients.size >= MAX_CLIENTS) { socket.write("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n"); socket.destroy(); return; }
    webSockets.handleUpgrade(request, socket, head, (client) => webSockets.emit("connection", client));
  });
  webSockets.on("connection", (client) => {
    clients.add(client);
    const core = new WebSocket(endpoint.url, { headers: { "x-finleet-token": endpoint.token }, perMessageDeflate: false, maxPayload: MAX_MESSAGE_BYTES });
    const queuedRequests: string[] = [];
    let requestCount = 0;
    let requestWindow = Date.now();
    client.on("message", (raw) => {
      const now = Date.now();
      if (now - requestWindow >= 1000) { requestWindow = now; requestCount = 0; }
      if (++requestCount > MAX_REQUESTS_PER_SECOND || Buffer.byteLength(raw.toString(), "utf8") > MAX_MESSAGE_BYTES) { client.close(1008, "Request limit exceeded"); return; }
      let request: unknown;
      try { request = JSON.parse(raw.toString()) as unknown; } catch { client.close(1007, "Invalid JSON"); return; }
      if (!isRecord(request) || request.jsonrpc !== "2.0" || (typeof request.id !== "number" && typeof request.id !== "string") || typeof request.method !== "string" || (typeof request.id === "number" && !Number.isFinite(request.id)) || !METHODS.has(request.method as RpcMethod)) { client.close(1008, "Unsupported RPC request"); return; }
      const method = request.method as RpcMethod;
      const serialized = JSON.stringify({ jsonrpc: "2.0", id: request.id, method, params: sessionParams(method, request.params, options.sessionId) });
      if (core.readyState === WebSocket.OPEN) core.send(serialized, { compress: false });
      else if (core.readyState === WebSocket.CONNECTING && queuedRequests.length < 16) queuedRequests.push(serialized);
      else client.close(1013, "Core connection is not ready");
    });
    core.on("message", (raw, isBinary) => {
      if (client.readyState !== WebSocket.OPEN) return;
      if (client.bufferedAmount > MAX_MESSAGE_BYTES * 4 || Buffer.byteLength(raw.toString(), "utf8") > MAX_MESSAGE_BYTES) { client.close(1013, "Slow browser client"); return; }
      if (isBinary) { client.close(1003, "Core sent a non-text message"); return; }
      client.send(raw.toString(), { compress: false });
    });
    core.on("open", () => {
      if (client.readyState !== WebSocket.OPEN) { core.close(); return; }
      for (const request of queuedRequests.splice(0)) core.send(request, { compress: false });
    });
    core.on("error", () => { if (client.readyState === WebSocket.OPEN) client.close(1011, "Core connection failed"); });
    client.once("close", () => { clients.delete(client); core.close(); });
    client.once("error", () => { clients.delete(client); core.close(); });
  });
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(options.port, "127.0.0.1", () => { server.off("error", reject); resolveListen(); });
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Web service did not receive a TCP port");
  const url = `http://127.0.0.1:${String(address.port)}`;
  return {
    url,
    close: async () => {
      for (const client of clients) client.close(1001, "Server shutting down");
      webSockets.close();
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
      if (owned !== undefined) {
        const child = owned.child;
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGTERM");
          const exited = await Promise.race([new Promise<boolean>((resolveExit) => child.once("exit", () => resolveExit(true))), new Promise<boolean>((resolveTimeout) => setTimeout(() => resolveTimeout(false), 2000))]);
          if (!exited) { child.kill("SIGKILL"); await new Promise<void>((resolveExit) => child.once("exit", () => resolveExit())); }
        }
      }
    },
  };
};

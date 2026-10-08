import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { WebSocket, WebSocketServer } from "ws";
import { parseWebOptions, startWebServer } from "./server.js";

test("web options separate UI settings from core serve arguments", () => {
  const options = parseWebOptions(["--port", "0", "--session", "review-1", "--provider", "fake", "--journal", "./tmp/review.jsonl"]);
  assert.equal(options.port, 0);
  assert.equal(options.sessionId, "review-1");
  assert.deepEqual(options.coreArgs, ["--provider", "fake", "--journal", "./tmp/review.jsonl"]);
  assert.notEqual(parseWebOptions([]).sessionId, parseWebOptions([]).sessionId);
  assert.throws(() => parseWebOptions(["--port", "65536"]), /--port/);
});

test("the gpt-5.6-luna provider shorthand selects core's OpenAI Responses provider", () => {
  assert.deepEqual(parseWebOptions(["--provider", "gpt-5.6-luna"]).coreArgs, ["--provider", "openai-responses"]);
  assert.deepEqual(parseWebOptions(["--provider=gpt-5.6-luna"]).coreArgs, ["--provider", "openai-responses"]);
});

test("web passes the documented OpenAI provider and model options to core", () => {
  assert.deepEqual(parseWebOptions([
    "--provider", "openai", "--model", "gpt-5.6-luna", "--reasoning-effort", "high", "--exchange", "paper",
  ]).coreArgs, ["--provider", "openai", "--model", "gpt-5.6-luna", "--reasoning-effort", "high", "--exchange", "paper"]);
});

test("loopback web proxy keeps the core token server-side and pins RPC to its session", async () => {
  const token = "t".repeat(43);
  const coreServer = createServer();
  const coreSockets = new WebSocketServer({ server: coreServer, perMessageDeflate: false });
  const received: Array<Record<string, unknown>> = [];
  coreSockets.on("connection", (socket, request) => {
    assert.equal(request.headers["x-finleet-token"], token);
    socket.on("message", (raw) => {
      const call = JSON.parse(raw.toString()) as Record<string, unknown>;
      received.push(call);
      socket.send(JSON.stringify({ jsonrpc: "2.0", id: call.id, result: call.method === "session.subscribe" ? { events: [] } : { accepted: true } }));
    });
  });
  await new Promise<void>((resolve) => coreServer.listen(0, "127.0.0.1", resolve));
  const coreAddress = coreServer.address();
  assert.ok(coreAddress !== null && typeof coreAddress !== "string");
  const oldUrl = process.env.FINLEET_CORE_URL;
  const oldToken = process.env.FINLEET_CORE_TOKEN;
  process.env.FINLEET_CORE_URL = `ws://127.0.0.1:${String(coreAddress.port)}`;
  process.env.FINLEET_CORE_TOKEN = token;
  const web = await startWebServer({ port: 0, sessionId: "pinned-session", coreArgs: [] });
  let client: WebSocket | undefined;
  try {
    const page = await fetch(web.url);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /CONVERSATION/);
    assert.match(html, /ACTIVITY/);
    assert.equal((await fetch(`${web.url}/conversation.js`)).status, 200);
    assert.equal((await fetch(`${web.url}/favicon.svg`)).status, 200);
    const config = await (await fetch(`${web.url}/config.js`)).text();
    assert.match(config, /pinned-session/);
    assert.equal(config.includes(token), false);
    client = new WebSocket(`${web.url.replace("http:", "ws:")}/rpc`, { origin: web.url });
    const connectedClient = client;
    await new Promise<void>((resolve, reject) => { connectedClient.once("open", resolve); connectedClient.once("error", reject); });
    const response = new Promise<Record<string, unknown>>((resolve) => connectedClient.once("message", (raw, isBinary) => {
      assert.equal(isBinary, false);
      resolve(JSON.parse(raw.toString()) as Record<string, unknown>);
    }));
    connectedClient.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "session.subscribe", params: { sessionId: "attacker-session" } }));
    assert.deepEqual(await response, { jsonrpc: "2.0", id: 1, result: { events: [] } });
    assert.deepEqual(received[0]?.params, { sessionId: "pinned-session" });
    connectedClient.close();
  } finally {
    if (client !== undefined && client.readyState !== WebSocket.CLOSED) {
      const clientClosed = new Promise<void>((resolve) => client?.once("close", () => resolve()));
      client.close();
      await clientClosed;
    }
    await web.close();
    await new Promise<void>((resolve) => coreSockets.close(() => resolve()));
    await new Promise<void>((resolve) => coreServer.close(() => resolve()));
    if (oldUrl === undefined) delete process.env.FINLEET_CORE_URL; else process.env.FINLEET_CORE_URL = oldUrl;
    if (oldToken === undefined) delete process.env.FINLEET_CORE_TOKEN; else process.env.FINLEET_CORE_TOKEN = oldToken;
  }
});

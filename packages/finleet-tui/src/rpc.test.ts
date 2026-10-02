import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import WebSocket from "ws";
import { parseAgentList, parsePermissionResponse, parsePromptSubmission, parseRpcRequest, parseRunCancellation, type PromptSubmission } from "finleet-core";
import { CoreService, RpcServer, type Provider, type Result, type ServiceResponse } from "finleet-core/testing";
import { WebSocketTuiClient } from "./tui-client.js";

const journal = (): string => join(mkdtempSync(join(tmpdir(), "finleet-rpc-")), "journal.jsonl");
const serviceFor = (path: string, allowAllPermissions = false): CoreService => new CoreService({
  args: ["exec", "--provider", "fake", "--exchange", "paper", "--journal", path, ...(allowAllPermissions ? ["--allow-all-permissions"] : [])],
  environment: { get: () => undefined },
  openAiFetch: async () => ({ ok: false, status: 500, headers: {}, json: async () => ({}), text: async () => "" }),
  compatibleFetch: globalThis.fetch,
  oauthFetch: async () => ({ ok: false, status: 500, json: async () => ({}) }),
});

async function withClient<T>(run: (client: WebSocketTuiClient, service: CoreService) => Promise<T>): Promise<T> {
  const service = serviceFor(journal());
  const server = new RpcServer(service);
  const endpoint = await server.start();
  const client = await WebSocketTuiClient.connect(endpoint.url, endpoint.token);
  try {
    return await run(client, service);
  } finally {
    await client.close();
    await server.close();
    service.close();
  }
}

async function within<T>(promise: Promise<T>, message: string): Promise<T> {
  return await Promise.race([promise, new Promise<T>((_resolve, reject) => setTimeout(() => reject(new Error(message)), 2_000))]);
}

test("JSON-RPC validators reject malformed and authority-bearing envelopes", () => {
  assert.equal(parseRpcRequest({ jsonrpc: "2.0", id: 1, method: "prompt.submit", params: { prompt: "x", sessionId: "s", promptId: "p" } })?.method, "prompt.submit");
  assert.deepEqual(parsePromptSubmission({ prompt: "x", sessionId: "s", promptId: "p", delivery: "steer" }), { prompt: "x", sessionId: "s", promptId: "p", delivery: "steer" });
  assert.equal(parsePromptSubmission({ prompt: "x", sessionId: "s", promptId: "p", delivery: "later" }), undefined);
  assert.equal(parseRpcRequest({ jsonrpc: "1.0", id: 1, method: "service.ping" }), undefined);
  assert.equal(parsePromptSubmission({ prompt: "x", sessionId: "s", promptId: "p", authority: "shell:write" }), undefined);
  assert.deepEqual(parsePermissionResponse({ requestId: "request", decision: "allow-job" }), { requestId: "request", decision: "allow-job" });
  assert.equal(parsePermissionResponse({ requestId: "request", decision: "allow-session", scope: "host" }), undefined);
  assert.equal(parsePermissionResponse({ requestId: "request", admissionId: "forged-admission", decision: "allow-job" }), undefined);
  assert.deepEqual(parseRunCancellation({ sessionId: "session" }), { sessionId: "session" });
  assert.equal(parseRunCancellation({ sessionId: "session", owner: "other-client" }), undefined);
  assert.deepEqual(parseAgentList({ sessionId: "session" }), { sessionId: "session" });
  assert.equal(parseAgentList({ sessionId: "session", history: true }), undefined);
  assert.equal(parseRpcRequest({ jsonrpc: "2.0", id: 1, method: "agent.list", params: { sessionId: "session" } })?.method, "agent.list");
});

test("agent list RPC returns only live safe rows for the requested session", async () => {
  await withClient(async (client, service) => {
    const append = (agentId: string, sessionId: string, status: "queued" | "completed") => {
      service.log.append(sessionId, { kind: "BackgroundAgentCreated", data: { agentId, parentSessionId: sessionId, parentToolCallId: `call-${agentId}`, profile: "read-only-research", childSessionId: `child-${agentId}`, contextMode: "fresh", provider: "private-provider", model: "private-model", timeoutMs: 1, maxTurns: 1, task: "private task" } });
      service.log.append(sessionId, { kind: "BackgroundAgentStatus", data: { agentId, status, output: "private output" } });
    };
    append("live", "listed", "queued"); append("settled", "listed", "completed"); append("other", "other", "queued");
    assert.deepEqual(await within(client.listAgents("listed"), "agent list response timed out"), [{ index: 1, agentId: "live", childSessionId: "child-live", status: "queued" }]);
    const listed = service.listAgents("listed"); assert.equal(listed.ok, true); if (listed.ok) assert.equal(JSON.stringify(listed.value).includes("private"), false);
  });
});

test("loopback server rejects unauthenticated WebSocket upgrades", async () => {
  const service = serviceFor(journal());
  const server = new RpcServer(service);
  const endpoint = await server.start();
  try {
    const status = await new Promise<number>((resolve, reject) => {
      const socket = new WebSocket(endpoint.url, { headers: { "x-finleet-token": "wrong" }, perMessageDeflate: false });
      socket.once("unexpected-response", (_request, response) => { response.resume(); resolve(response.statusCode ?? 0); });
      socket.once("error", reject);
    });
    assert.equal(status, 401);
  } finally {
    await server.close();
    service.close();
  }
});

test("malformed multibyte credentials are rejected without terminating the server", async () => {
  const service = serviceFor(journal());
  const server = new RpcServer(service);
  const endpoint = await server.start();
  try {
    const malformed = `é${"a".repeat(server.token.length - 1)}`;
    const status = await new Promise<number>((resolve, reject) => {
      const socket = new WebSocket(endpoint.url, { headers: { "x-finleet-token": malformed }, perMessageDeflate: false });
      socket.once("unexpected-response", (_request, response) => { response.resume(); resolve(response.statusCode ?? 0); });
      socket.once("error", reject);
    });
    assert.equal(status, 401);
    const client = await WebSocketTuiClient.connect(endpoint.url, endpoint.token);
    await client.close();
  } finally {
    await server.close();
    service.close();
  }
});

test("deep JSON requests return an error without terminating the server", async () => {
  const service = serviceFor(journal());
  const server = new RpcServer(service);
  const endpoint = await server.start();
  const socket = new WebSocket(endpoint.url, { headers: { "x-finleet-token": endpoint.token }, perMessageDeflate: false });
  try {
    await new Promise<void>((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
    const response = new Promise<string>((resolve) => socket.once("message", (raw) => resolve(raw.toString())));
    socket.send(`{"jsonrpc":"2.0","id":1,"method":"service.ping","params":${"[".repeat(10_000)}null${"]".repeat(10_000)}}`);
    assert.match(await within(response, "deep request response timed out"), /"code":-32600/);
    const client = await WebSocketTuiClient.connect(endpoint.url, endpoint.token);
    await client.close();
  } finally {
    socket.close();
    await server.close();
    service.close();
  }
});

test("prompt submission streams ordered durable events and snapshots dedupe IDs", async () => {
  await withClient(async (client) => {
    const received: string[] = [];
    client.onEvent((event) => received.push(event.id));
    assert.deepEqual(await within(client.subscribe("rpc-session"), "subscription response timed out"), []);
    const response = await within(client.submit({ prompt: "summarize the session", sessionId: "rpc-session", promptId: "rpc-prompt" }), "prompt response timed out");
    assert.equal(response.exitCode, 0);
    assert.equal(received.length > 0, true);
    assert.equal(new Set(received).size, received.length);
    assert.equal((await within(client.subscribe("rpc-session"), "replay response timed out")).length, 0);
  });
});

test("repeated subscriptions reuse one server listener while distinct sessions remain subscribed", async () => {
  await withClient(async (client, service) => {
    let subscriptions = 0;
    const originalSubscribe = service.subscribe.bind(service);
    service.subscribe = ((sessionId, listener) => {
      subscriptions += 1;
      return originalSubscribe(sessionId, listener);
    }) as CoreService["subscribe"];
    await within(client.subscribe("main-session"), "main subscription timed out");
    await within(client.subscribe("main-session"), "repeated main subscription timed out");
    await within(client.subscribe("child-session"), "child subscription timed out");
    assert.equal(subscriptions, 2);
  });
});

test("subscription returns an event published before its snapshot response", async () => {
  await withClient(async (client, service) => {
    const originalSubscribe = service.subscribe.bind(service);
    service.subscribe = ((sessionId, listener) => {
      const subscription = originalSubscribe(sessionId, listener);
      if (subscription.ok) {
        const appended = service.log.append(sessionId, {
          kind: "PromptAdmitted",
          data: { promptId: "racing-prompt", prompt: "race", delivery: "queue" },
        });
        assert.equal(appended.kind, "PromptAdmitted");
      }
      return subscription;
    }) as CoreService["subscribe"];

    const events = await within(client.subscribe("racing-session"), "racing subscription timed out");
    assert.equal(events.filter((event) => event.kind === "PromptAdmitted").length, 1);
  });
});

test("permission notifications accept only their opaque server request IDs", async () => {
  await withClient(async (client) => {
    const requests: string[] = [];
    let approval: Promise<void> | undefined;
    client.onPermission((request) => {
      requests.push(request.requestId);
      approval = client.respondPermission(request.requestId, { decision: "allow-once" });
    });
    await assert.rejects(within(client.respondPermission("forged-request", { decision: "allow-once" }), "forged response timed out"));
    const response = await within(client.submit({ prompt: "bash printf rpc-approved", sessionId: "permission-session", promptId: "permission-prompt" }), "prompt response timed out");
    assert.equal(response.exitCode, 0);
    assert.equal(requests.length, 1);
    await approval;
  });
});

test("allow-job resolves concurrent same-admission waiters and isolates other admissions", async () => {
  const service = serviceFor(journal());
  type ServiceInternals = {
    approver(owner: string, sessionId: string): (request: {
      toolName: string;
      requiredPermission: "shell:write";
      scope: string;
      arguments: {};
      reviewSteps: readonly string[];
      admissionId: string;
      childSessionId?: string;
    }) => Promise<{ decision: "allow-once" | "allow-job" | "allow-session" } | { decision: "reject"; feedback?: string }>;
  };
  const internals = service as unknown as ServiceInternals;
  const requested: Array<{ requestId: string; admissionId: string }> = [];
  service.onPermission((request) => requested.push({ requestId: request.requestId, admissionId: request.admissionId }));
  const approve = internals.approver("owner", "parent-session");
  const first = approve({ toolName: "bash", requiredPermission: "shell:write", scope: "first", arguments: {}, reviewSteps: [], admissionId: "admission-one" });
  const second = approve({ toolName: "bash", requiredPermission: "shell:write", scope: "second", arguments: {}, reviewSteps: [], admissionId: "admission-one" });
  assert.equal(requested.length, 2);
  assert.equal(service.respondPermission(requested[0]!.requestId, "owner", { decision: "allow-job" }), true);
  assert.deepEqual(await first, { decision: "allow-job" });
  assert.deepEqual(await second, { decision: "allow-once" });
  assert.deepEqual(await approve({ toolName: "bash", requiredPermission: "shell:write", scope: "third", arguments: {}, reviewSteps: [], admissionId: "admission-one" }), { decision: "allow-once" });
  assert.equal(requested.length, 2);
  const otherAdmission = approve({ toolName: "bash", requiredPermission: "shell:write", scope: "fourth", arguments: {}, reviewSteps: [], admissionId: "admission-two" });
  assert.equal(requested.length, 3);
  assert.equal(requested[2]!.admissionId, "admission-two");
  assert.equal(service.respondPermission(requested[2]!.requestId, "owner", { decision: "reject", feedback: "separate job" }), true);
  assert.deepEqual(await otherAdmission, { decision: "reject", feedback: "separate job" });
  const childAdmission = approve({ toolName: "bash", requiredPermission: "shell:write", scope: "child", arguments: {}, reviewSteps: [], admissionId: "admission-one", childSessionId: "child-session" });
  assert.equal(requested.length, 4);
  assert.equal(service.respondPermission(requested[3]!.requestId, "owner", { decision: "reject", feedback: "independent child" }), true);
  assert.deepEqual(await childAdmission, { decision: "reject", feedback: "independent child" });
  service.close();
});

test("local allow-job bypasses later prompts only for the same admission", async () => {
  let localPrompts = 0;
  const service = new CoreService({
    args: ["exec", "--provider", "fake", "--exchange", "paper", "--journal", journal()],
    environment: { get: () => undefined },
    openAiFetch: async () => ({ ok: false, status: 500, headers: {}, json: async () => ({}), text: async () => "" }),
    compatibleFetch: globalThis.fetch,
    oauthFetch: async () => ({ ok: false, status: 500, json: async () => ({}) }),
    localApprover: async () => {
      localPrompts += 1;
      return localPrompts === 1 ? { decision: "allow-job" } : { decision: "reject", feedback: "separate job" };
    },
  });
  type ServiceInternals = {
    approver(owner: string, sessionId: string): (request: {
      toolName: string;
      requiredPermission: "shell:write";
      scope: string;
      arguments: {};
      reviewSteps: readonly string[];
      admissionId: string;
    }) => Promise<{ decision: "allow-once" | "allow-job" } | { decision: "reject"; feedback?: string }>;
  };
  const approve = (service as unknown as ServiceInternals).approver("local", "local-session");
  const request = (scope: string, admissionId: string) => ({
    toolName: "bash",
    requiredPermission: "shell:write" as const,
    scope,
    arguments: {},
    reviewSteps: [],
    admissionId,
  });

  assert.deepEqual(await approve(request("first", "local-admission")), { decision: "allow-job" });
  assert.deepEqual(await approve(request("second", "local-admission")), { decision: "allow-once" });
  assert.equal(localPrompts, 1);
  assert.deepEqual(await approve(request("third", "other-admission")), { decision: "reject", feedback: "separate job" });
  assert.equal(localPrompts, 2);
  service.close();
});

test("allow-job expires with its completed admission and does not authorize a later prompt", async () => {
  await withClient(async (client) => {
    let requests = 0;
    client.onPermission((request) => {
      requests += 1;
      void client.respondPermission(request.requestId, requests === 1 ? { decision: "allow-job" } : { decision: "reject", feedback: "new prompt" });
    });
    const first = await within(client.submit({ prompt: "bash printf first", sessionId: "job-expiry", promptId: "first" }), "first job timed out");
    assert.equal(first.exitCode, 0);
    const second = await within(client.submit({ prompt: "bash printf second", sessionId: "job-expiry", promptId: "second" }), "second job timed out");
    assert.equal(second.exitCode, 2);
    assert.equal(requests, 2);
  });
});

test("launch flag automatically allows every permission request", async () => {
  const service = serviceFor(journal(), true);
  const server = new RpcServer(service);
  const endpoint = await server.start();
  const client = await WebSocketTuiClient.connect(endpoint.url, endpoint.token);
  const requests: string[] = [];
  try {
    client.onPermission((request) => requests.push(request.requestId));
    const response = await within(client.submit({
      prompt: "bash printf launch-allowed",
      sessionId: "auto-permission-session",
      promptId: "auto-permission-prompt",
    }), "auto-approved prompt timed out");
    assert.equal(response.exitCode, 0);
    assert.deepEqual(requests, []);
  } finally {
    await client.close();
    await server.close();
    service.close();
  }
});

test("session permission grants never cross connection or session boundaries", async () => {
  const service = serviceFor(journal());
  const server = new RpcServer(service);
  const endpoint = await server.start();
  const first = await WebSocketTuiClient.connect(endpoint.url, endpoint.token);
  const second = await WebSocketTuiClient.connect(endpoint.url, endpoint.token);
  try {
    first.onPermission((request) => {
      void first.respondPermission(request.requestId, { decision: "allow-session" });
    });
    const approved = await within(first.submit({
      prompt: "bash printf first",
      sessionId: "first-session",
      promptId: "first-prompt",
    }), "first permission-approved prompt timed out");
    assert.equal(approved.exitCode, 0);

    const secondRequest = new Promise<void>((resolve) => {
      second.onPermission((request) => {
        void second.respondPermission(request.requestId, { decision: "reject", feedback: "separate client" });
        resolve();
      });
    });
    const rejected = second.submit({
      prompt: "bash printf second",
      sessionId: "second-session",
      promptId: "second-prompt",
    });
    await within(secondRequest, "second client did not receive its own permission request");
    assert.equal((await within(rejected, "second prompt did not settle")).exitCode, 2);
  } finally {
    await first.close();
    await second.close();
    await server.close();
    service.close();
  }
});

test("only the owning connection can cancel its permission-blocked run", async () => {
  const service = serviceFor(journal());
  const server = new RpcServer(service);
  const endpoint = await server.start();
  const owner = await WebSocketTuiClient.connect(endpoint.url, endpoint.token);
  const other = await WebSocketTuiClient.connect(endpoint.url, endpoint.token);
  try {
    const permissionRequested = new Promise<void>((resolve) => {
      owner.onPermission(() => resolve());
    });
    const submission = owner.submit({
      prompt: "bash printf cancellation",
      sessionId: "cancel-session",
      promptId: "cancel-prompt",
    });
    await within(permissionRequested, "permission request timed out");
    assert.equal(await within(other.cancel("cancel-session"), "other cancellation timed out"), false);
    assert.equal(await within(owner.cancel("cancel-session"), "owner cancellation timed out"), true);

    const response = await within(submission, "cancelled prompt did not settle");
    assert.equal(response.exitCode, 2);
    assert.match(JSON.stringify(response.body), /EXECUTION_ABORTED/);
  } finally {
    await owner.close();
    await other.close();
    await server.close();
    service.close();
  }
});

test("simultaneous queues serialize delayed admission so only one is admitted", async () => {
  const service = serviceFor(journal());
  type ServiceInternals = {
    resolveProvider(providerName: string, responses: boolean, compatible: boolean): Promise<Result<{ provider: Provider; contextWindow?: number }>>;
  };
  const internals = service as unknown as ServiceInternals;
  const originalResolveProvider = internals.resolveProvider.bind(service);
  let releaseValidation: () => void = () => undefined;
  const validationReleased = new Promise<void>((resolve) => { releaseValidation = resolve; });
  let validationStarted: () => void = () => undefined;
  const validationWaiting = new Promise<void>((resolve) => { validationStarted = resolve; });
  let resolutions = 0;
  internals.resolveProvider = async (providerName, responses, compatible) => {
    resolutions += 1;
    if (resolutions === 1) {
      validationStarted();
      await validationReleased;
    }
    return await originalResolveProvider(providerName, responses, compatible);
  };
  try {
    const first = service.submit({ prompt: "first queue", sessionId: "lane-session", promptId: "first", delivery: "queue" }, "owner");
    await within(validationWaiting, "first admission validation did not start");
    const second = service.submit({ prompt: "second queue", sessionId: "lane-session", promptId: "second", delivery: "queue" }, "owner");
    releaseValidation();
    const [firstResponse, secondResponse] = await Promise.all([first, second]);
    assert.equal(firstResponse.exitCode, 0);
    assert.equal(secondResponse.exitCode, 2);
    assert.match(JSON.stringify(secondResponse.body), /RUN_ALREADY_ACTIVE/);
    const events = service.events();
    assert.equal(events.ok, true);
    if (events.ok) assert.deepEqual(events.value.filter((event) => event.kind === "PromptAdmitted").map((event) => event.data.promptId), ["first"]);
  } finally {
    service.close();
  }
});

test("simultaneous same-owner steers are admitted FIFO and abort the active run once", async () => {
  const service = serviceFor(journal());
  try {
    let requested: () => void = () => undefined;
    const permissionRequested = new Promise<void>((resolve) => { requested = resolve; });
    service.onPermission(() => requested());
    let promoted: () => void = () => undefined;
    const steersPromoted = new Promise<void>((resolve) => { promoted = resolve; });
    const subscription = service.subscribe("simultaneous-steers", (event) => {
      if (event.kind === "InputPromoted" && event.data.promptId === "second") promoted();
    });
    assert.equal(subscription.ok, true);

    const running = service.submit({ prompt: "bash printf active", sessionId: "simultaneous-steers", promptId: "active", delivery: "queue" }, "owner");
    await within(permissionRequested, "permission request timed out");
    const [first, second] = await Promise.all([
      service.submit({ prompt: "first steer", sessionId: "simultaneous-steers", promptId: "first", delivery: "steer" }, "owner"),
      service.submit({ prompt: "second steer", sessionId: "simultaneous-steers", promptId: "second", delivery: "steer" }, "owner"),
    ]);
    assert.equal(first.exitCode, 0);
    assert.equal(second.exitCode, 0);
    assert.equal((await within(running, "interrupted run did not settle")).exitCode, 2);
    await within(steersPromoted, "simultaneous steers did not promote");
    const events = service.events();
    assert.equal(events.ok, true);
    if (events.ok) assert.deepEqual(events.value.filter((event) => event.kind === "InputPromoted").map((event) => event.data.promptId), ["active", "first", "second"]);
    if (subscription.ok) subscription.value.unsubscribe();
  } finally {
    service.close();
  }
});

test("a pre-promotion setup failure stops the pump without retrying its admission", async () => {
  const service = serviceFor(journal());
  type ServiceInternals = {
    runSubmission(input: PromptSubmission, owner: string, signal: AbortSignal): Promise<ServiceResponse>;
  };
  const internals = service as unknown as ServiceInternals;
  let attempts = 0;
  internals.runSubmission = async () => {
    attempts += 1;
    return { exitCode: 2, body: { error: { code: "SETUP_FAILED", message: "setup failed" } } };
  };
  try {
    const response = await service.submit({ prompt: "cannot start", sessionId: "setup-failure", promptId: "setup", delivery: "queue" }, "owner");
    assert.equal(response.exitCode, 2);
    assert.equal(attempts, 1);
    const events = service.events();
    assert.equal(events.ok, true);
    if (events.ok) {
      assert.equal(events.value.filter((event) => event.kind === "PromptAdmitted").length, 1);
      assert.equal(events.value.some((event) => event.kind === "InputPromoted"), false);
    }
  } finally {
    service.close();
  }
});

test("queue rejects while active, while a same-owner steer is admitted before aborting its run", async () => {
  await withClient(async (client, service) => {
    let requestId = "";
    const permissionRequested = new Promise<void>((resolve) => {
      client.onPermission((request) => { requestId = request.requestId; resolve(); });
    });
    const running = client.submit({ prompt: "bash printf active", sessionId: "steer-session", promptId: "active", delivery: "queue" });
    await within(permissionRequested, "permission request timed out");

    const queued = await within(client.submit({ prompt: "queued", sessionId: "steer-session", promptId: "queued", delivery: "queue" }), "queue rejection timed out");
    assert.equal(queued.exitCode, 2);
    assert.match(JSON.stringify(queued.body), /RUN_ALREADY_ACTIVE/);

    const steer = await within(client.submit({ prompt: "take this direction", sessionId: "steer-session", promptId: "steer", delivery: "steer" }), "steer admission timed out");
    assert.equal(steer.exitCode, 0);
    assert.match(JSON.stringify(steer.body), /admitted/);
    assert.equal((await within(running, "interrupted run did not settle")).exitCode, 2);
    await assert.rejects(within(client.respondPermission(requestId, { decision: "allow-once" }), "interrupted permission remained pending"));

    const events = service.events();
    assert.equal(events.ok, true);
    if (!events.ok) return;
    assert.deepEqual(events.value.filter((event) => event.kind === "PromptAdmitted").map((event) => event.data.promptId), ["active", "steer"]);
    const failed = events.value.findIndex((event) => event.kind === "GraphTransition" && event.data.outcome === "failed");
    const promoted = events.value.findIndex((event) => event.kind === "InputPromoted" && event.data.promptId === "steer");
    assert.equal(failed >= 0, true);
    assert.equal(promoted > failed, true);
  });
});

test("different-owner steer is rejected before admission or cancellation", async () => {
  const service = serviceFor(journal());
  const server = new RpcServer(service);
  const endpoint = await server.start();
  const owner = await WebSocketTuiClient.connect(endpoint.url, endpoint.token);
  const other = await WebSocketTuiClient.connect(endpoint.url, endpoint.token);
  try {
    const permissionRequested = new Promise<void>((resolve) => owner.onPermission(() => resolve()));
    const running = owner.submit({ prompt: "bash printf owned", sessionId: "owner-session", promptId: "active", delivery: "queue" });
    await within(permissionRequested, "owner permission request timed out");
    const rejected = await within(other.submit({ prompt: "other direction", sessionId: "owner-session", promptId: "other-steer", delivery: "steer" }), "foreign steer rejection timed out");
    assert.equal(rejected.exitCode, 2);
    assert.match(JSON.stringify(rejected.body), /RUN_ALREADY_ACTIVE/);
    const events = service.events();
    assert.equal(events.ok, true);
    if (events.ok) assert.equal(events.value.some((event) => event.kind === "PromptAdmitted" && event.data.promptId === "other-steer"), false);
    assert.equal(await within(owner.cancel("owner-session"), "owner cancellation timed out"), true);
    assert.equal((await within(running, "owner run did not settle")).exitCode, 2);
  } finally {
    await owner.close();
    await other.close();
    await server.close();
    service.close();
  }
});

test("different owner cannot retry the exact active steer admission", async () => {
  const service = serviceFor(journal());
  const server = new RpcServer(service);
  const endpoint = await server.start();
  const owner = await WebSocketTuiClient.connect(endpoint.url, endpoint.token);
  const other = await WebSocketTuiClient.connect(endpoint.url, endpoint.token);
  try {
    let permissionCount = 0;
    let firstRequested: () => void = () => undefined;
    const firstPermission = new Promise<void>((resolve) => { firstRequested = resolve; });
    let steerRequested: () => void = () => undefined;
    const steerPermission = new Promise<void>((resolve) => { steerRequested = resolve; });
    owner.onPermission(() => {
      permissionCount += 1;
      if (permissionCount === 1) firstRequested();
      if (permissionCount === 2) steerRequested();
    });

    const running = owner.submit({ prompt: "bash printf original", sessionId: "retry-owner-session", promptId: "active", delivery: "queue" });
    await within(firstPermission, "original permission request timed out");
    const steer = { prompt: "bash printf steered", sessionId: "retry-owner-session", promptId: "steer", delivery: "steer" as const };
    assert.equal((await within(owner.submit(steer), "owner steer admission timed out")).exitCode, 0);
    assert.equal((await within(running, "interrupted original run did not settle")).exitCode, 2);
    await within(steerPermission, "steer permission request timed out");

    const rejected = await within(other.submit(steer), "foreign exact steer retry timed out");
    assert.equal(rejected.exitCode, 2);
    assert.match(JSON.stringify(rejected.body), /RUN_ALREADY_ACTIVE/);
    assert.equal(await within(owner.cancel("retry-owner-session"), "owner steer cancellation timed out"), true);
  } finally {
    await owner.close();
    await other.close();
    await server.close();
    service.close();
  }
});

test("exact steer retries are idempotent and rapid steers promote FIFO after interruption", async () => {
  await withClient(async (client, service) => {
    const permissionRequested = new Promise<void>((resolve) => client.onPermission(() => resolve()));
    const running = client.submit({ prompt: "bash printf first", sessionId: "fifo-session", promptId: "active", delivery: "queue" });
    await within(permissionRequested, "permission request timed out");
    const first = { prompt: "first steer", sessionId: "fifo-session", promptId: "first", delivery: "steer" as const };
    assert.equal((await within(client.submit(first), "first steer timed out")).exitCode, 0);
    assert.equal((await within(client.submit(first), "steer retry timed out")).exitCode, 0);
    assert.equal((await within(client.submit({ prompt: "second steer", sessionId: "fifo-session", promptId: "second", delivery: "steer" }), "second steer timed out")).exitCode, 0);
    assert.equal((await within(client.submit({ prompt: "third steer", sessionId: "fifo-session", promptId: "third", delivery: "steer" }), "third steer timed out")).exitCode, 0);
    assert.equal((await within(running, "interrupted run did not settle")).exitCode, 2);

    const events = service.events();
    assert.equal(events.ok, true);
    if (!events.ok) return;
    assert.equal(events.value.filter((event) => event.kind === "PromptAdmitted" && event.data.promptId === "first").length, 1);
    assert.deepEqual(
      events.value.filter((event) => event.kind === "InputPromoted").map((event) => event.data.promptId),
      ["active", "first", "second", "third"],
    );
    assert.deepEqual(
      events.value.filter((event) => event.kind === "GraphRunStarted").map((event) => event.data.inputEventId),
      events.value.filter((event) => event.kind === "InputPromoted").map((event) => {
        const admitted = events.value.find((candidate) => candidate.kind === "PromptAdmitted" && candidate.data.promptId === event.data.promptId);
        return admitted?.id;
      }),
    );
    const starts = events.value
      .map((event, index) => event.kind === "GraphRunStarted" ? { index, runId: event.data.runId } : undefined)
      .filter((entry): entry is { index: number; runId: string } => entry !== undefined);
    for (const [index, start] of starts.entries()) {
      if (index === 0) continue;
      const previous = starts[index - 1];
      assert.equal(previous !== undefined, true);
      if (previous === undefined) continue;
      assert.equal(events.value.some((event, eventIndex) => (
        eventIndex < start.index
        && event.kind === "GraphTransition"
        && event.data.runId === previous.runId
        && (event.data.outcome === "finished" || event.data.outcome === "failed")
      )), true);
    }
  });
});

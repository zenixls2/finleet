import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { execute } from "./cli.js";
import { EventLog, projectHistory, redactJson } from "./domain.js";
import { OpenAIResponsesProvider, OpenAIResponsesResolver, type Environment, type OpenAiFetch } from "./integrations.js";
import { buildAuthorizeURL, exchangeCodeForTokens, generatePKCE, openAIOAuthConfig, refreshAccessToken, type OAuthFetch } from "./auth.js";
import { Runner, ToolRegistry, type ProviderRequest, type ToolDefinition } from "./runtime.js";
import { DEFAULT_AGENT_SELECTION_PROMPT, DEFAULT_SELECTED_AGENT_PROMPT } from "./agent-context.js";

const journal = (): string => join(mkdtempSync(join(tmpdir(), "finleet-responses-")), "journal.jsonl");
const environment = (apiKey: string | undefined, authContent?: string, clientId?: string): Environment => ({ get: (name) => name === "OPENAI_API_KEY" ? apiKey : name === "FINLEET_AUTH_CONTENT" ? authContent : name === "FINLEET_OPENAI_CLIENT_ID" ? clientId : undefined });
const command = (path: string, promptId = "prompt-1", prompt = "Hello World", authFile?: string): string[] => ["exec", prompt, "--provider", "openai-responses", "--model", "gpt-5.6-luna", "--reasoning-effort", "high", "--exchange", "paper", "--journal", path, "--session", "responses-1", "--prompt-id", promptId, "--format", "json", ...(authFile === undefined ? [] : ["--auth-file", authFile])];
const successFetch = (): OpenAiFetch => async () => ({ ok: true, status: 200, json: async () => ({ output: [{ type: "message", content: [{ type: "output_text", text: "Hello from Responses" }] }] }) });

test("OpenAI login fails before network activity while CLIENT_ID is intentionally blank", async () => {
  const authFile = join(mkdtempSync(join(tmpdir(), "finleet-auth-handoff-")), "auth.json");
  writeFileSync(authFile, "preserved"); let calls = 0;
  const response = await execute(["auth", "login", "--provider", "openai", "--auth-file", authFile, "--format", "json"], { environment: environment(undefined, undefined, ""), openAiFetch: async () => { calls += 1; return { ok: false, status: 500, json: async () => ({}) }; } });
  assert.equal(response.exitCode, 2);
  assert.deepEqual(response.body, { error: { code: "AUTH_CLIENT_ID_REQUIRED", message: "OpenAI OAuth CLIENT_ID is blank; replace OPENAI_OAUTH_CLIENT_ID before logging in" } });
  assert.equal(readFileSync(authFile, "utf8"), "preserved"); assert.equal(calls, 0);
});

test("OpenAI OAuth builds PKCE authorization URLs and exchanges codes", async () => {
  const config = { ...openAIOAuthConfig(environment(undefined)), clientId: "client-test" }; const pkce = generatePKCE();
  const url = new URL(buildAuthorizeURL(config, pkce, "state-test", "http://localhost:1455/auth/callback"));
  assert.equal(url.pathname, "/oauth/authorize"); assert.equal(url.searchParams.get("client_id"), "client-test"); assert.equal(url.searchParams.get("code_challenge_method"), "S256"); assert.equal(url.searchParams.get("state"), "state-test"); assert.equal(url.searchParams.get("originator"), "codex_cli_rs");
  let requestBody = ""; const fetch: OAuthFetch = async (requestUrl, init) => { assert.equal(requestUrl, "https://auth.openai.com/oauth/token"); requestBody = init.body; return { ok: true, status: 200, json: async () => ({ access_token: "access-token", refresh_token: "refresh-token", expires_in: 3600 }) }; };
  const exchanged = await exchangeCodeForTokens(config, fetch, "code-test", pkce.codeVerifier, "http://localhost:1455/auth/callback");
  assert.equal(exchanged.ok, true); assert.match(requestBody, /grant_type=authorization_code/); assert.match(requestBody, /code_verifier=/); if (exchanged.ok) { assert.equal(exchanged.value.access, "access-token"); assert.equal(exchanged.value.refresh, "refresh-token"); }
});

test("OpenAI OAuth refresh preserves the prior refresh token and account metadata", async () => {
  const config = { ...openAIOAuthConfig(environment(undefined)), clientId: "client-test" }; const credential = { type: "oauth" as const, access: "old-access", refresh: "old-refresh", expires: Date.now() - 1, accountId: "account-test" };
  const refreshed = await refreshAccessToken(config, async (_url, init) => { assert.match(init.body, /refresh_token=old-refresh/); return { ok: true, status: 200, json: async () => ({ access_token: "new-access", expires_in: 3600 }) }; }, credential);
  assert.equal(refreshed.ok, true); if (refreshed.ok) { assert.equal(refreshed.value.access, "new-access"); assert.equal(refreshed.value.refresh, "old-refresh"); assert.equal(refreshed.value.accountId, "account-test"); }
});

test("OpenAI Responses uses stored OAuth credentials through the Codex route", async () => {
  const credential = JSON.stringify({ openai: { type: "oauth", access: "oauth-access", refresh: "oauth-refresh", expires: Date.now() + 600_000, accountId: "account-test" } });
  let url = ""; let headers: Readonly<Record<string, string>> = {}; let body = "";
  const response = await execute(command(journal()), { environment: environment(undefined, credential), oauthFetch: async () => { throw new Error("refresh should not run"); }, openAiFetch: async (requestUrl, init) => { url = requestUrl; headers = init.headers; body = init.body; return { ok: true, status: 200, json: async () => ({ output: [{ type: "message", content: [{ type: "output_text", text: "OAuth response" }] }] }) }; } });
  assert.equal(response.exitCode, 0, JSON.stringify(response.body)); assert.equal(url, "https://chatgpt.com/backend-api/codex/responses"); assert.equal(headers.authorization, "Bearer oauth-access"); assert.equal(headers["chatgpt-account-id"], "account-test"); assert.equal(headers.originator, "codex_cli_rs"); assert.equal(headers["openai-beta"], "responses=experimental"); assert.equal(body.includes("oauth-access") || body.includes("oauth-refresh"), false); assert.match(body, /"name":"fetch_page"/); assert.match(body, /"store":false/); assert.match(body, /"stream":true/); assert.match(JSON.stringify(response.body), /OAuth response/);
});

test("OAuth Responses consumes Codex SSE output and usage", async () => {
  const credential = JSON.stringify({ openai: { type: "oauth", access: "oauth-access", refresh: "oauth-refresh", expires: Date.now() + 600_000, accountId: "account-test" } });
  const response = await execute(command(journal()), { environment: environment(undefined, credential), openAiFetch: async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => "data: {\"type\":\"response.output_text.delta\",\"delta\":\"Hello\"}\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\" SSE\"}\ndata: {\"type\":\"response.completed\",\"response\":{\"usage\":{\"input_tokens\":4,\"output_tokens\":2}}}\n\ndata: [DONE]\n" }) });
  assert.equal(response.exitCode, 0, JSON.stringify(response.body)); assert.match(JSON.stringify(response.body), /Hello SSE/);
});

test("OAuth Responses sends the original durable tool call ID", async () => {
  let body = "";
  const provider = new OpenAIResponsesProvider("oauth-access", async (_url, init) => { body = init.body; return { ok: true, status: 200, json: async () => ({ output: [{ type: "message", content: [{ type: "output_text", text: "done" }] }] }) }; }, { accountId: "account-test" });
  const request: ProviderRequest = { providerId: "openai-responses", modelId: "gpt-5.6-luna", messages: [{ role: "tool", content: "quote result", eventId: "tool-event", toolCallId: "provider-call" }], system: "", tools: [] };
  for await (const event of provider.stream(request)) { void event; }
  assert.match(body, /"call_id":"provider-call"/); assert.equal(body.includes("tool-event"), false);
});

test("OAuth Responses rejects nonterminal and failed SSE streams", async () => {
  const credential = JSON.stringify({ openai: { type: "oauth", access: "oauth-access", refresh: "oauth-refresh", expires: Date.now() + 600_000, accountId: "account-test" } });
  const sources = ["data: {\"type\":\"response.output_text.delta\",\"delta\":\"partial\"}\n", "data: {\"type\":\"response.failed\",\"response\":{}}\n", "data: null\ndata: {\"type\":\"response.completed\",\"response\":{}}\n"];
  for (const source of sources) {
    const response = await execute(command(journal()), { environment: environment(undefined, credential), openAiFetch: async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => source }) });
    assert.equal(response.exitCode, 2); assert.match(JSON.stringify(response.body), /OPENAI_RESPONSES_RESPONSE_INVALID/);
  }
});

test("missing OpenAI key fails before admission or fetch", async () => {
  const path = journal(); let calls = 0;
  const response = await execute(command(path), { environment: environment(undefined, "{}"), openAiFetch: async () => { calls += 1; return { ok: true, status: 200, json: async () => ({}) }; } });
  assert.equal(response.exitCode, 2); assert.match(JSON.stringify(response.body), /OPENAI_OAUTH_REQUIRED/); assert.equal(calls, 0); assert.equal(existsSync(path), false);
});

test("expired OAuth credentials refresh and persist before the provider request", async () => {
  const root = mkdtempSync(join(tmpdir(), "finleet-oauth-refresh-")); const authFile = join(root, "auth.json"); const path = join(root, "journal.jsonl");
  writeFileSync(authFile, JSON.stringify({ openai: { type: "oauth", access: "old-access", refresh: "old-refresh", expires: Date.now() - 1, accountId: "account-test" } }));
  let refreshCalls = 0; let providerAuthorization = "";
  const response = await execute(command(path, "refresh-prompt", "Hello World", authFile), { environment: environment(undefined), oauthFetch: async (_url, init) => { refreshCalls += 1; assert.match(init.body, /refresh_token=old-refresh/); return { ok: true, status: 200, json: async () => ({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 3600 }) }; }, openAiFetch: async (_url, init) => { providerAuthorization = init.headers.authorization ?? ""; return { ok: true, status: 200, json: async () => ({ output: [{ type: "message", content: [{ type: "output_text", text: "refreshed" }] }] }) }; } });
  assert.equal(response.exitCode, 0, JSON.stringify(response.body)); assert.equal(refreshCalls, 1); assert.equal(providerAuthorization, "Bearer new-access"); assert.equal(JSON.parse(readFileSync(authFile, "utf8")).openai.refresh, "new-refresh");
});

test("OpenAI Responses uses the fixed official request and produces one durable result", async () => {
  const path = journal(); let calls = 0; let url = ""; let authorization = ""; let body = "";
  const fetch: OpenAiFetch = async (requestUrl, init) => { calls += 1; url = requestUrl; authorization = init.headers.authorization ?? ""; const payload = JSON.parse(init.body) as { tools: readonly { name: string }[] }; assert.equal(payload.tools.some((tool) => tool.name === "render_chart"), true); body = JSON.stringify({ ...payload, tools: payload.tools.filter((tool) => tool.name !== "render_chart") }); return { ok: true, status: 200, json: async () => ({ output: [{ type: "message", content: [{ type: "output_text", text: "Hello from Responses" }] }] }) }; };
  const response = await execute(command(path), { environment: environment("sk-test-secret"), openAiFetch: fetch });
  assert.equal(response.exitCode, 0, JSON.stringify(response.body)); assert.equal(calls, 1); assert.equal(url, "https://api.openai.com/v1/responses"); assert.equal(authorization, "Bearer sk-test-secret");
  const captured = JSON.parse(body) as { instructions?: unknown } & Record<string, unknown>;
  const requestInstructions = typeof captured.instructions === "string" ? captured.instructions : "";
  assert.match(requestInstructions, /Request-local timestamp: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2} \[[^\]]+\]/);
  assert.match(requestInstructions, /applies to the latest\/final message in the current messages array/);
  assert.equal(requestInstructions.indexOf(DEFAULT_AGENT_SELECTION_PROMPT) < requestInstructions.indexOf(DEFAULT_SELECTED_AGENT_PROMPT), true);
  assert.equal(requestInstructions.indexOf(DEFAULT_SELECTED_AGENT_PROMPT) < requestInstructions.indexOf("Market provenance:"), true);
  captured.instructions = "Market provenance: FIN 101.25 USD as-of 2026-01-01T00:00:00.000Z";
  body = JSON.stringify(captured);
   assert.equal(body, JSON.stringify({ model: "gpt-5.6-luna", input: [{ role: "user", content: "Hello World" }], tools: [{ type: "function", name: "fetch_page", description: "Fetch an HTTPS page with Obscura and return bounded rendered Markdown or HTML content. If pagination is provided, get as many rows from a single API call as much as possible within the range of data to reduce the number of API calls.", parameters: { type: "object", required: ["url"], properties: { url: { type: "string", format: "uri", pattern: "^https://" }, format: { type: "string", enum: ["markdown", "html", "original"], description: "Rendered output format; html returns the post-JavaScript DOM" } } } }, { type: "function", name: "bash", description: "Run an arbitrary host bash command from the current working directory after mandatory interactive shell:write approval. This grants arbitrary host authority and is not sandboxed; review the full command before approval. Quote paths containing spaces, prefer dedicated tools for file operations when available, and use the working-directory setting instead of changing directories with cd. Output is bounded and commands time out after 10 seconds.", parameters: { type: "object", required: ["command"], additionalProperties: false, properties: { command: { type: "string", minLength: 1, maxLength: 4096 } } } }, { type: "function", name: "spawn_agent", description: "Start a bounded read-only background research agent. Omit mode for the legacy immediate agent metadata response; mode 'blocking' waits and returns a terminal envelope; mode 'async' returns a callbackId and durably records a background_agent_callback tool result after the originating spawn result.", parameters: { type: "object", properties: { task: { type: "string" }, mode: { type: "string", enum: ["blocking", "async"] } }, required: ["task"] } }, ... [{ type: "function", name: "list_agents", description: "List live background agents for this session", parameters: { type: "object", properties: {}, additionalProperties: false } }, { type: "function", name: "get_agent", description: "get_agent for a background agent", parameters: { type: "object", required: ["agentId"] } }], { type: "function", name: "wait_agent", description: "wait_agent for a background agent", parameters: { type: "object", required: ["agentId"] } }, { type: "function", name: "read_agent_output", description: "read_agent_output for a background agent", parameters: { type: "object", required: ["agentId"] } }, { type: "function", name: "cancel_agent", description: "cancel_agent for a background agent", parameters: { type: "object", required: ["agentId"] } }], instructions: "Market provenance: FIN 101.25 USD as-of 2026-01-01T00:00:00.000Z", reasoning: { effort: "high" } })); assert.equal(body.includes("sk-test-secret"), false);
  const events = new EventLog(path).read(); assert.equal(events.ok, true); if (events.ok) { assert.equal(events.value.filter((event) => event.kind === "EffectClaimed").length, 1); assert.equal(events.value.filter((event) => event.kind === "EffectRecorded").length, 1); assert.equal(events.value.find((event) => event.kind === "ProviderTurnStarted" && event.data.model === "gpt-5.6-luna") !== undefined, true); }
  assert.match(JSON.stringify(response.body), /Hello from Responses/);
  const retry = await execute(command(path), { environment: environment(undefined), openAiFetch: fetch });
  assert.equal(retry.exitCode, 0, JSON.stringify(retry.body)); assert.equal((retry.body as { alreadyComplete?: boolean }).alreadyComplete, true); assert.equal(calls, 1);
});

test("provider failures are secret-safe, durable, and exact retries do not fetch", async () => {
  const path = journal(); let calls = 0;
  const fetch: OpenAiFetch = async () => { calls += 1; throw new Error("OPENAI_API_KEY=sk-secret-never-durable"); };
  const first = await execute(command(path), { environment: environment("sk-secret-never-durable"), openAiFetch: fetch });
  const retry = await execute(command(path), { environment: environment(undefined), openAiFetch: fetch });
  assert.equal(first.exitCode, 2); assert.equal(retry.exitCode, 2); assert.equal(calls, 1);
  assert.equal((retry.body as { alreadyComplete?: boolean; recordedOutcome?: string }).alreadyComplete, true); assert.equal((retry.body as { recordedOutcome?: string }).recordedOutcome, "failed");
  const journalText = readFileSync(path, "utf8"); assert.equal(`${JSON.stringify(first.body)}${JSON.stringify(retry.body)}${journalText}`.includes("sk-secret-never-durable"), false);
  const replay = await execute(["replay", "--journal", path, "--session", "responses-1", "--format", "json"], { environment: environment("sk-secret-never-durable"), openAiFetch: fetch });
  assert.equal(replay.exitCode, 0); assert.equal(calls, 1); assert.equal(JSON.stringify(replay.body).includes("sk-secret-never-durable"), false);
});

test("prefixed credential assignments are redacted from durable, projected, replay, and CLI surfaces", async () => {
  const sentinel = "sentinel-openai-value"; const path = journal();
  const prompt = `OPENAI_API_KEY=${sentinel}`;
  const fetch: OpenAiFetch = async () => ({ ok: true, status: 200, json: async () => ({ output: [{ type: "message", content: [{ type: "output_text", text: `openAiApiKey=${sentinel}` }] }] }) });
  const response = await execute(command(path, "redacted-prompt", prompt), { environment: environment("sk-test"), openAiFetch: fetch });
  assert.equal(response.exitCode, 0, JSON.stringify(response.body));
  const log = new EventLog(path); log.append("responses-1", { kind: "ToolSucceeded", data: { callId: "tool", preview: `vendor-api-key=${sentinel}`, truncated: false } });
  const events = log.read(); assert.equal(events.ok, true); if (events.ok) assert.equal(JSON.stringify(projectHistory(events.value, "responses-1")).includes(sentinel), false);
  const replay = await execute(["replay", "--journal", path, "--session", "responses-1", "--format", "json"]);
  const durableAndCli = `${readFileSync(path, "utf8")}${JSON.stringify(response.body)}${JSON.stringify(replay.body)}`;
  assert.equal(durableAndCli.includes(sentinel), false);
  for (const name of ["OPENAI_API_KEY", "vendor-api-key", "openAiApiKey"]) assert.equal(JSON.stringify(redactJson({ [name]: sentinel })).includes(sentinel), false);
  assert.equal(JSON.stringify(redactJson("The API key is documented here")).includes("[REDACTED]"), false);
});

test("non-success and malformed Responses outputs settle and are not retried", async () => {
  const cases: readonly OpenAiFetch[] = [async () => ({ ok: false, status: 401, json: async () => ({}) }), async () => ({ ok: true, status: 200, json: async () => ({ output: [] }) })];
  for (const source of cases) {
    const path = journal(); let calls = 0; const fetch: OpenAiFetch = async (url, init) => { calls += 1; return source(url, init); };
    const first = await execute(command(path), { environment: environment("sk-test"), openAiFetch: fetch }); const retry = await execute(command(path), { environment: environment("sk-test"), openAiFetch: fetch });
    assert.equal(first.exitCode, 2); assert.equal(retry.exitCode, 2); assert.match(JSON.stringify(first.body), /OPENAI_RESPONSES_(HTTP_FAILURE|RESPONSE_INVALID)/); assert.equal(calls, 1);
  }
});

test("Responses HTTP failures preserve safe server diagnostics", async () => {
  const path = journal();
  const fetch: OpenAiFetch = async () => ({ ok: false, status: 401, headers: { "x-request-id": "req-test" }, json: async () => ({ error: { code: "invalid_api_key", message: "The API key is invalid" } }) });
  const response = await execute(command(path), { environment: environment("sk-test"), openAiFetch: fetch });
  assert.equal(response.exitCode, 2);
  assert.deepEqual(response.body, { error: { code: "OPENAI_RESPONSES_HTTP_FAILURE", message: "OPENAI_RESPONSES_HTTP_FAILURE: HTTP 401: invalid_api_key: The API key is invalid: request_id=req-test" } });
});

test("Responses function output never invokes a local tool", async () => {
  const log = new EventLog(journal()); log.admit({ sessionId: "s", promptId: "p", prompt: "hello", delivery: "queue" });
  const provider = new OpenAIResponsesProvider("sk-test", async () => ({ ok: true, status: 200, json: async () => ({ output: [{ type: "message", content: [{ type: "output_text", text: "safe" }] }, { type: "function_call", call_id: "call-1", name: "unexpected" }] }) }));
  const result = await new Runner(log, provider, new ToolRegistry(new Map())).run("s"); assert.equal(result.ok, true, JSON.stringify(result));
  const events = log.read(); assert.equal(events.ok, true); if (events.ok) { assert.equal(events.value.some((event) => event.kind === "ToolCalled"), false); assert.equal(events.value.some((event) => event.kind === "ToolFailed" && event.data.code === "PROVIDER_TOOL_DEFERRED"), true); }
});

test("OAuth Responses parses local arguments and continues with function_call_output", async () => {
  const calls: string[] = [];
  const provider = new OpenAIResponsesProvider("oauth-access", async (_url, init) => {
    calls.push(init.body);
    return { ok: true, status: 200, json: async () => calls.length === 1
      ? { output: [{ type: "function_call", call_id: "fetch-call", name: "fetch_page", arguments: "{\"url\":\"https://example.test\"}" }] }
      : { output: [{ type: "message", content: [{ type: "output_text", text: "continued" }] }] } };
  }, { accountId: "account-test" });
  const fetchPage: ToolDefinition<{ url: string }, { title: string }> = {
    advertisement: { name: "fetch_page", description: "Fetch", inputSchema: { type: "object" } },
    decode: (input) => typeof input === "object" && input !== null && "url" in input && typeof input.url === "string" ? { ok: true, value: { url: input.url } } : { ok: false, error: { code: "TOOL_ARGUMENT_INVALID", message: "Invalid input" } },
    authorize: () => ({ ok: true, value: undefined }), execute: () => ({ ok: true, value: { title: "Example" } }), encode: (value) => value,
  };
  const log = new EventLog(journal()); log.admit({ sessionId: "s", promptId: "p", prompt: "fetch", delivery: "queue" });
  const result = await new Runner(log, provider, new ToolRegistry(new Map([["fetch_page", fetchPage]]))).run("s");
  assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(calls.length, 2);
   assert.match(calls[1] ?? "", /"type":"function_call"/); assert.match(calls[1] ?? "", /"type":"function_call_output"/); assert.match(calls[1] ?? "", /"call_id":"fetch-call"/); assert.match(calls[1] ?? "", /"name":"fetch_page"/);
});

test("Responses malformed function arguments are returned to the model for a final answer", async () => {
  let calls = 0;
  const payloads: string[] = [];
  const provider = new OpenAIResponsesProvider("oauth-access", async (_url, init) => { calls += 1; payloads.push(init.body); return { ok: true, status: 200, json: async () => calls === 1 ? ({ output: [{ type: "function_call", call_id: "bad-fetch", name: "fetch_page", arguments: "{" }] }) : ({ output: [{ type: "message", content: [{ type: "output_text", text: "I could not use that request because its arguments were invalid." }] }] }) }; }, { accountId: "account-test" });
  const fetchPage: ToolDefinition<{ url: string }, { title: string }> = { advertisement: { name: "fetch_page", description: "Fetch", inputSchema: { type: "object" } }, decode: () => ({ ok: false, error: { code: "TOOL_ARGUMENT_INVALID", message: "Invalid input" } }), authorize: () => ({ ok: true, value: undefined }), execute: () => ({ ok: true, value: { title: "unused" } }), encode: (value) => value };
  const log = new EventLog(journal()); log.admit({ sessionId: "s", promptId: "p", prompt: "fetch", delivery: "queue" });
  const result = await new Runner(log, provider, new ToolRegistry(new Map([["fetch_page", fetchPage]]))).run("s");
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(calls, 2);
  assert.match(payloads[1] ?? "", /TOOL_ARGUMENT_INVALID/);
  assert.match(payloads[1] ?? "", /Invalid input/);
});

test("fake execution remains available through the existing path", async () => {
  const response = await execute(["exec", "hello", "--provider", "fake", "--exchange", "paper", "--journal", journal(), "--session", "fake-1", "--format", "json"]);
  assert.equal(response.exitCode, 0, JSON.stringify(response.body)); assert.match(JSON.stringify(response.body), /Fake provider response/);
});

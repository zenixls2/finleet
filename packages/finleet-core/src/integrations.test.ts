import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AgentCatalog, AnthropicResolver, ConnectorRegistry, ModelCatalogService, OpenAICompatibleResolver, TrustedPluginRegistry, parseCatalog, type CatalogCache, type CatalogExecution, type CompatibleFetch } from "./integrations.js";
import type { ProviderEvent, ProviderRequest } from "./runtime.js";

const cachePath = (): string => join(mkdtempSync(join(tmpdir(), "finleet-integrations-")), "catalog.json");
const catalog: CatalogCache = { schemaVersion: 1, source: "models.dev-cache", models: [{ id: "openai/gpt-test", provider: "openai", model: "gpt-test", displayName: "Test", capabilities: ["chat"], modalities: ["text"], contextWindow: 4096, execution: { adapter: "ai-sdk/openai-compatible", protocol: "openai-chat-completions", baseUrl: "https://api.example/v1", apiKeyEnv: "OPENAI_API_KEY" } }] };

test("catalog validation rejects invalid records and sync falls back to cache", async () => {
  assert.equal(parseCatalog({ models: [{ provider: "openai" }] }).ok, false);
  const path = cachePath(); writeFileSync(path, JSON.stringify(catalog)); const service = new ModelCatalogService();
  const result = await service.sync(path, { remote: true, url: "https://catalog.example/models", fetch: async () => ({ ok: true, status: 200, json: async () => ({ invalid: true }) }) });
  assert.equal(result.ok, true); if (result.ok) assert.equal(result.value.source, "fallback");
});

test("resolver reports missing credentials without fetching", () => {
  let calls = 0; const fetch: CompatibleFetch = async () => { calls += 1; return new Response("{}"); };
  const resolver = new OpenAICompatibleResolver({ get: () => undefined }, fetch);
  const result = resolver.resolveCatalog("openai", "openai/gpt-test", catalog);
  assert.equal(result.ok, false); if (!result.ok) assert.equal(result.error.code, "PROVIDER_CREDENTIAL_MISSING"); assert.equal(calls, 0);
});

test("resolver rejects a location whose adapter contract does not match the catalog", () => {
  const resolver = new OpenAICompatibleResolver({ get: () => "key" }, globalThis.fetch);
  const result = resolver.resolve({ providerId: "openai", modelId: "openai/gpt-test", baseUrl: "https://api.example/v1", apiKeyEnv: "OTHER_KEY" }, catalog);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "PROVIDER_LOCATION_INVALID");
});

test("resolver rejects a catalog execution with a mismatched protocol", () => {
  const forgedExecution = { adapter: "ai-sdk/openai-compatible", protocol: "anthropic-messages", baseUrl: "https://api.example/v1", apiKeyEnv: "OPENAI_API_KEY" } as unknown as CatalogExecution;
  const mismatched: CatalogCache = { ...catalog, models: [{ id: "openai/gpt-test", provider: "openai", model: "gpt-test", displayName: "Test", capabilities: ["chat"], modalities: ["text"], contextWindow: 4096, execution: forgedExecution }] };
  const resolver = new OpenAICompatibleResolver({ get: () => "key" }, globalThis.fetch);
  const result = resolver.resolve({ providerId: "openai", modelId: "openai/gpt-test", baseUrl: "https://api.example/v1", apiKeyEnv: "OPENAI_API_KEY" }, mismatched);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "PROVIDER_NATIVE_UNSUPPORTED");
});

test("Anthropic resolver rejects a catalog execution with a mismatched protocol", () => {
  const mismatched: CatalogCache = { schemaVersion: 1, source: "models.dev-cache", models: [{ id: "anthropic-like/claude-test", provider: "anthropic-like", model: "claude-test", displayName: "Claude Test", capabilities: [], modalities: [], contextWindow: 4096, execution: { adapter: "ai-sdk/anthropic", protocol: "openai-chat-completions", baseUrl: "https://anthropic.example", apiKeyEnv: "ANTHROPIC_KEY" } as unknown as CatalogExecution }] };
  const resolver = new AnthropicResolver({ get: () => "key" }, globalThis.fetch);
  const result = resolver.resolve({ providerId: "anthropic-like", modelId: "anthropic-like/claude-test", baseUrl: "https://anthropic.example", apiKeyEnv: "ANTHROPIC_KEY" }, mismatched);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "PROVIDER_NATIVE_UNSUPPORTED");
});

test("agent capabilities and permission-filtered deferred extensions are visible safely", () => {
  const agents = new AgentCatalog([{ id: "primary", kind: "primary", modelId: "openai/gpt-test", requiredCapabilities: ["chat"], permissions: ["market:read"], budget: { maxTurns: 1, maxContextChars: 100 } }, { id: "sub", kind: "subagent", modelId: "openai/gpt-test", requiredCapabilities: ["vision"], permissions: [], budget: { maxTurns: 1, maxContextChars: 100 } }]);
  assert.deepEqual(agents.visible(catalog).map((agent) => agent.id), ["primary"]); const primary = agents.resolvePrimary("primary", catalog); assert.equal(primary.ok, true);
  if (primary.ok) { const connectors = new ConnectorRegistry([{ id: "disabled", kind: "stdio-mcp", enabled: false, requiredPermissions: [], mode: "deferred" }, { id: "account", kind: "native-exchange-api", enabled: true, requiredPermissions: ["account:read"], mode: "deferred" }]); const plugins = new TrustedPluginRegistry([{ id: "market", enabled: true, requiredPermissions: ["market:read"], mode: "deferred" }]); assert.deepEqual(connectors.visibleFor(primary.value), []); assert.deepEqual(plugins.visibleFor(primary.value).map((plugin) => plugin.id), ["market"]); }
});

test("provider credentials stay out of provider serialization and cache files", () => {
  const path = cachePath(); writeFileSync(path, JSON.stringify(catalog)); const fetch: CompatibleFetch = async () => new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }), { headers: { "content-type": "application/json" } }); const provider = new OpenAICompatibleResolver({ get: () => "secret-key" }, fetch).resolveCatalog("openai", "openai/gpt-test", catalog);
  assert.equal(provider.ok, true); if (provider.ok) assert.equal(JSON.stringify(provider.value).includes("secret-key"), false); assert.equal(readFileSync(path, "utf8").includes("secret-key"), false);
});

test("OpenAI-compatible adapter uses one injected request and preserves provider tool IDs", async () => {
  let url = ""; let authorization = ""; let body = ""; const fetch: CompatibleFetch = async (input, init) => { url = input.toString(); authorization = new Headers(init?.headers).get("authorization") ?? ""; body = typeof init?.body === "string" ? init.body : ""; return new Response(JSON.stringify({ choices: [{ finish_reason: "length", message: { content: "ok", tool_calls: [{ id: "provider-call-7", type: "function", function: { name: "remote_tool", arguments: "{}" } }] } }], usage: { prompt_tokens: 3, completion_tokens: 2 } }), { headers: { "content-type": "application/json" } }); };
  const resolved = new OpenAICompatibleResolver({ get: () => "private-key" }, fetch).resolveCatalog("openai", "openai/gpt-test", catalog); assert.equal(resolved.ok, true);
  if (resolved.ok) { const request: ProviderRequest = { providerId: "openai", modelId: "openai/gpt-test", messages: [{ role: "user", content: "hello", eventId: "e" }], system: "", tools: [{ name: "remote_tool", description: "Remote", inputSchema: { type: "object", properties: {} } }] }; const events: ProviderEvent[] = []; for await (const event of resolved.value.stream(request)) events.push(event); assert.equal(url, "https://api.example/v1/chat/completions"); assert.equal(authorization, "Bearer private-key"); assert.equal(body.includes("private-key"), false); assert.deepEqual(events.find((event) => event.type === "provider_tool_call"), { type: "provider_tool_call", callId: "provider-call-7", name: "remote_tool", arguments: {}, execution: "local" }); assert.deepEqual(events.at(-1), { type: "finished", finishReason: "length", usage: { inputTokens: 3, outputTokens: 2 } }); }
});

test("real models.dev provider maps normalize trusted adapters and retain native discovery", () => {
  const parsed = parseCatalog({ native: { id: "native", name: "Native", npm: "@ai-sdk/anthropic", api: null, env: ["NATIVE_KEY"], doc: "https://native.example/docs", models: { chat: { id: "chat", name: "Native Chat", reasoning: true, interleaved: { field: "reasoning_content" }, modalities: { input: ["text"], output: ["text"] }, limit: { context: 2048 } } } }, compatible: { id: "compatible", name: "Compatible", npm: "@ai-sdk/openai-compatible", api: "https://compatible.example/v1", env: ["COMPATIBLE_KEY"], doc: "https://compatible.example/docs", models: { chat: { id: "chat", name: "Compatible Chat", tool_call: true, modalities: { input: ["text"], output: ["text"] }, limit: { context: 4096 } } } } });
  assert.equal(parsed.ok, true); if (!parsed.ok) return;
  assert.equal(parsed.value.models.length, 2); assert.equal(parsed.value.models[0]?.contextWindow, 2048); assert.deepEqual(parsed.value.models[0]?.modalities, ["input:text", "output:text"]); assert.equal(parsed.value.models[0]?.capabilities.includes("interleaved"), true); assert.equal(parsed.value.models[1]?.execution?.adapter, "ai-sdk/openai-compatible");
  const resolver = new OpenAICompatibleResolver({ get: () => "key" }, globalThis.fetch);
  const native = resolver.resolveCatalog("native", "native/chat", parsed.value);
  assert.equal(native.ok, false); if (!native.ok) assert.equal(native.error.code, "PROVIDER_NATIVE_UNSUPPORTED");
});

test("remote malformed metadata falls back instead of being normalized", async () => {
  const path = cachePath();
  writeFileSync(path, JSON.stringify(catalog));
  const result = await new ModelCatalogService().sync(path, { remote: true, url: "https://catalog.example/models", fetch: async () => ({ ok: true, status: 200, json: async () => ({ provider: { id: "provider", name: "Provider", npm: "@ai-sdk/openai-compatible", api: "https://api.example", env: ["KEY"], models: { model: { id: "model", name: "Model", modalities: "invalid", limit: { context: 100 } } } } }) }) });
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.value.source, "fallback");
});

test("remote invalid capability and output-limit metadata falls back", async () => {
  const path = cachePath();
  writeFileSync(path, JSON.stringify(catalog));
  const result = await new ModelCatalogService().sync(path, { remote: true, url: "https://catalog.example/models", fetch: async () => ({ ok: true, status: 200, json: async () => ({ provider: { id: "provider", name: "Provider", npm: "@ai-sdk/openai-compatible", api: "https://api.example", env: ["KEY"], models: { model: { id: "model", name: "Model", reasoning: "yes", modalities: { input: ["text"], output: ["text"] }, limit: { context: 100, output: -1 } } } } }) }) });
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.value.source, "fallback");
});

test("Anthropic adapter uses the official Messages SSE protocol and preserves tool calls", async () => {
  const anthropicCatalog: CatalogCache = { schemaVersion: 1, source: "models.dev-cache", models: [{ id: "anthropic-like/claude-test", provider: "anthropic-like", model: "claude-test", displayName: "Claude Test", capabilities: ["tool_call"], modalities: ["input:text", "output:text"], contextWindow: 4096, execution: { adapter: "ai-sdk/anthropic", protocol: "anthropic-messages", baseUrl: "https://anthropic.example", apiKeyEnv: "ANTHROPIC_KEY" } }] };
  let url = ""; let apiKey = ""; let body = ""; const sse = ["event: message_start", "data: {\"type\":\"message_start\",\"message\":{\"id\":\"msg-1\",\"type\":\"message\",\"role\":\"assistant\",\"model\":\"claude-test\",\"content\":[],\"stop_reason\":null,\"stop_sequence\":null,\"usage\":{\"input_tokens\":2,\"output_tokens\":0}}}", "", "event: content_block_start", "data: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"tool_use\",\"id\":\"toolu-1\",\"name\":\"remote_tool\",\"input\":{}}}", "", "event: content_block_delta", "data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\"{}\"}}", "", "event: content_block_stop", "data: {\"type\":\"content_block_stop\",\"index\":0}", "", "event: message_delta", "data: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"tool_use\",\"stop_sequence\":null},\"usage\":{\"output_tokens\":1}}", "", "event: message_stop", "data: {\"type\":\"message_stop\"}", "", ""].join("\n");
  const fetch: CompatibleFetch = async (input, init) => { url = input.toString(); apiKey = new Headers(init?.headers).get("x-api-key") ?? ""; body = typeof init?.body === "string" ? init.body : ""; return new Response(sse, { headers: { "content-type": "text/event-stream" } }); };
  const resolved = new AnthropicResolver({ get: () => "private-anthropic-key" }, fetch).resolveCatalog("anthropic-like", "anthropic-like/claude-test", anthropicCatalog); assert.equal(resolved.ok, true);
  if (!resolved.ok) return; const events: ProviderEvent[] = []; for await (const event of resolved.value.stream({ providerId: "anthropic-like", modelId: "anthropic-like/claude-test", system: "System", messages: [{ role: "user", content: "hello", eventId: "user-1" }], tools: [{ name: "remote_tool", description: "Remote", inputSchema: { type: "object", properties: {} } }] })) events.push(event);
  assert.equal(url, "https://anthropic.example/messages"); assert.equal(apiKey, "private-anthropic-key"); assert.equal(body.includes("private-anthropic-key"), false); assert.equal(body.includes("\"stream\":true"), true); assert.equal(body.includes("\"model\":\"claude-test\""), true); assert.equal(body.includes("System"), true); assert.deepEqual(events.find((event) => event.type === "provider_tool_call"), { type: "provider_tool_call", callId: "toolu-1", name: "remote_tool", arguments: {}, execution: "local" }); assert.equal(events.at(-1)?.type, "finished");
});

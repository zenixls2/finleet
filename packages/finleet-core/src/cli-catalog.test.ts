import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { execute } from "./cli.js";
import { EventLog } from "./domain.js";

const temporaryPath = (name: string): string => join(mkdtempSync(join(tmpdir(), "finleet-cli-catalog-")), name);
const compatibleCatalog = (context: number): object => ({ compatible: { id: "compatible", name: "Compatible", npm: "@ai-sdk/openai-compatible", api: "https://compatible.example/v1", env: ["COMPATIBLE_KEY"], doc: "https://compatible.example/docs", models: { chat: { id: "chat", name: "Compatible Chat", modalities: { input: ["text"], output: ["text"] }, limit: { context } } } } });

test("catalog compatible execution resolves before admission and preserves secret boundaries", async () => {
  const cache = temporaryPath("catalog.json"); const journal = temporaryPath("journal.jsonl"); writeFileSync(cache, JSON.stringify(compatibleCatalog(4096)));
  const response = await execute(["exec", "hello", "--provider", "compatible", "--model", "compatible/chat", "--cache", cache, "--exchange", "paper", "--journal", journal, "--session", "catalog-1", "--format", "json"], { environment: { get: (name) => name === "COMPATIBLE_KEY" ? "private-key" : undefined }, compatibleFetch: async () => new Response(JSON.stringify({ choices: [{ message: { content: "catalog answer" } }], usage: { prompt_tokens: 2, completion_tokens: 2 } }), { headers: { "content-type": "application/json" } }) });
  assert.equal(response.exitCode, 0); assert.equal(JSON.stringify(response.body).includes("catalog answer"), true); assert.equal(readFileSync(journal, "utf8").includes("private-key"), false);
});

test("catalog context overflow fails before durable admission", async () => {
  const cache = temporaryPath("catalog.json"); const journal = temporaryPath("journal.jsonl"); writeFileSync(cache, JSON.stringify(compatibleCatalog(401)));
  const response = await execute(["exec", "hello", "--provider", "compatible", "--model", "compatible/chat", "--cache", cache, "--exchange", "paper", "--journal", journal, "--session", "catalog-overflow", "--format", "json"], { environment: { get: () => "private-key" }, compatibleFetch: globalThis.fetch });
  assert.equal(response.exitCode, 2); assert.deepEqual(response.body, { error: { code: "CONTEXT_OVERFLOW", message: "Projected request exceeds the catalog context limit before durable admission" } }); assert.equal(existsSync(journal), false);
});

test("catalog context accounting includes loaded agent instructions", async () => {
  const cache = temporaryPath("catalog.json"); const journal = temporaryPath("journal.jsonl"); const agentFile = temporaryPath("AGENT.md");
  writeFileSync(cache, JSON.stringify(compatibleCatalog(1_000))); writeFileSync(agentFile, "A".repeat(700));
  let providerCalled = false;
  const response = await execute(["exec", "hello", "--provider", "compatible", "--model", "compatible/chat", "--cache", cache, "--exchange", "paper", "--journal", journal, "--session", "agent-context-overflow", "--format", "json"], {
    environment: { get: (name) => name === "FINLEET_AGENT_FILE" ? agentFile : name === "COMPATIBLE_KEY" ? "private-key" : undefined },
    compatibleFetch: async () => { providerCalled = true; return new Response(); },
  });
  assert.equal(response.exitCode, 2);
  assert.deepEqual(response.body, { error: { code: "CONTEXT_OVERFLOW", message: "Projected request exceeds the catalog context limit before durable admission" } });
  assert.equal(providerCalled, false); assert.equal(existsSync(journal), false);
});

test("catalog execution uses the same agent-context snapshot admitted by the budget check", async () => {
  const cache = temporaryPath("catalog.json"); const journal = temporaryPath("journal.jsonl"); const agentFile = temporaryPath("AGENT.md");
  writeFileSync(cache, JSON.stringify(compatibleCatalog(4_096))); writeFileSync(agentFile, "admitted agent snapshot");
  let agentFileLookups = 0;
  const response = await execute(["exec", "hello", "--provider", "compatible", "--model", "compatible/chat", "--cache", cache, "--exchange", "paper", "--journal", journal, "--session", "agent-context-snapshot", "--format", "json"], {
    environment: { get: (name) => {
      if (name === "FINLEET_AGENT_FILE") {
        agentFileLookups += 1;
        if (agentFileLookups > 1) writeFileSync(agentFile, "changed after admission");
        return agentFile;
      }
      return name === "COMPATIBLE_KEY" ? "private-key" : undefined;
    } },
    compatibleFetch: async (_input, init) => {
      const body = String(init?.body);
      assert.equal(body.includes("admitted agent snapshot"), true);
      assert.equal(body.includes("changed after admission"), false);
      return new Response(JSON.stringify({ choices: [{ message: { content: "catalog answer" } }], usage: { prompt_tokens: 2, completion_tokens: 2 } }), { headers: { "content-type": "application/json" } });
    },
  });
  assert.equal(response.exitCode, 0); assert.equal(agentFileLookups, 1);
});

test("catalog context accounting includes projected tool-call arguments", async () => {
  const cache = temporaryPath("catalog.json"); const journal = temporaryPath("journal.jsonl");
  writeFileSync(cache, JSON.stringify(compatibleCatalog(500)));
  const log = new EventLog(journal);
  log.append("tool-context", { kind: "ToolCalled", data: { callId: "call-1", name: "fetch_page", argumentsDigest: "digest", arguments: JSON.stringify({ url: `https://${"x".repeat(180)}.example` }) } });
  const response = await execute(["exec", "hello", "--provider", "compatible", "--model", "compatible/chat", "--cache", cache, "--exchange", "paper", "--journal", journal, "--session", "tool-context", "--format", "json"], { environment: { get: () => "private-key" }, compatibleFetch: globalThis.fetch });
  assert.equal(response.exitCode, 2);
  if (response.exitCode === 2) assert.equal((response.body as { error: { code: string } }).error.code, "CONTEXT_OVERFLOW");
});

test("providers list summarizes catalog providers deterministically", async () => {
  const cache = temporaryPath("catalog.json");
  writeFileSync(cache, JSON.stringify({
    models: [
      { provider: "zeta", model: "small", displayName: "Small", capabilities: [], modalities: [] },
      { provider: "alpha", model: "chat", displayName: "Chat", capabilities: [], modalities: [], execution: { adapter: "ai-sdk/anthropic", protocol: "anthropic-messages", baseUrl: "https://alpha.example", apiKeyEnv: "ALPHA_KEY" } },
      { provider: "zeta", model: "large", displayName: "Large", capabilities: [], modalities: [], execution: { adapter: "ai-sdk/openai-compatible", protocol: "openai-chat-completions", baseUrl: "https://zeta.example", apiKeyEnv: "ZETA_KEY" } },
    ],
  }));
  const response = await execute(["providers", "list", "--cache", cache, "--format", "json"], { catalogFetch: async () => ({ ok: true, status: 200, json: async () => JSON.parse(readFileSync(cache, "utf8")) as unknown }) });
  assert.equal(response.exitCode, 0);
  assert.deepEqual(response.body, {
    providers: [
      { id: "alpha", modelCount: 1, executableModelCount: 1, models: ["chat"] },
      { id: "zeta", modelCount: 2, executableModelCount: 1, models: ["large", "small"] },
    ],
    source: "models.dev",
    advisory: "Catalog metadata does not guarantee runtime availability.",
  });
});

test("providers list uses locale-independent ordering", async () => {
  const cache = temporaryPath("catalog.json");
  writeFileSync(cache, JSON.stringify({
    models: [
      { provider: "z-provider", model: "z-model", displayName: "Z", capabilities: [], modalities: [] },
      { provider: "ä-provider", model: "ä-model", displayName: "A umlaut", capabilities: [], modalities: [] },
      { provider: "a-provider", model: "z-model", displayName: "A", capabilities: [], modalities: [] },
    ],
  }));
  const response = await execute(["providers", "list", "--cache", cache, "--format", "json"], { catalogFetch: async () => ({ ok: true, status: 200, json: async () => JSON.parse(readFileSync(cache, "utf8")) as unknown }) });
  assert.equal(response.exitCode, 0);
  const body = response.body as { providers: readonly { id: string }[] };
  assert.deepEqual(body.providers.map((provider) => provider.id), ["a-provider", "z-provider", "ä-provider"]);
});

test("providers list supports human-readable text output by default", async () => {
  const response = await execute(["providers", "list"], { catalogFetch: async () => ({ ok: true, status: 200, json: async () => ({ models: [{ provider: "alpha", model: "chat", displayName: "Chat", capabilities: [], modalities: [] }] }) }) });
  assert.equal(response.exitCode, 0);
  assert.equal(response.body, "Source: models.dev\nProviders: 1\nalpha (1 models, 0 executable)\n  chat\nCatalog metadata does not guarantee runtime availability.");
});

test("execution commands accept omitted and text formats", async () => {
  const omitted = await execute(["exec", "hello", "--provider", "fake", "--exchange", "paper", "--journal", temporaryPath("omitted.jsonl"), "--session", "format-omitted"]);
  const text = await execute(["exec", "hello", "--provider", "fake", "--exchange", "paper", "--journal", temporaryPath("text.jsonl"), "--session", "format-text", "--format", "text"]);
  assert.equal(omitted.exitCode, 0);
  assert.equal(text.exitCode, 0);
});

test("CLI help explains provider-list parameters", async () => {
  const response = await execute(["providers", "list", "--help"]);
  assert.equal(response.exitCode, 0);
  assert.equal(typeof response.body, "string");
  assert.doesNotMatch(response.body as string, /--offline.*required/);
  assert.match(response.body as string, /--cache <path>/);
  assert.match(response.body as string, /--format json/);
  assert.match(response.body as string, /--format text/);
  assert.match(response.body as string, /default/);
});

test("serve help explains loopback process configuration", async () => {
  const response = await execute(["serve", "--help"]);
  assert.equal(response.exitCode, 0);
  assert.match(response.body as string, /loopback JSON-RPC server/);
  assert.match(response.body as string, /--journal <path>/);
});

test("commands reject unsupported output formats", async () => {
  const response = await execute(["exec", "hello", "--provider", "fake", "--exchange", "paper", "--format", "yaml"]);
  assert.deepEqual(response, { exitCode: 2, body: { error: "--format must be text or json" } });
});

test("providers list falls back to the local cache only after an online failure", async () => {
  const cache = temporaryPath("catalog.json");
  writeFileSync(cache, JSON.stringify({ models: [{ provider: "cached", model: "model", displayName: "Cached", capabilities: [], modalities: [] }] }));
  const response = await execute(["providers", "list", "--cache", cache, "--format", "json"], { catalogFetch: async () => ({ ok: false, status: 503, json: async () => ({}) }) });
  assert.equal(response.exitCode, 0);
  assert.deepEqual(response.body, { providers: [{ id: "cached", modelCount: 1, executableModelCount: 0, models: ["model"] }], source: "cache-fallback", advisory: "Catalog metadata does not guarantee runtime availability." });
});

test("models sync uses models.dev when remote URL is omitted", async () => {
  const cache = temporaryPath("models-cache.json");
  const response = await execute(["models", "sync", "--cache", cache, "--remote", "--format", "json"], { catalogFetch: async (url) => {
    assert.equal(url, "https://models.dev/api.json");
    return { ok: true, status: 200, json: async () => ({ models: [{ provider: "cached", model: "model", displayName: "Model", capabilities: [], modalities: [] }] }) };
  } });
  assert.equal(response.exitCode, 0);
});

test("top-level CLI help lists the available commands", async () => {
  const response = await execute(["--help"]);
  assert.equal(response.exitCode, 0);
  assert.match(response.body as string, /providers list/);
  assert.match(response.body as string, /exec/);
});

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { execute } from "./cli.js";
import { CoreService } from "./core-service.js";
import type { OpenAiFetch } from "./integrations.js";

test("exec advertises reference lookup by default and returns workspace occurrences", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "finleet-reference-integration-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, "source.ts"), "export const greeting = 'hello';\n");
  const environment = { get: (name: string) => name === "OPENAI_API_KEY" ? "sk-test" : undefined };
  const args = (label: string): string[] => [
    "exec", "Find greeting in the workspace", "--provider", "openai-responses",
    "--model", "gpt-5.6-luna", "--reasoning-effort", "high", "--exchange", "paper",
    "--journal", join(root, `${label}.jsonl`), "--format", "json",
  ];
  const defaultTools: string[] = [];
  const defaultFetch: OpenAiFetch = async (_url, init) => {
    const payload = JSON.parse(init.body);
    assert.match(payload.instructions, /Market provenance:/);
    defaultTools.push(...(payload.tools as { name: string }[]).map((tool) => tool.name));
    assert.deepEqual(payload.tools.find((tool: { name: string }) => tool.name === "spawn_agent").parameters.properties.profile.enum, ["read-only-research", "code-maintenance"]);
    return { ok: true, status: 200, json: async () => ({ output: [{ type: "message", content: [{ type: "output_text", text: "done" }] }] }) };
  };
  const ordinary = await execute(args("default"), { environment, workingDirectory: root, openAiFetch: defaultFetch });
  assert.equal(ordinary.exitCode, 0, JSON.stringify(ordinary.body));
  assert.equal(defaultTools.includes("find_references"), true);
  assert.equal(defaultTools.includes("dependency_reference"), true);

  let calls = 0;
  const codeFetch: OpenAiFetch = async (_url, init) => {
    calls++;
    const payload = JSON.parse(init.body);
    assert.match(payload.instructions, /Market provenance:/);
    assert.deepEqual(payload.tools.find((tool: { name: string }) => tool.name === "spawn_agent").parameters.properties.profile.enum, ["read-only-research", "code-maintenance"]);
    assert.deepEqual((payload.tools as { name: string }[]).map((tool) => tool.name), defaultTools);
    assert.equal((payload.tools as { name: string }[]).filter((tool) => tool.name === "find_references").length, 1);
    assert.equal((payload.tools as { name: string }[]).filter((tool) => tool.name === "dependency_reference").length, 1);
    if (calls === 1) {
      return { ok: true, status: 200, json: async () => ({ output: [{ type: "function_call", call_id: "reference-call", name: "find_references", arguments: '{"identifier":"greeting","limit":2}' }] }) };
    }
    const output = (payload.input as { type?: string; output?: string }[]).find((item) => item.type === "function_call_output");
    assert.ok(output?.output);
    assert.deepEqual(JSON.parse(output.output), {
      references: [{ path: "source.ts", line: 1, column: 14, excerpt: "export const greeting = 'hello';" }],
      truncated: false,
    });
    return { ok: true, status: 200, json: async () => ({ output: [{ type: "message", content: [{ type: "output_text", text: "Found greeting." }] }] }) };
  };
  let approvals = 0;
  const coding = await execute(args("reference"), { environment, workingDirectory: root, openAiFetch: codeFetch, approver: async (request) => {
    approvals++;
    assert.equal(request.toolName, "find_references");
    assert.equal(request.requiredPermission, "shell:read");
    return { decision: "allow-once" };
  } });
  assert.equal(coding.exitCode, 0, JSON.stringify(coding.body));
  assert.equal(calls, 2);
  assert.equal(approvals, 1);
  assert.match(JSON.stringify(coding.body), /Found greeting/);
});

test("native dependency lookup resolves installed dependency references locally through the model tool flow", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "finleet-dependency-integration-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dependency = join(root, "node_modules", "greeting-lib");
  mkdirSync(dependency, { recursive: true });
  writeFileSync(join(dependency, "package.json"), JSON.stringify({ version: "1.2.3", types: "index.d.ts" }));
  writeFileSync(join(dependency, "index.d.ts"), "export declare function greet(): string;\n");
  const environment = { get: (name: string) => name === "OPENAI_API_KEY" ? "sk-test" : undefined };
  const args = [
    "exec", "How do I use greeting-lib?", "--provider", "openai-responses",
    "--model", "gpt-5.6-luna", "--reasoning-effort", "high", "--exchange", "paper",
    "--journal", join(root, "journal.jsonl"), "--format", "json",
  ];
  let calls = 0;
  let approvals = 0;
  const openAiFetch: OpenAiFetch = async (_url, init) => {
    calls++;
    const payload = JSON.parse(init.body);
    assert.equal((payload.tools as { name: string }[]).filter((tool) => tool.name === "dependency_reference").length, 1);
    if (calls === 1) {
      return { ok: true, status: 200, json: async () => ({ output: [{ type: "function_call", call_id: "dependency-call", name: "dependency_reference", arguments: '{"packageName":"greeting-lib","query":"greet"}' }] }) };
    }
    const output = (payload.input as { type?: string; output?: string }[]).find((item) => item.type === "function_call_output");
    assert.ok(output?.output);
    const result = JSON.parse(output.output);
    assert.equal(result.packageName, "greeting-lib");
    assert.equal(result.version, "1.2.3");
    assert.deepEqual(result.versionSource, { kind: "installed", source: "node_modules/greeting-lib/package.json" });
    assert.deepEqual(result.references.map((reference: { kind: string; source: string }) => [reference.kind, reference.source]), [["declaration", "node_modules/greeting-lib/index.d.ts"]]);
    assert.match(result.references[0].excerpt, /function greet/);
    return { ok: true, status: 200, json: async () => ({ output: [{ type: "message", content: [{ type: "output_text", text: "Use greet()." }] }] }) };
  };
  const response = await execute(args, {
    environment, workingDirectory: root, openAiFetch,
    approver: async (request) => {
      approvals++;
      assert.equal(request.toolName, "dependency_reference");
      assert.equal(request.requiredPermission, "shell:read");
      return { decision: "allow-once" };
    },
  });
  assert.equal(response.exitCode, 0, JSON.stringify(response.body));
  assert.equal(calls, 2);
  assert.equal(approvals, 1);
  assert.match(JSON.stringify(response.body), /Use greet/);
});

test("CoreService enables read-only background reference workers", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "finleet-code-background-integration-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, "source.ts"), "export const greeting = 'hello';\n");
  const environment = { get: (name: string) => name === "OPENAI_API_KEY" ? "sk-test" : undefined };
  {
    let parentCalls = 0;
    let childCalls = 0;
    let approvals = 0;
    const openAiFetch: OpenAiFetch = async (_url, init) => {
      const payload = JSON.parse(init.body);
      const names = (payload.tools as { name: string }[]).map(tool => tool.name);
      const output = (payload.input as { type?: string; output?: string }[]).find(item => item.type === "function_call_output");
      if (!names.includes("spawn_agent")) {
        childCalls++;
        assert.deepEqual(names, ["find_references"]);
        assert.doesNotMatch(payload.instructions, /Market provenance:/);
        if (childCalls === 1) {
          return { ok: true, status: 200, json: async () => ({ output: [{ type: "function_call", call_id: "child-reference", name: "find_references", arguments: '{"identifier":"greeting"}' }] }) };
        }
        assert.match(output?.output ?? "", /source.ts/);
        return { ok: true, status: 200, json: async () => ({ output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify({ summary: "Found greeting", changedFiles: [], verification: [], remainingIssues: [] }) }] }] }) };
      }
      parentCalls++;
      if (parentCalls === 1) {
        return { ok: true, status: 200, json: async () => ({ output: [{ type: "function_call", call_id: "spawn-reference", name: "spawn_agent", arguments: '{"task":"Find greeting references","profile":"code-maintenance","mode":"blocking"}' }] }) };
      }
      assert.ok(output?.output);
      assert.match(payload.instructions, /Market provenance:/);
      assert.match(output.output, /"status":"completed"/);
      assert.match(output.output, /Found greeting/);
      return { ok: true, status: 200, json: async () => ({ output: [{ type: "message", content: [{ type: "output_text", text: "Done." }] }] }) };
    };
    const result = await execute([
      "exec", "Find greeting references", "--provider", "openai-responses",
      "--model", "gpt-5.6-luna", "--reasoning-effort", "high", "--exchange", "paper",
      "--journal", join(root, "worker.jsonl"), "--format", "json",
    ], { environment, workingDirectory: root, openAiFetch, approver: async request => {
      approvals++;
      assert.equal(request.requiredPermission, "shell:read");
      assert.equal(request.toolName, "find_references");
      assert.ok(request.childSessionId);
      return { decision: "allow-once" };
    } });
    assert.equal(result.exitCode, 0, JSON.stringify(result.body));
    assert.equal(parentCalls, 2);
    assert.equal(childCalls, 2);
    assert.equal(approvals, 1);
  }
});

test("native official npm retrieval uses default or injected transport and preserves version provenance", async t => {
  const root = mkdtempSync(join(tmpdir(), "finleet-official-reference-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, "package-lock.json"), JSON.stringify({ packages: { "node_modules/greeting-lib": { version: "1.2.3" } } }));
  const environment = { get: (name: string) => name === "OPENAI_API_KEY" ? "sk-test" : undefined };
  for (const injected of [false, true]) {
    const requests: string[] = [];
    const permissions: string[] = [];
    let calls = 0;
    const transport = async (url: string, init: RequestInit) => {
      requests.push(url);
      assert.equal(init.redirect, "error");
      return new Response(JSON.stringify({ name: "greeting-lib", version: "1.2.3", readme: "Use greet()." }), { headers: { "content-type": "application/json" } });
    };
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url, init) => { assert.equal(injected, false); return transport(String(url), init ?? {}); });
    const service = new CoreService({
      args: ["exec", "How do I use greeting-lib?", "--provider", "openai-responses", "--model", "gpt-5.6-luna", "--reasoning-effort", "high", "--exchange", "paper", "--journal", join(root, `${injected}.jsonl`), "--format", "json"],
      environment,
      workingDirectory: root,
      compatibleFetch: async () => assert.fail("Unexpected compatible fetch"),
      oauthFetch: async () => assert.fail("Unexpected OAuth fetch"),
      ...(injected ? { officialDocumentationFetch: transport } : {}),
      openAiFetch: async (_url, init) => {
        calls++;
        const payload = JSON.parse(init.body);
        assert.equal((payload.tools as { name: string }[]).some(tool => tool.name === "dependency_reference"), true);
        if (calls === 1) {
          return { ok: true, status: 200, json: async () => ({ output: [{ type: "function_call", call_id: "dependency-call", name: "dependency_reference", arguments: '{"packageName":"greeting-lib","query":"greet"}' }] }) };
        }
        const output = (payload.input as { type?: string; output?: string }[]).find(item => item.type === "function_call_output");
        assert.ok(output?.output);
        const result = JSON.parse(output.output);
        assert.equal(result.version, "1.2.3");
        assert.deepEqual(result.versionSource, { kind: "lockfile", source: "package-lock.json#node_modules/greeting-lib" });
        assert.deepEqual(result.references, [
          { kind: "official-documentation", source: "https://registry.npmjs.org/greeting-lib/1.2.3", excerpt: "Use greet()." },
        ]);
        return { ok: true, status: 200, json: async () => ({ output: [{ type: "message", content: [{ type: "output_text", text: "Done." }] }] }) };
      },
      localApprover: async request => {
        permissions.push(request.requiredPermission);
        assert.equal(request.toolName, "dependency_reference");
        return { decision: "allow-once" };
      },
    });
    try {
      const response = await service.submit({ sessionId: "session", promptId: "prompt", prompt: "How do I use greeting-lib?" });
      assert.equal(response.exitCode, 0, JSON.stringify(response.body));
      assert.equal(calls, 2);
      assert.equal(permissions.includes("shell:read"), true);
      assert.deepEqual(requests, ["https://registry.npmjs.org/greeting-lib/1.2.3"]);
    } finally {
      service.close();
      globalThis.fetch = originalFetch;
    }
  }
});

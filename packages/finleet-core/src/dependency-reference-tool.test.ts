import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import { DEPENDENCY_REFERENCE_TOOL_NAME, dependencyReferenceTool } from "./dependency-reference-tool.js";
import type { DependencyReferenceOptions, OfficialDocumentationRequest } from "./dependency-reference.js";
import type { Permission } from "./domain.js";
import { ToolRegistry, type ToolContext } from "./runtime.js";

async function workspace(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "finleet-dependency-tool-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return {
    root,
    async file(path: string, content: string | object) {
      const target = join(root, path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, typeof content === "string" ? content : JSON.stringify(content));
    },
  };
}

function context(workingDirectory: string, permissions: Permission[] = ["shell:read"]): ToolContext {
  return { sessionId: "session", agentId: "agent", assistantMessageId: "message", providerCallId: "call", workingDirectory, permissions: new Set(permissions) };
}

function registry(options?: DependencyReferenceOptions): ToolRegistry {
  return new ToolRegistry(new Map([[DEPENDENCY_REFERENCE_TOOL_NAME, dependencyReferenceTool(options)]]));
}

test("tool advertises read-only lookup and returns installed version, local provenance and bounded excerpts", async t => {
  const { root, file } = await workspace(t);
  await file("node_modules/pkg/package.json", { version: "1.2.3", types: "index.d.ts" });
  await file("node_modules/pkg/index.d.ts", "declare function match(): void;\n" + "x".repeat(10_000));
  const tools = registry();
  assert.equal(tools.advertised()[0]?.requiredPermission, "shell:read");
  const result = await tools.invoke(DEPENDENCY_REFERENCE_TOOL_NAME, { packageName: "pkg", query: "match" }, context(root));
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const data = result.value as { version: string; versionSource: object; references: { kind: string; source: string; excerpt: string }[]; truncated: boolean };
  assert.equal(data.version, "1.2.3");
  assert.deepEqual(data.versionSource, { kind: "installed", source: "node_modules/pkg/package.json" });
  assert.equal(data.references[0]?.kind, "declaration");
  assert.equal(data.references[0]?.source, "node_modules/pkg/index.d.ts");
  assert.equal(data.references[0]?.excerpt.length, 2_000);
  assert.equal(data.truncated, true);
  await file("node_modules/pkg/package.json", { version: "2.0.0" });
  const updated = await tools.invoke(DEPENDENCY_REFERENCE_TOOL_NAME, { packageName: "pkg" }, context(root));
  assert.ok(updated.ok);
  assert.equal((updated.value as { version: string }).version, "2.0.0");
});

test("tool rejects model-controlled paths, URLs, invalid arguments, and unauthorized or missing workspace", async t => {
  const { root } = await workspace(t);
  const tools = registry();
  const cases = [
    { packageName: "../pkg" }, { packageName: "https://example.org" }, { packageName: "pkg", url: "https://example.org" },
    { packageName: "pkg\n" },
    { packageName: "pkg", fromDirectory: root }, { packageName: "pkg", workingDirectory: root },
    { packageName: "pkg", latest: "true" }, { packageName: "pkg", query: "" }, { packageName: "pkg", query: "a".repeat(1001) },
  ];
  for (const input of cases) {
    const result = await tools.invoke(DEPENDENCY_REFERENCE_TOOL_NAME, input, context(root));
    assert.ok(!result.ok);
    assert.equal(result.error.code, "TOOL_ARGUMENT_INVALID");
  }
  const input = { packageName: "pkg" };
  for (const [ctx, code] of [
    [context(root, []), "TOOL_DENIED"],
    [context("."), "TOOL_WORKSPACE_UNAVAILABLE"],
    [context(join(root, "missing")), "TOOL_WORKSPACE_UNAVAILABLE"],
    [{ ...context(root), signal: AbortSignal.abort() }, "TOOL_CANCELLED"],
  ] as const) {
    const result = await tools.invoke(DEPENDENCY_REFERENCE_TOOL_NAME, input, ctx);
    assert.ok(!result.ok);
    assert.equal(result.error.code, code);
  }
});

test("official retrieval requires web permission, caches by workspace/version/query, and latest is explicit", async t => {
  const a = await workspace(t);
  const b = await workspace(t);
  await a.file("package-lock.json", { packages: { "node_modules/pkg": { version: "1.2.3" } } });
  await b.file("package-lock.json", { packages: { "node_modules/pkg": { version: "2.0.0" } } });
  const requests: OfficialDocumentationRequest[] = [];
  const tools = registry({
    retrieveOfficialDocumentation: async request => {
      requests.push(request);
      return { version: request.version === "latest" ? "5.0.0" : request.version, source: "https://example.org/docs", excerpt: "official docs" };
    },
  });
  const lookup = (root: string, latest = false) => tools.invoke(DEPENDENCY_REFERENCE_TOOL_NAME, { packageName: "pkg", query: "foo", latest }, context(root, ["shell:read", "web:read"]));
  const first = await lookup(a.root);
  assert.deepEqual(first, {
    ok: true, value: {
      packageName: "pkg", version: "1.2.3", versionSource: { kind: "lockfile", source: "package-lock.json#node_modules/pkg" },
      references: [{ kind: "official-documentation", source: "https://example.org/docs", excerpt: "official docs" }], truncated: false,
    },
  });
  assert.deepEqual(await lookup(a.root), first);
  const unprivileged = await tools.invoke(DEPENDENCY_REFERENCE_TOOL_NAME, { packageName: "pkg", query: "foo" }, context(a.root));
  assert.ok(unprivileged.ok);
  assert.deepEqual((unprivileged.value as { references: unknown[] }).references, []);
  await lookup(b.root);
  const latest = await lookup(a.root, true);
  assert.ok(latest.ok);
  assert.equal((latest.value as { version: string }).version, "5.0.0");
  const denied = await tools.invoke(DEPENDENCY_REFERENCE_TOOL_NAME, { packageName: "pkg", latest: true }, context(a.root));
  assert.ok(!denied.ok);
  assert.equal(denied.error.code, "TOOL_DENIED");
  const unavailable = await registry().invoke(DEPENDENCY_REFERENCE_TOOL_NAME, { packageName: "pkg", latest: true }, context(a.root, ["shell:read", "web:read"]));
  assert.ok(!unavailable.ok);
  assert.equal(unavailable.error.code, "TOOL_REFERENCE_UNAVAILABLE");
  assert.deepEqual(requests.map(request => request.version), ["1.2.3", "2.0.0", "latest"]);
});

test("local matches win even when official retrieval is allowed; invalid official source is ignored", async t => {
  const { root, file } = await workspace(t);
  await file("node_modules/pkg/package.json", { version: "1.0.0" });
  await file("node_modules/pkg/README.md", "local usage");
  let calls = 0;
  const tools = registry({
    retrieveOfficialDocumentation: async request => {
      calls++;
      return { version: request.version, source: "file:///private/docs", excerpt: "unexpected source" };
    },
  });
  const ctx = context(root, ["shell:read", "web:read"]);
  const local = await tools.invoke(DEPENDENCY_REFERENCE_TOOL_NAME, { packageName: "pkg", query: "usage" }, ctx);
  assert.ok(local.ok);
  assert.deepEqual((local.value as { references: unknown[] }).references, [
    { kind: "local-documentation", source: "node_modules/pkg/README.md", excerpt: "local usage" },
  ]);
  assert.equal(calls, 0);
  const missing = await tools.invoke(DEPENDENCY_REFERENCE_TOOL_NAME, { packageName: "pkg", query: "missing" }, ctx);
  assert.ok(missing.ok);
  assert.deepEqual((missing.value as { references: unknown[] }).references, []);
  assert.equal(calls, 1);
});

test("concurrent lookup budget is shared across workspaces and cancellation does not expose results", async t => {
  const { root } = await workspace(t);
  const other = await workspace(t);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  let calls = 0;
  const tools = registry({
    retrieveOfficialDocumentation: async () => {
      if (++calls === 8) started();
      await gate;
      return { version: "1.0.0", source: "https://example.org/docs", excerpt: "official" };
    },
  });
  const controller = new AbortController();
  const ctx = context(root, ["shell:read", "web:read"]);
  const lookup = (query: string, signal?: AbortSignal, workingDirectory = root) => tools.invoke(
    DEPENDENCY_REFERENCE_TOOL_NAME, { packageName: "pkg", latest: true, query }, { ...ctx, workingDirectory, ...(signal ? { signal } : {}) },
  );
  const pending = Array.from({ length: 8 }, (_, i) => lookup(String(i), i === 0 ? controller.signal : undefined));
  await ready;
  try {
    const overflow = await lookup("overflow", undefined, other.root);
    assert.ok(!overflow.ok);
    assert.equal(overflow.error.code, "TOOL_REFERENCE_BUSY");
    controller.abort();
  } finally {
    release();
  }
  const results = await Promise.all(pending);
  assert.ok(!results[0]?.ok);
  assert.equal(results[0]?.error.code, "TOOL_CANCELLED");
  assert.ok((await lookup("overflow", undefined, other.root)).ok);
  assert.equal(calls, 9);
});

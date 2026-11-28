import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { REFERENCE_TOOL_NAME, referenceTool } from "./reference-tools.js";
import { ToolRegistry, type ToolContext } from "./runtime.js";

function workspace(t: TestContext): string {
  const root = mkdtempSync(join(tmpdir(), "finleet-reference-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function context(workingDirectory: string): ToolContext {
  return { sessionId: "session", agentId: "agent", assistantMessageId: "message", providerCallId: "call", workingDirectory, permissions: new Set(["shell:read"]) };
}

function registry(): ToolRegistry {
  return new ToolRegistry(new Map([[REFERENCE_TOOL_NAME, referenceTool()]]));
}

test("registry advertises read-only lookup and refreshes workspace sources across calls", async (t) => {
  const root = workspace(t);
  const path = join(root, "source.ts");
  writeFileSync(path, "const message = 1;\n");
  const tools = registry();
  assert.equal(tools.advertised()[0]?.name, "find_references");
  assert.equal(tools.advertised()[0]?.requiredPermission, "shell:read");
  assert.deepEqual(await tools.invoke(REFERENCE_TOOL_NAME, { identifier: "message" }, context(root)), {
    ok: true, value: { references: [{ path: "source.ts", line: 1, column: 7, excerpt: "const message = 1;" }], truncated: false },
  });
  writeFileSync(path, "const other = message;\n");
  assert.deepEqual(await tools.invoke(REFERENCE_TOOL_NAME, { identifier: "message" }, context(root)), {
    ok: true, value: { references: [{ path: "source.ts", line: 1, column: 15, excerpt: "const other = message;" }], truncated: false },
  });
  rmSync(path);
  assert.deepEqual(await tools.invoke(REFERENCE_TOOL_NAME, { identifier: "message" }, context(root)), {
    ok: true, value: { references: [], truncated: false },
  });
});

test("registry keeps workspace context isolated and rejects model-provided paths", async (t) => {
  const first = workspace(t);
  const second = workspace(t);
  writeFileSync(join(first, "first.ts"), "message");
  writeFileSync(join(second, "second.ts"), "message");
  const tools = registry();
  for (const [root, path] of [[first, "first.ts"], [second, "second.ts"], [first, "first.ts"]] as const) {
    assert.deepEqual(await tools.invoke(REFERENCE_TOOL_NAME, { identifier: "message" }, context(root)), {
      ok: true, value: { references: [{ path, line: 1, column: 1, excerpt: "message" }], truncated: false },
    });
  }
  for (const input of [{ identifier: "message", root: second }, { identifier: "message", path: second }, { identifier: "message.*" }, { identifier: "x", limit: 101 }, { identifier: "x", limit: 0 }, { identifier: "x", limit: 1.5 }]) {
    const result = await tools.invoke(REFERENCE_TOOL_NAME, input, context(first));
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, "TOOL_ARGUMENT_INVALID");
  }
});

test("registry enforces permissions, explicit workspace, cancellation and bounded results", async (t) => {
  const root = workspace(t);
  writeFileSync(join(root, "source.ts"), "message ".repeat(120));
  const tools = registry();
  const input = { identifier: "message" };
  const denied = await tools.invoke(REFERENCE_TOOL_NAME, input, { ...context(root), permissions: new Set() });
  assert.equal(denied.ok, false);
  if (!denied.ok) assert.equal(denied.error.code, "TOOL_DENIED");
  const unavailable = await tools.invoke(REFERENCE_TOOL_NAME, input, context("."));
  assert.equal(unavailable.ok, false);
  if (!unavailable.ok) assert.equal(unavailable.error.code, "TOOL_WORKSPACE_UNAVAILABLE");
  const controller = new AbortController();
  controller.abort();
  const cancelled = await tools.invoke(REFERENCE_TOOL_NAME, input, { ...context(root), signal: controller.signal });
  assert.equal(cancelled.ok, false);
  if (!cancelled.ok) assert.equal(cancelled.error.code, "TOOL_CANCELLED");
  const limited = await tools.invoke(REFERENCE_TOOL_NAME, { ...input, limit: 2 }, context(root));
  assert.equal(limited.ok, true);
  if (limited.ok) {
    const result = limited.value as { references: unknown[]; truncated: boolean };
    assert.equal(result.references.length, 2);
    assert.equal(result.truncated, true);
  }
  const defaultLimit = await tools.invoke(REFERENCE_TOOL_NAME, input, context(root));
  assert.equal(defaultLimit.ok, true);
  if (defaultLimit.ok) assert.equal((defaultLimit.value as { references: unknown[] }).references.length, 20);
});

test("registry preserves the serialized output budget and never returns a cached result for a missing workspace", async (t) => {
  const root = workspace(t);
  writeFileSync(join(root, "source.ts"), `message ${"\t".repeat(230)}\n`.repeat(100));
  const tools = registry();
  const input = { identifier: "message", limit: 100 };
  const result = await tools.invoke(REFERENCE_TOOL_NAME, input, context(root));
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.ok(Buffer.byteLength(JSON.stringify(result.value)) <= 32 * 1024);
    assert.equal((result.value as { truncated: boolean }).truncated, true);
  }
  rmSync(root, { recursive: true });
  const missing = await tools.invoke(REFERENCE_TOOL_NAME, input, context(root));
  assert.equal(missing.ok, false);
});

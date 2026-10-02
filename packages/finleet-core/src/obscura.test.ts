import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { obscuraFetchTool } from "./obscura.js";
import type { Permission } from "./domain.js";
import type { ToolContext } from "./runtime.js";

const context: ToolContext = { sessionId: "s", agentId: "a", assistantMessageId: "m", providerCallId: "p", permissions: new Set<Permission>(["web:read"]) };

test("Obscura fetch tool validates HTTPS URLs and excludes URL credentials", () => {
  const tool = obscuraFetchTool("obscura", { allowPrivateNetwork: false });
  assert.equal(tool.decode({ url: "http://example.com" }).ok, false);
  assert.equal(tool.decode({ url: "https://127.0.0.1" }).ok, false);
  assert.equal(tool.decode({ url: "https://localhost" }).ok, false);
  assert.equal(tool.decode({ url: "https://localhost." }).ok, false);
   assert.equal(tool.decode({ url: "https://[::ffff:127.0.0.1]" }).ok, false);
   assert.equal(tool.decode({ url: "https://[::ffff:7f00:1]" }).ok, false);
   assert.equal(tool.decode({ url: "https://[::192.168.1.1]" }).ok, false);
  assert.equal(tool.decode({ url: "https://[fe90::1]" }).ok, false);
  assert.equal(tool.decode({ url: "https://[febf::1]" }).ok, false);
  assert.equal(tool.decode({ url: "https://100.64.0.1" }).ok, false);
  assert.equal(tool.decode({ url: "https://0.0.0.0" }).ok, false);
  assert.equal(tool.decode({ url: "https://user:password@example.com" }).ok, false);
    const sensitiveQuery = tool.decode({ url: "https://example.com/?access_token=secret" });
    assert.equal(sensitiveQuery.ok, false);
    if (!sensitiveQuery.ok) assert.equal(sensitiveQuery.error.code, "TOOL_ARGUMENT_INVALID");
    assert.equal(tool.decode({ url: "https://example.com/?apiKey=secret" }).ok, false);
    assert.equal(tool.decode({ url: "https://example.com/?keynote=music" }).ok, true);
    assert.equal(tool.decode({ url: "https://example.com/?signal=green" }).ok, true);
   assert.equal(tool.decode({ url: "https://www.google.com/finance/quote/AAPL:NASDAQ?hl=en" }).ok, true);
   assert.equal(tool.decode({ url: "https://example.com#" }).ok, false);
  const decoded = tool.decode({ url: "https://example.com/path" });
   assert.deepEqual(decoded, { ok: true, value: { url: "https://example.com/path", format: "markdown" } });
   assert.deepEqual(tool.decode({ url: "https://example.com/path", title: "Example" }), { ok: true, value: { url: "https://example.com/path", format: "markdown" } });
   assert.equal(tool.decode({ url: "https://example.com/path", format: "url" }).ok, false);
   assert.deepEqual(tool.decode({ url: "https://example.com/path", format: "html" }), { ok: true, value: { url: "https://example.com/path", format: "html" } });
});

test("Obscura fetch process receives no application credentials", async () => {
  const directory = mkdtempSync(join(tmpdir(), "finleet-obscura-env-"));
  const binary = join(directory, "obscura");
  writeFileSync(binary, "#!/bin/sh\nprintf '%s' \"${OPENAI_API_KEY-unset}\"\n");
  chmodSync(binary, 0o755);
  const previous = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "must-not-inherit";
  try {
    const tool = obscuraFetchTool(binary);
    const decoded = tool.decode({ url: "https://example.com" });
    assert.equal(decoded.ok, true);
    if (decoded.ok) assert.deepEqual(await tool.execute(decoded.value, context), { ok: true, value: { url: "https://example.com/", content: "unset", truncated: false } });
  } finally {
    if (previous === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = previous;
  }
});

test("Obscura fetch tool invokes the configured binary with bounded Markdown output", async () => {
  const directory = mkdtempSync(join(tmpdir(), "finleet-obscura-"));
  const binary = join(directory, "obscura");
  writeFileSync(binary, "#!/bin/sh\nprintf '%s' '# Example page'\n");
  chmodSync(binary, 0o755);
  const tool = obscuraFetchTool(binary, { stealth: false });
  const decoded = tool.decode({ url: "https://example.com" });
  assert.equal(decoded.ok, true);
  if (!decoded.ok) return;
  const authorized = tool.authorize(context);
  assert.equal(authorized.ok, true);
   const result = await tool.execute(decoded.value, context);
  assert.deepEqual(result, { ok: true, value: { url: "https://example.com/", content: "# Example page", truncated: false } });
});

test("Obscura fetch tool waits for dynamic pages before dumping Markdown", async () => {
  const directory = mkdtempSync(join(tmpdir(), "finleet-obscura-args-"));
  const binary = join(directory, "obscura");
  writeFileSync(binary, "#!/bin/sh\nprintf '%s' \"$*\"\n");
  chmodSync(binary, 0o755);
  const tool = obscuraFetchTool(binary, { stealth: false });
  const decoded = tool.decode({ url: "https://example.com" });
  assert.equal(decoded.ok, true);
  if (decoded.ok) {
    const result = await tool.execute(decoded.value, context);
      assert.deepEqual(result, { ok: true, value: { url: "https://example.com/", content: "fetch https://example.com/ --dump markdown --wait-until domcontentloaded --wait 0 --timeout 30 --allow-private-network", truncated: false } });
  }
});

test("Obscura fetch can return bounded rendered HTML after a page-load wait", async () => {
  const directory = mkdtempSync(join(tmpdir(), "finleet-obscura-html-"));
  const binary = join(directory, "obscura");
  writeFileSync(binary, "#!/bin/sh\nprintf '%s' \"$*\"\n");
  chmodSync(binary, 0o755);
  const tool = obscuraFetchTool(binary, { stealth: false });
  const decoded = tool.decode({ url: "https://www.google.com/finance/quote/UUUU:NYSEAMERICAN?hl=en", format: "html" });
  assert.equal(decoded.ok, true);
   if (decoded.ok) assert.deepEqual(await tool.execute(decoded.value, context), { ok: true, value: { url: "https://www.google.com/finance/quote/UUUU:NYSEAMERICAN?hl=en", content: "fetch https://www.google.com/finance/quote/UUUU:NYSEAMERICAN?hl=en --dump html --wait-until load --wait 5 --timeout 30 --allow-private-network", truncated: false } });
});

test("Obscura fetch tolerates noisy browser output while bounding returned content", async () => {
  const directory = mkdtempSync(join(tmpdir(), "finleet-obscura-noisy-"));
  const binary = join(directory, "obscura");
  writeFileSync(binary, "#!/bin/sh\nprintf '%020000s' ''\nprintf '%s' '# usable page'\n");
  chmodSync(binary, 0o755);
  const tool = obscuraFetchTool(binary, { stealth: false });
  const decoded = tool.decode({ url: "https://example.com" });
  assert.equal(decoded.ok, true);
  if (decoded.ok) assert.deepEqual(await tool.execute(decoded.value, context), { ok: true, value: { url: "https://example.com/", content: "0".repeat(8192), truncated: true } });
});

test("Obscura fetch options enable stealth and explicitly allow private HTTPS hosts", async () => {
  const directory = mkdtempSync(join(tmpdir(), "finleet-obscura-options-"));
  const binary = join(directory, "obscura");
  writeFileSync(binary, "#!/bin/sh\nprintf '%s' \"$*\"\n");
  chmodSync(binary, 0o755);
  const tool = obscuraFetchTool(binary);
  const decoded = tool.decode({ url: "https://127.0.0.1/status" });
  assert.equal(decoded.ok, true);
  if (decoded.ok) {
    const result = await tool.execute(decoded.value, context);
       assert.deepEqual(result, { ok: true, value: { url: "https://127.0.0.1/status", content: "fetch https://127.0.0.1/status --dump markdown --wait-until domcontentloaded --wait 0 --timeout 30 --stealth --allow-private-network", truncated: false } });
   }
});

test("Obscura fetch omits private-network access when disabled", async () => {
  const directory = mkdtempSync(join(tmpdir(), "finleet-obscura-public-"));
  const binary = join(directory, "obscura");
  writeFileSync(binary, "#!/bin/sh\nprintf '%s' \"$*\"\n");
  chmodSync(binary, 0o755);
  const tool = obscuraFetchTool(binary, { stealth: false, allowPrivateNetwork: false });
  const decoded = tool.decode({ url: "https://example.com" });
  assert.equal(decoded.ok, true);
  if (decoded.ok) {
    const result = await tool.execute(decoded.value, context);
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.value.content.includes("--allow-private-network"), false);
  }
});

test("Obscura fetch tool requires web permission and reports process errors safely", async () => {
  const tool = obscuraFetchTool("missing-obscura-binary");
  assert.deepEqual(tool.authorize({ ...context, permissions: new Set<Permission>(["market:read"]) }), { ok: false, error: { code: "TOOL_DENIED", message: "web:read permission is required" } });
  const decoded = tool.decode({ url: "https://example.com" });
  assert.equal(decoded.ok, true);
  if (decoded.ok) {
    const result = await tool.execute(decoded.value, context);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, "TOOL_FETCH_FAILED");
      assert.match(result.error.message, /ENOENT|spawn-error/);
      assert.doesNotMatch(result.error.message, /OPENAI_API_KEY|access_token|refresh_token/);
    }
  }
});

test("Obscura session approvals are scoped to each canonical URL", async () => {
  const tool = obscuraFetchTool("obscura");
  const first = tool.decode({ url: "https://example.com/a" });
  const second = tool.decode({ url: "https://example.com/b" });
  const root = tool.decode({ url: "https://example.com/" });
  const equivalentRoot = tool.decode({ url: "https://EXAMPLE.com:443" });
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(root.ok, true);
  assert.equal(equivalentRoot.ok, true);
  assert.ok(tool.permissionRequirement);
  if (!first.ok || !second.ok || !root.ok || !equivalentRoot.ok || tool.permissionRequirement === undefined) return;
  const firstRequirement = await tool.permissionRequirement(first.value, context);
  const secondRequirement = await tool.permissionRequirement(second.value, context);
  const rootRequirement = await tool.permissionRequirement(root.value, context);
  const equivalentRootRequirement = await tool.permissionRequirement(equivalentRoot.value, context);
  assert.deepEqual(firstRequirement, {
    ok: true,
    value: {
      requiredPermission: "web:read",
      scope: "url:https://example.com/a",
      interactiveRequired: true,
      reviewSteps: ["Confirm the requested HTTPS resource", "Review the redacted fetch arguments"],
    },
  });
  assert.equal(secondRequirement.ok, true);
  if (firstRequirement.ok && secondRequirement.ok) assert.notEqual(secondRequirement.value.scope, firstRequirement.value.scope);
  assert.deepEqual(equivalentRootRequirement, rootRequirement);
});

test("Obscura abort force-kills a process group that ignores SIGTERM", { skip: process.platform === "win32" }, async () => {
  const directory = mkdtempSync(join(tmpdir(), "finleet-obscura-abort-"));
  const binary = join(directory, "obscura");
  writeFileSync(binary, "#!/bin/sh\ntrap '' TERM\nsleep 30\n");
  chmodSync(binary, 0o755);
  const tool = obscuraFetchTool(binary);
  const decoded = tool.decode({ url: "https://example.com" });
  assert.equal(decoded.ok, true);
  if (!decoded.ok) return;
  const controller = new AbortController();
  const running = tool.execute(decoded.value, { ...context, signal: controller.signal });
  setTimeout(() => controller.abort(), 50);
  const result = await Promise.race([running, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Obscura did not settle after abort")), 2_000))]);
  assert.equal(result.ok, false);
});

test("Obscura fetch tool includes bounded redacted stderr for page failures", async () => {
  const directory = mkdtempSync(join(tmpdir(), "finleet-obscura-failure-"));
  const binary = join(directory, "obscura");
  writeFileSync(binary, "#!/bin/sh\nprintf '%s' '\x1b]2;owned\x07apiKey=secret-from-stderr' >&2\nexit 7\n");
  chmodSync(binary, 0o755);
  const tool = obscuraFetchTool(binary);
  const decoded = tool.decode({ url: "https://example.com" });
  assert.equal(decoded.ok, true);
  if (decoded.ok) {
    const result = await tool.execute(decoded.value, context);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, "TOOL_FETCH_FAILED");
      assert.match(result.error.message, /exit status 7/);
      assert.equal(result.error.message.includes("secret-from-stderr"), false);
      assert.match(result.error.message, /\[REDACTED\]/);
      assert.equal(result.error.message.includes("owned"), false);
    }
  }
});

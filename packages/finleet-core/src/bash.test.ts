import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import test from "node:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { bashTool, validateBashCommand } from "./bash.js";
import { EventLog, type Permission } from "./domain.js";
import { Runner, ToolRegistry, type PermissionDecision, type Provider, type ToolContext } from "./runtime.js";

const writeContext: ToolContext = { sessionId: "s", agentId: "a", assistantMessageId: "m", providerCallId: "p", permissions: new Set<Permission>(["shell:write"]) };

class BashToolProvider implements Provider {
  readonly providerId = "bash-test";
  readonly mode = "fake" as const;
  private calls = 0;
  constructor(private readonly command: string) {}
  async *stream(): AsyncIterable<import("./runtime.js").ProviderEvent> {
    if (this.calls++ === 0) yield { type: "local_tool_call", callId: "bash-call", name: "bash", arguments: { command: this.command } };
    yield { type: "finished", finishReason: this.calls === 1 ? "tool-calls" : "stop", usage: { inputTokens: 0, outputTokens: 0 } };
  }
}

async function runBash(command: string, workspace: string, decision: PermissionDecision = { decision: "allow-once" }, onApproval: (request: Parameters<NonNullable<ConstructorParameters<typeof Runner>[8]>>[0]) => void = () => undefined, environment: Readonly<NodeJS.ProcessEnv> = process.env): Promise<{ result: Awaited<ReturnType<Runner["run"]>>; events: ReturnType<EventLog["read"]> }> {
  const log = new EventLog(join(mkdtempSync(join(tmpdir(), "finleet-bash-log-")), "journal.jsonl"));
  log.admit({ sessionId: "bash", promptId: "bash", prompt: "bash", delivery: "queue" });
  const runner = new Runner(log, new BashToolProvider(command), new ToolRegistry(new Map([["bash", bashTool("/bin/bash", environment)]])), undefined, undefined, undefined, "", workspace, async (request) => {
    onApproval(request);
    return decision;
  });
  return { result: await runner.run("bash"), events: log.read() };
}

test("bash accepts arbitrary scripts but preserves command length and control safety", () => {
  assert.equal(validateBashCommand("printf 'ok' > output.txt; wc -c < output.txt").ok, true);
  assert.equal(validateBashCommand("npm test").ok, true);
  assert.equal(validateBashCommand("cat /etc/hosts").ok, true);
  assert.equal(validateBashCommand("echo ok\nwc -c < output.txt").ok, true);
  assert.equal(validateBashCommand("echo\u0000bad").ok, false);
  assert.equal(validateBashCommand("echo\u001b[31mbad").ok, false);
  assert.equal(validateBashCommand("   \r\n ").ok, false);
  assert.equal(validateBashCommand("x".repeat(4097)).ok, false);
});

test("bash advertises dynamic mandatory host shell authority", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "finleet-bash-scope-"));
  const tool = bashTool("/bin/bash");
  assert.equal(tool.advertisement.requiredPermission, undefined);
  assert.match(tool.advertisement.description, /arbitrary host bash/i);
  const decoded = tool.decode({ command: "printf ok" });
  assert.equal(decoded.ok, true);
  if (!decoded.ok || tool.permissionRequirement === undefined) return;
  const requirement = await tool.permissionRequirement(decoded.value, { ...writeContext, workingDirectory: workspace });
  assert.equal(requirement.ok, true, JSON.stringify(requirement));
  if (!requirement.ok) return;
  assert.equal(requirement.value.requiredPermission, "shell:write");
  assert.equal(requirement.value.interactiveRequired, true);
  assert.match(requirement.value.scope, /^host:arbitrary-bash:cwd:.*:device:\d+:inode:\d+$/);
  assert.match(requirement.value.reviewSteps?.join(" ") ?? "", /not a sandbox/);
});

test("bash dynamically authorizes preparation but direct execute cannot bypass shell:write approval", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "finleet-bash-approval-"));
  const tool = bashTool("/bin/bash");
  assert.deepEqual(tool.authorize({ ...writeContext, permissions: new Set<Permission>() }), { ok: true, value: undefined });
  const noPermission = await tool.execute({ command: "printf blocked > blocked.txt" }, { ...writeContext, permissions: new Set<Permission>(), workingDirectory: workspace });
  assert.equal(noPermission.ok, false);
  if (!noPermission.ok) assert.equal(noPermission.error.code, "TOOL_PERMISSION_REQUIRED");
  const unapproved = await tool.execute({ command: "printf blocked > blocked.txt" }, { ...writeContext, workingDirectory: workspace });
  assert.equal(unapproved.ok, false);
  if (!unapproved.ok) assert.equal(unapproved.error.code, "TOOL_PERMISSION_REQUIRED");
  assert.equal(existsSync(join(workspace, "blocked.txt")), false);
  const malformed = await tool.execute({ command: "echo\u0000bad" }, { ...writeContext, workingDirectory: workspace });
  assert.equal(malformed.ok, false);
  if (!malformed.ok) assert.equal(malformed.error.code, "TOOL_ARGUMENT_INVALID");
});

test("Runner dynamically requests shell:write before claiming and executing arbitrary scripts", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "finleet-bash-arbitrary-"));
  const command = "printf 'hello' > note.txt; wc -c < note.txt";
  const approvals: Parameters<NonNullable<ConstructorParameters<typeof Runner>[8]>>[0][] = [];
  const { result, events } = await runBash(command, workspace, { decision: "allow-once" }, (request) => approvals.push(request));
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(approvals.length, 1);
  assert.equal(approvals[0]?.requiredPermission, "shell:write");
  assert.match(approvals[0]?.scope ?? "", /^host:arbitrary-bash:cwd:.*:device:\d+:inode:\d+$/);
  assert.equal(readFileSync(join(workspace, "note.txt"), "utf8"), "hello");
  assert.equal(events.ok, true, JSON.stringify(events));
  if (events.ok) assert.equal(events.value.some((event) => event.kind === "ToolSucceeded" && (event.data.result ?? "").includes("5")), true);
});

test("bash inherits caller environment variables while redacting secret-shaped output", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "finleet-bash-environment-"));
  const environment = { PATH: "/usr/bin:/bin", FINLEET_TEST_VALUE: "inherited-value", API_TOKEN: "never-show" };
  const command = "printf '%s\\n' \"$FINLEET_TEST_VALUE\"; printf 'PATH=%s\\n' \"$PATH\"; printf 'API_TOKEN=%s\\n' \"$API_TOKEN\"";
  const { result, events } = await runBash(command, workspace, { decision: "allow-once" }, () => undefined, environment);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(events.ok, true, JSON.stringify(events));
  if (events.ok) {
    const succeeded = events.value.find((event) => event.kind === "ToolSucceeded");
    const serialized = JSON.stringify(succeeded);
    assert.match(serialized, /inherited-value/);
    assert.match(serialized, /\/usr\/bin:\/bin/);
    assert.match(serialized, /API_TOKEN=\[REDACTED\]/);
    assert.equal(serialized.includes("never-show"), false);
  }
});

test("bash failures preserve bounded redacted stderr diagnostics", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "finleet-bash-failure-diagnostic-"));
  const { result, events } = await runBash("printf 'apiKey=secret-token' >&2; exit 7", workspace);
  assert.equal(result.ok, false);
  assert.equal(events.ok, true, JSON.stringify(events));
  if (events.ok) {
    const failure = events.value.find((event): event is Extract<typeof event, { kind: "ToolFailed" }> => event.kind === "ToolFailed");
    assert.equal(failure?.data.code, "TOOL_COMMAND_FAILED");
    assert.match(failure?.data.message ?? "", /stderr:/);
    assert.match(failure?.data.message ?? "", /apiKey=\[REDACTED\]/);
    assert.equal((failure?.data.message ?? "").includes("secret-token"), false);
    assert.ok((failure?.data.message ?? "").length <= 512);
  }
});

test("bash failure diagnostics redact prefixed compound secret names", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "finleet-bash-compound-secret-"));
  const { result, events } = await runBash("printf 'STRIPE_SECRET_KEY=sk_live_compound' >&2; exit 7", workspace);
  assert.equal(result.ok, false);
  assert.equal(events.ok, true, JSON.stringify(events));
  if (events.ok) {
    const failure = events.value.find((event): event is Extract<typeof event, { kind: "ToolFailed" }> => event.kind === "ToolFailed");
    assert.equal(failure?.data.code, "TOOL_COMMAND_FAILED");
    assert.equal(failure?.data.message.includes("sk_live_compound"), false);
    assert.match(failure?.data.message ?? "", /STRIPE_SECRET_KEY=\[REDACTED\]/);
  }
});

test("bash failure diagnostics preserve colon assignment separators", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "finleet-bash-colon-secret-"));
  const { result, events } = await runBash("printf 'API_KEY: secret-colon' >&2; exit 7", workspace);
  assert.equal(result.ok, false);
  assert.equal(events.ok, true, JSON.stringify(events));
  if (events.ok) {
    const failure = events.value.find((event): event is Extract<typeof event, { kind: "ToolFailed" }> => event.kind === "ToolFailed");
    assert.equal(failure?.data.code, "TOOL_COMMAND_FAILED");
    assert.equal(failure?.data.message.includes("secret-colon"), false);
    assert.match(failure?.data.message ?? "", /API_KEY:\[REDACTED\]/);
  }
});

test("bash syntax failures preserve the shell diagnostic", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "finleet-bash-syntax-diagnostic-"));
  const { result, events } = await runBash("printf 'before syntax failure' >&2; {", workspace);
  assert.equal(result.ok, false);
  assert.equal(events.ok, true, JSON.stringify(events));
  if (events.ok) {
    const failure = events.value.find((event): event is Extract<typeof event, { kind: "ToolFailed" }> => event.kind === "ToolFailed");
    assert.equal(failure?.data.code, "TOOL_COMMAND_FAILED");
    assert.match(failure?.data.message ?? "", /syntax error/);
  }
});

test("bash signal failures preserve the terminating signal", { skip: process.platform === "win32" }, async () => {
  const workspace = mkdtempSync(join(tmpdir(), "finleet-bash-signal-diagnostic-"));
  const { result, events } = await runBash("kill -TERM $$", workspace);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "PROVIDER_EMPTY_RESPONSE");
  assert.equal(events.ok, true, JSON.stringify(events));
  if (events.ok) {
    const failure = events.value.find((event): event is Extract<typeof event, { kind: "ToolFailed" }> => event.kind === "ToolFailed");
    assert.equal(failure?.data.code, "TOOL_COMMAND_FAILED");
    assert.match(failure?.data.message ?? "", /signal SIGTERM/);
    assert.equal((failure?.data.message ?? "").includes("TOOL_TIMEOUT"), false);
  }
});

test("bash approvers receive redacted command arguments", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "finleet-bash-approval-redaction-"));
  const pem = "-----BEGIN RSA PRIVATE KEY-----\\napproval-material\\n-----END RSA PRIVATE KEY-----";
  let approvalCommand = "";
  const { result } = await runBash(`printf '%b' 'PRIVATE_KEY=${pem}'`, workspace, { decision: "reject" }, (request) => {
    approvalCommand = typeof request.arguments === "object" && request.arguments !== null && "command" in request.arguments && typeof request.arguments.command === "string" ? request.arguments.command : "";
  });
  assert.equal(result.ok, false);
  assert.equal(approvalCommand.includes("approval-material"), false);
  assert.equal(approvalCommand.includes("BEGIN RSA PRIVATE KEY"), false);
});

test("bash uses the working folder but intentionally permits arbitrary host paths after approval", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "finleet-bash-host-path-"));
  const outside = join(mkdtempSync(join(tmpdir(), "finleet-bash-outside-")), "outside.txt");
  const { result } = await runBash(`printf host > ${outside}; cat ${outside}`, workspace);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(readFileSync(outside, "utf8"), "host");
});

test("bash redacts secret-shaped output and bounds returned output", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "finleet-bash-redaction-"));
  writeFileSync(join(workspace, "secret-output.txt"), "AWS_SECRET_ACCESS_KEY=never-show\n");
  const { result, events } = await runBash("cat secret-output.txt; yes x | head -c 10000", workspace);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(events.ok, true, JSON.stringify(events));
  if (events.ok) {
    const resultEvent = events.value.find((event) => event.kind === "ToolSucceeded");
    assert.equal(JSON.stringify(resultEvent).includes("never-show"), false);
    assert.ok((resultEvent?.kind === "ToolSucceeded" ? resultEvent.data.result ?? "" : "").length <= 512);
  }
});

test("bash streaming redaction handles PEM embedded in an assignment", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "finleet-bash-pem-stream-"));
  const command = "printf '%b' 'PRIVATE_KEY=-----BEGIN RSA PRIVATE KEY-----\\nstream-material\\n-----END RSA PRIVATE KEY-----\\n'";
  const { result, events } = await runBash(command, workspace);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(events.ok, true, JSON.stringify(events));
  if (events.ok) {
    const resultEvent = events.value.find((event) => event.kind === "ToolSucceeded");
    const output = resultEvent?.kind === "ToolSucceeded" ? resultEvent.data.result ?? "" : "";
    assert.equal(output.includes("stream-material"), false);
    assert.equal(output.includes("BEGIN RSA PRIVATE KEY"), false);
    assert.equal(output.includes("END RSA PRIVATE KEY"), false);
  }
});

test("bash terminates timed-out scripts", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "finleet-bash-timeout-"));
  const { result, events } = await runBash("sleep 11", workspace);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "PROVIDER_EMPTY_RESPONSE");
  assert.equal(events.ok, true, JSON.stringify(events));
  if (events.ok) assert.equal(events.value.some((event) => event.kind === "ToolFailed" && event.data.code === "TOOL_TIMEOUT"), true);
});

test("Runner durably records an explicit bash approval rejection", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "finleet-bash-reject-"));
  const { result, events } = await runBash("printf no > rejected.txt", workspace, { decision: "reject", feedback: "not expected" });
  assert.equal(result.ok, false);
  assert.equal(existsSync(join(workspace, "rejected.txt")), false);
  assert.equal(events.ok, true, JSON.stringify(events));
  if (events.ok) {
    assert.equal(events.value.some((event) => event.kind === "ToolFailed" && event.data.code === "TOOL_PERMISSION_REJECTED"), true);
    assert.equal(events.value.some((event) => event.kind === "EffectRecorded" && event.data.state === "failed"), true);
  }
});

test("bash input is strict", () => {
  assert.equal(bashTool("/bin/bash").decode({ command: "printf ok", extra: true }).ok, false);
});

import { spawn } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import { redactOutputText, type Json } from "./domain.js";
import { hasApprovedPermission, type PermissionRequirement, type ToolContext, type ToolDefinition } from "./runtime.js";

const MAX_COMMAND_LENGTH = 4096;
const MAX_OUTPUT_LENGTH = 8192;
const MAX_PROCESS_OUTPUT = 64 * 1024;
const MAX_REDACTION_CONTEXT = 256;
const COMMAND_TIMEOUT_MS = 10_000;
const secretAssignmentName = String.raw`(?:(?:[A-Za-z0-9]+[_-]+)*(?:api(?:[_-]?key)|access(?:[_-]?token)|client(?:[_-]?secret)|secret[_-]?key|private[_-]?key|authorization|proxy-authorization|x-api-key|x-auth-token|password|secret|token))`;

export interface BashInput { command: string; }
export interface BashOutput { command: string; stdout: string; stderr: string; exitCode: number; truncated: boolean; }

const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const controlCharacter = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

const childEnvironment = (source: Readonly<NodeJS.ProcessEnv>): NodeJS.ProcessEnv => {
  const environment: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(source)) {
    if (value !== undefined) environment[name] = value;
  }
  Object.assign(environment, {
    PATH: environment.PATH ?? (process.platform === "win32" ? "C:\\Windows\\System32;C:\\Windows" : "/usr/bin:/bin:/usr/sbin:/sbin"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_PAGER: "cat",
    GIT_TERMINAL_PROMPT: "0",
  });
  return environment;
};

const clean = (value: string): string => {
  const preRedacted = value
    .replace(/-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/g, "[REDACTED PEM]")
    .replace(new RegExp(`\\b${secretAssignmentName}\\s*[:=]\\s*(?:"[^"\\r\\n]*"|'[^'\\r\\n]*'|[^\\s,;]+)`, "gi"), (match) => { const separator = match.search(/[:=]/); return `${match.slice(0, separator)}${match[separator] ?? "="}[REDACTED]`; })
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "");
  return redactOutputText(preRedacted).replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "");
};

class RedactedOutputCapture {
  private pending = "";
  private output = "";
  private rawLength = 0;
  private truncated = false;
  private redactingLine = false;
  private redactingPem = false;

  add(chunk: string): void {
    if (this.rawLength >= MAX_PROCESS_OUTPUT) { this.truncated = true; return; }
    const accepted = chunk.slice(0, MAX_PROCESS_OUTPUT - this.rawLength);
    this.rawLength += accepted.length;
    if (accepted.length !== chunk.length) this.truncated = true;
    this.pending += accepted;
    this.drain(false);
  }

  finish(): { text: string; truncated: boolean } { this.drain(true); return { text: this.output, truncated: this.truncated }; }

  private append(value: string): void { this.output = (this.output + clean(value)).slice(0, MAX_PROCESS_OUTPUT); }

  private drain(final: boolean): void {
    while (this.pending.length > 0) {
      if (this.redactingPem) {
        const end = /-----END [^-]+-----/.exec(this.pending);
        if (end === null) { if (final) this.pending = ""; return; }
        this.pending = this.pending.slice((end.index ?? 0) + end[0].length);
        this.redactingPem = false;
        continue;
      }
      if (this.redactingLine) {
        const pem = this.pending.search(/-----BEGIN [^-]+-----/);
        if (pem >= 0) {
          this.pending = this.pending.slice(pem);
          const headerEnd = this.pending.indexOf("-----", 11);
          if (headerEnd >= 0) {
            this.pending = this.pending.slice(headerEnd + 5);
            this.redactingLine = false;
            this.redactingPem = true;
            continue;
          }
        }
        const newline = this.pending.search(/[\r\n]/);
        if (newline < 0) { if (final) this.pending = ""; return; }
        this.append(this.pending.slice(newline, newline + 1));
        this.pending = this.pending.slice(newline + 1);
        this.redactingLine = false;
        continue;
      }
      const pem = this.pending.search(/-----BEGIN [^-]+-----/);
      const assignment = this.pending.search(new RegExp(`\\b${secretAssignmentName}\\s*[:=]\\s*`, "i"));
      const match = [pem, assignment].filter((index) => index >= 0).sort((left, right) => left - right)[0];
      if (match !== undefined) {
        this.append(this.pending.slice(0, match));
        if (pem === match) {
          this.append("[REDACTED PEM]");
          const headerEnd = this.pending.indexOf("-----", match + 11);
          this.pending = this.pending.slice(headerEnd + 5);
          this.redactingPem = true;
          continue;
        }
        const assignment = this.pending.slice(match);
        const matched = /^([^:=\s]+)\s*([:=])/.exec(assignment);
        const separatorOffset = assignment.search(/[:=]/);
        const separator = separatorOffset >= 0 ? match + separatorOffset : match;
        this.append(`${matched?.[1] ?? "secret"}${matched?.[2] ?? "="}[REDACTED]`);
        this.pending = this.pending.slice(separator + 1);
        this.redactingLine = true;
        continue;
      }
      const safeLength = final ? this.pending.length : Math.max(0, this.pending.length - MAX_REDACTION_CONTEXT);
      if (safeLength === 0) return;
      this.append(this.pending.slice(0, safeLength));
      this.pending = this.pending.slice(safeLength);
    }
  }
}

interface WorkspaceIdentity { path: string; device: number; inode: number; }
async function workspaceIdentity(workingDirectory: string): Promise<WorkspaceIdentity | undefined> {
  const path = await realpath(workingDirectory).catch(() => undefined);
  if (path === undefined) return undefined;
  const info = await stat(path).catch(() => undefined);
  return info === undefined || !info.isDirectory() ? undefined : { path, device: info.dev, inode: info.ino };
}
const hostShellScope = (workspace: WorkspaceIdentity): string => `host:arbitrary-bash:cwd:${workspace.path}:device:${workspace.device}:inode:${workspace.inode}`;

export function validateBashCommand(command: string): { ok: true; value: BashInput } | { ok: false; error: { code: string; message: string } } {
  if (command.length > MAX_COMMAND_LENGTH) return { ok: false, error: { code: "TOOL_ARGUMENT_INVALID", message: `command must be between 1 and ${MAX_COMMAND_LENGTH} characters` } };
  if (controlCharacter.test(command)) return { ok: false, error: { code: "TOOL_ARGUMENT_INVALID", message: "command contains unsupported control characters" } };
  const normalized = command.replace(/\r\n?/g, "\n").trim();
  return normalized.length === 0
    ? { ok: false, error: { code: "TOOL_ARGUMENT_INVALID", message: `command must be between 1 and ${MAX_COMMAND_LENGTH} characters` } }
    : { ok: true, value: { command: normalized } };
}

interface ProcessResult { error?: Error; status: number | null; signal?: NodeJS.Signals | null; stdout: string; stderr: string; timedOut: boolean; outputTruncated?: boolean; }
async function runBash(binary: string, command: string, signal: AbortSignal | undefined, workingDirectory: string, environment: Readonly<NodeJS.ProcessEnv>): Promise<ProcessResult> {
  return new Promise((resolveResult) => {
    const stdout = new RedactedOutputCapture();
    const stderr = new RedactedOutputCapture();
    let settled = false;
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let forceTimer: ReturnType<typeof setTimeout> | undefined;
    const child = spawn(binary, ["--noprofile", "--norc", "-c", command], { cwd: workingDirectory, env: childEnvironment(environment), shell: false, detached: process.platform !== "win32" });
    const captured = (): Pick<ProcessResult, "stdout" | "stderr" | "outputTruncated"> => {
      const standard = stdout.finish();
      const error = stderr.finish();
      return { stdout: standard.text, stderr: error.text, outputTruncated: standard.truncated || error.truncated };
    };
    const finish = (value: ProcessResult): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      if (forceTimer !== undefined) clearTimeout(forceTimer);
      signal?.removeEventListener("abort", abort);
      resolveResult(value);
    };
    const abort = (): void => {
      if (process.platform !== "win32" && child.pid !== undefined) {
        try { process.kill(-child.pid, "SIGTERM"); } catch { child.kill("SIGTERM"); }
      } else child.kill("SIGTERM");
      forceTimer = setTimeout(() => {
        if (settled) return;
        if (process.platform !== "win32" && child.pid !== undefined) {
          try { process.kill(-child.pid, "SIGKILL"); return; } catch { /* fall through */ }
        }
        child.kill("SIGKILL");
      }, 250);
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => stdout.add(chunk));
    child.stderr.on("data", (chunk: string) => stderr.add(chunk));
    child.once("error", (error) => finish({ error, status: null, timedOut, ...captured() }));
    child.once("close", (status, signal) => finish({ status, signal, timedOut, ...captured() }));
    timer = setTimeout(() => { timedOut = true; abort(); }, COMMAND_TIMEOUT_MS);
    if (signal?.aborted === true) abort(); else signal?.addEventListener("abort", abort, { once: true });
  });
}

export function bashTool(binary = process.platform === "win32" ? "bash.exe" : "/bin/bash", environment: Readonly<NodeJS.ProcessEnv> = process.env): ToolDefinition<BashInput, BashOutput> {
  const decodeBashInput = (input: unknown): { ok: true; value: BashInput } | { ok: false; error: { code: string; message: string } } => {
    if (!record(input) || Object.keys(input).length !== 1 || typeof input.command !== "string") return { ok: false, error: { code: "TOOL_ARGUMENT_INVALID", message: "Expected exactly { command: string }" } };
    return validateBashCommand(input.command);
  };
  const requirement = async (context: ToolContext): Promise<{ ok: true; value: PermissionRequirement } | { ok: false; error: { code: string; message: string } }> => {
    const workspace = await workspaceIdentity(context.workingDirectory ?? process.cwd());
    return workspace === undefined
      ? { ok: false, error: { code: "TOOL_COMMAND_DENIED", message: "Working folder is unavailable" } }
      : { ok: true, value: { requiredPermission: "shell:write", scope: hostShellScope(workspace), interactiveRequired: true, reviewSteps: ["This grants arbitrary bash authority on the host, not a sandbox", "Review the full redacted script and its possible host paths/processes", "Confirm the working folder identity and approve only this expected command"] } };
  };
  return {
    advertisement: { name: "bash", description: "Run an arbitrary host bash command from the current working directory after mandatory interactive shell:write approval. This grants arbitrary host authority and is not sandboxed; review the full command before approval. Quote paths containing spaces, prefer dedicated tools for file operations when available, and use the working-directory setting instead of changing directories with cd. Output is bounded and commands time out after 10 seconds.", inputSchema: { type: "object", required: ["command"], additionalProperties: false, properties: { command: { type: "string", minLength: 1, maxLength: MAX_COMMAND_LENGTH } } } },
    decode: decodeBashInput,
    authorize() { return { ok: true, value: undefined }; },
    permissionRequirement(_input, context) { return requirement(context); },
    async execute(input, context) {
      const decoded = decodeBashInput(input);
      if (!decoded.ok) return decoded;
       const workingDirectory = context.workingDirectory ?? process.cwd();
      const resolvedRequirement = await requirement(context);
      if (!resolvedRequirement.ok) return resolvedRequirement;
      if (!hasApprovedPermission(context, resolvedRequirement.value.requiredPermission, resolvedRequirement.value.scope)) return { ok: false, error: { code: "TOOL_PERMISSION_REQUIRED", message: "Arbitrary host bash requires matching interactive approval" } };
      const result = await runBash(binary, decoded.value.command, context.signal, workingDirectory, environment);
      if (result.error !== undefined || result.timedOut || result.status !== 0) {
        if (result.timedOut) return { ok: false, error: { code: "TOOL_TIMEOUT", message: "Command exceeded the 10 second limit" } };
        const reason = result.error?.message ?? (result.signal === null || result.signal === undefined ? `exit ${result.status ?? "unknown"}` : `signal ${result.signal}`);
        const base = `Command failed (${clean(reason)})`;
        const diagnostic = result.stderr.trim().slice(0, 384);
        return { ok: false, error: { code: "TOOL_COMMAND_FAILED", message: (diagnostic.length === 0 ? base : `${base}; stderr: ${diagnostic}`).slice(0, 512) } };
      }
      const output = `${result.stdout}${result.stderr.length === 0 ? "" : `\n[stderr]\n${result.stderr}`}`;
      return { ok: true, value: { command: decoded.value.command, stdout: output.slice(0, MAX_OUTPUT_LENGTH), stderr: "", exitCode: result.status, truncated: result.outputTruncated === true || output.length > MAX_OUTPUT_LENGTH } };
    },
    encode(output): Json { return { command: output.command, stdout: output.stdout, stderr: output.stderr, exitCode: output.exitCode, truncated: output.truncated }; },
  };
}

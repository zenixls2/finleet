import { spawn } from "node:child_process";
import { isIP } from "node:net";
import { join } from "node:path";
import { MAX_TOOL_RESULT, redactJson, type Json } from "./domain.js";
import type { ToolDefinition } from "./runtime.js";

const MAX_URL_LENGTH = 2048;
const MAX_PROCESS_OUTPUT = 1024 * 1024;
const MAX_FETCH_OUTPUT = MAX_PROCESS_OUTPUT;
const FETCH_TIMEOUT_MS = 45_000;
const PROJECT_OBSCURA_VERSION = "v0.2.1";
const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const nonPublicIpv4 = (hostname: string): boolean => {
  const octets = hostname.split(".").map(Number);
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return false;
  const first = octets[0] ?? 0;
  const second = octets[1] ?? 0;
  return first === 0 || first === 10 || first === 127 || (first === 100 && second >= 64 && second <= 127) || (first === 169 && second === 254) || (first === 172 && second >= 16 && second <= 31) || (first === 192 && (second === 0 || second === 168)) || (first === 198 && (second === 18 || second === 19 || second === 51)) || (first === 203 && second === 0) || first >= 224;
};
const sensitiveQueryKey = /(?:^|[_-])(?:token|key|secret|password|passwd|auth|credential|session|signature|sig)(?:$|[_-])/i;
const splitQueryKeyWords = (key: string): string => key.replace(/([a-z0-9])([A-Z])/g, "$1_$2");
const containsSensitiveQuery = (parsed: URL): boolean => {
  for (const [key] of parsed.searchParams) if (sensitiveQueryKey.test(splitQueryKeyWords(key))) return true;
  return false;
};
const privateHost = (hostname: string): boolean => {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.+$/, "");
  if (normalized === "localhost" || normalized.endsWith(".localhost") || normalized.endsWith(".local") || normalized.endsWith(".internal")) return true;
  if (isIP(normalized) === 4) return nonPublicIpv4(normalized);
  if (isIP(normalized) === 6) {
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(normalized)?.[1];
    if (mapped !== undefined) return nonPublicIpv4(mapped);
     const hexMapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(normalized);
     if (hexMapped !== null) {
       const high = Number.parseInt(hexMapped[1] ?? "0", 16);
       const low = Number.parseInt(hexMapped[2] ?? "0", 16);
       return nonPublicIpv4(`${high >>> 8}.${high & 255}.${low >>> 8}.${low & 255}`);
     }
     const compatible = /^::([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(normalized);
     if (compatible !== null) {
       const high = Number.parseInt(compatible[1] ?? "0", 16);
       const low = Number.parseInt(compatible[2] ?? "0", 16);
       return nonPublicIpv4(`${high >>> 8}.${high & 255}.${low >>> 8}.${low & 255}`);
     }
      const firstGroup = Number.parseInt(normalized.split(":")[0] ?? "", 16);
     return normalized === "::" || normalized === "::1" || normalized.startsWith("fc") || normalized.startsWith("fd") || (Number.isInteger(firstGroup) && firstGroup >= 0xfe80 && firstGroup <= 0xfebf);
  }
  return false;
};
const neutralizeControls = (value: string): string => value.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g, "").replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "").replace(/\x1b/g, "");
const childEnvironment = (): NodeJS.ProcessEnv => {
  const environment: NodeJS.ProcessEnv = {};
  for (const name of ["PATH", "HOME", "TMPDIR", "TMP", "TEMP", "SystemRoot", "LANG", "LC_ALL"]) {
    const value = process.env[name];
    if (value !== undefined) environment[name] = value;
  }
  return environment;
};

const projectObscuraBinary = (): string => {
  const platform = process.platform === "darwin" ? "macos" : process.platform;
  const architecture = process.arch === "arm64" ? "aarch64" : process.arch === "x64" ? "x86_64" : process.arch;
  return join(process.cwd(), ".tools", "obscura", PROJECT_OBSCURA_VERSION, `${architecture}-${platform}`, process.platform === "win32" ? "obscura.exe" : "obscura");
};

type FetchFormat = "markdown" | "html" | "original";
interface FetchInput { url: string; format: FetchFormat; }
interface FetchOutput { url: string; content: string; truncated: boolean; }
export interface ObscuraFetchOptions { stealth?: boolean; allowPrivateNetwork?: boolean; }

interface ObscuraProcessResult { error?: Error; status: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string; stdoutTruncated: boolean; }
const failureDiagnostic = (result: ObscuraProcessResult): string => {
  const parts: string[] = [];
  if (result.error !== undefined) {
    const error = result.error as NodeJS.ErrnoException;
    const code = typeof error.code === "string" ? error.code : "spawn-error";
    const message = typeof error.message === "string" ? error.message : "process could not start";
    parts.push(`${code}: ${message}`);
  }
  if (typeof result.status === "number") parts.push(`exit status ${result.status}`);
  if (typeof result.signal === "string") parts.push(`signal ${result.signal}`);
  if (typeof result.stderr === "string" && result.stderr.trim().length > 0) parts.push(result.stderr.trim());
  const diagnostic = neutralizeControls(parts.join("; ")).slice(0, 512);
  const redacted = redactJson(diagnostic);
  return typeof redacted === "string" ? redacted : "process failed";
};

export function obscuraFetchTool(binary = process.env.FINLEET_OBSCURA_BIN ?? projectObscuraBinary(), options: ObscuraFetchOptions = {}): ToolDefinition<FetchInput, FetchOutput> {
  const settings: Required<ObscuraFetchOptions> = { stealth: true, allowPrivateNetwork: true, ...options };
  return {
    advertisement: {
      name: "fetch_page",
        description: "Fetch an HTTPS page with Obscura and return bounded rendered Markdown or HTML content. If pagination is provided, get as many rows from a single API call as much as possible within the range of data to reduce the number of API calls.",
       requiredPermission: "web:read",
       inputSchema: { type: "object", required: ["url"], properties: { url: { type: "string", format: "uri", pattern: "^https://" }, format: { type: "string", enum: ["markdown", "html", "original"], description: "Rendered output format; html returns the post-JavaScript DOM" } } },
    },
    durableResultLimit: MAX_TOOL_RESULT,
    decode(input: unknown) {
       if (!record(input) || typeof input.url !== "string") return { ok: false, error: { code: "TOOL_ARGUMENT_INVALID", message: "Expected an object containing { url: string, format?: markdown|html|original }" } };
       const format = input.format === undefined ? "markdown" : input.format;
       if (format !== "markdown" && format !== "html" && format !== "original") return { ok: false, error: { code: "TOOL_ARGUMENT_INVALID", message: "format must be markdown, html, or original" } };
      if (input.url.length === 0 || input.url.length > MAX_URL_LENGTH) return { ok: false, error: { code: "TOOL_ARGUMENT_INVALID", message: `url must be between 1 and ${MAX_URL_LENGTH} characters` } };
      let parsed: URL;
      try { parsed = new URL(input.url); } catch { return { ok: false, error: { code: "TOOL_ARGUMENT_INVALID", message: "url must be a valid HTTPS URL" } }; }
     if (parsed.protocol !== "https:" || parsed.username !== "" || parsed.password !== "" || containsSensitiveQuery(parsed) || (!settings.allowPrivateNetwork && privateHost(parsed.hostname)) || input.url.includes("#")) return { ok: false, error: { code: "TOOL_ARGUMENT_INVALID", message: settings.allowPrivateNetwork ? "url must be an HTTPS URL without credentials, sensitive query parameters, or fragment" : "url must be a public HTTPS URL without credentials, sensitive query parameters, or fragment" } };
       return { ok: true, value: { url: parsed.href, format } };
    },
    authorize(context) {
      return context.permissions.has("web:read") ? { ok: true, value: undefined } : { ok: false, error: { code: "TOOL_DENIED", message: "web:read permission is required" } };
    },
    permissionRequirement(input) {
      return {
        ok: true,
        value: {
          requiredPermission: "web:read",
          scope: `url:${input.url}`,
          interactiveRequired: true,
          reviewSteps: ["Confirm the requested HTTPS resource", "Review the redacted fetch arguments"],
        },
      };
    },
    async execute(input, context) {
         const renderedHtml = input.format === "html";
         const argumentsList = ["fetch", input.url, "--dump", input.format, "--wait-until", renderedHtml ? "load" : "domcontentloaded", "--wait", renderedHtml ? "5" : "0", "--timeout", "30", ...(settings.stealth ? ["--stealth"] : []), ...(settings.allowPrivateNetwork ? ["--allow-private-network"] : [])];
        const result = await new Promise<ObscuraProcessResult>((resolve) => {
          let stdout = "";
          let stderr = "";
          let stdoutTruncated = false;
         let settled = false;
         let timer: ReturnType<typeof setTimeout> | undefined;
          let forceTimer: ReturnType<typeof setTimeout> | undefined;
          const child = spawn(binary, argumentsList, { env: childEnvironment(), detached: process.platform !== "win32" });
          const finish = (value: Omit<ObscuraProcessResult, "stdoutTruncated">): void => { if (settled) return; settled = true; if (timer !== undefined) clearTimeout(timer); if (forceTimer !== undefined) clearTimeout(forceTimer); context.signal?.removeEventListener("abort", abort); resolve({ ...value, stdoutTruncated }); };
          const kill = (signal: NodeJS.Signals): void => {
            if (process.platform !== "win32" && child.pid !== undefined) {
              try { process.kill(-child.pid, signal); return; } catch { /* fall through */ }
            }
            child.kill(signal);
          };
          const abort = (): void => {
            kill("SIGTERM");
            if (forceTimer === undefined) forceTimer = setTimeout(() => { if (!settled) kill("SIGKILL"); }, 250);
          };
          child.stdout.setEncoding("utf8");
          child.stderr.setEncoding("utf8");
          child.stdout.on("data", (chunk: string) => {
            const remaining = MAX_PROCESS_OUTPUT - stdout.length;
            stdout += chunk.slice(0, remaining);
            if (chunk.length > remaining) stdoutTruncated = true;
          });
          child.stderr.on("data", (chunk: string) => { stderr = (stderr + chunk).slice(0, MAX_PROCESS_OUTPUT); });
          child.once("error", (error) => finish({ error, status: null, signal: null, stdout, stderr }));
          child.once("close", (status, signal) => finish({ status, signal, stdout, stderr }));
          timer = setTimeout(abort, FETCH_TIMEOUT_MS);
          if (context.signal?.aborted === true) abort();
          else context.signal?.addEventListener("abort", abort, { once: true });
        });
      if (result.error !== undefined || result.status !== 0 || typeof result.stdout !== "string") return { ok: false, error: { code: "TOOL_FETCH_FAILED", message: `Obscura could not fetch the requested page (${failureDiagnostic(result)})` } };
       return { ok: true, value: { url: input.url, content: result.stdout.slice(0, MAX_FETCH_OUTPUT), truncated: result.stdoutTruncated || result.stdout.length > MAX_FETCH_OUTPUT } };
    },
    encode(output): Json { return { url: output.url, content: output.content, truncated: output.truncated }; },
  };
}

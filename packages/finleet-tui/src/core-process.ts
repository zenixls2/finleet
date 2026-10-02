import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

export interface CoreEndpoint { readonly url: string; readonly token: string; }
export interface CoreProcess { readonly endpoint: CoreEndpoint; close(): Promise<void>; }
export interface StartCoreProcessOptions { readonly signal?: AbortSignal; }

const MAX_HANDSHAKE_BYTES = 1024;
const MAX_STDERR_BYTES = 64 * 1024;
const STARTUP_TIMEOUT_MS = 10_000;
const TERMINATION_TIMEOUT_MS = 2_000;

const validateEndpoint = (value: unknown): CoreEndpoint | undefined => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const object = value as { url?: unknown; token?: unknown };
  if (typeof object.url !== "string" || typeof object.token !== "string" || object.token.length < 32 || object.token.length > 128 || !/^[A-Za-z0-9_-]+$/.test(object.token)) return undefined;
  try {
    const url = new URL(object.url);
    return url.protocol === "ws:" && url.hostname === "127.0.0.1" && url.port.length > 0 && url.pathname === "/" && url.search === "" && url.hash === "" ? { url: object.url, token: object.token } : undefined;
  } catch { return undefined; }
};
export const parseCoreHandshake = (line: string): CoreEndpoint | undefined => {
  if (Buffer.byteLength(line, "utf8") > MAX_HANDSHAKE_BYTES) return undefined;
  try { return validateEndpoint(JSON.parse(line)); } catch { return undefined; }
};

const coreCliPath = (): string => fileURLToPath(new URL("./cli.js", import.meta.resolve("finleet-core")));
const exited = (child: ChildProcess): boolean => child.exitCode !== null || child.signalCode !== null;
const waitForExit = (child: ChildProcess): Promise<void> => new Promise((resolve) => exited(child) ? resolve() : child.once("exit", () => resolve()));
const terminate = async (child: ChildProcess): Promise<void> => {
  if (exited(child)) return;
  child.kill("SIGTERM");
  await Promise.race([waitForExit(child), new Promise<void>((resolve) => setTimeout(resolve, TERMINATION_TIMEOUT_MS))]);
  if (!exited(child)) { child.kill("SIGKILL"); await waitForExit(child); }
};

/** Spawn the core executable and accept exactly one bounded loopback endpoint handshake. */
export const startCoreProcess = async (args: readonly string[], options: StartCoreProcessOptions = {}): Promise<CoreProcess> => {
  const child = spawn(process.execPath, [coreCliPath(), "serve", ...args], { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"], shell: false });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => { stderr = `${stderr}${chunk}`.slice(-MAX_STDERR_BYTES); });
  const endpoint = await new Promise<CoreEndpoint>((resolve, reject) => {
    let stdout = "";
    let settled = false;
    const fail = (message: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", abort);
      reject(new Error(`${message}${stderr.length === 0 ? "" : `: ${stderr}`}`));
    };
    const succeed = (value: CoreEndpoint): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", abort);
      resolve(value);
    };
    const abort = (): void => fail("Core service startup was cancelled");
    const timeout = setTimeout(() => fail("Core service startup timed out"), STARTUP_TIMEOUT_MS);
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted === true) abort();
    child.once("error", () => fail("Unable to start core service"));
    child.once("exit", (code, signal) => fail(`Core service exited before handshake (${code === null ? signal ?? "unknown" : String(code)})`));
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
       if (Buffer.byteLength(stdout, "utf8") > MAX_HANDSHAKE_BYTES || stdout.includes("\n") && stdout.indexOf("\n") !== stdout.length - 1) { fail("Core service emitted an invalid handshake"); return; }
       const newline = stdout.indexOf("\n");
       if (newline < 0) return;
       const endpoint = parseCoreHandshake(stdout.slice(0, newline));
       if (endpoint === undefined) { fail("Core service emitted an invalid handshake"); return; }
       succeed(endpoint);
     });
   }).catch(async (error: unknown) => { await terminate(child); throw error; });
  return { endpoint, close: () => terminate(child) };
};

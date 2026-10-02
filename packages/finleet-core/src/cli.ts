#!/usr/bin/env node
import { digest, fail, MAX_EVENT_TEXT, projectHistory, projectSessions, type DeliveryMode, type DurableEvent, type Result } from "./domain.js";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { pathToFileURL } from "node:url";
import { type PermissionApprover } from "./runtime.js";
import { AgentCatalog, catalogProviders, ConnectorRegistry, MODELS_DEV_API_URL, ModelCatalogService, TrustedPluginRegistry, type CatalogFetch, type CompatibleFetch, type Environment, type OpenAiFetch } from "./integrations.js";
import { loginBrowser, OAuthCredentialStore, openAIOAuthConfig, type OAuthFetch } from "./auth.js";
import { CoreService } from "./core-service.js";
import { RpcServer } from "./rpc-server.js";

export interface CliResponse { exitCode: 0 | 2; body: unknown; }
export interface ExecuteDependencies { stdin?: AsyncIterable<string | Buffer>; environment?: Environment; workingDirectory?: string; openAiFetch?: OpenAiFetch; compatibleFetch?: CompatibleFetch; catalogFetch?: CatalogFetch; oauthFetch?: OAuthFetch; openBrowser?: (url: string) => Promise<void>; approver?: PermissionApprover; signal?: AbortSignal; }
const option = (argumentsList: readonly string[], name: string): string | undefined => { const index = argumentsList.indexOf(name); return index >= 0 ? argumentsList[index + 1] : undefined; };
const required = (args: readonly string[], name: string): string | undefined => option(args, name);
const failure = (message: string): CliResponse => ({ exitCode: 2, body: { error: message } });
const typedFailure = (code: string, message: string): CliResponse => ({ exitCode: 2, body: { error: { code, message } } });
const supportedFormat = (args: readonly string[]): boolean => {
  const format = required(args, "--format");
  return format === undefined || format === "json" || format === "text";
};
const providerListBody = (providers: ReturnType<typeof catalogProviders>, source: "models.dev" | "cache-fallback", format: string | undefined): unknown => {
  const advisory = "Catalog metadata does not guarantee runtime availability.";
  if (format === "text") {
    const lines = [`Source: ${source}`, `Providers: ${providers.length}`];
    for (const provider of providers) lines.push(`${provider.id} (${provider.modelCount} models, ${provider.executableModelCount} executable)`, `  ${provider.models.join(", ")}`);
    lines.push(advisory);
    return lines.join("\n");
  }
  return { providers, source, advisory };
};
const delivery = (value: string | undefined): DeliveryMode | undefined => value === "queue" || value === "steer" ? value : undefined;
const processEnvironment: Environment = { get: (name) => process.env[name] };
const remoteCatalogFetch: CatalogFetch = async (url, init) => { const response = await fetch(url, init); return { ok: response.ok, status: response.status, json: async () => response.json() as Promise<unknown> }; };
const openAiFetch: OpenAiFetch = async (url, init) => { const response = await fetch(url, init); return { ok: response.ok, status: response.status, headers: { "x-request-id": response.headers.get("x-request-id") ?? undefined }, json: async () => response.json() as Promise<unknown>, text: async () => response.text() }; };
const oauthFetch: OAuthFetch = async (url, init) => { const response = await fetch(url, init); return { ok: response.ok, status: response.status, json: async () => response.json() as Promise<unknown> }; };
const catalogService = new ModelCatalogService();
const agents = new AgentCatalog([{ id: "paper-primary", kind: "primary", modelId: "fake/finleet", requiredCapabilities: [], permissions: ["market:read"], budget: { maxTurns: 1, maxContextChars: 400 } }, { id: "research-subagent", kind: "subagent", modelId: "fake/finleet", requiredCapabilities: [], permissions: ["market:read"], budget: { maxTurns: 1, maxContextChars: 200 } }]);
const plugins = new TrustedPluginRegistry([{ id: "native-exchange", enabled: false, requiredPermissions: ["market:read"], mode: "deferred" }]);
const connectors = new ConnectorRegistry([{ id: "paper-cli", kind: "local-exchange-cli", enabled: false, requiredPermissions: ["market:read"], mode: "deferred" }, { id: "local-mcp", kind: "stdio-mcp", enabled: false, requiredPermissions: [], mode: "deferred" }]);
const MAX_SESSION_LIST_LIMIT = 100;
const HELP_TEXT = `Finleet - durable, read-only model and paper-exchange CLI

Usage:
  finleet <command> [options]

Commands:
  auth login       Log in with OpenAI OAuth
  auth status      Show authentication metadata without revealing tokens
  providers list   List providers from models.dev
  models list      List models from a local catalog cache
  models sync      Read or refresh a catalog cache
  agents list      List available agents
  connectors list  List deferred connectors and plugins
  agent run        Run the compatibility agent command
  serve            Start the authenticated loopback JSON-RPC server
  exec             Submit a prompt and run one durable turn
  resume           Continue an existing durable session
  sessions list    List durable sessions
  session show     Show a recorded session and projected history
  replay           Replay a recorded session outcome

Common options:
  --format text    Select readable output (default)
  --format json    Select compact JSON output for scripts
  --allow-all-permissions  Automatically allow every permission request (unsafe)
  --help           Show this help or help for a specific command

  Provider listing:
  finleet providers list --format text
  --cache <path>   Optional local cache used only if the online query fails
  --url <https-url> Override the models.dev API URL
  --format text    Return a human-readable provider summary
  --format json    Return provider summaries as JSON

Catalog metadata is advisory and does not guarantee runtime availability.
`;
const SERVE_HELP_TEXT = `Usage: finleet-core serve [options]

Start the authenticated loopback JSON-RPC server for a Finleet client.

Options:
  --provider <id>       Provider to use (default: openai-responses)
  --model <id>          Model to use
  --context-window <N>  Context window size in tokens (default: 128K)
  --journal <path>      Durable journal path
  --allow-all-permissions  Automatically allow every permission request (unsafe)
   --help                Show this help text
`;
const openBrowserUrl = (url: string): Promise<void> => new Promise((resolve, reject) => {
  const launch = process.platform === "darwin" ? { command: "open", args: [url] } : process.platform === "win32" ? { command: "rundll32.exe", args: ["url.dll,FileProtocolHandler", url] } : { command: "xdg-open", args: [url] };
  execFile(launch.command, launch.args, { windowsHide: true }, (error) => error === null ? resolve() : reject(error));
});
const tuiServiceArgs = (args: readonly string[]): readonly string[] => [
  "exec", "--provider", option(args, "--provider") ?? "openai-responses", "--model", option(args, "--model") ?? "gpt-5.6-luna", "--reasoning-effort", "high", "--exchange", "paper", "--journal", option(args, "--journal") ?? ".finleet/journal.jsonl",
  ...(option(args, "--context-window") === undefined ? [] : ["--context-window", option(args, "--context-window")!]),
  ...(option(args, "--cache") === undefined ? [] : ["--cache", option(args, "--cache")!]),
  ...(option(args, "--auth-file") === undefined ? [] : ["--auth-file", option(args, "--auth-file")!]),
  ...(args.includes("--allow-all-permissions") ? ["--allow-all-permissions"] : []),
];
const waitForTermination = (): Promise<void> => new Promise((resolve) => {
  const terminate = (): void => { process.off("SIGINT", terminate); process.off("SIGTERM", terminate); resolve(); };
  process.once("SIGINT", terminate);
  process.once("SIGTERM", terminate);
});
export const serve = async (args: readonly string[]): Promise<void> => {
  const service = new CoreService({ args: tuiServiceArgs(args), environment: processEnvironment, openAiFetch, compatibleFetch: globalThis.fetch, oauthFetch });
  const server = new RpcServer(service);
  try {
    const endpoint = await server.start();
    const handshake = JSON.stringify(endpoint);
    if (Buffer.byteLength(handshake, "utf8") > 1024) throw new Error("Loopback service handshake exceeds its bound");
    process.stdout.write(`${handshake}\n`);
    await waitForTermination();
  } finally { await server.close(); service.close(); }
};
const PROVIDERS_HELP_TEXT = `Usage: finleet providers list [--format <text|json>]

Query the live models.dev provider catalog and summarize its providers.

Parameters:
  --cache <path>   Optional local cache used only if the online query fails
  --url <https-url> Query this HTTPS catalog URL instead of models.dev
  --format text    Emit a human-readable provider summary (default)
  --format json    Emit provider summaries as JSON
  --help           Show this help text

Each provider includes its model count, executable model count, and model IDs.
Provider metadata is advisory and credentials are never printed.
`;

export async function readPromptFromStdin(input: AsyncIterable<string | Buffer>): Promise<Result<string>> {
  const chunks: string[] = [];
  let byteLength = 0;
  for await (const chunk of input) {
    const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    byteLength += Buffer.byteLength(text, "utf8");
    if (byteLength > MAX_EVENT_TEXT) return fail("PROMPT_TOO_LARGE", `stdin prompt exceeds ${MAX_EVENT_TEXT} bytes`);
    chunks.push(text);
  }
  const prompt = chunks.join("");
  return prompt.trim().length === 0 ? fail("PROMPT_EMPTY", "Prompt must not be empty") : { ok: true, value: prompt };
}
function parseLimit(value: string | undefined): Result<number> {
  if (value === undefined) return { ok: true, value: 20 };
  if (!/^[1-9]\d*$/.test(value)) return fail("LIMIT_INVALID", `--limit must be an integer from 1 to ${MAX_SESSION_LIST_LIMIT}`);
  const limit = Number(value);
  return Number.isSafeInteger(limit) && limit <= MAX_SESSION_LIST_LIMIT ? { ok: true, value: limit } : fail("LIMIT_INVALID", `--limit must be an integer from 1 to ${MAX_SESSION_LIST_LIMIT}`);
}
function readSessions(events: Result<readonly DurableEvent[]>): Result<readonly ReturnType<typeof projectSessions>[number][]> { return events.ok ? { ok: true, value: projectSessions(events.value) } : events; }
function selectSession(events: Result<readonly DurableEvent[]>, selector: string): Result<string> {
  const sessions = readSessions(events);
  if (!sessions.ok) return sessions;
  const ordered = [...sessions.value].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.sessionId.localeCompare(right.sessionId));
  if (selector === "--last") return ordered[0] === undefined ? fail("SESSION_UNKNOWN", "No durable session exists") : { ok: true, value: ordered[0].sessionId };
  return sessions.value.some((session) => session.sessionId === selector) ? { ok: true, value: selector } : fail("SESSION_UNKNOWN", `Session ${selector} does not exist`);
}
async function runPrompt(prompt: string, args: readonly string[], sessionId: string, promptId: string, environment: Environment, fetch: OpenAiFetch, compatibleFetch: CompatibleFetch, oauthFetch: OAuthFetch, workingDirectory?: string, approver?: PermissionApprover, signal?: AbortSignal): Promise<CliResponse> {
  const service = new CoreService({ args, environment, openAiFetch: fetch, compatibleFetch, oauthFetch, ...(workingDirectory === undefined ? {} : { workingDirectory }), ...(signal === undefined ? {} : { signal }), ...(approver === undefined ? {} : { localApprover: approver }) });
  try { return await service.submit({ prompt, sessionId, promptId }); } finally { service.close(); }
}
async function promptArgument(value: string | undefined, stdin: AsyncIterable<string | Buffer>): Promise<Result<string>> {
  if (value === undefined) return fail("PROMPT_MISSING", "Missing prompt argument");
  return value === "-" ? readPromptFromStdin(stdin) : value.trim().length === 0 ? fail("PROMPT_EMPTY", "Prompt must not be empty") : value.length > MAX_EVENT_TEXT ? fail("PROMPT_TOO_LARGE", `Prompt exceeds ${MAX_EVENT_TEXT} characters`) : { ok: true, value };
}

async function executeUnchecked(args: readonly string[], dependencies: ExecuteDependencies = {}): Promise<CliResponse> {
  const stdin = dependencies.stdin ?? process.stdin;
  const environment = dependencies.environment ?? processEnvironment;
  const fetch = dependencies.openAiFetch ?? openAiFetch;
  const compatibleTransport = dependencies.compatibleFetch ?? globalThis.fetch;
  const catalogTransport = dependencies.catalogFetch ?? remoteCatalogFetch;
  const oauthTransport = dependencies.oauthFetch ?? oauthFetch;
  const coreService = (): CoreService => new CoreService({ args, environment, openAiFetch: fetch, compatibleFetch: compatibleTransport, oauthFetch: oauthTransport, ...(dependencies.workingDirectory === undefined ? {} : { workingDirectory: dependencies.workingDirectory }), ...(dependencies.signal === undefined ? {} : { signal: dependencies.signal }), ...(dependencies.approver === undefined ? {} : { localApprover: dependencies.approver }) });
  if (args.includes("--help")) return { exitCode: 0, body: args[0] === "serve" ? SERVE_HELP_TEXT : args[0] === "providers" && (args[1] === undefined || args[1] === "list") ? PROVIDERS_HELP_TEXT : HELP_TEXT };
  if (args[0] === "auth" && args[1] === "login") {
    if (!supportedFormat(args)) return failure("--format must be text or json");
    if (required(args, "--provider") !== "openai") return failure("Only --provider openai is supported for auth login");
    const config = openAIOAuthConfig(environment);
      const credential = await loginBrowser(config, { fetch: oauthTransport, openBrowser: dependencies.openBrowser ?? openBrowserUrl, stdin });
    if (!credential.ok) return typedFailure(credential.error.code, credential.error.message);
    const saved = new OAuthCredentialStore(environment).save({ openai: credential.value }, option(args, "--auth-file"));
    return saved.ok ? { exitCode: 0, body: { provider: "openai", authenticated: true } } : typedFailure(saved.error.code, saved.error.message);
  }
  if (args[0] === "auth" && args[1] === "status") {
    if (!supportedFormat(args)) return failure("--format must be text or json");
    const status = new OAuthCredentialStore(environment).status(option(args, "--auth-file"));
    return status.ok ? { exitCode: 0, body: status.value } : typedFailure(status.error.code, status.error.message);
  }
  if (args[0] === "models" && args[1] === "list") { const cache = required(args, "--cache"); if (!args.includes("--offline")) return failure("models list requires --offline; catalog metadata is advisory only"); if (!supportedFormat(args)) return failure("--format must be text or json"); if (cache === undefined) return failure("Missing required --cache"); const catalog = catalogService.read(cache); return catalog.ok ? { exitCode: 0, body: { models: catalog.value.models, advisory: "Catalog metadata does not guarantee runtime availability." } } : failure(`${catalog.error.code}: ${catalog.error.message}`); }
  if (args[0] === "providers" && args[1] === "list") {
    const format = required(args, "--format") ?? "text";
    if (format !== "json" && format !== "text") return failure("--format must be text or json");
    if (args.includes("--offline")) return failure("--offline is not supported; providers list always queries models.dev");
    const cache = required(args, "--cache");
    if (cache === undefined) {
      const result = await catalogService.readRemote(option(args, "--url") ?? MODELS_DEV_API_URL, catalogTransport);
    return result.ok ? { exitCode: 0, body: providerListBody(catalogProviders(result.value), "models.dev", format) } : typedFailure(result.error.code, result.error.message);
    }
    const result = await catalogService.sync(cache, { remote: true, url: option(args, "--url") ?? MODELS_DEV_API_URL, fetch: catalogTransport });
    return result.ok ? { exitCode: 0, body: providerListBody(catalogProviders(result.value.cache), result.value.source === "fallback" ? "cache-fallback" : "models.dev", format) } : typedFailure(result.error.code, result.error.message);
  }
  if (args[0] === "models" && args[1] === "sync") { const cache = required(args, "--cache"); if (!supportedFormat(args)) return failure("--format must be text or json"); if (cache === undefined) return failure("Missing required --cache"); const remote = args.includes("--remote"); const url = option(args, "--url") ?? MODELS_DEV_API_URL; const syncOptions = remote ? { remote: true, url, fetch: remoteCatalogFetch } : { remote: false }; const result = await catalogService.sync(cache, syncOptions); return result.ok ? { exitCode: 0, body: { models: result.value.cache.models, source: result.value.source, advisory: "Catalog metadata does not guarantee runtime availability." } } : failure(`${result.error.code}: ${result.error.message}`); }
  if (args[0] === "agents" && args[1] === "list") { const cache = required(args, "--cache"); if (!supportedFormat(args)) return failure("--format must be text or json"); if (cache === undefined) return failure("Missing required --cache"); const catalog = catalogService.read(cache); return catalog.ok ? { exitCode: 0, body: { agents: agents.visible(catalog.value), execution: "primary-only; subagents are deferred" } } : failure(`${catalog.error.code}: ${catalog.error.message}`); }
  if (args[0] === "connectors" && args[1] === "list") { const agentId = required(args, "--agent"); if (!supportedFormat(args)) return failure("--format must be text or json"); if (agentId !== "paper-primary") return failure("AGENT_UNAVAILABLE: only the local primary agent is configurable"); const agent = agents.resolvePrimary("paper-primary", { schemaVersion: 1, source: "models.dev-cache", models: [{ id: "fake/finleet", provider: "fake", model: "finleet", displayName: "Fake Finleet", capabilities: [], modalities: [] }] }); return agent.ok ? { exitCode: 0, body: { connectors: connectors.visibleFor(agent.value), plugins: plugins.visibleFor(agent.value), mode: "deferred-only" } } : failure(`${agent.error.code}: ${agent.error.message}`); }
  if (args[0] === "sessions" && args[1] === "list") {
    const journal = required(args, "--journal"); const limit = parseLimit(option(args, "--limit"));
    if (!supportedFormat(args)) return failure("--format must be text or json");
    if (journal === undefined) return failure("sessions list requires --journal");
    if (!limit.ok) return failure(`${limit.error.code}: ${limit.error.message}`);
    const service = coreService(); try { const sessions = readSessions(service.events()); return sessions.ok ? { exitCode: 0, body: { sessions: [...sessions.value].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.sessionId.localeCompare(right.sessionId)).slice(0, limit.value), limit: limit.value, journal, creation: "Sessions are created on first prompt admission." } } : failure(`${sessions.error.code}: ${sessions.error.message}`); } finally { service.close(); }
  }
  if (args[0] === "session" && args[1] === "show") {
    const sessionId = args[2]; const journal = required(args, "--journal");
    if (!supportedFormat(args)) return failure("--format must be text or json");
    if (sessionId === undefined || journal === undefined) return failure("session show requires <SESSION_ID> and --journal");
    const service = coreService(); try { const events = service.events(); const sessions = readSessions(events);
      if (!sessions.ok) return failure(`${sessions.error.code}: ${sessions.error.message}`);
      const session = sessions.value.find((item) => item.sessionId === sessionId);
      if (session === undefined) return failure(`SESSION_UNKNOWN: Session ${sessionId} does not exist`);
      return events.ok ? { exitCode: 0, body: { session, history: projectHistory(events.value, sessionId), journal, mode: "recorded-outcome" } } : failure(`${events.error.code}: ${events.error.message}`);
    } finally { service.close(); }
  }
  if ((args[0] === "exec" && args[1] === "resume") || args[0] === "resume") {
    const offset = args[0] === "exec" ? 2 : 1; const selector = args[offset]; const suppliedPrompt = args[offset + 1]; const journal = option(args, "--journal") ?? ".finleet/journal.jsonl";
    if (selector === undefined) return failure("resume requires <SESSION_ID|--last>");
    const prompt = await promptArgument(suppliedPrompt, stdin); if (!prompt.ok) return failure(`${prompt.error.code}: ${prompt.error.message}`);
    const service = coreService(); const session = selectSession(service.events(), selector); service.close(); if (!session.ok) return failure(`${session.error.code}: ${session.error.message}`);
  return runPrompt(prompt.value, args, session.value, option(args, "--prompt-id") ?? `exec-${randomUUID()}`, environment, fetch, compatibleTransport, oauthTransport, dependencies.workingDirectory, dependencies.approver, dependencies.signal);
  }
  if (args[0] === "exec") {
    const prompt = await promptArgument(args[1], stdin); if (!prompt.ok) return failure(`${prompt.error.code}: ${prompt.error.message}`);
    const sessionId = option(args, "--session") ?? `session-${randomUUID()}`;
  return runPrompt(prompt.value, args, sessionId, option(args, "--prompt-id") ?? `exec-${randomUUID()}`, environment, fetch, compatibleTransport, oauthTransport, dependencies.workingDirectory, dependencies.approver, dependencies.signal);
  }
  if (args[0] === "agent" && args[1] === "run") {
    const prompt = required(args, "--prompt"); const journal = option(args, "--journal") ?? ".finleet/journal.jsonl"; const selectedDelivery = delivery(option(args, "--delivery") ?? "queue"); const sessionId = option(args, "--session") ?? "cli-paper";
    if (required(args, "--provider") !== "fake") return failure("Only --provider fake is implemented; live providers are deferred"); if (required(args, "--exchange") !== "paper") return failure("Only --exchange paper is implemented and is read-only; live trading is deferred"); if (!supportedFormat(args)) return failure("--format must be text or json"); if (prompt === undefined) return failure("Missing required --prompt"); if (selectedDelivery === undefined) return failure("--delivery must be queue or steer");
    const promptId = option(args, "--prompt-id") ?? `cli-${digest(`${sessionId}:${prompt}:${selectedDelivery}`).slice(0, 16)}`;
  return runPrompt(prompt, args, sessionId, promptId, environment, fetch, compatibleTransport, oauthTransport, dependencies.workingDirectory, dependencies.approver, dependencies.signal);
  }
  if (args[0] === "replay") { const journal = required(args, "--journal"); const sessionId = required(args, "--session"); if (!supportedFormat(args)) return failure("--format must be text or json"); if (journal === undefined || sessionId === undefined) return failure("replay requires --journal and --session"); const service = coreService(); try { const result = service.replay(sessionId); return result.ok ? { exitCode: 0, body: { history: result.value, journal, sessionId, mode: "recorded-outcome" } } : failure(`${result.error.code}: ${result.error.message}`); } finally { service.close(); } }
  return failure("Usage: finleet auth login --provider openai --format json | finleet auth status --format json [--auth-file <path>] | finleet providers list --format json [--cache <catalog>] | finleet models list --offline --cache <catalog> --format json | finleet models sync --cache <catalog> --format json [--remote --url <https-url>] | finleet sessions list --journal <path> --format json [--limit N] | finleet session show <SESSION_ID> --journal <path> --format json | finleet exec <PROMPT|-> --provider <fake|openai-responses|catalog-provider> --exchange paper --journal <path> [--session <id>] --format json [--cache <catalog> --model <provider/model>] | finleet exec resume <SESSION_ID|--last> <PROMPT|-> --provider fake --exchange paper --journal <path> --format json | finleet resume <SESSION_ID|--last> <PROMPT|-> --provider fake --exchange paper --journal <path> --format json | finleet agent run --provider fake --exchange paper --prompt <text> --delivery <queue|steer> --session <id> --prompt-id <id> --format json [--journal <path>] | finleet replay --journal <path> --session <id> --format json");
}
export async function execute(args: readonly string[], dependencies: ExecuteDependencies = {}): Promise<CliResponse> {
  try { return await executeUnchecked(args, dependencies); } catch { return typedFailure("CLI_IO_FAILED", "A filesystem or input operation failed"); }
}
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  if (args[0] === "serve" && !args.includes("--help")) void serve(args.slice(1)).catch((error: unknown) => { process.stderr.write(`${error instanceof Error ? error.message : "Unable to start loopback service"}\n`); process.exitCode = 2; });
  else void execute(args).then((response) => { const stream = response.exitCode === 0 ? process.stdout : process.stderr; const format = option(args, "--format") ?? "text"; stream.write(`${typeof response.body === "string" ? response.body : format === "json" ? JSON.stringify(response.body) : JSON.stringify(response.body, null, 2)}\n`); process.exitCode = response.exitCode; });
}

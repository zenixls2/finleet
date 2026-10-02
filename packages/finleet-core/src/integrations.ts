import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModelV4Prompt } from "@ai-sdk/provider";
import { fail, redactJson, type Permission, type ProviderFinishReason, type Result } from "./domain.js";
import type { Provider, ProviderEvent, ProviderRequest } from "./runtime.js";
import { resolveOAuthCredential } from "./auth.js";
import type { OAuthFetch } from "./auth.js";

export type CatalogExecution = { adapter: "ai-sdk/openai-compatible"; protocol: "openai-chat-completions"; baseUrl: string; apiKeyEnv: string; } | { adapter: "ai-sdk/anthropic"; protocol: "anthropic-messages"; baseUrl: string; apiKeyEnv: string; };
export interface CatalogModel { id: string; provider: string; model: string; displayName: string; capabilities: readonly string[]; modalities: readonly string[]; contextWindow?: number; execution?: CatalogExecution; }
export interface CatalogCache { schemaVersion: 1; source: "models.dev-cache"; models: readonly CatalogModel[]; }
export interface CatalogProviderSummary { id: string; modelCount: number; executableModelCount: number; models: readonly string[]; }
const compareIds = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;
export interface CatalogFetchResponse { ok: boolean; status: number; json(): Promise<unknown>; }
export type CatalogFetch = (url: string, init: { method: "GET"; headers: Readonly<Record<string, string>> }) => Promise<CatalogFetchResponse>;
export interface CatalogSyncOptions { remote: boolean; url?: string; fetch?: CatalogFetch; }
export const MODELS_DEV_API_URL = "https://models.dev/api.json";
const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const safeDiagnostic = (value: string): string => {
  const redacted = redactJson(value);
  return typeof redacted === "string" ? redacted : "[REDACTED]";
};
const strings = (value: unknown): readonly string[] | undefined => Array.isArray(value) && value.every((item) => typeof item === "string") ? value : undefined;
const optionalStrings = (value: Record<string, unknown>, key: string): readonly string[] | undefined => value[key] === undefined ? [] : strings(value[key]);
const positiveInteger = (value: unknown): number | undefined => typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
const nonNegativeInteger = (value: unknown): number | undefined => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
const httpsUrl = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  try { const url = new URL(value); return url.protocol === "https:" ? url.toString() : undefined; } catch { return undefined; }
};
const executionFrom = (value: unknown): CatalogExecution | undefined => {
  if (!record(value) || typeof value.apiKeyEnv !== "string" || value.apiKeyEnv.length === 0) return undefined;
  const baseUrl = httpsUrl(value.baseUrl); if (baseUrl === undefined) return undefined;
  if (value.adapter === "ai-sdk/openai-compatible" && value.protocol === "openai-chat-completions") return { adapter: value.adapter, protocol: value.protocol, baseUrl, apiKeyEnv: value.apiKeyEnv };
  if (value.adapter === "ai-sdk/anthropic" && value.protocol === "anthropic-messages") return { adapter: value.adapter, protocol: value.protocol, baseUrl, apiKeyEnv: value.apiKeyEnv };
  return undefined;
};
const modelFrom = (value: unknown): CatalogModel | undefined => {
  if (!record(value) || typeof value.provider !== "string" || typeof value.model !== "string" || typeof value.displayName !== "string") return undefined;
  const capabilities = optionalStrings(value, "capabilities");
  const modalities = optionalStrings(value, "modalities");
  if (capabilities === undefined || modalities === undefined) return undefined;
  const contextWindow = value.contextWindow === undefined ? undefined : positiveInteger(value.contextWindow);
  if (value.contextWindow !== undefined && contextWindow === undefined) return undefined;
  const execution = value.execution === undefined ? undefined : executionFrom(value.execution);
  if (value.execution !== undefined && execution === undefined) return undefined;
  const id = `${value.provider}/${value.model}`;
  return value.provider.length > 0 && value.model.length > 0 && (value.id === undefined || value.id === id) ? { id, provider: value.provider, model: value.model, displayName: value.displayName, capabilities, modalities, ...(contextWindow === undefined ? {} : { contextWindow }), ...(execution === undefined ? {} : { execution }) } : undefined;
};
const modelsDevExecution = (provider: Record<string, unknown>): CatalogExecution | undefined => {
  const apiKeyEnv = strings(provider.env); const baseUrl = httpsUrl(provider.api);
  if (apiKeyEnv === undefined || apiKeyEnv.length !== 1 || apiKeyEnv[0] === undefined || apiKeyEnv[0].length === 0 || baseUrl === undefined) return undefined;
  if (provider.npm === "@ai-sdk/openai-compatible") return { adapter: "ai-sdk/openai-compatible", protocol: "openai-chat-completions", baseUrl, apiKeyEnv: apiKeyEnv[0] };
  if (provider.npm === "@ai-sdk/anthropic") return { adapter: "ai-sdk/anthropic", protocol: "anthropic-messages", baseUrl, apiKeyEnv: apiKeyEnv[0] };
  return undefined;
};
const modelsDevCapabilities = (model: Record<string, unknown>): readonly string[] | undefined => {
  const known = ["attachment", "reasoning", "tool_call", "structured_output", "temperature", "interleaved", "open_weights"];
  if (known.some((capability) => model[capability] !== undefined && typeof model[capability] !== "boolean" && !(capability === "interleaved" && record(model[capability]) && typeof model[capability].field === "string"))) return undefined;
  return known.filter((capability) => model[capability] === true || (capability === "interleaved" && record(model[capability])));
};
const modelsDevModalities = (value: unknown): readonly string[] | undefined => {
   if (value === undefined) return [];
   if (!record(value)) return undefined;
   const input = value.input === undefined ? [] : strings(value.input); const output = value.output === undefined ? [] : strings(value.output);
   if (input === undefined || output === undefined) return undefined;
   return [...input.map((modality) => `input:${modality}`), ...output.map((modality) => `output:${modality}`)];
};
const modelsDevCatalog = (providers: Record<string, unknown>): CatalogModel[] | undefined => {
  const models: CatalogModel[] = [];
  for (const [providerId, providerValue] of Object.entries(providers)) {
    if (!record(providerValue) || !record(providerValue.models)) return undefined;
    if (typeof providerValue.id !== "string" || providerValue.id !== providerId || typeof providerValue.name !== "string" || typeof providerValue.npm !== "string" || !Array.isArray(providerValue.env)) return undefined;
    const providerExecution = modelsDevExecution(providerValue);
    for (const [modelId, modelValue] of Object.entries(providerValue.models)) {
      if (!record(modelValue)) return undefined;
      if (typeof modelValue.id !== "string" || modelValue.id !== modelId || typeof modelValue.name !== "string" || providerId.length === 0 || modelId.length === 0) return undefined;
       const limit = modelValue.limit === undefined ? undefined : record(modelValue.limit) ? modelValue.limit : undefined;
       if (modelValue.limit !== undefined && limit === undefined) return undefined;
       const knownLimits = ["context", "input", "output"];
        if (limit !== undefined && knownLimits.some((field) => limit[field] !== undefined && nonNegativeInteger(limit[field]) === undefined)) return undefined;
        const contextWindow = limit === undefined || limit.context === undefined || limit.context === 0 ? undefined : positiveInteger(limit.context);
       const modalities = modelsDevModalities(modelValue.modalities);
       if (modalities === undefined) return undefined;
       const capabilities = modelsDevCapabilities(modelValue);
       if (capabilities === undefined) return undefined;
       models.push({ id: `${providerId}/${modelId}`, provider: providerId, model: modelId, displayName: modelValue.name, capabilities, modalities, ...(contextWindow === undefined ? {} : { contextWindow }), ...(providerExecution === undefined ? {} : { execution: providerExecution }) });
    }
  }
  return models;
};
export function parseCatalog(value: unknown): Result<CatalogCache> {
  if (!record(value)) return fail("CATALOG_INVALID", "Catalog must be an object");
  if (!Array.isArray(value.models)) { const providers = record(value.providers) ? value.providers : value; const models = modelsDevCatalog(providers); return models === undefined ? fail("CATALOG_INVALID", "Catalog requires normalized models or a valid models.dev provider map") : { ok: true, value: { schemaVersion: 1, source: "models.dev-cache", models } }; }
  const models: CatalogModel[] = [];
  for (const item of value.models) { const model = modelFrom(item); if (model === undefined) return fail("CATALOG_INVALID", "Each catalog model requires provider, model, displayName, valid metadata, and explicit execution metadata when configured"); models.push(model); }
  return { ok: true, value: { schemaVersion: 1, source: "models.dev-cache", models } };
}
export function catalogProviders(catalog: CatalogCache): readonly CatalogProviderSummary[] {
  const providers = new Map<string, CatalogModel[]>();
  for (const model of catalog.models) {
    const models = providers.get(model.provider) ?? [];
    models.push(model);
    providers.set(model.provider, models);
  }
  return [...providers.entries()].sort(([left], [right]) => compareIds(left, right)).map(([id, models]) => ({
    id,
    modelCount: models.length,
    executableModelCount: models.filter((model) => model.execution !== undefined).length,
    models: models.map((model) => model.model).sort(compareIds),
  }));
}
export class ModelCatalogService {
  read(path: string): Result<CatalogCache> { let value: unknown; try { value = JSON.parse(readFileSync(path, "utf8")) as unknown; } catch { return fail("CATALOG_INVALID", "Catalog cache must contain valid JSON"); } return parseCatalog(value); }
  async readRemote(url: string, fetch: CatalogFetch): Promise<Result<CatalogCache>> {
    let parsedUrl: URL;
    try { parsedUrl = new URL(url); } catch { return fail("CATALOG_REMOTE_CONFIG", "Remote catalog URL is invalid"); }
    if (parsedUrl.protocol !== "https:") return fail("CATALOG_REMOTE_CONFIG", "Remote catalog URL must use HTTPS");
    try {
      const response = await fetch(parsedUrl.toString(), { method: "GET", headers: { accept: "application/json" } });
      if (!response.ok) return fail("CATALOG_REMOTE_FAILED", "Remote catalog request failed");
      const parsed = parseCatalog(await response.json());
      return parsed.ok ? parsed : fail("CATALOG_INVALID", "Remote catalog metadata is invalid");
    } catch { return fail("CATALOG_REMOTE_FAILED", "Remote catalog request failed"); }
  }
  async sync(path: string, options: CatalogSyncOptions): Promise<Result<{ cache: CatalogCache; source: "cache" | "remote" | "fallback" }>> {
    const cached = this.read(path);
    if (!options.remote) return cached.ok ? { ok: true, value: { cache: cached.value, source: "cache" } } : cached;
    if (options.url === undefined || options.fetch === undefined) return fail("CATALOG_REMOTE_CONFIG", "Remote sync requires an injected fetch and HTTPS URL");
    let url: URL; try { url = new URL(options.url); } catch { return fail("CATALOG_REMOTE_CONFIG", "Remote catalog URL is invalid"); }
    if (url.protocol !== "https:") return fail("CATALOG_REMOTE_CONFIG", "Remote catalog URL must use HTTPS");
    try { const response = await options.fetch(url.toString(), { method: "GET", headers: { accept: "application/json" } }); if (!response.ok) throw new Error(`HTTP ${response.status}`); const parsed = parseCatalog(await response.json()); if (!parsed.ok) throw new Error("CATALOG_INVALID"); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(parsed.value), "utf8"); return { ok: true, value: { cache: parsed.value, source: "remote" } }; } catch { return cached.ok ? { ok: true, value: { cache: cached.value, source: "fallback" } } : fail("CATALOG_REMOTE_FAILED", "Remote catalog sync failed and no valid cache exists"); }
  }
}

export interface OpenAiFetchResponse { ok: boolean; status: number; headers?: Readonly<Record<string, string | undefined>>; json(): Promise<unknown>; text?: () => Promise<string>; }
export type OpenAiFetch = (url: string, init: { method: "POST"; headers: Readonly<Record<string, string>>; body: string; signal?: AbortSignal }) => Promise<OpenAiFetchResponse>;
export type CompatibleFetch = typeof fetch;
export interface ProviderLocation { providerId: string; modelId: string; baseUrl: string; apiKeyEnv: string; }
export interface Environment { get(name: string): string | undefined; }
const providerPrompt = (request: ProviderRequest): LanguageModelV4Prompt => [
  ...(request.system.length === 0 ? [] : [{ role: "system" as const, content: request.system }]),
  ...request.messages.map((message) => message.role === "tool" ? { role: "tool" as const, content: [{ type: "tool-result" as const, toolCallId: message.toolCallId ?? message.eventId, toolName: message.toolName ?? "deferred", output: { type: "text" as const, value: message.content } }] } : message.role === "assistant" && message.toolCalls !== undefined ? { role: "assistant" as const, content: message.toolCalls.map((call) => ({ type: "tool-call" as const, toolCallId: call.callId, toolName: call.name, input: parseToolArguments(call.arguments) ?? {} })) } : { role: message.role, content: [{ type: "text" as const, text: message.content }] }),
];
const providerTools = (request: ProviderRequest) => request.tools.map((tool) => ({ type: "function" as const, name: tool.name, description: tool.description, inputSchema: tool.inputSchema }));
const parseToolArguments = (value: unknown): unknown => { if (typeof value !== "string") return value; try { return JSON.parse(value) as unknown; } catch { return undefined; } };
const toolExecution = (request: ProviderRequest, name: string): "local" | "provider" => request.tools.some((tool) => tool.name === name) ? "local" : "provider";
const normalizeFinishReason = (reason: string): ProviderFinishReason => reason === "error" ? "error" : reason === "length" ? "length" : reason === "content-filter" ? "content-filter" : reason === "tool-calls" ? "tool-calls" : "stop";
type CodexInputItem = { type: "function_call"; call_id: string; name: string; arguments: string } | { type: "function_call_output"; call_id: string; output: string } | { role: "user" | "assistant"; content: string };
const codexInput = (messages: ProviderRequest["messages"]): CodexInputItem[] => messages.flatMap((message): CodexInputItem[] => message.role === "tool" ? [{ type: "function_call_output", call_id: message.toolCallId ?? message.eventId, output: message.content }] : message.role === "assistant" && message.toolCalls !== undefined ? message.toolCalls.map((call): CodexInputItem => ({ type: "function_call", call_id: call.callId, name: call.name, arguments: call.arguments })) : [{ role: message.role, content: message.content }]);
export class OpenAICompatibleProvider implements Provider {
  readonly mode = "deferred" as const;
  readonly #apiKey: string;
  constructor(readonly providerId: string, readonly modelId: string, private readonly baseUrl: string, apiKey: string, private readonly fetch: CompatibleFetch) { this.#apiKey = apiKey; }
  async *stream(request: ProviderRequest): AsyncIterable<ProviderEvent> {
    const provider = createOpenAICompatible({ name: this.providerId, baseURL: this.baseUrl, apiKey: this.#apiKey, fetch: (input, init) => this.fetch(input, request.signal === undefined ? init : { ...init, signal: request.signal }) });
    const result = await provider.chatModel(this.modelId).doGenerate({ prompt: providerPrompt(request), tools: providerTools(request) });
    for (const content of result.content) {
      if (content.type === "text") yield { type: "text", text: content.text };
      if (content.type === "tool-call") yield { type: "provider_tool_call", callId: content.toolCallId, name: content.toolName, arguments: parseToolArguments(content.input), execution: toolExecution(request, content.toolName) };
    }
    const usage = { inputTokens: result.usage.inputTokens.total ?? 0, outputTokens: result.usage.outputTokens.total ?? 0 };
     yield { type: "finished", finishReason: normalizeFinishReason(result.finishReason.unified), usage };
  }
}
export class OpenAICompatibleResolver {
  constructor(private readonly environment: Environment, private readonly fetch: CompatibleFetch) {}
  resolve(location: ProviderLocation, catalog: CatalogCache): Result<OpenAICompatibleProvider> {
    const selected = catalog.models.find((model) => model.id === location.modelId && model.provider === location.providerId);
    if (selected === undefined) return fail("PROVIDER_MODEL_UNAVAILABLE", "Provider/model is not present in the advisory catalog");
    if (selected.execution?.adapter !== "ai-sdk/openai-compatible" || selected.execution.protocol !== "openai-chat-completions") return fail("PROVIDER_NATIVE_UNSUPPORTED", "Catalog metadata does not declare an executable OpenAI-compatible adapter for this provider/model");
    if (selected.execution.baseUrl !== location.baseUrl || selected.execution.apiKeyEnv !== location.apiKeyEnv) return fail("PROVIDER_LOCATION_INVALID", "Provider location does not match the catalog execution contract");
    let url: URL; try { url = new URL(location.baseUrl); } catch { return fail("PROVIDER_LOCATION_INVALID", "Provider base URL is invalid"); }
    if (url.protocol !== "https:") return fail("PROVIDER_LOCATION_INVALID", "Provider base URL must use HTTPS");
    const apiKey = this.environment.get(location.apiKeyEnv); if (apiKey === undefined || apiKey.length === 0) return fail("PROVIDER_CREDENTIAL_MISSING", `Missing ${location.apiKeyEnv}; no provider request was made`);
    return { ok: true, value: new OpenAICompatibleProvider(location.providerId, location.modelId.slice(location.providerId.length + 1), url.toString(), apiKey, this.fetch) };
  }
  resolveCatalog(providerId: string, modelId: string, catalog: CatalogCache): Result<OpenAICompatibleProvider> {
    const model = catalog.models.find((candidate) => candidate.id === modelId && candidate.provider === providerId);
    if (model === undefined) return fail("PROVIDER_MODEL_UNAVAILABLE", "Provider/model is not present in the advisory catalog");
    if (model.execution === undefined || model.execution.adapter !== "ai-sdk/openai-compatible") return fail("PROVIDER_NATIVE_UNSUPPORTED", "Catalog metadata does not declare an executable OpenAI-compatible adapter for this provider/model");
    return this.resolve({ providerId, modelId, baseUrl: model.execution.baseUrl, apiKeyEnv: model.execution.apiKeyEnv }, catalog);
  }
}
export class AnthropicProvider implements Provider {
  readonly mode = "deferred" as const;
  readonly #apiKey: string;
  constructor(readonly providerId: string, readonly modelId: string, private readonly baseUrl: string, apiKey: string, private readonly fetch: CompatibleFetch) { this.#apiKey = apiKey; }
  async *stream(request: ProviderRequest): AsyncIterable<ProviderEvent> {
    const anthropic = createAnthropic({ baseURL: this.baseUrl, apiKey: this.#apiKey, fetch: (input, init) => this.fetch(input, request.signal === undefined ? init : { ...init, signal: request.signal }) });
    const result = await anthropic(this.modelId).doStream({ prompt: providerPrompt(request), tools: providerTools(request) });
    for await (const part of result.stream) {
      if (part.type === "text-delta") yield { type: "text", text: part.delta };
      if (part.type === "tool-call") yield { type: "provider_tool_call", callId: part.toolCallId, name: part.toolName, arguments: parseToolArguments(part.input), execution: toolExecution(request, part.toolName) };
       if (part.type === "finish") yield { type: "finished", finishReason: normalizeFinishReason(part.finishReason.unified), usage: { inputTokens: part.usage.inputTokens.total ?? 0, outputTokens: part.usage.outputTokens.total ?? 0 } };
      if (part.type === "error") throw part.error;
    }
  }
}
export class AnthropicResolver {
  constructor(private readonly environment: Environment, private readonly fetch: CompatibleFetch) {}
  resolve(location: ProviderLocation, catalog: CatalogCache): Result<AnthropicProvider> {
    const selected = catalog.models.find((model) => model.id === location.modelId && model.provider === location.providerId);
    if (selected === undefined) return fail("PROVIDER_MODEL_UNAVAILABLE", "Provider/model is not present in the advisory catalog");
    if (selected.execution?.adapter !== "ai-sdk/anthropic" || selected.execution.protocol !== "anthropic-messages") return fail("PROVIDER_NATIVE_UNSUPPORTED", "Catalog metadata does not declare an executable Anthropic adapter for this provider/model");
    if (selected.execution.baseUrl !== location.baseUrl || selected.execution.apiKeyEnv !== location.apiKeyEnv) return fail("PROVIDER_LOCATION_INVALID", "Provider location does not match the catalog execution contract");
    const baseUrl = httpsUrl(location.baseUrl); if (baseUrl === undefined) return fail("PROVIDER_LOCATION_INVALID", "Provider base URL must use HTTPS");
    const apiKey = this.environment.get(location.apiKeyEnv); if (apiKey === undefined || apiKey.length === 0) return fail("PROVIDER_CREDENTIAL_MISSING", `Missing ${location.apiKeyEnv}; no provider request was made`);
    return { ok: true, value: new AnthropicProvider(location.providerId, location.modelId.slice(location.providerId.length + 1), baseUrl, apiKey, this.fetch) };
  }
  resolveCatalog(providerId: string, modelId: string, catalog: CatalogCache): Result<AnthropicProvider> {
    const model = catalog.models.find((candidate) => candidate.id === modelId && candidate.provider === providerId);
    if (model === undefined) return fail("PROVIDER_MODEL_UNAVAILABLE", "Provider/model is not present in the advisory catalog");
    if (model.execution === undefined || model.execution.adapter !== "ai-sdk/anthropic") return fail("PROVIDER_NATIVE_UNSUPPORTED", "Catalog metadata does not declare an executable Anthropic adapter for this provider/model");
    return this.resolve({ providerId, modelId, baseUrl: model.execution.baseUrl, apiKeyEnv: model.execution.apiKeyEnv }, catalog);
  }
}
export class CatalogProviderResolver {
  constructor(private readonly environment: Environment, private readonly fetch: CompatibleFetch) {}
  resolveCatalog(providerId: string, modelId: string, catalog: CatalogCache): Result<OpenAICompatibleProvider | AnthropicProvider> {
    const model = catalog.models.find((candidate) => candidate.id === modelId && candidate.provider === providerId);
    if (model === undefined) return fail("PROVIDER_MODEL_UNAVAILABLE", "Provider/model is not present in the advisory catalog");
    if (model.execution === undefined) return fail("PROVIDER_NATIVE_UNSUPPORTED", "Catalog metadata does not declare an executable supported adapter for this provider/model");
    return model.execution.adapter === "ai-sdk/openai-compatible" ? new OpenAICompatibleResolver(this.environment, this.fetch).resolveCatalog(providerId, modelId, catalog) : new AnthropicResolver(this.environment, this.fetch).resolveCatalog(providerId, modelId, catalog);
  }
}

const responseText = (body: unknown): string | undefined => {
  if (!record(body) || !Array.isArray(body.output)) return undefined;
  const parts: string[] = [];
  for (const output of body.output) {
    if (!record(output) || output.type !== "message" || !Array.isArray(output.content)) continue;
    for (const content of output.content) if (record(content) && content.type === "output_text" && typeof content.text === "string") parts.push(content.text);
  }
  return parts.length === 0 ? undefined : parts.join("");
};

const outputItems = (body: unknown): readonly Record<string, unknown>[] => {
  if (!record(body) || !Array.isArray(body.output)) return [];
  return body.output.filter((item): item is Record<string, unknown> => record(item));
};

const functionCall = (output: Record<string, unknown>): output is Record<string, unknown> & { type: "function_call"; call_id: string; name: string } => output.type === "function_call" && typeof output.call_id === "string" && typeof output.name === "string";

const responseUsage = (body: unknown): { inputTokens: number; outputTokens: number } => {
  const usage = record(body) && record(body.usage) ? body.usage : undefined;
  const inputTokens = usage !== undefined && typeof usage.input_tokens === "number" && Number.isSafeInteger(usage.input_tokens) ? usage.input_tokens : 0;
  const outputTokens = usage !== undefined && typeof usage.output_tokens === "number" && Number.isSafeInteger(usage.output_tokens) ? usage.output_tokens : 0;
  return { inputTokens, outputTokens };
};

const parseStreamingResponse = (source: string): { text: string; functionCalls: readonly { callId: string; name: string; arguments: unknown }[]; usage: { inputTokens: number; outputTokens: number } } | undefined => {
  const events: unknown[] = [];
  for (const line of source.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (payload === "[DONE]") continue;
    try { events.push(JSON.parse(payload) as unknown); } catch { return undefined; }
  }
  if (events.length === 0) return undefined;
  let text = ""; let completed: Record<string, unknown> | undefined; let terminal = ""; const functionCalls: { callId: string; name: string; arguments: unknown }[] = [];
  for (const event of events) {
    if (!record(event)) return undefined;
    terminal = typeof event.type === "string" ? event.type : "";
    if (event.type === "response.failed" || event.type === "response.incomplete") return undefined;
    if (event.type === "response.output_text.delta" && typeof event.delta === "string") text += event.delta;
    if (event.type === "response.completed" && record(event.response)) completed = event.response;
    if (event.type === "response.output_item.done" && record(event.item) && event.item.type === "function_call" && typeof event.item.call_id === "string" && typeof event.item.name === "string") functionCalls.push({ callId: event.item.call_id, name: event.item.name, arguments: parseToolArguments(event.item.arguments) });
  }
  if (completed === undefined || terminal !== "response.completed") return undefined;
  if (text.length === 0) text = responseText(completed) ?? "";
  return { text, functionCalls, usage: responseUsage(completed) };
};

export class OpenAIResponsesProvider implements Provider {
  readonly providerId = "openai-responses";
  readonly modelId = "gpt-5.6-luna";
  readonly mode = "deferred" as const;
  #token: string;
  constructor(token: string, private readonly fetch: OpenAiFetch, private readonly oauth?: { accountId: string }) { this.#token = token; }
  private static httpFailure(response: OpenAiFetchResponse, body: unknown): Error {
    const error = record(body) && record(body.error) ? body.error : undefined;
    const code = error !== undefined && typeof error.code === "string" ? safeDiagnostic(error.code) : undefined;
    const message = error !== undefined && typeof error.message === "string" ? safeDiagnostic(error.message) : undefined;
    const requestIdHeader = response.headers?.["x-request-id"];
    const requestId = requestIdHeader === undefined ? undefined : safeDiagnostic(requestIdHeader);
    const details = [code, message, requestId === undefined ? undefined : `request_id=${requestId}`].filter((value): value is string => value !== undefined && value.length > 0).join(": ");
    return new Error(`OPENAI_RESPONSES_HTTP_FAILURE: HTTP ${response.status}${details.length === 0 ? "" : `: ${details}`}`);
  }
  async *stream(request: ProviderRequest): AsyncIterable<ProviderEvent> {
    let response: OpenAiFetchResponse;
    try {
      const oauth = this.oauth !== undefined;
      const headers: Record<string, string> = { "content-type": "application/json", authorization: `Bearer ${this.#token}` };
      const url = oauth ? "https://chatgpt.com/backend-api/codex/responses" : "https://api.openai.com/v1/responses";
      if (oauth) { headers.originator = "codex_cli_rs"; headers["openai-beta"] = "responses=experimental"; headers["chatgpt-account-id"] = this.oauth.accountId; }
      const init: Parameters<OpenAiFetch>[1] = {
        method: "POST",
        headers,
          body: JSON.stringify({ model: this.modelId, input: codexInput(request.messages), tools: request.tools.map((tool) => ({ type: "function", name: tool.name, description: tool.description, parameters: tool.inputSchema })), ...(oauth ? { instructions: request.system || "You are Codex, a coding assistant.", store: false, stream: true } : { instructions: request.system, reasoning: { effort: "high" } }) }),
      };
      response = await this.fetch(url, request.signal === undefined ? init : { ...init, signal: request.signal });
    } catch { throw new Error("OPENAI_RESPONSES_REQUEST_FAILED"); }
    if (!response.ok) {
      let body: unknown = undefined;
      try { body = await response.json(); } catch (cause) { body = cause instanceof Error ? { error: { message: cause.message } } : undefined; }
      throw OpenAIResponsesProvider.httpFailure(response, body);
    }
    let body: unknown; let streamed: ReturnType<typeof parseStreamingResponse>;
    if (this.oauth !== undefined && response.text !== undefined) {
      try { streamed = parseStreamingResponse(await response.text()); } catch { throw new Error("OPENAI_RESPONSES_RESPONSE_INVALID"); }
      if (streamed === undefined) throw new Error("OPENAI_RESPONSES_RESPONSE_INVALID");
      body = undefined;
    } else {
      try { body = await response.json(); } catch { throw new Error("OPENAI_RESPONSES_RESPONSE_INVALID"); }
    }
    if (streamed !== undefined) {
      if (streamed.text.length > 0) yield { type: "text", text: streamed.text };
      for (const call of streamed.functionCalls) yield { type: "provider_tool_call", callId: call.callId, name: call.name, arguments: call.arguments, execution: toolExecution(request, call.name) };
      yield { type: "finished", finishReason: streamed.functionCalls.length > 0 ? "tool-calls" : "stop", usage: streamed.usage };
      return;
    }
    const text = responseText(body);
    const outputs = outputItems(body);
    if (text !== undefined) yield { type: "text", text };
    const functionCalls = outputs.filter(functionCall);
    for (const output of functionCalls) yield { type: "provider_tool_call", callId: output.call_id, name: output.name, arguments: parseToolArguments(output.arguments), execution: toolExecution(request, output.name) };
    if (text === undefined && outputs.length === 0) throw new Error("OPENAI_RESPONSES_RESPONSE_INVALID");
    yield { type: "finished", finishReason: functionCalls.length > 0 ? "tool-calls" : "stop", usage: responseUsage(body) };
  }
}

export class OpenAIResponsesResolver {
  constructor(private readonly environment: Environment, private readonly fetch: OpenAiFetch, private readonly oauthFetch: OAuthFetch, private readonly authFile?: string) {}
  async resolve(): Promise<Result<OpenAIResponsesProvider>> {
    const apiKey = this.environment.get("OPENAI_API_KEY");
    if (apiKey !== undefined && apiKey.length > 0) return { ok: true, value: new OpenAIResponsesProvider(apiKey, this.fetch) };
    const resolved = await resolveOAuthCredential(this.environment, this.oauthFetch, this.authFile);
    if (!resolved.ok) return resolved;
    const accountId = resolved.value.credential.accountId;
    if (accountId === undefined) return fail("OPENAI_OAUTH_ACCOUNT_REQUIRED", "OpenAI OAuth credentials must include a ChatGPT account ID");
    return { ok: true, value: new OpenAIResponsesProvider(resolved.value.credential.access, this.fetch, { accountId }) };
  }
}

export interface AgentDefinition { id: string; kind: "primary" | "subagent"; modelId: string; requiredCapabilities: readonly string[]; permissions: readonly Permission[]; budget: { maxTurns: number; maxContextChars: number }; }
export class AgentCatalog {
  constructor(private readonly agents: readonly AgentDefinition[]) {}
  visible(catalog: CatalogCache): readonly AgentDefinition[] { return this.agents.filter((agent) => catalog.models.some((model) => model.id === agent.modelId && agent.requiredCapabilities.every((capability) => model.capabilities.includes(capability)))); }
  resolvePrimary(id: string, catalog: CatalogCache): Result<AgentDefinition> { const agent = this.visible(catalog).find((candidate) => candidate.id === id); if (agent === undefined) return fail("AGENT_UNAVAILABLE", "Agent or model is unavailable"); if (agent.kind !== "primary") return fail("AGENT_DEFERRED", "Subagents are catalog-only and cannot execute"); return { ok: true, value: agent }; }
}
export interface TrustedPlugin { id: string; enabled: boolean; requiredPermissions: readonly Permission[]; mode: "deferred"; }
export type ConnectorKind = "native-exchange-api" | "local-exchange-cli" | "stdio-mcp";
export interface Connector { id: string; kind: ConnectorKind; enabled: boolean; requiredPermissions: readonly Permission[]; mode: "deferred"; }
const permitted = (required: readonly Permission[], permissions: readonly Permission[]): boolean => required.every((permission) => permissions.includes(permission));
export class TrustedPluginRegistry { constructor(private readonly plugins: readonly TrustedPlugin[]) {} visibleFor(agent: AgentDefinition): readonly TrustedPlugin[] { return this.plugins.filter((plugin) => plugin.enabled && permitted(plugin.requiredPermissions, agent.permissions)); } }
export class ConnectorRegistry { constructor(private readonly connectors: readonly Connector[]) {} visibleFor(agent: AgentDefinition): readonly Connector[] { return this.connectors.filter((connector) => connector.enabled && permitted(connector.requiredPermissions, agent.permissions)); } }

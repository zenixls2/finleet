import { closeSync, chmodSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { fail, type Result } from "./domain.js";
import type { Environment } from "./integrations.js";

export const OPENAI_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const OPENAI_OAUTH_ISSUER = "https://auth.openai.com";
export const OPENAI_OAUTH_SCOPES = "openid profile email offline_access";
export const OPENAI_OAUTH_PORT = 1455;

export interface OAuthProviderConfig { issuer: string; clientId: string; scopes: string; originator?: string; port: number; }
export interface OAuthFetchResponse { ok: boolean; status: number; json(): Promise<unknown>; }
export type OAuthFetch = (url: string, init: { method: "POST"; headers: Readonly<Record<string, string>>; body: string }) => Promise<OAuthFetchResponse>;
export interface PKCECodes { codeVerifier: string; codeChallenge: string; }
export interface OAuthLoginOptions { fetch: OAuthFetch; openBrowser?: (url: string) => Promise<void>; stdin?: AsyncIterable<string | Buffer>; timeoutMs?: number; }

export const openAIOAuthConfig = (environment?: Environment): OAuthProviderConfig => ({
  issuer: OPENAI_OAUTH_ISSUER,
  clientId: environment?.get("FINLEET_OPENAI_CLIENT_ID") ?? OPENAI_OAUTH_CLIENT_ID,
  scopes: OPENAI_OAUTH_SCOPES,
  originator: "codex_cli_rs",
  port: OPENAI_OAUTH_PORT,
});

export function generatePKCE(): PKCECodes {
  const verifier = randomBytes(64).toString("base64url");
  return { codeVerifier: verifier, codeChallenge: createHash("sha256").update(verifier).digest("base64url") };
}

export function generateOAuthState(): string { return randomBytes(32).toString("hex"); }

export function buildAuthorizeURL(config: OAuthProviderConfig, pkce: PKCECodes, state: string, redirectUri: string): string {
  const params = new URLSearchParams({ response_type: "code", client_id: config.clientId, redirect_uri: redirectUri, scope: config.scopes, code_challenge: pkce.codeChallenge, code_challenge_method: "S256", state, id_token_add_organizations: "true", codex_cli_simplified_flow: "true" });
  if (config.originator !== undefined && config.originator.length > 0) params.set("originator", config.originator);
  return `${config.issuer}/oauth/authorize?${params.toString()}`;
}

const jsonObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const tokenString = (value: unknown): string | undefined => typeof value === "string" && value.length > 0 ? value : undefined;

function jwtAccountId(token: string): string | undefined {
  const payload = token.split(".")[1];
  if (payload === undefined) return undefined;
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as unknown;
    if (!jsonObject(claims)) return undefined;
    const direct = [claims.chatgpt_account_id, claims["https://api.openai.com/auth.chatgpt_account_id"]];
    for (const value of direct) { const accountId = tokenString(value); if (accountId !== undefined) return accountId; }
    const auth = claims["https://api.openai.com/auth"];
    if (jsonObject(auth)) { const accountId = tokenString(auth.chatgpt_account_id); if (accountId !== undefined) return accountId; }
    if (Array.isArray(claims.organizations)) for (const organization of claims.organizations) if (jsonObject(organization)) { const accountId = tokenString(organization.id); if (accountId !== undefined) return accountId; }
  } catch { return undefined; }
  return undefined;
}

export async function exchangeCodeForTokens(config: OAuthProviderConfig, fetch: OAuthFetch, code: string, codeVerifier: string, redirectUri: string): Promise<Result<OAuthCredential>> {
  if (config.clientId.length === 0) return fail("AUTH_CLIENT_ID_REQUIRED", "OpenAI OAuth CLIENT_ID is blank; replace OPENAI_OAUTH_CLIENT_ID before logging in");
  const body = new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirectUri, client_id: config.clientId, code_verifier: codeVerifier });
  let response: OAuthFetchResponse;
  try { response = await fetch(`${config.issuer}/oauth/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" }, body: body.toString() }); } catch { return fail("AUTH_TOKEN_REQUEST_FAILED", "OAuth token exchange failed"); }
  if (!response.ok) return fail("AUTH_TOKEN_REQUEST_FAILED", `OAuth token exchange failed with HTTP ${response.status}`);
  try { return parseOAuthTokenResponse(await response.json(), "openai"); } catch { return fail("AUTH_TOKEN_RESPONSE_INVALID", "OAuth token response is invalid"); }
}

export async function refreshAccessToken(config: OAuthProviderConfig, fetch: OAuthFetch, credential: OAuthCredential): Promise<Result<OAuthCredential>> {
  if (config.clientId.length === 0) return fail("AUTH_CLIENT_ID_REQUIRED", "OpenAI OAuth CLIENT_ID is blank; replace OPENAI_OAUTH_CLIENT_ID before refreshing");
  const body = new URLSearchParams({ client_id: config.clientId, grant_type: "refresh_token", refresh_token: credential.refresh, scope: "openid profile email" });
  let response: OAuthFetchResponse;
  try { response = await fetch(`${config.issuer}/oauth/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" }, body: body.toString() }); } catch { return fail("AUTH_TOKEN_REQUEST_FAILED", "OAuth token refresh failed"); }
  if (!response.ok) return fail("AUTH_TOKEN_REQUEST_FAILED", `OAuth token refresh failed with HTTP ${response.status}`);
  let parsed: Result<OAuthCredential>;
  try { parsed = parseOAuthTokenResponse(await response.json(), "openai", false); } catch { return fail("AUTH_TOKEN_RESPONSE_INVALID", "OAuth token response is invalid"); }
  if (!parsed.ok) return parsed;
  return { ok: true, value: { ...parsed.value, refresh: parsed.value.refresh || credential.refresh, ...(parsed.value.accountId === undefined && credential.accountId === undefined ? {} : { accountId: parsed.value.accountId ?? credential.accountId }) } };
}

export interface ResolvedOAuthCredential { credential: OAuthCredential; source: AuthSource; }

export async function resolveOAuthCredential(environment: Environment, fetch: OAuthFetch, authFile?: string): Promise<Result<ResolvedOAuthCredential>> {
  const store = new OAuthCredentialStore(environment);
  const loaded = store.load(authFile);
  if (!loaded.ok) return loaded;
  const credential = loaded.value.credentials.openai;
  if (credential === undefined) return fail("OPENAI_OAUTH_REQUIRED", "OpenAI OAuth credentials are required; run auth login first");
  if (credential.expires > Date.now() + 300_000) return { ok: true, value: { credential, source: loaded.value.source } };
  const refreshed = await refreshAccessToken(openAIOAuthConfig(environment), fetch, credential);
  if (!refreshed.ok) return refreshed;
  const credentials = { ...loaded.value.credentials, openai: refreshed.value };
  if (loaded.value.source === "file") {
    const saved = store.save(credentials, authFile);
    if (!saved.ok) return saved;
  }
  return { ok: true, value: { credential: refreshed.value, source: loaded.value.source } };
}

function parseOAuthTokenResponse(value: unknown, provider: string, refreshOptional = true): Result<OAuthCredential> {
  if (!jsonObject(value)) return fail("AUTH_TOKEN_RESPONSE_INVALID", "OAuth token response is invalid");
  const access = tokenString(value.access_token); const refresh = tokenString(value.refresh_token); const idToken = tokenString(value.id_token);
  if (access === undefined || (refreshOptional && refresh === undefined)) return fail("AUTH_TOKEN_RESPONSE_INVALID", "OAuth token response must include access_token and refresh_token");
  if (typeof value.expires_in !== "number" || !Number.isSafeInteger(value.expires_in) || value.expires_in <= 0) return fail("AUTH_TOKEN_RESPONSE_INVALID", "OAuth token response must include a positive expires_in");
  const expiresIn = value.expires_in;
  const accountId = jwtAccountId(idToken ?? "") ?? jwtAccountId(access);
  return { ok: true, value: { type: "oauth", access, refresh: refresh ?? "", expires: Date.now() + expiresIn * 1000, ...(accountId === undefined ? {} : { accountId }) } };
}

const requestPath = (request: IncomingMessage): string => request.url === undefined ? "" : request.url;

interface PendingInput { promise: Promise<string>; cancel(): void; }

function firstInput(input: AsyncIterable<string | Buffer>): PendingInput {
  const iterator = input[Symbol.asyncIterator]();
  const promise = iterator.next().then((result) => result.done || result.value === undefined ? "" : (typeof result.value === "string" ? result.value : result.value.toString("utf8")).trim());
  return { promise, cancel: () => { const close = iterator.return?.(); if (close !== undefined) void Promise.resolve(close).catch(() => undefined); } };
}

export async function loginBrowser(config: OAuthProviderConfig, options: OAuthLoginOptions): Promise<Result<OAuthCredential>> {
  if (config.clientId.length === 0) return fail("AUTH_CLIENT_ID_REQUIRED", "OpenAI OAuth CLIENT_ID is blank; replace OPENAI_OAUTH_CLIENT_ID before logging in");
  const pkce = generatePKCE(); const state = generateOAuthState(); const redirectUri = `http://localhost:${config.port}/auth/callback`;
  const authorizationUrl = buildAuthorizeURL(config, pkce, state, redirectUri);
  let resolveCode: (result: Result<string>) => void = () => undefined;
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  let manualInput: PendingInput | undefined;
  const code = new Promise<Result<string>>((resolve) => { resolveCode = resolve; });
  const server = createServer((request, response) => handleCallback(request, response, state, resolveCode));
  try {
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(config.port, "127.0.0.1", () => resolve()); });
    if (options.openBrowser !== undefined) await options.openBrowser(authorizationUrl);
    manualInput = options.stdin === undefined ? undefined : firstInput(options.stdin);
    const input = manualInput === undefined ? undefined : manualInput.promise.then((value) => {
      if (value.length === 0) return fail("AUTH_INPUT_INVALID", "No authorization code was supplied");
      if (!value.includes("?")) return { ok: true as const, value };
      try {
        const callback = new URL(value);
        if (callback.searchParams.get("state") !== state) return fail("AUTH_STATE_MISMATCH", "OAuth state mismatch");
        return { ok: true as const, value: callback.searchParams.get("code") ?? "" };
      } catch { return fail("AUTH_INPUT_INVALID", "Authorization input was not a valid callback URL"); }
    });
    const timeout = new Promise<Result<string>>((resolve) => { timeoutHandle = setTimeout(() => resolve(fail("AUTH_TIMEOUT", "OAuth authentication timed out")), options.timeoutMs ?? 300_000); });
    const received = await Promise.race([code, ...(input === undefined ? [] : [input]), timeout]);
    if (!received.ok) return received;
    return exchangeCodeForTokens(config, options.fetch, received.value, pkce.codeVerifier, redirectUri);
  } catch { return fail("AUTH_CALLBACK_FAILED", "OAuth callback server failed"); }
  finally { if (timeoutHandle !== undefined) clearTimeout(timeoutHandle); manualInput?.cancel(); await new Promise<void>((resolve) => server.close(() => resolve())); }
}

function handleCallback(request: IncomingMessage, response: ServerResponse, state: string, resolveCode: (result: Result<string>) => void): void {
  if (requestPath(request).split("?")[0] !== "/auth/callback") { response.statusCode = 404; response.end("Not found"); return; }
  try {
    const query = new URL(request.url ?? "", "http://localhost").searchParams;
    if (query.get("state") !== state) { response.statusCode = 400; response.end("State mismatch"); resolveCode(fail("AUTH_STATE_MISMATCH", "OAuth state mismatch")); return; }
    const error = query.get("error"); if (error !== null) { response.statusCode = 400; response.end("Authorization failed"); resolveCode(fail("AUTH_AUTHORIZATION_FAILED", `OAuth authorization failed: ${error}`)); return; }
    const authorizationCode = query.get("code"); if (authorizationCode === null || authorizationCode.length === 0) { response.statusCode = 400; response.end("Missing authorization code"); resolveCode(fail("AUTH_CODE_MISSING", "OAuth callback did not include an authorization code")); return; }
    response.setHeader("content-type", "text/html"); response.end("<html><body><h2>Authentication successful!</h2><p>You can close this window.</p></body></html>"); resolveCode({ ok: true, value: authorizationCode });
  } catch { response.statusCode = 400; response.end("Invalid callback"); resolveCode(fail("AUTH_CALLBACK_INVALID", "OAuth callback was invalid")); }
}

export interface OAuthCredential {
  type: "oauth";
  refresh: string;
  access: string;
  expires: number;
  accountId?: string;
  enterpriseUrl?: string;
}

export type OAuthCredentials = Readonly<Record<string, OAuthCredential>>;
export type AuthSource = "environment" | "file";
export interface LoadedOAuthCredentials { source: AuthSource; credentials: OAuthCredentials; }
export interface OAuthCredentialStatus { provider: string; type: "oauth"; expires: number; accountId?: string; enterpriseUrl?: string; source: AuthSource; }

const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const nonEmpty = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const providerId = (value: string): boolean => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value);
const optionalString = (value: unknown): value is string | undefined => value === undefined || nonEmpty(value);
const exactKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean => Object.keys(value).every((key) => keys.includes(key));

function credentialFrom(value: unknown): OAuthCredential | undefined {
  if (!record(value) || !exactKeys(value, ["type", "refresh", "access", "expires", "accountId", "enterpriseUrl"])) return undefined;
  if (value.type !== "oauth" || !nonEmpty(value.refresh) || !nonEmpty(value.access) || typeof value.expires !== "number" || !Number.isSafeInteger(value.expires) || value.expires < 0 || !optionalString(value.accountId) || !optionalString(value.enterpriseUrl)) return undefined;
  const optional = value.accountId === undefined ? {} : { accountId: value.accountId };
  const enterprise = value.enterpriseUrl === undefined ? {} : { enterpriseUrl: value.enterpriseUrl };
  return { type: "oauth", refresh: value.refresh, access: value.access, expires: value.expires, ...optional, ...enterprise };
}

export function parseOAuthCredentials(value: unknown, code = "AUTH_CONTENT_INVALID"): Result<OAuthCredentials> {
  if (!record(value)) return fail(code, "OAuth credential content must be a provider-ID-keyed object");
  const credentials: Record<string, OAuthCredential> = {};
  for (const [provider, rawCredential] of Object.entries(value)) {
    const credential = credentialFrom(rawCredential);
    if (!providerId(provider) || credential === undefined) return fail(code, "OAuth credential content has an invalid provider record");
    credentials[provider] = credential;
  }
  return { ok: true, value: credentials };
}

export function defaultAuthFile(environment: Environment, platform = process.platform): Result<string> {
  const home = environment.get(platform === "win32" ? "USERPROFILE" : "HOME");
  if (!nonEmpty(home)) return fail("AUTH_PATH_UNAVAILABLE", "The home directory environment variable is required for the default auth file");
  return { ok: true, value: platform === "win32" ? `${home}\\.local\\share\\finleet\\auth.json` : `${home}/.local/share/finleet/auth.json` };
}

export class OAuthCredentialStore {
  constructor(private readonly environment: Environment, private readonly platform = process.platform) {}

  load(authFile?: string): Result<LoadedOAuthCredentials> {
    const supplied = this.environment.get("FINLEET_AUTH_CONTENT");
    if (supplied !== undefined) {
      let content: unknown;
      try { content = JSON.parse(supplied) as unknown; } catch { return fail("AUTH_ENV_INVALID", "FINLEET_AUTH_CONTENT must contain valid OAuth credential JSON"); }
      const parsed = parseOAuthCredentials(content, "AUTH_ENV_INVALID");
      return parsed.ok ? { ok: true, value: { source: "environment", credentials: parsed.value } } : parsed;
    }
    const path = authFile === undefined ? defaultAuthFile(this.environment, this.platform) : { ok: true as const, value: authFile };
    if (!path.ok) return path;
    let content: unknown;
    try { content = JSON.parse(readFileSync(path.value, "utf8")) as unknown; } catch { return fail("AUTH_FILE_INVALID", "The OAuth auth file must contain valid credential JSON"); }
    const parsed = parseOAuthCredentials(content, "AUTH_FILE_INVALID");
    return parsed.ok ? { ok: true, value: { source: "file", credentials: parsed.value } } : parsed;
  }

  save(credentials: OAuthCredentials, authFile?: string): Result<void> {
    const parsed = parseOAuthCredentials(credentials);
    if (!parsed.ok) return parsed;
    const path = authFile === undefined ? defaultAuthFile(this.environment, this.platform) : { ok: true as const, value: authFile };
    if (!path.ok) return path;
    const directory = dirname(path.value);
    const temporary = `${path.value}.${randomUUID()}.tmp`;
    try {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      if (this.platform !== "win32") chmodSync(directory, 0o700);
      writeFileSync(temporary, JSON.stringify(parsed.value), { encoding: "utf8", mode: 0o600, flag: "wx" });
      const descriptor = openSync(temporary, "r");
      try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
      renameSync(temporary, path.value);
      if (this.platform !== "win32") chmodSync(path.value, 0o600);
      return { ok: true, value: undefined };
    } catch {
      try { if (existsSync(temporary)) unlinkSync(temporary); } catch { return fail("AUTH_WRITE_FAILED", "OAuth credential storage failed"); }
      return fail("AUTH_WRITE_FAILED", "OAuth credential storage failed");
    }
  }

  status(authFile?: string): Result<readonly OAuthCredentialStatus[]> {
    const loaded = this.load(authFile);
    if (!loaded.ok) return loaded;
    return { ok: true, value: Object.entries(loaded.value.credentials).sort(([left], [right]) => left.localeCompare(right)).map(([provider, credential]) => ({ provider, type: credential.type, expires: credential.expires, ...(credential.accountId === undefined ? {} : { accountId: credential.accountId }), ...(credential.enterpriseUrl === undefined ? {} : { enterpriseUrl: credential.enterpriseUrl }), source: loaded.value.source })) };
  }
}

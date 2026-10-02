import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { defaultAuthFile, OAuthCredentialStore, type OAuthCredentials } from "./auth.js";
import { execute } from "./cli.js";
import type { Environment } from "./integrations.js";

const credentials: OAuthCredentials = { github: { type: "oauth", refresh: "refresh-sentinel", access: "access-sentinel", expires: 1780000000000, accountId: "account-1", enterpriseUrl: "https://github.example" } };
const directory = (): string => mkdtempSync(join(tmpdir(), "finleet-auth-"));
const environment = (values: Readonly<Record<string, string | undefined>>): Environment => ({ get: (name) => values[name] });

test("default auth paths use the Finleet application directory", () => {
  const unix = defaultAuthFile(environment({ HOME: "/home/test" }), "darwin");
  const windows = defaultAuthFile(environment({ USERPROFILE: "C:\\Users\\test" }), "win32");
  assert.deepEqual(unix, { ok: true, value: "/home/test/.local/share/finleet/auth.json" });
  assert.deepEqual(windows, { ok: true, value: "C:\\Users\\test\\.local\\share\\finleet\\auth.json" });
});

test("valid environment credentials override disk without being written", () => {
  const path = join(directory(), "auth.json"); writeFileSync(path, JSON.stringify({ disk: credentials.github }));
  const store = new OAuthCredentialStore(environment({ FINLEET_AUTH_CONTENT: JSON.stringify({ environment: credentials.github }) }));
  const loaded = store.load(path);
  assert.equal(loaded.ok, true); if (loaded.ok) { assert.equal(loaded.value.source, "environment"); assert.deepEqual(Object.keys(loaded.value.credentials), ["environment"]); }
  assert.equal(readFileSync(path, "utf8").includes("access-sentinel"), true);
});

test("invalid environment credentials fail closed without reading disk", () => {
  const store = new OAuthCredentialStore(environment({ FINLEET_AUTH_CONTENT: "{invalid" }));
  const loaded = store.load(join(directory(), "missing.json"));
  assert.equal(loaded.ok, false); if (!loaded.ok) assert.equal(loaded.error.code, "AUTH_ENV_INVALID");
});

test("malformed disk schemas are rejected", () => {
  const path = join(directory(), "auth.json"); writeFileSync(path, JSON.stringify({ github: { type: "oauth", refresh: "refresh", access: "access", expires: "not-an-epoch", token: "unexpected" } }));
  const loaded = new OAuthCredentialStore(environment({})).load(path);
  assert.equal(loaded.ok, false); if (!loaded.ok) assert.equal(loaded.error.code, "AUTH_FILE_INVALID");
});

test("save atomically replaces credentials and secures Unix files", () => {
  const root = directory(); const path = join(root, "nested", "auth.json"); const store = new OAuthCredentialStore(environment({}));
  const github = credentials.github; assert.notEqual(github, undefined); if (github === undefined) return;
  const replacement: OAuthCredentials = { github: { ...github, access: "replacement-access", refresh: "replacement-refresh" } };
  assert.equal(store.save(credentials, path).ok, true); assert.equal(store.save(replacement, path).ok, true); assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), replacement);
  const nested = join(root, "nested"); assert.equal(readdirSync(nested).some((name) => name.endsWith(".tmp")), false);
  if (process.platform !== "win32") { assert.equal(statSync(path).mode & 0o777, 0o600); assert.equal(statSync(nested).mode & 0o777, 0o700); }
});

test("auth status is metadata-only for environment and file sources", async () => {
  const path = join(directory(), "auth.json"); writeFileSync(path, JSON.stringify(credentials));
  const original = process.env.FINLEET_AUTH_CONTENT;
  try {
    delete process.env.FINLEET_AUTH_CONTENT;
    const fromFile = await execute(["auth", "status", "--format", "json", "--auth-file", path]);
    process.env.FINLEET_AUTH_CONTENT = JSON.stringify(credentials);
    const fromEnvironment = await execute(["auth", "status", "--format", "json", "--auth-file", path]);
    for (const response of [fromFile, fromEnvironment]) { const json = JSON.stringify(response.body); assert.equal(response.exitCode, 0); assert.equal(json.includes("access-sentinel") || json.includes("refresh-sentinel"), false); }
    assert.equal(JSON.stringify(fromFile.body).includes('"source":"file"'), true); assert.equal(JSON.stringify(fromEnvironment.body).includes('"source":"environment"'), true);
  } finally { if (original === undefined) delete process.env.FINLEET_AUTH_CONTENT; else process.env.FINLEET_AUTH_CONTENT = original; }
});

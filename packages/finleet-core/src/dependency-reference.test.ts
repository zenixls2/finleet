import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { DependencyReferenceResolver, type OfficialDocumentationRequest } from "./dependency-reference.js";

async function fixture(t: { after: (callback: () => Promise<void>) => void }) {
  const root = await mkdtemp(join(tmpdir(), "finleet-dependency-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return {
    root,
    async file(path: string, content: string | object) {
      const target = join(root, path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, typeof content === "string" ? content : JSON.stringify(content));
    },
  };
}

test("nearest installed package and local declarations/docs precede lockfile and retrieval", async t => {
  const { root, file } = await fixture(t);
  await file("package-lock.json", { packages: { "node_modules/@scope/pkg": { version: "1.0.0" } } });
  await file("node_modules/@scope/pkg/package.json", { version: "2.0.0" });
  await file("apps/client/node_modules/@scope/pkg/package.json", {
    version: "3.0.0",
    exports: { ".": { import: { types: "./dist/index.d.mts" } } },
  });
  await file("apps/client/node_modules/@scope/pkg/dist/index.d.mts", "export declare function example(): string;");
  await file("apps/client/node_modules/@scope/pkg/README.md", "Usage: example()");
  const resolver = new DependencyReferenceResolver(root, {
    retrieveOfficialDocumentation: async () => assert.fail("Local matches should suppress retrieval"),
  });
  const result = await resolver.resolve({ packageName: "@scope/pkg", fromDirectory: "apps/client", query: "example" });
  assert.equal(result.version, "3.0.0");
  assert.deepEqual(result.versionSource, { kind: "installed", source: "apps/client/node_modules/@scope/pkg/package.json" });
  assert.deepEqual(result.references.map(ref => ref.kind), ["declaration", "local-documentation"]);
  assert.match(result.references[0]!.excerpt, /function example/);
});

test("lockfile workspace and legacy versions are exact and unresolved dependencies never request latest", async t => {
  const { root, file } = await fixture(t);
  await file("apps/client/package.json", { dependencies: { pkg: "^3.0.0" } });
  await file("package-lock.json", { packages: {
    "node_modules/pkg": { version: "2.0.0" },
    "apps/client/node_modules/pkg": { version: "3.1.0" },
  } });
  const requests: OfficialDocumentationRequest[] = [];
  const resolver = new DependencyReferenceResolver(root, {
    retrieveOfficialDocumentation: async request => {
      requests.push(request);
      return { version: request.version, source: "https://example.com/docs", excerpt: "Official docs" };
    },
  });
  const result = await resolver.resolve({ packageName: "pkg", fromDirectory: "apps/client" });
  assert.equal(result.version, "3.1.0");
  assert.equal(result.versionSource?.source, "package-lock.json#apps/client/node_modules/pkg");
  assert.equal(result.references[0]?.kind, "official-documentation");
  await file("package-lock.json", { dependencies: { legacy: { version: "1.2.3" } } });
  assert.equal((await resolver.resolve({ packageName: "legacy", fromDirectory: "apps/client" })).version, "1.2.3");
  assert.deepEqual(await resolver.resolve({ packageName: "missing" }), { packageName: "missing", references: [] });
  assert.deepEqual(requests.map(request => request.version), ["3.1.0", "1.2.3"]);
});

test("official retrieval coalesces, caches by version and query, bounds cache, and explicitly supports latest", async t => {
  const { root, file } = await fixture(t);
  await file("node_modules/pkg/package.json", { version: "1.0.0" });
  const requests: OfficialDocumentationRequest[] = [];
  const resolver = new DependencyReferenceResolver(root, {
    cacheEntries: 2,
    retrieveOfficialDocumentation: async request => {
      requests.push(request);
      return { version: request.version === "latest" ? "9.0.0" : request.version, source: "https://example.com/docs", excerpt: request.query ?? "docs" };
    },
  });
  const lookup = (query: string) => resolver.resolve({ packageName: "pkg", query });
  await Promise.all([lookup("foo"), lookup("foo"), lookup("foo")]);
  await lookup("foo");
  assert.equal(requests.length, 1);
  await lookup("bar");
  await file("node_modules/pkg/package.json", { version: "2.0.0" });
  await lookup("foo");
  await file("node_modules/pkg/package.json", { version: "1.0.0" });
  await lookup("foo"); // Evicted by the two intervening keys.
  const latest = await resolver.resolve({ packageName: "pkg", latest: true, query: "foo" });
  assert.equal(latest.version, "9.0.0");
  assert.equal(latest.versionSource?.kind, "official");
  await file("node_modules/pkg/package.json", { version: "9.0.0" });
  await lookup("foo"); // Explicit latest populated the exact-version cache.
  await resolver.resolve({ packageName: "pkg", latest: true, query: "foo" });
  assert.deepEqual(requests.map(request => [request.version, request.query]), [
    ["1.0.0", "foo"], ["1.0.0", "bar"], ["2.0.0", "foo"], ["1.0.0", "foo"], ["latest", "foo"], ["latest", "foo"],
  ]);
});

test("mismatched versions are not cached and failed requests can be retried", async t => {
  const { root, file } = await fixture(t);
  await file("node_modules/pkg/package.json", { version: "1.0.0" });
  let attempts = 0;
  const resolver = new DependencyReferenceResolver(root, {
    retrieveOfficialDocumentation: async () => {
      attempts++;
      if (attempts === 1) throw new Error("offline");
      return { version: attempts === 2 ? "2.0.0" : "1.0.0", source: "https://example.com/docs", excerpt: "docs" };
    },
  });
  await assert.rejects(resolver.resolve({ packageName: "pkg" }), /offline/);
  assert.equal((await resolver.resolve({ packageName: "pkg" })).references.length, 0);
  assert.equal((await resolver.resolve({ packageName: "pkg" })).references.length, 1);
  assert.equal(attempts, 3);
  await assert.rejects(resolver.resolve({ packageName: "../pkg" }), /package name/);
});

test("overlapping latest requests share one retrieval without persisting a latest alias", async t => {
  const { root } = await fixture(t);
  let attempts = 0;
  const resolver = new DependencyReferenceResolver(root, {
    retrieveOfficialDocumentation: async () => {
      attempts++;
      await new Promise(resolve => setTimeout(resolve, 30));
      return { version: "1.2.3", source: "https://example.com/docs", excerpt: "docs" };
    },
  });
  const lookup = () => resolver.resolve({ packageName: "pkg", latest: true });
  const results = await Promise.all([lookup(), lookup(), lookup()]);
  assert.equal(attempts, 1);
  assert.deepEqual(results[0], results[1]);
  assert.deepEqual(results[1], results[2]);
  await lookup();
  assert.equal(attempts, 2);
});

test("outside installations and invalid nearest versions do not silently fall back to stale lock metadata", async t => {
  const { root, file } = await fixture(t);
  const outside = await fixture(t);
  await outside.file("pkg/package.json", { version: "9.0.0" });
  await outside.file("pkg/README.md", "outside secret");
  await file("package-lock.json", { packages: { "node_modules/pkg": { version: "1.0.0" } } });
  await mkdir(join(root, "node_modules"));
  await symlink(join(outside.root, "pkg"), join(root, "node_modules/pkg"), "dir");
  const resolver = new DependencyReferenceResolver(root, {
    retrieveOfficialDocumentation: async () => assert.fail("An unsafe installation must not use stale lock metadata"),
  });
  assert.deepEqual(await resolver.resolve({ packageName: "pkg" }), { packageName: "pkg", references: [] });
  await rm(join(root, "node_modules/pkg"));
  await file("node_modules/pkg/package.json", { version: "not-a-version" });
  assert.deepEqual(await resolver.resolve({ packageName: "pkg" }), { packageName: "pkg", references: [] });
  await rm(join(root, "node_modules/pkg"), { recursive: true });
  await file("apps/client/package.json", {});
  await file("package-lock.json", { packages: {
    "node_modules/pkg": { version: "1.0.0" },
    "apps/client/node_modules/pkg": { link: true, resolved: "packages/pkg" },
  } });
  assert.deepEqual(await resolver.resolve({ packageName: "pkg", fromDirectory: "apps/client" }), { packageName: "pkg", references: [] });
});

test("manifest declarations cannot point at arbitrary files, and npm aliases retrieve the canonical package", async t => {
  const { root, file } = await fixture(t);
  await file("node_modules/alias/package.json", { version: "1.2.3", name: "canonical", types: "credentials.json" });
  await file("node_modules/alias/credentials.json", "private contents");
  await file("outside.d.ts", "outside package");
  await symlink(join(root, "outside.d.ts"), join(root, "node_modules/alias/index.d.ts"));
  const requests: OfficialDocumentationRequest[] = [];
  const resolver = new DependencyReferenceResolver(root, {
    retrieveOfficialDocumentation: async request => {
      requests.push(request);
      return { version: request.version, source: "https://example.org/docs", excerpt: "official" };
    },
  });
  const result = await resolver.resolve({ packageName: "alias" });
  assert.deepEqual(result.versionSource, { kind: "installed", source: "node_modules/alias/package.json" });
  assert.deepEqual(result.references.map(reference => reference.excerpt), ["official"]);
  assert.deepEqual(requests, [{ packageName: "canonical", version: "1.2.3" }]);
  await assert.rejects(resolver.resolve({ packageName: "alias\n" }), /package name/);
  await assert.rejects(resolver.resolve({ packageName: "alias", latest: "false" as unknown as boolean }), /boolean latest/);
});

test("official retrieval bounds distinct in-flight requests and permits retry when capacity frees", async t => {
  const { root } = await fixture(t);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  let calls = 0;
  const resolver = new DependencyReferenceResolver(root, {
    retrieveOfficialDocumentation: async () => {
      if (++calls === 8) started();
      await gate;
      return { version: "1.0.0", source: "https://example.org/docs", excerpt: "official" };
    },
  });
  const lookup = (query: string) => resolver.resolve({ packageName: "pkg", latest: true, query });
  const pending = Array.from({ length: 8 }, (_, i) => lookup(String(i)));
  await ready;
  try {
    assert.deepEqual(await lookup("overflow"), { packageName: "pkg", references: [] });
    assert.equal(calls, 8);
  } finally {
    release();
    await Promise.all(pending);
  }
  assert.equal((await lookup("overflow")).version, "1.0.0");
  assert.equal(calls, 9);
});

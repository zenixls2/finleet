import assert from "node:assert/strict";
import test from "node:test";
import { createNpmOfficialDocumentationRetriever, type OfficialDocumentationFetch } from "./official-documentation.js";

const registry = "https://registry.npmjs.org";
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { "content-type": "application/json" },
});

test("retrieves README only from the exact official registry version endpoint", async () => {
  const requests: string[] = [];
  const retrieve = createNpmOfficialDocumentationRetriever(async (url, init) => {
    requests.push(url);
    assert.equal(init.method, "GET");
    assert.equal(init.redirect, "error");
    assert.equal(init.credentials, "omit");
    assert.ok(init.signal);
    return json({ name: "@scope/pkg", version: "1.2.3", readme: "x".repeat(3000) + "example()" + "y".repeat(3000), homepage: "https://elsewhere.example" });
  });
  const result = await retrieve({ packageName: "@scope/pkg", version: "1.2.3", query: "example()" });
  const source = `${registry}/%40scope%2Fpkg/1.2.3`;
  assert.deepEqual(requests, [source]);
  assert.equal(result?.version, "1.2.3");
  assert.equal(result?.source, source);
  assert.equal(result?.excerpt.length, 2000);
  assert.match(result!.excerpt, /example\(\)/);
});

test("explicit latest resolves a concrete version then retrieves its own README", async () => {
  const requests: string[] = [];
  const retrieve = createNpmOfficialDocumentationRetriever(async url => {
    requests.push(url);
    if (url.endsWith("/latest")) return json({ name: "pkg", version: "2.3.4", readme: "floating README" });
    return json({ name: "pkg", version: "2.3.4", readme: "exact README" });
  });
  assert.deepEqual(await retrieve({ packageName: "pkg", version: "latest" }), {
    version: "2.3.4", source: `${registry}/pkg/2.3.4`, excerpt: "exact README",
  });
  assert.deepEqual(requests, [`${registry}/pkg/latest`, `${registry}/pkg/2.3.4`]);
});

test("fails closed for missing version-specific README, mismatch, packument, or query miss", async () => {
  const manifests = [
    { name: "pkg", version: "1.0.0" },
    { name: "pkg", version: "1.0.0", readme: "ERROR: No README data found!" },
    { name: "pkg", version: "2.0.0", readme: "match" },
    { name: "other", version: "1.0.0", readme: "match" },
    { name: "pkg", version: "1.0.0", readme: "match", versions: {} },
    { name: "pkg", version: "1.0.0", readme: "match", "dist-tags": { latest: "1.0.0" } },
    { name: "pkg", version: "1.0.0", readme: "unrelated" },
  ];
  for (const manifest of manifests) {
    const retrieve = createNpmOfficialDocumentationRetriever(async () => json(manifest));
    assert.equal(await retrieve({ packageName: "pkg", version: "1.0.0", query: "match" }), undefined);
  }
  const latest = createNpmOfficialDocumentationRetriever(async url => url.endsWith("/latest")
    ? json({ name: "pkg", version: "1.0.0", readme: "match" })
    : json({ name: "pkg", version: "1.0.0" }));
  assert.equal(await latest({ packageName: "pkg", version: "latest" }), undefined);
});

test("rejects arbitrary URLs, version ranges, tags, and malformed input without fetch", async () => {
  const retrieve = createNpmOfficialDocumentationRetriever(async () => assert.fail("Must not fetch"));
  for (const [packageName, version] of [
    ["https://example.com/pkg", "1.0.0"], ["../pkg", "1.0.0"], ["pkg\n", "1.0.0"],
    ["pkg", "^1.0.0"], ["pkg", "next"], ["pkg", "1.0.0/../../other"], ["pkg", "1.0.0\n"],
  ]) {
    assert.equal(await retrieve({ packageName: packageName!, version: version! }), undefined);
  }
});

test("rejects redirects, HTTP errors, malformed responses and oversized streamed bodies", async () => {
  const oversized = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(700_000));
      controller.enqueue(new Uint8Array(700_000));
      controller.close();
    },
  });
  const responses: OfficialDocumentationFetch[] = [
    async () => json({}, 404),
    async () => new Response("bad", { headers: { "content-type": "application/json" } }),
    async () => new Response("{}", { headers: { "content-type": "application/json", "content-length": "2000000" } }),
    async () => new Response(oversized, { headers: { "content-type": "application/json" } }),
    async () => new Response("{}", { headers: { "content-type": "text/html" } }),
    async () => Response.redirect("https://example.com", 302),
    async () => { throw new Error("offline"); },
    async () => {
      const response = json({ name: "pkg", version: "1.0.0", readme: "README" });
      Object.defineProperty(response, "url", { value: "https://example.com/pkg/1.0.0" });
      return response;
    },
  ];
  for (const fetcher of responses) {
    const retrieve = createNpmOfficialDocumentationRetriever(fetcher);
    assert.equal(await retrieve({ packageName: "pkg", version: "1.0.0" }), undefined);
  }
});

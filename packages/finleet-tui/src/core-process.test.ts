import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseCoreEndpoint, parseCoreHandshake, startCoreProcess } from "./core-process.js";

test("core handshake parser accepts only bounded loopback endpoint credentials", () => {
  const token = "a".repeat(32);
  assert.deepEqual(parseCoreHandshake(`{"url":"ws://127.0.0.1:4321","token":"${token}"}`), { url: "ws://127.0.0.1:4321", token });
  assert.equal(parseCoreHandshake("not json"), undefined);
  assert.equal(parseCoreHandshake(`{"url":"ws://localhost:4321","token":"${token}"}`), undefined);
  assert.equal(parseCoreHandshake("x".repeat(1025)), undefined);
  assert.deepEqual(parseCoreEndpoint("ws://127.0.0.1:4321", token), { url: "ws://127.0.0.1:4321", token });
  assert.equal(parseCoreEndpoint("ws://127.0.0.1:4321", undefined), undefined);
  assert.equal(parseCoreEndpoint("ws://example.com:4321", token), undefined);
});

test("TUI-owned core child starts from its handshake and is reaped on close", async () => {
  const directory = await mkdtemp(join(tmpdir(), "finleet-tui-core-"));
  try {
    const core = await startCoreProcess(["--journal", join(directory, "journal.jsonl")]);
    assert.match(core.endpoint.url, /^ws:\/\/127\.0\.0\.1:\d+$/);
    await core.close();
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("aborting core startup rejects only after reaping the child", async () => {
  const controller = new AbortController();
  const starting = startCoreProcess([], { signal: controller.signal });
  controller.abort();
  await assert.rejects(starting, /startup was cancelled/);
});

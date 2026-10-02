import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

test("serve prints one bounded loopback handshake and exits on SIGTERM", async () => {
  const child = spawn(process.execPath, [fileURLToPath(new URL("./cli.js", import.meta.url)), "serve"], { stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("serve handshake timed out")), 5_000);
    child.stdout.setEncoding("utf8");
    child.stdout.once("data", (chunk: string) => { output = chunk; clearTimeout(timeout); resolve(); });
    child.once("error", reject);
  });
  assert.ok(Buffer.byteLength(output, "utf8") <= 1024);
  assert.match(output, /^\{"url":"ws:\/\/127\.0\.0\.1:\d+","token":"[A-Za-z0-9_-]+"\}\n$/);
  child.kill("SIGTERM");
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("serve did not terminate")), 5_000);
    child.once("exit", () => { clearTimeout(timeout); resolve(); });
  });
});

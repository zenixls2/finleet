import assert from "node:assert/strict";
import test from "node:test";
import { createTuiLifecycle, type SignalHost } from "./cli.js";

class FakeSignalHost implements SignalHost {
  public exitCode: string | number | null | undefined = undefined;
  private readonly listeners = new Map<NodeJS.Signals, Set<() => void>>();

  public on(signal: NodeJS.Signals, listener: () => void): void {
    const listeners = this.listeners.get(signal) ?? new Set<() => void>();
    listeners.add(listener);
    this.listeners.set(signal, listeners);
  }

  public off(signal: NodeJS.Signals, listener: () => void): void {
    this.listeners.get(signal)?.delete(listener);
  }

  public emit(signal: NodeJS.Signals): void {
    for (const listener of this.listeners.get(signal) ?? []) listener();
  }

  public count(signal: NodeJS.Signals): number { return this.listeners.get(signal)?.size ?? 0; }
}

test("TUI lifecycle handles SIGINT and SIGTERM once, then removes both listeners", async () => {
  const host = new FakeSignalHost();
  const controller = new AbortController();
  let closes = 0;
  const lifecycle = createTuiLifecycle(host, controller, async () => { closes += 1; });

  host.emit("SIGINT");
  host.emit("SIGTERM");
  assert.equal(host.exitCode, 143);
  await lifecycle.close();
  lifecycle.dispose();

  assert.equal(controller.signal.aborted, true);
  assert.equal(closes, 1);
  assert.equal(host.count("SIGINT"), 0);
  assert.equal(host.count("SIGTERM"), 0);
});

test("TUI lifecycle preserves a core-close failure and still removes listeners", async () => {
  const host = new FakeSignalHost();
  const lifecycle = createTuiLifecycle(host, new AbortController(), async () => { throw new Error("close failed"); });

  await assert.rejects(lifecycle.close(), /close failed/);
  lifecycle.dispose();

  assert.equal(host.count("SIGINT"), 0);
  assert.equal(host.count("SIGTERM"), 0);
});

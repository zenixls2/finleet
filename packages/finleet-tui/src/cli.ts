#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { startCoreProcess } from "./core-process.js";
import { WebSocketTuiClient } from "./tui-client.js";
import { startTui } from "./tui.js";

export interface SignalHost {
  exitCode: string | number | null | undefined;
  on(signal: NodeJS.Signals, listener: () => void): void;
  off(signal: NodeJS.Signals, listener: () => void): void;
}

export interface TuiLifecycle {
  close(): Promise<void>;
  dispose(): void;
}

/** Own process signals here so the terminal restores itself before the core child is reaped. */
export const createTuiLifecycle = (host: SignalHost, controller: AbortController, closeCore: () => Promise<void>): TuiLifecycle => {
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    if (closing === undefined) closing = closeCore();
    return closing;
  };
  const interrupt = (): void => {
    host.exitCode = 130;
    controller.abort();
  };
  const terminate = (): void => {
    host.exitCode = 143;
    controller.abort();
  };
  host.on("SIGINT", interrupt);
  host.on("SIGTERM", terminate);
  return {
    close,
    dispose: (): void => {
      host.off("SIGINT", interrupt);
      host.off("SIGTERM", terminate);
    },
  };
};

const run = async (args: readonly string[]): Promise<{ exitCode: 0 | 2; body: unknown }> => {
  const controller = new AbortController();
  let core: Awaited<ReturnType<typeof startCoreProcess>> | undefined;
  const lifecycle = createTuiLifecycle(process, controller, async () => { await core?.close(); });
  try {
    core = await startCoreProcess(args, { signal: controller.signal });
    const client = await WebSocketTuiClient.connect(core.endpoint.url, core.endpoint.token);
    try { return await startTui(args, client, { signal: controller.signal }); } finally { await client.close(); }
  } finally {
    lifecycle.dispose();
    await lifecycle.close();
  }
};

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) void run(process.argv.slice(2)).then((response) => {
  if (response.exitCode !== 0) process.stderr.write(`${typeof response.body === "string" ? response.body : JSON.stringify(response.body)}\n`);
  if (process.exitCode === undefined) process.exitCode = response.exitCode;
}).catch((error: unknown) => { process.stderr.write(`${error instanceof Error ? error.message : "Unable to start Finleet"}\n`); process.exitCode = 2; });

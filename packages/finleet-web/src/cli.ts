#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { parseWebOptions, startWebServer, WEB_USAGE } from "./server.js";

const run = async (args: readonly string[]): Promise<void> => {
  if (args.includes("--help")) {
    process.stdout.write(`${WEB_USAGE}\n`);
    return;
  }
  const options = parseWebOptions(args);
  const server = await startWebServer(options);
  process.stdout.write(`Finleet Web: ${server.url}\nSession: ${options.sessionId}\nPress Ctrl-C to stop.\n`);
  await new Promise<void>((resolve) => {
    const stop = (): void => { process.off("SIGINT", stop); process.off("SIGTERM", stop); resolve(); };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
  await server.close();
};

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void run(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : "Unable to start Finleet Web"}\n`);
    process.exitCode = 2;
  });
}

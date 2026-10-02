import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";

const supported = new Set(["darwin", "linux"]);
if (supported.has(process.platform)) {
  const compiler = process.env.CC ?? "cc";
  const result = spawnSync(compiler, ["-std=c11", "-Wall", "-Wextra", "-Werror", "-O2", "src/safe-mutate.c", "-o", `dist/safe-mutate-${process.platform}`], { stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
} else if (existsSync("dist/safe-mutate-darwin") || existsSync("dist/safe-mutate-linux")) {
  throw new Error("platform-specific safe mutation helpers must not be packaged for an unsupported platform");
}

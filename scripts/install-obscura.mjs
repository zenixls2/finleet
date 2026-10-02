#!/usr/bin/env node
import { createHash } from "node:crypto";
import { chmod, mkdtemp, mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

const version = "v0.2.1";
const repository = "h4ckf0r0day/obscura";
const releases = {
  "darwin-arm64": ["obscura-aarch64-macos.tar.gz", "5233da6426ec16667d7e4374b824189c6dfb3b325e5cf3fb5f04c7bc48b52a0f"],
  "darwin-x64": ["obscura-x86_64-macos.tar.gz", "e6d0f8719998fa4460bccc712b20a1e524717d5c54e943f345227bd893ec9620"],
  "linux-arm64": ["obscura-aarch64-linux.tar.gz", "0297c26d583f598f0126a7271cc40750598a9a9cbd86d1d6f79b2b99097d5244"],
  "linux-x64": ["obscura-x86_64-linux.tar.gz", "6a1a66b3f1ab118fa7d31330894a868617aea68c06d75436d851356c39df1ed3"],
};

const key = `${process.platform}-${process.arch}`;
const release = releases[key];
if (release === undefined) throw new Error(`Obscura installation is unsupported on ${key}; install it separately and set FINLEET_OBSCURA_BIN`);

const [archiveName, expectedSha256] = release;
const installRoot = join(process.cwd(), ".tools", "obscura", version, `${process.arch === "arm64" ? "aarch64" : "x86_64"}-${process.platform === "darwin" ? "macos" : "linux"}`);
const url = `https://github.com/${repository}/releases/download/${version}/${archiveName}`;

const response = await fetch(url);
if (!response.ok) throw new Error(`Obscura download failed with HTTP ${response.status}`);
const archive = Buffer.from(await response.arrayBuffer());
const actualSha256 = createHash("sha256").update(archive).digest("hex");
if (actualSha256 !== expectedSha256) throw new Error(`Obscura checksum mismatch: expected ${expectedSha256}, received ${actualSha256}`);

const tar = "/usr/bin/tar";
const stagingParent = await mkdtemp(join(tmpdir(), "finleet-obscura-"));
const archivePath = join(stagingParent, archiveName);
const stagingRoot = join(stagingParent, "install");
try {
  await mkdir(stagingRoot, { recursive: true });
  await writeFile(archivePath, archive, { mode: 0o600 });
  const listing = spawnSync(tar, ["-tzf", archivePath], { encoding: "utf8", timeout: 120_000 });
  if (listing.error !== undefined || listing.status !== 0 || typeof listing.stdout !== "string") throw new Error("Obscura archive could not be inspected");
  const members = listing.stdout.split("\n").filter((member) => member.length > 0);
  if (members.length === 0 || members.some((member) => member.startsWith("/") || member.split("/").includes("..") || member.includes("\\") || member.endsWith("/"))) throw new Error("Obscura archive contains unsafe paths");
  if (new Set(members).size !== members.length) throw new Error("Obscura archive contains duplicate paths");
  const verboseListing = spawnSync(tar, ["-tvzf", archivePath], { encoding: "utf8", timeout: 120_000 });
  if (verboseListing.error !== undefined || verboseListing.status !== 0 || typeof verboseListing.stdout !== "string" || verboseListing.stdout.split("\n").some((line) => line.length > 0 && line[0] !== "-")) throw new Error("Obscura archive contains non-regular files");
  const extraction = spawnSync(tar, ["-xzf", archivePath, "-C", stagingRoot], { encoding: "utf8", timeout: 120_000 });
  if (extraction.error !== undefined || extraction.status !== 0) throw new Error("Obscura archive extraction failed");
  const binary = join(stagingRoot, process.platform === "win32" ? "obscura.exe" : "obscura");
  const worker = join(stagingRoot, process.platform === "win32" ? "obscura-worker.exe" : "obscura-worker");
  if (!(await stat(binary)).isFile() || !(await stat(worker)).isFile()) throw new Error("Obscura archive is missing the CLI or worker");
  await chmod(binary, 0o755);
  await chmod(worker, 0o755);
  const versionCheck = spawnSync(binary, ["--version"], { encoding: "utf8", timeout: 30_000, env: { PATH: process.env.PATH, HOME: process.env.HOME, LANG: process.env.LANG } });
  if (versionCheck.error !== undefined || versionCheck.status !== 0) throw new Error("Obscura was extracted but could not be executed");
  await mkdir(join(process.cwd(), ".tools", "obscura", version), { recursive: true });
  const backup = `${installRoot}.previous`;
  await rm(backup, { recursive: true, force: true });
  let movedPrevious = false;
  try {
    await rename(installRoot, backup);
    movedPrevious = true;
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  await rename(stagingRoot, installRoot);
  if (movedPrevious) await rm(backup, { recursive: true, force: true });
  console.log(`Installed Obscura ${version} at ${join(installRoot, process.platform === "win32" ? "obscura.exe" : "obscura")}`);
} finally {
  await rm(stagingParent, { recursive: true, force: true });
}

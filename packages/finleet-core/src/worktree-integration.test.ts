import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { execute } from "./cli.js";
import { validateExistingWorkspace } from "./workspace.js";
import type { OpenAiFetch } from "./integrations.js";

test("native references use an explicitly selected linked worktree for both reference tools", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "finleet-worktree-integration-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const main = join(root, "main");
  const selected = join(root, "selected");
  mkdirSync(main);
  const git = (...args: string[]) => execFileSync("git", ["-C", main, ...args], { encoding: "utf8" });
  git("init", "-q");
  writeFileSync(join(main, ".gitignore"), "node_modules/\n");
  writeFileSync(join(main, "source.ts"), "export const greeting = 'main';\n");
  git("add", ".");
  git("-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "-qm", "initial");
  git("worktree", "add", "--detach", "--", selected, "HEAD");
  writeFileSync(join(selected, "source.ts"), "export const greeting = 'selected';\n");
  function installFixture(directory: string, version: string, label: string): void {
    const dependency = join(directory, "node_modules", "greeting-lib");
    mkdirSync(dependency, { recursive: true });
    writeFileSync(join(dependency, "package.json"), JSON.stringify({ version, types: "index.d.ts" }));
    writeFileSync(join(dependency, "index.d.ts"), `export declare function greet(): '${label}';\n`);
  }
  installFixture(main, "1.0.0", "main");
  installFixture(selected, "2.0.0", "selected");
  const validated = validateExistingWorkspace(main, selected);
  assert.ok(validated.ok);
  const statusBefore = git("status", "--porcelain=v1", "--ignored", "--untracked-files=all");
  const headBefore = git("rev-parse", "HEAD");
  const worktreesBefore = git("worktree", "list", "--porcelain");

  let calls = 0;
  const approvals: string[] = [];
  const openAiFetch: OpenAiFetch = async (_url, init) => {
    calls++;
    const payload = JSON.parse(init.body);
    assert.ok(payload.tools.some((tool: { name: string }) => tool.name === "find_references"));
    assert.ok(payload.tools.some((tool: { name: string }) => tool.name === "dependency_reference"));
    if (calls === 1) {
      return { ok: true, status: 200, json: async () => ({ output: [
        { type: "function_call", call_id: "reference", name: "find_references", arguments: '{"identifier":"greeting"}' },
        { type: "function_call", call_id: "dependency", name: "dependency_reference", arguments: '{"packageName":"greeting-lib","query":"greet"}' },
      ] }) };
    }
    const outputs = new Map((payload.input as { type?: string; call_id: string; output: string }[])
      .filter((item) => item.type === "function_call_output").map((item) => [item.call_id, JSON.parse(item.output)]));
    assert.deepEqual(outputs.get("reference"), {
      references: [{ path: "source.ts", line: 1, column: 14, excerpt: "export const greeting = 'selected';" }],
      truncated: false,
    });
    const dependency = outputs.get("dependency");
    assert.equal(dependency.version, "2.0.0");
    assert.deepEqual(dependency.versionSource, { kind: "installed", source: "node_modules/greeting-lib/package.json" });
    assert.deepEqual(dependency.references.map((reference: { source: string; excerpt: string }) => [reference.source, reference.excerpt]), [
      ["node_modules/greeting-lib/index.d.ts", "export declare function greet(): 'selected';\n"],
    ]);
    return { ok: true, status: 200, json: async () => ({ output: [{ type: "message", content: [{ type: "output_text", text: "Found selected workspace references." }] }] }) };
  };
  const result = await execute([
    "exec", "Find greeting and its dependency", "--provider", "openai-responses",
    "--model", "gpt-5.6-luna", "--reasoning-effort", "high", "--exchange", "paper",
    "--journal", join(root, "journal.jsonl"), "--format", "json",
  ], {
    environment: { get: (name) => name === "OPENAI_API_KEY" ? "sk-test" : undefined },
    workingDirectory: validated.value,
    openAiFetch,
    approver: async (request) => {
      assert.equal(request.requiredPermission, "shell:read");
      approvals.push(request.toolName);
      return { decision: "allow-once" };
    },
  });
  assert.equal(result.exitCode, 0, JSON.stringify(result.body));
  assert.equal(calls, 2);
  assert.deepEqual(approvals.sort(), ["dependency_reference", "find_references"]);
  assert.equal(git("status", "--porcelain=v1", "--ignored", "--untracked-files=all"), statusBefore);
  assert.equal(git("rev-parse", "HEAD"), headBefore);
  assert.equal(git("worktree", "list", "--porcelain"), worktreesBefore);
  assert.equal(readFileSync(join(main, "source.ts"), "utf8"), "export const greeting = 'main';\n");
  assert.equal(readFileSync(join(main, "node_modules/greeting-lib/package.json"), "utf8"), '{"version":"1.0.0","types":"index.d.ts"}');
  assert.equal(readFileSync(join(main, "node_modules/greeting-lib/index.d.ts"), "utf8"), "export declare function greet(): 'main';\n");
});

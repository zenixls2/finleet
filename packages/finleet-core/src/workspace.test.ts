import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { validateExistingWorkspace, WorkspaceManager } from "./workspace.js";
import type { Result } from "./domain.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function value<T>(result: Result<T>): T {
  assert.ok(result.ok, JSON.stringify(result));
  return result.value;
}

function fixture(t: TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "finleet-workspace-test-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = join(root, "repo");
  mkdirSync(repo);
  git(repo, "init");
  git(repo, "config", "user.name", "Workspace Test");
  git(repo, "config", "user.email", "workspace@example.test");
  git(repo, "config", "commit.gpgsign", "false");
  mkdirSync(join(repo, "nested"));
  writeFileSync(join(repo, "nested", "file.txt"), "base\n");
  writeFileSync(join(repo, ".gitignore"), "*.ignored\n");
  git(repo, "add", ".");
  git(repo, "commit", "-m", "base");
  return { repo, manager: new WorkspaceManager(root) };
}

test("shared workspaces preserve the selected cwd without creating a worktree", (t) => {
  const { repo, manager } = fixture(t);
  const before = git(repo, "worktree", "list");
  const workspace = value(manager.allocate({ workingDirectory: join(repo, "nested") }));
  assert.equal(workspace.mode, "shared");
  assert.equal(workspace.workingDirectory, join(repo, "nested"));
  assert.equal(git(repo, "worktree", "list"), before);
  assert.equal(value(manager.cleanup(workspace.id, false)).status, "released");
  assert.ok(existsSync(repo));
});

test("isolated allocation requires authorization and selects a clean worktree at HEAD", (t) => {
  const { repo, manager } = fixture(t);
  const cwd = join(repo, "nested");
  const before = git(repo, "worktree", "list");
  assert.equal(manager.allocate({ workingDirectory: cwd, mode: "isolated" }).ok, false);
  assert.equal(git(repo, "worktree", "list"), before);
  writeFileSync(join(cwd, "file.txt"), "parent edit\n");
  const first = value(manager.allocate({ workingDirectory: cwd, mode: "isolated", authorized: true }));
  const second = value(manager.allocate({ workingDirectory: cwd, mode: "isolated", authorized: true }));
  assert.notEqual(first.workingDirectory, second.workingDirectory);
  assert.equal(first.baseCommit, git(repo, "rev-parse", "HEAD"));
  assert.equal(readFileSync(join(first.workingDirectory, "file.txt"), "utf8"), "base\n");
  assert.equal(readFileSync(join(cwd, "file.txt"), "utf8"), "parent edit\n");
  assert.equal(manager.cleanup(first.id, false).ok, false);
  assert.equal(value(manager.cleanup(first.id, true)).status, "removed");
  assert.equal(value(manager.cleanup(second.id, true)).status, "removed");
  assert.equal(git(repo, "worktree", "list"), before);
});

test("cleanup retains tracked, untracked, ignored and unintegrated committed changes", (t) => {
  const { repo, manager } = fixture(t);
  const workspace = value(manager.allocate({ workingDirectory: repo, mode: "isolated", authorized: true }));
  const cwd = workspace.workingDirectory;
  const tracked = join(cwd, "nested", "file.txt");
  writeFileSync(tracked, "change\n");
  assert.equal(value(manager.cleanup(workspace.id, true)).status, "retained");
  git(cwd, "add", ".");
  git(cwd, "commit", "-m", "child change");
  assert.equal(value(manager.cleanup(workspace.id, true)).status, "retained");
  const childHead = git(cwd, "rev-parse", "HEAD");
  git(repo, "merge", "--ff-only", childHead);
  for (const name of ["output.txt", "output.ignored"]) {
    const file = join(cwd, name);
    writeFileSync(file, "important");
    assert.equal(value(manager.cleanup(workspace.id, true)).status, "retained");
    assert.equal(readFileSync(file, "utf8"), "important");
    rmSync(file);
  }
  assert.equal(value(manager.cleanup(workspace.id, true)).status, "removed");
  assert.equal(existsSync(cwd), false);
  assert.equal(readFileSync(join(repo, "nested", "file.txt"), "utf8"), "change\n");
});

test("unknown workspace and roots inside the source checkout cannot be removed or allocated", (t) => {
  const { repo, manager } = fixture(t);
  assert.equal(manager.cleanup("unknown", true).ok, false);
  const nestedManager = new WorkspaceManager(join(repo, "nested"));
  assert.equal(nestedManager.allocate({ workingDirectory: repo, mode: "isolated", authorized: true }).ok, false);
  assert.equal(git(repo, "status", "--porcelain"), "");
});

test("explicit existing-worktree selection validates across manager instances without adopting or mutating it", (t) => {
  const { repo, manager } = fixture(t);
  const workspace = value(manager.allocate({ workingDirectory: repo, mode: "isolated", authorized: true }));
  const nested = join(workspace.workingDirectory, "nested");
  writeFileSync(join(nested, "file.txt"), "user edit\n");
  const before = git(repo, "worktree", "list", "--porcelain");
  assert.equal(value(validateExistingWorkspace(repo, nested)), nested);
  assert.equal(value(validateExistingWorkspace(join(repo, "nested"), workspace.workingDirectory)), workspace.workingDirectory);
  assert.equal(new WorkspaceManager().cleanup(workspace.id, true).ok, false);
  assert.equal(git(repo, "worktree", "list", "--porcelain"), before);
  assert.equal(readFileSync(join(nested, "file.txt"), "utf8"), "user edit\n");
});

test("existing-worktree selection rejects the source checkout, an unrelated repository and missing paths", (t) => {
  const { repo, manager } = fixture(t);
  const unrelated = fixture(t);
  const workspace = value(manager.allocate({ workingDirectory: repo, mode: "isolated", authorized: true }));
  assert.equal(validateExistingWorkspace(repo, repo).ok, false);
  assert.equal(validateExistingWorkspace(repo, join(repo, "nested")).ok, false);
  assert.equal(validateExistingWorkspace(repo, unrelated.repo).ok, false);
  assert.equal(validateExistingWorkspace(unrelated.repo, workspace.workingDirectory).ok, false);
  assert.equal(validateExistingWorkspace(repo, join(repo, "missing")).ok, false);
  assert.equal(validateExistingWorkspace(repo, join(repo, "nested", "file.txt")).ok, false);
  assert.equal(value(manager.cleanup(workspace.id, true)).status, "removed");
});

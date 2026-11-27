import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { WorkspaceCodeIndex } from "./code-index.js";

function workspace(t: TestContext): string {
  const root = mkdtempSync(join(tmpdir(), "finleet-code-index-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test("refresh indexes changes, additions and removals without reindexing unchanged files", (t) => {
  const root = workspace(t);
  writeFileSync(join(root, "a.ts"), "const task = 1;\nuse(task, taskList);\n");
  writeFileSync(join(root, "b.ts"), "export const task = 2;\n");
  const index = new WorkspaceCodeIndex(root);
  assert.deepEqual(index.refresh(), { indexed: 2, unchanged: 0, removed: 0 });
  assert.deepEqual(index.findReferences("task"), {
    references: [
      { path: "a.ts", line: 1, column: 7, excerpt: "const task = 1;" },
      { path: "a.ts", line: 2, column: 5, excerpt: "use(task, taskList);" },
      { path: "b.ts", line: 1, column: 14, excerpt: "export const task = 2;" },
    ],
    truncated: false,
  });
  assert.deepEqual(index.refresh(), { indexed: 0, unchanged: 2, removed: 0 });
  writeFileSync(join(root, "a.ts"), "const nextTask = 1;\n");
  assert.deepEqual(index.refresh(), { indexed: 1, unchanged: 1, removed: 0 });
  assert.deepEqual(index.findReferences("task").references.map((ref) => ref.path), ["b.ts"]);
  renameSync(join(root, "b.ts"), join(root, "c.ts"));
  assert.deepEqual(index.refresh(), { indexed: 1, unchanged: 1, removed: 1 });
  assert.deepEqual(index.findReferences("task").references.map((ref) => ref.path), ["c.ts"]);
  rmSync(join(root, "c.ts"));
  assert.deepEqual(index.refresh(), { indexed: 0, unchanged: 1, removed: 1 });
  assert.deepEqual(index.findReferences("task"), { references: [], truncated: false });
});

test("Git discovery respects workspace boundaries, ignore rules and generated and vendor exclusions", (t) => {
  const repository = workspace(t);
  execFileSync("git", ["init", "-q", repository]);
  const root = join(repository, "app");
  mkdirSync(root);
  writeFileSync(join(repository, ".gitignore"), "app/ignored.ts\n");
  writeFileSync(join(repository, "sibling.ts"), "marker");
  writeFileSync(join(root, "source.ts"), "marker");
  writeFileSync(join(root, "ignored.ts"), "marker");
  writeFileSync(join(root, "file.generated.ts"), "marker");
  writeFileSync(join(root, "header.ts"), "// @generated\nmarker");
  writeFileSync(join(root, "large.ts"), "marker ".repeat(100_000));
  writeFileSync(join(root, "binary.ts"), "marker\0");
  mkdirSync(join(root, "vendor"));
  writeFileSync(join(root, "vendor", "dependency.ts"), "marker");
  execFileSync("git", ["-C", repository, "add", "app/vendor/dependency.ts", "app/source.ts"]);
  symlinkSync(join(repository, "sibling.ts"), join(root, "linked.ts"));
  symlinkSync(repository, join(root, "linked-directory"), "dir");
  const index = new WorkspaceCodeIndex(root);
  assert.deepEqual(index.refresh(), { indexed: 1, unchanged: 0, removed: 0 });
  assert.deepEqual(index.findReferences("marker").references.map((ref) => ref.path), ["source.ts"]);
  const other = new WorkspaceCodeIndex(repository);
  other.refresh();
  assert.deepEqual(other.findReferences("marker").references.map((ref) => ref.path), ["app/source.ts", "sibling.ts"]);
  assert.deepEqual(index.findReferences("marker").references.map((ref) => ref.path), ["source.ts"]);
});

test("lookup is exact, case-sensitive and bounded, including excerpts and repeated occurrences", (t) => {
  const root = workspace(t);
  writeFileSync(join(root, "source.ts"), `${"x".repeat(1000)} task task\nTask taskList $task\n${"task ".repeat(200)}`);
  const index = new WorkspaceCodeIndex(root);
  index.refresh();
  const limited = index.findReferences("task", 2);
  assert.equal(limited.truncated, true);
  assert.deepEqual(limited.references.map((ref) => [ref.line, ref.column]), [[1, 1002], [1, 1007]]);
  assert.ok(limited.references.every((ref) => ref.excerpt.length <= 240 && ref.excerpt.includes("task")));
  assert.equal(index.findReferences("task", 1_000).references.length, 100);
  assert.equal(index.findReferences("Task").references.length, 1);
  assert.equal(index.findReferences("$task").references.length, 1);
  assert.equal(index.findReferences("Task", 1).truncated, false);
  assert.throws(() => index.findReferences("task.*"));
  assert.throws(() => index.findReferences("task", 0));
});

test("workspace byte budget includes unchanged files and reports incomplete coverage", (t) => {
  const root = workspace(t);
  const content = "marker\n".padEnd(512 * 1024, " ");
  for (let i = 0; i < 17; i++) writeFileSync(join(root, `${String(i).padStart(2, "0")}.ts`), content);
  const index = new WorkspaceCodeIndex(root);
  assert.deepEqual(index.refresh(), { indexed: 16, unchanged: 0, removed: 0 });
  assert.deepEqual(index.refresh(), { indexed: 0, unchanged: 16, removed: 0 });
  assert.equal(index.findReferences("marker").references.length, 16);
  assert.equal(index.findReferences("absent").truncated, true);
  rmSync(join(root, "00.ts"));
  assert.deepEqual(index.refresh(), { indexed: 1, unchanged: 15, removed: 1 });
  assert.equal(index.findReferences("marker").truncated, false);
});

test("workspace file budget bounds even empty sources", (t) => {
  const root = workspace(t);
  for (let i = 0; i < 2001; i++) writeFileSync(join(root, `${String(i).padStart(4, "0")}.ts`), "");
  const index = new WorkspaceCodeIndex(root);
  assert.deepEqual(index.refresh(), { indexed: 2000, unchanged: 0, removed: 0 });
  assert.equal(index.findReferences("marker").truncated, true);
});

test("refresh removes stale entries after symlink replacement and workspace failure", (t) => {
  const root = workspace(t);
  const outside = workspace(t);
  mkdirSync(join(root, "nested"));
  writeFileSync(join(root, "nested", "source.ts"), "oldMarker");
  writeFileSync(join(outside, "source.ts"), "outsideMarker");
  const index = new WorkspaceCodeIndex(root);
  index.refresh();
  rmSync(join(root, "nested"), { recursive: true });
  symlinkSync(outside, join(root, "nested"), "dir");
  assert.deepEqual(index.refresh(), { indexed: 0, unchanged: 0, removed: 1 });
  assert.deepEqual(index.findReferences("outsideMarker").references, []);
  writeFileSync(join(root, "source.ts"), "oldMarker");
  index.refresh();
  rmSync(root, { recursive: true });
  symlinkSync(outside, root, "dir");
  assert.throws(() => index.refresh());
  assert.deepEqual(index.findReferences("oldMarker").references, []);
});

test("serialized lookup size is bounded even with escaped excerpts", (t) => {
  const root = workspace(t);
  writeFileSync(join(root, "source.ts"), `marker ${"\t".repeat(230)}\n`.repeat(100));
  const index = new WorkspaceCodeIndex(root);
  index.refresh();
  const result = index.findReferences("marker", 100);
  assert.equal(result.truncated, true);
  assert.ok(result.references.length < 100);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 32 * 1024);
});

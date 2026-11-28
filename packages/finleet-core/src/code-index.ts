import { spawnSync } from "node:child_process";
import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readSync, realpathSync, type Stats } from "node:fs";
import { extname, isAbsolute, join, relative, sep } from "node:path";

const MAX_FILE_BYTES = 512 * 1024;
const MAX_INDEX_BYTES = 8 * 1024 * 1024;
const MAX_INDEX_FILES = 2_000;
const MAX_RESULT_BYTES = 32 * 1024;
const MAX_RESULTS = 100;
const MAX_EXCERPT_LENGTH = 240;
const SOURCE_EXTENSIONS = new Set([
  ".c", ".cc", ".cpp", ".cs", ".css", ".cts", ".go", ".h", ".hpp", ".html",
  ".java", ".js", ".jsx", ".kt", ".kts", ".lua", ".mjs", ".mts", ".php",
  ".py", ".rb", ".rs", ".scala", ".sh", ".sql", ".svelte", ".swift", ".ts",
  ".tsx", ".vue", ".zig",
]);
const EXCLUDED_DIRECTORIES = new Set([
  "node_modules", "vendor", "vendors", "third_party", "third-party", "dist",
  "build", "out", "target", "coverage", "__pycache__", "generated",
]);
const IDENTIFIER = /[$_\p{ID_Start}][$\u200c\u200d\p{ID_Continue}]*/gu;
const VALID_IDENTIFIER = /^[$_\p{ID_Start}][$\u200c\u200d\p{ID_Continue}]*$/u;

export interface CodeReference {
  /** Workspace-relative path, with forward slashes. */
  path: string;
  /** One-based line and UTF-16 column. */
  line: number;
  column: number;
  excerpt: string;
}

export interface CodeIndexRefresh {
  indexed: number;
  unchanged: number;
  removed: number;
}

export interface CodeReferenceResult {
  references: CodeReference[];
  truncated: boolean;
}

interface IndexedFile {
  fingerprint: string;
  bytes: number;
  content: string;
}

function sourcePath(path: string): boolean {
  const parts = path.split("/");
  const name = parts.pop() ?? "";
  return !parts.some((part) => part.startsWith(".") || EXCLUDED_DIRECTORIES.has(part))
    && !name.startsWith(".")
    && SOURCE_EXTENSIONS.has(extname(name).toLowerCase())
    && !/\.(?:min|bundle|generated|gen)\.[^.]+$/i.test(name);
}

function inside(root: string, path: string): boolean {
  const local = relative(root, path);
  return local !== "" && local !== ".." && !local.startsWith(`..${sep}`) && !isAbsolute(local);
}

function* walk(root: string, prefix = ""): Iterable<string> {
  const directory = join(root, prefix);
  if (realpathSync(directory) !== directory) return;
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory() && !entry.name.startsWith(".") && !EXCLUDED_DIRECTORIES.has(entry.name)) {
      yield* walk(root, path);
    } else if (entry.isFile() && sourcePath(path)) {
      yield path;
    }
  }
}

function discover(root: string): Iterable<string> {
  // Git handles nested ignore rules, global excludes and untracked source files.
  const probe = spawnSync("git", ["-C", root, "rev-parse", "--is-inside-work-tree"], { encoding: "utf8" });
  if (probe.status !== 0 || probe.stdout.trim() !== "true") return walk(root);
  const result = spawnSync("git", [
    "-C", root, "ls-files", "--cached", "--others", "--exclude-standard", "-z", "--", ".",
  ], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
  if (result.status !== 0) throw new Error("Unable to list workspace source files", { cause: result.error });
  return [...new Set(result.stdout.split("\0").filter((path) => path && sourcePath(path)))].sort();
}

function fingerprint(stat: Stats): string {
  return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
}

function readSource(path: string, expected: Stats): string | undefined {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (fingerprint(fstatSync(fd)) !== fingerprint(expected) || realpathSync(path) !== path) return undefined;
    const buffer = Buffer.alloc(expected.size + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = readSync(fd, buffer, length, buffer.length - length, null);
      if (count === 0) break;
      length += count;
    }
    if (length !== expected.size || fingerprint(fstatSync(fd)) !== fingerprint(expected)
      || realpathSync(path) !== path || fingerprint(lstatSync(path)) !== fingerprint(expected)) return undefined;
    return buffer.toString("utf8", 0, length);
  } finally {
    closeSync(fd);
  }
}

/**
 * In-memory lexical index for a single workspace. Refresh discovers additions,
 * removals and edits, reading only files whose metadata changed.
 */
export class WorkspaceCodeIndex {
  readonly root: string;
  private files = new Map<string, IndexedFile>();
  private incomplete = false;

  constructor(root: string) {
    this.root = realpathSync(root);
    if (!lstatSync(this.root).isDirectory()) throw new Error("Workspace must be a directory");
  }

  refresh(): CodeIndexRefresh {
    const previousFiles = this.files;
    this.files = new Map();
    this.incomplete = true;
    if (realpathSync(this.root) !== this.root || !lstatSync(this.root).isDirectory()) throw new Error("Workspace is unavailable");
    const next = new Map<string, IndexedFile>();
    let indexed = 0;
    let unchanged = 0;
    let bytes = 0;
    let incomplete = false;
    for (const path of discover(this.root)) {
      const absolute = join(this.root, path);
      if (!inside(this.root, absolute)) continue;
      try {
        const stat = lstatSync(absolute);
        if (!stat.isFile() || stat.size > MAX_FILE_BYTES || realpathSync(absolute) !== absolute) continue;
        if (next.size >= MAX_INDEX_FILES || bytes + stat.size > MAX_INDEX_BYTES) {
          incomplete = true;
          break;
        }
        const version = fingerprint(stat);
        const previous = previousFiles.get(path);
        if (previous?.fingerprint === version) {
          next.set(path, previous);
          bytes += previous.bytes;
          unchanged++;
          continue;
        }
        const content = readSource(absolute, stat);
        if (content === undefined || content.includes("\0") || /@generated|automatically generated|do not edit.*generated/i.test(content.slice(0, 2048))) continue;
        next.set(path, { fingerprint: version, bytes: stat.size, content });
        bytes += stat.size;
        indexed++;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "ENOENT" && code !== "ENOTDIR" && code !== "EACCES" && code !== "ELOOP") throw error;
      }
    }
    let removed = 0;
    for (const path of previousFiles.keys()) {
      if (!next.has(path)) removed++;
    }
    this.files = next;
    this.incomplete = incomplete;
    return { indexed, unchanged, removed };
  }

  /** Case-sensitive identifier occurrences, including definitions and comments. */
  findReferences(identifier: string, limit = 30): CodeReferenceResult {
    if (!VALID_IDENTIFIER.test(identifier)) throw new Error("Expected a single identifier");
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("Expected a positive integer result limit");
    const boundedLimit = Math.min(limit, MAX_RESULTS);
    const references: CodeReference[] = [];
    let bytes = Buffer.byteLength('{"references":[],"truncated":false}');
    for (const [path, file] of this.files) {
      if (!file.content.includes(identifier)) continue;
      for (const [index, line] of file.content.split(/\r?\n/).entries()) {
        for (const match of line.matchAll(IDENTIFIER)) {
          if (match[0] !== identifier) continue;
          if (references.length === boundedLimit) return { references, truncated: true };
          const start = Math.max(0, match.index - 60);
          const reference = {
            path,
            line: index + 1,
            column: match.index + 1,
            excerpt: line.slice(start, start + MAX_EXCERPT_LENGTH),
          };
          bytes += Buffer.byteLength(JSON.stringify(reference)) + 1;
          if (bytes > MAX_RESULT_BYTES) return { references, truncated: true };
          references.push(reference);
        }
      }
    }
    return { references, truncated: this.incomplete };
  }
}

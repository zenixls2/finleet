import { constants } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const MAX_MANIFEST_BYTES = 8 * 1024 * 1024;
const MAX_REFERENCE_BYTES = 256 * 1024;
const MAX_EXCERPT_LENGTH = 8_000;
const MAX_REFERENCES = 8;
export const DEPENDENCY_PACKAGE_NAME_PATTERN = /^(?:@[a-zA-Z0-9][a-zA-Z0-9._-]*\/)?[a-zA-Z0-9][a-zA-Z0-9._-]*(?![\s\S])/;
export const MAX_DEPENDENCY_PACKAGE_NAME = 214;
export const MAX_DEPENDENCY_QUERY = 1_000;
export const MAX_DEPENDENCY_VERSION = 256;
export const MAX_DEPENDENCY_SOURCE = 4_096;
const MAX_CACHE_ENTRIES = 64;
const MAX_IN_FLIGHT = 8;
const EXACT_VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9a-z-]+(?:\.[0-9a-z-]+)*)?(?:\+[0-9a-z-]+(?:\.[0-9a-z-]+)*)?(?![\s\S])/i;

type JsonObject = Record<string, unknown>;

export interface DependencyReferenceRequest {
  packageName: string;
  /** Directory of the consuming project, relative to the resolver root or absolute. */
  fromDirectory?: string;
  /** Optional literal symbol or text to look for in local references. */
  query?: string;
  /** Ignore the installed version and explicitly request current official documentation. */
  latest?: boolean;
}

export interface DependencyReference {
  kind: "declaration" | "local-documentation" | "official-documentation";
  /** Workspace-relative file path or official source URL. */
  source: string;
  excerpt: string;
}

export interface DependencyReferenceResult {
  packageName: string;
  version?: string;
  versionSource?: { kind: "installed" | "lockfile" | "official"; source: string };
  references: DependencyReference[];
}

export interface OfficialDocumentationRequest {
  packageName: string;
  /** Exact resolved version, or "latest" only on explicit request. */
  version: string;
  query?: string;
}

export interface OfficialDocumentationResult {
  /** Actual documentation version, including when the request was for latest. */
  version: string;
  source: string;
  excerpt: string;
}

export interface DependencyReferenceOptions {
  /** Caller-supplied retrieval from a trusted official documentation source. */
  retrieveOfficialDocumentation?: (request: OfficialDocumentationRequest) => Promise<OfficialDocumentationResult | undefined>;
  /** Maximum number of cached version/query combinations (default and maximum 64). */
  cacheEntries?: number;
}

function object(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : undefined;
}

function exactVersion(value: unknown): string | undefined {
  return typeof value === "string" && value.length <= MAX_DEPENDENCY_VERSION && EXACT_VERSION.test(value) ? value : undefined;
}

function inside(root: string, path: string): boolean {
  const local = relative(root, path);
  return local !== ".." && !local.startsWith(`..${sep}`) && !isAbsolute(local);
}

async function boundedText(path: string, root: string, maximum: number): Promise<string | undefined> {
  try {
    const actual = await realpath(path);
    if (!inside(root, actual)) return undefined;
    const file = await open(actual, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
    try {
      const info = await file.stat();
      if (!info.isFile() || info.size > maximum) return undefined;
      // Read at most the measured size plus one byte, even if the file grows.
      const buffer = Buffer.alloc(info.size + 1);
      let offset = 0;
      while (offset < buffer.length) {
        const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, offset);
        if (!bytesRead) break;
        offset += bytesRead;
      }
      if (offset !== info.size) return undefined;
      return buffer.toString("utf8", 0, offset);
    } finally {
      await file.close();
    }
  } catch {
    return undefined;
  }
}

async function json(path: string, root: string): Promise<JsonObject | undefined> {
  const text = await boundedText(path, root, MAX_MANIFEST_BYTES);
  if (text === undefined) return undefined;
  try {
    return object(JSON.parse(text));
  } catch {
    return undefined;
  }
}

function excerpt(text: string, query?: string): string | undefined {
  if (!query) return text.slice(0, MAX_EXCERPT_LENGTH);
  const index = text.indexOf(query);
  if (index < 0) return undefined;
  const start = Math.max(0, index - 1_000);
  return text.slice(start, start + MAX_EXCERPT_LENGTH);
}

function declarationPaths(manifest: JsonObject): string[] {
  const paths = new Set<string>();
  for (const value of [manifest.types, manifest.typings]) {
    if (typeof value === "string") paths.add(value);
  }
  // Conditional root exports often declare separate ESM and CJS typings.
  function visit(value: unknown, depth: number): void {
    if (depth > 8 || paths.size >= MAX_REFERENCES) return;
    const entry = object(value);
    if (!entry) return;
    for (const [key, child] of Object.entries(entry)) {
      if (key === "types" && typeof child === "string") paths.add(child);
      else visit(child, depth + 1);
      if (paths.size >= MAX_REFERENCES) break;
    }
  }
  const exports = object(manifest.exports);
  visit(exports?.["."] ?? exports, 0);
  paths.add("index.d.ts");
  return [...paths].filter(path => /\.d\.(?:ts|cts|mts)$/.test(path));
}

/**
 * Resolve references for npm packages within a workspace. Local metadata and
 * documentation are read afresh; only official retrieval results are cached.
 */
export class DependencyReferenceResolver {
  private readonly cache = new Map<string, OfficialDocumentationResult>();
  private readonly inFlight = new Map<string, Promise<OfficialDocumentationResult | undefined>>();
  private readonly cacheEntries: number;

  constructor(readonly root: string, private readonly options: DependencyReferenceOptions = {}) {
    this.cacheEntries = options.cacheEntries ?? MAX_CACHE_ENTRIES;
    if (!Number.isSafeInteger(this.cacheEntries) || this.cacheEntries < 0) {
      throw new Error("Expected a nonnegative integer cache capacity");
    }
    this.cacheEntries = Math.min(this.cacheEntries, MAX_CACHE_ENTRIES);
  }

  async resolve(request: DependencyReferenceRequest): Promise<DependencyReferenceResult> {
    const { packageName, query } = request;
    if (typeof packageName !== "string" || packageName.length > MAX_DEPENDENCY_PACKAGE_NAME || !DEPENDENCY_PACKAGE_NAME_PATTERN.test(packageName)) throw new Error("Expected an npm package name");
    if (query !== undefined && (typeof query !== "string" || query.length === 0 || query.length > MAX_DEPENDENCY_QUERY)) throw new Error("Expected a nonempty reference query of at most 1000 characters");
    if (request.latest !== undefined && typeof request.latest !== "boolean") throw new Error("Expected a boolean latest flag");
    const root = await realpath(this.root);
    const fromDirectory = await realpath(resolve(root, request.fromDirectory ?? "."));
    if (!inside(root, fromDirectory) || !(await stat(fromDirectory)).isDirectory()) {
      throw new Error("Reference directory must be within the workspace");
    }
    const result: DependencyReferenceResult = { packageName, references: [] };
    let officialPackage = packageName;
    if (request.latest !== true) {
      const directories: string[] = [];
      for (let directory = fromDirectory; ; directory = dirname(directory)) {
        directories.push(directory);
        if (directory === root) break;
      }
      // Node's nearest installed package takes precedence over lock metadata.
      for (const directory of directories) {
        const packageRoot = join(directory, "node_modules", packageName);
        const actualPackageRoot = await realpath(packageRoot).catch(() => undefined);
        if (!actualPackageRoot) continue;
        // Do not fall back to another package/version if the nearer installation
        // is outside the workspace or its metadata cannot be safely inspected.
        if (!inside(root, actualPackageRoot) || actualPackageRoot === root) return result;
        const manifestPath = join(packageRoot, "package.json");
        const manifest = await json(join(actualPackageRoot, "package.json"), actualPackageRoot);
        const version = exactVersion(manifest?.version);
        if (!manifest || !version) return result;
        result.version = version;
        result.versionSource = { kind: "installed", source: relative(root, manifestPath) };
        // npm aliases use the installed manifest's canonical name.
        if (typeof manifest.name === "string") officialPackage = manifest.name;
        const candidates = [
          ...declarationPaths(manifest).map(path => ({ path, kind: "declaration" as const })),
          ...["README.md", "readme.md", "README", "docs/index.md", "docs/README.md"].map(path => ({ path, kind: "local-documentation" as const })),
        ];
        const seen = new Set<string>();
        for (const candidate of candidates) {
          const path = resolve(actualPackageRoot, candidate.path);
          if (!inside(actualPackageRoot, path)) continue;
          // Deduplicate aliases, including README.md/readme.md on case-insensitive filesystems.
          const actual = await realpath(path).catch(() => undefined);
          if (!actual || !inside(actualPackageRoot, actual)) continue;
          if (candidate.kind === "declaration" && !/\.d\.(?:ts|cts|mts)$/.test(actual)) continue;
          const info = await stat(actual).catch(() => undefined);
          if (!info) continue;
          const identity = `${info.dev}:${info.ino}`;
          if (seen.has(identity)) continue;
          seen.add(identity);
          const content = await boundedText(path, actualPackageRoot, MAX_REFERENCE_BYTES);
          const snippet = content === undefined ? undefined : excerpt(content, query);
          if (snippet) result.references.push({ kind: candidate.kind, source: relative(root, path), excerpt: snippet });
          if (result.references.length === MAX_REFERENCES) break;
        }
        break;
      }
      if (!result.version) {
        for (const lockDirectory of directories) {
          const lockPath = join(lockDirectory, "package-lock.json");
          const lock = await json(lockPath, root);
          if (!lock) continue;
          const packages = object(lock.packages);
          for (const directory of directories) {
            if (!inside(lockDirectory, directory)) continue;
            const key = relative(lockDirectory, join(directory, "node_modules", packageName)).split(sep).join("/");
            const entry = object(packages?.[key]);
            const legacy = directory === lockDirectory && !packages ? object(object(lock.dependencies)?.[packageName]) : undefined;
            const version = exactVersion(entry?.version ?? legacy?.version);
            if (!version) {
              // An explicit nearer lock entry (including an unresolved link)
              // cannot establish the version of a farther duplicate.
              if (entry || legacy) return result;
              continue;
            }
            result.version = version;
            result.versionSource = { kind: "lockfile", source: `${relative(root, lockPath)}#${packages ? key : `dependencies/${packageName}`}` };
            if (typeof entry?.name === "string") officialPackage = entry.name;
            break;
          }
          if (result.version) break;
        }
      }
      if (!result.version || result.references.length) return result;
    }
    const version = request.latest === true ? "latest" : result.version!;
    if (officialPackage.length > MAX_DEPENDENCY_PACKAGE_NAME || !DEPENDENCY_PACKAGE_NAME_PATTERN.test(officialPackage)) return result;
    const official = await this.official({ packageName: officialPackage, version, ...(query === undefined ? {} : { query }) });
    if (official) {
      if (request.latest === true) {
        result.version = official.version;
        result.versionSource = { kind: "official", source: official.source };
      }
      result.references.push({ kind: "official-documentation", source: official.source, excerpt: official.excerpt });
    }
    return result;
  }

  private async official(request: OfficialDocumentationRequest): Promise<OfficialDocumentationResult | undefined> {
    const retrieve = this.options.retrieveOfficialDocumentation;
    if (!retrieve) return undefined;
    const key = JSON.stringify([request.packageName, request.version, request.query]);
    const cached = this.cache.get(key);
    if (cached) {
      this.cache.delete(key);
      this.cache.set(key, cached);
      return cached;
    }
    const existing = this.inFlight.get(key);
    if (existing) return existing;
    if (this.inFlight.size >= MAX_IN_FLIGHT) return undefined;
    const pending = Promise.resolve().then(async () => {
      const documentation = await retrieve(request);
      if (!documentation || !exactVersion(documentation.version)
        || (request.version !== "latest" && documentation.version !== request.version)
        || typeof documentation.source !== "string" || documentation.source.length > MAX_DEPENDENCY_SOURCE
        || typeof documentation.excerpt !== "string" || !documentation.excerpt) return undefined;
      const source = URL.parse(documentation.source);
      if (!source || source.protocol !== "https:" || source.username || source.password) return undefined;
      const value = { version: documentation.version, source: documentation.source, excerpt: documentation.excerpt.slice(0, MAX_EXCERPT_LENGTH) };
      // A latest request never creates a persistent alias for an exact version.
      const versionKey = JSON.stringify([request.packageName, value.version, request.query]);
      this.cache.delete(versionKey);
      this.cache.set(versionKey, value);
      while (this.cache.size > this.cacheEntries) this.cache.delete(this.cache.keys().next().value!);
      return value;
    });
    this.inFlight.set(key, pending);
    try {
      return await pending;
    } finally {
      this.inFlight.delete(key);
    }
  }
}

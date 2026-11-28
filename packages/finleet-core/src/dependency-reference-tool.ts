import { realpath, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { DEPENDENCY_PACKAGE_NAME_PATTERN, MAX_DEPENDENCY_PACKAGE_NAME, MAX_DEPENDENCY_QUERY, MAX_DEPENDENCY_SOURCE, MAX_DEPENDENCY_VERSION, DependencyReferenceResolver, type DependencyReferenceOptions, type DependencyReferenceRequest, type DependencyReferenceResult } from "./dependency-reference.js";
import { fail, type Json } from "./domain.js";
import type { ToolDefinition } from "./runtime.js";

export const DEPENDENCY_REFERENCE_TOOL_NAME = "dependency_reference";

const MAX_WORKSPACES = 8;
const MAX_REFERENCES = 8;
const MAX_EXCERPT = 2_000;
const MAX_ACTIVE_LOOKUPS = 8;

type DependencyInput = Pick<DependencyReferenceRequest, "packageName" | "query" | "latest">;

/** Reuse the tool definition across calls to retain the bounded official documentation cache. */
export function dependencyReferenceTool(options: DependencyReferenceOptions = {}): ToolDefinition<DependencyInput, DependencyReferenceResult> {
  const workspaces = new Map<string, DependencyReferenceResolver>();
  const retrieve = options.retrieveOfficialDocumentation;
  let activeLookups = 0;
  const officialOptions: DependencyReferenceOptions = {
    cacheEntries: options.cacheEntries ?? 16,
    ...(retrieve ? {
      retrieveOfficialDocumentation: async request => {
        const result = await retrieve(request);
        if (!result || typeof result.excerpt !== "string") return undefined;
        return { version: result.version, source: result.source, excerpt: result.excerpt.slice(0, MAX_EXCERPT + 1) };
      },
    } : {}),
  };
  return {
    advertisement: {
      name: DEPENDENCY_REFERENCE_TOOL_NAME,
      description: "Look up an npm dependency's installed or lockfile version and find relevant declarations or local documentation in the current workspace. Optional literal query selects relevant excerpts. Official version-specific documentation may be available with web:read permission. Set latest to true only when explicitly asked for current official documentation instead of the project's version.",
      requiredPermission: "shell:read",
      inputSchema: {
        type: "object",
        required: ["packageName"],
        additionalProperties: false,
        properties: {
          packageName: { type: "string", minLength: 1, maxLength: MAX_DEPENDENCY_PACKAGE_NAME, pattern: DEPENDENCY_PACKAGE_NAME_PATTERN.source },
          query: { type: "string", minLength: 1, maxLength: MAX_DEPENDENCY_QUERY },
          latest: { type: "boolean", default: false },
        },
      },
    },
    durableResultLimit: 384 * 1024,
    decode(input) {
      if (typeof input !== "object" || input === null || Array.isArray(input)) return fail("TOOL_ARGUMENT_INVALID", "Expected a package name and optional query and latest flag");
      const fields = input as Record<string, unknown>;
      if (Object.keys(fields).some(key => key !== "packageName" && key !== "query" && key !== "latest")) return fail("TOOL_ARGUMENT_INVALID", "Only packageName, query and latest are supported");
      const { packageName, query, latest = false } = fields;
      if (typeof packageName !== "string" || packageName.length > MAX_DEPENDENCY_PACKAGE_NAME || !DEPENDENCY_PACKAGE_NAME_PATTERN.test(packageName)) return fail("TOOL_ARGUMENT_INVALID", "Expected an npm package name");
      if (query !== undefined && (typeof query !== "string" || !query.length || query.length > MAX_DEPENDENCY_QUERY)) return fail("TOOL_ARGUMENT_INVALID", "Expected a nonempty query of at most 1000 characters");
      if (typeof latest !== "boolean") return fail("TOOL_ARGUMENT_INVALID", "latest must be a boolean");
      return { ok: true, value: { packageName, ...(query === undefined ? {} : { query }), latest } };
    },
    authorize(context) {
      return context.permissions.has("shell:read")
        ? { ok: true, value: undefined }
        : fail("TOOL_DENIED", "shell:read permission is required");
    },
    async execute(input, context) {
      if (!context.permissions.has("shell:read")) return fail("TOOL_DENIED", "shell:read permission is required");
      if (context.signal?.aborted) return fail("TOOL_CANCELLED", "Dependency lookup was cancelled");
      if (!context.workingDirectory || !isAbsolute(context.workingDirectory)) return fail("TOOL_WORKSPACE_UNAVAILABLE", "An absolute working directory is required");
      const root = await realpath(context.workingDirectory).catch(() => undefined);
      if (!root || !(await stat(root).catch(() => undefined))?.isDirectory()) return fail("TOOL_WORKSPACE_UNAVAILABLE", "A valid working directory is required");
      const canRetrieve = !!retrieve && context.permissions.has("web:read");
      if (input.latest && !context.permissions.has("web:read")) return fail("TOOL_DENIED", "web:read permission is required for latest documentation");
      if (input.latest && !retrieve) return fail("TOOL_REFERENCE_UNAVAILABLE", "Official documentation retrieval is not configured");
      if (activeLookups >= MAX_ACTIVE_LOOKUPS) return fail("TOOL_REFERENCE_BUSY", "Too many dependency lookups are in progress");
      activeLookups++;
      try {
        if (context.signal?.aborted) return fail("TOOL_CANCELLED", "Dependency lookup was cancelled");
        // Unprivileged local lookups never access the official cache and have no retained state.
        const resolver = (canRetrieve ? workspaces.get(root) : undefined) ?? new DependencyReferenceResolver(root, canRetrieve ? officialOptions : {});
        if (canRetrieve) {
          workspaces.delete(root);
          workspaces.set(root, resolver);
          if (workspaces.size > MAX_WORKSPACES) workspaces.delete(workspaces.keys().next().value!);
        }
        const result = await resolver.resolve(input);
        if (context.signal?.aborted) return fail("TOOL_CANCELLED", "Dependency lookup was cancelled");
        return { ok: true, value: result };
      } catch {
        if (context.signal?.aborted) return fail("TOOL_CANCELLED", "Dependency lookup was cancelled");
        return fail("TOOL_REFERENCE_FAILED", "Unable to look up dependency references in the current workspace");
      } finally {
        activeLookups--;
      }
    },
    encode(output): Json {
      const versionSource = output.versionSource && output.versionSource.source.length <= MAX_DEPENDENCY_SOURCE ? output.versionSource : undefined;
      const validVersion = output.version !== undefined && output.version.length <= MAX_DEPENDENCY_VERSION && !!versionSource;
      const references = output.references.slice(0, MAX_REFERENCES).filter(reference => reference.source.length <= MAX_DEPENDENCY_SOURCE);
      return {
        packageName: output.packageName,
        ...(validVersion ? { version: output.version! } : {}),
        ...(validVersion && versionSource ? { versionSource: { kind: versionSource.kind, source: versionSource.source } } : {}),
        references: references.map(reference => ({
          kind: reference.kind,
          source: reference.source,
          excerpt: reference.excerpt.slice(0, MAX_EXCERPT),
        })),
        truncated: references.length !== output.references.length || references.some(reference => reference.excerpt.length > MAX_EXCERPT) || (!!output.version && !validVersion) || (!!output.versionSource && !versionSource),
      };
    },
  };
}

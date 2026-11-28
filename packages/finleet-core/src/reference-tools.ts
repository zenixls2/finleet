import { realpathSync } from "node:fs";
import { isAbsolute } from "node:path";
import { WorkspaceCodeIndex, type CodeReferenceResult } from "./code-index.js";
import { fail, type Json } from "./domain.js";
import type { ToolDefinition } from "./runtime.js";

const MAX_REFERENCES = 100;
const DEFAULT_REFERENCES = 20;
const MAX_IDENTIFIER_LENGTH = 256;
const MAX_CACHED_WORKSPACES = 4;
const IDENTIFIER = /^[$_\p{ID_Start}][$\u200c\u200d\p{ID_Continue}]*$/u;

export const REFERENCE_TOOL_NAME = "find_references";

interface ReferenceInput {
  identifier: string;
  limit: number;
}

/** Create a read-only reference tool. Reuse the definition across turns for incremental refresh. */
export function referenceTool(): ToolDefinition<ReferenceInput, CodeReferenceResult> {
  const workspaces = new Map<string, WorkspaceCodeIndex>();
  return {
    advertisement: {
      name: REFERENCE_TOOL_NAME,
      description: "Find exact, case-sensitive identifier occurrences in source files in the current workspace. Results contain relative paths, one-based lines and columns, and short excerpts. Includes declarations, comments and strings; this is lexical lookup, without type or scope resolution. Truncated results indicate a lookup or workspace index limit was reached.",
      requiredPermission: "shell:read",
      inputSchema: {
        type: "object",
        required: ["identifier"],
        additionalProperties: false,
        properties: {
          identifier: { type: "string", minLength: 1, maxLength: MAX_IDENTIFIER_LENGTH },
          limit: { type: "integer", minimum: 1, maximum: MAX_REFERENCES, default: DEFAULT_REFERENCES },
        },
      },
    },
    durableResultLimit: 64 * 1024,
    decode(input) {
      if (typeof input !== "object" || input === null || Array.isArray(input)) return fail("TOOL_ARGUMENT_INVALID", "Expected an identifier and optional limit");
      const fields = input as Record<string, unknown>;
      if (Object.keys(fields).some((key) => key !== "identifier" && key !== "limit")) return fail("TOOL_ARGUMENT_INVALID", "Only identifier and limit are supported");
      const { identifier, limit = DEFAULT_REFERENCES } = fields;
      if (typeof identifier !== "string" || identifier.length > MAX_IDENTIFIER_LENGTH || !IDENTIFIER.test(identifier)) return fail("TOOL_ARGUMENT_INVALID", "Expected a single identifier");
      if (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 1 || limit > MAX_REFERENCES) return fail("TOOL_ARGUMENT_INVALID", "Expected a limit between 1 and 100");
      return { ok: true, value: { identifier, limit } };
    },
    authorize(context) {
      return context.permissions.has("shell:read")
        ? { ok: true, value: undefined }
        : fail("TOOL_DENIED", "shell:read permission is required");
    },
    execute(input, context) {
      if (!context.permissions.has("shell:read")) return fail("TOOL_DENIED", "shell:read permission is required");
      if (context.signal?.aborted) return fail("TOOL_CANCELLED", "Reference lookup was cancelled");
      if (!context.workingDirectory || !isAbsolute(context.workingDirectory)) return fail("TOOL_WORKSPACE_UNAVAILABLE", "An absolute working directory is required");
      try {
        const root = realpathSync(context.workingDirectory);
        const index = workspaces.get(root) ?? new WorkspaceCodeIndex(root);
        if (index.root !== root) return fail("TOOL_WORKSPACE_UNAVAILABLE", "Working directory changed during lookup");
        index.refresh();
        workspaces.delete(root);
        workspaces.set(root, index);
        if (workspaces.size > MAX_CACHED_WORKSPACES) {
          const oldest = workspaces.keys().next().value;
          if (oldest !== undefined) workspaces.delete(oldest);
        }
        return { ok: true, value: index.findReferences(input.identifier, input.limit) };
      } catch {
        return fail("TOOL_REFERENCE_FAILED", "Unable to look up references in the current workspace");
      }
    },
    encode(output): Json {
      return { references: output.references.map((ref) => ({ path: ref.path, line: ref.line, column: ref.column, excerpt: ref.excerpt })), truncated: output.truncated };
    },
  };
}

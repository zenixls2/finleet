import {
  DEPENDENCY_PACKAGE_NAME_PATTERN,
  MAX_DEPENDENCY_PACKAGE_NAME,
  MAX_DEPENDENCY_QUERY,
  MAX_DEPENDENCY_VERSION,
  type OfficialDocumentationRequest,
  type OfficialDocumentationResult,
} from "./dependency-reference.js";

const REGISTRY = "https://registry.npmjs.org";
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_EXCERPT = 2_000;
const TIMEOUT_MS = 5_000;
const EXACT_VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9a-z-]+(?:\.[0-9a-z-]+)*)?(?:\+[0-9a-z-]+(?:\.[0-9a-z-]+)*)?(?![\s\S])/i;

type RegistryMetadata = Record<string, unknown>;
export type OfficialDocumentationFetch = (url: string, init: RequestInit) => Promise<Response>;

function exactVersion(value: unknown): value is string {
  return typeof value === "string" && value.length <= MAX_DEPENDENCY_VERSION && EXACT_VERSION.test(value);
}

async function metadata(fetcher: OfficialDocumentationFetch, url: string, signal: AbortSignal): Promise<RegistryMetadata | undefined> {
  const response = await fetcher(url, {
    method: "GET",
    redirect: "error",
    credentials: "omit",
    headers: { accept: "application/json" },
    signal,
  });
  const body = response.body;
  if (!body) return undefined;
  const reader = body.getReader();
  try {
    if (signal.aborted || !response.ok || response.redirected || (response.url && response.url !== url)) return undefined;
    const length = response.headers.get("content-length");
    if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_RESPONSE_BYTES)) return undefined;
    const contentType = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
    if (contentType !== "application/json") return undefined;
    const buffer = new Uint8Array(MAX_RESPONSE_BYTES);
    let bytes = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (signal.aborted) return undefined;
      if (done) break;
      if (bytes + value.byteLength > MAX_RESPONSE_BYTES) return undefined;
      buffer.set(value, bytes);
      bytes += value.byteLength;
    }
    const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, bytes)));
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as RegistryMetadata : undefined;
  } finally {
    // Do not wait indefinitely for a broken transport's cancellation handler.
    void reader.cancel().catch(() => {});
  }
}

/**
 * Explicitly opt in by supplying a fetch implementation. Only the npm registry
 * version endpoint is consulted; a packument README is not version evidence.
 * npm often omits README content from version metadata, yielding no reference.
 */
export function createNpmOfficialDocumentationRetriever(fetcher: OfficialDocumentationFetch): (request: OfficialDocumentationRequest) => Promise<OfficialDocumentationResult | undefined> {
  let active = 0;
  return async ({ packageName, version, query }) => {
    if (typeof packageName !== "string" || packageName.length > MAX_DEPENDENCY_PACKAGE_NAME || !DEPENDENCY_PACKAGE_NAME_PATTERN.test(packageName)) return undefined;
    if (version !== "latest" && !exactVersion(version)) return undefined;
    if (query !== undefined && (typeof query !== "string" || !query.length || query.length > MAX_DEPENDENCY_QUERY)) return undefined;
    if (active >= 8) return undefined;
    const base = `${REGISTRY}/${encodeURIComponent(packageName)}`;
    const controller = new AbortController();
    active++;
    const work = async (): Promise<OfficialDocumentationResult | undefined> => {
      if (version === "latest") {
        const latest = await metadata(fetcher, `${base}/latest`, controller.signal);
        if (controller.signal.aborted || latest?.name !== packageName || !exactVersion(latest.version)) return undefined;
        version = latest.version;
      }
      const source = `${base}/${encodeURIComponent(version)}`;
      const manifest = await metadata(fetcher, source, controller.signal);
      if (controller.signal.aborted || manifest?.name !== packageName || manifest.version !== version) return undefined;
      // Reject package-level documents even if they happen to contain a version.
      if ("versions" in manifest || "dist-tags" in manifest) return undefined;
      const readme = manifest.readme;
      if (typeof readme !== "string" || !readme.trim() || /^ERROR:\s*No README data found!$/i.test(readme.trim())) return undefined;
      const index = query === undefined ? 0 : readme.indexOf(query);
      if (index < 0) return undefined;
      const start = Math.max(0, index - 500);
      return { version, source, excerpt: readme.slice(start, start + MAX_EXCERPT) };
    };
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<undefined>(resolve => {
      timeout = setTimeout(() => {
        controller.abort();
        resolve(undefined);
      }, TIMEOUT_MS);
    });
    // Hold the concurrency slot until the underlying transport actually settles.
    const pending = work().catch(() => undefined).finally(() => { active--; });
    try {
      return await Promise.race([pending, deadline]);
    } finally {
      clearTimeout(timeout);
    }
  };
}

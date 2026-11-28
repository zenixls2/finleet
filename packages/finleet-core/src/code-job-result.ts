import { fail, MAX_AGENT_OUTPUT, MAX_EVENT_TEXT, redactOutputText, type BackgroundAgentTerminalEnvelope, type Result } from "./domain.js";

export const MAX_CODE_JOB_ITEMS = 16;

export interface CodeJobVerification {
  readonly check: string;
  readonly status: "passed" | "failed" | "not_run";
  readonly detail?: string;
}

/** All fields are reported claims, including successful verification. */
export interface CodeJobResult {
  readonly trust: "untrusted-data";
  readonly summary: string;
  readonly changedFiles: readonly string[];
  readonly verification: readonly CodeJobVerification[];
  readonly remainingIssues: readonly string[];
}

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function text(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > MAX_EVENT_TEXT) return undefined;
  const sanitized = redactOutputText(value);
  if (sanitized.trim().length === 0 || sanitized.length > MAX_EVENT_TEXT) return undefined;
  // Terminal envelopes are redacted again by the journal. Some credential
  // assignments consume JSON punctuation on that second pass, so redact the
  // entire field when its encoded form cannot survive that pass unchanged.
  const encoded = JSON.stringify(sanitized);
  return redactOutputText(encoded) === encoded ? sanitized : "[REDACTED]";
}

function textList(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length > MAX_CODE_JOB_ITEMS) return undefined;
  const result: string[] = [];
  for (const item of value) {
    const sanitized = text(item);
    if (sanitized === undefined) return undefined;
    result.push(sanitized);
  }
  return result;
}

function verificationList(value: unknown): CodeJobVerification[] | undefined {
  if (!Array.isArray(value) || value.length > MAX_CODE_JOB_ITEMS) return undefined;
  const result: CodeJobVerification[] = [];
  for (const item of value) {
    if (!record(item)) return undefined;
    const check = text(item.check);
    const status = item.status;
    if (check === undefined || (status !== "passed" && status !== "failed" && status !== "not_run")) return undefined;
    const detail = item.detail === undefined ? undefined : text(item.detail);
    if (item.detail !== undefined && detail === undefined) return undefined;
    result.push({ check, status, ...(detail === undefined ? {} : { detail }) });
  }
  return result;
}

/**
 * Validate and redact a reported completion summary. Unknown properties are
 * discarded. Reject oversized reports rather than silently omitting issues
 * or truncating structured JSON.
 */
export function validateCodeJobResult(input: unknown): Result<CodeJobResult> {
  if (!record(input) || (input.trust !== undefined && input.trust !== "untrusted-data")) {
    return fail("CODE_JOB_RESULT_INVALID", "Expected an untrusted coding-job report");
  }
  const summary = text(input.summary);
  const changedFiles = textList(input.changedFiles);
  const verification = verificationList(input.verification);
  const remainingIssues = textList(input.remainingIssues);
  if (summary === undefined || changedFiles === undefined || verification === undefined || remainingIssues === undefined) {
    return fail("CODE_JOB_RESULT_INVALID", "Invalid or oversized coding-job report fields");
  }
  const report: CodeJobResult = { trust: "untrusted-data", summary, changedFiles, verification, remainingIssues };
  if (JSON.stringify(report).length > MAX_AGENT_OUTPUT) {
    return fail("CODE_JOB_RESULT_TOO_LARGE", "Coding-job report exceeds the terminal output limit");
  }
  return { ok: true, value: report };
}

/** Encode a completed report using the existing background terminal envelope. */
export function encodeCodeJobResult(input: unknown): Result<BackgroundAgentTerminalEnvelope> {
  const report = validateCodeJobResult(input);
  if (!report.ok) return report;
  return { ok: true, value: { trust: "untrusted-data", status: "completed", output: JSON.stringify(report.value), outputTruncated: false } };
}

/** Decode only complete structured output; never infer success from failures or prose. */
export function decodeCodeJobResult(envelope: BackgroundAgentTerminalEnvelope): Result<CodeJobResult> {
  if (envelope.trust !== "untrusted-data" || envelope.status !== "completed" ||
      envelope.outputTruncated !== false || typeof envelope.output !== "string" || envelope.output.length > MAX_AGENT_OUTPUT) {
    return fail("CODE_JOB_RESULT_UNAVAILABLE", "A complete untrusted terminal output is required");
  }
  try {
    return validateCodeJobResult(JSON.parse(envelope.output));
  } catch {
    return fail("CODE_JOB_RESULT_INVALID", "Terminal output is not a structured coding-job report");
  }
}

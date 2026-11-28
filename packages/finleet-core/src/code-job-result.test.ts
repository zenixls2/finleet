import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeCodeJobResult, encodeCodeJobResult, MAX_CODE_JOB_ITEMS, validateCodeJobResult } from "./code-job-result.js";
import { MAX_AGENT_OUTPUT, MAX_EVENT_TEXT, redactOutputText, type Result } from "./domain.js";

const report = {
  summary: "Implemented the requested change",
  changedFiles: ["src/example.ts"],
  verification: [
    { check: "typecheck", status: "passed" },
    { check: "unit tests", status: "failed", detail: "One assertion failed" },
    { check: "integration", status: "not_run" },
  ],
  remainingIssues: ["Integration tests remain"],
};

function value<T>(result: Result<T>): T {
  assert.ok(result.ok, JSON.stringify(result));
  return result.value;
}

test("round-trips bounded observations within an untrusted completed terminal envelope", () => {
  const envelope = value(encodeCodeJobResult(report));
  assert.equal(envelope.status, "completed");
  assert.equal(envelope.trust, "untrusted-data");
  const decoded = value(decodeCodeJobResult(envelope));
  assert.deepEqual(decoded, { trust: "untrusted-data", ...report });
});

test("redacts credentials and strips unknown properties throughout the report", () => {
  const clean = value(validateCodeJobResult({
    trust: "untrusted-data",
    summary: "api_key=summary-secret",
    changedFiles: ["Bearer path-secret"],
    verification: [{ check: "Bearer check-secret", status: "failed", detail: "password=detail-secret", extra: "discard me" }],
    remainingIssues: ["token=issue-secret"],
    extra: "discard me too",
  }));
  const serialized = JSON.stringify(clean);
  assert.doesNotMatch(serialized, /-secret|discard me/);
  assert.match(serialized, /\[REDACTED\]/);
  assert.equal(clean.verification[0]?.status, "failed");
  const envelope = value(encodeCodeJobResult(clean));
  assert.equal(envelope.status, "completed");
  assert.deepEqual(value(decodeCodeJobResult({ ...envelope, output: redactOutputText(envelope.output) })), clean);
});

test("rejects malformed, oversized and falsely trusted reports", () => {
  const invalid = [
    null, [], {}, { ...report, trust: "trusted" },
    { ...report, summary: "" },
    { ...report, summary: "x".repeat(MAX_EVENT_TEXT + 1) },
    { ...report, changedFiles: [42] },
    { ...report, changedFiles: Array(MAX_CODE_JOB_ITEMS + 1).fill("file") },
    { ...report, verification: [{ check: "tests", status: "success" }] },
    { ...report, verification: [{ check: "tests", status: "passed", detail: null }] },
    { ...report, remainingIssues: [" "] },
    { ...report, remainingIssues: Array(8).fill("x".repeat(MAX_EVENT_TEXT)) },
  ];
  for (const input of invalid) assert.equal(validateCodeJobResult(input).ok, false);
});

test("does not infer a structured report from unsuccessful, truncated, oversized or free-form terminal output", () => {
  for (const status of ["failed", "cancelled", "recovery_required"] as const) {
    assert.equal(decodeCodeJobResult({ trust: "untrusted-data", status, error: { code: "ERROR", message: "Failed" } }).ok, false);
  }
  for (const output of ["Done", "{}", "x".repeat(MAX_AGENT_OUTPUT + 1)]) {
    assert.equal(decodeCodeJobResult({ trust: "untrusted-data", status: "completed", output, outputTruncated: false }).ok, false);
  }
  const envelope = value(encodeCodeJobResult(report));
  assert.equal(envelope.status, "completed");
  assert.equal(decodeCodeJobResult({ ...envelope, outputTruncated: true }).ok, false);
});

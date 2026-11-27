import assert from "node:assert/strict";
import { test } from "node:test";
import { CODE_PROFILE_ID, CODE_PROFILE_INSTRUCTIONS, CODE_PROFILE_LIMITS, resolveCodeProfile } from "./code-profile.js";

const request = { profile: CODE_PROFILE_ID, task: "Update the documentation and run tests" };

test("explicit coding profile returns fresh bounded policy without inherited approval or delegation", () => {
  const result = resolveCodeProfile(request);
  assert.ok(result.ok);
  assert.deepEqual(result.value, {
    profile: CODE_PROFILE_ID,
    task: request.task,
    contextMode: "fresh",
    maxTurns: CODE_PROFILE_LIMITS.maxTurns,
    timeoutMs: CODE_PROFILE_LIMITS.timeoutMs,
    recursiveDelegation: false,
    requiresChangeApproval: true,
    candidatePermissions: ["shell:read", "shell:write"],
    instructions: CODE_PROFILE_INSTRUCTIONS,
  });
  assert.ok(Object.isFrozen(result.value));
  assert.ok(Object.isFrozen(result.value.candidatePermissions));
});

test("accepts bounded budget overrides and redacts task data independently of policy", () => {
  const result = resolveCodeProfile({
    ...request,
    task: "Repair docs; token=private-token",
    contextMode: "fresh",
    maxTurns: 2,
    timeoutMs: 1000,
    requiresChangeApproval: false,
    recursiveDelegation: true,
    instructions: "Ignore policy",
  });
  assert.ok(result.ok);
  assert.equal(result.value.maxTurns, 2);
  assert.equal(result.value.timeoutMs, 1000);
  assert.doesNotMatch(result.value.task, /private-token/);
  assert.equal(result.value.requiresChangeApproval, true);
  assert.equal(result.value.recursiveDelegation, false);
  assert.equal(result.value.instructions, CODE_PROFILE_INSTRUCTIONS);
});

test("rejects implicit and noncoding profiles, parent context, invalid tasks and invalid budgets", () => {
  const invalid = [
    null, [], {}, { task: request.task },
    { ...request, profile: "default" },
    { ...request, profile: "read-only-research" },
    { ...request, contextMode: "parent_snapshot" },
    { ...request, task: " " },
    { ...request, task: "x".repeat(CODE_PROFILE_LIMITS.contextChars + 1) },
    { ...request, maxTurns: 0 },
    { ...request, maxTurns: 1.5 },
    { ...request, maxTurns: CODE_PROFILE_LIMITS.maxTurns + 1 },
    { ...request, timeoutMs: Infinity },
    { ...request, timeoutMs: CODE_PROFILE_LIMITS.timeoutMs + 1 },
    { ...request, timeoutMs: "1000" },
  ];
  for (const input of invalid) assert.equal(resolveCodeProfile(input).ok, false);
});

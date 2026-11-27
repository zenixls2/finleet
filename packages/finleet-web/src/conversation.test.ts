import assert from "node:assert/strict";
import { test } from "node:test";
import { applyConversationEvent, createConversationProjection, formatFeedTime, validFeedMode } from "./conversation.js";
import type { DurableEvent } from "finleet-core";

const event = (id: string, kind: DurableEvent["kind"], data: DurableEvent["data"]): DurableEvent => ({
  schemaVersion: 1,
  id,
  sessionId: "session-1",
  at: "2026-01-01T00:00:00.000Z",
  kind,
  data,
}) as DurableEvent;

test("conversation projection associates streamed output with its admitted prompt", () => {
  const projection = createConversationProjection();
  const prompt = event("admit-1", "PromptAdmitted", { promptId: "prompt-1", prompt: "Explain this result", delivery: "queue" });
  const run = event("run-start-1", "GraphRunStarted", { runId: "run-1", planId: "plan", planVersion: 1, planDigest: "digest", status: "running", inputEventId: "admit-1" });
  const turn = event("provider-start-1", "ProviderTurnStarted", { provider: "fake", model: "fake/finleet", providerCallId: "run-1:turn-1", effectId: "effect-1" });
  const first = event("text-1", "ProviderText", { providerCallId: "run-1:turn-1", text: "The ", truncated: false });
  const second = event("text-2", "ProviderText", { providerCallId: "run-1:turn-1", text: "answer is 42.", truncated: false });
  const done = event("conclusion-1", "TaskConclusion", { runId: "run-1", outcome: "finished", summary: "Task completed" });

  const result = applyConversationEvent(projection, prompt);
  assert.ok(result);
  applyConversationEvent(projection, run);
  applyConversationEvent(projection, turn);
  applyConversationEvent(projection, first);
  applyConversationEvent(projection, second);
  applyConversationEvent(projection, done);

  assert.equal(projection.turns.length, 1);
  assert.equal(result.prompt, "Explain this result");
  assert.equal(result.response, "The answer is 42.");
  assert.equal(result.status, "completed");
});

test("conversation projection bounds retained turns and response text", () => {
  const projection = createConversationProjection();
  let latest: ReturnType<typeof applyConversationEvent>;
  for (let index = 0; index < 41; index += 1) {
    latest = applyConversationEvent(projection, event(`admit-${index}`, "PromptAdmitted", {
      promptId: `prompt-${index}`,
      prompt: "prompt",
      delivery: "queue",
    }));
  }
  assert.equal(projection.turns.length, 40);
  assert.equal(projection.byPromptId.has("prompt-0"), false);
  assert.ok(latest);
  const output = event("text-large", "ProviderText", {
    providerCallId: "unmapped:turn-1",
    text: "x".repeat(512),
    truncated: false,
  });
  for (let index = 0; index < 40; index += 1) applyConversationEvent(projection, output);
  assert.equal(latest.response.length, 16_384);
  assert.equal(latest.truncated, true);
});

test("provider failures are surfaced on the associated turn", () => {
  const projection = createConversationProjection();
  applyConversationEvent(projection, event("admit", "PromptAdmitted", { promptId: "p", prompt: "fail", delivery: "queue" }));
  applyConversationEvent(projection, event("run", "GraphRunStarted", { runId: "r", planId: "plan", planVersion: 1, planDigest: "digest", status: "running", inputEventId: "admit" }));
  applyConversationEvent(projection, event("started", "ProviderTurnStarted", { provider: "fake", model: "fake/finleet", providerCallId: "r:turn-1", effectId: "effect" }));
  const result = applyConversationEvent(projection, event("failed", "ProviderTurnFailed", { providerCallId: "r:turn-1", code: "PROVIDER_FAILED", message: "Provider unavailable" }));
  assert.equal(result?.status, "failed");
  assert.equal(result?.error, "Provider unavailable");
});

test("chat-clean keeps timestamps and folds tool events into safe activity labels", () => {
  const projection = createConversationProjection();
  const turn = applyConversationEvent(projection, event("admit", "PromptAdmitted", { promptId: "p", prompt: "inspect", delivery: "queue" }))!;
  applyConversationEvent(projection, event("call", "ToolCalled", { callId: "private-id", name: "bash", argumentsDigest: "digest", arguments: "secret command" }));
  applyConversationEvent(projection, event("done", "ToolSucceeded", { callId: "private-id", preview: "private path", truncated: false }));
  assert.equal(turn.promptAt, "2026-01-01T00:00:00.000Z");
  assert.equal(turn.activity.length, 1);
  assert.equal(turn.activity[0]?.state, "done");
  assert.equal(turn.activity[0]?.label, "Working");
  assert.doesNotMatch(JSON.stringify(turn.activity), /private-id|secret command|private path|bash/);
  assert.equal(formatFeedTime("invalid"), "--:--:--");
  assert.equal(validFeedMode("clean"), true);
  assert.equal(validFeedMode("other"), false);
});

test("chat-clean turns failures into timestamped recovery guidance", () => {
  const projection = createConversationProjection();
  applyConversationEvent(projection, event("admit", "PromptAdmitted", { promptId: "p", prompt: "fail", delivery: "queue" }));
  applyConversationEvent(projection, event("call", "ToolCalled", { callId: "c", name: "tool", argumentsDigest: "digest" }));
  const turn = applyConversationEvent(projection, event("failed", "ToolFailed", { callId: "c", code: "INTERNAL_CODE", message: "raw stack" }));
  assert.equal(turn?.activity[0]?.state, "error");
  assert.match(turn?.activity[0]?.detail ?? "", /permissions|retry/i);
  assert.doesNotMatch(JSON.stringify(turn?.activity), /INTERNAL_CODE|raw stack/);
});

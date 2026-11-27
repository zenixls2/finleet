import type { DurableEvent } from "finleet-core";

const MAX_TURNS = 40;
const MAX_RESPONSE_CHARS = 16_384;
const MAX_RUN_REFERENCES = 400;
const MAX_PROVIDER_REFERENCES = 1200;

export type ConversationStatus = "queued" | "running" | "completed" | "failed";
export type FeedMode = "clean" | "normal" | "raw";

export const feedModes: readonly FeedMode[] = ["clean", "normal", "raw"];
export const validFeedMode = (value: string): value is FeedMode => feedModes.includes(value as FeedMode);
export const formatFeedTime = (value: string): string => {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? "--:--:--" : date.toLocaleTimeString([], { hour12: false });
};

export interface FeedActivity {
  readonly id: string;
  readonly at: string;
  readonly label: string;
  readonly state: "running" | "done" | "error";
  readonly detail: string;
}

export interface ConversationTurn {
  readonly id: string;
  readonly promptId: string;
  readonly prompt: string;
  readonly promptAt: string;
  response: string;
  responseAt?: string;
  status: ConversationStatus;
  error?: string;
  truncated: boolean;
  readonly activity: FeedActivity[];
}

export interface ConversationProjection {
  readonly turns: ConversationTurn[];
  readonly byAdmissionEvent: Map<string, ConversationTurn>;
  readonly byPromptId: Map<string, ConversationTurn>;
  readonly byRunId: Map<string, ConversationTurn>;
  readonly byProviderCallId: Map<string, ConversationTurn>;
  readonly byToolCallId: Map<string, ConversationTurn>;
  active?: ConversationTurn;
}

export const createConversationProjection = (): ConversationProjection => ({
  turns: [],
  byAdmissionEvent: new Map(),
  byPromptId: new Map(),
  byRunId: new Map(),
  byProviderCallId: new Map(),
  byToolCallId: new Map(),
});

const boundedSet = (map: Map<string, ConversationTurn>, key: string, turn: ConversationTurn, limit: number): void => {
  map.set(key, turn);
  while (map.size > limit) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
};

const forgetTurn = (projection: ConversationProjection, turn: ConversationTurn): void => {
  for (const map of [projection.byAdmissionEvent, projection.byPromptId, projection.byRunId, projection.byProviderCallId, projection.byToolCallId]) {
    for (const [key, value] of map) if (value === turn) map.delete(key);
  }
  if (projection.active === turn) delete projection.active;
};

const runIdForProviderCall = (providerCallId: string): string | undefined => {
  const marker = providerCallId.indexOf(":turn-");
  return marker > 0 ? providerCallId.slice(0, marker) : undefined;
};

const findTurnForRun = (projection: ConversationProjection, runId: string): ConversationTurn | undefined =>
  projection.byRunId.get(runId) ?? projection.active;

/** Updates a bounded conversation projection and returns the affected prompt turn, if any. */
export const applyConversationEvent = (projection: ConversationProjection, event: DurableEvent): ConversationTurn | undefined => {
  switch (event.kind) {
    case "PromptAdmitted": {
      const turn: ConversationTurn = {
        id: event.id,
        promptId: event.data.promptId,
        prompt: event.data.prompt,
        promptAt: event.at,
        response: "",
        status: "queued",
        truncated: false,
        activity: [],
      };
      projection.turns.push(turn);
      boundedSet(projection.byAdmissionEvent, event.id, turn, MAX_TURNS);
      boundedSet(projection.byPromptId, turn.promptId, turn, MAX_TURNS);
      projection.active = turn;
      while (projection.turns.length > MAX_TURNS) {
        const removed = projection.turns.shift();
        if (removed !== undefined) forgetTurn(projection, removed);
      }
      return turn;
    }
    case "InputPromoted": {
      const turn = projection.byPromptId.get(event.data.promptId);
      if (turn === undefined) return undefined;
      turn.status = "running";
      projection.active = turn;
      return turn;
    }
    case "GraphRunStarted": {
      const turn = projection.byAdmissionEvent.get(event.data.inputEventId) ?? projection.active;
      if (turn === undefined) return undefined;
      boundedSet(projection.byRunId, event.data.runId, turn, MAX_RUN_REFERENCES);
      turn.status = "running";
      projection.active = turn;
      return turn;
    }
    case "ProviderTurnStarted": {
      const runId = runIdForProviderCall(event.data.providerCallId);
      const turn = runId === undefined ? projection.active : findTurnForRun(projection, runId);
      if (turn === undefined) return undefined;
      if (runId !== undefined) boundedSet(projection.byRunId, runId, turn, MAX_RUN_REFERENCES);
      boundedSet(projection.byProviderCallId, event.data.providerCallId, turn, MAX_PROVIDER_REFERENCES);
      turn.status = "running";
      projection.active = turn;
      return turn;
    }
    case "ProviderText": {
      const runId = runIdForProviderCall(event.data.providerCallId);
      const turn = projection.byProviderCallId.get(event.data.providerCallId)
        ?? (runId === undefined ? projection.active : findTurnForRun(projection, runId));
      if (turn === undefined) return undefined;
      const remaining = Math.max(0, MAX_RESPONSE_CHARS - turn.response.length);
      if (event.data.text.length > remaining) turn.truncated = true;
      turn.response += event.data.text.slice(0, remaining);
      turn.responseAt = event.at;
      turn.truncated ||= event.data.truncated;
      return turn;
    }
    case "ProviderTurnFailed": {
      const turn = projection.byProviderCallId.get(event.data.providerCallId)
        ?? (() => {
          const runId = runIdForProviderCall(event.data.providerCallId);
          return runId === undefined ? projection.active : findTurnForRun(projection, runId);
        })();
      if (turn === undefined) return undefined;
      turn.status = "failed";
      turn.error = event.data.message || event.data.code;
      turn.activity.push({ id: event.id, at: event.at, label: "Run stopped", state: "error", detail: "Check the connection or settings, then try again." });
      return turn;
    }
    case "ToolCalled": {
      const turn = projection.active;
      if (turn === undefined) return undefined;
      boundedSet(projection.byToolCallId, event.data.callId, turn, MAX_PROVIDER_REFERENCES);
      turn.activity.push({ id: event.id, at: event.at, label: "Working", state: "running", detail: "" });
      return turn;
    }
    case "ToolSucceeded": {
      const turn = projection.byToolCallId.get(event.data.callId) ?? projection.active;
      projection.byToolCallId.delete(event.data.callId);
      const activity = turn?.activity.findLast((item) => item.state === "running");
      if (turn === undefined || activity === undefined) return turn;
      turn.activity[turn.activity.indexOf(activity)] = { ...activity, state: "done" };
      return turn;
    }
    case "ToolFailed": {
      const turn = projection.byToolCallId.get(event.data.callId) ?? projection.active;
      projection.byToolCallId.delete(event.data.callId);
      const activity = turn?.activity.findLast((item) => item.state === "running");
      if (turn === undefined || activity === undefined) return turn;
      turn.activity[turn.activity.indexOf(activity)] = { ...activity, state: "error", detail: "Review the action and available permissions, then retry." };
      return turn;
    }
    case "TaskConclusion": {
      const turn = projection.byRunId.get(event.data.runId) ?? projection.active;
      if (turn === undefined) return undefined;
      turn.status = event.data.outcome === "finished" ? "completed" : "failed";
      turn.responseAt = event.at;
      if (turn.status === "failed") {
        turn.error = event.data.summary;
        turn.activity.push({ id: event.id, at: event.at, label: "Run stopped", state: "error", detail: "Review the recent activity, then retry the task." });
      }
      return turn;
    }
    default:
      return undefined;
  }
};

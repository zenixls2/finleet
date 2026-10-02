# Finleet Implementation Guild

This document is the implementation contract for an LLM building Finleet's agent
runtime. It extracts the useful boundaries from the current OpenCode design and
turns them into an implementation plan. Read the **current design** sections as
source-grounded facts. Read the **Finleet design** sections as proposed work;
they are not claims about features that already exist in OpenCode.

## 0. Mission and operating rules

The runtime must make a request durable, execute it through explicit provider
turns, execute local tools safely, and leave a replayable record of what
happened. The model is not the source of truth: durable state, typed schemas,
authorization, and observable transitions are.

When implementing a feature, an LLM should:

1. Find the owning state machine before editing a call site.
2. Define or update the schema and event transition before adding orchestration.
3. Keep admission, execution ownership, provider transport, and tool execution
   as separate layers.
4. Use one explicit provider stream per provider turn.
5. Reload projected history before continuing after a tool call or new input.
6. Preserve typed errors and typed tool inputs/outputs; never use `any` or type
   suppression to cross a boundary.
7. Add a replayable test for every new durable transition and a failure test for
   every retry, interruption, or authorization branch.

Do not implement a second in-memory agent loop beside the canonical runner.
Do not let a graph engine bypass persistence, permissions, provider resolution,
or the tool registry.

### Bounded background-agent MVP

**CURRENT (`src/background.ts`, `src/runtime.ts`, `src/tui.ts`):** A primary
local fake-provider primary session may invoke the typed background-agent control tools. Admission writes
parent-child lineage before an independent child session is queued; the child
uses the canonical `Runner`, an independent session lease, and the resolved
primary provider rather than a recursive CLI loop or alternate transport.
Only the allowlisted `read-only-research` profile is available. It has no
spawning tools and only paper `market:read`; parent permissions are not
transitive. Parent tool-call identities are idempotent, ownership checks apply
to every control operation, output/snapshots are redacted and bounded, and
unknown claimed child work remains recovery-required. The TUI approval broker
queues child and foreground permission requests FIFO and rejects pending work
at shutdown. This MVP is bounded to two children per parent, four active
globally per scheduler, eight queued, depth one, one turn, and 30 seconds.

**DEFERRED:** Remote workers, arbitrary profiles/system prompts, recursive
spawning, write capabilities, arbitrary provider-local execution, live child
transcript injection, sandboxing, trading, and multi-tenant scheduling.

### Status and evidence notation

Every architecture statement in future Finleet design records MUST be labeled
`CURRENT`, `NORMATIVE`, `PROPOSED`, `DEFERRED`, or `UNKNOWN`.

- `CURRENT` means observed in OpenCode source or tests and MUST include a
  repository-relative evidence path and symbol/test reference.
- `NORMATIVE` means required by this guild, even if Finleet has not implemented
  it yet.
- `PROPOSED` means a candidate Finleet design and must never be described as an
  existing OpenCode feature.
- `DEFERRED` means intentionally not implemented; `UNKNOWN` means evidence is
  insufficient and requires investigation.

The authority order is implementation/tests for observed behavior, OpenCode
`specs/v2/*` for normative session contracts, and `specs/v2/todo.md` for known
gaps. If sources disagree, record the conflict and investigate; do not silently
merge the claims. OpenCode's `parentID` is lineage metadata, not evidence of a
general graph scheduler.

## 1. Current OpenCode design: source map

The relevant implementation is split across packages. Paths below are relative
to the OpenCode repository at `/Users/hanshenghuang/src/opencode`.

| Responsibility | Primary implementation |
| --- | --- |
| Public session API and admission boundary | `packages/core/src/session.ts` (`SessionV2`) |
| Durable inbox, retry reconciliation, steer/queue promotion | `packages/core/src/session/input.ts` |
| Input schema and delivery modes | `packages/schema/src/session-input.ts` |
| Durable event projection | `packages/core/src/session/projector.ts` |
| Provider-visible history reload | `packages/core/src/session/history.ts` |
| Process-global execution service | `packages/core/src/session/execution.ts` |
| Local placement and runner invocation | `packages/core/src/session/execution/local.ts` |
| Per-session serialization and wake coalescing | `packages/core/src/session/run-coordinator.ts` |
| V2 execution boundary | `packages/core/src/session/runner/index.ts` |
| V2 provider-turn loop | `packages/core/src/session/runner/llm.ts` |
| Location-scoped model/provider resolution | `packages/core/src/session/runner/model.ts` |
| Projected messages to canonical LLM messages | `packages/core/src/session/runner/to-llm-message.ts` |
| Canonical provider request and one-turn stream | `packages/llm/src/llm.ts` |
| Provider wire protocols and transport | `packages/llm/src/route/protocol.ts` |
| Typed local tool definition and settlement | `packages/core/src/tool/tool.ts` |
| Tool materialization and stale-registration checks | `packages/core/src/tool/registry.ts` |
| Tool registration producers | `packages/core/src/tool/tools.ts`, `application-tools.ts` |
| Bounded retained tool output | `packages/core/src/tool-output-store.ts` |
| Typed one-call dispatch only | `packages/llm/src/tool-runtime.ts` |
| Bounded workflow-style execution precedent | `packages/codemode/src/codemode.ts`, `tool-runtime.ts` |
| HTTP session adapter | `packages/server/src/handlers/session.ts` |
| HTTP contract | `packages/protocol/src/groups/session.ts` |

The old compatibility path under `packages/opencode/src/session/llm/*` and
`packages/opencode/src/session/prompt.ts` is not the V2 orchestration authority.
In particular, do not bridge the new runner through the legacy monolithic
`SessionPrompt.runLoop`.

OpenCode's current V2 runner still has unfinished areas around durable status,
bounded repeated-call retries, cancellation/context settlement, and some
continuation maintenance. Treat those as Finleet requirements or explicit
proposals, not as guarantees already provided by OpenCode. The stream and
history-reload rules above are the narrower source-grounded boundaries.

## 2. Core loop

### 2.1 Two planes, not one loop

**Admission plane**

```text
client -> protocol -> server handler -> SessionV2.prompt
       -> SessionInput.admit -> durable PromptAdmitted event
       -> projector -> advisory SessionExecution.wake(sessionID)
```

Admission records intent. It does not call the model. `resume: false` admits
without waking execution. Reusing a prompt ID is an exact retry only when the
session, prompt, and delivery mode match; conflicting reuse fails.

**Execution plane**

```text
SessionExecution.wake(sessionID)
  -> discover Location
  -> SessionRunCoordinator (one active drain per session)
  -> SessionRunner.run
  -> one or more explicit provider turns
```

`SessionExecution` is process-global and addressed by session ID. The runner,
model, permissions, tools, and filesystem are Location-scoped. Different
sessions may run concurrently; same-session wakes join/coalesce instead of
creating competing model loops.

### 2.2 Provider-turn algorithm

The following is implementation pseudocode, not a copy of a concrete function:

```text
run(sessionID):
  fail abandoned pending/running local tools
  while the current drain requires continuation:
    capture eligible steer inputs, or promote one queued input only at idle
    reload projected history
    resolve Location-scoped agent, model, context epoch, and tools
    convert history into canonical LLM messages
    build one canonical LLM request
    stream exactly once: llm.stream(request)
    publish durable text/reasoning/step/tool lifecycle events
    dispatch only locally-owned tool calls
    await all local tool fibers and settle success/failure
    if overflow: compact through a transition and retry safely
    reload projected history before the next provider turn
```

Each `llm.stream(request)` is one provider turn. A continuation is a new turn,
not more work hidden inside the prior stream. A steer is promoted at the next
safe boundary while continuation is required. A queued input stays pending
until the drain would otherwise become idle; promote one item, then reevaluate.
Promoting new user input resets the selected agent's provider-turn allowance.

Interruption targets the active process-local ownership chain. Interruption of
an idle or missing chain is a no-op. Crash continuation is not implied by an
advisory wake; implement it as a separate, explicit recovery design.

### 2.3 Why history must be reloaded

Tool settlement, user-input promotion, compaction, and event projection can
change the durable view while a turn is finishing. The next turn therefore
reads projected history rather than appending to an in-memory message array.
This makes retries and replay converge on the same provider-visible sequence.

### 2.4 Stable invariant catalog

Use these IDs in code reviews, graph nodes, proposals, and tests:

| ID | Rule |
| --- | --- |
| `INV-ADMISSION-DURABLE` | Admit input durably before scheduling execution. |
| `INV-EXECUTION-SERIAL` | At most one active drain owns a session at a time. |
| `INV-TURN-ONE-STREAM` | One provider turn performs one explicit provider stream. |
| `INV-HISTORY-PROJECTED` | Reload projected history before durable continuation. |
| `INV-TOOLS-TYPED` | Decode inputs and encode outputs through typed tool contracts. |
| `INV-TOOLS-AUTHORIZED` | A tool implementation authorizes execution independently of registry visibility. |
| `INV-TOOLS-NO-DUPLICATE` | Never locally dispatch a provider-executed tool call. |
| `INV-EFFECT-CLAIMED` | Claim/reconcile external effects before retrying them. |
| `INV-REPLAY-RECORDED` | Default replay uses recorded outcomes and no live side effects. |
| `INV-PLAN-IMMUTABLE` | Published plan versions are immutable and runs remain pinned. |

When a proposal changes one of these rules, it must name the affected IDs,
provide replacement evidence, and show why the safety property is preserved.

## 3. Provider integration

Provider selection belongs to a Location-scoped model resolver, not to the
session API and not to tools. The resolver should:

- select catalog/provider/model information and variants;
- resolve credentials without exposing secrets to the model;
- construct endpoint, headers, body, limits, and provider options;
- remove credentials from request bodies;
- map the model to a supported wire route (for example Anthropic Messages,
  OpenAI Responses, or compatible Chat);
- return typed provider/model errors.

The canonical request should contain system content, projected messages,
typed tool definitions, tool choice, generation settings, HTTP configuration,
and provider options. The route layer owns framing, authentication, streaming,
and transport. The session runner owns when a turn begins and ends; the route
must not decide session continuation.

Provider adapters must normalize provider-specific events into a small internal
event vocabulary. Preserve provider call IDs, usage, finish reasons, and errors
as structured data. Never infer completion from display text. Provider-executed
tools are passed through and must not be dispatched again locally.

## 4. Tool-call infrastructure

The canonical path is:

```text
materialize registry -> advertise typed definition -> provider tool call
  -> durable Called -> local decode -> leaf authorization -> execute
  -> durable Success or Failed -> projected result -> next provider turn
```

Every tool definition needs typed input decoding, an execution context, typed
output encoding, and a terminal settlement. The context should identify at
least session ID, agent, assistant message ID, and provider tool-call ID.

`ToolRegistry` is responsible for Location-scoped materialization, visibility
filters, registration identity, output bounding, and settlement. It is not a
generic execution-authorization engine. Canonical tool implementations enforce
execution authorization through their captured permission services. A stale
registration must fail rather than invoke a replaced implementation.

Tool output is both bounded and retained. Large output should be stored behind
a managed reference with a bounded preview, so the model receives useful data
without making the transcript unbounded. Tool progress is a durable semantic
checkpoint; terminal success/failure is replayable. Before a new run, abandoned
pending/running local calls become durable failures.

The one-call tool runtime is deliberately smaller than the session runtime: it
decodes and dispatches one typed call. It must not persist history, approve
access, schedule continuation, or implement a second loop.

## 5. Finleet graph design

OpenCode currently has no general durable graph engine. Codemode demonstrates
useful bounded execution ideas—catalog discovery, explicit programs, limits,
timeouts, supervised fibers, hooks, bounded parallelism, and a safe-data
boundary—but it is not durable or replayable. Finleet should use those ideas
without confusing them with the session state machine.

### 5.1 Graph placement

Place the graph transition layer after durable admission and execution ownership,
but before individual provider/tool operations:

```text
SessionInput/EventLog
  -> SessionExecution/RunCoordinator
  -> GraphPlan + GraphRuntime
     -> provider-turn node (one stream)
     -> tool node (registry + settlement)
     -> context/history node
     -> compaction/retry node
  -> projector/history
```

The graph may choose the next operation and record why. It must not replace
admission, event durability, execution ownership, model resolution, permissions,
the tool registry, or history reload. Graph nodes are orchestration units; they
are not alternate implementations of those services.

### 5.2 Minimal durable graph model

Start with versioned, append-only records:

```text
GraphPlan {
  plan_id, version, content_digest, session_scope, entry_node,
  activation_state, validation_ref, evaluation_ref,
  nodes: [{node_id, kind, config}],
  edges: [{from, outcome, to}],
  limits: {max_turns, max_cost, max_parallelism, timeout}
}

GraphRun {
  run_id, session_id, plan_id, plan_version,
  status, current_node, input_event_id, started_at
}

GraphTransition {
  transition_id, run_id, sequence, node_id,
  attempt_id, input_digest, outcome, output_ref, event_ids, duration, cost
}

EffectRecord {
  effect_id, attempt_id, kind, request_digest,
  state, provider_call_id, result_ref, retry_policy
}
```

The actual implementation must define schemas before persistence. `attempt_id`
is distinct from `transition_id`: a transition may be retried, but an effect
must be claimed atomically by its effect key before invoking a provider or
external tool. Durable event deduplication alone does not prevent duplicate
external side effects. Store digests/references rather than copying secrets or
unbounded provider payloads.

A provider call or external tool must declare one of these policies before it
can be a graph effect: idempotent retry with a stable request key, compensation
on failure, or non-retryable execution requiring reconciliation. Provider retry
boundaries are explicit; a network timeout does not prove that the provider
did not execute. Local tool calls need the same policy, especially for writes.
At-most-once, at-least-once, and recorded-outcome semantics must be named rather
than implied.

Plan versions are immutable. Activation is an atomic state transition from
validated/evaluated to active or rejected and must link the content digest,
validation result, evaluation result, and approval policy. A `GraphRun` pins
its plan version for its entire lifetime; a later admission may select a newer
active version without changing an existing run.

Required node kinds for the first implementation:

- `provider_turn`: resolves a model and calls `llm.stream` once;
- `tool_call`: invokes only an authorized local registry tool;
- `history_reload`: obtains the projected provider view;
- `decision`: evaluates typed state, with a bounded set of outcomes;
- `finish`: closes the graph run.

Compaction, interruption, and retry should be explicit outcomes or transitions,
not hidden exception paths.

### 5.3 Recovery and replay contract

Graph ownership is separate from event replay ownership. A coordinator claims a
run transition with a lease or compare-and-set, commits the transition and its
durable event references atomically, and renews ownership while a node runs.
Lease expiry produces an `interrupted` attempt; it does not automatically
re-execute an unknown provider or external effect.

On restart, recovery reads the last committed transition and each
`EffectRecord`:

1. recorded success/failure is reused without invoking the effect again;
2. an uncommitted effect is reconciled by provider/tool-specific policy;
3. an unknown non-idempotent effect becomes terminal/requires operator
   reconciliation;
4. only a safely retryable effect may be claimed by a new owner.

Default replay is **recorded-outcome replay**: it rebuilds projections and
decision inputs from stored outcomes and does not call live providers or tools.
Live re-execution is a separate, explicitly labeled evaluation mode with
isolated credentials, side-effect protection, and a budget. This distinction is
required because provider outputs and external systems are nondeterministic.

### 5.4 Self-improvement without uncontrolled mutation

“Self-improving” means the system can propose and validate a better graph plan;
it does not mean the model can silently rewrite the active runtime. Use this
closed loop:

```text
observe run metrics/events
  -> diagnose a bounded bottleneck
  -> propose a new immutable plan version
  -> statically validate schema, reachability, limits, and permissions
  -> replay historical fixtures
  -> run deterministic conformance tests
  -> canary under budget and approval policy
  -> compare quality, latency, cost, failure, and safety metrics
  -> promote or reject; retain rollback to prior version
```

The proposer may edit graph data, not executable tool/provider code. Promotion
requires a human or explicitly configured policy, and every plan version must
have an evaluation record. Improvements are accepted only when they satisfy
hard safety invariants and meet declared metric thresholds; a quality gain that
increases unauthorized calls, unbounded cost, or unreplayable behavior is a
regression.

The evaluator should test at least:

- recorded-outcome replay produces the same state-transition shape without live
  provider/tool calls;
- duplicate delivery does not duplicate durable side effects;
- provider turns, tool calls, and approvals remain correctly ordered;
- interruption and timeout settle active work;
- limits stop cycles, parallelism, token/cost growth, and output growth;
- provider-executed tools are never locally executed;
- rejected plans cannot become active;
- expired ownership cannot cause an unknown effect to run twice.

### 5.5 Evidence graph for this guild

The implementation guild itself should maintain an evidence graph separate from
the runtime graph. Its node types are `Invariant`, `Component`, `Contract`,
`Event`, `State`, `Test`, `Decision`, `Risk`, and `Proposal`. Useful edges are
`owns`, `depends_on`, `reads`, `writes`, `projects_to`, `validates`,
`contradicts`, `supersedes`, and `proposes_change_to`.

Each node MUST carry `id`, `type`, `status`, `description`, `evidence`, related
invariant IDs, validation command, and `last_verified`. A self-improvement
proposal may update only `PROPOSED` nodes until source checks, targeted tests,
and review promote it. The graph is improved monotonically: zero broken
evidence paths, zero unsupported `CURRENT` claims, zero contradictions, and
100% evidence coverage for current invariants are promotion gates. This is the
safe way for an LLM to improve its implementation understanding without
hallucinating a runtime graph into existence.

## 6. Implementation sequence for Finleet

Implement in this order so each layer has a verifiable boundary:

1. Define schemas for session input, durable events, projected history, provider
   requests, tool calls, and typed errors.
2. Implement append-only admission and projection; test exact retry and replay.
3. Implement process-local execution ownership and per-session serialization.
4. Implement a provider route with one-turn streaming and event normalization.
5. Implement the typed tool registry, authorization boundary, output store, and
   terminal settlement.
6. Implement the runner loop with history reload between turns, steer/queue
   semantics, interruption, and compaction.
7. Add the minimal durable graph model as a coordinator around those primitives.
8. Add plan validation, fixture replay, metrics, canarying, and rollback before
   enabling self-improvement.

At every step, keep the happy path obvious and keep recovery paths explicit.
Do not optimize by collapsing durable transitions into local mutable state.

## 7. Definition of done

A feature is complete only when:

- its owning layer and schema/event transitions are documented;
- its normal path and failure path are typed and observable;
- modified code has zero language-server errors;
- package typecheck, build, and related tests pass from the package directory;
- replay, retry, interruption, authorization, and output-limit behavior are
  tested where applicable;
- no second orchestration loop, provider bypass, local execution of provider
  tools, secret leakage, or type suppression was introduced.

Useful OpenCode reference tests are:

- `packages/core/test/session-prompt.test.ts`
- `packages/core/test/session-run-coordinator.test.ts`
- `packages/core/test/session-runner-recorded.test.ts`
- `packages/core/test/session-tool-progress.test.ts`
- `packages/schema/test/event-manifest.test.ts`

These tests are references for behavior and coverage, not a requirement to copy
OpenCode's implementation or test framework wholesale.

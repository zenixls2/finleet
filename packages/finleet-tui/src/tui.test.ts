import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createInterface } from "node:readline/promises";
import { PassThrough } from "node:stream";
import { Jimp } from "jimp";
import { activityFooterFrame, applyGraphicFallbackMasks, boundImageRows, cancelSelectionOnClick, clampHistoryScrollOffset, clipboardCommands, composeReadlineFrame, consumePermissionRelease, consumeTerminalCellPixelResponses, containsInterrupt, containsQuitSubmission, createDeferredImagePainter, createFrameScheduler, createPermissionSessionCache, createTuiInteractionState, expandHomePath, extractSelection, extractTerminalLinks, findChartSurfacePlacement, footerFrame, hasSupportedTerminalWidth, harnessFlows, harnessGroups, hitTestHarnessRow, hitTestTerminalLink, imagePreviewContentRow, imagePreviewLines, imagePreviewStartRow, inputAreaLines, inputHistoryDirection, kittyChartPlacementKey, kittyPreviewPlacementKey, latexFallbackMasks, reconcileKittyPlacements, mergeDurableEvents, navigateInputHistory, nativeImageData, nativeImageGeometry, normalizeSelection, offsetPermissionButtons, openTerminalLink, parseMouseClick, parseMouseEvents, parseMouseRow, parseMouseWheel, parsePermissionSuggestion, parseTerminalCellPixelSize, permissionDecisionForKey, permissionHitTest, permissionInputTokens, permissionMouseChoice, prepareMouseInput, pinFooter, pinFooters, promptBoards, ReadlineOutputCapture, reconcileHiddenImageScrollOffset, renderAssistantCanvas, renderConsolePrompt, renderCopyPopup, renderHarnessPanel, renderMarkdown, renderPermissionCard, renderPromptBoard, renderPromptHistory, renderSettings, renderStatusBar, renderThinkingEffort, restoreLatexSources, safeHttpUrl, scrollHarness, scrollHistory, scrollHistoryOnWheel, sessionInputHistory, shouldArchiveImagePreview, shouldFollowHarnessThinking, shouldNavigateInputHistory, shouldQueueMouseAfterSubmittedLine, shouldShowImagePreview, shouldRenderSubmittedPrompt, shutdownTerminalFrame, splitMouseInput, splitMouseInputAfterSubmittedLine, splitReadlineInput, stripMouseSequences, summarizeTokenUsage, synchronizedTerminalFrame, terminalCellWidth, terminalWidth, thinkingFrame, toggleHarnessFlow, tuiPalette, visibleHarnessItems, visibleImagePreviewRows, visiblePermissionButtons, writeClipboardText, writeTerminalFrame, commitPermissionBeforeBufferedInput, chartFallbackMasks, findLatexFallbackSurface, visibleLatexFallbackSurfaces } from "./tui.js";
import { digest, MAX_TOOL_RESULT, type DurableEvent, type PermissionRequest } from "finleet-core";
import { activateAgentPanelButton, cacheSessionEvent, dispatchHistoryWheel, hitTestAgentPanelButton, isCurrentSessionSwitch, mergeSessionEventCache, navigateHistory, offsetAgentPanelButtons, reconcileHistoryNavigation, renderAgentsPanel, sessionEventsFromCache, shouldHandleMouseDuringExecution, visibleAgentPanelButtons } from "./tui.js";
import { activateOverlayButton, clipOverlayRender, hitTestOverlayButton, offsetOverlayButtons, renderHelp, routeBareEscape, visibleOverlayButtons } from "./tui.js";
import { canPlaceLatexGraphic, kittyLatexPlacementKey, latexGraphicRenderKey, latexGraphicRowBudget, nativeLatexGraphicCandidates, placeIterm2Frame, shouldApplyGraphicRender } from "./tui.js";
import { reconcileKittyPlacementsBeforePaint } from "./tui.js";
import { promptDelivery, sessionHasPendingExecution } from "./tui.js";
import { navigatePromptCursor, prepareShiftEnterInput } from "./tui.js";
import { renderLatexGraphic } from "./latex-graphics.js";
import { renderChartSurface } from "./components/chart.js";
import { chartGraphicRenderKey, deriveChartHitBoxes, dispatchChartHoverMotion, formatChartHoverFeedback, hitTestChartScreen, reconcileChartHoverAtPointer, reconcileChartHoverTarget, reduceChartHover, routeChartHoverMotion, runTuiCleanup, selectActivityFeedback, startTerminalMouseFrame, startTuiWithTerminal, translateChartSurfaceHitBoxes, type ChartHoverTarget, type TuiTerminalInput, type TuiTerminalOutput } from "./tui.js";
import { isPermissionAdmissionLocallyResolved, transitionPermissionQueue } from "./tui.js";
import type { TuiClient } from "./tui-client.js";

const event = (kind: DurableEvent["kind"], data: DurableEvent["data"], id = `${kind}-1`, sessionId = "session-1"): DurableEvent => ({ schemaVersion: 1, id, sessionId, kind, at: "2026-01-01T00:00:00.000Z", data } as DurableEvent);

class FakeTerminalInput extends EventEmitter implements TuiTerminalInput {
  public readonly isTTY = true;
  public isRaw = false;
  public readonly rawModeCalls: boolean[] = [];
  public pauseCalls = 0;
  public failRestoreOnCall: number | undefined;

  public setRawMode(mode: boolean): void {
    this.rawModeCalls.push(mode);
    if (!mode && this.failRestoreOnCall !== undefined && this.rawModeCalls.filter((call) => call === false).length >= this.failRestoreOnCall) throw new Error("raw restore failed");
    this.isRaw = mode;
  }

  public pause(): void { this.pauseCalls += 1; }
  public emitData(value: string): void { this.emit("data", value); }
}

class FakeTerminalOutput extends EventEmitter implements TuiTerminalOutput {
  public readonly isTTY = true;
  public readonly columns = 80;
  public readonly rows = 32;
  public readonly imageCapabilities = { kitty: false, iterm2: false, sixel: false };
  public readonly writes: string[] = [];
  public failNextWrite = false;

  public write(text: string): boolean {
    if (this.failNextWrite) {
      this.failNextWrite = false;
      throw new Error("startup output failed");
    }
    this.writes.push(text);
    return true;
  }
}

class FakeTuiClient implements TuiClient {
  public readonly events: readonly DurableEvent[];
  public readonly submissions: Array<Parameters<TuiClient["submit"]>[0]> = [];
  public removeEventThrows = false;
  private eventListener: ((event: DurableEvent) => void) | undefined;

  public constructor(events: readonly DurableEvent[] = []) { this.events = events; }
  public async subscribe(_sessionId: string): Promise<readonly DurableEvent[]> { return this.events; }
  public async listAgents(_sessionId: string): Promise<readonly never[]> { return []; }
  public async submit(input: Parameters<TuiClient["submit"]>[0]): Promise<{ exitCode: 0 | 2; body: unknown }> { this.submissions.push(input); return { exitCode: 0, body: "" }; }
  public async cancel(_sessionId: string): Promise<boolean> { return false; }
  public async respondPermission(_requestId: string, _decision: Parameters<TuiClient["respondPermission"]>[1]): Promise<void> {}
  public onEvent(listener: (event: DurableEvent) => void): () => void {
    this.eventListener = listener;
    return () => {
      if (this.removeEventThrows) throw new Error("unsubscribe failed");
      this.eventListener = undefined;
    };
  }
  public onPermission(_listener: Parameters<TuiClient["onPermission"]>[0]): () => void { return () => undefined; }
  public async close(): Promise<void> {}
  public emit(event: DurableEvent): void { this.eventListener?.(event); }
}

const settleTui = async (): Promise<void> => {
  await new Promise<void>((resolve) => setTimeout(resolve, 40));
  await new Promise<void>((resolve) => setImmediate(resolve));
};

const chartLifecycleEvents = (): readonly DurableEvent[] => {
  const chartResult = JSON.stringify({ kind: "line-chart", title: "FIN", points: [{ label: "open", value: 10 }, { label: "close", value: 14 }] });
  return [
    event("PromptAdmitted", { promptId: "prompt-1", prompt: "show chart", delivery: "queue" }, "admit-1", "chart-integration"),
    event("InputPromoted", { promptId: "prompt-1", delivery: "queue", reason: "queue-idle" }, "promote-1", "chart-integration"),
    event("ToolCalled", { callId: "chart-call", name: "render_chart", argumentsDigest: "digest", arguments: "{}" }, "call-1", "chart-integration"),
    event("ToolSucceeded", { callId: "chart-call", preview: chartResult, truncated: false, result: chartResult, resultTruncated: false }, "result-1", "chart-integration"),
    event("TaskConclusion", { runId: "run-1", outcome: "finished", summary: "done" }, "done-1", "chart-integration"),
  ];
};

test("subscription snapshot merges buffered durable events without duplicates", () => {
  const snapshot = event("PromptAdmitted", { promptId: "one", prompt: "first", delivery: "queue" }, "one");
  const raced = event("ProviderTurnStarted", {
    provider: "fake",
    model: "finleet",
    providerCallId: "call",
    effectId: "effect",
  }, "two");
  const merged = mergeDurableEvents([snapshot, raced], [raced]);
  assert.deepEqual(merged.map((item) => item.id), ["one", "two"]);
});

test("live agents panel retains background indices, sanitizes text, and stays width-bounded", () => {
  const lines = renderAgentsPanel("main\x1b[31m", [{ index: 2, agentId: "agent\x1b[31m", childSessionId: "child\nnext", status: "running" }], "idle", 24).lines;
  const plain = lines.map(stripAnsi).join("\n");
  assert.match(plain, /\[0\] main main/);
  assert.match(plain, /\[2\] background agent/);
  assert.doesNotMatch(plain, /\x1b|child\nnext/);
  assert.equal(lines.every((line) => stripAnsi(line).length <= 24), true);
  assert.equal(renderAgentsPanel("main", [], "idle", 24).lines.map(stripAnsi).join("\n").includes("[0] main main idle"), true);
});

test("agent panel hitboxes target rows, exclude clipped rows, and require same-row release", () => {
  const panel = renderAgentsPanel("main", [
    { index: 1, agentId: "first", childSessionId: "child-1", status: "running" },
    { index: 2, agentId: "second", childSessionId: "child-2", status: "queued" },
  ], "idle", 80);
  assert.deepEqual(panel.buttons.map((button) => button.action), [
    { type: "session", sessionId: "main" },
    { type: "session", sessionId: "child-1" },
    { type: "session", sessionId: "child-2" },
    { type: "back-to-compose" },
  ]);
  const screenButtons = offsetAgentPanelButtons(panel.buttons, 4);
  assert.equal(visibleAgentPanelButtons(screenButtons, 6, 6).length, 1);
  assert.equal(visibleAgentPanelButtons(screenButtons, 6, 5).length, 0);
  const button = screenButtons[1];
  assert.ok(button !== undefined);
  assert.deepEqual(hitTestAgentPanelButton(button.row, button.left, screenButtons)?.action, { type: "session", sessionId: "child-1" });
  assert.deepEqual(activateAgentPanelButton(button, { action: "release", button: 0, row: button.row, column: button.left }, false), { type: "session", sessionId: "child-1" });
  assert.equal(activateAgentPanelButton(button, { action: "release", button: 0, row: button.row + 1, column: button.left }, false), undefined);
  assert.equal(activateAgentPanelButton(button, { action: "release", button: 0, row: button.row, column: button.left }, true), undefined);
});

test("every overlay exposes a bounded back-to-compose button with shared hit semantics", () => {
  const settings = { provider: "fake", model: "finleet", agent: "primary" as const, thinking: true, thinkingEffort: "high" as const, details: false, journal: "/tmp/finleet.jsonl", contextWindow: 128_000 };
  const overlays = [renderHelp(44), renderSettings(settings, 44), renderAgentsPanel("main", [], "idle", 44)];
  for (const rendered of overlays) {
    const button = rendered.buttons.at(-1);
    assert.ok(button !== undefined);
    assert.deepEqual(button.action, { type: "back-to-compose" });
    assert.equal(stripAnsi(rendered.lines[button.row - 1] ?? "").includes("[ESC] BACK TO COMPOSE"), true);
    assert.equal(rendered.lines.at(-1)?.includes("┘"), true);
    assert.equal(rendered.lines.every((line) => stripAnsi(line).length <= 44), true);

    const offset = offsetOverlayButtons([button], 7);
    assert.equal(visibleOverlayButtons(offset, button.row + 7, button.row + 7).length, 1);
    assert.equal(visibleOverlayButtons(offset, button.row + 8, button.row + 8).length, 0);
    assert.equal(hitTestOverlayButton(button.row + 7, button.left, offset)?.action.type, "back-to-compose");
    assert.deepEqual(activateOverlayButton(button, { action: "release", button: 0, row: button.row, column: button.left }), { type: "back-to-compose" });
    assert.equal(activateOverlayButton(button, { action: "release", button: 0, row: button.row, column: button.right + 1 }), undefined);
    assert.equal(activateOverlayButton(button, { action: "release", button: 0, row: button.row, column: button.left }, true), undefined);
  }
});

test("overlay clipping keeps narrow help actions visible and remaps the back row", () => {
  const help = renderHelp(20);
  const clipped = clipOverlayRender(help, 3);
  assert.equal(clipped.lines.length, 3);
  assert.match(stripAnsi(clipped.lines[0] ?? ""), /COMMANDS \/\/ HEL/);
  assert.match(stripAnsi(clipped.lines[1] ?? ""), /\[ESC\] BACK TO CO/);
  assert.match(stripAnsi(clipped.lines[2] ?? ""), /┘/);
  assert.deepEqual(clipped.buttons.map((button) => ({ action: button.action, row: button.row })), [{ action: { type: "back-to-compose" }, row: 2 }]);
  const button = clipped.buttons[0];
  assert.ok(button !== undefined);
  assert.deepEqual(hitTestOverlayButton(2, button.left, clipped.buttons)?.action, { type: "back-to-compose" });
  assert.deepEqual(activateOverlayButton(button, { action: "release", button: 0, row: 2, column: button.left }), { type: "back-to-compose" });
});

test("overlay clipping handles tiny viewports without stale hitboxes", () => {
  const help = renderHelp(32);
  assert.deepEqual(clipOverlayRender(help, 0), { lines: [], buttons: [] });
  const oneRow = clipOverlayRender(help, 1);
  assert.equal(oneRow.lines.length, 1);
  assert.match(stripAnsi(oneRow.lines[0] ?? ""), /COMMANDS \/\/ HELP/);
  assert.deepEqual(oneRow.buttons, []);
  const twoRows = clipOverlayRender(help, 2);
  assert.equal(twoRows.lines.length, 2);
  assert.match(stripAnsi(twoRows.lines[1] ?? ""), /\[ESC\] BACK TO COMPOSE/);
  assert.equal(twoRows.buttons.length, 1);
  assert.equal(twoRows.buttons[0]?.row, 2);
});

test("overlay clipping drops clipped agent rows and remaps retained session rows", () => {
  const agents = renderAgentsPanel("main", [
    { index: 1, agentId: "first", childSessionId: "child-1", status: "running" },
    { index: 2, agentId: "second", childSessionId: "child-2", status: "queued" },
  ], "idle", 60);
  const clipped = clipOverlayRender(agents, 4);
  assert.deepEqual(clipped.buttons.map((button) => ({ action: button.action, row: button.row })), [
    { action: { type: "session", sessionId: "main" }, row: 2 },
    { action: { type: "back-to-compose" }, row: 3 },
  ]);
  assert.equal(hitTestOverlayButton(2, 1, clipped.buttons)?.action.type, "session");
  assert.equal(hitTestOverlayButton(3, 3, clipped.buttons)?.action.type, "back-to-compose");
  assert.equal(clipped.buttons.some((button) => button.action.type === "session" && button.action.sessionId === "child-1"), false);
  assert.equal(clipped.buttons.some((button) => button.action.type === "session" && button.action.sessionId === "child-2"), false);
  assert.equal(new Set(clipped.buttons.map((button) => button.row)).size, clipped.buttons.length);
});

test("bare Escape routing gives permission priority and does not consume escape sequences", () => {
  assert.equal(routeBareEscape("\x1b", true, true), "permission");
  assert.equal(routeBareEscape("\x1b", false, true), "overlay");
  assert.equal(routeBareEscape("\x1b", false, false), "readline");
  assert.equal(routeBareEscape("\x1b[A", false, true), "sequence");
  assert.equal(routeBareEscape("\x1bOP", false, true), "sequence");
  assert.equal(routeBareEscape("\x1b[<0;4;2M", false, true), "sequence");
});

test("session event cache preserves per-session history and snapshot-before-live ordering", () => {
  const cache = new Map<string, DurableEvent[]>();
  const snapshot = event("PromptAdmitted", { promptId: "one", prompt: "one", delivery: "queue" }, "one", "main");
  const live = event("ProviderTurnStarted", { provider: "fake", model: "fake", providerCallId: "call", effectId: "effect" }, "two", "main");
  cacheSessionEvent(cache, live);
  mergeSessionEventCache(cache, "main", [snapshot]);
  cacheSessionEvent(cache, live);
  assert.deepEqual(sessionEventsFromCache(cache, "main").map((item) => item.id), ["one", "two"]);
  assert.equal(cache.get("main")?.length, 2);
  assert.deepEqual(sessionEventsFromCache(cache, "child"), []);
  assert.equal(isCurrentSessionSwitch(4, 4), true);
  assert.equal(isCurrentSessionSwitch(4, 3), false);
});

const stripAnsi = (text: string): string => text.replace(/\x1b\](?:(?!\x07|\x1b\\|\x9c)[\s\S])*(?:\x07|\x1b\\|\x9c|$)|\x1b\[[0-?]*[ -/]*[@-~]/g, "");

test("thinkingFrame gives the TUI an immediate, elapsed status", () => {
  const first = thinkingFrame(0, 0);
  const later = thinkingFrame(2, 2_400);
  assert.match(first, /THINKING/);
  assert.match(first, /0s/);
  assert.match(later, /2s/);
  assert.notEqual(first, later);
});

test("prompt delivery steers durable or locally pending work and queues only when idle", () => {
  const failed = { promptId: "old", prompt: "old", events: [event("TaskConclusion", { runId: "old-run", outcome: "failed", summary: "failed" })], assistant: "" };
  const pending = { promptId: "new", prompt: "new", events: [], assistant: "" };
  assert.equal(promptDelivery([], false), "queue");
  assert.equal(promptDelivery([pending], false), "steer");
  assert.equal(promptDelivery([failed], true), "steer");
  assert.equal(sessionHasPendingExecution([failed, pending], false), true);
  assert.equal(sessionHasPendingExecution([failed], false), false);
  assert.equal(sessionHasPendingExecution([{ ...pending, events: [event("TaskConclusion", { runId: "new-run", outcome: "finished", summary: "done" })] }], false), false);
});

test("terminal frame commits batch all chunks into one write", () => {
  const writes: string[] = [];
  writeTerminalFrame((text) => writes.push(text), ["clear", "body", "footer"]);
  assert.deepEqual(writes, ["clearbodyfooter"]);
});

test("iTerm2 synchronized frames hide the complete clear, OSC repaint, and cursor restore transaction", () => {
  const frame = synchronizedTerminalFrame("clear\x1b]1337;File=inline=1;:AQID\x07restore");
  assert.equal(frame, "\x1b[?2026hclear\x1b]1337;File=inline=1;:AQID\x07restore\x1b[?2026l");
  assert.equal(frame.indexOf("\x1b[?2026h"), 0);
  assert.equal(frame.endsWith("\x1b[?2026l"), true);
});

test("thinking animation repaints only the activity footer without clearing or retransmitting images", () => {
  const active = activityFooterFrame("THINKING · 2s", true, 24, 80);
   assert.match(active, /^\x1b\[\?25h\x1b\[s\x1b\[23;1H\x1b\[2K/);
  assert.equal(active.endsWith("\x1b[u"), true);
  assert.doesNotMatch(active, /\x1b\[2J|\x1b\]1337;File=|\x1b_G/);

  const stopped = activityFooterFrame("", false, 24, 80);
  assert.match(stopped, /^\x1b\[\?25h\x1b\[s\x1b\[23;1H\x1b\[2K/);
});

test("thinking animation preserves the status footer in a one-row terminal", () => {
   assert.equal(activityFooterFrame("THINKING · 2s", true, 1, 80), "\x1b[?25h");
  assert.equal(activityFooterFrame("", false, 1, 80), "\x1b[?25h");
});

test("terminal cell pixel query parses height and width", () => {
  assert.deepEqual(parseTerminalCellPixelSize("\x1b[6;18;9t"), { width: 9, height: 18 });
  assert.equal(parseTerminalCellPixelSize("ordinary input"), undefined);
});

test("LaTeX graphics mask every fallback row at its exact terminal-cell column", () => {
  assert.deepEqual(latexFallbackMasks("  ──\n  √5", ["  ──  ──", "prefix  √5"], 0, 4, 4), [
    { row: 4, column: 5, width: 4 },
    { row: 5, column: 7, width: 4 },
  ]);
});

test("native graphics mask their ANSI fallback before the frame is painted", () => {
  const screen = ["header", "  ▌ FIN", "  ●────", "footer"];
  assert.deepEqual(applyGraphicFallbackMasks(screen, [
    { row: 2, column: 3, width: 5 },
    { row: 3, column: 3, width: 5 },
  ]), ["header", "       ", "       ", "footer"]);
});

test("native graphic masks suspend reverse video across the image footprint", () => {
  const selected = `${tuiPalette.reverse}The result is x².${tuiPalette.reverseOff}`;
  assert.equal(
    applyGraphicFallbackMasks([selected], [{ row: 1, column: 15, width: 2 }])[0],
    `${tuiPalette.reverse}The result is ${tuiPalette.reverseOff}  ${tuiPalette.reverse}.${tuiPalette.reverseOff}`,
  );
});

test("Kitty charts mask their complete ANSI footprint even when the raster is narrower", () => {
  assert.deepEqual(chartFallbackMasks({ row: 2, column: 4, columns: 8, rows: 3 }, 5, 5), [
    { row: 8, column: 5, width: 8 },
    { row: 9, column: 5, width: 8 },
    { row: 10, column: 5, width: 8 },
  ]);
});

test("chart placement requires the complete visible ANSI surface", () => {
  assert.deepEqual(findChartSurfacePlacement(["  TITLE", "  ─────", "  ●"], "TITLE\n─────\n●"), { row: 0, column: 2, columns: 5, rows: 3 });
  assert.equal(findChartSurfacePlacement(["  TITLE", "  ─────"], "TITLE\n─────\n●"), undefined);
});

test("chart placement finds a duplicated visible surface after the first occurrence", () => {
  const lines = ["  TITLE", "  ─────", "  ●", "other", "  TITLE", "  ─────", "  ●"];
  const first = findChartSurfacePlacement(lines, "TITLE\n─────\n●");
  assert.deepEqual(first, { row: 0, column: 2, columns: 5, rows: 3 });
  assert.deepEqual(findChartSurfacePlacement(lines, "TITLE\n─────\n●", (first?.row ?? 0) + (first?.rows ?? 0)), { row: 4, column: 2, columns: 5, rows: 3 });
});

test("LaTeX graphic discovery requires a complete contiguous fallback surface", () => {
  assert.equal(findLatexFallbackSurface(["  ──"], "  ──\n  √5"), undefined);
  assert.deepEqual(findLatexFallbackSurface(["  ──", "prefix  √5"], "  ──\n  √5"), {
    row: 0,
    column: 0,
    cellColumns: [1, 7],
    rows: 2,
  });
});

test("visible LaTeX budget ignores clipped earlier fallback surfaces", () => {
  const candidates = Array.from({ length: 9 }, (_unused, index) => ({ value: index, fallback: `F${index}\nS${index}` }));
  const lines = ["F0", ...candidates.slice(1).flatMap((candidate) => candidate.fallback.split("\n"))];
  assert.deepEqual(visibleLatexFallbackSurfaces(candidates, lines).map((candidate) => candidate.value), [1, 2, 3, 4, 5, 6, 7, 8]);
});

test("graphic render completion applies only a successful current promise and retains negative cache entries", async () => {
  const cache = new Map<string, Promise<string | undefined>>();
  const failed = Promise.resolve<string | undefined>(undefined);
  cache.set("formula", failed);
  assert.equal(shouldApplyGraphicRender(cache, "formula", failed, await failed), false);
  assert.equal(cache.get("formula"), failed);

  const stale = Promise.resolve<string | undefined>(undefined);
  const replacement = Promise.resolve<string | undefined>("graphic");
  cache.set("formula", replacement);
  assert.equal(shouldApplyGraphicRender(cache, "formula", stale, await stale), false);
  assert.equal(cache.get("formula"), replacement);

  assert.equal(shouldApplyGraphicRender(cache, "formula", replacement, await replacement), true);
});

test("LaTeX graphics mask fallback only when their raster geometry covers it", () => {
  const graphic = { data: new Uint8Array(), columns: 6, rows: 2 };
  assert.equal(canPlaceLatexGraphic(graphic, "one\ntwo", 6), true);
  assert.equal(canPlaceLatexGraphic({ ...graphic, rows: 1 }, "one\ntwo", 6), true);
  assert.equal(canPlaceLatexGraphic({ ...graphic, rows: 0 }, "one\ntwo", 6), false);
  assert.equal(canPlaceLatexGraphic({ ...graphic, rows: 3 }, "one\ntwo", 6), false);
  assert.equal(canPlaceLatexGraphic({ ...graphic, columns: 7 }, "one\ntwo", 6), false);
});

test("multiline LaTeX fallbacks request and cache their complete raster row budget", () => {
  const surface = findLatexFallbackSurface(["  ──", "  √5", "  done"], "  ──\n  √5\n  done");
  assert.ok(surface !== undefined);
  const requiredRows = latexGraphicRowBudget(surface);
  const segment = { source: "\\frac{1}{2}", displayMode: true };
  assert.equal(requiredRows, 3);
  assert.notEqual(latexGraphicRenderKey(segment, 24, 8, 8, 16), latexGraphicRenderKey(segment, 24, requiredRows, 8, 16));
  assert.equal(canPlaceLatexGraphic({ data: new Uint8Array(), columns: 6, rows: requiredRows }, "  ──\n  √5\n  done", 24), true);
});

test("native LaTeX candidates include inline and display formulas for protocol adapters", () => {
  assert.deepEqual(nativeLatexGraphicCandidates(String.raw`inline $x^2$ and display $$\frac{a}{b}$$`), [
    { segment: { source: "x^2", displayMode: false }, occurrence: 0, fallback: "x²", linePrefix: "inline ", lineSuffix: " and display  a", uniqueContext: true },
    { segment: { source: String.raw`\frac{a}{b}`, displayMode: true }, occurrence: 1, fallback: " a\n───\n b", linePrefix: "inline x² and display ", lineSuffix: "", uniqueContext: true },
  ]);
});

test("native LaTeX candidates preserve unsupported math context from one Markdown render", () => {
  const [bold] = nativeLatexGraphicCandidates(String.raw`**before \[\boxed{x}\] after**`);
  assert.deepEqual(bold, {
    segment: { source: String.raw`\boxed{x}`, displayMode: true },
    occurrence: 0,
    fallback: String.raw`\[\boxed{x}\]`,
    linePrefix: "before ",
    lineSuffix: " after",
    uniqueContext: true,
  });

  const [link] = nativeLatexGraphicCandidates(String.raw`[before \[\boxed{x}\] after](https://example.com)`);
  assert.deepEqual(link, {
    segment: { source: String.raw`\boxed{x}`, displayMode: true },
    occurrence: 0,
    fallback: String.raw`\[\boxed{x}\]`,
    linePrefix: "before ",
    lineSuffix: " after",
    uniqueContext: true,
  });
});

test("inline LaTeX placement uses source context instead of matching identical prose", () => {
  const [candidate] = nativeLatexGraphicCandidates(String.raw`x before $x$`);
  assert.ok(candidate !== undefined);
  assert.deepEqual(findLatexFallbackSurface(["x before x"], "x", 0, 0, candidate.linePrefix, candidate.lineSuffix, true), {
    row: 0,
    column: 9,
    cellColumns: [10],
    rows: 1,
  });
});

test("inline LaTeX placement fails closed for context-free or repeated source surfaces", () => {
  const newlineCandidate = nativeLatexGraphicCandidates("x before\n$x$")[0];
  const repeatedCandidate = nativeLatexGraphicCandidates("same prefix text $x$\nsame prefix text x")[0];
  assert.equal(newlineCandidate?.uniqueContext, false);
  assert.equal(repeatedCandidate?.uniqueContext, false);
});

test("display LaTeX placement does not replace identical fenced code", () => {
  const [candidate] = nativeLatexGraphicCandidates([
    "```",
    String.raw`\[\boxed{x}\]`,
    "```",
    String.raw`\[\boxed{x}\]`,
  ].join("\n"));
  assert.ok(candidate !== undefined);
  assert.equal(candidate?.segment.displayMode, true);
  assert.equal(candidate?.uniqueContext, false);
});

test("inline LaTeX placement is restricted to its originating Assistant board", () => {
  assert.deepEqual(visibleLatexFallbackSurfaces([
    { value: "second", fallback: "x", requireUnique: true, owner: "prompt-2" },
  ], ["x", "x"], 8, ["prompt-1", "prompt-2"]), [{
    value: "second",
    fallback: "x",
    surface: { row: 1, column: 0, cellColumns: [1], rows: 1 },
  }]);
});

test("one-row Assistant LaTeX follows the live placement path for iTerm2 and Kitty", async () => {
  const promptId = "prompt-inline";
  const [candidate] = nativeLatexGraphicCandidates(String.raw`The result is $x^2$.`);
  assert.ok(candidate !== undefined);
  if (candidate === undefined) return;

  const plainLines = ["The result is x²."];
  const [visible] = visibleLatexFallbackSurfaces([{
    value: candidate,
    fallback: candidate.fallback,
    linePrefix: candidate.linePrefix,
    lineSuffix: candidate.lineSuffix,
    requireUnique: true,
    owner: promptId,
  }], plainLines, 8, [promptId]);
  assert.ok(visible !== undefined);
  if (visible === undefined) return;

  const maxColumns = 40 - (visible.surface.cellColumns[0] ?? 1) - 1;
  const maxRows = latexGraphicRowBudget(visible.surface);
  assert.equal(maxRows, 1);
  const graphic = await renderLatexGraphic(visible.value.segment, maxColumns, maxRows, 8, 16);
  assert.ok(graphic !== undefined);
  if (graphic === undefined) return;
  assert.equal(canPlaceLatexGraphic(graphic, visible.fallback, maxColumns), true);

  const masks = latexFallbackMasks(visible.fallback, plainLines, visible.surface.row, visible.surface.column, 5);
  assert.deepEqual(masks, [{ row: 5, column: 15, width: 2 }]);
  assert.equal(applyGraphicFallbackMasks(plainLines, masks.map((mask) => ({ ...mask, row: 1 })))[0], "The result is   .");

  const placement = {
    key: kittyLatexPlacementKey(promptId, visible.value.occurrence, "inline-raster"),
    data: graphic.data,
    row: 5,
    column: visible.surface.cellColumns[0] ?? 1,
    columns: graphic.columns,
    rows: graphic.rows,
  };
  const itermFrame = placeIterm2Frame([placement], 20);
  assert.match(itermFrame, /^\x1b\[5;15H\x1b\]1337;File=inline=1;/);
  const oscPayload = /:([A-Za-z0-9+/=]*)\x07/.exec(itermFrame)?.[1];
  assert.deepEqual(Buffer.from(oscPayload ?? "", "base64"), Buffer.from(graphic.data));

  const kitty = reconcileKittyPlacements(new Map(), "kitty", [placement], 1);
  assert.match(kitty.frame, /^\x1b\[5;15H\x1b_Ga=T,f=100,q=2/);
});

test("boxed multiline Assistant LaTeX follows the live placement path for iTerm2 and Kitty", async () => {
  const promptId = "prompt-boxed";
  const source = String.raw`\[
\boxed{
F_n=
\frac{1}{\sqrt{5}}
\left[
\left(\frac{1+\sqrt{5}}{2}\right)^n
-
\left(\frac{1-\sqrt{5}}{2}\right)^n
\right]
}
\]`;
  const [candidate] = nativeLatexGraphicCandidates(source);
  assert.ok(candidate !== undefined);
  if (candidate === undefined) return;
  assert.equal(candidate.fallback, source);

  const plainLines = source.split("\n");
  const [visible] = visibleLatexFallbackSurfaces([{
    value: candidate,
    fallback: candidate.fallback,
    linePrefix: candidate.linePrefix,
    lineSuffix: candidate.lineSuffix,
    requireUnique: true,
    owner: promptId,
  }], plainLines, 8, Array.from({ length: plainLines.length }, () => promptId));
  assert.ok(visible !== undefined);
  if (visible === undefined) return;

  const maxColumns = 80 - (visible.surface.cellColumns[0] ?? 1) - 1;
  const maxRows = latexGraphicRowBudget(visible.surface);
  const graphic = await renderLatexGraphic(visible.value.segment, maxColumns, maxRows, 8, 16);
  assert.ok(graphic !== undefined);
  if (graphic === undefined) return;
  assert.ok(graphic.rows <= visible.surface.rows);
  assert.equal(canPlaceLatexGraphic(graphic, visible.fallback, maxColumns), true);

  const masks = latexFallbackMasks(visible.fallback, plainLines, visible.surface.row, visible.surface.column, 5);
  assert.equal(masks.length, plainLines.length);
  const placement = {
    key: kittyLatexPlacementKey(promptId, visible.value.occurrence, "boxed-raster"),
    data: graphic.data,
    row: 5,
    column: visible.surface.cellColumns[0] ?? 1,
    columns: graphic.columns,
    rows: graphic.rows,
  };
  const itermFrame = placeIterm2Frame([placement], 20);
  assert.match(itermFrame, /^\x1b\[5;1H\x1b\]1337;File=inline=1;/);
  const oscPayload = /:([A-Za-z0-9+/=]*)\x07/.exec(itermFrame)?.[1];
  assert.deepEqual(Buffer.from(oscPayload ?? "", "base64"), Buffer.from(graphic.data));

  const kitty = reconcileKittyPlacements(new Map(), "kitty", [placement], 1);
  assert.match(kitty.frame, /^\x1b\[5;1H\x1b_Ga=T,f=100,q=2/);
});

test("square-root raster may occupy fewer rows than its fallback", async () => {
  const [candidate] = nativeLatexGraphicCandidates(String.raw`\[\sqrt{x^2+y^2}\]`);
  assert.ok(candidate !== undefined);
  if (candidate === undefined) return;
  const graphic = await renderLatexGraphic(candidate.segment, 24, candidate.fallback.split("\n").length, 8, 16);
  assert.ok(graphic !== undefined);
  if (graphic === undefined) return;
  const shorterGraphic = { ...graphic, rows: graphic.rows - 1 };
  assert.ok(shorterGraphic.rows > 0);
  assert.ok(shorterGraphic.rows < candidate.fallback.split("\n").length);
  assert.equal(canPlaceLatexGraphic(shorterGraphic, candidate.fallback, 24), true);
});

test("terminal cell pixel replies remain buffered across input chunks", () => {
  const partial = consumeTerminalCellPixelResponses("", "\x1b[6;18;");
  assert.deepEqual(partial, { pending: "\x1b[6;18;", input: "", cellPixels: undefined });
  assert.deepEqual(consumeTerminalCellPixelResponses(partial.pending, "9tinput"), { pending: "", input: "input", cellPixels: { width: 9, height: 18 } });
});

test("terminal cell pixel replies never leak at any chunk boundary", () => {
  const response = "\x1b[6;18;9t";
  for (let boundary = 1; boundary < response.length; boundary += 1) {
    const first = consumeTerminalCellPixelResponses("", response.slice(0, boundary));
    assert.equal(first.input, "");
    const second = consumeTerminalCellPixelResponses(first.pending, `${response.slice(boundary)}USER`);
    assert.deepEqual(second, { pending: "", input: "USER", cellPixels: { width: 9, height: 18 } });
  }
});

test("production TUI startup and /quit restore saved terminal modes", async () => {
  const input = new FakeTerminalInput();
  const output = new FakeTerminalOutput();
  const run = startTuiWithTerminal(["--session", "integration"], new FakeTuiClient(), input, output, { workingDirectory: "/tmp" });
  await settleTui();
  input.emitData("/quit\n");
  const result = await run;
  assert.deepEqual(result, { exitCode: 0, body: "" });
  assert.deepEqual(input.rawModeCalls, [true, false]);
  assert.equal(output.writes[0], startTerminalMouseFrame());
  assert.equal(output.writes.at(-1), shutdownTerminalFrame(false));
});

test("production TUI abort signal uses the same deterministic terminal cleanup", async () => {
  const input = new FakeTerminalInput();
  const output = new FakeTerminalOutput();
  const controller = new AbortController();
  const run = startTuiWithTerminal(["--session", "abort-cleanup"], new FakeTuiClient(), input, output, {
    workingDirectory: "/tmp",
    signal: controller.signal,
  });
  await settleTui();
  controller.abort();
  const result = await run;

  assert.deepEqual(result, { exitCode: 0, body: "" });
  assert.deepEqual(input.rawModeCalls, [true, false]);
  assert.equal(input.listenerCount("data"), 0);
  assert.equal(output.listenerCount("resize"), 0);
  assert.equal(output.writes.at(-1), shutdownTerminalFrame(false));
});

test("production TUI startup failure cleans up without restoring unsaved modes", async () => {
  const input = new FakeTerminalInput();
  const output = new FakeTerminalOutput();
  output.failNextWrite = true;
  const run = startTuiWithTerminal(["--session", "startup-failure"], new FakeTuiClient(), input, output, { workingDirectory: "/tmp" });
  await assert.rejects(run, /startup output failed/);
  assert.deepEqual(input.rawModeCalls, [true, false]);
  assert.equal(output.writes.at(-1), shutdownTerminalFrame(false, false));
  assert.equal(output.writes.some((write) => write.includes("\x1b[?25;1003;1006r")), false);
});

test("production TUI preserves startup and cleanup failures together", async () => {
  const input = new FakeTerminalInput();
  input.failRestoreOnCall = 1;
  const output = new FakeTerminalOutput();
  output.failNextWrite = true;
  const run = startTuiWithTerminal(["--session", "startup-cleanup-failure"], new FakeTuiClient(), input, output, { workingDirectory: "/tmp" });
  await assert.rejects(run, (error: unknown) => error instanceof AggregateError
    && error.errors.length === 2
    && error.errors[0] instanceof Error
    && error.errors[0].message === "startup output failed"
    && error.errors[1] instanceof Error
    && error.errors[1].message === "raw restore failed");
  assert.equal(output.writes.at(-1), shutdownTerminalFrame(false, false));
  assert.deepEqual(input.rawModeCalls, [true, false]);
});

test("production TUI cleanup preserves body and raw-mode failures while shutting down", async () => {
  const input = new FakeTerminalInput();
  input.failRestoreOnCall = 1;
  const output = new FakeTerminalOutput();
  const client = new FakeTuiClient();
  client.removeEventThrows = true;
  const run = startTuiWithTerminal(["--session", "cleanup-failure"], client, input, output, { workingDirectory: "/tmp" });
  await settleTui();
  input.emitData("/quit\n");
  await assert.rejects(run, (error: unknown) => error instanceof AggregateError && error.errors.length === 2 && error.errors.some((item) => item instanceof Error && item.message === "unsubscribe failed") && error.errors.some((item) => item instanceof Error && item.message === "raw restore failed"));
  assert.equal(output.writes.at(-1), shutdownTerminalFrame(false));
  assert.deepEqual(input.rawModeCalls, [true, false]);
  assert.equal(input.listenerCount("data"), 0);
  assert.equal(output.listenerCount("resize"), 0);
  assert.equal(input.pauseCalls, 1);
});

test("production TUI routes passive chart motion and does not repaint repeated targets", async () => {
  const chart = { kind: "line-chart" as const, title: "FIN", points: [{ label: "open", value: 10 }, { label: "close", value: 14 }] };
  const input = new FakeTerminalInput();
  const output = new FakeTerminalOutput();
  const client = new FakeTuiClient(chartLifecycleEvents());
  const run = startTuiWithTerminal(["--session", "chart-integration"], client, input, output, { workingDirectory: "/tmp" });
  await settleTui();
  input.emitData("/thinking\n");
  await settleTui();
  const frame = stripAnsi([...output.writes].reverse().find((write) => stripAnsi(write).includes("FIN")) ?? "");
  const lines = frame.split("\n");
  const placement = findChartSurfacePlacement(lines, stripAnsi(renderChartSurface(chart, 70, 10)));
  assert.ok(placement !== undefined, output.writes.map((write, index) => `${index}:${stripAnsi(write).slice(0, 240)}`).join("\n"));
  const column = terminalCellWidth(lines[placement.row]?.slice(0, placement.column) ?? "") + 1;
  const box = translateChartSurfaceHitBoxes(chart, "result-1", 0, placement, placement.row + 1, column, output.columns, output.rows)[0];
  assert.ok(box !== undefined);
  const baselineWrites = output.writes.length;
  const baselineRasterWrites = output.writes.filter((write) => write.includes("\x1b_G") || write.includes("\x1b]1337;")).length;
  const rasterKey = chartGraphicRenderKey(chart, 70, 10, 0, 0);
  input.emitData(`\x1b[<35;${box.left};${box.top}M`);
  await settleTui();
  assert.equal(output.writes.length, baselineWrites + 1, `first hover writes: ${output.writes.length - baselineWrites}`);
  assert.match(stripAnsi(output.writes.at(-1) ?? ""), /CHART · FIN · open = 10/);
  input.emitData(`\x1b[<35;${box.left};${box.top}M`);
  await settleTui();
  assert.equal(output.writes.length, baselineWrites + 1, `repeated hover writes: ${output.writes.length - baselineWrites}`);
  assert.equal(output.writes.filter((write) => write.includes("\x1b_G") || write.includes("\x1b]1337;")).length, baselineRasterWrites, `raster writes changed from ${baselineRasterWrites}`);
  assert.equal(chartGraphicRenderKey(chart, 70, 10, 0, 0), rasterKey);
  input.emitData("/quit\n");
  await run;
});

test("production prompt arrows move the cursor across wrapped input", async () => {
  const input = new FakeTerminalInput();
  const output = new FakeTerminalOutput();
  const client = new FakeTuiClient();
  const run = startTuiWithTerminal(["--session", "cursor-integration"], client, input, output, { workingDirectory: "/tmp" });
  await settleTui();
  input.emitData("a".repeat(90));
  input.emitData("\x1b[A");
  input.emitData("\x1b[D");
  input.emitData("L");
  input.emitData("\x1b[C");
  input.emitData("R");
  input.emitData("\x1b[B");
  input.emitData("D\n");
  await settleTui();
  assert.equal(client.submissions[0]?.prompt, `${"a".repeat(9)}LaR${"a".repeat(80)}D`);
  input.emitData("/quit\n");
  await run;
});

test("production Shift+Enter inserts a line break without submitting", async () => {
  const input = new FakeTerminalInput();
  const output = new FakeTerminalOutput();
  const client = new FakeTuiClient();
  const run = startTuiWithTerminal(["--session", "multiline-integration"], client, input, output, { workingDirectory: "/tmp" });
  await settleTui();
  input.emitData("first");
  input.emitData("\x1b[13;");
  input.emitData("2u");
  await settleTui();
  assert.equal(client.submissions.length, 0);
  input.emitData("second");
  await settleTui();
  assert.ok(output.writes.some((write) => stripAnsi(write).includes("USER > first\nsecond")));
  input.emitData("\r");
  await settleTui();
  assert.equal(client.submissions.length, 1);
  assert.equal(client.submissions[0]?.prompt, "first\nsecond");
  input.emitData("  padded  ");
  input.emitData("\x1b[13;2u");
  input.emitData("\r");
  await settleTui();
  assert.equal(client.submissions.length, 2);
  assert.equal(client.submissions[1]?.prompt, "  padded  \n");
  input.emitData("/quit\n");
  await run;
});

test("production mouse selection reverses assistant text and copies without panel borders", async () => {
  const sessionId = "selection-integration";
  const assistantText = "runtime selection content";
  const events: DurableEvent[] = [
    event("PromptAdmitted", { promptId: "prompt-1", prompt: "select this answer", delivery: "queue" }, "admit-1", sessionId),
    event("InputPromoted", { promptId: "prompt-1", delivery: "queue", reason: "queue-idle" }, "promote-1", sessionId),
    event("GraphRunStarted", { runId: "run-1", planId: "plan", planVersion: 1, planDigest: "digest", status: "running", inputEventId: "admit-1" }, "run-1", sessionId),
    event("ProviderTurnStarted", { provider: "test", model: "model", providerCallId: "run-1:turn-0", effectId: "run-1:provider:0" }, "turn-1", sessionId),
    event("ProviderText", { providerCallId: "run-1:turn-0", text: assistantText, truncated: false }, "text-1", sessionId),
  ];
  const input = new FakeTerminalInput();
  const output = new FakeTerminalOutput();
  const copied: string[] = [];
  const run = startTuiWithTerminal(["--session", sessionId], new FakeTuiClient(events), input, output, {
    workingDirectory: "/tmp",
    clipboard: async (text) => { copied.push(text); return true; },
  });
  await settleTui();

  const initialFrame = [...output.writes].reverse().find((write) => stripAnsi(write).includes(assistantText));
  assert.ok(initialFrame !== undefined);
  const assistantRow = stripAnsi(initialFrame).split("\n").findIndex((line) => line.includes(assistantText)) + 1;
  assert.ok(assistantRow > 0);

  input.emitData(`\x1b[<0;1;${assistantRow}M`);
  input.emitData(`\x1b[<32;${output.columns};${assistantRow}M`);
  await settleTui();
  assert.ok(output.writes.at(-1)?.includes(tuiPalette.reverse));

  input.emitData(`\x1b[<0;${output.columns};${assistantRow}m`);
  await settleTui();
  assert.deepEqual(copied, [assistantText]);
  assert.doesNotMatch(copied[0] ?? "", /[│┌┐└┘─]/);

  input.emitData("/quit\n");
  await run;
});

test("Kitty shutdown removes native image placements", () => {
  const startup = "\x1b[?25;1003;1006s\x1b[?1003;1006h\x1b[?25l\x1b[16t";
  assert.equal(startTerminalMouseFrame(), startup);
  assert.equal(startTerminalMouseFrame(), startup);
  assert.match(shutdownTerminalFrame(true), /^\x1b_Ga=d,d=A,q=2\x1b\\/);
  assert.doesNotMatch(shutdownTerminalFrame(false), /\x1b_Ga=d/);
  const shutdown = "\x1b[?1003l\x1b[?1006l\x1b[?25h\x1b[?25;1003;1006r\x1b[0m\n";
  assert.equal(shutdownTerminalFrame(false), shutdown);
  assert.equal(shutdownTerminalFrame(false), shutdown);
  assert.equal(shutdownTerminalFrame(false, false), "\x1b[?1003l\x1b[?1006l\x1b[?25h\x1b[0m\n");
});

test("TUI cleanup preserves stage ordering and guarantees terminal shutdown", () => {
  const run = (failure: "none" | "body" | "raw") => {
    const order: string[] = [];
    const execute = () => runTuiCleanup(
      () => { order.push("body"); if (failure === "body") throw new Error("body failed"); },
      () => { order.push("raw"); if (failure === "raw") throw new Error("raw failed"); },
      () => { order.push("shutdown"); },
    );
    if (failure === "none") execute();
    else assert.throws(execute, new RegExp(`${failure} failed`));
    assert.deepEqual(order, ["body", "raw", "shutdown"]);
  };
  run("none");
  run("body");
  run("raw");
  assert.doesNotMatch(shutdownTerminalFrame(false, false), /\x1b\[\?25;1003;1006r/);
  assert.match(shutdownTerminalFrame(false, true), /\x1b\[\?25;1003;1006r/);
});

test("TUI cleanup recursively flattens initial and stage aggregate errors in order", () => {
  const primary = new Error("primary failed");
  const request = new Error("request failed");
  const body = new Error("body failed");
  const raw = new Error("raw failed");
  const shutdown = new Error("shutdown failed");
  assert.throws(
    () => runTuiCleanup(
      () => { throw new AggregateError([new AggregateError([body], "nested body")], "body aggregate"); },
      () => { throw new AggregateError([raw], "raw aggregate"); },
      () => { throw shutdown; },
      [new AggregateError([primary, new AggregateError([request], "nested request")], "initial aggregate")],
    ),
    (error: unknown) => error instanceof AggregateError
      && error.message === "TUI cleanup failed"
      && error.errors.length === 5
      && error.errors[0] === primary
      && error.errors[1] === request
      && error.errors[2] === body
      && error.errors[3] === raw
      && error.errors[4] === shutdown,
  );
});

const hoverChart = (kind: "line-chart" | "bar-chart") => ({ kind, title: "Revenue", points: [{ label: "Jan", value: 10 }, { label: "Feb", value: 20 }, { label: "Mar", value: 15 }] } as const);

test("chart hover translation shares line and bar layout geometry and clips to the screen", () => {
  const line = translateChartSurfaceHitBoxes(hoverChart("line-chart"), "event-1", 0, { row: 0, column: 0, columns: 30, rows: 13 }, 4, 5, 80, 24);
  const bar = translateChartSurfaceHitBoxes(hoverChart("bar-chart"), "event-2", 1, { row: 0, column: 0, columns: 30, rows: 13 }, 4, 5, 80, 24);
  assert.equal(line.length, 3);
  assert.equal(bar.length, 3);
  assert.equal(line.every((box) => box.left >= 1 && box.right <= 80 && box.top >= 1 && box.bottom <= 24), true);
  assert.equal(hitTestChartScreen(line[0]?.top ?? 0, line[0]?.left ?? 0, line)?.pointIndex, 0);
  assert.equal(hitTestChartScreen(1, 1, line), undefined);
  const clipped = translateChartSurfaceHitBoxes(hoverChart("line-chart"), "event-3", 0, { row: 0, column: 0, columns: 30, rows: 13 }, 1, 78, 80, 5);
  assert.equal(clipped.every((box) => box.left <= box.right && box.top <= box.bottom), true);
  assert.equal(hitTestChartScreen(6, 77, clipped), undefined);
  assert.equal(hitTestChartScreen(1, 80, clipped), undefined);
});

test("chart hover translation exposes semantic targets for K-line, heatmap, and pie charts", () => {
  const placement = { row: 0, column: 0, columns: 40, rows: 13 };
  const kline = translateChartSurfaceHitBoxes({ kind: "kline-chart", title: "OHLCV", candles: [
    { label: "A", open: 1, high: 4, low: 0, close: 3, volume: 5 },
    { label: "B", open: 3, high: 5, low: 2, close: 2, volume: 2 },
  ] }, "k", 0, placement, 4, 5, 80, 24);
  assert.equal(kline.length, 4);
  assert.deepEqual(new Set(kline.map((box) => box.kind === "kline-chart" ? box.series : "")), new Set(["candle", "volume"]));
  const klineFeedback = formatChartHoverFeedback(kline[0], 100);
  assert.match(klineFeedback, /O:|H:|L:|C:|V:/);

  const heatmap = translateChartSurfaceHitBoxes({ kind: "heatmap-chart", title: "FLOW", rows: ["Buy", "Sell"], columns: ["A", "B"], values: [[1, null], [2, 3]] }, "h", 0, placement, 4, 5, 80, 24);
  assert.equal(heatmap.length, 3);
  assert.equal(heatmap.some((box) => box.kind === "heatmap-chart" && box.row === "Buy" && box.column === "B"), false);
  const heatmapFeedback = formatChartHoverFeedback(heatmap[0], 100);
  assert.match(heatmapFeedback, /×/);

  const pie = translateChartSurfaceHitBoxes({ kind: "pie-chart", title: "MIX", slices: [{ label: "A", value: 3 }, { label: "B", value: 1 }] }, "p", 0, placement, 4, 5, 80, 24);
  assert.equal(pie.length, 2);
  const pieTarget = pie[0];
  assert.equal(pieTarget?.kind, "pie-chart");
  assert.match(formatChartHoverFeedback(pieTarget, 100), /75\.0%/);
});

test("chart hover transitions are semantic and repeated targets are no-op", () => {
  const target: ChartHoverTarget = { chartId: "event", occurrence: 0, kind: "line-chart", pointIndex: 1, title: "Revenue", label: "Feb", value: 20 };
  assert.equal(reduceChartHover(undefined, target).type, "enter");
  assert.equal(reduceChartHover(target, { ...target, label: "changed display", value: 21 }).type, "no-op");
  assert.equal(reduceChartHover(target, { ...target, pointIndex: 2 }).type, "change");
  assert.equal(reduceChartHover(target, undefined).type, "leave");
  assert.equal(reduceChartHover(undefined, undefined).type, "no-op");
});

test("chart hover reconciliation drops stale targets and retains matching identities", () => {
  const target: ChartHoverTarget = { chartId: "event", occurrence: 0, kind: "line-chart", pointIndex: 1, title: "Revenue", label: "Feb", value: 20 };
  const hitBox = { ...target, left: 10, top: 4, right: 12, bottom: 6 };
  assert.deepEqual(reconcileChartHoverTarget(target, [hitBox]), hitBox);
  assert.equal(reconcileChartHoverTarget(target, []), undefined);
  assert.equal(reconcileChartHoverTarget({ ...target, pointIndex: 2 }, [hitBox]), undefined);
});

test("stationary pointer reconciliation follows shifted and clipped chart geometry", () => {
  const target: ChartHoverTarget = { chartId: "event", occurrence: 0, kind: "line-chart", pointIndex: 1, title: "Revenue", label: "Feb", value: 20 };
  const pointer = { row: 5, column: 11 };
  const shifted = { ...target, left: 20, top: 5, right: 22, bottom: 7 };
  const stale = reconcileChartHoverAtPointer(target, pointer, [shifted]);
  assert.equal(stale.target, undefined);
  assert.equal(stale.transition.type, "leave");
  const retained = reconcileChartHoverAtPointer(target, { row: 5, column: 21 }, [shifted]);
  assert.equal(retained.target?.pointIndex, 1);
  assert.equal(retained.transition.type, "no-op");
  const clipped = { ...shifted, left: 1, right: 80, top: 1, bottom: 1 };
  const outside = reconcileChartHoverAtPointer(target, pointer, [clipped]);
  assert.equal(outside.target, undefined);
  assert.equal(outside.transition.type, "leave");
});

test("hover routing preserves permission, overlay, selection, and non-motion priority", () => {
  const motion = { action: "motion" as const, button: 3 };
  const clear = { permissionActive: false, overlayActive: false, selectionDragging: false };
  assert.equal(routeChartHoverMotion(motion, clear), "eligible");
  assert.equal(routeChartHoverMotion(motion, { ...clear, permissionActive: true }), "blocked");
  assert.equal(routeChartHoverMotion(motion, { ...clear, overlayActive: true }), "blocked");
  assert.equal(routeChartHoverMotion(motion, { ...clear, selectionDragging: true }), "blocked");
  assert.equal(routeChartHoverMotion({ action: "press", button: 64 }, clear), "ignored");
  assert.equal(routeChartHoverMotion({ action: "release", button: 3 }, clear), "ignored");
});

test("unchanged hover is a no-op and cannot change the production chart raster key", () => {
  const chart = hoverChart("line-chart");
  const target: ChartHoverTarget = { chartId: "event", occurrence: 0, kind: chart.kind, pointIndex: 0, title: chart.title, label: "Jan", value: 10 };
  let frameRequests = 0;
  const hover = dispatchChartHoverMotion(target, { row: 5, column: 11 }, [{ ...target, left: 10, top: 4, right: 12, bottom: 6 }], () => { frameRequests += 1; });
  assert.equal(hover.transition.type, "no-op");
  assert.equal(frameRequests, 0);
  const firstKey = chartGraphicRenderKey(chart, 24, 13, 8, 16);
  const secondKey = chartGraphicRenderKey(chart, 24, 13, 8, 16);
  assert.equal(firstKey, secondKey);
  assert.notEqual(firstKey, chartGraphicRenderKey(chart, 25, 13, 8, 16));
});

test("chart hover dispatcher requests exactly one frame for each semantic change", () => {
  const target: ChartHoverTarget = { chartId: "event", occurrence: 0, kind: "line-chart", pointIndex: 0, title: "Revenue", label: "Jan", value: 10 };
  const hitBox = { ...target, left: 10, top: 4, right: 12, bottom: 6 };
  const transitions: string[] = [];
  const request = (transition: { readonly type: "enter" | "change" | "leave" }) => { transitions.push(transition.type); };
  let current: ChartHoverTarget | undefined;
  current = dispatchChartHoverMotion(current, { row: 5, column: 11 }, [hitBox], request).target;
  current = dispatchChartHoverMotion(current, { row: 5, column: 11 }, [hitBox], request).target;
  current = dispatchChartHoverMotion(current, { row: 5, column: 20 }, [hitBox], request).target;
  dispatchChartHoverMotion(current, undefined, [hitBox], request);
  assert.deepEqual(transitions, ["enter", "leave"]);
});

test("activity feedback preserves thinking and transient priority after hover invalidation", () => {
  const target: ChartHoverTarget = { chartId: "event", occurrence: 0, kind: "bar-chart", pointIndex: 0, title: "Revenue", label: "Jan", value: 10 };
  assert.equal(selectActivityFeedback("Thinking", "Notice", target, 80), "Thinking");
  assert.equal(selectActivityFeedback(undefined, "Notice", target, 80), "Notice");
  assert.equal(selectActivityFeedback(undefined, undefined, undefined, 80), "");
});

test("chart hover feedback is compact and terminal-safe", () => {
  const target: ChartHoverTarget = { chartId: "event", occurrence: 0, kind: "bar-chart", pointIndex: 0, title: "Sales\x1b[31m", label: "Jan\n", value: 12.5 };
  const feedback = formatChartHoverFeedback(target, 40);
  assert.equal(feedback.includes("\x1b"), false);
  assert.equal(feedback.includes("\n"), false);
  assert.equal(feedback.length <= 40, true);
  assert.equal(formatChartHoverFeedback(undefined), "");
});

test("Kitty prepaint reconciliation deletes a moved placement before text and replaces it without retransmitting PNG", () => {
  const active = new Map();
  const placement = { key: "chart", data: new Uint8Array([1, 2, 3]), row: 4, column: 2, columns: 8, rows: 3 };
  const initial = reconcileKittyPlacements(active, "kitty", [placement], 1);
  assert.match(initial.frame, /a=T,f=100,q=2,i=1,p=1,c=8,r=3/);
  const movedPlacement = { ...placement, row: 7 };
  const prepaint = reconcileKittyPlacementsBeforePaint(active, "kitty", [movedPlacement]);
  assert.match(prepaint, /^\x1b_Ga=d,d=p,p=1,q=2\x1b\\$/);
  assert.doesNotMatch(prepaint, /a=d,d=i/);
  const moved = reconcileKittyPlacements(active, "kitty", [movedPlacement], initial.nextId);
  assert.match(moved.frame, /^\x1b\[7;2H\x1b_Ga=p,i=1,p=1,c=8,r=3,C=1,q=2\x1b\\$/);
  assert.doesNotMatch(moved.frame, /a=T/);
  const frame = `${prepaint}\x1b[2J\x1b[Htext${moved.frame}`;
  assert.ok(frame.indexOf(prepaint) < frame.indexOf("\x1b[2J"));
  assert.ok(frame.indexOf("\x1b[2J") < frame.indexOf(moved.frame));
});

test("Kitty prepaint reconciliation leaves unchanged placements alone", () => {
  const active = new Map();
  const placement = { key: "chart", data: new Uint8Array([1, 2, 3]), row: 4, column: 2, columns: 8, rows: 3 };
  const initial = reconcileKittyPlacements(active, "kitty", [placement], 1);
  assert.equal(reconcileKittyPlacementsBeforePaint(active, "kitty", [placement]), "");
  const repeated = reconcileKittyPlacements(active, "kitty", [placement], initial.nextId);
  assert.match(repeated.frame, /a=p,i=1,p=1,c=8,r=3,C=1,q=2/);
  assert.doesNotMatch(repeated.frame, /a=T/);
});

test("Kitty prepaint reconciliation releases missing placements and images", () => {
  const active = new Map();
  const placement = { key: "chart", data: new Uint8Array([1, 2, 3]), row: 4, column: 2, columns: 8, rows: 3 };
  reconcileKittyPlacements(active, "kitty", [placement], 1);
  const prepaint = reconcileKittyPlacementsBeforePaint(active, "kitty", []);
  assert.match(prepaint, /a=d,d=p,p=1,q=2/);
  assert.match(prepaint, /a=d,d=i,i=1,q=2/);
  assert.equal(active.size, 0);
});

test("Kitty chart placements remain distinct and move by durable event identity", () => {
  const cacheKey = "same-chart\u00008\u00003\u00008\u000016";
  const first = { key: kittyChartPlacementKey("chart-event-1", 0, cacheKey), data: new Uint8Array([1, 2, 3]), row: 4, column: 2, columns: 8, rows: 3 };
  const second = { ...first, key: kittyChartPlacementKey("chart-event-2", 0, cacheKey), row: 9 };
  const repeated = { ...first, key: kittyChartPlacementKey("chart-event-1", 1, cacheKey), row: 14 };
  assert.notEqual(first.key, second.key);
  assert.notEqual(first.key, repeated.key);
  const active = new Map();
  const initial = reconcileKittyPlacements(active, "kitty", [first, second], 1);
  assert.equal(active.size, 2);
  assert.match(initial.frame, /i=1,p=1/);
  assert.match(initial.frame, /i=2,p=2/);
  const moved = reconcileKittyPlacements(active, "kitty", [{ ...first, row: 6, column: 5 }, { ...second, row: 11, column: 5 }], initial.nextId);
  assert.equal(active.size, 2);
  assert.match(moved.frame, /\x1b\[6;5H\x1b_Ga=p,i=1,p=1,c=8,r=3,C=1,q=2\x1b\\/);
  assert.match(moved.frame, /\x1b\[11;5H\x1b_Ga=p,i=2,p=2,c=8,r=3,C=1,q=2\x1b\\/);
  assert.doesNotMatch(moved.frame, /a=(?:T|d)/);
});

test("Kitty LaTeX placements remain distinct per source occurrence and move without screen coordinates", () => {
  const cacheKey = "display\u0000x\u000080\u00008\u000016";
  const first = { key: kittyLatexPlacementKey("prompt-1", 0, cacheKey), data: new Uint8Array([1, 2, 3]), row: 4, column: 2, columns: 8, rows: 3 };
  const duplicate = { ...first, key: kittyLatexPlacementKey("prompt-1", 1, cacheKey), row: 9 };
  assert.notEqual(first.key, duplicate.key);
  const active = new Map();
  const initial = reconcileKittyPlacements(active, "kitty", [first, duplicate], 1);
  assert.equal(active.size, 2);
  const moved = reconcileKittyPlacements(active, "kitty", [{ ...first, row: 6 }, { ...duplicate, row: 11 }], initial.nextId);
  assert.match(moved.frame, /\x1b\[6;2H\x1b_Ga=p,i=1,p=1,c=8,r=3,C=1,q=2\x1b\\/);
  assert.match(moved.frame, /\x1b\[11;2H\x1b_Ga=p,i=2,p=2,c=8,r=3,C=1,q=2\x1b\\/);
  assert.doesNotMatch(moved.frame, /a=(?:T|d)/);
});

test("iTerm2 Assistant frames place two neutral graphics, repaint only current scroll content, and restore the cursor", () => {
  const chartKey = kittyChartPlacementKey("chart-event-1", 0, "chart-cache");
  const latexKey = kittyLatexPlacementKey("prompt-2", 0, "latex-cache");
  const chart = { key: chartKey, data: new Uint8Array([1, 2, 3]), row: 4, column: 2, columns: 8, rows: 3 };
  const latex = { key: latexKey, data: new Uint8Array([4, 5, 6]), row: 12, column: 5, columns: 6, rows: 2 };
  const first = placeIterm2Frame([chart, latex], 20);
  assert.equal((first.match(/\x1b]1337;File=/g) ?? []).length, 2);
  assert.match(first, /^\x1b\[4;2H\x1b]1337;File=inline=1;size=3;preserveAspectRatio=0;doNotMoveCursor=1;width=8;height=3;:AQID\x07\x1b\[12;5H\x1b]1337;File=inline=1;size=3;preserveAspectRatio=0;doNotMoveCursor=1;width=6;height=2;:BAUG\x07\x1b\[20;1H$/);
  assert.doesNotMatch(first, /\x1b_G|a=p|p=\d/);

  const movedChart = { ...chart, row: 7, column: 3 };
  const second = placeIterm2Frame([movedChart], 20);
  assert.equal((second.match(/\x1b]1337;File=/g) ?? []).length, 1);
  assert.match(second, /^\x1b\[7;3H\x1b]1337;File=inline=1;size=3;preserveAspectRatio=0;doNotMoveCursor=1;width=8;height=3;:AQID\x07\x1b\[20;1H$/);
  assert.doesNotMatch(second, /BAUG|\x1b_G|a=p|p=\d/);
});

test("Kitty preview geometry reserves cells using measured character pixels", () => {
  assert.deepEqual(nativeImageGeometry(1_600, 900, 100, 40, { width: 8, height: 16 }), { columns: 60, rows: 17 });
});

test("Kitty preview placement keys change when same-path image data changes", () => {
  assert.notEqual(kittyPreviewPlacementKey("chart.png", new Uint8Array([1, 2]), 4, 8, 3), kittyPreviewPlacementKey("chart.png", new Uint8Array([1, 3]), 4, 8, 3));
});

test("readline output capture buffers bytes and forwards terminal geometry", () => {
  const terminal = { columns: 37, rows: 12, isTTY: true };
  const capture = new ReadlineOutputCapture(terminal);
  capture.write("prompt ");
  capture.write(Buffer.from("typed"));
  assert.equal(capture.columns, 37);
  assert.equal(capture.rows, 12);
  assert.equal(capture.isTTY, true);
  assert.equal(capture.takeCaptured(), "prompt typed");
  assert.equal(capture.takeCaptured(), "");
  terminal.columns = 300;
  assert.equal(capture.columns, 240);
  terminal.columns = 12;
  assert.equal(capture.columns, 20);
  let cursorCallbackCalled = false;
  capture.cursorTo(0, () => { cursorCallbackCalled = true; });
  capture.moveCursor(2, -1);
  assert.equal(cursorCallbackCalled, true);
  assert.equal(capture.takeCaptured(), "\x1b[1G\x1b[2C\x1b[1A");
  capture.end();
});

test("readline commit discards stale repaint bytes and restores the footer cursor", () => {
  const capture = new ReadlineOutputCapture({ columns: 80, rows: 24, isTTY: true });
  capture.write("stale");
  capture.discardCaptured();
  capture.write("readline repaint");
  const committed = composeReadlineFrame("full frame", capture.takeCaptured(), "footer row 1footer row 2");
  assert.equal(committed, "full framereadline repaint\x1b[sfooter row 1footer row 2\x1b[u");
  assert.ok(committed.indexOf("readline repaint") < committed.indexOf("\x1b[s"));
  assert.ok(committed.indexOf("\x1b[s") < committed.indexOf("footer row 1"));
  assert.equal(committed.endsWith("\x1b[u"), true);
  capture.end();
});

test("readline integration captures prompt repaint across wrapping and resize", () => {
  const terminal = { columns: 24, rows: 12, isTTY: true };
  const input = new PassThrough();
  const output = new ReadlineOutputCapture(terminal);
  const readline = createInterface({ input, output, terminal: true, historySize: 0 });
  readline.setPrompt("USER > ");
  readline.prompt(true);
  output.discardCaptured();
  readline.write("abcdefghijklmnopqrstuv");
  readline.write(null, { name: "left" });
  const firstRepaint = output.takeCaptured();
  assert.notEqual(firstRepaint, "");
  assert.equal(output.columns, 24);
  terminal.columns = 32;
  readline.prompt(true);
  const resizedRepaint = output.takeCaptured();
  const committed = composeReadlineFrame("full frame", resizedRepaint, "activitystatus");
  assert.notEqual(resizedRepaint, "");
  assert.equal(output.columns, 32);
  assert.ok(committed.indexOf(resizedRepaint) >= "full frame".length);
  assert.ok(committed.endsWith("\x1b[u"));
  readline.close();
  input.end();
  output.end();
});

test("readline left and right arrows move the prompt cursor", () => {
  const input = new PassThrough();
  const output = new ReadlineOutputCapture({ columns: 24, rows: 12, isTTY: true });
  const readline = createInterface({ input, output, terminal: true, historySize: 0 });
  readline.setPrompt("USER > ");
  readline.prompt(true);
  readline.write("abcd");
  readline.write(null, { name: "left" });
  readline.write(null, { name: "left" });
  assert.equal(readline.cursor, 2);
  readline.write(null, { name: "right" });
  readline.write("X");
  assert.equal(readline.line, "abcXd");
  assert.equal(readline.cursor, 4);
  readline.close();
  input.end();
  output.end();
});

test("frame scheduler coalesces redraw bursts and supports cancellation", () => {
  const queued: (() => void)[] = [];
  const cancelled: number[] = [];
  let commits = 0;
  let nextHandle = 0;
  const scheduler = createFrameScheduler(() => { commits += 1; }, (callback) => { queued.push(callback); return ++nextHandle; }, (handle) => { cancelled.push(handle); });
  scheduler.request(); scheduler.request(); scheduler.request();
  assert.equal(queued.length, 1);
  queued.shift()?.();
  assert.equal(commits, 1);
  scheduler.request();
  const canceledCallback = queued.at(-1);
  scheduler.cancel();
  assert.deepEqual(cancelled, [2]);
  canceledCallback?.();
  assert.equal(commits, 1);
  scheduler.request();
  const flushedCallback = queued.at(-1);
  scheduler.flush();
  assert.equal(commits, 2);
  flushedCallback?.();
  assert.equal(commits, 2);
  scheduler.request();
  queued.at(-1)?.();
  assert.equal(commits, 3);
});

test("wheel input requests one frame that paints the latest scroll state", () => {
  const queued: (() => void)[] = [];
  const paintedOffsets: number[] = [];
  let state = createTuiInteractionState();
  const scheduler = createFrameScheduler(() => { paintedOffsets.push(state.scrollOffset); }, (callback) => { queued.push(callback); return queued.length; }, () => {});
  for (let index = 0; index < 8; index += 1) {
    state = scrollHistoryOnWheel(state, "down", 100, 20, scheduler.request);
  }
  assert.equal(queued.length, 1);
  assert.deepEqual(paintedOffsets, []);
  queued[0]?.();
  assert.deepEqual(paintedOffsets, [8]);
});

test("history mode preserves manual browsing across live updates and geometry changes", () => {
  const atTopWithoutOverflow = navigateHistory(createTuiInteractionState(), "follow", "up", 5, 20);
  assert.equal(atTopWithoutOverflow.mode, "manual");
  assert.equal(reconcileHistoryNavigation(atTopWithoutOverflow.state, atTopWithoutOverflow.mode, 6, 20).mode, "manual");

  const browsing = { ...createTuiInteractionState(), scrollOffset: 70 };
  const afterLiveEvent = reconcileHistoryNavigation(browsing, "manual", 160, 20);
  assert.deepEqual(afterLiveEvent, { state: browsing, mode: "manual" });
  const afterResize = reconcileHistoryNavigation(afterLiveEvent.state, afterLiveEvent.mode, 100, 50);
  assert.deepEqual(afterResize, { state: { ...browsing, scrollOffset: 50 }, mode: "manual" });
});

test("execution wheel dispatch remains manual until the latest edge is explicitly reached", () => {
  const wheelUp = { action: "press" as const, button: 64, column: 1, row: 1 };
  assert.equal(shouldHandleMouseDuringExecution(wheelUp, false), true);
  assert.equal(shouldHandleMouseDuringExecution(wheelUp, true), false);
  let navigation = dispatchHistoryWheel(scrollHistory(createTuiInteractionState(), "bottom", 100, 20), "follow", wheelUp, 100, 20);
  assert.deepEqual(navigation?.mode, "manual");
  navigation = dispatchHistoryWheel(navigation?.state ?? createTuiInteractionState(), navigation?.mode ?? "follow", wheelUp, 100, 20);
  assert.deepEqual(navigation, { state: { ...createTuiInteractionState(), scrollOffset: 78 }, mode: "manual" });

  const beforeEdge = navigateHistory({ ...createTuiInteractionState(), scrollOffset: 78 }, "manual", "down", 100, 20);
  assert.equal(beforeEdge.mode, "manual");
  const atEdge = navigateHistory(beforeEdge.state, beforeEdge.mode, "down", 100, 20);
  assert.deepEqual(atEdge, { state: { ...createTuiInteractionState(), scrollOffset: 80 }, mode: "follow" });
  assert.equal(navigateHistory({ ...createTuiInteractionState(), scrollOffset: 12 }, "manual", "bottom", 100, 20).mode, "follow");
});

test("submission starts following but a later user scroll survives completion", () => {
  const submissionStart = navigateHistory({ ...createTuiInteractionState(), scrollOffset: 12 }, "manual", "bottom", 100, 20);
  assert.equal(submissionStart.mode, "follow");
  const userScroll = navigateHistory(submissionStart.state, submissionStart.mode, "up", 100, 20);
  const completion = reconcileHistoryNavigation(userScroll.state, userScroll.mode, 140, 20);
  assert.deepEqual(completion, { state: { ...createTuiInteractionState(), scrollOffset: 79 }, mode: "manual" });
});

test("permission confirmation commits before buffered approval input is consumed", () => {
  const sequence: string[] = [];
  commitPermissionBeforeBufferedInput(() => sequence.push("permission-card"), () => sequence.push("buffered-input"));
  assert.deepEqual(sequence, ["permission-card", "buffered-input"]);
});

test("status bar aggregates abbreviated token usage and remaining context", () => {
  const events: DurableEvent[] = [
    event("ProviderTurnFinished", { providerCallId: "turn-1", finishReason: "stop", inputTokens: 12_345, outputTokens: 4_567 }),
    event("ProviderTurnFinished", { providerCallId: "turn-2", finishReason: "stop", inputTokens: 2_000, outputTokens: 512 }, "turn-2"),
  ];
  const usage = summarizeTokenUsage(events, 128_000);
  assert.deepEqual(usage, { inputTokens: 14_345, outputTokens: 5_079, contextTokens: 2_000, contextWindow: 128_000 });
  const status = stripAnsi(renderStatusBar("/Users/example/finleet", usage, 80));
  assert.match(status, /finleet/);
  assert.match(status, /IN 14K/);
  assert.match(status, /OUT 5\.1K/);
  assert.match(status, /CTX 1\.6%/);
  assert.match(status, /REMAIN 126K/);
  assert.match(status, /NAVIGATION MODE/);
  assert.ok(status.length <= 80);
});

test("status context remaining clamps after the context window is exhausted", () => {
  const status = stripAnsi(renderStatusBar("/tmp", { inputTokens: 1, outputTokens: 2, contextTokens: 256, contextWindow: 128 }, 80));
  assert.match(status, /REMAIN 0/);
});

test("thinking effort is visible at the top and status bar remains responsive", () => {
  const effort = stripAnsi(renderThinkingEffort("high", true, 40));
  assert.match(effort, /THINKING EFFORT HIGH/);
  assert.match(effort, /VISIBILITY ON/);
  const narrow = stripAnsi(renderStatusBar("/Users/example/a-very-long-project-folder", { inputTokens: 1_500_000, outputTokens: 2_000_000, contextTokens: 96_000, contextWindow: 128_000 }, 24));
  assert.ok(narrow.length <= 24);
  assert.match(narrow, /1\.5M|1M/);
});

test("status fields stay single-line and terminal-safe", () => {
  const status = stripAnsi(renderStatusBar("/tmp/project\n\tSECRET", { inputTokens: 1, outputTokens: 2, contextTokens: 1, contextWindow: 128 }, 60));
  const effort = stripAnsi(renderThinkingEffort("high\n\tunsafe", true, 60));
  assert.equal(status.includes("\n"), false);
  assert.equal(status.includes("\t"), false);
  assert.equal(effort.includes("\n"), false);
  assert.equal(effort.includes("\t"), false);
});

test("status token abbreviations promote units after rounding", () => {
  const strip = (value: number): string => stripAnsi(renderStatusBar("/tmp", { inputTokens: value, outputTokens: 0, contextTokens: 0, contextWindow: 128 }, 80));
  assert.match(strip(999_999), /IN 1M/);
  assert.match(strip(999_999_999), /IN 1B/);
});

test("status bar is pinned to the final terminal row", () => {
  const footer = renderStatusBar("/tmp/project", { inputTokens: 1, outputTokens: 2, contextTokens: 1, contextWindow: 128 }, 40);
  const shortScreen = pinFooter(["header", "content"], footer, 6);
  const tallScreen = pinFooter(Array.from({ length: 40 }, (_, index) => `line-${index}`), footer, 6);
  assert.equal(shortScreen.length, 6);
  assert.equal(tallScreen.length, 6);
  assert.equal(shortScreen[5], footer);
  assert.equal(tallScreen[5], footer);
  assert.equal(shortScreen[2], "");
});

test("activity and status footers stay below the input and status is repainted last", () => {
  const frame = pinFooters(["header", "input"], ["activity", "status"], 6);
  assert.deepEqual(frame.slice(-2), ["activity", "status"]);
  const repaint = footerFrame(["activity", "status"], 6, 40);
  assert.match(repaint, /\x1b\[5;1H/);
  assert.match(repaint, /\x1b\[6;1H/);
  assert.ok(repaint.lastIndexOf("status") > repaint.lastIndexOf("activity"));
});

test("terminal board palette keeps structure, actions, and dark surfaces distinct", () => {
  assert.equal(tuiPalette.background, "\x1b[48;5;233m");
  assert.equal(tuiPalette.cyan, "\x1b[38;5;45m");
  assert.equal(tuiPalette.amber, "\x1b[38;5;214m");
  assert.equal(tuiPalette.foreground, "\x1b[38;5;255m");
  const request: PermissionRequest = { toolName: "fetch_page", requiredPermission: "web:read", scope: "example.test", arguments: { url: "https://example.test" }, reviewSteps: [] };
  const card = renderPermissionCard(request, 48, "allow-once").lines.join("\n");
  assert.match(card, /48;5;233m/);
  assert.match(card, /38;5;45m/);
  assert.match(card, /38;5;214m/);
  assert.match(stripAnsi(card), /\[1\] ALLOW ONCE/);
});

test("styled terminal rows remain bounded by their cell width", () => {
  const request: PermissionRequest = { toolName: "fetch_page", requiredPermission: "web:read", scope: "example.test", arguments: { url: "https://example.test" }, reviewSteps: ["Review the target before continuing"] };
  const rows = [
    ...renderPermissionCard(request, 20).lines,
    ...renderHarnessPanel([event("ToolCalled", { callId: "call-1", name: "a-very-long-tool-name", argumentsDigest: "digest", arguments: "{}" })], createTuiInteractionState(), 20).text.split("\n"),
    ...renderPromptBoard({ promptId: "prompt-1", prompt: "界🙂 a long user prompt", events: [], assistant: "A long agent answer" }, createTuiInteractionState(), 20).text.split("\n"),
    renderStatusBar("/Users/example/finleet", { inputTokens: 1_500_000, outputTokens: 2_000_000, contextTokens: 96_000, contextWindow: 128_000 }, 20),
  ];
  for (const row of rows) assert.ok(terminalCellWidth(stripAnsi(row)) <= 20, row);
});

test("board labels preserve USER, HARNESS, and AGENT hierarchy", () => {
  const board = renderPromptBoard({ promptId: "prompt-1", prompt: "hello", events: [event("ToolCalled", { callId: "call-1", name: "fetch_page", argumentsDigest: "digest", arguments: "{}" })], assistant: "answer" }, createTuiInteractionState(), 48);
  const rendered = stripAnsi(board.text);
  assert.equal(stripAnsi(renderConsolePrompt("hello", 48).join("\n")).trimEnd(), "USER > hello");
  assert.match(rendered, /HARNESS \/\/ TURN 1/);
  assert.match(rendered, /TOOL fetch_page/);
  assert.match(rendered, /AGENT \/\/ ASSISTANT/);
  assert.match(stripAnsi(renderStatusBar("/tmp/project", { inputTokens: 1, outputTokens: 2, contextTokens: 1, contextWindow: 128 }, 80)), /NAVIGATION MODE/);
});

test("submitted USER prompt is hidden once its durable board is present", () => {
  const boards = [{ promptId: "prompt-1", prompt: "same message", events: [], assistant: "" }];
  assert.equal(shouldRenderSubmittedPrompt("prompt-1", boards), false);
  assert.equal(shouldRenderSubmittedPrompt("prompt-2", boards), true);
  assert.equal(shouldRenderSubmittedPrompt(undefined, boards), false);
});

test("permission buttons clipped at the footer are not clickable", () => {
  const visible = offsetPermissionButtons([{ choice: "reject", label: "[3] Reject", left: 1, right: 10, row: 5 }], 0, 0);
  const footer = offsetPermissionButtons([{ choice: "reject", label: "[3] Reject", left: 1, right: 10, row: 6 }], 0, 0);
  assert.equal(visiblePermissionButtons(visible, 6).length, 1);
  assert.equal(visiblePermissionButtons(footer, 6).length, 0);
});

test("permission choices support keyboard navigation and bounded feedback", () => {
  assert.equal(permissionDecisionForKey("1", "reject"), "allow-once");
  assert.equal(permissionDecisionForKey("a", "allow-once"), "allow-job");
  assert.equal(permissionDecisionForKey("A", "allow-session"), "allow-job");
  assert.equal(permissionDecisionForKey("ArrowDown", "allow-once"), "allow-session");
  assert.equal(permissionDecisionForKey("ArrowDown", "allow-session"), "allow-job");
  assert.equal(permissionDecisionForKey("ArrowDown", "allow-job"), "reject");
  assert.equal(permissionDecisionForKey("ArrowDown", "reject"), "allow-once");
  assert.equal(permissionDecisionForKey("ArrowUp", "reject"), "allow-job");
  assert.equal(permissionDecisionForKey("k", "allow-job"), "allow-session");
  assert.equal(permissionDecisionForKey("j", "allow-session"), "allow-job");
  assert.equal(permissionDecisionForKey("h", "allow-once"), "reject");
  assert.equal(permissionDecisionForKey("Escape", "allow-once"), "reject");
  assert.equal(permissionDecisionForKey("Enter", "allow-job"), undefined);
  assert.equal(parsePermissionSuggestion("s please only inspect the page"), "please only inspect the page");
  assert.equal(parsePermissionSuggestion("reject without feedback"), undefined);
  assert.equal(parsePermissionSuggestion(`s ${"x".repeat(200)}`)?.length, 160);
});

test("permission input preserves approval tokens that arrive in one raw chunk", () => {
  assert.deepEqual(permissionInputTokens("1\r\n"), ["1", "\r\n"]);
  assert.deepEqual(permissionInputTokens("s inspect this\n"), ["s", " ", "i", "n", "s", "p", "e", "c", "t", " ", "t", "h", "i", "s", "\n"]);
  assert.deepEqual(permissionInputTokens("\x1b[A1\x1bOB"), ["\x1b[A", "1", "\x1bOB"]);
  assert.deepEqual(splitReadlineInput("quote FIN\r1\r"), { line: "quote FIN\r", remainder: "1\r" });
  assert.deepEqual(splitReadlineInput("partial input"), { line: "partial input", remainder: "" });
  assert.equal(shouldQueueMouseAfterSubmittedLine("quote FIN\r"), true);
  assert.equal(parseMouseEvents("quote FIN\r\x1b[<0;40;12M").length, 1);
  assert.deepEqual(splitMouseInputAfterSubmittedLine("quote FIN\r", "\x1b[<0;2;2Mquote FIN\r\x1b[<0;40;12M"), { before: "\x1b[<0;2;2Mquote FIN\r", after: "\x1b[<0;40;12M" });
  assert.equal(shouldQueueMouseAfterSubmittedLine("partial input"), false);
});

test("Shift+Enter decoding recognizes Kitty and xterm sequences across chunks", () => {
  assert.deepEqual(prepareShiftEnterInput("", "a\x1b[13;2ub"), { input: "a\x00b", pending: "" });
  assert.deepEqual(prepareShiftEnterInput("", "a\x1b[27;2;13~b"), { input: "a\x00b", pending: "" });
  const partial = prepareShiftEnterInput("", "a\x1b[13;");
  assert.deepEqual(partial, { input: "a", pending: "\x1b[13;" });
  assert.deepEqual(prepareShiftEnterInput(partial.pending, "2ub"), { input: "\x00b", pending: "" });
  assert.deepEqual(prepareShiftEnterInput("", "\r\n"), { input: "\r\n", pending: "" });
});

test("permission card exposes redacted review context and screen-offset button hitboxes", () => {
  const request: PermissionRequest = { toolName: "fetch_page", requiredPermission: "web:read", scope: "tool:fetch_page apiKey=secret", arguments: { url: "https://example.test", apiKey: "secret" }, reviewSteps: ["Review the redacted arguments", "Confirm the target"] };
  const card = renderPermissionCard(request, 60, "allow-session");
  assert.match(card.lines.join("\n"), /PERMISSION REQUIRED/);
  assert.match(stripAnsi(card.lines.join("\n")), /\[2\] ALLOW THIS SESSION/);
  assert.match(stripAnsi(card.lines.join("\n")), /\[A\] ALLOW THIS JOB/);
  assert.match(card.lines.join("\n"), /fetch_page/);
  assert.doesNotMatch(card.lines.join("\n"), /secret/);
  const offset = offsetPermissionButtons(card.buttons, 5, 7);
  const selected = offset.find((button) => button.choice === "allow-session");
  assert.ok(selected);
  if (selected !== undefined) assert.equal(permissionHitTest(selected.row, selected.left, offset), "allow-session");
  assert.equal(permissionMouseChoice("press", 1, selected?.row ?? 0, selected?.left ?? 0, offset), undefined);
  assert.equal(permissionMouseChoice("release", 0, selected?.row ?? 0, selected?.left ?? 0, offset), undefined);
  const job = offset.find((button) => button.choice === "allow-job");
  assert.ok(job);
  if (job !== undefined) assert.equal(permissionMouseChoice("press", 0, job.row, job.left, offset), "allow-job");
});

test("narrow permission cards keep every action visible and clickable", () => {
  const request: PermissionRequest = { toolName: "bash", requiredPermission: "shell:write", scope: "host", arguments: {}, reviewSteps: [] };
  const card = renderPermissionCard(request, 20);
  assert.equal(card.buttons.length, 4);
  assert.equal(new Set(card.buttons.map((button) => button.row)).size, 4);
  for (const button of card.buttons) {
    assert.ok(button.left >= 1 && button.right <= 20);
    assert.equal(permissionHitTest(button.row, button.left, card.buttons), button.choice);
    assert.match(stripAnsi(card.lines[button.row - 1] ?? ""), new RegExp(`\\[${button.choice === "allow-once" ? "1" : button.choice === "allow-session" ? "2" : button.choice === "allow-job" ? "A" : "3"}\\]`));
  }
});

test("wide permission cards keep all four actions bounded and clickable", () => {
  const request: PermissionRequest = { toolName: "bash", requiredPermission: "shell:write", scope: "host", arguments: {}, reviewSteps: [] };
  const card = renderPermissionCard(request, 100);
  assert.deepEqual(card.buttons.map((button) => button.choice), ["allow-once", "allow-session", "allow-job", "reject"]);
  assert.equal(new Set(card.buttons.map((button) => button.row)).size, 1);
  for (const button of card.buttons) {
    assert.ok(button.left >= 1 && button.right <= 100 && button.left <= button.right);
    assert.equal(permissionHitTest(button.row, button.left, card.buttons), button.choice);
  }
});

test("permission queue transition suppresses only a resolved admission", () => {
  const queued = [
    { admissionId: "admission-one" },
    { admissionId: "admission-two" },
    {},
    { admissionId: "admission-two" },
  ];
  const transition = transitionPermissionQueue({ admissionId: "admission-one" }, queued, { decision: "allow-job" }, new Set());
  assert.deepEqual(transition.queued, [{ admissionId: "admission-two" }, {}, { admissionId: "admission-two" }]);
  assert.equal(transition.resolvedAdmissions.has("admission-one"), true);
  assert.equal(isPermissionAdmissionLocallyResolved({ admissionId: "admission-one" }, transition.resolvedAdmissions), true);
  assert.equal(isPermissionAdmissionLocallyResolved({ admissionId: "admission-two" }, transition.resolvedAdmissions), false);
  assert.equal(isPermissionAdmissionLocallyResolved({}, transition.resolvedAdmissions), false);

  const malformed = transitionPermissionQueue({}, [{ admissionId: "admission-one" }, {}], { decision: "allow-job" }, new Set());
  assert.deepEqual(malformed.queued, [{ admissionId: "admission-one" }, {}]);
  assert.equal(malformed.resolvedAdmissions.has("undefined"), false);
});

test("permission metadata cannot inject rows, tabs, or credentials", () => {
  const request: PermissionRequest = { toolName: "fetch\n\tapiKey=TOOL_SECRET", requiredPermission: "web:read", scope: "target\n\taccessToken=SCOPE_SECRET", arguments: {}, reviewSteps: ["review\nnext"] };
  const card = renderPermissionCard(request, 60);
  assert.doesNotMatch(card.lines.join("\n"), /TOOL_SECRET|SCOPE_SECRET|\t/);
  assert.ok(card.lines.every((line) => !stripAnsi(line).includes("\t")));
});

test("permission session cache grants only the selected capability and resource scope", async () => {
  const cache = createPermissionSessionCache();
  const request: PermissionRequest = { toolName: "bash", requiredPermission: "shell:write", scope: "[REDACTED]", scopeKey: "scope-one", arguments: { command: "pwd" }, reviewSteps: [] };
  const otherScope: PermissionRequest = { ...request, scopeKey: "scope-two" };
  assert.equal(cache.has(request), false);
  assert.deepEqual(await cache.approver(request), { decision: "allow-once" });
  cache.grant(request);
  assert.equal(cache.has(request), true);
  assert.deepEqual(await cache.approver(request), { decision: "allow-session" });
  assert.equal(cache.has(otherScope), false);
  assert.deepEqual(await cache.approver(otherScope), { decision: "allow-once" });
});

test("permission button release is consumed without affecting later clicks", () => {
  assert.deepEqual(consumePermissionRelease(true, { action: "release", button: 0 }), { handled: false, consumed: true });
  assert.deepEqual(consumePermissionRelease(true, { action: "press", button: 0 }), { handled: true, consumed: false });
  assert.deepEqual(consumePermissionRelease(false, { action: "release", button: 0 }), { handled: false, consumed: false });
  assert.deepEqual(consumePermissionRelease(true, { action: "release", button: 1 }), { handled: true, consumed: false });
});

test("renderMarkdown formats useful Markdown without retaining model controls", () => {
  const rendered = renderMarkdown("# Heading\n\n- **bold** and *emphasis* with `code`\n\u001b[31munsafe");
  assert.match(rendered, /Heading/);
  assert.match(rendered, /• /);
  assert.match(rendered, /bold/);
  assert.match(rendered, /unsafe/);
  assert.equal(rendered.includes("\u001b[31m"), false);
});

test("renderMarkdown emits OSC-8 only for credential-free HTTP(S) targets", () => {
  const rendered = renderMarkdown("[Docs](https://example.test/docs) and https://example.test/plain");
  assert.equal((rendered.match(/\u001b]8;;https:\/\/example\.test/g) ?? []).length, 2);
  const unsafe = renderMarkdown("[Credentials](https://user:secret@example.test/) [Bad](javascript:alert(1))");
  assert.equal(unsafe.includes("\u001b]8;;"), false);
  assert.match(unsafe, /Credentials/);
  assert.match(unsafe, /Bad/);
});

test("renderMarkdown preserves visible fenced code and neutralizes OSC controls", () => {
  const rendered = renderMarkdown("```ts\nhttps://not-a-link.test\n```\n\u001b]8;;https://evil.test\u001b\\label");
  assert.match(rendered, /https:\/\/not-a-link\.test/);
  assert.equal(rendered.includes("evil.test"), false);
  assert.equal(rendered.includes("\u001b]8;;https://evil.test"), false);
});

test("renderMarkdown renders bounded inline and display LaTeX", () => {
  const rendered = renderMarkdown(String.raw`Inline \(x^2 + \alpha\) and display $$\frac{a}{b}$$.`);
  assert.match(rendered, /x²/);
  assert.match(rendered, /α/);
  assert.match(rendered, /───/);
  assert.match(rendered, /a/);
  assert.match(rendered, /b/);
});

test("renderMarkdown renders single-dollar math without mistaking currency for math", () => {
  const rendered = renderMarkdown(String.raw`Cost $5 and $6; result $x^2$.`);
  assert.match(rendered, /Cost \$5 and \$6/);
  assert.match(rendered, /result x²/);
});

test("renderMarkdown supports display math across normal lines", () => {
  const rendered = renderMarkdown(String.raw`Before
$$
\frac{a}{b}
$$
After`);
  assert.match(rendered, /───/);
  assert.match(rendered, /Before/);
  assert.match(rendered, /After/);
});

test("renderMarkdown keeps LaTeX inside fenced code literal", () => {
  const rendered = renderMarkdown("```latex\n\\frac{a}{b}\n```");
  assert.match(rendered, /\\frac\{a\}\{b\}/);
  assert.equal(rendered.includes("───"), false);
});

test("renderMarkdown safely falls back for malformed or oversized LaTeX", () => {
  const malformed = String.raw`Bad \(\frac{a}\) expression`;
  assert.match(renderMarkdown(malformed), /\\frac\{a\}/);

  const oversized = `$$${"x".repeat(2_049)}$$`;
  assert.equal(renderMarkdown(oversized).includes("x".repeat(2_049)), true);
});

test("renderMarkdown keeps rendered LaTeX terminal-safe", () => {
  const rendered = renderMarkdown(String.raw`\(\text{safe}\)` + "\u001b[31m");
  assert.equal(rendered.includes("\u001b[31m"), false);
  assert.match(rendered, /safe/);
});

test("copied rendered math restores its original LaTeX source", () => {
  assert.equal(restoreLatexSources("The result is x².", String.raw`The result is \(x^2\).`), String.raw`The result is \(x^2\).`);
  assert.equal(restoreLatexSources("Cost $5 and $6", "Cost $5 and $6"), "Cost $5 and $6");
});

test("copying a rendered Fibonacci display restores its multiline LaTeX source", () => {
  const source = String.raw`The Fibonacci sequence is defined by:

\[
F_0 = 0,\qquad F_1 = 1,\qquad F_n = F_{n-1} + F_{n-2}\quad(n\ge 2)
\]

The closed-form expression (Binet’s formula) is:

\[
F_n = \frac{\varphi^n - \psi^n}{\sqrt{5}},
\qquad
\varphi = \frac{1+\sqrt{5}}{2},
\qquad
\psi = \frac{1-\sqrt{5}}{2}
\]`;
  const board = renderPromptBoard({ promptId: "fibonacci", prompt: "show Fibonacci", events: [], assistant: source }, createTuiInteractionState(), 80);
  const lines = board.text.split("\n");
  const renderedSelection = extractSelection(lines, {
    anchor: { row: 1, column: 1 },
    focus: { row: lines.length, column: 80 },
  }, 1, board.selectableRows);
  const copied = restoreLatexSources(renderedSelection, source);
  assert.equal(copied.includes(source), true);
  assert.doesNotMatch(copied, /[│┌┐└┘─]/);
});

test("copying from the middle of a LaTeX image restores boundary formulas", () => {
  const firstFormula = String.raw`\[
F_n = \frac{\varphi^n - \psi^n}{\sqrt{5}}
\]`;
  const secondFormula = String.raw`\[
\varphi = \frac{1+\sqrt{5}}{2},
\qquad
\psi = \frac{1-\sqrt{5}}{2}
\]`;
  const source = `${firstFormula}\n\nwhere\n\n${secondFormula}.`;
  const board = renderPromptBoard({ promptId: "partial-fibonacci", prompt: "show formula", events: [], assistant: source }, createTuiInteractionState(), 80);
  const lines = board.text.split("\n");
  const plainLines = lines.map(stripAnsi);
  const firstRow = plainLines.findIndex((line) => line.includes("Fₙ ="));
  const lastRow = board.selectableRows.findLastIndex((row) => typeof row === "object");
  assert.ok(firstRow >= 0);
  assert.ok(lastRow > firstRow);
  const firstColumn = (plainLines[firstRow]?.indexOf("Fₙ =") ?? -1) + 1;
  const renderedSelection = extractSelection(lines, {
    anchor: { row: firstRow + 1, column: firstColumn },
    focus: { row: lastRow + 1, column: 80 },
  }, 1, board.selectableRows);
  const copied = restoreLatexSources(renderedSelection, source);
  assert.match(copied, /^\\\[/);
  assert.equal(copied.includes(firstFormula), true);
  assert.equal(copied.includes("where"), true);
  assert.equal(copied.includes(secondFormula), true);
  assert.doesNotMatch(copied, /[╭─]/);
});

test("copied math fails closed when rendered source mapping is ambiguous", () => {
  assert.equal(
    restoreLatexSources("Literal x² before x²", String.raw`Literal x² before \(x^2\)`),
    "Literal x² before x²",
  );
  assert.equal(
    restoreLatexSources("x² x²", String.raw`\(x^2\) $x^2$`),
    "x² x²",
  );
});

test("harness rows are pure, selectable, and collapse through immutable state", () => {
  const events: DurableEvent[] = [
    event("ToolCalled", { callId: "call-1", name: "fetch_page", argumentsDigest: "digest", arguments: '{"url":"https://example.test"}' }),
    event("GraphTransition", { runId: "run-1", planId: "plan-1", planVersion: 1, nodeId: "finish", sequence: 1, outcome: "finished", inputDigest: "digest" }),
  ];
  const flows = harnessFlows(events);
  assert.equal(flows.length, 2);
  assert.equal(hitTestHarnessRow(2, [{ flowId: flows[0]?.id ?? "", top: 1, bottom: 1 }]), undefined);
  assert.equal(hitTestHarnessRow(1, [{ flowId: flows[0]?.id ?? "", top: 1, bottom: 1 }]), flows[0]?.id);
  const expanded = toggleHarnessFlow(createTuiInteractionState(), flows[0]?.id ?? "", flows);
  assert.equal(expanded.expanded.has(flows[0]?.id ?? ""), true);
  const collapsed = toggleHarnessFlow(expanded, flows[0]?.id ?? "", flows);
  assert.equal(collapsed.expanded.has(flows[0]?.id ?? ""), false);
  assert.match(stripAnsi(renderHarnessPanel(events, expanded).text), /Fetch HTTPS https:\/\/example\.test\//);
});

test("harness renders a durable chart tool result beneath its tool event", () => {
  const chartResult = JSON.stringify({ kind: "line-chart", title: "FIN", points: [{ label: "open", value: 10 }, { label: "close", value: 14 }] });
  const events: DurableEvent[] = [
    event("ToolCalled", { callId: "chart-call", name: "render_chart", argumentsDigest: "digest", arguments: "{}" }),
    event("ToolSucceeded", { callId: "chart-call", preview: chartResult, truncated: false, result: chartResult, resultTruncated: false }),
  ];
  const rendered = stripAnsi(renderHarnessPanel(events, createTuiInteractionState(), 48).text);
  assert.match(rendered, /TOOL RESULT chart-call/);
  assert.match(rendered, /▌ FIN/);
  assert.match(rendered, /●/);
  assert.match(rendered, /open\s+close/);
});

test("harness renders a full 24-candle durable K-line result without truncation", () => {
  const chart = {
    kind: "kline-chart" as const,
    title: "BTCUSDT 30m",
    candles: Array.from({ length: 24 }, (_unused, index) => ({ label: `2026-01-02 ${String(9 + Math.floor(index / 2)).padStart(2, "0")}:${index % 2 === 0 ? "30" : "00"}`, open: 97.125 + index * 0.1875, high: 97.8125 + index * 0.203125, low: 96.9375 + index * 0.15625, close: 97.4375 + index * 0.171875, volume: 12034.567 + index * 137.891 })),
  };
  const result = JSON.stringify(chart);
  assert.ok(result.length > 512);
  assert.ok(result.length <= MAX_TOOL_RESULT);
  const events: DurableEvent[] = [
    event("ToolCalled", { callId: "chart-call", name: "render_chart", argumentsDigest: "digest", arguments: "{}" }),
    event("ToolSucceeded", { callId: "chart-call", preview: result.slice(0, 256), truncated: true, result, resultTruncated: false }),
  ];
  const rendered = stripAnsi(renderHarnessPanel(events, createTuiInteractionState(), 48).text);
  assert.match(rendered, /OHLCV/);
  assert.match(rendered, /C:/);
  assert.equal(rendered.split("\n").every((line) => line.length <= 48), true);
});

test("harness renders every new durable chart descriptor and fails closed for malformed results", () => {
  const charts = [
    { kind: "kline-chart" as const, title: "OHLCV", candles: [{ label: "A", open: 1, high: 3, low: 0, close: 2, volume: 4 }, { label: "B", open: 2, high: 4, low: 1, close: 3, volume: 5 }] },
    { kind: "heatmap-chart" as const, title: "FLOW", rows: ["Buy", "Sell"], columns: ["A", "B"], values: [[1, null], [2, 3]] },
    { kind: "pie-chart" as const, title: "MIX", slices: [{ label: "A", value: 2 }, { label: "B", value: 1 }] },
  ];
  for (const chart of charts) {
    const chartResult = JSON.stringify(chart);
    const events: DurableEvent[] = [event("ToolCalled", { callId: "chart-call", name: "render_chart", argumentsDigest: "digest", arguments: "{}" }), event("ToolSucceeded", { callId: "chart-call", preview: chartResult, truncated: false, result: chartResult, resultTruncated: false })];
    const rendered = stripAnsi(renderHarnessPanel(events, createTuiInteractionState(), 48).text);
    assert.match(rendered, new RegExp(`▌ ${chart.title}`));
    assert.match(rendered, chart.kind === "kline-chart" ? /OHLCV/ : chart.kind === "heatmap-chart" ? /heatmap/ : /pie/);
  }
  for (const result of ["not-json", JSON.stringify({ kind: "pie-chart", title: "BAD", slices: [{ label: "x", value: -1 }] })]) {
    const events: DurableEvent[] = [event("ToolSucceeded", { callId: "chart-call", preview: result, truncated: false, result, resultTruncated: false })];
    const rendered = stripAnsi(renderHarnessPanel(events, createTuiInteractionState(), 48).text);
    assert.equal(rendered.includes("▌ BAD"), false);
    assert.equal(rendered.includes("▌"), false);
  }
});

test("assistant canvas projects a chart result over a chart-only assistant marker", () => {
  const chartResult = JSON.stringify({ kind: "line-chart", title: "FIN", points: [{ label: "open", value: 10 }, { label: "close", value: 14 }] });
  const events: DurableEvent[] = [
    event("ToolCalled", { callId: "chart-call", name: "render_chart", argumentsDigest: "digest", arguments: "{}" }),
    event("ToolSucceeded", { callId: "chart-call", preview: chartResult, truncated: false, result: chartResult, resultTruncated: false }),
  ];
  const rendered = renderPromptBoard({ promptId: "prompt-1", prompt: "show GOOG", events, assistant: "!GOOG chart" }, createTuiInteractionState(), 48).text;
  const assistant = rendered.slice(rendered.indexOf("AGENT // ASSISTANT"));
  assert.equal(assistant.includes("!GOOG chart"), false);
  assert.match(assistant, /▌ FIN/);
  assert.match(assistant, /●/);
  assert.match(assistant, /\x1b\[38;5;24m/);
});

test("assistant canvas preserves paragraph breaks in ordinary prose", () => {
  const rendered = stripAnsi(renderPromptBoard({ promptId: "prompt-1", prompt: "hello", events: [], assistant: "first\n\nsecond" }, createTuiInteractionState(), 48).text);
  const lines = rendered.split("\n");
  const first = lines.findIndex((line) => line.includes("first"));
  const second = lines.findIndex((line) => line.includes("second"));
  assert.ok(first >= 0);
  assert.equal(second - first, 2);
});

test("harness omits a chart whose durable result was truncated", () => {
  const chartResult = JSON.stringify({ kind: "line-chart", title: "FIN", points: [{ label: "open", value: 10 }, { label: "close", value: 14 }] });
  const events: DurableEvent[] = [
    event("ToolCalled", { callId: "chart-call", name: "render_chart", argumentsDigest: "digest", arguments: "{}" }),
    event("ToolSucceeded", { callId: "chart-call", preview: chartResult, truncated: false, result: chartResult, resultTruncated: true }),
  ];
  const rendered = stripAnsi(renderHarnessPanel(events, createTuiInteractionState(), 48).text);
  assert.match(rendered, /TOOL RESULT chart-call/);
  assert.equal(rendered.includes("▌ FIN"), false);
});

test("harness keeps a chart intact in a narrow panel", () => {
  const chartResult = JSON.stringify({ kind: "line-chart", title: "FIN", points: [{ label: "open", value: -1_000_000_000 }, { label: "close", value: 1_000_000_000 }] });
  const events: DurableEvent[] = [
    event("ToolCalled", { callId: "chart-call", name: "render_chart", argumentsDigest: "digest", arguments: "{}" }),
    event("ToolSucceeded", { callId: "chart-call", preview: chartResult, truncated: false, result: chartResult, resultTruncated: false }),
  ];
  const rendered = stripAnsi(renderHarnessPanel(events, createTuiInteractionState(), 20).text);
  assert.equal(rendered.split("\n").every((line) => line.length <= 20), true);
  assert.match(rendered, /e\+/);
});

test("harness hitboxes align with the first rendered item row", () => {
  const tool = event("ToolCalled", { callId: "call-1", name: "fetch_page", argumentsDigest: "digest", arguments: "{}" });
  const board = renderPromptBoard({ promptId: "prompt-1", prompt: "hello", events: [tool], assistant: "" }, createTuiInteractionState(), 48);
  const itemRow = board.text.split("\n").findIndex((line) => line.includes("fetch_page")) + 1;
  assert.ok(itemRow > 0);
  assert.equal(board.hitBoxes[0]?.top, itemRow);
  assert.equal(hitTestHarnessRow(itemRow, board.hitBoxes), tool.id);
  assert.equal(hitTestHarnessRow(itemRow - 1, board.hitBoxes), undefined);
});

test("fetch intent labels are safe and compact details pair by exact call ID", () => {
  const tool = event("ToolCalled", { callId: "fetch-1", name: "fetch_page", argumentsDigest: "digest", arguments: '{"url":"https://example.test/path?hl=en#fragment"}' }, "fetch-event");
  const success = event("ToolSucceeded", { callId: "fetch-1", preview: "ok", truncated: false, result: JSON.stringify({ status: 200, content: "Readable page content" }), resultTruncated: false }, "success-event");
  const board = renderPromptBoard({ promptId: "prompt-1", prompt: "fetch", events: [tool, success], assistant: "" }, toggleHarnessFlow(createTuiInteractionState(), tool.id, harnessFlows([tool, success])), 64);
  const plain = stripAnsi(board.text);
  assert.match(plain, /Fetch HTTPS https:\/\/example\.test\/path/);
  assert.doesNotMatch(plain, /[?]hl=en|fragment/);
  assert.match(plain, /QUERY hl=en/);
  assert.match(plain, /RESULT 200 Readable page content/);
  assert.equal(board.hitBoxes.some((box) => box.flowId === tool.id), true);
  assert.equal(board.hitBoxes.some((box) => box.flowId === success.id), true);
});

test("Fetch intents promote the exact pair into one expandable header in both renderers", () => {
  const intent = event("HarnessThinking", { runId: "run-1", step: "Fetch an HTTPS page", text: "Use Obscura to inspect the page." }, "fetch-intent");
  const tool = event("ToolCalled", { callId: "fetch-1", name: "fetch_page", argumentsDigest: "digest", arguments: '{"url":"https://example.test/path?hl=en#fragment"}' }, "fetch-event");
  const success = event("ToolSucceeded", { callId: "fetch-1", preview: "ok", truncated: false, result: JSON.stringify({ status: 200, content: "Readable page content" }), resultTruncated: false }, "success-event");
  const sibling = event("GraphTransition", { runId: "run-1", planId: "plan-1", planVersion: 1, nodeId: "finish", sequence: 1, outcome: "finished", inputDigest: "digest" }, "sibling-event");
  const events = [intent, tool, success, sibling];
  const headerId = "intent:fetch-intent";
  const groups = harnessGroups(events);
  const group = groups[0];
  assert.ok(group && "header" in group);
  if (group !== undefined && "header" in group) {
    assert.equal(group.id, headerId);
    assert.equal(group.promotedFetch?.id, tool.id);
    assert.equal(group.promotedFetchResult?.id, success.id);
    assert.deepEqual(group.children.map((child) => child.id), [sibling.id]);
  }

  const collapsed = renderPromptBoard({ promptId: "prompt-1", prompt: "fetch", events, assistant: "" }, createTuiInteractionState(), 64);
  const collapsedText = stripAnsi(collapsed.text);
  assert.match(collapsedText, /INTENT Fetch HTTPS https:\/\/example\.test\/path/);
  assert.doesNotMatch(collapsedText, /INTENT Fetch an HTTPS page/);
  assert.doesNotMatch(collapsedText, /hl=en|fragment|TOOL fetch_page|TOOL RESULT fetch-1/);
  assert.deepEqual(collapsed.hitBoxes.map((box) => box.flowId), [headerId]);
  assert.equal(hitTestHarnessRow(collapsed.hitBoxes[0]?.top ?? 0, collapsed.hitBoxes), headerId);

  const expandedState = toggleHarnessFlow(createTuiInteractionState(), headerId, visibleHarnessItems(events, new Set()));
  assert.equal(expandedState.expanded.has(headerId), true);
  const expanded = renderPromptBoard({ promptId: "prompt-1", prompt: "fetch", events, assistant: "" }, expandedState, 64);
  const expandedText = stripAnsi(expanded.text);
  assert.match(expandedText, /QUERY hl=en/);
  assert.match(expandedText, /RESULT 200 Readable page content/);
  assert.match(expandedText, /GRAPH finish/);
  assert.doesNotMatch(expandedText, /TOOL fetch_page|TOOL RESULT fetch-1/);
  assert.deepEqual(expanded.hitBoxes.map((box) => box.flowId), [headerId, sibling.id]);

  const legacy = stripAnsi(renderHarnessPanel(events, expandedState, 64).text);
  assert.match(legacy, /Fetch HTTPS https:\/\/example\.test\/path/);
  assert.match(legacy, /QUERY hl=en/);
  assert.match(legacy, /RESULT 200 Readable page content/);
  assert.doesNotMatch(legacy, /TOOL fetch_page|TOOL RESULT fetch-1/);
});

test("Fetch intent promotion requires a Fetch intent and scopes duplicate call IDs to each group", () => {
  const unrelatedIntent = event("HarnessThinking", { runId: "run-unrelated", step: "Analyze market data", text: "Use available evidence." }, "unrelated-intent");
  const unrelatedTool = event("ToolCalled", { callId: "unrelated-fetch", name: "fetch_page", argumentsDigest: "d", arguments: '{"url":"https://unrelated.example/path"}' }, "unrelated-tool");
  const unrelatedResult = event("ToolSucceeded", { callId: "unrelated-fetch", preview: "ok", truncated: false, result: JSON.stringify({ status: 200, content: "unrelated result" }), resultTruncated: false }, "unrelated-result");
  const unrelatedEvents = [unrelatedIntent, unrelatedTool, unrelatedResult];
  const unrelatedGroup = harnessGroups(unrelatedEvents)[0];
  assert.ok(unrelatedGroup && "header" in unrelatedGroup);
  if (unrelatedGroup !== undefined && "header" in unrelatedGroup) assert.equal(unrelatedGroup.promotedFetch, undefined);
  const unrelated = stripAnsi(renderPromptBoard({ promptId: "unrelated", prompt: "analyze", events: unrelatedEvents, assistant: "" }, createTuiInteractionState(), 64).text);
  assert.match(unrelated, /INTENT Analyze market data/);
  assert.doesNotMatch(unrelated, /Fetch HTTPS https:\/\/unrelated\.example/);

  const firstIntent = event("HarnessThinking", { runId: "run-first", step: "Fetch an HTTPS page with Obscura", text: "Fetch the first page." }, "first-intent");
  const firstTool = event("ToolCalled", { callId: "shared-call", name: "fetch_page", argumentsDigest: "d1", arguments: '{"url":"https://first.example/a?view=one"}' }, "first-tool");
  const firstResult = event("ToolSucceeded", { callId: "shared-call", preview: "first", truncated: false, result: JSON.stringify({ status: 200, content: "first scoped result" }), resultTruncated: false }, "first-result");
  const secondIntent = event("HarnessThinking", { runId: "run-second", step: "Fetch an HTTPS page with Obscura", text: "Fetch the second page." }, "second-intent");
  const secondTool = event("ToolCalled", { callId: "shared-call", name: "fetch_page", argumentsDigest: "d2", arguments: '{"url":"https://second.example/b?view=two"}' }, "second-tool");
  const secondResult = event("ToolSucceeded", { callId: "shared-call", preview: "second", truncated: false, result: JSON.stringify({ status: 201, content: "second scoped result" }), resultTruncated: false }, "second-result");
  const events = [firstIntent, firstTool, firstResult, secondIntent, secondTool, secondResult];
  const state = { ...createTuiInteractionState(), expanded: new Set(["intent:first-intent", "intent:second-intent"]) };
  const rendered = stripAnsi(renderPromptBoard({ promptId: "scoped", prompt: "fetch both", events, assistant: "" }, state, 72).text);
  assert.match(rendered, /Fetch HTTPS https:\/\/first\.example\/a/);
  assert.match(rendered, /QUERY view=one[\s\S]*RESULT 200 first scoped result/);
  assert.match(rendered, /Fetch HTTPS https:\/\/second\.example\/b/);
  assert.match(rendered, /QUERY view=two[\s\S]*RESULT 201 second scoped result/);
  assert.doesNotMatch(rendered, /RESULT unavailable/);
});

test("Fetch intent promotion appears before completion and fails closed for unsafe or ambiguous calls", () => {
  const pendingIntent = event("HarnessThinking", { runId: "pending", step: "Fetch an HTTPS page with Obscura", text: "Fetch the page." }, "pending-intent");
  const pendingTool = event("ToolCalled", { callId: "pending", name: "fetch_page", argumentsDigest: "d", arguments: '{"url":"https://pending.example/path?view=full"}' }, "pending-tool");
  const pendingEvents = [pendingIntent, pendingTool];
  const pendingHeaderId = "intent:pending-intent";
  const collapsedPending = stripAnsi(renderPromptBoard({ promptId: "pending", prompt: "fetch", events: pendingEvents, assistant: "" }, createTuiInteractionState(), 64).text);
  assert.match(collapsedPending, /INTENT Fetch HTTPS https:\/\/pending\.example\/path/);
  assert.doesNotMatch(collapsedPending, /INTENT Fetch an HTTPS page|view=full|TOOL fetch_page/);
  const expandedPending = stripAnsi(renderPromptBoard({ promptId: "pending", prompt: "fetch", events: pendingEvents, assistant: "" }, { ...createTuiInteractionState(), expanded: new Set([pendingHeaderId]) }, 64).text);
  assert.match(expandedPending, /QUERY view=full/);
  assert.match(expandedPending, /RESULT unavailable/);

  const cases: readonly [string, DurableEvent[]][] = [
    ["unsafe", [event("ToolCalled", { callId: "unsafe", name: "fetch_page", argumentsDigest: "d", arguments: '{"url":"https://example.test/?apiKey=secret"}' })]],
    ["duplicate-calls", [event("ToolCalled", { callId: "duplicate-1", name: "fetch_page", argumentsDigest: "d", arguments: '{"url":"https://example.test/"}' }), event("ToolCalled", { callId: "duplicate-2", name: "fetch_page", argumentsDigest: "d", arguments: '{"url":"https://example.test/"}' }), event("ToolSucceeded", { callId: "duplicate-1", preview: "one", truncated: false, result: JSON.stringify({ content: "one" }), resultTruncated: false })]],
  ];
  for (const [name, pair] of cases) {
    const intent = event("HarnessThinking", { runId: name, step: "Fetch an HTTPS page", text: "Use the fetch tool." }, `${name}-intent`);
    const events = [intent, ...pair];
    const headerId = `intent:${intent.id}`;
    const rendered = stripAnsi(renderPromptBoard({ promptId: name, prompt: "fetch", events, assistant: "" }, createTuiInteractionState(), 64).text);
    assert.match(rendered, /INTENT Fetch an HTTPS page/);
    assert.doesNotMatch(rendered, /Fetch HTTPS https:\/\/example\.test/);
    const expanded = renderPromptBoard({ promptId: name, prompt: "fetch", events, assistant: "" }, { ...createTuiInteractionState(), expanded: new Set([headerId]) }, 64);
    assert.match(stripAnsi(expanded.text), /INTENT Fetch an HTTPS page/);
  }
});

test("promoted Fetch headers stay width-bounded and keep hitboxes on the header row", () => {
  const intent = event("HarnessThinking", { runId: "run-width", step: "Fetch an HTTPS page", text: "fetch" }, "width-intent");
  const tool = event("ToolCalled", { callId: "width-fetch", name: "fetch_page", argumentsDigest: "d", arguments: '{"url":"https://example.test/a?hl=en"}' }, "width-tool");
  const success = event("ToolSucceeded", { callId: "width-fetch", preview: "ok", truncated: false, result: JSON.stringify({ status: 200, content: "bounded" }), resultTruncated: false }, "width-result");
  const events = [intent, tool, success];
  const headerId = `intent:${intent.id}`;
  const state = { ...createTuiInteractionState(), expanded: new Set([headerId]) };
  for (const width of [20, 24, 40, 48, 64]) {
    const legacy = renderHarnessPanel(events, state, width);
    assert.equal(legacy.text.split("\n").every((line) => terminalCellWidth(stripAnsi(line)) <= width), true, `legacy width ${width}`);
    const legacyRow = legacy.text.split("\n").findIndex((line) => stripAnsi(line).includes("INTENT")) + 1;
    assert.ok(legacyRow > 0, `legacy header width ${width}`);
    assert.equal(hitTestHarnessRow(legacyRow, legacy.hitBoxes), headerId, `legacy hitbox width ${width}`);

    const board = renderPromptBoard({ promptId: "prompt-width", prompt: "fetch", events, assistant: "" }, state, width);
    assert.equal(board.text.split("\n").every((line) => terminalCellWidth(stripAnsi(line)) <= width), true, `board width ${width}`);
    const boardRow = board.text.split("\n").findIndex((line) => stripAnsi(line).includes("INTENT")) + 1;
    assert.ok(boardRow > 0, `board header width ${width}`);
    assert.equal(hitTestHarnessRow(boardRow, board.hitBoxes), headerId, `board hitbox width ${width}`);
  }
});

test("fetch details fail closed for unsafe, missing, ambiguous, malformed, and truncated data", () => {
  const cases: readonly [string, DurableEvent[]][] = [
    ["unsafe", [event("ToolCalled", { callId: "unsafe", name: "fetch_page", argumentsDigest: "d", arguments: '{"url":"https://example.test/?apiKey=secret"}' })]],
    ["missing", [event("ToolCalled", { callId: "missing", name: "fetch_page", argumentsDigest: "d", arguments: '{"url":"https://example.test/"}' })]],
    ["ambiguous", [event("ToolCalled", { callId: "ambiguous", name: "fetch_page", argumentsDigest: "d", arguments: '{"url":"https://example.test/"}' }), event("ToolSucceeded", { callId: "ambiguous", preview: "one", truncated: false, result: JSON.stringify({ content: "one" }), resultTruncated: false }), event("ToolSucceeded", { callId: "ambiguous", preview: "two", truncated: false, result: JSON.stringify({ content: "two" }), resultTruncated: false })]],
    ["malformed", [event("ToolCalled", { callId: "malformed", name: "fetch_page", argumentsDigest: "d", arguments: '{"url":"https://example.test/"}' }), event("ToolSucceeded", { callId: "malformed", preview: "bad", truncated: false, result: "not-json", resultTruncated: false })]],
    ["truncated", [event("ToolCalled", { callId: "truncated", name: "fetch_page", argumentsDigest: "d", arguments: '{"url":"https://example.test/"}' }), event("ToolSucceeded", { callId: "truncated", preview: "partial", truncated: false, result: JSON.stringify({ content: "secret page" }), resultTruncated: true })]],
  ];
  for (const [callId, events] of cases) {
    const tool = events[0];
    assert.ok(tool !== undefined);
    const state = toggleHarnessFlow(createTuiInteractionState(), tool.id, harnessFlows(events));
    const rendered = stripAnsi(renderHarnessPanel(events, state, 40).text);
    if (callId === "unsafe") {
      assert.match(rendered, /TOOL fetch_page/);
      assert.match(rendered, /QUERY unavailable/);
      assert.match(rendered, /RESULT unavailable/);
      assert.doesNotMatch(rendered, /argumentsDigest|apiKey/);
      assert.doesNotMatch(rendered, /secret/);
    } else {
      assert.match(rendered, /RESULT unavailable/);
    }
  }
});

test("fetch compact panels stay bounded at supported narrow widths", () => {
  const tool = event("ToolCalled", { callId: "fetch-width", name: "fetch_page", argumentsDigest: "d", arguments: '{"url":"https://example.test/a?hl=en"}' });
  const success = event("ToolSucceeded", { callId: "fetch-width", preview: "ok", truncated: false, result: JSON.stringify({ status: 200, content: "bounded result content" }), resultTruncated: false });
  const events = [tool, success];
  const state = toggleHarnessFlow(createTuiInteractionState(), tool.id, harnessFlows(events));
  for (const width of [20, 24, 40, 48, 64]) {
    const rendered = renderHarnessPanel(events, state, width);
    assert.equal(rendered.text.split("\n").every((line) => terminalCellWidth(stripAnsi(line)) <= width), true, `width ${width}`);
    const itemRow = rendered.text.split("\n").findIndex((line) => stripAnsi(line).includes("Fetch HTTPS")) + 1;
    assert.equal(hitTestHarnessRow(itemRow, rendered.hitBoxes), tool.id, `hitbox width ${width}`);
  }
});

test("legacy harness panel hitboxes align in both scroll positions", () => {
  const first = event("ToolCalled", { callId: "call-1", name: "first_tool", argumentsDigest: "digest", arguments: "{}" }, "tool-1");
  const second = event("ToolCalled", { callId: "call-2", name: "second_tool", argumentsDigest: "digest", arguments: "{}" }, "tool-2");
  const flows = [first, second];
  const topPanel = renderHarnessPanel(flows, createTuiInteractionState(), 48);
  const topItemRow = topPanel.text.split("\n").findIndex((line) => line.includes("first_tool")) + 1;
  assert.ok(topItemRow > 0);
  assert.equal(topPanel.hitBoxes[0]?.top, topItemRow);
  assert.equal(hitTestHarnessRow(topItemRow, topPanel.hitBoxes), first.id);
  const scrolledPanel = renderHarnessPanel(flows, { ...createTuiInteractionState(), scrollOffset: 1 }, 48);
  const scrolledItemRow = scrolledPanel.text.split("\n").findIndex((line) => line.includes("second_tool")) + 1;
  assert.ok(scrolledItemRow > 0);
  assert.equal(scrolledPanel.hitBoxes[0]?.top, scrolledItemRow);
  assert.equal(hitTestHarnessRow(scrolledItemRow, scrolledPanel.hitBoxes), second.id);
});

test("harness details and mouse parsing stay terminal-safe", () => {
  const tool = event("ToolCalled", { callId: "call-2", name: "fetch_page", argumentsDigest: "digest", arguments: '{"apiKey":"do-not-show"}' });
  const inline = renderPromptBoard({ promptId: "prompt-1", prompt: "fetch page", events: [tool], assistant: "" }, toggleHarnessFlow(createTuiInteractionState(), tool.id, harnessFlows([tool])), 40);
  assert.equal(inline.text.includes("do-not-show"), false);
  assert.doesNotMatch(inline.text, /apiKey|argumentsDigest/);
  assert.match(inline.text, /QUERY unavailable/);
  assert.match(inline.text, /RESULT unavailable/);
  assert.match(inline.text, /48;5;235m/);
  const assistantRow = inline.text.split("\n").findIndex((line) => line.includes("ASSISTANT"));
  assert.ok(assistantRow > 0);
  const separator = inline.text.split("\n")[assistantRow - 1] ?? "";
  assert.equal(separator, "");
  assert.equal(parseMouseRow("\u001b[<0;12;9M"), 9);
  assert.equal(parseMouseRow("\u001b[<0;12;9m"), undefined);
  assert.equal(parseMouseRow("not-a-click"), undefined);
  assert.match(renderAssistantCanvas("# Done\n\nSafe output"), /ASSISTANT/);
});

test("terminal width is bounded and panels wrap visible content", () => {
  assert.equal(hasSupportedTerminalWidth(19), false);
  assert.equal(hasSupportedTerminalWidth(20), true);
  assert.equal(terminalWidth(3), 20);
  assert.equal(terminalWidth(999), 240);
  const narrow = renderAssistantCanvas("A very long assistant line that must wrap without overflowing the panel", 24);
  for (const line of narrow.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").split("\n")) assert.ok(line.length <= 24, line);
  const harness = renderHarnessPanel([event("ToolCalled", { callId: "call-1", name: "a-very-long-tool-name", argumentsDigest: "digest", arguments: "{}" })], createTuiInteractionState(), 24).text;
  assert.match(harness, /48;5;233m/);
  assert.match(harness, /38;5;45m/);
  assert.match(stripAnsi(harness), /^┌─ HARNESS \/\/ EVENT/m);
  assert.match(stripAnsi(harness), /└─+┘$/m);
  assert.match(stripAnsi(harness), /^│ .* │$/m);
  for (const line of harness.split("\n")) assert.ok(terminalCellWidth(stripAnsi(line)) <= 24, line);
  assert.match(renderAssistantCanvas("a detail line that wraps", 24), /ASSISTANT/);
});

test("panel backgrounds survive content style resets", () => {
  const rendered = renderAssistantCanvas("**bold content** remains on the panel", 48);
  const contentRow = rendered.split("\n").find((line) => line.includes("bold content"));
  assert.ok(contentRow);
  if (contentRow !== undefined) {
    assert.match(contentRow, /\x1b\[0m\x1b\[48;5;233m/);
    assert.match(contentRow, /\x1b\[0m$/);
  }
});

test("selected assistant rows retain panel background and content styling", () => {
  const board = renderPromptBoard({ promptId: "prompt-1", prompt: "hello", events: [], assistant: "**bold** and *italic*" }, createTuiInteractionState(), 48);
  const contentRow = board.text.split("\n").findIndex((line) => line.includes("bold")) + 1;
  const history = renderPromptHistory([{ promptId: "prompt-1", prompt: "hello", events: [], assistant: "**bold** and *italic*" }], { ...createTuiInteractionState(), selection: { anchor: { column: 4, row: contentRow }, focus: { column: 16, row: contentRow } } }, 48, 100);
  assert.match(history.text, /\x1b\[48;5;233m/);
  assert.match(history.text, /\x1b\[38;5;45m/);
  assert.match(history.text, /\x1b\[7m/);
  assert.match(history.text, /\x1b\[27m/);

  const rowEnd = renderPromptHistory([{ promptId: "prompt-1", prompt: "hello", events: [], assistant: "**bold** and *italic*" }], { ...createTuiInteractionState(), selection: { anchor: { column: 1, row: contentRow }, focus: { column: 48, row: contentRow } } }, 48, 100);
  const selectedRow = rowEnd.text.split("\n").find((line) => line.includes("bold")) ?? "";
  const firstRail = selectedRow.indexOf("│");
  assert.ok(selectedRow.indexOf("\x1b[7m") > firstRail);
  assert.ok(selectedRow.lastIndexOf("\x1b[27m") < selectedRow.lastIndexOf("│"));
  assert.doesNotMatch(selectedRow.slice(0, firstRail + 1), /\x1b\[7m/);
});

test("harness scroll state and SGR wheel parsing are pure", () => {
  assert.equal(parseMouseWheel("\x1b[<64;12;9M"), "up");
  assert.equal(parseMouseWheel("\x1b[<65;12;9M"), "down");
  assert.equal(parseMouseWheel("\x1b[<0;12;9M"), undefined);
  const initial = createTuiInteractionState();
  const down = scrollHarness(initial, "down", 4);
  assert.equal(down.scrollOffset, 1);
  assert.equal(scrollHarness(down, "bottom", 4).scrollOffset, 3);
  assert.equal(scrollHarness(down, "top", 4).scrollOffset, 0);
  assert.equal(initial.scrollOffset, 0);
});

test("meaningful intent rows follow the HARNESS tail without interrupting history browsing", () => {
  const prior = [event("GraphRunStarted", { runId: "run-1", planId: "plan", planVersion: 1, planDigest: "digest", status: "running", inputEventId: "input-1" }, "run-1")];
  const next = [...prior, event("HarnessThinking", { runId: "run-1", step: "Read a quote", text: "To gather evidence." }, "thinking-1")];
  assert.equal(shouldFollowHarnessThinking(prior, next, true), true);
  assert.equal(shouldFollowHarnessThinking(prior, next, false), false);
  assert.equal(shouldFollowHarnessThinking(next, next, true), false);
  const legacy = [...prior, event("HarnessThinking", { runId: "run-1", step: "turn-1", text: "Preparing provider turn" }, "thinking-legacy")];
  assert.equal(shouldFollowHarnessThinking(prior, legacy, true), false);
});

test("SGR mouse packets are consumed before readline receives prompt input", () => {
  assert.equal(stripMouseSequences("hello\x1b[<0;10;7Mworld\x1b[<0;10;7m"), "helloworld");
  assert.equal(stripMouseSequences("\x1b[<64;10;7M"), "");
  assert.deepEqual(splitMouseInput("\x1b[<0;10"), { safe: "", pending: "\x1b[<0;10" });
  assert.deepEqual(splitMouseInput("\x1b[<0;10x"), { safe: "", pending: "" });
  assert.deepEqual(splitMouseInput("\x1b[<0;10;7Mtyped"), { safe: "\x1b[<0;10;7Mtyped", pending: "" });
  assert.deepEqual(splitMouseInput("\x1b[<0;10x\x1b[A"), { safe: "", pending: "" });
  assert.deepEqual(splitMouseInput("typed\x1b"), { safe: "typed", pending: "\x1b" });
  assert.deepEqual(splitMouseInput("typed\x1b["), { safe: "typed", pending: "\x1b[" });
  assert.deepEqual(prepareMouseInput("\x1b[", "<0;10;7Mtyped").readlineInput, "typed");
  assert.equal(stripMouseSequences(splitMouseInput("before\x1b[<0;10;7Mafter").safe), "beforeafter");
  assert.deepEqual(prepareMouseInput("", "before\x1b[<0;10;7Mafter"), { mouseInput: "before\x1b[<0;10;7Mafter", readlineInput: "beforeafter", pending: "" });
  assert.deepEqual(prepareMouseInput("\x1b[<0;10", ";7Mtyped"), { mouseInput: "\x1b[<0;10;7Mtyped", readlineInput: "typed", pending: "" });
});

test("SGR 1002 mouse parsing distinguishes left press, motion, and release", () => {
  assert.deepEqual(parseMouseEvents("\x1b[<0;4;2M\x1b[<32;7;3M\x1b[<0;9;3m"), [
    { action: "press", button: 0, column: 4, row: 2 },
    { action: "motion", button: 0, column: 7, row: 3 },
    { action: "release", button: 0, column: 9, row: 3 },
  ]);
  assert.deepEqual(parseMouseEvents("\x1b[<64;1;1M"), [{ action: "press", button: 64, column: 1, row: 1 }]);
  assert.equal(prepareMouseInput("", "\x1b[<32;7;3Mtyped").readlineInput, "typed");
});

test("SGR all-motion code 35 is parsed as passive motion with button 3", () => {
  assert.deepEqual(parseMouseEvents("\x1b[<35;12;8M"), [{ action: "motion", button: 3, column: 12, row: 8 }]);
});

test("selection extraction is reversed-order, ANSI-free, row-preserving, and wide-glyph safe", () => {
  const selection = normalizeSelection({ anchor: { column: 4, row: 3 }, focus: { column: 2, row: 2 } });
  assert.deepEqual(selection, { anchor: { column: 2, row: 2 }, focus: { column: 4, row: 3 } });
  const lines = ["\x1b[31mhello\x1b[0m", "界🙂z"];
  assert.equal(extractSelection(lines, selection, 2), "ello\n界🙂");
  assert.equal(extractSelection(["a界b"], { anchor: { column: 2, row: 1 }, focus: { column: 3, row: 1 } }), "界");
  assert.equal(extractSelection(["> What's your name?", "│ answer"], { anchor: { column: 3, row: 4 }, focus: { column: 8, row: 4 } }, 4), "What's");
  assert.equal(terminalCellWidth("👩‍💻"), 2);
  assert.equal(extractSelection(["👩‍💻 ready"], { anchor: { column: 1, row: 1 }, focus: { column: 2, row: 1 } }), "👩‍💻");
  assert.equal(extractSelection(["harness secret", "canvas answer"], { anchor: { column: 1, row: 1 }, focus: { column: 14, row: 2 } }, 1, [false, true]), "canvas answer");
  assert.equal(extractSelection(["\x1b[48;5;236m│ Tokyo is in Japan.   \x1b[0m"], { anchor: { column: 1, row: 1 }, focus: { column: 24, row: 1 } }), "Tokyo is in Japan.");
  assert.equal(extractSelection(["\x1b[48;5;236m│ Tokyo is in Japan.   \x1b[0m"], { anchor: { column: 2, row: 1 }, focus: { column: 24, row: 1 } }), "Tokyo is in Japan.");
  const boards = [
    renderPromptBoard({ promptId: "one", prompt: "first prompt", events: [], assistant: "first answer" }, createTuiInteractionState(), 32),
    renderPromptBoard({ promptId: "two", prompt: "second prompt", events: [], assistant: "second answer" }, createTuiInteractionState(), 32, 1),
  ];
  const boardLines = boards.flatMap((board) => board.text.split("\n"));
  const selectableRows = boards.flatMap((board) => board.selectableRows);
  const copied = extractSelection(boardLines, { anchor: { column: 32, row: boardLines.length }, focus: { column: 1, row: 1 } }, 1, selectableRows);
  assert.doesNotMatch(copied, /[│┌┐└┘─]/);
  assert.match(copied, /first prompt/);
  assert.match(copied, /first answer/);
  assert.match(copied, /second prompt/);
  assert.match(copied, /second answer/);
});

test("clipboard selection uses structured platform commands and injected fallback", async () => {
  assert.deepEqual(clipboardCommands("darwin"), [{ command: "pbcopy", args: [] }]);
  assert.deepEqual(clipboardCommands("win32"), [{ command: "clip.exe", args: [] }]);
  const attempted: string[] = [];
  const copied = await writeClipboardText("safe\x1b[31m\ntext", "linux", async (command, text) => {
    attempted.push(`${command.command}:${text}`);
    if (command.command === "wl-copy") throw new Error("missing");
  });
  assert.equal(copied, true);
  assert.deepEqual(attempted, ["wl-copy:safe\ntext", "xclip:safe\ntext"]);
});

test("clipboard text strips terminal string controls before copying", async () => {
  let copied = "";
  const ok = await writeClipboardText("before\x1b7secret\x1b8\x1bPprivate\x1b\\after", "darwin", async (_command, text) => { copied = text; });
  assert.equal(ok, true);
  assert.equal(copied, "beforeafter");
  const c1 = await writeClipboardText("before\x9b31msecret\x9cafter", "darwin", async (_command, text) => { copied = text; });
  assert.equal(c1, true);
  assert.equal(copied, "beforeafter");
  const unterminated = await writeClipboardText("before\x9d8;;https://example.test", "darwin", async (_command, text) => { copied = text; });
  assert.equal(unterminated, true);
  assert.equal(copied, "before");
});

test("clipboard fallback tolerates a synchronous injected writer failure", async () => {
  const ok = await writeClipboardText("safe", "darwin", () => { throw new Error("clipboard unavailable"); });
  assert.equal(ok, false);
});

test("copy popup is centered-sized and terminal-safe", () => {
  const popup = renderCopyPopup("Copied selection to clipboard", 40);
  assert.equal(popup.length, 3);
  assert.equal(popup.every((line) => line.includes("Copied selection to clipboard") || line.includes("─") || line.includes("╭") || line.includes("╰")), true);
  assert.equal(popup.join("\n").includes("\x1b["), true);
});

test("a subsequent click cancels selection without changing durable interaction state", () => {
  const state = { ...createTuiInteractionState(), selection: { anchor: { column: 2, row: 4 }, focus: { column: 8, row: 4 } } };
  const cancelled = cancelSelectionOnClick(state);
  assert.equal(cancelled.selection, undefined);
  assert.equal(cancelled.scrollOffset, state.scrollOffset);
  assert.equal(cancelled.expanded, state.expanded);
});

test("console prompt is rendered once outside the harness boards", () => {
  const prompt = renderConsolePrompt("What's your name?", 48);
  assert.deepEqual(prompt.map((line) => stripAnsi(line).trimEnd()), ["USER > What's your name?"]);
  const board = renderPromptBoard({ promptId: "prompt-1", prompt: "What's your name?", events: [], assistant: "" }, createTuiInteractionState(), 48);
  assert.equal(stripAnsi(board.text).includes("> What's your name?"), true);
});

test("settings render as a bounded in-window panel", () => {
  const rendered = renderSettings({ provider: "fake", model: "finleet", agent: "primary", thinking: true, thinkingEffort: "high", details: false, journal: "/tmp/finleet.jsonl", contextWindow: 128_000, cache: "/tmp/cache.json", authFile: "/tmp/auth.json" }, 44);
  const plain = rendered.lines.map(stripAnsi);
  assert.equal(plain[0]?.includes("RUNTIME // SETTINGS"), true);
  assert.equal(plain.some((line) => line.includes("PROVIDER") && line.includes("fake")), true);
  assert.equal(plain.some((line) => line.includes("CONTEXT WINDOW") && line.includes("128K")), true);
  assert.equal(plain.some((line) => line.includes("AUTH FILE") && line.includes("/tmp/auth.json")), true);
  assert.equal(plain.at(-2)?.includes("[ESC] BACK TO COMPOSE"), true);
  assert.deepEqual(rendered.buttons.at(-1)?.action, { type: "back-to-compose" });
  assert.equal(plain.every((line) => line.length <= 44), true);
  assert.equal(plain.at(-1)?.includes("┘"), true);
});

test("input area reserves rows as typed content wraps", () => {
  assert.equal(inputAreaLines("", 40), 1);
  assert.equal(inputAreaLines("short", 40), 1);
  assert.equal(inputAreaLines("x".repeat(80), 40), 3);
});

test("image previews reserve a stable rendering area outside the text frame", () => {
  assert.equal(imagePreviewLines(undefined), 0);
  assert.equal(imagePreviewLines("kitty-payload"), 1);
  assert.equal(imagePreviewLines("ansi-row-1\nansi-row-2"), 2);
  assert.equal(imagePreviewStartRow(5, 2, 7), 15);
  const frame = pinFooter(["header", "history", "", ""], "footer", 6);
  assert.equal(frame.at(-1), "footer");
  assert.equal(frame[2], "");
});

test("Kitty converts non-PNG images while iTerm2 preserves source bytes", async () => {
  const directory = mkdtempSync(join(tmpdir(), "finleet-image-protocol-"));
  const imagePath = join(directory, "pixel.jpg");
  const source = await new Jimp({ width: 1, height: 1, color: 0xffaa00ff }).getBuffer("image/jpeg");
  writeFileSync(imagePath, source);
  const decoded = await Jimp.read(imagePath);
  const kitty = await nativeImageData("kitty", imagePath, decoded);
  const iterm = await nativeImageData("iterm2", imagePath, decoded);
  assert.deepEqual([...kitty.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.deepEqual(iterm, readFileSync(imagePath));
  assert.notDeepEqual(kitty, iterm);
});

test("iTerm2-style image padding separates preview content and yields space to active input", () => {
  const preview = { payload: "iterm2-payload", rows: 4, columns: 20, paddingRows: 1 };
  assert.equal(imagePreviewLines(preview), 6);
  assert.equal(imagePreviewContentRow(8, preview), 9);
  assert.equal(visibleImagePreviewRows(preview, ""), 6);
  assert.equal(visibleImagePreviewRows(preview, "typing"), 0);
  assert.equal(visibleImagePreviewRows(preview, "", true), 0);
});

test("submitted image previews stay hidden at the live edge and return while browsing history", () => {
  assert.equal(shouldShowImagePreview(false, false), true);
  assert.equal(shouldShowImagePreview(true, false), false);
  assert.equal(shouldShowImagePreview(true, true), true);
  assert.equal(shouldArchiveImagePreview("/tmp/image.png"), true);
  assert.equal(shouldArchiveImagePreview(undefined), false);
  const browsing = { ...createTuiInteractionState(), scrollOffset: 8 };
  assert.equal(clampHistoryScrollOffset(browsing, 5).scrollOffset, 5);
  assert.equal(clampHistoryScrollOffset(browsing, 12).scrollOffset, 8);
  assert.equal(reconcileHiddenImageScrollOffset(browsing, 3).scrollOffset, 3);
});

test("only the final settled redraw may paint a native image", () => {
  const callbacks = new Map<number, () => void>();
  const cancelled = new Set<number>();
  let nextHandle = 1;
  const output: string[] = [];
  const painter = createDeferredImagePainter((callback) => {
    const handle = nextHandle;
    nextHandle += 1;
    callbacks.set(handle, callback);
    return handle;
  }, (handle) => { cancelled.add(handle); });
  painter.queue(() => { output.push("image-frame-1"); }, () => true);
  painter.queue(() => { output.push("image-frame-2"); }, () => true);
  painter.queue(() => { output.push("image-frame-3", "footer", "input"); }, () => true);
  assert.deepEqual(cancelled, new Set([1, 2]));
  callbacks.get(1)?.();
  callbacks.get(2)?.();
  callbacks.get(3)?.();
  assert.deepEqual(output, ["image-frame-3", "footer", "input"]);
  painter.queue(() => { output.push("stale-after-cleanup"); }, () => true);
  painter.cancel();
  callbacks.get(4)?.();
  assert.deepEqual(output, ["image-frame-3", "footer", "input"]);
});

test("native image geometry fits portrait previews within the reserved rows", () => {
  assert.deepEqual(nativeImageGeometry(100, 400, 100, 10), { columns: 5, rows: 10 });
});

test("ANSI image previews are bounded to their reserved rows", () => {
  assert.equal(boundImageRows("row-1\nrow-2\nrow-3", 2), "row-1\nrow-2");
});

test("image paths expand a leading home shortcut", () => {
  assert.equal(expandHomePath("~/Downloads/wbird.png", "/Users/tester"), "/Users/tester/Downloads/wbird.png");
  assert.equal(expandHomePath("/tmp/wbird.png", "/Users/tester"), "/tmp/wbird.png");
});

test("input history navigates only through eligible durable prompts", () => {
  const entries = sessionInputHistory([
    event("PromptAdmitted", { promptId: "one", prompt: "first", delivery: "queue" }),
    event("PromptAdmitted", { promptId: "slash", prompt: "/help", delivery: "queue" }),
    event("PromptAdmitted", { promptId: "blank", prompt: "   ", delivery: "queue" }),
    event("PromptAdmitted", { promptId: "two", prompt: "second", delivery: "queue" }),
  ]);
  assert.deepEqual(entries, ["first", "second"]);
  assert.equal(inputHistoryDirection("\x1b[A"), "up");
  assert.equal(inputHistoryDirection("\x1b[B"), "down");
  assert.equal(inputHistoryDirection("\x1bOA"), "up");
  assert.equal(inputHistoryDirection("\x1bOB"), "down");
  assert.equal(inputHistoryDirection("\x1b[C"), undefined);
  assert.equal(shouldNavigateInputHistory("", entries, -1), true);
  assert.equal(shouldNavigateInputHistory("second", entries, 1), true);
  assert.equal(shouldNavigateInputHistory("second edited", entries, 1), false);
  assert.deepEqual(navigateInputHistory(entries, -1, "up"), { index: 1, value: "second", consumed: true });
  assert.deepEqual(navigateInputHistory(entries, 1, "up"), { index: 0, value: "first", consumed: true });
  assert.deepEqual(navigateInputHistory(entries, 0, "down"), { index: 1, value: "second", consumed: true });
  assert.deepEqual(navigateInputHistory(entries, 1, "down"), { index: -1, value: "", consumed: true });
  assert.deepEqual(navigateInputHistory(entries, -1, "down"), { index: -1, value: "", consumed: false });
});

test("prompt cursor navigation preserves its visual column across wrapped rows", () => {
  const up = navigatePromptCursor("abcdefghijklmnop", 16, "up", 10, undefined, 3);
  assert.deepEqual(up, { cursor: 6, preferredColumn: 9, moved: true });
  assert.deepEqual(navigatePromptCursor("abcdefghijklmnop", up.cursor, "down", 10, up.preferredColumn, 3), { cursor: 16, preferredColumn: 9, moved: true });
  assert.deepEqual(navigatePromptCursor("abcdefghijklmnop", 6, "up", 10, undefined, 3), { cursor: 6, preferredColumn: 9, moved: false });
});

test("prompt cursor navigation matches hard lines and wide-grapheme wrapping", () => {
  assert.deepEqual(navigatePromptCursor("ab🙂x", 2, "down", 10, 2, 7), { cursor: 4, preferredColumn: 2, moved: true });
  const hardLine = navigatePromptCursor("abc\ndef", 3, "down", 10, undefined, 3);
  assert.deepEqual(hardLine, { cursor: 7, preferredColumn: 6, moved: true });
  assert.deepEqual(navigatePromptCursor("abc\ndef", hardLine.cursor, "up", 10, hardLine.preferredColumn, 3), { cursor: 3, preferredColumn: 6, moved: true });
});

test("raw input recognizes Ctrl+C and Ctrl+D as interrupts", () => {
  assert.equal(containsInterrupt("typed\x03input"), true);
  assert.equal(containsInterrupt("typed\x04input"), true);
  assert.equal(containsInterrupt("typed input"), false);
  assert.equal(containsQuitSubmission("/quit\r"), true);
  assert.equal(containsQuitSubmission(" /exit \n"), true);
  assert.equal(containsQuitSubmission("explain /quit\r"), false);
  assert.equal(containsQuitSubmission("/quit"), false);
});

test("each durable prompt stays immediately above its own turn", () => {
  const first = renderPromptBoard({ promptId: "prompt-1", prompt: "first prompt", events: [], assistant: "" }, createTuiInteractionState(), 48, 0).text;
  const second = renderPromptBoard({ promptId: "prompt-2", prompt: "second prompt", events: [], assistant: "" }, createTuiInteractionState(), 48, 1).text;
  const rendered = [...first.split("\n"), ...second.split("\n")].map((line) => stripAnsi(line).trimEnd());
  assert.equal(rendered[0], "USER > first prompt");
  assert.match(rendered[2] ?? "", /TURN 1/);
  const secondPrompt = rendered.findIndex((line) => line === "USER > second prompt");
  const secondTurn = rendered.findIndex((line) => line.includes("TURN 2"));
  assert.ok(secondPrompt >= 0);
  assert.equal(secondTurn, secondPrompt + 2);
});

test("prompt boards accumulate durable harness events and assistant canvases", () => {
  const events: DurableEvent[] = [
    event("PromptAdmitted", { promptId: "prompt-1", prompt: "first prompt", delivery: "queue" }, "admit-1"),
    event("InputPromoted", { promptId: "prompt-1", delivery: "queue", reason: "queue-idle" }, "promote-1"),
    event("GraphRunStarted", { runId: "run-1", planId: "plan", planVersion: 1, planDigest: "digest", status: "running", inputEventId: "admit-1" }, "run-1"),
    event("ProviderTurnStarted", { provider: "test", model: "model", providerCallId: "run-1:turn-0", effectId: "run-1:provider:0" }, "turn-1"),
    event("ToolCalled", { callId: "call-1", name: "fetch_page", argumentsDigest: "digest" }, "tool-1"),
    event("ProviderText", { providerCallId: "run-1:turn-0", text: "first answer", truncated: false }, "text-1"),
    event("ProviderText", { providerCallId: "run-1:turn-0", text: " continued", truncated: false }, "text-1b"),
    event("PromptAdmitted", { promptId: "prompt-2", prompt: "second prompt", delivery: "queue" }, "admit-2"),
    event("InputPromoted", { promptId: "prompt-2", delivery: "queue", reason: "queue-idle" }, "promote-2"),
    event("GraphRunStarted", { runId: "run-2", planId: "plan", planVersion: 1, planDigest: "digest", status: "running", inputEventId: "admit-2" }, "run-2"),
    event("ProviderTurnStarted", { provider: "test", model: "model", providerCallId: "run-2:turn-0", effectId: "run-2:provider:0" }, "turn-2"),
    event("ProviderText", { providerCallId: "run-2:turn-0", text: "second answer", truncated: false }, "text-2"),
  ];
  const boards = promptBoards(events, "session-1");
  assert.equal(boards.length, 2);
  assert.equal(boards[0]?.events.some((entry) => entry.id === "tool-1"), true);
  assert.equal(boards[0]?.events.some((entry) => entry.id === "tool-2"), false);
  assert.equal(boards[0]?.assistant, "first answer continued");
  assert.equal(boards[1]?.assistant, "second answer");
  const history = renderPromptHistory(boards, createTuiInteractionState(), 48, 100);
  assert.match(history.text, /TURN 1/);
  assert.match(history.text, /TURN 2/);
  assert.match(stripAnsi(history.text), /> first prompt/);
  assert.match(stripAnsi(history.text), /> second prompt/);
  assert.match(history.text, /first answer continued/);
  assert.match(history.text, /second answer/);
  assert.equal(history.lines.length, history.totalRows);
});

test("continuation boards retain assistant chunks but hide lifecycle thinking", () => {
  const events: DurableEvent[] = [
    event("PromptAdmitted", { promptId: "prompt-1", prompt: "long answer", delivery: "queue" }, "admit-1"),
    event("GraphRunStarted", { runId: "run-1", planId: "plan", planVersion: 1, planDigest: "digest", status: "running", inputEventId: "admit-1" }, "run-1"),
    event("HarnessThinking", { runId: "run-1", step: "Read a quote", text: "To gather evidence." }, "thinking-1"),
    event("ProviderText", { providerCallId: "run-1:turn-1", text: "first output ", truncated: false }, "text-1"),
    event("ContinuationWindowOpened", { parentRunId: "run-1", continuationRunId: "run-1:continuation-1", originalInputEventId: "admit-1", planId: "plan", planVersion: 1, planDigest: "digest", windowIndex: 1, turnsUsedBeforeHandoff: 8, providerEffectId: "run-1:provider:8", providerCallId: "run-1:turn-8", triggerToolEffectId: "tool-1", reason: "provider-tool-continuation" }, "handoff-1"),
    event("GraphRunStarted", { runId: "run-1:continuation-1", planId: "plan", planVersion: 1, planDigest: "digest", status: "running", inputEventId: "admit-1" }, "run-2"),
    event("HarnessThinking", { runId: "run-1:continuation-1", step: "continuation", text: "later thinking step" }, "thinking-2"),
    event("ProviderText", { providerCallId: "run-1:continuation-1:turn-1", text: "second output", truncated: false }, "text-2"),
  ];
  const board = promptBoards(events, "session-1")[0]!;
  assert.equal(board.assistant, "first output second output");
  const rendered = stripAnsi(renderPromptBoard(board, createTuiInteractionState(), 80).text);
  assert.match(rendered, /first output second output/);
  assert.match(rendered, /INTENT Read a quote — To gather evidence\./);
  assert.doesNotMatch(rendered, /later thinking step|first thinking step/);
});

test("callback synthesis stays with its originating prompt after a later prompt is admitted", () => {
  const callbackId = "callback-origin";
  const callbackRunId = `callback-${digest(`session-1:${callbackId}`).slice(0, 16)}`;
  const boards = promptBoards([
    event("PromptAdmitted", { promptId: "prompt-1", prompt: "first prompt", delivery: "queue" }, "admit-1"),
    event("GraphRunStarted", { runId: "run-1", planId: "plan", planVersion: 1, planDigest: "digest", status: "running", inputEventId: "admit-1" }, "run-1"),
    event("ToolCalled", { callId: "spawn-1", name: "spawn_agent", argumentsDigest: "digest" }, "spawn-1"),
    event("BackgroundAgentCallback", { agentId: "agent-1", callbackId, parentToolCallId: "spawn-1", envelope: { trust: "untrusted-data", status: "completed", output: "evidence", outputTruncated: false } }, "callback-1"),
    event("PromptAdmitted", { promptId: "prompt-2", prompt: "second prompt", delivery: "queue" }, "admit-2"),
    event("GraphRunStarted", { runId: "run-2", planId: "plan", planVersion: 1, planDigest: "digest", status: "running", inputEventId: "admit-2" }, "run-2"),
    event("ProviderTurnStarted", { provider: "test", model: "model", providerCallId: `${callbackRunId}:turn-1`, effectId: `${callbackRunId}:provider:1` }, "callback-turn"),
    event("ProviderText", { providerCallId: `${callbackRunId}:turn-1`, text: "callback synthesis", truncated: false }, "callback-text"),
    event("ProviderTurnStarted", { provider: "test", model: "model", providerCallId: "callback-unknown:turn-1", effectId: "callback-unknown:provider:1" }, "unknown-turn"),
    event("ProviderText", { providerCallId: "callback-unknown:turn-1", text: "must not move", truncated: false }, "unknown-text"),
  ], "session-1");

  assert.equal(boards[0]?.assistant, "callback synthesis");
  assert.equal(boards[1]?.assistant, "");
});

test("batch callback synthesis is attributed only when every member has the same origin board", () => {
  const callbackId = "batch-callback-origin";
  const callbackRunId = `callback-${digest(`session-1:${callbackId}`).slice(0, 16)}`;
  const boards = promptBoards([
    event("PromptAdmitted", { promptId: "prompt-1", prompt: "first prompt", delivery: "queue" }, "admit-1"),
    event("GraphRunStarted", { runId: "run-1", planId: "plan", planVersion: 1, planDigest: "digest", status: "running", inputEventId: "admit-1" }, "run-1"),
    event("ToolCalled", { callId: "spawn-1", name: "spawn_agent", argumentsDigest: "digest" }, "spawn-1"),
    event("ToolCalled", { callId: "spawn-2", name: "spawn_agent", argumentsDigest: "digest" }, "spawn-2"),
    event("BackgroundAgentBatchCallback", { batchId: "batch-1", callbackId, synthesisRequired: true, members: [
      { agentId: "agent-1", callbackId: "callback-1", childSessionId: "child-1", parentToolCallId: "spawn-1", envelope: { trust: "untrusted-data", status: "completed", output: "one", outputTruncated: false } },
      { agentId: "agent-2", callbackId: "callback-2", childSessionId: "child-2", parentToolCallId: "spawn-2", envelope: { trust: "untrusted-data", status: "completed", output: "two", outputTruncated: false } },
    ] }, "batch-callback-1"),
    event("PromptAdmitted", { promptId: "prompt-2", prompt: "second prompt", delivery: "queue" }, "admit-2"),
    event("ProviderText", { providerCallId: `${callbackRunId}:turn-1`, text: "batch synthesis", truncated: false }, "batch-text"),
  ], "session-1");

  assert.equal(boards[0]?.assistant, "batch synthesis");
  assert.equal(boards[1]?.assistant, "");
});

test("textless completed prompts retain the assistant fallback", () => {
  const boards = promptBoards([
    event("PromptAdmitted", { promptId: "prompt-1", prompt: "tool-only task", delivery: "queue" }, "admit-1"),
    event("GraphRunStarted", { runId: "run-1", planId: "plan", planVersion: 1, planDigest: "digest", status: "running", inputEventId: "admit-1" }, "run-1"),
    event("TaskConclusion", { runId: "run-1", outcome: "finished", summary: "Task completed" }, "conclusion-1"),
  ], "session-1");

  assert.equal(boards[0]?.assistant, "");
  assert.match(stripAnsi(renderPromptBoard(boards[0]!, createTuiInteractionState(), 64).text), /\(completed without text\)/);
});

test("tool-call turns remain visibly in progress until a final response arrives", () => {
  const started: DurableEvent[] = [
    event("PromptAdmitted", { promptId: "prompt-1", prompt: "use a tool", delivery: "queue" }, "admit-1"),
    event("GraphRunStarted", { runId: "run-1", planId: "plan", planVersion: 1, planDigest: "digest", status: "running", inputEventId: "admit-1" }, "run-1"),
    event("ProviderTurnStarted", { provider: "test", model: "model", providerCallId: "run-1:turn-0", effectId: "run-1:provider:0" }, "turn-1"),
    event("ProviderTurnFinished", { providerCallId: "run-1:turn-0", finishReason: "tool-calls", inputTokens: 1, outputTokens: 1 }, "turn-1-finished"),
  ];
  const waitingBoard = promptBoards(started, "session-1")[0]!;
  const waiting = stripAnsi(renderPromptBoard(waitingBoard, createTuiInteractionState(), 64).text);
  assert.match(waiting, /AGENT CONTINUE \(tool-calls\)/);
  assert.match(waiting, /\(continuing after tool calls\.\.\.\)/);
  assert.doesNotMatch(waiting, /AGENT COMPLETE \(tool-calls\)|\(completed without text\)/);

  const completedBoard = promptBoards([
    ...started,
    event("ProviderTurnStarted", { provider: "test", model: "model", providerCallId: "run-1:turn-1", effectId: "run-1:provider:1" }, "turn-2"),
    event("ProviderText", { providerCallId: "run-1:turn-1", text: "final answer", truncated: false }, "text-1"),
    event("ProviderTurnFinished", { providerCallId: "run-1:turn-1", finishReason: "stop", inputTokens: 1, outputTokens: 1 }, "turn-2-finished"),
    event("TaskConclusion", { runId: "run-1", outcome: "finished", summary: "Task completed" }, "conclusion-1"),
  ], "session-1")[0]!;
  const completed = stripAnsi(renderPromptBoard(completedBoard, createTuiInteractionState(), 64).text);
  assert.match(completed, /final answer/);
  assert.doesNotMatch(completed, /continuing after tool calls|completed without text/);
});

test("failed prompts do not claim a successful textless completion", () => {
  const boards = promptBoards([
    event("PromptAdmitted", { promptId: "prompt-1", prompt: "fail", delivery: "queue" }, "admit-1"),
    event("GraphRunStarted", { runId: "run-1", planId: "plan", planVersion: 1, planDigest: "digest", status: "running", inputEventId: "admit-1" }, "run-1"),
    event("TaskConclusion", { runId: "run-1", outcome: "failed", summary: "Task failed" }, "conclusion-1"),
  ], "session-1");
  const rendered = stripAnsi(renderPromptBoard(boards[0]!, createTuiInteractionState(), 64).text);
  assert.match(rendered, /\(agent failed before producing text\)/);
  assert.doesNotMatch(rendered, /\(completed without text\)/);
});

test("bash tool calls render as muted command lines", () => {
  const board = renderPromptBoard({ promptId: "prompt-1", prompt: "run it", events: [event("ToolCalled", { callId: "bash-1", name: "bash", argumentsDigest: "digest", arguments: JSON.stringify({ command: "API_KEY=secret-token\nnpm test" }) })], assistant: "done" }, createTuiInteractionState(), 48);
  assert.equal(board.text.includes(`${tuiPalette.muted}> API_KEY=[REDACTED] npm test${tuiPalette.reset}`), true);
  assert.equal(board.text.includes("secret-token"), false);
  assert.equal(board.text.includes("\u001b[31m"), false);
  assert.equal(stripAnsi(board.text).includes("⟳ TOOL bash"), false);
});

test("Bash intents show the redacted command immediately and expand tool details", () => {
  const intent = event("HarnessThinking", { runId: "bash-run", step: "Run an arbitrary host bash script after mandatory interactive shell approval", text: "Run the command." }, "bash-intent");
  const tool = event("ToolCalled", { callId: "bash-call", name: "bash", argumentsDigest: "digest", arguments: JSON.stringify({ command: `API_KEY=secret-token\nnpm test ${"x".repeat(220)}` }) }, "bash-tool");
  const events = [intent, tool];
  const headerId = "intent:bash-intent";
  const collapsed = stripAnsi(renderPromptBoard({ promptId: "bash", prompt: "run", events, assistant: "" }, createTuiInteractionState(), 80).text);
  assert.match(collapsed, /INTENT API_KEY=\[REDACTED\] npm test/);
  assert.doesNotMatch(collapsed, /Run an arbitrary host bash script|secret-token|> API_KEY/);
  assert.equal(collapsed.includes("x".repeat(180)), false);
  const expanded = stripAnsi(renderPromptBoard({ promptId: "bash", prompt: "run", events, assistant: "" }, { ...createTuiInteractionState(), expanded: new Set([headerId]) }, 80).text);
  assert.match(expanded, /COMMAND API_KEY=\[REDACTED\] npm test/);
  assert.doesNotMatch(expanded, /secret-token/);
  assert.deepEqual(renderPromptBoard({ promptId: "bash", prompt: "run", events, assistant: "" }, createTuiInteractionState(), 80).hitBoxes.map((box) => box.flowId), [headerId]);
});

test("Bash intent promotion rejects payloads rejected by the production decoder", () => {
  const malformed: readonly [unknown, string | undefined][] = [
    [{ command: "   " }, undefined],
    [{ command: `oversized-marker-${"x".repeat(4097)}` }, "oversized-marker"],
    [{ command: "extra-property-marker", extra: true }, "extra-property-marker"],
    [null, undefined],
    [{ command: "nul-control-marker\u0000tail" }, "nul-control-marker"],
    [{ command: "escape-control-marker\u001b[31m" }, "escape-control-marker"],
  ];
  for (const [index, [input, commandMarker]] of malformed.entries()) {
    const intent = event("HarnessThinking", { runId: `bash-${index}`, step: "Run an arbitrary host bash script after mandatory interactive shell approval", text: "Run the command." }, `bash-intent-${index}`);
    const tool = event("ToolCalled", { callId: `bash-call-${index}`, name: "bash", argumentsDigest: "digest", arguments: JSON.stringify(input) }, `bash-tool-${index}`);
    const events = [intent, tool];
    const group = harnessGroups(events)[0];
    assert.ok(group && "header" in group);
    if (group !== undefined && "header" in group) assert.equal(group.promotedBash, undefined);
    const expanded = stripAnsi(renderPromptBoard(
      { promptId: `bash-${index}`, prompt: "run", events, assistant: "" },
      { ...createTuiInteractionState(), expanded: new Set([`intent:${intent.id}`, tool.id]) },
      80,
    ).text);
    assert.match(expanded, /INTENT Run an arbitrary host bash script/);
    assert.match(expanded, /TOOL bash/);
    assert.match(expanded, /COMMAND unavailable/);
    assert.doesNotMatch(expanded, /argumentsDigest|"command"/);
    if (commandMarker !== undefined) assert.equal(expanded.includes(commandMarker), false);
  }
});

test("HARNESS renders the plan, meaningful intent, and conclusion for the active run", () => {
  const plan = { planId: "plan", version: 1, sessionScope: "local", entryNode: "finish", activationState: "active" as const, nodes: [{ nodeId: "finish", kind: "finish" as const, config: {} }], edges: [], limits: { maxTurns: 1, maxCost: 0, maxParallelism: 1, timeoutMs: 1 }, contentDigest: "digest" };
  const boards = promptBoards([
    event("PromptAdmitted", { promptId: "p1", prompt: "plan this", delivery: "queue" }, "a1"),
    event("GraphPlanPublished", { plan }, "plan-1"),
    event("GraphRunStarted", { runId: "r1", planId: "plan", planVersion: 1, planDigest: "digest", status: "running", inputEventId: "a1" }, "r1"),
    event("HarnessThinking", { runId: "r1", step: "Read a deterministic paper-market quote", text: "The model selected this action to gather evidence for the response." }, "thinking-1"),
    event("TaskConclusion", { runId: "r1", outcome: "finished", summary: "Task completed" }, "conclusion-1"),
  ], "session-1");
  assert.equal(boards.length, 1);
  const rendered = stripAnsi(renderPromptBoard(boards[0]!, createTuiInteractionState(), 120).text);
  assert.match(rendered, /PLAN/);
  assert.match(rendered, /INTENT Read a deterministic paper-market quote —/);
  assert.doesNotMatch(rendered, /CONCLUSION/);
  const expanded = new Set(harnessGroups(boards[0]!.events).flatMap((item) => "header" in item ? [item.id, ...item.children.map((child) => child.id)] : [item.id]));
  assert.match(stripAnsi(renderPromptBoard(boards[0]!, { ...createTuiInteractionState(), expanded }, 120).text), /CONCLUSION/);
  assert.deepEqual(boards[0]?.events.map((entry) => entry.kind), ["GraphPlanPublished", "HarnessThinking", "TaskConclusion"]);
});

test("HARNESS suppresses legacy lifecycle rows while retaining intent and tool events", () => {
  const boards = promptBoards([
    event("PromptAdmitted", { promptId: "p1", prompt: "quote", delivery: "queue" }, "a1"),
    event("GraphRunStarted", { runId: "r1", planId: "plan", planVersion: 1, planDigest: "digest", status: "running", inputEventId: "a1" }, "r1"),
    event("HarnessThinking", { runId: "r1", step: "input", text: "Promoting input" }, "input-thinking"),
    event("HarnessThinking", { runId: "r1", step: "turn-1", text: "Preparing provider turn" }, "turn-thinking"),
    event("HarnessThinking", { runId: "r1", step: "continuation", text: "Continuing" }, "continuation-thinking"),
    event("HarnessThinking", { runId: "r1", step: "tool", text: "Evaluating tool" }, "tool-thinking"),
    event("HarnessThinking", { runId: "r1", step: "Read a quote", text: "To gather evidence." }, "intent-thinking"),
    event("ToolCalled", { callId: "quote-1", name: "paper_quote", argumentsDigest: "digest" }, "tool-called"),
  ], "session-1");
  assert.deepEqual(boards[0]?.events.map((entry) => entry.kind), ["HarnessThinking", "ToolCalled"]);
  const rendered = stripAnsi(renderPromptBoard(boards[0]!, createTuiInteractionState(), 80).text);
  assert.match(rendered, /INTENT Read a quote — To gather evidence\./);
  assert.doesNotMatch(rendered, /TOOL paper_quote/);
  const intent = harnessGroups(boards[0]!.events).find((item) => "header" in item);
  assert.ok(intent && "header" in intent);
  assert.match(stripAnsi(renderPromptBoard(boards[0]!, { ...createTuiInteractionState(), expanded: new Set([intent.id]) }, 80).text), /TOOL paper_quote/);
  assert.doesNotMatch(rendered, /Promoting input|Preparing provider turn|Continuing|Evaluating tool/);
});

test("intent groups preserve order, expose group and child hitboxes, and never render intent JSON", () => {
  const preamble = event("GraphTransition", { runId: "r1", planId: "p", planVersion: 1, nodeId: "start", sequence: 1, outcome: "loaded", inputDigest: "safe" }, "pre");
  const intent = event("HarnessThinking", { runId: "r1", step: "Gather quote", text: "Use the quote tool", secret: "hidden" } as DurableEvent["data"], "intent");
  const tool = event("ToolCalled", { callId: "call", name: "quote", argumentsDigest: "digest", arguments: '{"apiKey":"secret"}' }, "tool");
  const conclusion = event("TaskConclusion", { runId: "r1", outcome: "finished", summary: "done" }, "done");
  const groups = harnessGroups([preamble, intent, tool, conclusion]);
  assert.deepEqual(groups.map((item) => item.id), ["pre", "intent:intent"]);
  assert.deepEqual((groups[1] && "header" in groups[1] ? groups[1].children : []).map((item) => item.id), ["tool", "done"]);
  const collapsed = renderPromptBoard({ promptId: "p", prompt: "q", events: [preamble, intent, tool, conclusion], assistant: "" }, createTuiInteractionState(), 64);
  assert.match(stripAnsi(collapsed.text), /GRAPH start/);
  assert.match(stripAnsi(collapsed.text), /INTENT Gather quote/);
  assert.doesNotMatch(stripAnsi(collapsed.text), /TOOL quote|CONCLUSION|hidden|secret/);
  assert.equal(collapsed.hitBoxes.length, 2);
  const groupId = collapsed.hitBoxes[1]?.flowId;
  assert.equal(groupId, "intent:intent");
  assert.equal(hitTestHarnessRow(collapsed.hitBoxes[1]?.top ?? 0, collapsed.hitBoxes), groupId);
  const expanded = renderPromptBoard({ promptId: "p", prompt: "q", events: [preamble, intent, tool, conclusion], assistant: "" }, { ...createTuiInteractionState(), expanded: new Set([groupId ?? ""]) }, 64);
  assert.match(stripAnsi(expanded.text), /TOOL quote/);
  assert.match(stripAnsi(expanded.text), /CONCLUSION/);
  assert.doesNotMatch(stripAnsi(expanded.text), /hidden/);
  assert.equal(expanded.hitBoxes.map((box) => box.flowId).join(","), "pre,intent:intent,tool,done");
  const childExpanded = renderPromptBoard({ promptId: "p", prompt: "q", events: [preamble, intent, tool, conclusion], assistant: "" }, { ...createTuiInteractionState(), expanded: new Set([groupId ?? "", "tool"]) }, 64);
  assert.match(stripAnsi(childExpanded.text), /RED.*ACTED/);
});

test("intent group headers toggle their children without opening JSON details", () => {
  const intent = event("HarnessThinking", { runId: "run-1", step: "Inspect a source", text: "The model selected this action to gather evidence for the response." }, "intent");
  const tool = event("ToolCalled", { callId: "tool-1", name: "bash", argumentsDigest: "digest", arguments: "{}" }, "tool");
  const collapsed = createTuiInteractionState();
  const header = visibleHarnessItems([intent, tool], collapsed.expanded)[0];
  assert.ok(header);
  const expanded = toggleHarnessFlow(collapsed, header.id, visibleHarnessItems([intent, tool], collapsed.expanded));
  assert.equal(expanded.expanded.has("intent:intent"), true);
  assert.equal(visibleHarnessItems([intent, tool], expanded.expanded).length, 2);
  assert.equal(expanded.expanded.has("intent"), false);
});

test("collapsed intent groups stay aligned when historical boards are scrolled", () => {
  const makeBoard = (prefix: string) => ({
    promptId: prefix,
    prompt: `${prefix} prompt`,
    events: [
      event("HarnessThinking", { runId: prefix, step: `${prefix} intent`, text: "decide" }, `${prefix}-intent`),
      event("ToolCalled", { callId: `${prefix}-tool`, name: `${prefix}_tool`, argumentsDigest: "digest", arguments: "{}" }, `${prefix}-tool`),
    ],
    assistant: "",
  });
  const boards = [makeBoard("old"), makeBoard("new")];
  const full = renderPromptHistory(boards, createTuiInteractionState(), 48, 6);
  const scrolled = renderPromptHistory(boards, { ...createTuiInteractionState(), scrollOffset: full.maxScrollOffset }, 48, 6);
  assert.doesNotMatch(stripAnsi(scrolled.text), /old_tool/);
  assert.ok(scrolled.hitBoxes.every((box) => box.top >= 1 && box.bottom <= 6));
  assert.match(stripAnsi(renderPromptHistory(boards, { ...createTuiInteractionState(), expanded: new Set(["intent:old-intent"]) }, 48, 100).text), /old_tool/);
});

test("prompt history scroll keeps old boards and hit rows aligned", () => {
  const boards = promptBoards([
    event("PromptAdmitted", { promptId: "p1", prompt: "old prompt", delivery: "queue" }, "a1"),
    event("GraphRunStarted", { runId: "r1", planId: "plan", planVersion: 1, planDigest: "digest", status: "running", inputEventId: "a1" }, "r1"),
    event("GraphTransition", { runId: "r1", planId: "plan", planVersion: 1, nodeId: "finish", sequence: 1, outcome: "finished", inputDigest: "digest" }, "g1"),
    event("PromptAdmitted", { promptId: "p2", prompt: "new prompt", delivery: "queue" }, "a2"),
  ], "session-1");
  const state = createTuiInteractionState();
  const full = renderPromptHistory(boards, state, 36, 100, 3);
  assert.ok(full.totalRows > 4);
  const scrolledState = scrollHistory(state, "bottom", full.totalRows, 4);
  const scrolled = renderPromptHistory(boards, scrolledState, 36, 4, 3);
  assert.match(scrolled.text, /TURN 2|ASSISTANT/);
  const rendered = renderPromptHistory(boards, scrollHistory(state, "bottom", full.totalRows, 100), 36, 100);
  assert.match(rendered.text, /TURN 1/);
  assert.match(rendered.text, /TURN 2/);
  assert.match(stripAnsi(rendered.text), /> old prompt/);
  assert.match(stripAnsi(rendered.text), /> new prompt/);
  assert.ok(scrolled.hitBoxes.every((box) => box.top >= 3));
  assert.equal(scrolledState.scrollOffset, Math.max(0, full.totalRows - 4));
});

test("a submitted prompt follows history added after the previous frame", () => {
  const oldBoards = promptBoards([
    event("PromptAdmitted", { promptId: "p1", prompt: "old prompt", delivery: "queue" }, "a1"),
  ], "session-1");
  const previousFrame = renderPromptHistory(oldBoards, createTuiInteractionState(), 36, 4);
  const staleBottom = scrollHistory(createTuiInteractionState(), "bottom", previousFrame.totalRows, 4);
  const newBoards = promptBoards([
    event("PromptAdmitted", { promptId: "p1", prompt: "old prompt", delivery: "queue" }, "a1"),
    event("PromptAdmitted", { promptId: "p2", prompt: "new inquiry", delivery: "queue" }, "a2"),
    event("ProviderText", { providerCallId: "turn-2", text: "new answer", truncated: false }, "text-2"),
  ], "session-1");

  const stale = renderPromptHistory(newBoards, staleBottom, 36, 4);
  const followedState = reconcileHistoryNavigation(staleBottom, "follow", renderPromptHistory(newBoards, staleBottom, 36, 4).totalRows, 4).state;
  const followed = renderPromptHistory(newBoards, followedState, 36, 4);

  assert.doesNotMatch(stripAnsi(stale.text), /new inquiry/);
  assert.match(stripAnsi(followed.text), /new inquiry|new answer/);
  assert.equal(followed.maxScrollOffset, followed.totalRows - 4);
});

test("terminal links require safe targets and use rendered hit boxes", async () => {
  const osc = "prefix \x1b]8;;https://example.test/docs\x1b\\Docs\x1b]8;;\x1b\\";
  const links = extractTerminalLinks(osc);
  assert.deepEqual(links, [{ url: "https://example.test/docs", startColumn: 7, endColumn: 11 }]);
  assert.deepEqual(extractTerminalLinks("[Docs](https://example.test/docs)"), [{ url: "https://example.test/docs", startColumn: 1, endColumn: 5 }]);
  assert.equal(extractTerminalLinks("[Bad](https://user:secret@example.test/) https://example.test/a?token=1").length, 0);
  assert.equal(safeHttpUrl("https://example.test/docs#part"), undefined);
  assert.equal(hitTestTerminalLink(4, 10, [{ url: "https://example.test/docs", row: 4, left: 3, right: 10 }]), "https://example.test/docs");
  const board = renderPromptBoard({ promptId: "prompt-1", prompt: "hello", events: [], assistant: "See https://example.test/docs" }, createTuiInteractionState(), 48);
  const assistantLink = board.linkBoxes.find((link) => link.url === "https://example.test/docs");
  assert.equal(assistantLink?.row, 8);
  assert.equal(parseMouseClick("\x1b[<0;10;4M")?.row, 4);
  const opened: string[] = [];
  assert.equal(await openTerminalLink("https://example.test/docs", async (url) => { opened.push(url); }), true);
  assert.deepEqual(opened, ["https://example.test/docs"]);
  assert.equal(await openTerminalLink("javascript:alert(1)", async () => { opened.push("unsafe"); }), false);
  assert.deepEqual(opened, ["https://example.test/docs"]);
  const longBoard = renderPromptBoard({ promptId: "prompt-long", prompt: "hello", events: [], assistant: "[abcdefghijklmnopqrstuvwxyz](https://example.test/docs)" }, createTuiInteractionState(), 20);
  for (const line of longBoard.text.split("\n")) assert.ok(terminalCellWidth(stripAnsi(line)) <= 20, line);
  assert.ok(longBoard.linkBoxes.length >= 2);
  assert.ok(longBoard.linkBoxes.every((box) => box.left >= 1 && box.right <= 20));
});

test("only assistant canvas content spans are selectable inside a board", () => {
  const board = renderPromptBoard({ promptId: "prompt-1", prompt: "hello", events: [], assistant: "answer" }, createTuiInteractionState(), 48);
  const assistantRow = board.text.split("\n").findIndex((line) => line.includes("ASSISTANT"));
  assert.ok(assistantRow >= 0);
  assert.equal(board.selectableRows[0], true);
  assert.equal(board.selectableRows[1], false);
  assert.equal(board.selectableRows[assistantRow], false);
  assert.deepEqual(board.selectableRows[assistantRow + 1], { startColumn: 2, endColumn: 46 });
  assert.equal(board.selectableRows[assistantRow + 2], false);
  assert.equal(board.selectableRows[board.selectableRows.length - 1], false);
});

test("wrapping uses terminal cells and does not split a wide glyph", () => {
  assert.equal(terminalCellWidth("a界🙂"), 5);
  assert.equal(terminalCellWidth("👍🏽"), 2);
  assert.equal(terminalCellWidth("👩🏽"), 2);
  assert.equal(terminalCellWidth("1️⃣"), 2);
  const rendered = renderAssistantCanvas("界界界", 20);
  const visible = rendered.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)|\x1b\[[0-?]*[ -/]*[@-~]/g, "");
  for (const line of visible.split("\n")) assert.ok(terminalCellWidth(line) <= 20, line);
});

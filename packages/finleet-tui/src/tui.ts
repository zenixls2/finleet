import { createInterface } from "node:readline/promises";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { basename, resolve } from "node:path";
import { readFile, stat } from "node:fs/promises";
import { stdin as processStdin, stdout as processStdout } from "node:process";
import { PassThrough, Writable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import terminalImage from "terminal-image";
import { Jimp } from "jimp";
import { digest, redactJson, redactOutputText, validateBashCommand, type DurableEvent, type Json, type LiveBackgroundAgent } from "finleet-core";
import { clearKittyImages, deleteKittyImage, deleteKittyPlacement, detectImageCapabilities, encodeIterm2Graphic, encodeIterm2Png, encodeKittyPng, encodeSixel, placeKittyImage, selectImageProtocol, type ImageCapabilities, type ImageProtocol } from "./image-protocols.js";
import { parseTerminalCellPixelSize, rasterCellGeometry, type RasterGraphic, type TerminalCellPixelSize } from "./kitty-graphics.js";
import type { TuiClient, TuiPermissionDecision, TuiPermissionRequest } from "./tui-client.js";
import { openBrowserUrl } from "./browser.js";
import { layoutChartSurface, renderChartGraphic, renderChartSurface } from "./components/chart.js";
import { isChartDescriptor, type ChartDescriptor, type ChartKind } from "finleet-core";
import { extractLatexGraphicMatches, latexGraphicKey, renderLatexGraphic, type LatexRasterGraphic, type LatexGraphicSegment } from "./latex-graphics.js";
import { renderLatexToString } from "opentui-math";

export type TuiExecute = never;

/** Keeps snapshot events ahead of races without repeating durable records. */
export const mergeDurableEvents = (
  snapshot: readonly DurableEvent[],
  live: readonly DurableEvent[],
): readonly DurableEvent[] => {
  const seen = new Set<string>();
  return [...snapshot, ...live].filter((event) => {
    if (seen.has(event.id)) return false;
    seen.add(event.id);
    return true;
  });
};

export type SessionEventCache = Map<string, DurableEvent[]>;

const sessionEventCacheIds = new WeakMap<SessionEventCache, Map<string, { events: DurableEvent[]; ids: Set<string> }>>();

const cacheIdsFor = (cache: SessionEventCache, sessionId: string, events: DurableEvent[]): Set<string> => {
  let sessions = sessionEventCacheIds.get(cache);
  if (sessions === undefined) {
    sessions = new Map();
    sessionEventCacheIds.set(cache, sessions);
  }
  let indexed = sessions.get(sessionId);
  if (indexed?.events !== events) {
    indexed = { events, ids: new Set(events.map((event) => event.id)) };
    sessions.set(sessionId, indexed);
  }
  return indexed.ids;
};

/** Cache a subscription snapshot before already-buffered live events. */
export const mergeSessionEventCache = (
  cache: SessionEventCache,
  sessionId: string,
  snapshot: readonly DurableEvent[],
  live: readonly DurableEvent[] = [],
): readonly DurableEvent[] => {
  const existing = cache.get(sessionId) ?? [];
  const merged = [...mergeDurableEvents(snapshot, [...existing, ...live])];
  cache.set(sessionId, merged);
  cacheIdsFor(cache, sessionId, merged);
  return merged;
};

export const cacheSessionEvent = (cache: SessionEventCache, event: DurableEvent): readonly DurableEvent[] => {
  const existing = cache.get(event.sessionId) ?? [];
  const ids = cacheIdsFor(cache, event.sessionId, existing);
  if (ids.has(event.id)) return existing;
  existing.push(event);
  ids.add(event.id);
  cache.set(event.sessionId, existing);
  return existing;
};

export const sessionEventsFromCache = (cache: ReadonlyMap<string, readonly DurableEvent[]>, sessionId: string): readonly DurableEvent[] => cache.get(sessionId) ?? [];

export const isCurrentSessionSwitch = (activeGeneration: number, requestGeneration: number): boolean => activeGeneration === requestGeneration;

export type PermissionChoice = "allow-once" | "allow-session" | "allow-job" | "reject";
export interface PermissionButton { choice: PermissionChoice; label: string; left: number; right: number; row: number; }
export interface PermissionCard { lines: readonly string[]; buttons: readonly PermissionButton[]; }
export const permissionDecisionForKey = (key: string, selected: PermissionChoice): PermissionChoice | undefined => {
  if (key === "1") return "allow-once";
  if (key === "2") return "allow-session";
  if (key === "a" || key === "A") return "allow-job";
  if (key === "3" || key === "Escape") return "reject";
  if (key === "ArrowLeft" || key === "ArrowUp" || key === "h" || key === "k") return selected === "allow-once" ? "reject" : selected === "allow-session" ? "allow-once" : selected === "allow-job" ? "allow-session" : "allow-job";
  if (key === "ArrowRight" || key === "ArrowDown" || key === "l" || key === "j") return selected === "allow-once" ? "allow-session" : selected === "allow-session" ? "allow-job" : selected === "allow-job" ? "reject" : "allow-once";
  return undefined;
};
export interface PermissionQueueTransition<T extends Pick<TuiPermissionRequest, "admissionId">> {
  readonly queued: readonly T[];
  readonly resolvedAdmissions: ReadonlySet<string>;
}
export const transitionPermissionQueue = <T extends Pick<TuiPermissionRequest, "admissionId">>(
  current: T,
  queued: readonly T[],
  decision: Pick<TuiPermissionDecision, "decision">,
  resolvedAdmissions: ReadonlySet<string>,
): PermissionQueueTransition<T> => {
  const nextResolvedAdmissions = new Set(resolvedAdmissions);
  if (decision.decision === "allow-job" && current.admissionId !== undefined) nextResolvedAdmissions.add(current.admissionId);
  return {
    queued: queued.filter((request) => request.admissionId === undefined || !nextResolvedAdmissions.has(request.admissionId)),
    resolvedAdmissions: nextResolvedAdmissions,
  };
};
export const isPermissionAdmissionLocallyResolved = (request: Pick<TuiPermissionRequest, "admissionId">, resolvedAdmissions: ReadonlySet<string>): boolean => request.admissionId !== undefined && resolvedAdmissions.has(request.admissionId);
export const permissionInputTokens = (input: string): readonly string[] => input.match(/\x1b(?:\[[ABCD]|O[ABCD])|\r\n|\r|\n|[\s\S]/g) ?? [];
export const containsInterrupt = (input: string): boolean => input.includes("\x03") || input.includes("\x04");
export const containsQuitSubmission = (input: string): boolean => {
  const lines = input.split(/\r\n|\r|\n/);
  lines.pop();
  return lines.some((line) => /^\/(?:quit|exit)$/.test(line.trim()));
};
export const splitReadlineInput = (input: string): { line: string; remainder: string } => {
  const index = input.search(/[\r\n]/);
  if (index < 0) return { line: input, remainder: "" };
  const end = input[index] === "\r" && input[index + 1] === "\n" ? index + 2 : index + 1;
  return { line: input.slice(0, end), remainder: input.slice(end) };
};
const shiftEnterSequences = ["\x1b[13;2u", "\x1b[27;2;13~"] as const;
const shiftEnterMarker = "\x00";
export const prepareShiftEnterInput = (pending: string, chunk: string): { input: string; pending: string } => {
  const combined = pending + chunk;
  let pendingLength = 0;
  for (const sequence of shiftEnterSequences) {
    for (let length = 1; length < sequence.length; length += 1) {
      if (length > pendingLength && combined.endsWith(sequence.slice(0, length))) pendingLength = length;
    }
  }
  const complete = pendingLength === 0 ? combined : combined.slice(0, -pendingLength);
  return {
    input: shiftEnterSequences.reduce((input, sequence) => input.replaceAll(sequence, shiftEnterMarker), complete),
    pending: pendingLength === 0 ? "" : combined.slice(-pendingLength),
  };
};
export const shouldQueueMouseAfterSubmittedLine = (readlineInput: string): boolean => /[\r\n]/.test(readlineInput);
export const splitMouseInputAfterSubmittedLine = (readlineInput: string, mouseInput: string): { before: string; after: string } => {
  const lineEnd = readlineInput.search(/[\r\n]/);
  if (lineEnd < 0) return { before: mouseInput, after: "" };
  const packet = /\x1b\[<[0-9;]+[Mm]/y;
  let textOffset = 0;
  let cursor = 0;
  let before = "";
  let after = "";
  const append = (value: string, isBefore: boolean): void => {
    if (isBefore) before += value;
    else after += value;
  };
  while (cursor < mouseInput.length) {
    packet.lastIndex = cursor;
    const match = packet.exec(mouseInput);
    if (match !== null && match.index === cursor) {
      append(match[0], textOffset <= lineEnd);
      cursor += match[0].length;
      continue;
    }
    const character = mouseInput[cursor] ?? "";
    append(character, textOffset <= lineEnd);
    textOffset += 1;
    cursor += 1;
  }
  return { before, after };
};
export const parsePermissionSuggestion = (input: string, limit = 160): string | undefined => {
  const match = /^s\s+(.+?)(?:\r?\n)?$/.exec(input);
  if (match === null) return undefined;
  const redacted = redactJson(match[1] ?? "");
  return (typeof redacted === "string" ? neutralizeControls(redacted) : "").trim().slice(0, Math.max(1, limit));
};
export const permissionHitTest = (row: number, column: number, buttons: readonly PermissionButton[]): PermissionChoice | undefined => buttons.find((button) => button.row === row && column >= button.left && column <= button.right)?.choice;
export const offsetPermissionButtons = (buttons: readonly PermissionButton[], rowOffset: number, columnOffset: number): readonly PermissionButton[] => buttons.map((button) => ({ ...button, row: button.row + rowOffset, left: button.left + columnOffset, right: button.right + columnOffset }));
export const visiblePermissionButtons = (buttons: readonly PermissionButton[], rows: number): readonly PermissionButton[] => {
  const screenRows = Math.max(1, Math.floor(rows));
  return buttons.filter((button) => button.row > 0 && button.row < screenRows);
};
export const permissionMouseChoice = (action: MouseEventAction, button: number, row: number, column: number, buttons: readonly PermissionButton[]): PermissionChoice | undefined => action === "press" && button === 0 ? permissionHitTest(row, column, buttons) : undefined;
export const consumePermissionRelease = (handled: boolean, mouse: Pick<MouseEvent, "action" | "button">): { handled: boolean; consumed: boolean } => handled && mouse.action === "release" && mouse.button === 0 ? { handled: false, consumed: true } : { handled, consumed: false };
type PermissionView = Pick<TuiPermissionRequest, "requiredPermission" | "scope"> & { scopeKey?: string };
type PermissionCardRequest = Omit<TuiPermissionRequest, "requestId">;
const permissionCacheKey = (request: PermissionView): string => `${request.requiredPermission}\u0000${request.scopeKey ?? request.scope}`;
export interface PermissionSessionCache { approver(request: PermissionView): Promise<TuiPermissionDecision>; grant(request: PermissionView): void; has(request: PermissionView): boolean; }
export const createPermissionSessionCache = (): PermissionSessionCache => {
  const grants = new Set<string>();
  return { approver: async (request) => grants.has(permissionCacheKey(request)) ? { decision: "allow-session" } : { decision: "allow-once" }, grant: (request) => { grants.add(permissionCacheKey(request)); }, has: (request) => grants.has(permissionCacheKey(request)) };
};

/** ANSI roles for the RELAY-inspired terminal board. Keep visual choices centralized. */
export const tuiPalette = {
  amber: "\x1b[38;5;214m",
  background: "\x1b[48;5;233m",
  bold: "\x1b[1m",
  cyan: "\x1b[38;5;45m",
  detailsBackground: "\x1b[48;5;235m",
  dim: "\x1b[2m",
  foreground: "\x1b[38;5;255m",
  green: "\x1b[38;5;82m",
  muted: "\x1b[38;5;245m",
  red: "\x1b[38;5;203m",
  reset: "\x1b[0m",
  reverse: "\x1b[7m",
  reverseOff: "\x1b[27m",
  selectedBackground: "\x1b[48;5;30m",
  selectedForeground: "\x1b[38;5;255m",
} as const;

const ansi = tuiPalette;

const MIN_TERMINAL_WIDTH = 20;
const MAX_TERMINAL_WIDTH = 240;
const ansiSequence = /(?:\x1b\](?:(?!\x07|\x1b\\|\x9c)[\s\S])*(?:\x07|\x1b\\|\x9c|$)|\x1b(?:P|X|\^|_)(?:(?!\x1b\\|\x9c)[\s\S])*(?:\x1b\\|\x9c|$)|(?:\x90|\x98|\x9b|\x9d|\x9e|\x9f)(?:(?!\x07|\x1b\\|\x9c)[\s\S])*(?:\x07|\x1b\\|\x9c|$)|\x1b7[\s\S]*?(?:\x1b8|$)|\x1b\[[0-?]*[ -/]*[@-~]|\x1b[ -/]*[@-~])/g;
const styledTokenPattern = /(\x1b\](?:[^\x07\x1b]|\x1b(?!\\))*?(?:\x07|\x1b\\|\x9c)|\x1b\[[0-?]*[ -/]*[@-~])/g;
const styledToken = /^(?:\x1b\](?:[^\x07\x1b]|\x1b(?!\\))*?(?:\x07|\x1b\\|\x9c)|\x1b\[[0-?]*[ -/]*[@-~])$/;
const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export const terminalWidth = (columns: number | undefined = processStdout.columns): number => {
  const value = Number.isFinite(columns) ? Math.floor(columns as number) : 80;
  return Math.min(MAX_TERMINAL_WIDTH, Math.max(MIN_TERMINAL_WIDTH, value));
};

export const hasSupportedTerminalWidth = (columns: number | undefined = processStdout.columns): boolean => {
  const value = Number.isFinite(columns) ? Math.floor(columns as number) : 80;
  return value >= MIN_TERMINAL_WIDTH;
};

export { parseTerminalCellPixelSize, type TerminalCellPixelSize } from "./kitty-graphics.js";

/** Remove complete CSI 16t replies and retain only a trailing partial reply for the next input chunk. */
export const consumeTerminalCellPixelResponses = (pending: string, input: string): { pending: string; input: string; cellPixels: TerminalCellPixelSize | undefined } => {
  let cellPixels: TerminalCellPixelSize | undefined;
  let remaining = `${pending}${input}`.replace(/\x1b\[6;\d+;\d+t/g, (response) => {
    cellPixels = parseTerminalCellPixelSize(response) ?? cellPixels;
    return "";
  });
  const partialStart = remaining.lastIndexOf("\x1b");
  const partial = partialStart < 0 ? "" : remaining.slice(partialStart);
  const incompleteResponse = partial === "\x1b" || partial === "\x1b[" || partial === "\x1b[6" || /^\x1b\[6;\d*(?:;\d*)?$/.test(partial);
  if (partialStart >= 0 && incompleteResponse) {
    const nextPending = remaining.slice(partialStart);
    remaining = remaining.slice(0, partialStart);
    return { pending: nextPending, input: remaining, cellPixels };
  }
  return { pending: "", input: remaining, cellPixels };
};

export const startTerminalMouseFrame = (): string => "\x1b[?25;1003;1006s\x1b[?1003;1006h\x1b[?25l\x1b[16t";

export const shutdownTerminalFrame = (kitty: boolean, restoreSavedModes = true): string => `${kitty ? clearKittyImages() : ""}\x1b[?1003l\x1b[?1006l\x1b[?25h${restoreSavedModes ? "\x1b[?25;1003;1006r" : ""}\x1b[0m\n`;

export const runTuiCleanup = (
  cleanupBody: () => void,
  restoreRawMode: () => void,
  shutdownTerminal: () => void,
  initialErrors: readonly unknown[] = [],
): void => {
  const errors: unknown[] = [];
  const collectError = (error: unknown): void => {
    if (error instanceof AggregateError) {
      for (const nestedError of error.errors) collectError(nestedError);
      return;
    }
    errors.push(error);
  };
  for (const initialError of initialErrors) collectError(initialError);
  try {
    cleanupBody();
  } catch (error) {
    collectError(error);
  }
  try {
    restoreRawMode();
  } catch (error) {
    collectError(error);
  } finally {
    try {
      shutdownTerminal();
    } catch (error) {
      collectError(error);
    }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, "TUI cleanup failed");
};

export interface ChartSurfacePlacement { row: number; column: number; columns: number; rows: number; }

interface ChartHoverIdentityBase {
  readonly chartId: string;
  readonly occurrence: number;
  readonly title: string;
}

export type ChartHoverTarget =
  | (ChartHoverIdentityBase & { readonly kind: "line-chart" | "bar-chart"; readonly pointIndex: number; readonly label: string; readonly value: number })
  | (ChartHoverIdentityBase & { readonly kind: "kline-chart"; readonly pointIndex: number; readonly candleIndex: number; readonly series: "candle" | "volume"; readonly label: string; readonly open: number; readonly high: number; readonly low: number; readonly close: number; readonly volume: number; readonly value: number })
  | (ChartHoverIdentityBase & { readonly kind: "heatmap-chart"; readonly pointIndex: number; readonly rowIndex: number; readonly columnIndex: number; readonly row: string; readonly column: string; readonly value: number })
  | (ChartHoverIdentityBase & { readonly kind: "pie-chart"; readonly pointIndex: number; readonly sliceIndex: number; readonly label: string; readonly value: number; readonly percentage: number });

export interface ChartPointerPosition {
  readonly row: number;
  readonly column: number;
}

export type ChartScreenHitBox = ChartHoverTarget & { readonly left: number; readonly top: number; readonly right: number; readonly bottom: number };

export type ChartHoverTransition =
  | { readonly type: "enter"; readonly target: ChartHoverTarget }
  | { readonly type: "change"; readonly target: ChartHoverTarget }
  | { readonly type: "leave"; readonly previous: ChartHoverTarget }
  | { readonly type: "no-op"; readonly target: ChartHoverTarget | undefined };

const chartHoverIdentity = (target: ChartHoverTarget): string => {
  if (target.kind === "line-chart" || target.kind === "bar-chart") return `${target.chartId}\u0000${target.occurrence}\u0000${target.kind}\u0000${target.pointIndex}`;
  if (target.kind === "kline-chart") return `${target.chartId}\u0000${target.occurrence}\u0000${target.kind}\u0000${target.candleIndex}\u0000${target.series}`;
  if (target.kind === "heatmap-chart") return `${target.chartId}\u0000${target.occurrence}\u0000${target.kind}\u0000${target.rowIndex}\u0000${target.columnIndex}`;
  if (target.kind === "pie-chart") return `${target.chartId}\u0000${target.occurrence}\u0000${target.kind}\u0000${target.sliceIndex}`;
  return "";
};

export const translateChartSurfaceHitBoxes = (
  chart: ChartDescriptor,
  chartId: string,
  occurrence: number,
  placement: ChartSurfacePlacement,
  screenRow: number,
  screenColumn: number,
  viewportWidth: number,
  viewportRows: number,
): readonly ChartScreenHitBox[] => {
  const surface = layoutChartSurface(chart, placement.columns, Math.max(1, placement.rows - 3));
  const boxes: ChartScreenHitBox[] = [];
  for (const region of surface.layout.hitRegions) {
    const left = Math.max(1, screenColumn + region.left);
    const right = Math.min(Math.floor(viewportWidth), screenColumn + region.right);
    const top = Math.max(1, screenRow + region.top);
    const bottom = Math.min(Math.floor(viewportRows), screenRow + region.bottom);
    if (left > right || top > bottom) continue;
    if (region.kind === "line-chart" || region.kind === "bar-chart") {
      if (chart.kind !== region.kind) continue;
      const point = chart.points[region.pointIndex];
      if (point === undefined) continue;
      boxes.push({ chartId, occurrence, kind: region.kind, pointIndex: region.pointIndex, title: chart.title, label: point.label, value: point.value, left, top, right, bottom });
    } else if (region.kind === "kline-chart") {
      if (chart.kind !== "kline-chart") continue;
      const candle = chart.candles[region.candleIndex];
      if (candle === undefined) continue;
       boxes.push({ chartId, occurrence, kind: region.kind, pointIndex: region.pointIndex, candleIndex: region.candleIndex, series: region.series, title: chart.title, label: candle.label, open: candle.open, high: candle.high, low: candle.low, close: candle.close, volume: candle.volume, value: region.series === "volume" ? candle.volume : candle.close, left, top, right, bottom });
    } else if (region.kind === "heatmap-chart") {
      if (chart.kind !== "heatmap-chart") continue;
      const value = chart.values[region.rowIndex]?.[region.columnIndex];
      const row = chart.rows[region.rowIndex];
      const column = chart.columns[region.columnIndex];
      if (value === undefined || value === null || row === undefined || column === undefined) continue;
       boxes.push({ chartId, occurrence, kind: region.kind, pointIndex: region.pointIndex, rowIndex: region.rowIndex, columnIndex: region.columnIndex, row, column, value, title: chart.title, left, top, right, bottom });
     } else if (region.kind === "pie-chart") {
      if (chart.kind !== "pie-chart") continue;
      const slice = chart.slices[region.sliceIndex];
      if (slice === undefined) continue;
      const total = chart.slices.reduce((sum, item) => sum + item.value, 0);
       boxes.push({ chartId, occurrence, kind: region.kind, pointIndex: region.pointIndex, sliceIndex: region.sliceIndex, title: chart.title, label: slice.label, value: slice.value, percentage: total === 0 ? 0 : slice.value / total * 100, left, top, right, bottom });
    }
  }
  return boxes;
};

export const hitTestChartScreen = (row: number, column: number, hitBoxes: readonly ChartScreenHitBox[]): ChartHoverTarget | undefined => {
  const hit = hitBoxes.find((box) => row >= box.top && row <= box.bottom && column >= box.left && column <= box.right);
  return hit === undefined ? undefined : hit;
};

export const reconcileChartHoverTarget = (target: ChartHoverTarget | undefined, hitBoxes: readonly ChartScreenHitBox[]): ChartHoverTarget | undefined => {
  if (target === undefined) return undefined;
  return hitBoxes.find((box) => chartHoverIdentity(box) === chartHoverIdentity(target));
};

export const reduceChartHover = (previous: ChartHoverTarget | undefined, next: ChartHoverTarget | undefined): ChartHoverTransition => {
  if (previous === undefined && next === undefined) return { type: "no-op", target: undefined };
  if (previous === undefined && next !== undefined) return { type: "enter", target: next };
  if (previous !== undefined && next === undefined) return { type: "leave", previous };
  if (previous !== undefined && next !== undefined && chartHoverIdentity(previous) === chartHoverIdentity(next)) return { type: "no-op", target: previous };
  return { type: "change", target: next as ChartHoverTarget };
};

export interface ChartHoverReconciliation {
  readonly target: ChartHoverTarget | undefined;
  readonly transition: ChartHoverTransition;
}

export const reconcileChartHoverAtPointer = (
  previous: ChartHoverTarget | undefined,
  pointer: ChartPointerPosition | undefined,
  hitBoxes: readonly ChartScreenHitBox[],
): ChartHoverReconciliation => {
  const next = pointer === undefined ? undefined : hitTestChartScreen(pointer.row, pointer.column, hitBoxes);
  return { target: next, transition: reduceChartHover(previous, next) };
};

export type ChartHoverDispatchTransition = Exclude<ChartHoverTransition, { readonly type: "no-op" }>;

export const dispatchChartHoverMotion = (
  previous: ChartHoverTarget | undefined,
  pointer: ChartPointerPosition | undefined,
  hitBoxes: readonly ChartScreenHitBox[],
  requestFrame: (transition: ChartHoverDispatchTransition) => void,
): ChartHoverReconciliation => {
  const reconciliation = reconcileChartHoverAtPointer(previous, pointer, hitBoxes);
  if (reconciliation.transition.type !== "no-op") requestFrame(reconciliation.transition);
  return reconciliation;
};

const chartHoverValue = (value: number): string => {
  const plain = Number.isInteger(value) ? value.toString() : value.toFixed(2);
  if (plain.length <= 10) return plain;
  return value.toExponential(2).slice(0, 10);
};

export const formatChartHoverFeedback = (target: ChartHoverTarget | undefined, width = terminalWidth()): string => {
  if (target === undefined) return "";
  const safeTitle = singleLineText(target.title);
  let text: string;
  if (target.kind === "line-chart" || target.kind === "bar-chart") text = `CHART · ${safeTitle} · ${singleLineText(target.label)} = ${chartHoverValue(target.value)}`;
  else if (target.kind === "kline-chart") text = `CHART · ${safeTitle} · ${singleLineText(target.label)} ${target.series === "volume" ? "VOLUME" : "CANDLE"} O:${chartHoverValue(target.open)} H:${chartHoverValue(target.high)} L:${chartHoverValue(target.low)} C:${chartHoverValue(target.close)} V:${chartHoverValue(target.volume)}`;
  else if (target.kind === "heatmap-chart") text = `CHART · ${safeTitle} · ${singleLineText(target.row)} × ${singleLineText(target.column)} = ${chartHoverValue(target.value)}`;
   else if (target.kind === "pie-chart") text = `CHART · ${safeTitle} · ${singleLineText(target.label)} = ${chartHoverValue(target.value)} (${target.percentage.toFixed(1)}%)`;
   else text = `CHART · ${safeTitle}`;
  return truncateCells(text, Math.max(1, Math.floor(width)));
};

export const selectActivityFeedback = (
  thinkingStatus: string | undefined,
  transientNotice: string | undefined,
  hoverTarget: ChartHoverTarget | undefined,
  width: number,
): string => thinkingStatus ?? transientNotice ?? formatChartHoverFeedback(hoverTarget, width);

export const chartGraphicRenderKey = (
  chart: ChartDescriptor,
  maxColumns: number,
  rows: number,
  cellPixelWidth: number,
  cellPixelHeight: number,
): string => `${JSON.stringify(chart)}\u0000${maxColumns}\u0000${rows}\u0000${cellPixelWidth}\u0000${cellPixelHeight}`;

export const deriveChartHitBoxes = (
  lines: readonly string[],
  events: readonly DurableEvent[],
  width: number,
  historyHeaderRows: number,
  viewportRows: number,
): readonly ChartScreenHitBox[] => {
  const plainLines = lines.map((line) => line.replace(ansiSequence, ""));
  const hitBoxes: ChartScreenHitBox[] = [];
  let searchRow = 0;
  for (const event of events) {
    const chart = chartDescriptorForToolEvent(event);
    const surfaceText = chartForToolEvent(event, width);
    if (chart === undefined || surfaceText === undefined) continue;
    let occurrence = 0;
    let placement: ChartSurfacePlacement | undefined;
    while ((placement = findChartSurfacePlacement(plainLines, surfaceText.replace(ansiSequence, ""), searchRow)) !== undefined) {
      const currentOccurrence = occurrence;
      occurrence += 1;
      searchRow = placement.row + placement.rows;
      const column = terminalCellWidth(plainLines[placement.row]?.slice(0, placement.column) ?? "") + 1;
      hitBoxes.push(...translateChartSurfaceHitBoxes(chart, event.id, currentOccurrence, placement, historyHeaderRows + placement.row + 1, column, width, viewportRows));
    }
  }
  return hitBoxes;
};

/** Locate one complete visible ANSI chart before replacing only that text footprint with a native image. */
export const findChartSurfacePlacement = (lines: readonly string[], surface: string, startRow = 0): ChartSurfacePlacement | undefined => {
  const surfaceLines = surface.split("\n");
  const first = surfaceLines[0] ?? "";
  if (first.length === 0) return undefined;
  for (let row = Math.max(0, startRow); row + surfaceLines.length <= lines.length; row += 1) {
    const column = lines[row]?.indexOf(first) ?? -1;
    if (column < 0 || !surfaceLines.every((line, offset) => lines[row + offset]?.slice(column, column + line.length) === line)) continue;
    return { row, column, columns: Math.max(...surfaceLines.map((line) => terminalCellWidth(line))), rows: surfaceLines.length };
  }
  return undefined;
};

export interface LatexFallbackSurface { row: number; column: number; cellColumns: readonly number[]; rows: number; }
/** Locate a complete visible LaTeX fallback surface, retaining each row's terminal-cell origin. */
export const findLatexFallbackSurface = (lines: readonly string[], fallback: string, startRow = 0, startColumn = 0, linePrefix = "", lineSuffix = "", requireUnique = false, lineOwners: readonly (string | undefined)[] = [], owner?: string): LatexFallbackSurface | undefined => {
  const fallbackLines = fallback.split("\n");
  const first = fallbackLines[0] ?? "";
  if (first.length === 0) return undefined;
  const matches: LatexFallbackSurface[] = [];
  for (let row = Math.max(0, startRow); row + fallbackLines.length <= lines.length; row += 1) {
    const minimumColumn = row === startRow ? Math.max(0, startColumn) : 0;
    let column = lines[row]?.indexOf(first, minimumColumn) ?? -1;
    while (column >= 0) {
      const lineColumns = fallbackLines.map((line, offset) => offset === 0 ? column : lines[row + offset]?.indexOf(line) ?? -1);
      const prefixMatches = linePrefix.length === 0 || (lines[row]?.slice(0, column) ?? "").endsWith(linePrefix);
      const finalOffset = fallbackLines.length - 1;
      const finalColumn = lineColumns[finalOffset] ?? -1;
      const suffixMatches = lineSuffix.length === 0 || finalColumn >= 0 && (lines[row + finalOffset]?.slice(finalColumn + (fallbackLines[finalOffset]?.length ?? 0)) ?? "").startsWith(lineSuffix);
      const ownerMatches = owner === undefined || fallbackLines.every((_line, offset) => lineOwners[row + offset] === owner);
      if (prefixMatches && suffixMatches && ownerMatches && lineColumns.every((lineColumn) => lineColumn >= 0)) {
        const surface = { row, column, cellColumns: lineColumns.map((lineColumn, offset) => terminalCellWidth(lines[row + offset]?.slice(0, lineColumn) ?? "") + 1), rows: fallbackLines.length };
        if (!requireUnique) return surface;
        matches.push(surface);
      }
      column = lines[row]?.indexOf(first, column + Math.max(1, first.length)) ?? -1;
    }
  }
  return matches.length === 1 ? matches[0] : undefined;
};

export const visibleLatexFallbackSurfaces = <T>(candidates: readonly { value: T; fallback: string; linePrefix?: string; lineSuffix?: string; requireUnique?: boolean; owner?: string }[], lines: readonly string[], limit = 8, lineOwners: readonly (string | undefined)[] = []): readonly { value: T; fallback: string; surface: LatexFallbackSurface }[] => {
  const visible: Array<{ value: T; fallback: string; surface: LatexFallbackSurface }> = [];
  let searchFromRow = 0;
  let searchFromColumn = 0;
  for (const candidate of candidates) {
    const surface = findLatexFallbackSurface(lines, candidate.fallback, candidate.requireUnique === true ? 0 : searchFromRow, candidate.requireUnique === true ? 0 : searchFromColumn, candidate.linePrefix, candidate.lineSuffix, candidate.requireUnique, lineOwners, candidate.owner);
    if (surface === undefined) continue;
    const firstLine = candidate.fallback.split("\n")[0] ?? "";
    searchFromRow = surface.row;
    searchFromColumn = surface.column + firstLine.length;
    if (searchFromColumn >= (lines[surface.row]?.length ?? 0)) {
      searchFromRow += 1;
      searchFromColumn = 0;
    }
    visible.push({ value: candidate.value, fallback: candidate.fallback, surface });
    if (visible.length >= limit) break;
  }
  return visible;
};

/** Apply only a successful result from the exact render that still owns this cache entry. */
export const shouldApplyGraphicRender = <T>(cache: Map<string, Promise<T | undefined>>, key: string, promise: Promise<T | undefined>, graphic: T | undefined): graphic is T => graphic !== undefined && cache.get(key) === promise;

const isCombining = (codePoint: number): boolean => codePoint === 0x200d || codePoint === 0xfe0e || codePoint === 0xfe0f || codePoint >= 0x300 && codePoint <= 0x36f || codePoint >= 0x1ab0 && codePoint <= 0x1aff || codePoint >= 0x1dc0 && codePoint <= 0x1dff || codePoint >= 0x20d0 && codePoint <= 0x20ff || codePoint >= 0xfe20 && codePoint <= 0xfe2f;
const isEmojiModifier = (codePoint: number): boolean => codePoint >= 0x1f3fb && codePoint <= 0x1f3ff;

const isWideCodePoint = (codePoint: number): boolean => codePoint >= 0x1100 && (codePoint <= 0x115f || codePoint === 0x2329 || codePoint === 0x232a || codePoint >= 0x2e80 && codePoint <= 0xa4cf || codePoint >= 0xac00 && codePoint <= 0xd7a3 || codePoint >= 0xf900 && codePoint <= 0xfaff || codePoint >= 0xfe10 && codePoint <= 0xfe19 || codePoint >= 0xfe30 && codePoint <= 0xfe6f || codePoint >= 0xff00 && codePoint <= 0xff60 || codePoint >= 0xffe0 && codePoint <= 0xffe6 || codePoint >= 0x1f300 && codePoint <= 0x1faff);

/** Return terminal cells, conservatively treating East Asian and emoji glyphs as wide. */
export const terminalCellWidth = (text: string): number => {
  let width = 0;
  for (const grapheme of graphemes(text.replace(ansiSequence, ""))) {
    if (grapheme.includes("\u20e3") || /\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(grapheme)) {
      width += 2;
    } else {
      width += cellWidthWithoutControls(grapheme);
    }
  }
  return width;
};

const codePointCellWidth = (character: string): number => {
  const codePoint = character.codePointAt(0) ?? 0;
  if (codePoint < 0x20 || isCombining(codePoint) || isEmojiModifier(codePoint)) return 0;
  return isWideCodePoint(codePoint) ? 2 : 1;
};

const cellWidthWithoutControls = (text: string): number => Array.from(text).reduce((total, character) => total + codePointCellWidth(character), 0);

const graphemes = (text: string): readonly string[] => Array.from(graphemeSegmenter.segment(text), (part) => part.segment);

const visibleWidth = (text: string): number => terminalCellWidth(text);

const truncateCells = (text: string, width: number): string => {
  let result = "";
  let used = 0;
  for (const token of text.split(styledTokenPattern).filter((part) => part.length > 0)) {
    if (styledToken.test(token)) {
      result += token;
      continue;
    }
    for (const character of graphemes(token)) {
      const cells = terminalCellWidth(character);
      if (used + cells > width) return result;
      result += character;
      used += cells;
    }
  }
  return result;
};

const maskAnsiCells = (text: string, start: number, length: number): string => {
  if (length <= 0) return text;
  let cells = 0;
  let reverseActive = false;
  let masking = false;
  return text.split(styledTokenPattern).filter((part) => part.length > 0).map((token) => {
    if (styledToken.test(token)) {
      const sgr = /^\x1b\[([0-9;]*)m$/.exec(token);
      if (sgr !== null) {
        const parameters = sgr[1] === "" ? [0] : sgr[1]?.split(";").map(Number) ?? [];
        for (const parameter of parameters) {
          if (parameter === 0 || parameter === 27) reverseActive = false;
          else if (parameter === 7) reverseActive = true;
        }
      }
      return masking && reverseActive ? `${token}${ansi.reverseOff}` : token;
    }
    return graphemes(token).map((grapheme) => {
      const width = terminalCellWidth(grapheme);
      const masked = cells < start + length && cells + width > start;
      let prefix = "";
      if (masked && !masking && reverseActive) prefix = ansi.reverseOff;
      else if (!masked && masking && reverseActive) prefix = ansi.reverse;
      masking = masked;
      cells += width;
      return `${prefix}${masked ? " ".repeat(Math.max(1, width)) : grapheme}`;
    }).join("");
  }).join("");
};

export interface LatexFallbackMask { row: number; column: number; width: number; }
export const applyGraphicFallbackMasks = (screenLines: readonly string[], masks: readonly LatexFallbackMask[]): string[] => {
  const maskedLines = [...screenLines];
  for (const mask of masks) {
    const lineIndex = mask.row - 1;
    if (lineIndex >= 0 && lineIndex < maskedLines.length) maskedLines[lineIndex] = maskAnsiCells(maskedLines[lineIndex] ?? "", mask.column - 1, mask.width);
  }
  return maskedLines;
};
export const chartFallbackMasks = (placement: ChartSurfacePlacement, rowOffset: number, column: number): readonly LatexFallbackMask[] => Array.from({ length: placement.rows }, (_unused, offset) => ({ row: rowOffset + placement.row + offset + 1, column, width: placement.columns }));
export const latexFallbackMasks = (fallback: string, plainLines: readonly string[], firstRow: number, firstColumn: number, rowOffset = 0): readonly LatexFallbackMask[] => fallback.split("\n").flatMap((line, offset) => {
  if (line.length === 0) return [];
  const row = firstRow + offset;
  const text = plainLines[row];
  const lineColumn = offset === 0 ? firstColumn : text?.indexOf(line) ?? -1;
  if (lineColumn < 0) return [];
  return [{ row: row + rowOffset, column: terminalCellWidth(text?.slice(0, lineColumn) ?? "") + 1, width: terminalCellWidth(line) }];
});
/** A native formula may replace its fallback when its bounded raster fits this layout. */
export const canPlaceLatexGraphic = (graphic: LatexRasterGraphic, fallback: string, availableColumns: number): boolean => graphic.rows > 0 && graphic.rows <= fallback.split("\n").length && graphic.columns > 0 && graphic.columns <= availableColumns;
export const latexGraphicRowBudget = (surface: LatexFallbackSurface): number => Math.max(1, surface.rows);
export const latexGraphicRenderKey = (segment: LatexGraphicSegment, maxColumns: number, maxRows: number, cellWidth: number, cellHeight: number): string => `${latexGraphicKey(segment)}\u0000${maxColumns}\u0000${maxRows}\u0000${cellWidth}\u0000${cellHeight}`;
const textOccurrenceCount = (text: string, value: string): number => {
  if (value.length === 0) return 0;
  let count = 0;
  let offset = 0;
  while ((offset = text.indexOf(value, offset)) >= 0) {
    count += 1;
    offset += Math.max(1, value.length);
  }
  return count;
};
export const nativeLatexGraphicCandidates = (assistant: string): readonly { segment: LatexGraphicSegment; occurrence: number; fallback: string; linePrefix: string; lineSuffix: string; uniqueContext: boolean }[] => {
  const matches = extractLatexGraphicMatches(assistant);
  let sentinel = "FINLEETLATEXMARK";
  while (assistant.includes(sentinel)) sentinel += "X";
  const markers = matches.map((_match, occurrence) => ({ start: `${sentinel}START${occurrence}X:`, end: `:${sentinel}END${occurrence}X` }));
  let cursor = 0;
  const markedAssistant = matches.map((match, occurrence) => {
    const marker = markers[occurrence];
    const chunk = `${assistant.slice(cursor, match.start)}${marker?.start ?? ""}${assistant.slice(match.start, match.end)}${marker?.end ?? ""}`;
    cursor = match.end;
    return chunk;
  }).join("") + assistant.slice(cursor);
  const markedRendered = renderMarkdown(markedAssistant).replace(ansiSequence, "");
  const removeMarkers = (value: string): string => markers.reduce((result, marker) => result.replaceAll(marker.start, "").replaceAll(marker.end, ""), value);
  const renderedAssistant = removeMarkers(markedRendered);
  return matches.flatMap((match, occurrence) => {
    const marker = markers[occurrence];
    if (marker === undefined) return [];
    const start = markedRendered.indexOf(marker.start);
    const end = start < 0 ? -1 : markedRendered.indexOf(marker.end, start + marker.start.length);
    if (start < 0 || end < 0) return [];
    const renderedPrefix = removeMarkers(markedRendered.slice(0, start));
    const renderedSuffix = removeMarkers(markedRendered.slice(end + marker.end.length));
    const linePrefix = renderedPrefix.split("\n").at(-1) ?? "";
    const lineSuffix = renderedSuffix.split("\n")[0] ?? "";
    const fallback = markedRendered.slice(start + marker.start.length, end);
    return [{ segment: match.segment, occurrence, fallback, linePrefix, lineSuffix, uniqueContext: textOccurrenceCount(renderedAssistant, `${linePrefix}${fallback}${lineSuffix}`) === 1 }];
  });
};

const wrapAnsiLine = (line: string, width: number): string[] => {
  const output: string[] = [];
  let current = "";
  let count = 0;
  let activeLink: string | undefined;
  const closeLink = "\x1b]8;;\x1b\\";
  for (const token of line.split(styledTokenPattern).filter((part) => part.length > 0)) {
    if (osc8Close.test(token)) {
      current += token;
      activeLink = undefined;
      continue;
    }
    if (osc8Open.test(token)) {
      current += token;
      activeLink = token;
      continue;
    }
    if (styledToken.test(token)) {
      current += token;
      continue;
    }
    for (const character of graphemes(token)) {
      const characterWidth = terminalCellWidth(character);
      if (count > 0 && count + characterWidth > width) {
        output.push(activeLink === undefined ? current : `${current}${closeLink}`);
        current = activeLink ?? "";
        count = 0;
      }
      current += character;
      count += characterWidth;
    }
  }
  if (activeLink !== undefined) current += closeLink;
  output.push(current);
  return output.length === 0 ? [""] : output;
};

const wrapText = (text: string, width: number): string[] => text.split("\n").flatMap((line) => wrapAnsiLine(line, width));
const preservePanelBackground = (content: string, background: string): string => content.replace(/\x1b\[([0-9;]*)m/g, (sequence: string, parameters: string): string => {
  const codes = parameters.length === 0 ? [0] : parameters.split(";").map(Number);
  return codes.includes(0) || codes.includes(49) ? `${sequence}${background}${ansi.foreground}` : sequence;
});

const panelLine = (content: string, width: number, border: string = ansi.cyan, background: string = ansi.background): string => {
  const innerWidth = Math.max(1, width - 4);
  const wrapped = wrapAnsiLine(content, innerWidth)[0] ?? "";
  const padding = " ".repeat(Math.max(0, innerWidth - visibleWidth(wrapped)));
  return `${background}${border}│${ansi.reset}${background}${ansi.foreground} ${preservePanelBackground(wrapped, background)}${padding} ${border}│${ansi.reset}`;
};

const panelTop = (title: string, width: number, border: string = ansi.cyan): string => {
  const safeTitle = truncateCells(title, Math.max(1, width - 5));
  const rule = "─".repeat(Math.max(0, width - visibleWidth(safeTitle) - 5));
  return `${ansi.background}${border}┌─${ansi.reset}${ansi.background} ${ansi.cyan}${ansi.bold}${safeTitle}${ansi.reset}${ansi.background} ${border}${rule}┐${ansi.reset}`;
};
const panelBottom = (width: number, border: string = ansi.cyan): string => `${ansi.background}${border}└${"─".repeat(Math.max(0, width - 2))}┘${ansi.reset}`;

const sectionBanner = (label: string, detail: string, width: number): string => {
  const prefix = `${ansi.cyan}${ansi.bold}${label}${ansi.reset}${ansi.background}${ansi.foreground} // ${ansi.muted}${detail}${ansi.reset}${ansi.background}`;
  const clipped = truncateCells(prefix, Math.max(1, width - 1));
  return `${ansi.background}${clipped}${ansi.cyan}${"─".repeat(Math.max(0, width - visibleWidth(clipped)))}${ansi.reset}`;
};

export const renderPermissionCard = (request: PermissionCardRequest, width = terminalWidth(), selected: PermissionChoice = "allow-once"): PermissionCard => {
  const safeWidth = terminalWidth(width);
  const inner = Math.max(12, safeWidth - 4);
  const argumentText = JSON.stringify(redactJson(request.arguments));
  const lines = [
    panelTop("PERMISSION REQUIRED // ACTION GATE", safeWidth, ansi.cyan),
    panelLine(`${ansi.cyan}TOOL${ansi.reset} ${singleLineText(redactOutputText(request.toolName))}`, safeWidth),
    ...(request.agentId === undefined ? [] : [panelLine(`${ansi.cyan}AGENT${ansi.reset} ${singleLineText(redactOutputText(request.agentId))}`, safeWidth)]),
    panelLine(`${ansi.cyan}CAPABILITY${ansi.reset} ${singleLineText(request.requiredPermission)}`, safeWidth),
    panelLine(`${ansi.cyan}SCOPE${ansi.reset} ${truncateCells(singleLineText(redactOutputText(request.scope)), Math.max(1, inner - 2))}`, safeWidth),
    panelLine(`${ansi.cyan}ARGUMENTS${ansi.reset} ${truncateCells(singleLineText(argumentText), Math.max(1, inner - 2))}`, safeWidth),
    panelLine(`${ansi.cyan}REVIEW${ansi.reset}`, safeWidth),
    ...request.reviewSteps.slice(0, 3).flatMap((step) => wrapText(`  • ${terminalText(redactOutputText(step))}`, Math.max(1, inner)).map((line) => panelLine(line, safeWidth))),
    panelLine(`${ansi.amber}CHOOSE ACTION${ansi.reset}  (s <feedback> rejects with bounded feedback)`, safeWidth),
  ];
  const labels: readonly [PermissionChoice, string][] = [["allow-once", "[1] ALLOW ONCE"], ["allow-session", "[2] ALLOW THIS SESSION"], ["allow-job", "[A] ALLOW THIS JOB"], ["reject", "[3] REJECT"]];
  const combinedWidth = labels.reduce((total, [, label], index) => total + terminalCellWidth(label) + (index === 0 ? 0 : 2), 0);
  const buttonRows = combinedWidth <= inner ? [labels] : labels.map((label) => [label] as const);
  const buttons: PermissionButton[] = [];
  const styledButton = (button: PermissionButton): string => {
    const shortcut = button.label.slice(0, 3);
    const label = `${ansi.amber}${shortcut}${ansi.reset}${button.label.slice(3)}`;
    return button.choice === selected ? `${ansi.selectedBackground}${ansi.selectedForeground}${ansi.bold}${label}${ansi.reset}${ansi.background}` : label;
  };
  for (const rowLabels of buttonRows) {
    const row = lines.length + 1;
    let column = 3;
    const rowButtons = rowLabels.map(([choice, fullLabel]) => {
      const label = truncateCells(fullLabel, inner);
      const button: PermissionButton = { choice, label, left: column, right: Math.min(safeWidth - 2, column + terminalCellWidth(label) - 1), row };
      column += terminalCellWidth(label) + 2;
      buttons.push(button);
      return button;
    });
    lines.push(panelLine(rowButtons.map(styledButton).join("  "), safeWidth));
  }
  lines.push(panelBottom(safeWidth, ansi.cyan));
  return { lines, buttons };
};

const thinkingFrames = ["◐", "◓", "◑", "◒"] as const;

export const writeTerminalFrame = (write: (text: string) => void, chunks: readonly string[]): void => {
  write(chunks.join(""));
};

/** Keep an iTerm2 repaint hidden until text, OSC graphics, readline, and footer are complete. */
export const synchronizedTerminalFrame = (frame: string): string => `\x1b[?2026h${frame}\x1b[?2026l`;

export type ReadlineTerminalGeometry = Pick<NodeJS.WriteStream, "columns" | "rows" | "isTTY">;

/** Writable readline output that keeps terminal repaint bytes in the frame transaction. */
export class ReadlineOutputCapture extends Writable {
  private captured = "";
  private readonly terminal: ReadlineTerminalGeometry;

  public constructor(terminal: ReadlineTerminalGeometry) {
    super({
      write: (chunk: unknown, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void => {
        this.captured += typeof chunk === "string" ? chunk : Buffer.from(chunk as Uint8Array).toString();
        callback();
      },
    });
    this.terminal = terminal;
  }

  /** Keep readline's wrapping width identical to the bounded canvas width. */
  public get columns(): number { return terminalWidth(this.terminal.columns); }
  public get rows(): number { return this.terminal.rows; }
  public get isTTY(): boolean { return this.terminal.isTTY; }

  public discardCaptured(): void { this.captured = ""; }
  public takeCaptured(): string {
    const captured = this.captured;
    this.captured = "";
    return captured;
  }

  public clearLine(direction: -1 | 0 | 1, callback?: () => void): boolean {
    const sequence = direction < 0 ? "\x1b[1K" : direction > 0 ? "\x1b[0K" : "\x1b[2K";
    this.captured += sequence;
    callback?.();
    return true;
  }

  public clearScreenDown(callback?: () => void): boolean {
    this.captured += "\x1b[0J";
    callback?.();
    return true;
  }

  public cursorTo(x: number, callback?: () => void): boolean;
  public cursorTo(x: number, y: number, callback?: () => void): boolean;
  public cursorTo(x: number, yOrCallback?: number | (() => void), callback?: () => void): boolean {
    const column = Math.max(0, Math.floor(x)) + 1;
    const y = typeof yOrCallback === "number" ? yOrCallback : undefined;
    this.captured += y === undefined ? `\x1b[${column}G` : `\x1b[${Math.max(0, Math.floor(y)) + 1};${column}H`;
    (typeof yOrCallback === "function" ? yOrCallback : callback)?.();
    return true;
  }

  public moveCursor(dx: number, dy: number, callback?: () => void): boolean {
    const horizontal = Math.floor(dx);
    const vertical = Math.floor(dy);
    if (horizontal !== 0) this.captured += `\x1b[${Math.abs(horizontal)}${horizontal > 0 ? "C" : "D"}`;
    if (vertical !== 0) this.captured += `\x1b[${Math.abs(vertical)}${vertical > 0 ? "B" : "A"}`;
    callback?.();
    return true;
  }
}

export const composeReadlineFrame = (frame: string, readlineRepaint: string, footerRepaint: string): string => `${frame}${readlineRepaint}\x1b[s${footerRepaint}\x1b[u`;

export interface FrameScheduler {
  request(): void;
  flush(): void;
  cancel(): void;
}

export const createFrameScheduler = <H>(commit: () => void, schedule: (callback: () => void, delayMs: number) => H, cancel: (handle: H) => void, delayMs = 16): FrameScheduler => {
  let pending: H | undefined;
  let generation = 0;
  return {
    request: (): void => {
      if (pending !== undefined) return;
      const scheduledGeneration = ++generation;
      pending = schedule(() => {
        if (scheduledGeneration !== generation) return;
        pending = undefined;
        commit();
      }, delayMs);
    },
    flush: (): void => {
      generation += 1;
      if (pending !== undefined) {
        cancel(pending);
        pending = undefined;
      }
      commit();
    },
    cancel: (): void => {
      generation += 1;
      if (pending === undefined) return;
      cancel(pending);
      pending = undefined;
    },
  };
};

export const commitPermissionBeforeBufferedInput = (commit: () => void, consumeBufferedInput: () => void): void => { commit(); consumeBufferedInput(); };

export const thinkingFrame = (frame: number, elapsedMs: number): string => {
  const glyph = thinkingFrames[Math.abs(frame) % thinkingFrames.length] ?? thinkingFrames[0];
  const elapsedSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
  return `${ansi.cyan}${glyph}${ansi.reset} ${ansi.amber}${ansi.bold}THINKING${ansi.reset} ${ansi.muted}· ${elapsedSeconds}s · working through the harness${ansi.reset}`;
};

interface ThinkingAnimation {
  stop: () => void;
}

const startThinkingAnimation = (update: (status: string | undefined, active: boolean) => void, now: () => number = Date.now, schedule: (callback: () => void, delayMs: number) => ReturnType<typeof setInterval> = setInterval, cancel: (timer: ReturnType<typeof setInterval>) => void = clearInterval): ThinkingAnimation => {
  const startedAt = now();
  let frame = 0;
  let stopped = false;
  const render = (): void => {
    if (!stopped) update(thinkingFrame(frame++, now() - startedAt), true);
  };
  render();
  const timer = schedule(render, 160);
  return {
    stop: (): void => {
      if (stopped) return;
      stopped = true;
      cancel(timer);
      update(undefined, false);
    },
  };
};

const neutralizeControls = (text: string): string => text.replace(ansiSequence, "").replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "").replace(/\x1b/g, "");
const singleLineText = (text: string): string => neutralizeControls(text).replace(/[\r\n\t]+/g, " ");

export const safeHttpUrl = (value: string): string | undefined => {
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && url.username === "" && url.password === "" && url.search === "" && url.hash === "" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
};

export interface TerminalLinkRange {
  url: string;
  startColumn: number;
  endColumn: number;
}

const osc8Open = /^\x1b\]8;;([^\x07\x1b]*)(?:\x07|\x1b\\)$/;
const osc8Close = /^\x1b\]8;;(?:\x07|\x1b\\)$/;

/** Extract only validated links from rendered OSC-8 text or visible Markdown/plain URLs. */
export const extractTerminalLinks = (text: string): readonly TerminalLinkRange[] => {
  const links: TerminalLinkRange[] = [];
  let active: { url: string; startColumn: number } | undefined;
  let column = 0;
  for (const token of text.split(styledTokenPattern).filter((part) => part.length > 0)) {
    if (osc8Close.test(token)) {
      if (active !== undefined && column > active.startColumn) links.push({ url: active.url, startColumn: active.startColumn, endColumn: column });
      active = undefined;
      continue;
    }
    const open = osc8Open.exec(token);
    if (open !== null) {
      const url = safeHttpUrl(open[1] ?? "");
      active = url === undefined ? undefined : { url, startColumn: column };
      continue;
    }
    if (ansiSequence.test(token)) {
      ansiSequence.lastIndex = 0;
      continue;
    }
    column += terminalCellWidth(token);
    if (active !== undefined) active = { ...active };
  }
  if (active !== undefined && column > active.startColumn) links.push({ url: active.url, startColumn: active.startColumn, endColumn: column });
  if (links.length > 0) return links;

  const visible = neutralizeControls(text);
  const markdown = /\[([^\]\n]+)\]\(([^\s)]+)\)/g;
  let match: RegExpExecArray | null;
  while ((match = markdown.exec(visible)) !== null) {
    const label = match[1] ?? "";
    const url = safeHttpUrl(match[2] ?? "");
    if (url !== undefined) {
      const startColumn = terminalCellWidth(visible.slice(0, match.index + 1));
      links.push({ url, startColumn, endColumn: startColumn + terminalCellWidth(label) });
    }
  }
  if (links.length > 0) return links;
  const bare = /https?:\/\/[^\s<>()]+/g;
  while ((match = bare.exec(visible)) !== null) {
    const url = safeHttpUrl(match[0] ?? "");
    if (url !== undefined) {
      const startColumn = terminalCellWidth(visible.slice(0, match.index));
      links.push({ url, startColumn, endColumn: startColumn + terminalCellWidth(match[0] ?? "") });
    }
  }
  return links;
};

export interface TerminalLinkHitBox {
  url: string;
  row: number;
  left: number;
  right: number;
}

export const hitTestTerminalLink = (row: number, column: number, hitBoxes: readonly TerminalLinkHitBox[]): string | undefined => hitBoxes.find((box) => box.row === row && column >= box.left && column <= box.right)?.url;

const terminalLink = (label: string, target: string): string => {
  const url = safeHttpUrl(target);
  return url === undefined ? label : `\x1b]8;;${url}\x1b\\${label}\x1b]8;;\x1b\\`;
};

const terminalText = (value: string): string => neutralizeControls(value).replace(/\t/g, " ");

const LATEX_MAX_SOURCE_LENGTH = 2_048;
const LATEX_MAX_EXPANDED_LENGTH = 8_192;
const LATEX_MAX_DEPTH = 32;

const renderLatexSource = (source: string, displayMode: boolean): string | undefined => {
  if (source.length > LATEX_MAX_SOURCE_LENGTH) return undefined;
  try {
    return terminalText(renderLatexToString(source, {
      compactScripts: true,
      displayMode,
      maxDepth: LATEX_MAX_DEPTH,
      maxExpandedLength: LATEX_MAX_EXPANDED_LENGTH,
      maxSourceLength: LATEX_MAX_SOURCE_LENGTH,
      strict: true,
    }));
  } catch {
    return undefined;
  }
};

const protectLatexSegments = (text: string, math: string[]): string => {
  const delimiter = /\$\$([\s\S]*?)\$\$|\\\[([\s\S]*?)\\\]|\\\(([\s\S]*?)\\\)|(?<![\w$])\$([^$\n]+?)\$(?![\w$])/g;
  const rendered: string[] = [];
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = delimiter.exec(text)) !== null) {
    rendered.push(text.slice(cursor, match.index));
    const source = match[1] ?? match[2] ?? match[3] ?? match[4] ?? "";
    const displayMode = match[1] !== undefined || match[2] !== undefined;
    const value = renderLatexSource(source, displayMode) ?? match[0];
    math.push(value);
    rendered.push(`\u0001latex${math.length - 1}\u0001`);
    cursor = match.index + match[0].length;
  }
  rendered.push(text.slice(cursor));
  return rendered.join("");
};

/** Restore original math delimiters when a rendered assistant selection is copied. */
export const restoreLatexSources = (renderedText: string, originalText: string): string => {
  const delimiter = /\$\$([\s\S]*?)\$\$|\\\[([\s\S]*?)\\\]|\\\(([\s\S]*?)\\\)|(?<![\w$])\$([^$\n]+?)\$(?![\w$])/g;
  const replacements: Array<{ rendered: string; source: string }> = [];
  let match: RegExpExecArray | null;
  while ((match = delimiter.exec(originalText)) !== null) {
    const source = match[1] ?? match[2] ?? match[3] ?? match[4] ?? "";
    const displayMode = match[1] !== undefined || match[2] !== undefined;
    const rendered = renderLatexSource(source, displayMode);
    if (rendered !== undefined && rendered !== match[0]) replacements.push({ rendered, source: match[0] });
  }
  const candidatesFor = (rendered: string): readonly string[] => {
    const candidates = new Set([rendered]);
    const lines = rendered.split("\n");
    for (let boundary = 1; boundary < lines.length; boundary += 1) {
      for (const fragment of [lines.slice(0, boundary).join("\n"), lines.slice(boundary).join("\n")]) {
        for (const candidate of [fragment, fragment.trimStart(), fragment.trimEnd(), fragment.trim()]) {
          if (candidate.includes("\n") && candidate.replace(/\s/g, "").length >= 4) candidates.add(candidate);
        }
      }
    }
    return [...candidates].sort((left, right) => right.length - left.length);
  };
  const candidates = replacements.map((replacement) => ({ ...replacement, candidates: candidatesFor(replacement.rendered) }));
  const owners = new Map<string, number>();
  for (const replacement of candidates) {
    for (const candidate of replacement.candidates) owners.set(candidate, (owners.get(candidate) ?? 0) + 1);
  }
  return candidates
    .sort((left, right) => right.rendered.length - left.rendered.length)
    .reduce((value, replacement) => {
      const candidate = replacement.candidates.find((item) => {
        if (owners.get(item) !== 1) return false;
        const first = value.indexOf(item);
        return first >= 0 && first === value.lastIndexOf(item);
      });
      if (candidate === undefined) return value;
      const first = value.indexOf(candidate);
      return `${value.slice(0, first)}${terminalText(replacement.source)}${value.slice(first + candidate.length)}`;
    }, terminalText(renderedText));
};

const renderInlineMarkdownProtected = (protectedText: string, math: readonly string[]): string => {
  const links: string[] = [];
  const protectedLinks = protectedText.replace(/\[([^\]\n]+)\]\(([^\s)]+)\)/g, (_match, label: string, target: string) => {
    links.push(terminalLink(label, target));
    return `\u0000${links.length - 1}\u0000`;
  });
  const bareLinks = protectedLinks.replace(/https?:\/\/[^\s<>()]+/g, (target: string) => terminalLink(target, target));
  return bareLinks.replace(/\u0000(\d+)\u0000/g, (_match, index: string) => links[Number(index)] ?? "")
    .replace(/`([^`\n]+)`/g, `${ansi.dim}$1${ansi.reset}`)
    .replace(/\*\*([^*\n]+)\*\*/g, `${ansi.bold}$1${ansi.reset}`)
    .replace(/__([^_\n]+)__/g, `${ansi.bold}$1${ansi.reset}`)
    .replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, `${ansi.dim}$1${ansi.reset}`)
    .replace(/(?<!_)_([^_\n]+)_(?!_)/g, `${ansi.dim}$1${ansi.reset}`)
    .replace(/\u0001latex(\d+)\u0001/g, (_match, index: string) => math[Number(index)] ?? "");
};

const renderInlineMarkdown = (text: string): string => {
  const math: string[] = [];
  return renderInlineMarkdownProtected(protectLatexSegments(neutralizeControls(text), math), math);
};

/** Render a deliberately small Markdown subset without allowing model terminal controls. */
export const renderMarkdown = (text: string): string => {
  const output: string[] = [];
  let fenced = false;
  let normalLines: string[] = [];
  const flushNormal = (): void => {
    if (normalLines.length === 0) return;
    const math: string[] = [];
    const protectedLines = protectLatexSegments(normalLines.join("\n"), math).split("\n");
    for (const line of protectedLines) {
      const heading = /^(#{1,6})\s+(.+)$/.exec(line);
      const headingText = heading?.[2];
      if (headingText !== undefined) {
        output.push(`${ansi.cyan}${ansi.bold}${renderInlineMarkdownProtected(headingText, math)}${ansi.reset}`);
        continue;
      }
      const list = /^(\s*)([-*+] |\d+\. )(.*)$/.exec(line);
      const indentation = list?.[1];
      const item = list?.[3];
      output.push(indentation === undefined || item === undefined ? renderInlineMarkdownProtected(line, math) : `${indentation}• ${renderInlineMarkdownProtected(item, math)}`);
    }
    normalLines = [];
  };
  for (const line of neutralizeControls(text).split("\n")) {
    if (/^\s*```/.test(line)) {
      flushNormal();
      fenced = !fenced;
      output.push(fenced ? ansi.dim : ansi.reset);
      continue;
    }
    if (fenced) {
      output.push(line);
      continue;
    }
    normalLines.push(line);
  }
  flushNormal();
  if (fenced) output.push(ansi.reset);
  return output.join("\n");
};

interface TuiSettings {
  provider: string;
  model: string;
  agent: "primary" | "build";
  thinking: boolean;
  thinkingEffort: "low" | "medium" | "high";
  details: boolean;
  journal: string;
  contextWindow: number;
  cache?: string;
  authFile?: string;
}

const option = (args: readonly string[], name: string): string | undefined => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};

const changedEvents = (events: readonly DurableEvent[], before: number, sessionId: string): readonly DurableEvent[] => events.slice(before).filter((event) => event.sessionId === sessionId);

export interface HarnessFlow {
  id: string;
  event: DurableEvent;
  label: string;
}

export interface HarnessGroup {
  id: string;
  header: HarnessFlow;
  children: HarnessFlow[];
  promotedFetch?: HarnessFlow;
  promotedFetchResult?: HarnessFlow;
  promotedBash?: HarnessFlow;
}

export type HarnessDisplayItem = HarnessFlow & { groupId?: string; group?: HarnessGroup; groupHeader?: boolean };

export interface TuiInteractionState {
  expanded: ReadonlySet<string>;
  scrollOffset: number;
  selection?: TextSelection;
}

export interface SelectionPoint {
  column: number;
  row: number;
}

export interface TextSelection {
  anchor: SelectionPoint;
  focus: SelectionPoint;
}

export interface SelectableSpan {
  /** Zero-based, half-open terminal-cell columns. */
  startColumn: number;
  endColumn: number;
}

export type SelectableRow = boolean | SelectableSpan;

export const normalizeSelection = (selection: TextSelection): TextSelection => {
  const before = selection.anchor.row < selection.focus.row || (selection.anchor.row === selection.focus.row && selection.anchor.column <= selection.focus.column);
  return before ? selection : { anchor: selection.focus, focus: selection.anchor };
};

const clearSelection = (state: TuiInteractionState): TuiInteractionState => ({ expanded: state.expanded, scrollOffset: state.scrollOffset });

export const cancelSelectionOnClick = (state: TuiInteractionState): TuiInteractionState => clearSelection(state);

const visibleCharacters = (text: string): readonly string[] => text.split(ansiSequence).flatMap((part) => graphemes(part).filter((grapheme) => cellWidthWithoutControls(grapheme) > 0));

const cellsToText = (text: string, start: number, end: number): string => {
  let column = 0;
  let result = "";
  for (const character of visibleCharacters(text)) {
    const width = terminalCellWidth(character);
    if (width === 0) continue;
    const nextColumn = column + width;
    if (nextColumn > start && column < end) result += character;
    column = nextColumn;
    if (column >= end) break;
  }
  return result;
};

const cleanCopiedLine = (text: string, panel: boolean): string => {
  const withoutRail = panel ? text.replace(/^│ ?/, "").replace(/^ /, "").replace(/ ?│$/, "") : text;
  return withoutRail.replace(/[ \t]+$/, "");
};

const selectableSpan = (row: SelectableRow | undefined, line: string, implicit = false): SelectableSpan | undefined => {
  if (row === false || (row === undefined && !implicit)) return undefined;
  const width = terminalCellWidth(line);
  if (row === true || row === undefined) return { startColumn: 0, endColumn: width };
  const startColumn = Math.min(width, Math.max(0, row.startColumn));
  return { startColumn, endColumn: Math.min(width, Math.max(startColumn, row.endColumn)) };
};

/** Extract a terminal-cell selection from rows whose first screen row is `firstRow`. */
export const extractSelection = (lines: readonly string[], selection: TextSelection, firstRow = 1, selectableRows: readonly SelectableRow[] = []): string => {
  const normalized = normalizeSelection(selection);
  const selected: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const row = firstRow + index;
    if (row < normalized.anchor.row || row > normalized.focus.row) continue;
    const source = lines[index] ?? "";
    const span = selectableSpan(selectableRows[index], source, selectableRows.length <= index);
    if (span === undefined) continue;
    const requestedStart = row === normalized.anchor.row ? Math.max(1, normalized.anchor.column) - 1 : 0;
    const requestedEnd = row === normalized.focus.row ? Math.max(requestedStart + 1, normalized.focus.column) : terminalCellWidth(source);
    const start = Math.max(requestedStart, span.startColumn);
    const end = Math.min(requestedEnd, span.endColumn);
    if (start >= end) continue;
    const hasExplicitSpan = typeof selectableRows[index] === "object";
    selected.push(cleanCopiedLine(cellsToText(source, start, end), !hasExplicitSpan && visibleCharacters(source)[0] === "│"));
  }
  return selected.join("\n");
};

const selectionIntersectsRow = (selection: TextSelection, row: number): boolean => {
  const normalized = normalizeSelection(selection);
  return row >= normalized.anchor.row && row <= normalized.focus.row;
};

const renderSelectedLine = (line: string, selection: TextSelection, row: number, selectable: SelectableRow = true): string => {
  const span = selectableSpan(selectable, line);
  if (span === undefined) return line;
  if (!selectionIntersectsRow(selection, row)) return line;
  const normalized = normalizeSelection(selection);
  const requestedStart = row === normalized.anchor.row ? Math.max(1, normalized.anchor.column) - 1 : 0;
  const requestedEnd = row === normalized.focus.row ? Math.max(requestedStart + 1, normalized.focus.column) : terminalCellWidth(line);
  const start = Math.max(requestedStart, span.startColumn);
  const end = Math.min(requestedEnd, span.endColumn);
  if (start >= end) return line;
  const selectedStyle = ansi.reverse;
  const output: string[] = [];
  let column = 0;
  let selected = false;
  const appendVisible = (text: string): void => {
    for (const character of graphemes(text)) {
      const width = terminalCellWidth(character);
      if (width === 0) {
        output.push(character);
        continue;
      }
      const shouldSelect = column < end && column + width > start;
      if (shouldSelect && !selected) {
        output.push(selectedStyle);
        selected = true;
      } else if (!shouldSelect && selected) {
        output.push(ansi.reverseOff);
        selected = false;
      }
      output.push(character);
      column += width;
    }
  };
  let cursor = 0;
  ansiSequence.lastIndex = 0;
  for (const match of line.matchAll(ansiSequence)) {
    appendVisible(line.slice(cursor, match.index));
    const sequence = match[0];
    output.push(sequence);
    if (/\x1b\[([0-9;]*)m/.test(sequence) && selected && /\x1b\[(?:0|[0-9;]*27)[0-9;]*m/.test(sequence)) output.push(selectedStyle);
    cursor = (match.index ?? cursor) + sequence.length;
  }
  appendVisible(line.slice(cursor));
  ansiSequence.lastIndex = 0;
  if (selected) output.push(ansi.reverseOff);
  return output.join("");
};

export interface HarnessHitBox {
  flowId: string;
  top: number;
  bottom: number;
}

export interface PromptBoard {
  promptId: string;
  prompt: string;
  events: readonly DurableEvent[];
  assistant: string;
}

export function shouldRenderSubmittedPrompt(
  promptId: string | undefined,
  boards: readonly PromptBoard[],
): boolean {
  return promptId !== undefined && !boards.some((board) => board.promptId === promptId);
}

export type PromptBoardStatus = "running" | "completed" | "failed";

export const promptBoardStatus = (board: PromptBoard): PromptBoardStatus => {
  const conclusion = [...board.events].reverse().find((event) => event.kind === "TaskConclusion");
  return conclusion?.kind === "TaskConclusion" ? conclusion.data.outcome === "finished" ? "completed" : "failed" : "running";
};

export const hasDurablePendingPrompt = (boards: readonly PromptBoard[]): boolean => boards.some((board) => promptBoardStatus(board) === "running");

export const sessionHasPendingExecution = (boards: readonly PromptBoard[], localSubmissionPending: boolean): boolean =>
  localSubmissionPending || hasDurablePendingPrompt(boards);

export const promptDelivery = (boards: readonly PromptBoard[], localSubmissionPending: boolean): "queue" | "steer" =>
  sessionHasPendingExecution(boards, localSubmissionPending) ? "steer" : "queue";

const assistantPlaceholder = (status: PromptBoardStatus, continuing: boolean): string => {
  if (status === "completed") return "(completed without text)";
  if (status === "failed") return "(agent failed before producing text)";
  return continuing ? "(continuing after tool calls...)" : "(waiting for agent response...)";
};

export const promptBoards = (events: readonly DurableEvent[], sessionId: string): readonly PromptBoard[] => {
  const boards: PromptBoard[] = [];
  const byAdmission = new Map<string, PromptBoard>();
  const byRun = new Map<string, PromptBoard>();
  const byProviderCall = new Map<string, PromptBoard>();
  const byToolCall = new Map<string, PromptBoard>();
  const byEffect = new Map<string, PromptBoard>();
  let active: PromptBoard | undefined;
  const callbackRunId = (callbackId: string): string => `callback-${digest(`${sessionId}:${callbackId}`).slice(0, 16)}`;
  const providerRoot = (providerCallId: string): string => providerCallId.split(":turn-", 1)[0] ?? "";
  const addEvent = (board: PromptBoard, event: DurableEvent): void => {
    const index = boards.indexOf(board);
    if (index < 0) return;
    const next = { ...board, events: [...board.events, event], assistant: event.kind === "ProviderText" ? event.data.text : board.assistant };
    boards[index] = next;
    byAdmission.forEach((candidate, key) => { if (candidate === board) byAdmission.set(key, next); });
    byRun.forEach((candidate, key) => { if (candidate === board) byRun.set(key, next); });
    byProviderCall.forEach((candidate, key) => { if (candidate === board) byProviderCall.set(key, next); });
    byToolCall.forEach((candidate, key) => { if (candidate === board) byToolCall.set(key, next); });
    byEffect.forEach((candidate, key) => { if (candidate === board) byEffect.set(key, next); });
    active = active === board ? next : active;
  };
  const boardForRunId = (runId: string): PromptBoard | undefined => byRun.get(runId) ?? boards.find((board) => board.events.some((event) => event.kind === "GraphRunStarted" && event.data.runId === runId));
  for (const event of events) {
    if (event.sessionId !== sessionId) continue;
    if (event.kind === "PromptAdmitted") {
      const board: PromptBoard = { promptId: event.data.promptId, prompt: event.data.prompt, events: [], assistant: "" };
      boards.push(board);
      byAdmission.set(event.id, board);
      active = board;
      continue;
    }
    let board: PromptBoard | undefined;
    if (event.kind === "GraphRunStarted") {
      board = byAdmission.get(event.data.inputEventId);
      if (board !== undefined) byRun.set(event.data.runId, board);
      active = board ?? active;
    } else if (event.kind === "GraphPlanPublished") {
      board = active;
    } else if (event.kind === "HarnessThinking" || event.kind === "TaskConclusion") {
      board = byRun.get(event.data.runId) ?? active;
    } else if (event.kind === "GraphTransition") {
      board = boardForRunId(event.data.runId);
    } else if (event.kind === "BackgroundAgentCallback") {
      board = byToolCall.get(event.data.parentToolCallId);
      if (board !== undefined) byRun.set(callbackRunId(event.data.callbackId), board);
    } else if (event.kind === "BackgroundAgentBatchCallback") {
      const memberBoards = event.data.members.map((member) => byToolCall.get(member.parentToolCallId));
      const first = memberBoards[0];
      if (first !== undefined && memberBoards.every((member) => member === first)) byRun.set(callbackRunId(event.data.callbackId), first);
    } else if (event.kind === "ProviderTurnStarted") {
      const runId = providerRoot(event.data.providerCallId);
      board = boardForRunId(runId) ?? (runId.startsWith("callback-") ? undefined : active);
      if (board !== undefined) byProviderCall.set(event.data.providerCallId, board);
      const effectRunId = event.data.effectId.split(":provider:", 1)[0] ?? "";
      if (board !== undefined) byEffect.set(event.data.effectId, board);
      if (effectRunId.length > 0 && board !== undefined) byRun.set(effectRunId, board);
    } else if (event.kind === "ProviderText" || event.kind === "ProviderTurnFinished" || event.kind === "ProviderTurnFailed") {
      const runId = providerRoot(event.data.providerCallId);
      board = byProviderCall.get(event.data.providerCallId) ?? boardForRunId(runId) ?? (runId.startsWith("callback-") ? undefined : active);
    } else if (event.kind === "ToolCalled") {
      board = active;
      if (board !== undefined) byToolCall.set(event.data.callId, board);
    } else if (event.kind === "ToolSucceeded" || event.kind === "ToolFailed") {
      board = byToolCall.get(event.data.callId) ?? active;
    } else if (event.kind === "EffectClaimed") {
      board = byEffect.get(event.data.effectId) ?? boardForRunId(event.data.effectId.split(/:(?:provider|tool):/, 1)[0] ?? "") ?? active;
      if (board !== undefined) byEffect.set(event.data.effectId, board);
    } else if (event.kind === "EffectRecorded") {
      board = byEffect.get(event.data.effectId) ?? active;
    } else if (event.kind === "InputPromoted") {
      board = boards.find((candidate) => candidate.promptId === event.data.promptId);
      active = board ?? active;
    }
    if (board !== undefined) {
      if (event.kind === "ProviderText") {
        const index = boards.indexOf(board);
        const current = index < 0 ? undefined : boards[index];
        if (current !== undefined) {
          const next: PromptBoard = { ...current, assistant: current.assistant + event.data.text };
          boards[index] = next;
          byAdmission.forEach((candidate, key) => { if (candidate === board) byAdmission.set(key, next); });
          byRun.forEach((candidate, key) => { if (candidate === board) byRun.set(key, next); });
          byProviderCall.forEach((candidate, key) => { if (candidate === board) byProviderCall.set(key, next); });
          byToolCall.forEach((candidate, key) => { if (candidate === board) byToolCall.set(key, next); });
          byEffect.forEach((candidate, key) => { if (candidate === board) byEffect.set(key, next); });
          active = active === board ? next : active;
        }
      } else if (eventLabel(event) !== undefined) addEvent(board, event);
    }
  }
  return boards;
};

export const shouldFollowHarnessThinking = (previousEvents: readonly DurableEvent[], currentEvents: readonly DurableEvent[], atBottom: boolean): boolean => {
  if (!atBottom) return false;
  const previousIds = new Set(previousEvents.map((event) => event.id));
  return currentEvents.some((event) => event.kind === "HarnessThinking" && !previousIds.has(event.id) && eventLabel(event) !== undefined);
};

export const createTuiInteractionState = (): TuiInteractionState => ({ expanded: new Set<string>(), scrollOffset: 0 });

export const harnessFlows = (events: readonly DurableEvent[]): readonly HarnessFlow[] => events.flatMap((event) => {
  const label = eventLabel(event);
  return label === undefined ? [] : [{ id: event.id, event, label }];
});

const intentFlow = (flow: HarnessFlow): boolean => flow.event.kind === "HarnessThinking";
const intentGroupId = (flow: HarnessFlow): string => `intent:${flow.id}`;

const promoteFetchIntentGroup = (group: HarnessGroup): HarnessGroup => {
  if (group.header.event.kind !== "HarnessThinking" || !/^Fetch an HTTPS page(?:$| with Obscura\b)/.test(group.header.event.data.step)) return group;
  const fetchCalls = group.children.filter((child): child is HarnessFlow & { event: Extract<DurableEvent, { kind: "ToolCalled" }> } => child.event.kind === "ToolCalled" && child.event.data.name === "fetch_page");
  if (fetchCalls.length !== 1) return group;
  const fetchCall = fetchCalls[0];
  if (fetchCall === undefined || fetchPageUrl(fetchCall.event) === undefined) return group;
  const matchingResults = group.children.filter((child) => child.event.kind === "ToolSucceeded" && child.event.data.callId === fetchCall.event.data.callId);
  const candidate = matchingResults.length === 1 && group.children.indexOf(fetchCall) < group.children.indexOf(matchingResults[0]!) ? matchingResults[0] : undefined;
  const result = candidate !== undefined && fetchPageResult(fetchCall.event, [fetchCall.event, candidate.event]) !== undefined ? candidate : undefined;
  return {
    ...group,
    promotedFetch: fetchCall,
    ...(result === undefined ? {} : { promotedFetchResult: result }),
    children: group.children.filter((child) => child !== fetchCall && !matchingResults.includes(child)),
  };
};

const promoteBashIntentGroup = (group: HarnessGroup): HarnessGroup => {
  if (group.header.event.kind !== "HarnessThinking" || !/^Run an arbitrary host bash script(?:$| after mandatory\b)/.test(group.header.event.data.step)) return group;
  const calls = group.children.filter((child) => child.event.kind === "ToolCalled" && child.event.data.name === "bash");
  if (calls.length !== 1 || bashCommand(calls[0]!.event) === undefined) return group;
  const call = calls[0]!;
  return { ...group, promotedBash: call, children: group.children.filter((child) => child !== call) };
};

/** UI-only grouping; the returned children retain their durable event IDs. */
export const harnessGroups = (events: readonly DurableEvent[]): readonly (HarnessFlow | HarnessGroup)[] => {
  const result: (HarnessFlow | HarnessGroup)[] = [];
  for (const flow of harnessFlows(events)) {
    if (intentFlow(flow)) result.push({ id: intentGroupId(flow), header: flow, children: [] });
    else {
      const group = result.at(-1);
      if (group !== undefined && "header" in group) group.children = [...group.children, flow];
      else result.push(flow);
    }
  }
  return result.map((item) => "header" in item ? promoteBashIntentGroup(promoteFetchIntentGroup(item)) : item);
};

export const visibleHarnessItems = (events: readonly DurableEvent[], expanded: ReadonlySet<string>): readonly HarnessDisplayItem[] => harnessGroups(events).flatMap((item) => {
  if ("header" in item) {
    const promotedLabel = item.promotedFetch === undefined ? bashIntentLabel(item.promotedBash?.event) : fetchIntentLabel(item.promotedFetch.event);
    const header = promotedLabel === undefined ? item.header : { ...item.header, label: promotedLabel };
    return [{ ...header, id: item.id, group: item, groupHeader: true }, ...(expanded.has(item.id) ? item.children.map((child) => ({ ...child, groupId: item.id, group: item })) : [])];
  }
  return [item];
});

const allHarnessInteractiveItems = (boards: readonly PromptBoard[], expanded: ReadonlySet<string>): readonly HarnessDisplayItem[] => boards.flatMap((board) => visibleHarnessItems(board.events, expanded));

const allHarnessIds = (boards: readonly PromptBoard[]): readonly string[] => boards.flatMap((board) => harnessGroups(board.events).flatMap((item) => "header" in item ? [item.id, ...item.children.map((child) => child.id)] : [item.id]));

export const hitTestHarnessRow = (row: number, hitBoxes: readonly HarnessHitBox[]): string | undefined => hitBoxes.find((box) => row >= box.top && row <= box.bottom)?.flowId;

export const parseMouseRow = (input: string): number | undefined => {
  const match = /\x1b\[<(?:0);\d+;(\d+)M/.exec(input);
  const row = match?.[1] === undefined ? undefined : Number(match[1]);
  return row === undefined || !Number.isSafeInteger(row) ? undefined : row;
};

export interface MouseClick {
  column: number;
  row: number;
}

export type MouseEventAction = "press" | "motion" | "release";

export interface MouseEvent {
  action: MouseEventAction;
  button: number;
  column: number;
  row: number;
}

export type ChartHoverMotionRoute = "eligible" | "blocked" | "ignored";

export interface ChartHoverMotionContext {
  readonly permissionActive: boolean;
  readonly overlayActive: boolean;
  readonly selectionDragging: boolean;
}

export const routeChartHoverMotion = (mouse: Pick<MouseEvent, "action" | "button">, context: ChartHoverMotionContext): ChartHoverMotionRoute => {
  if (mouse.action !== "motion") return "ignored";
  if (context.permissionActive || context.overlayActive || context.selectionDragging) return "blocked";
  return "eligible";
};

/** Parse all complete SGR mouse packets in a chunk, including left drag events. */
export const parseMouseEvents = (input: string): readonly MouseEvent[] => {
  const events: MouseEvent[] = [];
  const packet = /\x1b\[<(\d+);(\d+);(\d+)([mM])/g;
  let match: RegExpExecArray | null;
  while ((match = packet.exec(input)) !== null) {
    const code = Number(match[1]);
    const column = Number(match[2]);
    const row = Number(match[3]);
    if (!Number.isSafeInteger(code) || !Number.isSafeInteger(column) || !Number.isSafeInteger(row)) continue;
    const button = code >= 64 ? code : code & 3;
    const action: MouseEventAction = match[4] === "m" ? "release" : (code & 32) !== 0 ? "motion" : "press";
    events.push({ action, button, column, row });
  }
  return events;
};

export const parseMouseClick = (input: string): MouseClick | undefined => {
  const match = /\x1b\[<0;(\d+);(\d+)M/.exec(input);
  const column = match?.[1] === undefined ? undefined : Number(match[1]);
  const row = match?.[2] === undefined ? undefined : Number(match[2]);
  return column === undefined || row === undefined || !Number.isSafeInteger(column) || !Number.isSafeInteger(row) ? undefined : { column, row };
};

export type MouseWheelDirection = "up" | "down";

export const parseMouseWheel = (input: string): MouseWheelDirection | undefined => {
  const match = /\x1b\[<(64|65);\d+;\d+M/.exec(input);
  if (match?.[1] === "64") return "up";
  if (match?.[1] === "65") return "down";
  return undefined;
};

const mouseSequence = /\x1b\[<\d+;\d+;\d+[mM]/g;

export const stripMouseSequences = (input: string): string => input.replace(mouseSequence, "");

export const splitMouseInput = (input: string): { safe: string; pending: string } => {
  let safe = "";
  let cursor = 0;
  while (cursor < input.length) {
    const escapeIndex = input.indexOf("\x1b[<", cursor);
    if (escapeIndex < 0) {
      const remainder = input.slice(cursor);
      const partial = /(?:\x1b|\x1b\[|\x1b\[<)$/.exec(remainder)?.[0];
      if (partial !== undefined) return { safe: safe + remainder.slice(0, -partial.length), pending: partial };
      return { safe: safe + remainder, pending: "" };
    }
    safe += input.slice(cursor, escapeIndex);
    const suffix = input.slice(escapeIndex);
    const complete = /^\x1b\[<\d+;\d+;\d+[mM]/.exec(suffix);
    if (complete !== null) {
      safe += complete[0];
      cursor = escapeIndex + complete[0].length;
      continue;
    }
    if (/^\x1b\[<\d*(?:;\d*){0,2}$/.test(suffix)) return { safe, pending: suffix };
    const nextEscape = input.indexOf("\x1b[<", escapeIndex + 3);
    if (nextEscape < 0) return { safe, pending: "" };
    cursor = nextEscape;
  }
  return { safe, pending: "" };
};

export const prepareMouseInput = (pending: string, chunk: string): { mouseInput: string; readlineInput: string; pending: string } => {
  const split = splitMouseInput(pending + chunk);
  return { mouseInput: split.safe, readlineInput: stripMouseSequences(split.safe), pending: split.pending };
};

export const scrollHarness = (state: TuiInteractionState, direction: MouseWheelDirection | "top" | "bottom", flowCount: number): TuiInteractionState => {
  const maxOffset = Math.max(0, flowCount - 1);
  const offset = direction === "top" ? 0 : direction === "bottom" ? maxOffset : Math.min(maxOffset, Math.max(0, state.scrollOffset + (direction === "up" ? -1 : 1)));
  return { ...state, scrollOffset: offset };
};

export const toggleHarnessFlow = (state: TuiInteractionState, flowId: string, flows: readonly Pick<HarnessFlow, "id">[]): TuiInteractionState => {
  const expanded = new Set(state.expanded);
  if (expanded.has(flowId)) expanded.delete(flowId); else expanded.add(flowId);
  const selected = flows.findIndex((flow) => flow.id === flowId);
  return selected < 0 ? state : { expanded, scrollOffset: state.scrollOffset };
};

const safeEventData = (event: DurableEvent): string => {
  const data = redactJson(event.data as unknown as Json);
  return terminalText(JSON.stringify(data, null, 2));
};

const fetchSensitiveQueryKey = (key: string): boolean => /(?:^|[_-])(?:token|key|secret|password|passwd|auth|credential|session|signature|sig)(?:$|[_-])/i.test(key.replace(/([a-z])([A-Z])/g, "$1-$2"));

const fetchPageUrl = (event: DurableEvent): URL | undefined => {
  if (event.kind !== "ToolCalled" || event.data.name !== "fetch_page" || event.data.arguments === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(event.data.arguments);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed) || !("url" in parsed) || typeof parsed.url !== "string") return undefined;
    const url = new URL(parsed.url);
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username.length > 0 || url.password.length > 0 || url.hostname.length === 0) return undefined;
    for (const [key] of url.searchParams) if (fetchSensitiveQueryKey(key)) return undefined;
    return url;
  } catch {
    return undefined;
  }
};

const fetchPageLabel = (event: DurableEvent): string | undefined => {
  const url = fetchPageUrl(event);
  if (url === undefined) return undefined;
  return `  ${ansi.amber}Fetch${ansi.reset} ${url.protocol.slice(0, -1).toUpperCase()} ${singleLineText(`${url.origin}${url.pathname}`)}`;
};

const fetchIntentLabel = (event: DurableEvent): string | undefined => {
  const label = fetchPageLabel(event);
  return label === undefined ? undefined : `  ${ansi.amber}INTENT${ansi.reset} ${label.trimStart()}`;
};

const bashCommand = (event: DurableEvent | undefined): string | undefined => {
  if (event?.kind !== "ToolCalled" || event.data.name !== "bash" || event.data.arguments === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(event.data.arguments);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed) || Object.keys(parsed).length !== 1 || !("command" in parsed) || typeof parsed.command !== "string") return undefined;
    const validated = validateBashCommand(parsed.command);
    return validated.ok ? singleLineText(redactOutputText(neutralizeControls(validated.value.command))) : undefined;
  } catch {
    return undefined;
  }
};

const bashIntentLabel = (event: DurableEvent | undefined): string | undefined => {
  const command = bashCommand(event);
  return command === undefined ? undefined : `  ${ansi.amber}INTENT${ansi.reset} ${truncateCells(command, 160)}`;
};

const fetchPageResult = (event: DurableEvent, events: readonly DurableEvent[]): { status: string | undefined; content: string | undefined } | undefined => {
  if (event.kind !== "ToolCalled") return undefined;
  const matches = events.filter((candidate): candidate is Extract<DurableEvent, { kind: "ToolSucceeded" }> => candidate.kind === "ToolSucceeded" && candidate.data.callId === event.data.callId);
  if (matches.length !== 1) return undefined;
  const success = matches[0];
  if (success === undefined || success.data.result === undefined || success.data.resultTruncated === true) return undefined;
  try {
    const parsed: unknown = JSON.parse(success.data.result);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
    const content = "content" in parsed && typeof parsed.content === "string" ? truncateCells(singleLineText(redactOutputText(neutralizeControls(parsed.content))), 256) : undefined;
    const status = "status" in parsed && (typeof parsed.status === "number" || typeof parsed.status === "string") ? singleLineText(redactOutputText(String(parsed.status))) : undefined;
    return content === undefined && status === undefined ? undefined : { content, status };
  } catch {
    return undefined;
  }
};

const fetchPageDetails = (event: DurableEvent, events: readonly DurableEvent[]): string | undefined => {
  const url = fetchPageUrl(event);
  if (url === undefined || event.kind !== "ToolCalled") return undefined;
  const query = truncateCells([...url.searchParams].map(([key, value]) => `${singleLineText(redactOutputText(neutralizeControls(key)))}=${singleLineText(redactOutputText(neutralizeControls(value)))}`).join("&") || "(none)", 256);
  const result = fetchPageResult(event, events);
  if (result === undefined) return `QUERY ${query}\nRESULT unavailable`;
  return `QUERY ${query}\nRESULT ${result.status === undefined ? "" : `${result.status} `}${result.content === undefined ? "(none)" : result.content}`.trimEnd();
};

const eventDetails = (event: DurableEvent, events: readonly DurableEvent[]): string => event.kind === "ToolCalled" && event.data.name === "fetch_page"
  ? (fetchPageDetails(event, events) ?? "QUERY unavailable\nRESULT unavailable")
  : event.kind === "ToolCalled" && event.data.name === "bash"
    ? `COMMAND ${bashCommand(event) ?? "unavailable"}`
    : safeEventData(event);

const detailsEvent = (flow: HarnessDisplayItem): DurableEvent | undefined => flow.groupHeader === true ? (flow.group?.promotedFetch?.event ?? flow.group?.promotedBash?.event) : flow.event;
const detailsEvents = (flow: HarnessDisplayItem, events: readonly DurableEvent[]): readonly DurableEvent[] => {
  const call = flow.groupHeader === true ? flow.group?.promotedFetch?.event : undefined;
  const result = flow.groupHeader === true ? flow.group?.promotedFetchResult?.event : undefined;
  const bash = flow.groupHeader === true ? flow.group?.promotedBash?.event : undefined;
  return call === undefined ? (bash === undefined ? events : [bash]) : result === undefined ? [call] : [call, result];
};

const chartDescriptorForToolEvent = (event: DurableEvent): ChartDescriptor | undefined => {
  if (event.kind !== "ToolSucceeded" || event.data.result === undefined || event.data.resultTruncated === true) return undefined;
  try {
    const parsed: unknown = JSON.parse(event.data.result);
    return isChartDescriptor(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
};

const chartForToolEvent = (event: DurableEvent, width: number): string | undefined => {
  const chart = chartDescriptorForToolEvent(event);
  return chart === undefined ? undefined : renderChartSurface(chart, Math.max(13, Math.min(72, width - 10)), 10);
};

const chartPlaceholder = /^!?[A-Za-z0-9$._-]+\s+chart$/i;

export const renderHarnessPanel = (events: readonly DurableEvent[], state: TuiInteractionState, width = terminalWidth()): { text: string; hitBoxes: readonly HarnessHitBox[] } => {
  width = terminalWidth(width);
  const flows = visibleHarnessItems(events, state.expanded);
  const contentWidth = Math.max(1, width - 4);
 const viewportRows = processStdout.rows === undefined ? flows.length : Math.max(3, processStdout.rows - 12);
  const visibleFlows = flows.slice(Math.min(state.scrollOffset, Math.max(0, flows.length - 1)), Math.min(flows.length, Math.min(state.scrollOffset, Math.max(0, flows.length - 1)) + viewportRows));
  const lines = [panelTop("HARNESS // EVENT STREAM", width, ansi.cyan)];
  const hitBoxes: HarnessHitBox[] = [];
  let row = state.scrollOffset > 0 ? 3 : 2;
  for (const flow of visibleFlows) {
    const marker = flow.groupHeader === true ? (state.expanded.has(flow.id) ? "▾" : "▸") : state.expanded.has(flow.id) ? "▾" : "▸";
    const flowLines = wrapText(`${marker} ${flow.label.trim()}`, contentWidth);
    lines.push(...flowLines.map((line) => panelLine(line, width)));
    hitBoxes.push({ flowId: flow.id, top: row, bottom: row + flowLines.length - 1 });
    row += flowLines.length;
     const chart = chartForToolEvent(flow.event, contentWidth);
    if (chart !== undefined) {
      const chartLines = chart.split("\n").flatMap((line) => wrapText(line, contentWidth));
      lines.push(...chartLines.map((line) => panelLine(` ${line}`, width)));
      row += chartLines.length;
    }
    const detailEvent = detailsEvent(flow);
    if (detailEvent !== undefined && state.expanded.has(flow.id)) {
      const details = wrapText(eventDetails(detailEvent, detailsEvents(flow, events)), Math.max(1, contentWidth - 2));
      lines.push(...details.map((line) => panelLine(` ${line}`, width)));
      row += details.length;
    }
  }
  if (state.scrollOffset > 0) lines.splice(1, 0, panelLine("↑ older events (wheel or /scroll top)", width));
  if (state.scrollOffset < Math.max(0, flows.length - visibleFlows.length)) lines.push(panelLine("↓ newer events (wheel or /scroll bottom)", width));
  lines.push(panelBottom(width, ansi.cyan));
  return { text: lines.join("\n"), hitBoxes };
};

export const renderAssistantCanvas = (body: string, width = terminalWidth(), status: PromptBoardStatus = "completed", continuing = false): string => {
  width = terminalWidth(width);
  const content = wrapText(renderMarkdown(body || assistantPlaceholder(status, continuing)), Math.max(1, width - 4));
  return [panelTop("AGENT // ASSISTANT", width, ansi.cyan), ...content.map((line) => panelLine(line, width, ansi.cyan)), panelBottom(width, ansi.cyan)].join("\n");
};

interface RenderedLine {
  text: string;
  links: readonly TerminalLinkRange[];
}

const renderPanelLines = (contents: readonly string[], width: number, border: string, startRow: number, background: string = ansi.background): { lines: RenderedLine[]; linkBoxes: TerminalLinkHitBox[] } => {
  const lines: RenderedLine[] = [];
  const linkBoxes: TerminalLinkHitBox[] = [];
  let row = startRow;
  for (const content of contents) {
    const wrapped = wrapAnsiLine(content, Math.max(1, width - 4));
    for (const line of wrapped) {
      const links = extractTerminalLinks(line);
      lines.push({ text: panelLine(line, width, border, background), links });
      for (const link of links) linkBoxes.push({ url: link.url, row, left: link.startColumn + 3, right: Math.max(link.startColumn + 3, link.endColumn + 2) });
      row += 1;
    }
  }
  return { lines, linkBoxes };
};

const renderAssistantParts = (body: string, events: readonly DurableEvent[], width: number, status: PromptBoardStatus, continuing: boolean): { lines: RenderedLine[]; linkBoxes: TerminalLinkHitBox[] } => {
  const charts = events.flatMap((event) => {
    const chart = chartForToolEvent(event, width);
    return chart === undefined ? [] : chart.split("\n");
  });
  const visibleBody = charts.length > 0 && chartPlaceholder.test(body.trim()) ? "" : body;
  const content = visibleBody.length > 0 ? renderMarkdown(visibleBody) : charts.length > 0 ? "" : renderMarkdown(assistantPlaceholder(status, continuing));
  const contentLines = content.length === 0 ? [] : content.split("\n");
  const panel = renderPanelLines([...contentLines, ...charts], width, ansi.cyan, 2);
  return {
    lines: [{ text: panelTop("AGENT // ASSISTANT", width, ansi.cyan), links: [] }, ...panel.lines, { text: panelBottom(width, ansi.cyan), links: [] }],
    linkBoxes: panel.linkBoxes,
  };
};

export const renderPromptBoard = (board: PromptBoard, state: TuiInteractionState, width = terminalWidth(), index = 0): { text: string; hitBoxes: readonly HarnessHitBox[]; linkBoxes: readonly TerminalLinkHitBox[]; selectableRows: readonly SelectableRow[]; lineOwners: readonly (string | undefined)[] } => {
  width = terminalWidth(width);
  const flows = visibleHarnessItems(board.events, state.expanded);
  const promptLines = renderConsolePrompt(board.prompt, width);
  const lines: RenderedLine[] = [
    ...promptLines.map((line) => ({ text: line, links: [] })),
    ...(promptLines.length === 0 ? [] : [{ text: "", links: [] }]),
    { text: panelTop(`HARNESS // TURN ${index + 1}`, width, ansi.cyan), links: [] },
  ];
  const selectableRows: SelectableRow[] = [
    ...promptLines.map(() => true),
    ...(promptLines.length === 0 ? [] : [false]),
    false,
  ];
  const hitBoxes: HarnessHitBox[] = [];
  const linkBoxes: TerminalLinkHitBox[] = [];
  let row = lines.length + 1;
  for (const flow of flows) {
    const flowLines = renderPanelLines([`${flow.groupHeader === true ? (state.expanded.has(flow.id) ? "▾" : "▸") : state.expanded.has(flow.id) ? "▾" : "▸"} ${flow.label.trim()}`], width, ansi.cyan, row);
    lines.push(...flowLines.lines);
    selectableRows.push(...flowLines.lines.map(() => false));
    linkBoxes.push(...flowLines.linkBoxes);
    hitBoxes.push({ flowId: flow.id, top: row, bottom: row + flowLines.lines.length - 1 });
    row += flowLines.lines.length;
     const chart = chartForToolEvent(flow.event, width);
    if (chart !== undefined) {
      const chartLines = chart.split("\n").flatMap((line) => wrapAnsiLine(line, Math.max(1, width - 4)));
      lines.push(...chartLines.map((line) => ({ text: panelLine(` ${line}`, width, ansi.cyan), links: [] })));
      selectableRows.push(...chartLines.map(() => false));
      row += chartLines.length;
    }
    const detailEvent = detailsEvent(flow);
    if (detailEvent !== undefined && state.expanded.has(flow.id)) {
      const details = renderPanelLines(wrapText(eventDetails(detailEvent, detailsEvents(flow, board.events)), Math.max(1, width - 6)), width, ansi.cyan, row, ansi.detailsBackground);
      lines.push(...details.lines);
      selectableRows.push(...details.lines.map(() => false));
      linkBoxes.push(...details.linkBoxes);
      row += details.lines.length;
    }
  }
  if (flows.length === 0) {
    const empty = renderPanelLines(["No harness events recorded yet"], width, ansi.cyan, row);
    lines.push(...empty.lines);
    selectableRows.push(...empty.lines.map(() => false));
    linkBoxes.push(...empty.linkBoxes);
    row += empty.lines.length;
  }
  lines.push({ text: panelBottom(width, ansi.cyan), links: [] });
  selectableRows.push(false);
  lines.push({ text: "", links: [] });
  selectableRows.push(false);
  const status = promptBoardStatus(board);
  const continuing = status === "running" && board.events.some((event) => event.kind === "ProviderTurnFinished" && event.data.finishReason === "tool-calls");
  const assistant = renderAssistantParts(board.assistant, board.events, width, status, continuing);
  const lineOwners: Array<string | undefined> = lines.map(() => undefined);
  lines.push(...assistant.lines);
  selectableRows.push(...assistant.lines.map((_, assistantIndex) => assistantIndex > 0 && assistantIndex < assistant.lines.length - 1
    ? { startColumn: 2, endColumn: Math.max(2, width - 2) }
    : false));
  lineOwners.push(...assistant.lines.map((_line, assistantIndex) => assistantIndex > 0 && assistantIndex < assistant.lines.length - 1 ? board.promptId : undefined));
  linkBoxes.push(...assistant.linkBoxes.map((link) => ({ ...link, row: link.row + lines.length - assistant.lines.length })));
  return { text: lines.map((line) => line.text).join("\n"), hitBoxes, linkBoxes, selectableRows, lineOwners };
};

export interface RenderedPromptHistory {
  text: string;
  lines: readonly string[];
  selectableRows: readonly SelectableRow[];
  lineOwners: readonly (string | undefined)[];
  hitBoxes: readonly HarnessHitBox[];
  linkBoxes: readonly TerminalLinkHitBox[];
  totalRows: number;
  maxScrollOffset: number;
}

export const renderPromptHistory = (boards: readonly PromptBoard[], state: TuiInteractionState, width = terminalWidth(), viewportRows = 24, headerRows = 0): RenderedPromptHistory => {
  width = terminalWidth(width);
  const bodyLines: string[] = [];
  const bodySelectableRows: SelectableRow[] = [];
  const bodyLineOwners: Array<string | undefined> = [];
  const bodyHits: HarnessHitBox[] = [];
  const bodyLinks: TerminalLinkHitBox[] = [];
  for (const [index, board] of boards.entries()) {
    const rendered = renderPromptBoard(board, state, width, index);
    const startRow = bodyLines.length + 1;
    bodyLines.push(...rendered.text.split("\n"));
    bodySelectableRows.push(...rendered.selectableRows);
    bodyLineOwners.push(...rendered.lineOwners);
    bodyHits.push(...rendered.hitBoxes.map((box) => ({ ...box, top: box.top + startRow - 1, bottom: box.bottom + startRow - 1 })));
    bodyLinks.push(...rendered.linkBoxes.map((box) => ({ ...box, row: box.row + startRow - 1 })));
  }
  const safeViewport = Math.max(1, Math.floor(viewportRows));
  const maxScrollOffset = Math.max(0, bodyLines.length - safeViewport);
  const offset = Math.min(maxScrollOffset, Math.max(0, state.scrollOffset));
  const visibleRows = bodyLines.slice(offset, offset + safeViewport);
  const visibleSelectableRows = bodySelectableRows.slice(offset, offset + safeViewport);
  const visibleLineOwners = bodyLineOwners.slice(offset, offset + safeViewport);
  const firstVisibleRow = headerRows + 1;
  const lastVisibleRow = headerRows + visibleRows.length;
  const visibleHits = bodyHits.flatMap((box) => {
    if (box.bottom < offset + 1 || box.top > offset + visibleRows.length) return [];
    return [{
      ...box,
      top: Math.max(firstVisibleRow, box.top - offset + headerRows),
      bottom: Math.min(lastVisibleRow, box.bottom - offset + headerRows),
    }];
  });
  const visibleLinks = bodyLinks.flatMap((box) => box.row < offset + 1 || box.row > offset + visibleRows.length ? [] : [{ ...box, row: box.row - offset + headerRows }]);
  const renderedRows = visibleRows.map((line, index) => state.selection === undefined ? line : renderSelectedLine(line, state.selection, firstVisibleRow + index, visibleSelectableRows[index] ?? false));
  return { text: renderedRows.join("\n"), lines: visibleRows, selectableRows: visibleSelectableRows, lineOwners: visibleLineOwners, hitBoxes: visibleHits, linkBoxes: visibleLinks, totalRows: bodyLines.length, maxScrollOffset };
};

const canvasLine = (content: string, width: number): string => {
  const safeWidth = terminalWidth(width);
  const clipped = truncateCells(content, safeWidth);
  return `${ansi.background}${ansi.foreground}${clipped}${ansi.background}${ansi.foreground}${" ".repeat(Math.max(0, safeWidth - visibleWidth(clipped)))}${ansi.reset}`;
};
const activeInputPrompt = (): string => `${ansi.background}${ansi.cyan}${ansi.bold}USER${ansi.reset}${ansi.background} ${ansi.amber}>${ansi.reset}${ansi.background}${ansi.foreground} `;
export const renderConsolePrompt = (prompt: string, width = terminalWidth()): readonly string[] => {
  if (prompt.length === 0) return [];
  const safeWidth = terminalWidth(width);
  return wrapText(`${ansi.cyan}${ansi.bold}USER${ansi.reset}${ansi.background} ${ansi.amber}>${ansi.reset}${ansi.background}${ansi.foreground} ${terminalText(prompt)}${ansi.reset}${ansi.background}`, safeWidth).map((line) => canvasLine(line, safeWidth));
};

export const inputAreaLines = (input: string, width = terminalWidth()): number => Math.max(1, wrapText(`USER > ${terminalText(input)}`, terminalWidth(width)).length);
export interface ImagePreview { payload: string; rows: number; columns: number; paddingRows?: number; kittyData?: Uint8Array; }
export interface GraphicPlacement {
  key: string;
  data: Uint8Array;
  row: number;
  column: number;
  columns: number;
  rows: number;
}
export interface ActiveKittyPlacement {
  imageId: number;
  placementId: number;
  row: number;
  column: number;
  columns: number;
  rows: number;
}
export const kittyPreviewPlacementKey = (path: string, data: Uint8Array, row: number, columns: number, rows: number): string => `preview\u0000${path}\u0000${digest(Buffer.from(data).toString("base64"))}\u0000${row}\u0000${columns}\u0000${rows}`;
/** Stable chart identity keeps a placement attached to its durable source across viewport moves. */
export const kittyChartPlacementKey = (eventId: string, occurrence: number, cacheKey: string): string => `chart\u0000${eventId}\u0000${occurrence}\u0000${cacheKey}`;
/** Stable formula identity keeps duplicate source occurrences separate while scrolling. */
export const kittyLatexPlacementKey = (promptId: string, occurrence: number, cacheKey: string): string => `latex\u0000${promptId}\u0000${occurrence}\u0000${cacheKey}`;
const kittyPlacementGeometryChanged = (active: ActiveKittyPlacement, placement: GraphicPlacement): boolean => active.row !== placement.row || active.column !== placement.column || active.columns !== placement.columns || active.rows !== placement.rows;

/** Removes stale or relocated Kitty placements before the text frame is cleared. */
export const reconcileKittyPlacementsBeforePaint = (activePlacements: Map<string, ActiveKittyPlacement>, protocol: ImageProtocol, placements: readonly GraphicPlacement[]): string => {
  let frame = "";
  for (const [key, placement] of activePlacements) {
    const next = protocol === "kitty" ? placements.find((candidate) => candidate.key === key) : undefined;
    if (next === undefined) {
      frame += `${deleteKittyPlacement(placement.placementId)}${deleteKittyImage(placement.imageId)}`;
      activePlacements.delete(key);
    } else if (kittyPlacementGeometryChanged(placement, next)) frame += deleteKittyPlacement(placement.placementId);
  }
  return frame;
};

/** Replaces every current Kitty placement after the text frame has been painted. */
export const reconcileKittyPlacements = (activePlacements: Map<string, ActiveKittyPlacement>, protocol: ImageProtocol, placements: readonly GraphicPlacement[], nextId: number): { frame: string; nextId: number } => {
  let frame = "";
  if (protocol !== "kitty") return { frame, nextId };
  for (const placement of placements) {
    const active = activePlacements.get(placement.key);
    if (active !== undefined) {
      frame += `\x1b[${placement.row};${placement.column}H${placeKittyImage(active.imageId, active.placementId, placement.columns, placement.rows)}`;
      active.row = placement.row;
      active.column = placement.column;
      active.columns = placement.columns;
      active.rows = placement.rows;
      continue;
    }
    const imageId = nextId;
    const placementId = nextId;
    nextId += 1;
    activePlacements.set(placement.key, { imageId, placementId, row: placement.row, column: placement.column, columns: placement.columns, rows: placement.rows });
    frame += `\x1b[${placement.row};${placement.column}H${encodeKittyPng(placement.data, 4096, placement.columns, placement.rows, imageId, placementId)}`;
  }
  return { frame, nextId };
};

/** Repaint the current iTerm2 images after a cleared text frame; OSC images have no retained placement state. */
export const placeIterm2Frame = (placements: readonly GraphicPlacement[], restoreRow: number): string => {
  let frame = "";
  for (const placement of placements) frame += `\x1b[${placement.row};${placement.column}H${encodeIterm2Graphic(placement)}`;
  return `${frame}\x1b[${Math.max(1, Math.floor(restoreRow))};1H`;
};
const imagePreviewPaddingRows = (preview: ImagePreview | string): number => typeof preview === "string" ? 0 : Math.max(0, Math.floor(preview.paddingRows ?? 0));
export const imagePreviewLines = (preview: ImagePreview | string | undefined): number => preview === undefined ? 0 : typeof preview === "string" ? Math.max(1, preview.split("\n").length) : Math.max(1, Math.floor(preview.rows)) + imagePreviewPaddingRows(preview) * 2;
export const imagePreviewContentRow = (regionStartRow: number, preview: ImagePreview | string): number => Math.max(1, Math.floor(regionStartRow)) + imagePreviewPaddingRows(preview);
export const visibleImagePreviewRows = (preview: ImagePreview | string | undefined, input: string, blocked = false): number => blocked || input.length > 0 ? 0 : imagePreviewLines(preview);
export const shouldShowImagePreview = (archived: boolean, browsingHistory: boolean): boolean => !archived || browsingHistory;
export const shouldArchiveImagePreview = (path: string | undefined): boolean => path !== undefined;
export const clampHistoryScrollOffset = (state: TuiInteractionState, maxScrollOffset: number): TuiInteractionState => ({ ...state, scrollOffset: Math.min(Math.max(0, Math.floor(maxScrollOffset)), Math.max(0, state.scrollOffset)) });
export const reconcileHiddenImageScrollOffset = (state: TuiInteractionState, maxScrollOffset: number): TuiInteractionState => clampHistoryScrollOffset(state, maxScrollOffset);
export interface DeferredImagePainter { queue(commit: () => void, valid: () => boolean): void; cancel(): void; }
export const createDeferredImagePainter = <H>(schedule: (callback: () => void, delayMs: number) => H, cancelScheduled: (handle: H) => void, delayMs = 32): DeferredImagePainter => {
  let generation = 0;
  let handle: H | undefined;
  const cancel = (): void => {
    generation += 1;
    if (handle !== undefined) cancelScheduled(handle);
    handle = undefined;
  };
  return {
    cancel,
    queue: (commit, valid) => {
      cancel();
      const expectedGeneration = generation;
      handle = schedule(() => {
        handle = undefined;
        if (expectedGeneration === generation && valid()) commit();
      }, delayMs);
    },
  };
};
export const boundImageRows = (payload: string, maxRows: number): string => payload.split("\n").slice(0, Math.max(1, Math.floor(maxRows))).join("\n");
export const imagePreviewStartRow = (headerRows: number, promptRows: number, historyRows: number): number => Math.max(1, Math.floor(headerRows) + Math.floor(promptRows) + Math.floor(historyRows) + 1);
const layoutRows = (screenRows: number, headerRows: number, promptRows: number, requestedInputRows: number, reservedRows = 0, footerRows = 1): { inputRows: number; viewportRows: number } => {
  const available = screenRows - headerRows - promptRows - Math.max(1, Math.floor(footerRows)) - Math.max(0, Math.floor(reservedRows));
  const inputRows = Math.min(requestedInputRows, Math.max(0, available - 1));
  return { inputRows, viewportRows: Math.max(1, available - inputRows) };
};
const TUI_FOOTER_ROWS = 2;
const readlineControlBytes = new Set(["\x01", "\x02", "\x05", "\x06", "\x08", "\x09", "\x0a", "\x0b", "\x0d", "\x0e", "\x10", "\x15", "\x17", "\x19", "\x1a", "\x7f"]);
const readlineEscapeSequences = new Set(["\x1b[A", "\x1b[B", "\x1b[C", "\x1b[D", "\x1bOA", "\x1bOB", "\x1bOC", "\x1bOD", "\x1b[H", "\x1b[F", "\x1bOH", "\x1bOF", "\x1b[1~", "\x1b[3~", "\x1b[4~", "\x1b[5~", "\x1b[6~"]);
const sanitizeReadlineInput = (input: string): string => input
  .replace(/(?:\x1b(?:\][\s\S]*?(?:\x07|\x1b\\|\x9c|$)|P[\s\S]*?(?:\x1b\\|\x9c|$)|X[\s\S]*?(?:\x1b\\|\x9c|$)|\^[\s\S]*?(?:\x1b\\|\x9c|$)|_[\s\S]*?(?:\x07|\x1b\\|\x9c|$))|[\x90\x98\x9d\x9e\x9f][\s\S]*?(?:\x07|\x1b\\|\x9c|$))/g, "")
  .replace(/\x1b(?:O[A-DHF]|\[[0-?]*[ -/]*[@-~]|[ -/]*[@-~])/g, (sequence) => readlineEscapeSequences.has(sequence) ? sequence : "")
  .replace(/[\x00-\x1f\x7f-\x9f]/g, (character) => readlineControlBytes.has(character) ? character : "");

export const renderCopyPopup = (message: string, width = terminalWidth()): string[] => {
  const safeWidth = terminalWidth(width);
  const content = ` ${terminalText(message)} `;
  const boxWidth = Math.min(safeWidth - 4, Math.max(24, visibleWidth(content) + 2));
  const innerWidth = Math.max(1, boxWidth - 2);
  const clipped = truncateCells(content, innerWidth);
  const padding = " ".repeat(Math.max(0, innerWidth - visibleWidth(clipped)));
  return [
    `${ansi.background}${ansi.cyan}╭${"─".repeat(innerWidth)}╮${ansi.reset}`,
    `${ansi.background}${ansi.cyan}│${ansi.reset}${ansi.background}${ansi.amber}${ansi.bold}${clipped}${padding}${ansi.reset}${ansi.cyan}│${ansi.reset}`,
    `${ansi.background}${ansi.cyan}╰${"─".repeat(innerWidth)}╯${ansi.reset}`,
  ];
};

export const scrollHistory = (state: TuiInteractionState, direction: MouseWheelDirection | "top" | "bottom", totalRows: number, viewportRows: number): TuiInteractionState => {
  const maxOffset = Math.max(0, Math.max(0, Math.floor(totalRows)) - Math.max(1, Math.floor(viewportRows)));
  const offset = direction === "top" ? 0 : direction === "bottom" ? maxOffset : Math.min(maxOffset, Math.max(0, state.scrollOffset + (direction === "up" ? -1 : 1)));
  return { ...state, scrollOffset: offset };
};

export type HistoryFollowMode = "follow" | "manual";

export interface HistoryNavigation {
  state: TuiInteractionState;
  mode: HistoryFollowMode;
}

/** Explicit user intent outlives event, resize, and async rendering geometry changes. */
export const navigateHistory = (state: TuiInteractionState, mode: HistoryFollowMode, direction: MouseWheelDirection | "top" | "bottom", totalRows: number, viewportRows: number): HistoryNavigation => {
  const nextState = scrollHistory(state, direction, totalRows, viewportRows);
  if (direction === "up" || direction === "top") return { state: nextState, mode: "manual" };
  if (direction === "bottom") return { state: nextState, mode: "follow" };
  const maxScrollOffset = Math.max(0, Math.floor(totalRows) - Math.max(1, Math.floor(viewportRows)));
  return { state: nextState, mode: nextState.scrollOffset === maxScrollOffset ? "follow" : "manual" };
};

/** Reconcile an already chosen mode against freshly rendered geometry without changing intent. */
export const reconcileHistoryNavigation = (state: TuiInteractionState, mode: HistoryFollowMode, totalRows: number, viewportRows: number): HistoryNavigation => mode === "follow"
  ? { state: scrollHistory(state, "bottom", totalRows, viewportRows), mode }
  : { state: clampHistoryScrollOffset(state, Math.max(0, Math.floor(totalRows) - Math.max(1, Math.floor(viewportRows)))), mode };

export const dispatchHistoryWheel = (state: TuiInteractionState, mode: HistoryFollowMode, mouse: MouseEvent, totalRows: number, viewportRows: number): HistoryNavigation | undefined => {
  if (mouse.action !== "press" || (mouse.button !== 64 && mouse.button !== 65)) return undefined;
  return navigateHistory(clearSelection(state), mode, mouse.button === 64 ? "up" : "down", totalRows, viewportRows);
};

/** Execution blocks clicks and drags, but wheel navigation remains available outside permission overlays. */
export const shouldHandleMouseDuringExecution = (mouse: MouseEvent, permissionOverlayActive: boolean): boolean => !permissionOverlayActive && mouse.action === "press" && (mouse.button === 64 || mouse.button === 65);

export const scrollHistoryOnWheel = (state: TuiInteractionState, direction: MouseWheelDirection, totalRows: number, viewportRows: number, requestRender: () => void): TuiInteractionState => {
  const nextState = scrollHistory(clearSelection(state), direction, totalRows, viewportRows);
  requestRender();
  return nextState;
};

const eventLabel = (event: DurableEvent): string | undefined => {
  if (event.kind === "GraphPlanPublished") return `  ${ansi.cyan}▣ PLAN${ansi.reset} ${singleLineText(event.data.plan.nodes.map((node) => node.nodeId).join(" → "))}`;
  if (event.kind === "HarnessThinking") {
    if (event.data.step === "input" || event.data.step === "continuation" || event.data.step === "tool" || /^turn-\d+$/.test(event.data.step)) return undefined;
    return `  ${ansi.amber}INTENT${ansi.reset} ${singleLineText(event.data.step)} ${ansi.muted}—${ansi.reset} ${singleLineText(event.data.text)}`;
  }
  if (event.kind === "TaskConclusion") return `  ${event.data.outcome === "finished" ? ansi.green + "✓" : ansi.red + "✗"} CONCLUSION${ansi.reset} ${singleLineText(event.data.summary)}`;
  if (event.kind === "ToolCalled") {
    const fetchLabel = fetchPageLabel(event);
    if (fetchLabel !== undefined) return fetchLabel;
    const command = bashCommand(event);
    if (command !== undefined) return `  ${ansi.muted}> ${command}${ansi.reset}`;
    return `  ${ansi.amber}⟳ TOOL${ansi.reset} ${singleLineText(event.data.name)}`;
  }
  if (event.kind === "ToolSucceeded") return `  ${ansi.green}✓ TOOL RESULT${ansi.reset} ${singleLineText(event.data.callId)}`;
  if (event.kind === "ToolFailed") return `  ${ansi.red}✗ TOOL FAILED${ansi.reset} ${singleLineText(event.data.code)}: ${singleLineText(event.data.message)}`;
  if (event.kind === "ProviderTurnStarted") return `  ${ansi.cyan}◇ AGENT${ansi.reset} ${singleLineText(event.data.provider)}/${singleLineText(event.data.model)}`;
  if (event.kind === "ProviderTurnFinished") return event.data.finishReason === "tool-calls"
    ? `  ${ansi.amber}⟳ AGENT CONTINUE${ansi.reset} (${singleLineText(event.data.finishReason)})`
    : `  ${ansi.green}✓ AGENT COMPLETE${ansi.reset} (${singleLineText(event.data.finishReason)})`;
  if (event.kind === "ProviderTurnFailed") return `  ${ansi.red}✗ AGENT FAILED${ansi.reset} ${singleLineText(event.data.code)}`;
  if (event.kind === "GraphTransition") return `  ${ansi.cyan}· GRAPH${ansi.reset} ${singleLineText(event.data.nodeId)}: ${singleLineText(event.data.outcome)}`;
  if (event.kind === "BackgroundAgentCreated") return `  ${ansi.cyan}◇ BACKGROUND${ansi.reset} ${singleLineText(event.data.profile)} ${singleLineText(event.data.agentId)}`;
  if (event.kind === "BackgroundAgentStatus") return `  ${event.data.status === "completed" ? ansi.green : event.data.status === "failed" || event.data.status === "cancelled" ? ansi.red : ansi.amber}· BACKGROUND ${singleLineText(event.data.status)}${ansi.reset} ${singleLineText(event.data.outputPreview ?? event.data.detail ?? "")}`;
  return undefined;
};

const assistantText = (body: unknown): string | undefined => {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return undefined;
  const history = (body as { history?: unknown }).history;
  if (!Array.isArray(history)) return undefined;
  const messages = history.filter((message): message is { role: unknown; content: unknown } => typeof message === "object" && message !== null && !Array.isArray(message));
  const assistants = messages.filter((message): message is { role: "assistant"; content: string } => message.role === "assistant" && typeof message.content === "string");
  return assistants.map((message) => message.content).at(-1);
};

export interface TuiTokenUsage {
  inputTokens: number;
  outputTokens: number;
  contextTokens: number;
  contextWindow: number;
}

const compactNumber = (value: number): string => {
  const normalized = Math.max(0, Math.floor(value));
  if (normalized < 1_000) return String(normalized);
  const units = [{ divisor: 1_000, suffix: "K" }, { divisor: 1_000_000, suffix: "M" }, { divisor: 1_000_000_000, suffix: "B" }] as const;
  let unit = normalized >= 1_000_000_000 ? 2 : normalized >= 1_000_000 ? 1 : 0;
  while (unit < units.length - 1) {
    const current = units[unit] ?? units[0];
    const decimals = normalized >= current.divisor * 10 ? 0 : 1;
    if (Number((normalized / current.divisor).toFixed(decimals)) < 1_000) break;
    unit += 1;
  }
  const current = units[unit] ?? units[0];
  const decimals = normalized >= current.divisor * 10 ? 0 : 1;
  return `${(normalized / current.divisor).toFixed(decimals).replace(/\.0$/, "")}${current.suffix}`;
};

const contextPercent = (tokens: number, contextWindow: number): string => {
  if (contextWindow <= 0) return "0%";
  const percent = Math.max(0, tokens / contextWindow * 100);
  return `${percent.toFixed(percent < 10 ? 1 : 0)}%`;
};

export const summarizeTokenUsage = (events: readonly DurableEvent[], contextWindow: number): TuiTokenUsage => {
  let inputTokens = 0;
  let outputTokens = 0;
  let contextTokens = 0;
  for (const event of events) {
    if (event.kind !== "ProviderTurnFinished") continue;
    inputTokens += Math.max(0, event.data.inputTokens);
    outputTokens += Math.max(0, event.data.outputTokens);
    contextTokens = Math.max(0, event.data.inputTokens);
  }
  return { inputTokens, outputTokens, contextTokens, contextWindow: Math.max(1, Math.floor(contextWindow)) };
};

const compactFolder = (folder: string, maxWidth: number): string => {
  const safeFolder = singleLineText(folder);
  if (visibleWidth(safeFolder) <= maxWidth) return safeFolder;
  const leaf = basename(safeFolder);
  return truncateCells(`…/${leaf}`, maxWidth);
};

export const renderStatusBar = (folder: string, usage: TuiTokenUsage, width = terminalWidth()): string => {
  const safeWidth = terminalWidth(width);
  const remainingContext = Math.max(0, usage.contextWindow - usage.contextTokens);
  const metrics = `IN ${compactNumber(usage.inputTokens)}  OUT ${compactNumber(usage.outputTokens)}  CTX ${contextPercent(usage.contextTokens, usage.contextWindow)}  REMAIN ${compactNumber(remainingContext)}`;
  const contentWidth = Math.max(1, safeWidth - 4);
  const mode = `${ansi.amber}NAVIGATION MODE${ansi.reset}`;
  const folderWidth = Math.max(8, contentWidth - visibleWidth("NAVIGATION MODE  ·  ") - visibleWidth(metrics) - 2);
  const full = `${mode}  ${ansi.muted}·${ansi.reset}  ${ansi.foreground}${compactFolder(folder, folderWidth)}${ansi.reset}  ${ansi.muted}·${ansi.reset}  ${ansi.cyan}${metrics}${ansi.reset}`;
  const compact = `${ansi.amber}NAV${ansi.reset}  ${ansi.cyan}${metrics}${ansi.reset}`;
  const content = visibleWidth(full) <= contentWidth ? full : compact;
  return panelLine(truncateCells(content, contentWidth), safeWidth, ansi.cyan, ansi.detailsBackground);
};

/** Compose a screen whose footer always occupies the terminal's final row. */
export const pinFooter = (bodyLines: readonly string[], footer: string, rows: number): readonly string[] => {
  return pinFooters(bodyLines, [footer], rows);
};

/** Compose a screen whose footer lines always occupy the terminal's final rows. */
export const pinFooters = (bodyLines: readonly string[], footerLines: readonly string[], rows: number): readonly string[] => {
  const height = Math.max(1, Math.floor(rows));
  const footer = footerLines.length === 0 ? [""] : footerLines.slice(-height);
  const bodyRows = Math.max(0, height - footer.length);
  const padded = bodyLines.slice(0, bodyRows);
  while (padded.length < bodyRows) padded.push("");
  return [...padded, ...footer];
};

/** Restore footer rows after readline redraws the active input line. */
export const footerFrame = (footerLines: readonly string[], screenRows: number, width = terminalWidth()): string => {
  const height = Math.max(1, Math.floor(screenRows));
  const footer = footerLines.length === 0 ? [""] : footerLines.slice(-height);
  const startRow = height - footer.length + 1;
  return footer.map((line, index) => `\x1b[${startRow + index};1H\x1b[2K${canvasLine(line, width)}`).join("");
};

/** Repaint only the activity footer so animation ticks never clear and retransmit native images. */
export const activityFooterFrame = (activity: string, active: boolean, screenRows: number, width = terminalWidth()): string => {
  const height = Math.max(1, Math.floor(screenRows));
  void active;
  const cursorVisibility = "\x1b[?25h";
  if (height < 2) return cursorVisibility;
  const row = height - 1;
  const line = panelLine(singleLineText(activity), width, ansi.amber, ansi.detailsBackground);
  return `${cursorVisibility}\x1b[s\x1b[${row};1H\x1b[2K${canvasLine(line, width)}\x1b[u`;
};

export const renderThinkingEffort = (effort: string, visible: boolean, width = terminalWidth()): string => panelLine(`${ansi.cyan}THINKING EFFORT${ansi.reset} ${ansi.amber}${singleLineText(effort).toUpperCase()}${ansi.reset} ${ansi.muted}· VISIBILITY ${visible ? "ON" : "OFF"}${ansi.reset}`, terminalWidth(width), ansi.cyan);

const headerLines = (settings: TuiSettings, sessionId: string, width = terminalWidth()): string[] => {
  width = terminalWidth(width);
  const status = `${ansi.cyan}SESSION${ansi.reset} ${terminalText(sessionId)}  ${ansi.muted}·${ansi.reset}  ${ansi.cyan}MODEL${ansi.reset} ${terminalText(settings.model)}  ${ansi.muted}·${ansi.reset}  ${ansi.cyan}AGENT${ansi.reset} ${terminalText(settings.agent).toUpperCase()}`;
  return [panelTop("F I N L E E T // TERMINAL BOARD", width, ansi.cyan), renderThinkingEffort(settings.thinkingEffort, settings.thinking, width), ...wrapText(status, Math.max(1, width - 4)).map((line) => panelLine(line, width, ansi.cyan)), panelBottom(width, ansi.cyan), sectionBanner("COMPOSE", `TYPE A MESSAGE · ${ansi.amber}/HELP${ansi.reset}${ansi.background}${ansi.muted} COMMANDS`, width)];
};

export type OverlayButtonAction =
  | { type: "session"; sessionId: string }
  | { type: "back-to-compose" };

export interface OverlayButton {
  action: OverlayButtonAction;
  left: number;
  right: number;
  row: number;
}

export type AgentPanelButton = OverlayButton;

export interface OverlayRender {
  lines: readonly string[];
  buttons: readonly OverlayButton[];
}

const overlayBackButtonLabel = "[ESC] BACK TO COMPOSE";

const appendOverlayBackButton = (lines: string[], buttons: OverlayButton[], width: number): void => {
  const safeWidth = terminalWidth(width);
  const innerWidth = Math.max(1, safeWidth - 4);
  const visibleLabel = truncateCells(overlayBackButtonLabel, innerWidth);
  const left = 3;
  lines.push(panelLine(`${ansi.amber}${ansi.bold}[ESC]${ansi.reset} BACK TO COMPOSE`, safeWidth, ansi.cyan));
  buttons.push({ action: { type: "back-to-compose" }, left, right: Math.min(safeWidth - 2, left + visibleWidth(visibleLabel) - 1), row: lines.length });
};

export const renderHelp = (width = terminalWidth()): OverlayRender => {
  const safeWidth = terminalWidth(width);
  const commands = ["  /model <provider/model>  select a model", "  /agent  toggle primary/build view", "  /thinking  toggle thinking visibility", "  /details  toggle harness details", "  /harness <n>  toggle harness row and show detail", "  /scroll up|down|top|bottom  scroll prompt history", "  /open <https-url>  open a safe link", "  /image <path>  render an image in the terminal", "  /settings  show current settings", "  /list_agents  show active main and background agents", "  --context-window <N>  set the context window in tokens", "  /help  show this help", "  /quit  exit"];
  const contents = commands.flatMap((command) => wrapText(command, Math.max(1, safeWidth - 4)));
  const lines = [panelTop("COMMANDS // HELP", safeWidth), ...contents.map((line) => panelLine(line, safeWidth))];
  const buttons: OverlayButton[] = [];
  appendOverlayBackButton(lines, buttons, safeWidth);
  lines.push(panelBottom(safeWidth));
  return { lines, buttons };
};

export const renderSettings = (settings: TuiSettings, width = terminalWidth()): OverlayRender => {
  const safeWidth = terminalWidth(width);
  const rows = [
    ["PROVIDER", settings.provider],
    ["MODEL", settings.model],
    ["AGENT", settings.agent.toUpperCase()],
    ["THINKING", settings.thinking ? "ON" : "OFF"],
    ["EFFORT", settings.thinkingEffort.toUpperCase()],
    ["DETAILS", settings.details ? "ON" : "OFF"],
    ["CONTEXT WINDOW", compactNumber(settings.contextWindow)],
    ["JOURNAL", settings.journal],
    ...(settings.cache === undefined ? [] : [["CACHE", settings.cache]]),
    ...(settings.authFile === undefined ? [] : [["AUTH FILE", settings.authFile]]),
  ] as const;
  const contents = rows.flatMap(([label, value]) => wrapText(`${label.padEnd(14)} ${terminalText(value)}`, Math.max(1, safeWidth - 4)));
  const lines = [panelTop("RUNTIME // SETTINGS", safeWidth, ansi.cyan), ...contents.map((line) => panelLine(line, safeWidth, ansi.cyan))];
  const buttons: OverlayButton[] = [];
  appendOverlayBackButton(lines, buttons, safeWidth);
  lines.push(panelBottom(safeWidth, ansi.cyan));
  return { lines, buttons };
};

export type AgentsPanelRender = OverlayRender;

/** Keep overlay structure visible while remapping only controls whose source rows survive clipping. */
export const clipOverlayRender = (render: OverlayRender, viewportRows: number): OverlayRender => {
  const availableRows = Math.max(0, Math.floor(viewportRows));
  if (availableRows === 0 || render.lines.length === 0) return { lines: [], buttons: [] };

  const lastSourceRow = render.lines.length;
  const backButton = render.buttons.find((button) => button.action.type === "back-to-compose");
  const backSourceRow = backButton !== undefined && backButton.row >= 1 && backButton.row <= lastSourceRow
    ? backButton.row
    : undefined;
  const middleRows = availableRows >= 3 ? Math.max(0, availableRows - 3) : 0;
  const lastMiddleRow = Math.max(1, (backSourceRow ?? lastSourceRow) - 1);
  const middle: number[] = [];
  for (let row = 2; row <= lastMiddleRow && middle.length < middleRows; row += 1) middle.push(row);
  const sourceRows: number[] = [1, ...middle];
  if (availableRows >= 2 && backSourceRow !== undefined && backSourceRow !== 1) sourceRows.push(backSourceRow);
  if (availableRows >= 3) sourceRows.push(lastSourceRow);
  const uniqueSourceRows = [...new Set(sourceRows)].filter((row) => row >= 1 && row <= lastSourceRow);
  const rowMap = new Map<number, number>(uniqueSourceRows.map((sourceRow, index) => [sourceRow, index + 1]));
  const lines = uniqueSourceRows.map((sourceRow) => render.lines[sourceRow - 1] ?? "");
  const buttons: OverlayButton[] = [];
  for (const button of render.buttons) {
    const row = rowMap.get(button.row);
    if (row === undefined || button.left < 1 || button.right < button.left) continue;
    const overlaps = buttons.some((existing) => existing.row === row && button.left <= existing.right && button.right >= existing.left);
    if (overlaps) continue;
    buttons.push({ ...button, row });
  }
  return { lines, buttons };
};

export const offsetOverlayButtons = (buttons: readonly OverlayButton[], rowOffset: number): readonly OverlayButton[] => buttons.map((button) => ({ ...button, row: button.row + rowOffset }));

export const visibleOverlayButtons = (buttons: readonly OverlayButton[], minRow: number, maxRow: number): readonly OverlayButton[] => {
  const first = Math.max(1, Math.floor(minRow));
  const last = Math.floor(maxRow);
  if (last < first) return [];
  return buttons.filter((button) => button.row >= first && button.row <= last);
};

export const hitTestOverlayButton = (row: number, column: number, buttons: readonly OverlayButton[]): OverlayButton | undefined => buttons.find((button) => button.row === row && column >= button.left && column <= button.right);

/** Activate only a left-button press/release that remains inside the same visible row. */
export const activateOverlayButton = (pressed: OverlayButton | undefined, release: MouseEvent, dragged = false): OverlayButtonAction | undefined => {
  if (pressed === undefined || dragged || release.action !== "release" || release.button !== 0 || release.row !== pressed.row || release.column < pressed.left || release.column > pressed.right) return undefined;
  return pressed.action;
};

export const offsetAgentPanelButtons = offsetOverlayButtons;
export const visibleAgentPanelButtons = visibleOverlayButtons;
export const hitTestAgentPanelButton = hitTestOverlayButton;
export const activateAgentPanelButton = activateOverlayButton;

export const renderAgentsPanel = (sessionId: string, agents: readonly LiveBackgroundAgent[], mainStatus: "idle" | "running" | "failed" | "recovery_required" = "idle", width = terminalWidth()): AgentsPanelRender => {
  const safeWidth = terminalWidth(width);
  const rows: readonly [string, string][] = [[sessionId, `${ansi.amber}${ansi.bold}[0]${ansi.reset} main ${terminalText(sessionId)} ${mainStatus}`], ...agents.map((agent): [string, string] => [agent.childSessionId, `${ansi.amber}${ansi.bold}[${agent.index}]${ansi.reset} background ${terminalText(agent.agentId)} ${terminalText(agent.childSessionId)} ${agent.status}`])];
  const buttons: OverlayButton[] = [];
  const contents = rows.flatMap(([targetSessionId, row]) => wrapText(row, Math.max(1, safeWidth - 4)).map((line) => {
    buttons.push({ action: { type: "session", sessionId: targetSessionId }, left: 1, right: safeWidth, row: buttons.length + 2 });
    return panelLine(line, safeWidth, ansi.cyan);
  }));
  const lines = [panelTop("AGENTS // LIVE", safeWidth, ansi.cyan), ...contents];
  appendOverlayBackButton(lines, buttons, safeWidth);
  lines.push(panelBottom(safeWidth, ansi.cyan));
  return { lines, buttons };
};

export const expandHomePath = (path: string, home = homedir()): string => path === "~" ? home : path.startsWith("~/") || path.startsWith("~\\") ? resolve(home, path.slice(2)) : path;

export const sessionInputHistory = (events: readonly DurableEvent[]): readonly string[] => events
  .filter((event): event is DurableEvent & { kind: "PromptAdmitted" } => event.kind === "PromptAdmitted")
  .map((event) => event.data.prompt)
  .filter((prompt) => prompt.trim().length > 0 && !prompt.trimStart().startsWith("/"));

export type InputHistoryDirection = "up" | "down";
export interface InputHistoryNavigation { index: number; value: string; consumed: boolean; }
export const inputHistoryDirection = (input: string): InputHistoryDirection | undefined => input === "\x1b[A" || input === "\x1bOA" ? "up" : input === "\x1b[B" || input === "\x1bOB" ? "down" : undefined;
const horizontalPromptCursorKey = (input: string): "left" | "right" | undefined => input === "\x1b[D" || input === "\x1bOD" ? "left" : input === "\x1b[C" || input === "\x1bOC" ? "right" : undefined;
export type BareEscapeRoute = "permission" | "overlay" | "readline" | "sequence";
export const routeBareEscape = (input: string, permissionVisible: boolean, overlayVisible: boolean): BareEscapeRoute => {
  if (input !== "\x1b") return "sequence";
  if (permissionVisible) return "permission";
  if (overlayVisible) return "overlay";
  return "readline";
};
export const shouldNavigateInputHistory = (line: string, entries: readonly string[], index: number): boolean => line.length === 0 || index >= 0 && line === entries[index];
export const navigateInputHistory = (entries: readonly string[], index: number, direction: InputHistoryDirection): InputHistoryNavigation => {
  if (entries.length === 0) return { index: -1, value: "", consumed: false };
  if (direction === "up") {
    const next = index < 0 ? entries.length - 1 : Math.max(0, index - 1);
    return { index: next, value: entries[next] ?? "", consumed: true };
  }
  if (index < 0) return { index: -1, value: "", consumed: false };
  if (index >= entries.length - 1) return { index: -1, value: "", consumed: true };
  const next = index + 1;
  return { index: next, value: entries[next] ?? "", consumed: true };
};

export interface PromptCursorNavigation { cursor: number; preferredColumn: number; moved: boolean; }
export const navigatePromptCursor = (line: string, cursor: number, direction: InputHistoryDirection, columns: number, preferredColumn?: number, promptWidth = terminalCellWidth("USER > ")): PromptCursorNavigation => {
  const safeColumns = Math.max(1, Math.floor(columns));
  const stops: Array<{ cursor: number; row: number; column: number }> = [{ cursor: 0, row: Math.floor(promptWidth / safeColumns), column: promptWidth % safeColumns }];
  let offset = 0;
  let row = Math.floor(promptWidth / safeColumns);
  let column = promptWidth % safeColumns;
  for (const grapheme of graphemes(line)) {
    offset += grapheme.length;
    if (grapheme === "\n") {
      row += 1;
      column = 0;
    } else {
      const width = terminalCellWidth(grapheme);
      if (column > 0 && column + width > safeColumns) {
        row += 1;
        column = 0;
      }
      column += width;
      row += Math.floor(column / safeColumns);
      column %= safeColumns;
    }
    stops.push({ cursor: offset, row, column });
  }
  const safeCursor = Math.max(0, Math.min(line.length, Math.floor(cursor)));
  const current = stops.reduce((closest, stop) => Math.abs(stop.cursor - safeCursor) < Math.abs(closest.cursor - safeCursor) ? stop : closest);
  const desiredColumn = preferredColumn ?? current.column;
  const targetRow = current.row + (direction === "up" ? -1 : 1);
  const candidates = stops.filter((stop) => stop.row === targetRow);
  if (candidates.length === 0) return { cursor: current.cursor, preferredColumn: desiredColumn, moved: false };
  const target = candidates.reduce((closest, stop) => Math.abs(stop.column - desiredColumn) < Math.abs(closest.column - desiredColumn) ? stop : closest);
  return { cursor: target.cursor, preferredColumn: desiredColumn, moved: target.cursor !== current.cursor };
};

const MAX_IMAGE_FILE_BYTES = 16 * 1024 * 1024;
const MAX_IMAGE_PIXELS = 16_000_000;

export const nativeImageGeometry = (width: number, height: number, terminalColumns: number, maxRows = Number.MAX_SAFE_INTEGER, cellPixels?: TerminalCellPixelSize): { columns: number; rows: number } => {
  if (cellPixels !== undefined) return rasterCellGeometry(width, height, Math.max(1, Math.floor(terminalColumns * 0.6)), maxRows, cellPixels.width, cellPixels.height);
  const targetWidth = Math.max(1, Math.min(width, Math.floor(terminalColumns * 0.6)));
  const targetRows = Math.max(1, Math.ceil(height * (targetWidth / Math.max(1, width)) / 2));
  const scale = Math.min(1, Math.max(1, Math.floor(maxRows)) / targetRows);
  return { columns: Math.max(1, Math.floor(targetWidth * scale)), rows: Math.max(1, Math.floor(targetRows * scale)) };
};
const SIXEL_CELL_PIXEL_HEIGHT = 20;
export const nativeImageData = async (protocol: "kitty" | "iterm2", imagePath: string, decoded: Awaited<ReturnType<typeof Jimp.read>>): Promise<Buffer> => protocol === "kitty" ? decoded.getBuffer("image/png") : readFile(imagePath);

const renderImage = async (path: string, maxRows = Number.MAX_SAFE_INTEGER, cellPixels?: TerminalCellPixelSize): Promise<ImagePreview | undefined> => {
  try {
    const imagePath = expandHomePath(path);
 const protocol = selectImageProtocol(detectImageCapabilities(processStdout), process.env.TERM_PROGRAM);
    if ((await stat(imagePath)).size > MAX_IMAGE_FILE_BYTES) throw new Error("image exceeds the bounded input size");
    const decoded = await Jimp.read(imagePath);
    if (decoded.bitmap.width * decoded.bitmap.height > MAX_IMAGE_PIXELS) throw new Error("decoded image exceeds the bounded pixel size");
    if (protocol === "kitty" || protocol === "iterm2") {
      const data = await nativeImageData(protocol, imagePath, decoded);
      const paddingRows = protocol === "iterm2" && maxRows >= 3 ? 1 : 0;
       const geometry = nativeImageGeometry(decoded.bitmap.width, decoded.bitmap.height, terminalWidth(), Math.max(1, maxRows - paddingRows * 2), protocol === "kitty" ? cellPixels : undefined);
      const columns = geometry.columns;
      const rows = geometry.rows;
       return { payload: protocol === "kitty" ? encodeKittyPng(data, 4096, columns, rows) : encodeIterm2Png(data, columns, rows), rows, columns, paddingRows, ...(protocol === "kitty" ? { kittyData: data } : {}) };
    } else if (protocol === "sixel") {
       const maxWidth = Math.max(1, terminalWidth() - 2);
       const scaledWidth = Math.max(1, Math.min(decoded.bitmap.width, maxWidth));
 const maxImageRows = Math.max(1, Math.min(Math.floor(maxRows), Math.floor((processStdout.rows ?? 24) - 8)));
       const maxPixelHeight = maxImageRows * SIXEL_CELL_PIXEL_HEIGHT;
       const scaledHeight = Math.max(1, Math.min(maxPixelHeight, Math.ceil(decoded.bitmap.height * scaledWidth / Math.max(1, decoded.bitmap.width))));
       return { payload: encodeSixel({ width: decoded.bitmap.width, height: decoded.bitmap.height, data: decoded.bitmap.data }, maxWidth, maxPixelHeight), rows: Math.min(maxImageRows, Math.max(1, Math.ceil(scaledHeight / SIXEL_CELL_PIXEL_HEIGHT))), columns: scaledWidth };
    } else {
       const image = await terminalImage.file(imagePath, { width: "60%", preserveAspectRatio: true, preferNativeRender: false });
       const boundedImage = boundImageRows(image, maxRows);
       return { payload: boundedImage, rows: Math.max(1, boundedImage.split("\n").length), columns: terminalWidth() };
    }
  } catch {
    return { payload: `${ansi.red}Unable to render image:${ansi.reset} ${terminalText(path)}`, rows: 1, columns: terminalWidth() };
  }
};

const parseSettings = (args: readonly string[]): TuiSettings => {
  const provider = option(args, "--provider") ?? "openai-responses";
  const selectedModel = option(args, "--model") ?? "gpt-5.6-luna";
  const providerPrefix = `${provider}/`;
  const model = selectedModel.startsWith(providerPrefix) ? selectedModel.slice(providerPrefix.length) : selectedModel;
  const requestedContextWindow = Number(option(args, "--context-window"));
  const settings: TuiSettings = {
    provider,
    model,
    agent: "primary",
    thinking: true,
    thinkingEffort: "high",
    details: false,
    journal: option(args, "--journal") ?? ".finleet/journal.jsonl",
    contextWindow: Number.isSafeInteger(requestedContextWindow) && requestedContextWindow > 0 ? requestedContextWindow : 128_000,
  };
  const cache = option(args, "--cache");
  if (cache !== undefined) settings.cache = cache;
  const authFile = option(args, "--auth-file");
  if (authFile !== undefined) settings.authFile = authFile;
  return settings;
};

const commandArgs = (settings: TuiSettings, prompt: string, sessionId: string): string[] => [
  "exec", prompt, "--provider", settings.provider, "--model", settings.provider === "openai-responses" ? settings.model : `${settings.provider}/${settings.model}`, "--exchange", "paper", "--journal", settings.journal, "--session", sessionId, "--prompt-id", `tui-${randomUUID()}`, "--format", "text",
  ...(settings.provider === "openai-responses" ? ["--reasoning-effort", settings.thinkingEffort] : []),
  ...(settings.cache === undefined ? [] : ["--cache", settings.cache]),
  ...(settings.authFile === undefined ? [] : ["--auth-file", settings.authFile]),
];

export interface ClipboardCommand {
  command: string;
  args: readonly string[];
}

export const clipboardCommands = (platform: NodeJS.Platform = process.platform): readonly ClipboardCommand[] => {
  if (platform === "darwin") return [{ command: "pbcopy", args: [] }];
  if (platform === "win32") return [{ command: "clip.exe", args: [] }];
  return [{ command: "wl-copy", args: [] }, { command: "xclip", args: ["-selection", "clipboard"] }, { command: "xsel", args: ["--clipboard", "--input"] }];
};

export type ClipboardCommandRunner = (command: ClipboardCommand, text: string) => Promise<void>;

const runClipboardCommand: ClipboardCommandRunner = (command, text) => new Promise((resolve, reject) => {
  let settled = false;
  const finish = (error?: Error): void => {
    if (settled) return;
    settled = true;
    if (error === undefined) resolve(); else reject(error);
  };
  const child = spawn(command.command, [...command.args], { shell: false, windowsHide: true, stdio: ["pipe", "ignore", "ignore"] });
  child.once("error", (error) => finish(error));
  child.stdin.once("error", (error) => finish(error));
  child.once("close", (code) => code === 0 ? finish() : finish(new Error(`clipboard exited with ${String(code)}`)));
  child.stdin.end(text, "utf8");
});

const MAX_CLIPBOARD_TEXT = 64 * 1024;

export const clipboardText = (text: string): string => neutralizeControls(text.replace(ansiSequence, "")).slice(0, MAX_CLIPBOARD_TEXT);

/** Write bounded, control-free text without invoking a shell; Linux tries common clipboard tools in order. */
export const writeClipboardText = async (text: string, platform: NodeJS.Platform = process.platform, run: ClipboardCommandRunner = runClipboardCommand): Promise<boolean> => {
  const safeText = clipboardText(text);
  if (safeText.length === 0) return false;
  for (const command of clipboardCommands(platform)) {
    try {
      await run(command, safeText);
      return true;
    } catch {
      // Try the next platform-native clipboard utility.
    }
  }
  return false;
};

export const openTerminalLink = async (value: string, openBrowser: (url: string) => Promise<void>): Promise<boolean> => {
  const url = safeHttpUrl(value);
  if (url === undefined) return false;
  await openBrowser(url);
  return true;
};

export type TuiDependencies = { clipboard?: ClipboardWriter; workingDirectory?: string; openBrowser?: (url: string) => Promise<void>; signal?: AbortSignal; };

export type ClipboardWriter = (text: string) => Promise<boolean>;

export interface TuiTerminalInput {
  readonly isTTY: boolean;
  readonly isRaw: boolean;
  readonly setRawMode?: (mode: boolean) => void;
  on(event: "data", listener: (chunk: Buffer | string) => void): void;
  off(event: "data", listener: (chunk: Buffer | string) => void): void;
  pause(): void;
}

export interface TuiTerminalOutput {
  readonly isTTY: boolean;
  readonly columns: number;
  readonly rows: number;
  readonly imageCapabilities?: ImageCapabilities;
  write(text: string): boolean;
  on(event: "resize", listener: () => void): void;
  off(event: "resize", listener: () => void): void;
}

export async function startTui(args: readonly string[], client: TuiClient, dependencies: TuiDependencies = {}): Promise<{ exitCode: 0 | 2; body: unknown }> {
  return startTuiWithTerminal(args, client, processStdin, processStdout, dependencies);
}

export async function startTuiWithTerminal(
  args: readonly string[],
  client: TuiClient,
  terminalInput: TuiTerminalInput,
  terminalOutput: TuiTerminalOutput,
  dependencies: TuiDependencies = {},
): Promise<{ exitCode: 0 | 2; body: unknown }> {
  const stdin = terminalInput;
  const stdout = terminalOutput;
  const imageCapabilities = stdout.imageCapabilities ?? detectImageCapabilities(stdout);
  if (!stdin.isTTY || !stdout.isTTY) return { exitCode: 2, body: "TUI requires an interactive terminal (stdin/stdout must be TTYs)" };
  if (!hasSupportedTerminalWidth(stdout.columns)) return { exitCode: 2, body: "TUI requires a terminal at least 20 columns wide" };
  const settings = parseSettings(args);
  const mainSessionId = option(args, "--session") ?? `tui-${Date.now()}`;
  let sessionId = mainSessionId;
  const readlineInput = new PassThrough();
  const readlineOutput = new ReadlineOutputCapture(stdout);
  const readline = createInterface({ input: readlineInput, output: readlineOutput, terminal: true, historySize: 0 });
  readline.setPrompt(activeInputPrompt());
  let interaction = createTuiInteractionState();
   let boards: readonly PromptBoard[] = [];
    let sessionEvents: readonly DurableEvent[] = [];
  const sessionEventCache: SessionEventCache = new Map();
  let sessionSwitchGeneration = 0;
  let snapshotApplied = false;
    let historyMode: HistoryFollowMode = "follow";
  let consolePrompt = "";
  let consolePromptId: string | undefined;
  let imagePreview: ImagePreview | undefined;
  let imagePreviewPath: string | undefined;
  let imageRenderGeneration = 0;
  const imagePainter = createDeferredImagePainter(setTimeout, clearTimeout);
  const activeKittyPlacements = new Map<string, ActiveKittyPlacement>();
  let nextKittyGraphicId = 1;
  let usedKittyGraphics = false;
  let previousImageRect: { row: number; rows: number; columns: number } | undefined;
  let imageArchived = false;
  let browsingArchivedImage = false;
   let inputHistoryIndex = -1;
   let promptCursorColumn: number | undefined;
   let lastHitBoxes: readonly HarnessHitBox[] = [];
  let lastChartHitBoxes: readonly ChartScreenHitBox[] = [];
  let chartHoverTarget: ChartHoverTarget | undefined;
  let lastPointerPosition: ChartPointerPosition | undefined;
  let lastLinkBoxes: readonly TerminalLinkHitBox[] = [];
  let lastSelectableLines: readonly string[] = [];
    let lastSelectableRows: readonly SelectableRow[] = [];
  let firstSelectableRow = 1;
  let lastOverlayButtons: readonly OverlayButton[] = [];
    let lastHistory: RenderedPromptHistory = { text: "", lines: [], selectableRows: [], lineOwners: [], hitBoxes: [], linkBoxes: [], totalRows: 0, maxScrollOffset: 0 };
  let copyNotice: string | undefined;
  let copyNoticeTimer: ReturnType<typeof setTimeout> | undefined;
  let pendingPermission: TuiPermissionRequest | undefined;
  let queuedPermissions: TuiPermissionRequest[] = [];
  let permissionSelected: PermissionChoice = "allow-once";
  let permissionInput = "";
  let pendingBoardUpdate = false;
  let locallyResolvedPermissionAdmissions = new Set<string>();
  const localSubmissionIds = new Map<string, Set<string>>();
  let queuedExecutionInput = "";
  let queuedExecutionMouseInput = "";
   let permissionCard: PermissionCard | undefined;
    let activeThinking: ThinkingAnimation | undefined;
    let thinkingStatus: string | undefined;
     let thinkingActive = false;
     let thinkingGeneration = 0;
    let transientNotice: string | undefined;
    let transientNoticeTimer: ReturnType<typeof setTimeout> | undefined;
    let linkRequestGeneration = 0;
   let overlay: "help" | "settings" | "agents" | undefined;
   let liveAgents: readonly LiveBackgroundAgent[] = [];
  const latexRasterCache = new Map<string, Promise<LatexRasterGraphic | undefined>>();
  const latexRasterResults = new Map<string, LatexRasterGraphic>();
  let latexGraphicGeneration = 0;
  const chartRasterCache = new Map<string, Promise<RasterGraphic | undefined>>();
  const chartRasterResults = new Map<string, RasterGraphic>();
  let chartGraphicGeneration = 0;
  let terminalCellPixels: TerminalCellPixelSize = { width: 8, height: 16 };
  let requestLatexRedraw: () => void = () => undefined;
  const executionController = new AbortController();
  const decoder = new StringDecoder("utf8");
  let pendingShiftEnterInput = "";
    const updateBoards = (nextSessionEvents: readonly DurableEvent[]): boolean => {
       const changed = nextSessionEvents.length !== sessionEvents.length || nextSessionEvents.at(-1)?.id !== sessionEvents.at(-1)?.id;
        if (changed) {
           sessionEvents = [...nextSessionEvents];
           boards = promptBoards(sessionEvents, sessionId);
           const localIds = localSubmissionIds.get(sessionId);
           if (localIds !== undefined) {
             for (const promptId of localIds) {
               const board = boards.find((candidate) => candidate.promptId === promptId);
               if (board !== undefined && promptBoardStatus(board) !== "running") localIds.delete(promptId);
             }
             if (localIds.size === 0) localSubmissionIds.delete(sessionId);
           }
         chartGraphicGeneration += 1;
          chartRasterCache.clear();
          chartRasterResults.clear();
       }
        return changed;
     };
  const availableImageRows = (): number => {
     const width = terminalWidth();
    const screenRows = Math.max(1, Math.floor(stdout.rows ?? 24));
    const header = headerLines(settings, sessionId, width);
    const promptLines = shouldRenderSubmittedPrompt(consolePromptId, boards)
      ? renderConsolePrompt(consolePrompt, width)
      : [];
    const requestedInputRows = pendingPermission !== undefined ? 0 : inputAreaLines(readline.line, width);
    const inputRows = layoutRows(screenRows, header.length, promptLines.length, requestedInputRows, 0, TUI_FOOTER_ROWS).inputRows;
    return Math.max(1, screenRows - header.length - promptLines.length - inputRows - TUI_FOOTER_ROWS - 1);
  };
   const visibleImageRows = (): number => visibleImagePreviewRows(imagePreview, readline.line, pendingPermission !== undefined || copyNotice !== undefined || !shouldShowImagePreview(imageArchived, browsingArchivedImage));
   const historyViewportRows = (): number => {
     const width = terminalWidth();
     const header = headerLines(settings, sessionId, width);
     const promptLines = shouldRenderSubmittedPrompt(consolePromptId, boards) ? renderConsolePrompt(consolePrompt, width) : [];
     const requestedInputRows = pendingPermission !== undefined ? 0 : inputAreaLines(readline.line, width);
     return layoutRows(Math.max(1, Math.floor(stdout.rows ?? 24)), header.length, promptLines.length, requestedInputRows, visibleImageRows(), TUI_FOOTER_ROWS).viewportRows;
   };
   const commitScreen = (): void => {
    if (!tuiActive) return;
    imagePainter.cancel();
     const width = terminalWidth();
  const imageProtocol = selectImageProtocol(imageCapabilities, process.env.TERM_PROGRAM);
    const screenRows = Math.max(1, Math.floor(stdout.rows ?? 24));
    const header = headerLines(settings, sessionId, width);
       const promptLines = shouldRenderSubmittedPrompt(consolePromptId, boards)
         ? renderConsolePrompt(consolePrompt, width)
         : [];
      const requestedInputRows = pendingPermission !== undefined ? 0 : inputAreaLines(readline.line, width);
      const imageRows = visibleImageRows();
      const usage = summarizeTokenUsage(sessionEvents, settings.contextWindow);
      const statusBar = renderStatusBar(dependencies.workingDirectory ?? process.cwd(), usage, width);
        const activity = selectActivityFeedback(thinkingStatus, transientNotice, chartHoverTarget, width);
       const footer = [panelLine(singleLineText(activity), width, ansi.amber, ansi.detailsBackground), statusBar];
      const { inputRows, viewportRows } = layoutRows(screenRows, header.length, promptLines.length, requestedInputRows, imageRows, footer.length);
    const historyHeaderRows = header.length + promptLines.length;
      lastHistory = renderPromptHistory(boards, interaction, width, viewportRows, historyHeaderRows);
      const navigation = reconcileHistoryNavigation(interaction, historyMode, lastHistory.totalRows, viewportRows);
      if (navigation.state.scrollOffset !== interaction.scrollOffset) {
        interaction = navigation.state;
        lastHistory = renderPromptHistory(boards, interaction, width, viewportRows, historyHeaderRows);
      } else interaction = navigation.state;
    lastHitBoxes = lastHistory.hitBoxes;
    lastLinkBoxes = lastHistory.linkBoxes;
    firstSelectableRow = header.length + 1;
    lastSelectableLines = [...promptLines, ...lastHistory.lines];
    lastSelectableRows = [...promptLines.map(() => true), ...lastHistory.selectableRows];
    const renderedPromptLines = promptLines.map((line, index) => interaction.selection === undefined ? line : renderSelectedLine(line, interaction.selection, firstSelectableRow + index, true));
         const agentPanel = overlay === "agents" ? renderAgentsPanel(mainSessionId, liveAgents, "idle", width) : undefined;
         const overlayRender = overlay === "help" ? renderHelp(width) : overlay === "settings" ? renderSettings(settings, width) : agentPanel;
         const clippedOverlay = overlayRender === undefined ? undefined : clipOverlayRender(overlayRender, viewportRows);
         const overlayLines = clippedOverlay?.lines;
       const historyLines = overlayLines === undefined ? lastHistory.text.length === 0 ? [] : lastHistory.text.split("\n") : [...overlayLines];
       const plainLines = lastHistory.lines.map((line) => line.replace(ansiSequence, ""));
       lastChartHitBoxes = overlayLines === undefined && copyNotice === undefined && pendingPermission === undefined
         ? deriveChartHitBoxes(lastHistory.lines, boards.flatMap((board) => board.events), width, historyHeaderRows, screenRows)
         : [];
        chartHoverTarget = reconcileChartHoverAtPointer(chartHoverTarget, lastPointerPosition, lastChartHitBoxes).target;
        footer[0] = panelLine(singleLineText(selectActivityFeedback(thinkingStatus, transientNotice, chartHoverTarget, width)), width, ansi.amber, ansi.detailsBackground);
       if (overlayLines !== undefined) {
        lastHitBoxes = [];
        lastLinkBoxes = [];
        lastSelectableLines = [...promptLines];
        lastSelectableRows = promptLines.map(() => true);
      }
        lastOverlayButtons = clippedOverlay === undefined
          ? []
          : offsetOverlayButtons(clippedOverlay.buttons, header.length + promptLines.length);
      const imageLines = Array.from({ length: imageRows }, () => "");
     const bodyLines = [...header, ...renderedPromptLines, ...historyLines, ...imageLines, ...Array.from({ length: inputRows }, () => "")];
      let screenLines = [...pinFooters(bodyLines, footer, screenRows)];
     if (copyNotice !== undefined) {
       const popup = renderCopyPopup(copyNotice, width);
       const top = Math.max(0, Math.floor(((stdout.rows ?? 24) - popup.length) / 2));
       for (const [index, line] of popup.entries()) {
         if (top + index >= screenRows - 1) continue;
         const left = " ".repeat(Math.max(0, Math.floor((width - visibleWidth(line)) / 2)));
         screenLines[top + index] = `${left}${line}`;
       }
      }
      if (pendingPermission !== undefined) {
        const localCard = renderPermissionCard(pendingPermission, width, permissionSelected);
        const top = Math.max(0, Math.floor(((stdout.rows ?? 24) - localCard.lines.length) / 2));
         const left = Math.max(0, Math.floor((width - visibleWidth(localCard.lines[0] ?? "")) / 2));
          permissionCard = { ...localCard, buttons: visiblePermissionButtons(offsetPermissionButtons(localCard.buttons, top, left), screenRows) };
         for (const [index, line] of localCard.lines.entries()) {
           if (top + index >= screenRows - 1) continue;
           const lineLeft = " ".repeat(Math.max(0, Math.floor((width - visibleWidth(line)) / 2)));
           screenLines[top + index] = `${lineLeft}${line}`;
         }
     } else permissionCard = undefined;
            let frame = pendingPermission !== undefined ? "\x1b[?25l" : "\x1b[?25h";
          if (imageProtocol !== "kitty" && previousImageRect !== undefined) {
           const spaces = " ".repeat(Math.max(1, previousImageRect.columns));
           for (let row = previousImageRect.row; row < previousImageRect.row + previousImageRect.rows; row += 1) frame += `\x1b[${row};1H${spaces}`;
         }
         previousImageRect = undefined;
            const inputRow = Math.max(1, screenRows - footer.length - inputRows + 1);
              const graphicPlacements: Array<{ key: string; row: number; column: number; graphic: RasterGraphic; fallbackMasks: readonly { row: number; column: number; width: number }[] }> = [];
              const nativeGraphicsAllowed = overlayLines === undefined && copyNotice === undefined && pendingPermission === undefined && (imageProtocol === "kitty" || imageProtocol === "iterm2");
             if (nativeGraphicsAllowed) {
                 const startLatexGraphicRender = (key: string, segment: LatexGraphicSegment, maxColumns: number, maxRows: number): void => {
                    if (latexRasterCache.has(key)) return;
                   const generation = latexGraphicGeneration;
                    const startedPromise = renderLatexGraphic(segment, maxColumns, maxRows, terminalCellPixels.width, terminalCellPixels.height);
                    latexRasterCache.set(key, startedPromise);
                    void startedPromise.then((graphic) => {
                      if (tuiActive && generation === latexGraphicGeneration && shouldApplyGraphicRender(latexRasterCache, key, startedPromise, graphic)) {
                        latexRasterResults.set(key, graphic);
                        requestLatexRedraw();
                      }
                    });
                 };
                  const segments = boards.flatMap((board) => nativeLatexGraphicCandidates(board.assistant).map(({ segment, occurrence, fallback, linePrefix, lineSuffix, uniqueContext }) => ({ segment, promptId: board.promptId, occurrence, fallback, linePrefix, lineSuffix, uniqueContext })));
      const visibleSegments = visibleLatexFallbackSurfaces(segments.flatMap((segment) => !segment.uniqueContext ? [] : [{ value: segment, fallback: segment.fallback, linePrefix: segment.linePrefix, lineSuffix: segment.lineSuffix, requireUnique: true, owner: segment.promptId }]), plainLines, 8, lastHistory.lineOwners);
                 for (const { value: { segment, promptId, occurrence }, fallback, surface } of visibleSegments) {
                    const column = surface.cellColumns[0] ?? 1;
                  const maxColumns = Math.max(1, width - column - 1);
                   const maxRows = latexGraphicRowBudget(surface);
                   const key = latexGraphicRenderKey(segment, maxColumns, maxRows, terminalCellPixels.width, terminalCellPixels.height);
                   const graphic = latexRasterResults.get(key);
                  if (graphic === undefined) {
                   startLatexGraphicRender(key, segment, maxColumns, maxRows);
                   continue;
                   }
                    if (!canPlaceLatexGraphic(graphic, fallback, maxColumns)) continue;
                     const fallbackMasks = latexFallbackMasks(fallback, plainLines, surface.row, surface.column, historyHeaderRows + 1);
                       graphicPlacements.push({ key: kittyLatexPlacementKey(promptId, occurrence, key), row: historyHeaderRows + surface.row + 1, column, graphic, fallbackMasks });
                 }
             }
               if (nativeGraphicsAllowed) {
               let chartSearchRow = 0;
               const chartEvents = boards.flatMap((board) => board.events);
               for (const event of chartEvents) {
                 const chart = chartDescriptorForToolEvent(event);
                 const surface = chartForToolEvent(event, width);
                 if (chart === undefined || surface === undefined) continue;
                 let occurrence = 0;
                  let placement: ChartSurfacePlacement | undefined;
                  while ((placement = findChartSurfacePlacement(plainLines, surface.replace(ansiSequence, ""), chartSearchRow)) !== undefined) {
                  const chartPlacement = placement;
                  const chartOccurrence = occurrence++;
                  chartSearchRow = chartPlacement.row + chartPlacement.rows;
                 const column = terminalCellWidth(plainLines[chartPlacement.row]?.slice(0, chartPlacement.column) ?? "") + 1;
                  const maxColumns = Math.max(1, Math.min(chartPlacement.columns, width - column + 1));
                  const key = chartGraphicRenderKey(chart, maxColumns, chartPlacement.rows, terminalCellPixels.width, terminalCellPixels.height);
                  let graphicPromise = chartRasterCache.get(key);
                 if (graphicPromise === undefined) {
                   const generation = chartGraphicGeneration;
                    const startedPromise = renderChartGraphic(chart, maxColumns, chartPlacement.rows, terminalCellPixels.width, terminalCellPixels.height);
                    chartRasterCache.set(key, startedPromise);
                    void startedPromise.then((graphic) => {
                      if (tuiActive && generation === chartGraphicGeneration && shouldApplyGraphicRender(chartRasterCache, key, startedPromise, graphic)) {
                        chartRasterResults.set(key, graphic);
                        requestLatexRedraw();
                      }
                    });
                }
                  const graphic = chartRasterResults.get(key);
                 if (graphic === undefined) continue;
                    const fallbackMasks = chartFallbackMasks(chartPlacement, historyHeaderRows, column);
                     graphicPlacements.push({ key: kittyChartPlacementKey(event.id, chartOccurrence, key), row: historyHeaderRows + chartPlacement.row + 1, column, graphic, fallbackMasks });
                  }
               }
               }
                screenLines = applyGraphicFallbackMasks(screenLines, graphicPlacements.flatMap((placement) => placement.fallbackMasks));
            const preview = imagePreview;
              const graphicPlacementFrame: GraphicPlacement[] = graphicPlacements.map((placement) => ({ key: placement.key, data: placement.graphic.data, row: placement.row, column: placement.column, columns: placement.graphic.columns, rows: placement.graphic.rows }));
            const cursorRestoreRow = inputRows > 0 ? inputRow : Math.max(1, screenRows - footer.length);
           if (preview !== undefined && imageRows > 0) {
             const imageRegionRow = imagePreviewStartRow(header.length, renderedPromptLines.length, historyLines.length);
             const imageRow = imagePreviewContentRow(imageRegionRow, preview);
             if (imageProtocol === "kitty" && preview.kittyData !== undefined) {
                 graphicPlacementFrame.push({ key: kittyPreviewPlacementKey(imagePreviewPath ?? "", preview.kittyData, imageRow, preview.columns, preview.rows), data: preview.kittyData, row: imageRow, column: 1, columns: preview.columns, rows: preview.rows });
              }
             previousImageRect = { row: imageRegionRow, rows: imagePreviewLines(preview), columns: preview.columns };
            }
              frame += reconcileKittyPlacementsBeforePaint(activeKittyPlacements, imageProtocol, graphicPlacementFrame);
             const paintedScreenLines = screenLines.map((line) => canvasLine(line, width));
           frame += `\x1b[2J\x1b[H${paintedScreenLines.join("\n")}`;
           if (inputRows > 0) frame += `\x1b[${inputRow};1H\x1b[2K${canvasLine("", width)}\x1b[${inputRow};1H`;
            if (preview !== undefined && imageRows > 0 && (imageProtocol !== "kitty" || preview.kittyData === undefined)) {
              const imageRegionRow = imagePreviewStartRow(header.length, renderedPromptLines.length, historyLines.length);
              const imageRow = imagePreviewContentRow(imageRegionRow, preview);
              frame += `\x1b[${imageRow};1H\x1b[2K${preview.payload}\x1b[${cursorRestoreRow};1H`;
            }
              const reconciledKittyPlacements = reconcileKittyPlacements(activeKittyPlacements, imageProtocol, graphicPlacementFrame, nextKittyGraphicId);
             frame += reconciledKittyPlacements.frame;
             nextKittyGraphicId = reconciledKittyPlacements.nextId;
             usedKittyGraphics ||= activeKittyPlacements.size > 0;
              if (imageProtocol === "iterm2") frame += placeIterm2Frame(graphicPlacementFrame, cursorRestoreRow);
             else if (inputRows > 0) frame += `\x1b[${inputRow};1H`;
           readlineOutput.discardCaptured();
            if (inputRows > 0 && hasSupportedTerminalWidth(stdout.columns)) readline.prompt(true);
            const composedFrame = composeReadlineFrame(frame, readlineOutput.takeCaptured(), footerFrame(footer, screenRows, width));
            writeTerminalFrame((text) => stdout.write(text), [imageProtocol === "iterm2" ? synchronizedTerminalFrame(composedFrame) : composedFrame]);
     };
    const frameScheduler = createFrameScheduler(() => {
      if (!tuiActive) return;
      if (pendingBoardUpdate) {
        pendingBoardUpdate = false;
        if (updateBoards(sessionEventsFromCache(sessionEventCache, sessionId))) syncThinking(sessionId);
      }
      commitScreen();
    }, setTimeout, clearTimeout);
     const renderScreen = (): void => {
       if (tuiActive) frameScheduler.request();
     };
     const dismissOverlay = (): void => {
       if (overlay === undefined) return;
       overlay = undefined;
       liveAgents = [];
       lastOverlayButtons = [];
       renderScreen();
     };
  requestLatexRedraw = renderScreen;
     const updateThinking = (status: string | undefined, active: boolean): void => {
       thinkingStatus = status;
       thinkingActive = active;
       if (tuiActive) stdout.write(activityFooterFrame(selectActivityFeedback(thinkingStatus, transientNotice, chartHoverTarget, terminalWidth()), active, Math.max(1, Math.floor(stdout.rows ?? 24)), terminalWidth()));
     };
     const localSubmissionPending = (targetSessionId: string): boolean => (localSubmissionIds.get(targetSessionId)?.size ?? 0) > 0;
     const executionActiveFor = (targetSessionId: string): boolean => {
       const targetBoards = targetSessionId === sessionId ? boards : promptBoards(sessionEventsFromCache(sessionEventCache, targetSessionId), targetSessionId);
       return sessionHasPendingExecution(targetBoards, localSubmissionPending(targetSessionId));
     };
      const stopDisplayedThinking = (): void => {
        thinkingGeneration += 1;
        activeThinking?.stop();
        activeThinking = undefined;
        thinkingStatus = undefined;
        thinkingActive = false;
     };
     const syncThinking = (targetSessionId: string, restart = false): void => {
       if (targetSessionId !== sessionId) return;
       if (!executionActiveFor(targetSessionId) || !settings.thinking) {
         stopDisplayedThinking();
         return;
       }
       if (!restart && activeThinking !== undefined) return;
       stopDisplayedThinking();
       const generation = ++thinkingGeneration;
       activeThinking = startThinkingAnimation((status, active) => {
         if (generation !== thinkingGeneration || !tuiActive || sessionId !== targetSessionId) return;
         updateThinking(status, active);
       });
     };
    const showTransientNotice = (message: string): void => {
     transientNotice = terminalText(message);
     if (transientNoticeTimer !== undefined) clearTimeout(transientNoticeTimer);
     transientNoticeTimer = setTimeout(() => {
       transientNotice = undefined;
       transientNoticeTimer = undefined;
       if (tuiActive) renderScreen();
     }, 1800);
      renderScreen();
    };
    const switchSession = (targetSessionId: string): void => {
      chartHoverTarget = undefined;
      lastChartHitBoxes = [];
     if (targetSessionId === sessionId) {
       overlay = undefined;
       liveAgents = [];
       renderScreen();
       return;
     }
     const requestGeneration = ++sessionSwitchGeneration;
     sessionId = targetSessionId;
     overlay = undefined;
     liveAgents = [];
     interaction = createTuiInteractionState();
     historyMode = "follow";
     inputHistoryIndex = -1;
     consolePrompt = "";
     consolePromptId = undefined;
     imagePreview = undefined;
     imagePreviewPath = undefined;
     imageArchived = false;
     browsingArchivedImage = false;
     imageRenderGeneration += 1;
     latexGraphicGeneration += 1;
     latexRasterCache.clear();
     latexRasterResults.clear();
     chartGraphicGeneration += 1;
     chartRasterCache.clear();
     chartRasterResults.clear();
      lastOverlayButtons = [];
     stopDisplayedThinking();
     activeThinking = undefined;
     thinkingStatus = undefined;
     thinkingActive = false;
     const cachedEvents = sessionEventsFromCache(sessionEventCache, targetSessionId);
      sessionEvents = [];
      boards = [];
      updateBoards(cachedEvents);
      syncThinking(targetSessionId);
      renderScreen();
     void client.subscribe(targetSessionId).then((snapshot) => {
       const merged = mergeSessionEventCache(sessionEventCache, targetSessionId, snapshot);
       if (tuiActive && isCurrentSessionSwitch(sessionSwitchGeneration, requestGeneration) && sessionId === targetSessionId) {
         updateBoards(merged);
         renderScreen();
       }
     }, () => {
       if (tuiActive && isCurrentSessionSwitch(sessionSwitchGeneration, requestGeneration) && sessionId === targetSessionId) showTransientNotice("Unable to subscribe to session.");
     });
   };
  const showCopyNotice = (message: string): void => {
    copyNotice = message;
    if (copyNoticeTimer !== undefined) clearTimeout(copyNoticeTimer);
    copyNoticeTimer = setTimeout(() => {
      copyNotice = undefined;
      copyNoticeTimer = undefined;
      if (tuiActive) renderScreen();
    }, 1800);
    renderScreen();
  };
    const scrollToLatest = (): void => {
     chartHoverTarget = undefined;
     lastChartHitBoxes = [];
     browsingArchivedImage = false;
    historyMode = "follow";
    interaction = reconcileHistoryNavigation(interaction, historyMode, lastHistory.totalRows, historyViewportRows()).state;
  };
   let pendingMouseInput = "";
   let pendingTerminalCellPixels = "";
   let escapeTimer: ReturnType<typeof setTimeout> | undefined;
   let mouseAnchor: SelectionPoint | undefined;
   let cancelClick = false;
   let harnessPressHandled = false;
    let overlayPressButton: OverlayButton | undefined;
    let overlayPressDragged = false;
   let permissionPressHandled = false;
  let tuiActive = true;
  let removeEvents = (): void => {};
  let removePermissions = (): void => {};
        const onResize = (): void => {
         if (!tuiActive) return;
         chartHoverTarget = undefined;
         lastChartHitBoxes = [];
         latexGraphicGeneration += 1;
  latexRasterCache.clear();
  latexRasterResults.clear();
         chartGraphicGeneration += 1;
  chartRasterCache.clear();
  chartRasterResults.clear();
        linkRequestGeneration += 1;
        stdout.write("\x1b[16t");
        const path = imagePreviewPath;
      const generation = ++imageRenderGeneration;
      imagePreview = undefined;
      renderScreen();
       if (path === undefined) return;
 void renderImage(path, availableImageRows(), terminalCellPixels).then((preview) => {
        if (tuiActive && generation === imageRenderGeneration && path === imagePreviewPath) {
         imagePreview = preview;
          renderScreen();
        }
      });
  };
    const settlePermission = (decision: TuiPermissionDecision): void => {
      const pending = pendingPermission;
      if (pending === undefined) return;
      const transition = transitionPermissionQueue(pending, queuedPermissions, decision, locallyResolvedPermissionAdmissions);
      locallyResolvedPermissionAdmissions = new Set(transition.resolvedAdmissions);
      pendingPermission = undefined;
     permissionInput = "";
     permissionCard = undefined;
      void client.respondPermission(pending.requestId, decision).catch(() => undefined);
      queuedPermissions = [...transition.queued];
      const nextPermission = queuedPermissions.shift();
     if (nextPermission !== undefined) pendingPermission = nextPermission;
     if (tuiActive) {
          renderScreen();
        syncThinking(sessionId, true);
    }
  };
    const rejectPendingPermissions = (feedback: string): void => {
     const pending = pendingPermission;
     pendingPermission = undefined;
      if (pending !== undefined) void client.respondPermission(pending.requestId, { decision: "reject", feedback }).catch(() => undefined);
      for (const queued of queuedPermissions) void client.respondPermission(queued.requestId, { decision: "reject", feedback }).catch(() => undefined);
     queuedPermissions = [];
   };
   const handlePermissionToken = (input: string): void => {
     if (pendingPermission === undefined) return;
     if (input === "\x1b[A" || input === "\x1bOA") { permissionSelected = permissionDecisionForKey("ArrowUp", permissionSelected) ?? permissionSelected; renderScreen(); return; }
     if (input === "\x1b[B" || input === "\x1bOB") { permissionSelected = permissionDecisionForKey("ArrowDown", permissionSelected) ?? permissionSelected; renderScreen(); return; }
     if (input === "\x1b[D" || input === "\x1bOD") { permissionSelected = permissionDecisionForKey("ArrowLeft", permissionSelected) ?? permissionSelected; renderScreen(); return; }
     if (input === "\x1b[C" || input === "\x1bOC") { permissionSelected = permissionDecisionForKey("ArrowRight", permissionSelected) ?? permissionSelected; renderScreen(); return; }
    if (input === "\x1b") { settlePermission({ decision: "reject" }); return; }
     if (input === "\r" || input === "\n" || input === "\r\n") {
      const suggestion = parsePermissionSuggestion(permissionInput);
      settlePermission(suggestion === undefined ? { decision: permissionSelected } : { decision: "reject", feedback: suggestion });
      return;
    }
     if (/^[123aA]$/.test(input)) { const choice = permissionDecisionForKey(input, permissionSelected); if (choice !== undefined) settlePermission({ decision: choice }); return; }
     if (input.length > 0 && /[\x20-\x7e]/.test(input)) { permissionInput = `${permissionInput}${input}`.slice(0, 180); renderScreen(); }
   };
    const handlePermissionInput = (input: string): string => {
      const tokens = permissionInputTokens(input);
      for (let index = 0; index < tokens.length; index += 1) {
        if (pendingPermission === undefined) return tokens.slice(index).join("").replace(/^(?:\r\n|\r|\n)+/, "");
        handlePermissionToken(tokens[index] ?? "");
      }
      return "";
    };
    const handleBufferedPermissionMouse = (input: string): void => {
      for (const mouse of parseMouseEvents(input)) {
        if (pendingPermission === undefined) {
          if (permissionPressHandled && mouse.action === "release" && mouse.button === 0) permissionPressHandled = false;
          continue;
        }
        const choice = permissionCard === undefined ? undefined : permissionMouseChoice(mouse.action, mouse.button, mouse.row, mouse.column, permissionCard.buttons);
        if (choice !== undefined) {
          permissionPressHandled = true;
          settlePermission({ decision: choice });
        }
      }
    };
   const shutdownRequestErrors: unknown[] = [];
   const runShutdownRequestStep = (step: () => void): void => {
     try {
       step();
     } catch (error) {
       shutdownRequestErrors.push(error);
     }
   };
    const requestShutdown = (): void => {
      if (!tuiActive) return;
      tuiActive = false;
      runShutdownRequestStep(() => { readline.write(null, { name: "return" }); });
      const sessionsToCancel = new Set<string>(localSubmissionIds.keys());
     for (const [targetSessionId, events] of sessionEventCache) {
       runShutdownRequestStep(() => {
         if (hasDurablePendingPrompt(promptBoards(events, targetSessionId))) sessionsToCancel.add(targetSessionId);
       });
     }
     for (const targetSessionId of sessionsToCancel) {
       runShutdownRequestStep(() => { void client.cancel(targetSessionId).catch(() => undefined); });
     }
     runShutdownRequestStep(() => executionController.abort());
     imageRenderGeneration += 1;
     latexGraphicGeneration += 1;
  latexRasterCache.clear();
  latexRasterResults.clear();
     chartGraphicGeneration += 1;
  chartRasterCache.clear();
  chartRasterResults.clear();
     pendingMouseInput = "";
     pendingTerminalCellPixels = "";
    queuedExecutionInput = "";
    queuedExecutionMouseInput = "";
    if (escapeTimer !== undefined) {
      clearTimeout(escapeTimer);
      escapeTimer = undefined;
    }
     runShutdownRequestStep(() => rejectPendingPermissions("TUI interrupted"));
      runShutdownRequestStep(stopDisplayedThinking);
    if (copyNoticeTimer !== undefined) {
      clearTimeout(copyNoticeTimer);
      copyNoticeTimer = undefined;
    }
     if (transientNoticeTimer !== undefined) {
       clearTimeout(transientNoticeTimer);
       transientNoticeTimer = undefined;
     }
      runShutdownRequestStep(frameScheduler.cancel);
      runShutdownRequestStep(imagePainter.cancel);
     latexGraphicGeneration += 1;
  latexRasterCache.clear();
  latexRasterResults.clear();
     chartGraphicGeneration += 1;
  chartRasterCache.clear();
  chartRasterResults.clear();
   };
   const abortSignal = dependencies.signal;
   const onAbort = (): void => requestShutdown();
   abortSignal?.addEventListener("abort", onAbort, { once: true });
   if (abortSignal?.aborted) requestShutdown();
   const replacePromptDraft = (line: string, cursor: number): void => {
    if (!Reflect.set(readline, "line", line) || !Reflect.set(readline, "cursor", cursor)) throw new Error("Unable to update prompt draft");
  };
  const insertPromptLineBreak = (): void => {
    const cursor = Math.max(0, Math.min(readline.line.length, readline.cursor));
    replacePromptDraft(`${readline.line.slice(0, cursor)}\n${readline.line.slice(cursor)}`, cursor + 1);
  };
  const dispatchPromptReadlineInput = (input: string): string => {
    const split = splitReadlineInput(input);
    const history = sessionInputHistory(sessionEvents);
    const historyKey = inputHistoryDirection(split.line);
    const horizontalKey = horizontalPromptCursorKey(split.line);
    const direction = shouldNavigateInputHistory(readline.line, history, inputHistoryIndex) ? historyKey : undefined;
    if (split.line.includes(shiftEnterMarker) || readline.line.includes("\n")) {
      promptCursorColumn = undefined;
      inputHistoryIndex = -1;
      const submits = /(?:\r\n|\r|\n)$/.test(split.line);
      const editableInput = submits ? split.line.replace(/(?:\r\n|\r|\n)$/, "") : split.line;
      const parts = editableInput.split(shiftEnterMarker);
      for (const [index, part] of parts.entries()) {
        if (part.length > 0) readlineInput.write(sanitizeReadlineInput(part));
        if (index < parts.length - 1) insertPromptLineBreak();
      }
      if (submits) readline.write(null, { name: "return" });
      renderScreen();
    } else if (horizontalKey !== undefined) {
      promptCursorColumn = undefined;
      inputHistoryIndex = -1;
      readline.write(null, { name: horizontalKey });
      renderScreen();
    } else if (historyKey !== undefined) {
      let historyConsumed = false;
      if (direction === undefined) {
        inputHistoryIndex = -1;
      } else {
        const navigation = navigateInputHistory(history, inputHistoryIndex, direction);
        if (navigation.consumed) {
          historyConsumed = true;
          inputHistoryIndex = navigation.index;
          promptCursorColumn = undefined;
          replacePromptDraft(navigation.value, navigation.value.length);
          renderScreen();
        }
      }
      if (!historyConsumed) {
        const navigation = navigatePromptCursor(readline.line, readline.cursor, historyKey, stdout.columns, promptCursorColumn);
        promptCursorColumn = navigation.preferredColumn;
        const key = navigation.cursor < readline.cursor ? "left" : "right";
        for (let remaining = Math.abs(navigation.cursor - readline.cursor); navigation.moved && remaining > 0 && readline.cursor !== navigation.cursor; remaining -= 1) {
          const previousCursor = readline.cursor;
          readline.write(null, { name: key });
          if (readline.cursor === previousCursor) break;
        }
        if (navigation.moved) renderScreen();
      }
    } else {
      promptCursorColumn = undefined;
      if (split.line.length > 0) inputHistoryIndex = -1;
      readlineInput.write(sanitizeReadlineInput(split.line));
      if (split.line.length > 0) { scrollToLatest(); renderScreen(); }
    }
    return split.remainder;
  };
   const onMouseData = (chunk: Buffer | string): void => {
    const decoded = typeof chunk === "string" ? chunk : decoder.write(chunk);
    const cellPixels = consumeTerminalCellPixelResponses(pendingTerminalCellPixels, decoded);
    pendingTerminalCellPixels = cellPixels.pending;
     const shiftedInput = prepareShiftEnterInput(pendingShiftEnterInput, cellPixels.input);
     pendingShiftEnterInput = shiftedInput.pending;
     let decodedChunk = shiftedInput.input;
    const reportedCellPixels = cellPixels.cellPixels;
    if (reportedCellPixels !== undefined && (reportedCellPixels.width !== terminalCellPixels.width || reportedCellPixels.height !== terminalCellPixels.height)) {
      terminalCellPixels = reportedCellPixels;
       latexGraphicGeneration += 1;
  latexRasterCache.clear();
  latexRasterResults.clear();
        chartGraphicGeneration += 1;
  chartRasterCache.clear();
  chartRasterResults.clear();
        const path = imagePreviewPath;
        const generation = ++imageRenderGeneration;
        imagePreview = undefined;
        if (path !== undefined) void renderImage(path, availableImageRows(), terminalCellPixels).then((preview) => {
          if (tuiActive && generation === imageRenderGeneration && path === imagePreviewPath) {
            imagePreview = preview;
            renderScreen();
          }
        });
        if (tuiActive) renderScreen();
    }
     if (containsInterrupt(decodedChunk) || containsQuitSubmission(decodedChunk)) { requestShutdown(); return; }
     const prepared = prepareMouseInput(pendingMouseInput, decodedChunk);
    pendingMouseInput = prepared.pending;
    const input = prepared.mouseInput;
    if (escapeTimer !== undefined && pendingMouseInput !== "\x1b") {
      clearTimeout(escapeTimer);
      escapeTimer = undefined;
    }
    if (pendingMouseInput === "\x1b" && escapeTimer === undefined) {
      escapeTimer = setTimeout(() => {
        escapeTimer = undefined;
        if (pendingMouseInput !== "\x1b") return;
        pendingMouseInput = "";
        const route = routeBareEscape("\x1b", pendingPermission !== undefined, overlay !== undefined);
        if (route === "permission") handlePermissionInput("\x1b");
        else if (route === "overlay") dismissOverlay();
        else if (route === "readline") readlineInput.write("\x1b");
      }, 50);
    }
      let mouseInputForDispatch = input;
       if (pendingPermission !== undefined) queuedExecutionInput += handlePermissionInput(prepared.readlineInput.replaceAll(shiftEnterMarker, ""));
        else {
         queuedExecutionInput += dispatchPromptReadlineInput(prepared.readlineInput);
        if (shouldQueueMouseAfterSubmittedLine(prepared.readlineInput)) {
          const partitioned = splitMouseInputAfterSubmittedLine(prepared.readlineInput, input);
          queuedExecutionMouseInput += partitioned.after;
          mouseInputForDispatch = partitioned.before;
        }
      }
      for (const mouse of parseMouseEvents(mouseInputForDispatch)) {
       const permissionRelease = consumePermissionRelease(permissionPressHandled, mouse);
      permissionPressHandled = permissionRelease.handled;
         if (permissionRelease.consumed) {
           mouseAnchor = undefined;
            overlayPressButton = undefined;
            overlayPressDragged = false;
           continue;
         }
         lastPointerPosition = { row: mouse.row, column: mouse.column };
         const hoverRoute = routeChartHoverMotion(mouse, {
           permissionActive: pendingPermission !== undefined,
           overlayActive: overlay !== undefined,
           selectionDragging: mouseAnchor !== undefined,
         });
         if (pendingPermission !== undefined) {
        if (permissionCard !== undefined) {
          const choice = permissionMouseChoice(mouse.action, mouse.button, mouse.row, mouse.column, permissionCard.buttons);
          if (choice !== undefined) {
            permissionPressHandled = true;
            settlePermission({ decision: choice });
          }
        }
        continue;
      }
        if (mouse.action === "press" && (mouse.button === 64 || mouse.button === 65)) {
          chartHoverTarget = undefined;
          lastChartHitBoxes = [];
          if (overlay !== undefined) {
            overlayPressButton = undefined;
            overlayPressDragged = false;
            continue;
          }
          // A user scroll must win over an auto-follow queued by an earlier event or resize.
          if (imageArchived && mouse.button === 64) browsingArchivedImage = true;
          const navigation = dispatchHistoryWheel(interaction, historyMode, mouse, lastHistory.totalRows, historyViewportRows());
          if (navigation === undefined) continue;
          historyMode = navigation.mode;
          interaction = navigation.state;
          renderScreen();
          const hidArchivedImage = mouse.button === 65 && historyMode === "follow" && browsingArchivedImage;
          if (hidArchivedImage) browsingArchivedImage = false;
          mouseAnchor = undefined;
           overlayPressButton = undefined;
           overlayPressDragged = false;
          if (hidArchivedImage) {
           interaction = reconcileHiddenImageScrollOffset(interaction, lastHistory.maxScrollOffset);
           renderScreen();
         }
         continue;
       }
        if (overlay !== undefined && mouse.action === "press" && mouse.button >= 0 && mouse.button <= 2) {
          chartHoverTarget = undefined;
          lastChartHitBoxes = [];
          overlayPressButton = mouse.button === 0 ? hitTestOverlayButton(mouse.row, mouse.column, lastOverlayButtons) : undefined;
         overlayPressDragged = false;
         mouseAnchor = undefined;
         interaction = clearSelection(interaction);
         continue;
       }
       if (overlay !== undefined && mouse.action === "motion") {
         if (mouse.button === 0 && overlayPressButton !== undefined && (mouse.row !== overlayPressButton.row || mouse.column < overlayPressButton.left || mouse.column > overlayPressButton.right)) overlayPressDragged = true;
         continue;
       }
        if (overlay !== undefined && mouse.action === "release") {
         if (mouse.button === 0 && overlayPressButton !== undefined) {
           const action = activateOverlayButton(overlayPressButton, mouse, overlayPressDragged);
           overlayPressButton = undefined;
           overlayPressDragged = false;
           if (action?.type === "back-to-compose") dismissOverlay();
           else if (action?.type === "session") switchSession(action.sessionId);
         } else {
           overlayPressButton = undefined;
           overlayPressDragged = false;
         }
          continue;
        }
          if (hoverRoute === "eligible") {
            const reconciliation = dispatchChartHoverMotion(chartHoverTarget, lastPointerPosition, lastChartHitBoxes, () => renderScreen());
            chartHoverTarget = reconciliation.target;
            continue;
         }
        if (mouse.button >= 0 && mouse.button <= 2 && mouse.action === "press") {
          cancelClick = interaction.selection !== undefined;
           if (cancelClick) {
            interaction = cancelSelectionOnClick(interaction);
            mouseAnchor = undefined;
            renderScreen();
             continue;
           }
            if (mouse.button === 0) {
            const flows = allHarnessInteractiveItems(boards, interaction.expanded);
            const flowId = hitTestHarnessRow(mouse.row, lastHitBoxes);
            if (flowId !== undefined) {
              interaction = toggleHarnessFlow(interaction, flowId, flows);
              mouseAnchor = undefined;
              harnessPressHandled = true;
              renderScreen();
              continue;
            }
          }
          const width = terminalWidth();
         const header = headerLines(settings, sessionId, width);
         const rowIndex = mouse.row - (header.length + 1);
          if (rowIndex < 0 || rowIndex >= lastSelectableRows.length || lastSelectableRows[rowIndex] === false || lastSelectableRows[rowIndex] === undefined) {
           mouseAnchor = undefined;
           interaction = clearSelection(interaction);
           continue;
         }
         mouseAnchor = { column: mouse.column, row: mouse.row };
        interaction = clearSelection(interaction);
        continue;
      }
       if (mouse.button === 0 && mouse.action === "motion" && mouseAnchor !== undefined) {
        const focus = { column: mouse.column, row: mouse.row };
        if (focus.column !== mouseAnchor.column || focus.row !== mouseAnchor.row) interaction = { ...interaction, selection: { anchor: mouseAnchor, focus } };
        renderScreen();
         continue;
       }
        if (mouse.button !== 0 || mouse.action !== "release") continue;
        if (harnessPressHandled) {
          harnessPressHandled = false;
          mouseAnchor = undefined;
          continue;
        }
        if (cancelClick) {
         cancelClick = false;
         mouseAnchor = undefined;
         continue;
       }
        const click = { column: mouse.column, row: mouse.row };
      const selection = interaction.selection;
      if (selection !== undefined) {
          const copied = restoreLatexSources(
            extractSelection(lastSelectableLines, selection, firstSelectableRow, lastSelectableRows),
            boards.map((board) => board.assistant).join("\n"),
          );
         let copy: Promise<boolean>;
         try {
          copy = dependencies.clipboard === undefined ? writeClipboardText(copied) : dependencies.clipboard(copied);
        } catch {
          copy = Promise.resolve(false);
        }
         void copy.then((ok) => {
            if (tuiActive) showCopyNotice(ok ? "Copied selection to clipboard" : "Unable to copy selection");
          }, () => {
            if (tuiActive) showCopyNotice("Unable to copy selection");
          });
        mouseAnchor = undefined;
        continue;
      }
      mouseAnchor = undefined;
       const link = hitTestTerminalLink(click.row, click.column, lastLinkBoxes);
       if (link !== undefined) {
         const requestGeneration = ++linkRequestGeneration;
          void openTerminalLink(link, dependencies.openBrowser ?? openBrowserUrl).catch(() => {
            if (tuiActive && requestGeneration === linkRequestGeneration) showTransientNotice("Unable to open link.");
          });
        continue;
      }
       const flows = allHarnessInteractiveItems(boards, interaction.expanded);
      const flowId = hitTestHarnessRow(click.row, lastHitBoxes);
      if (flowId !== undefined) {
        interaction = toggleHarnessFlow(interaction, flowId, flows);
        renderScreen();
      }
     }
    };
   const flushQueuedInput = (): void => {
     if (queuedExecutionInput.length === 0) return;
     const buffered = queuedExecutionInput;
     queuedExecutionInput = "";
      queuedExecutionInput += dispatchPromptReadlineInput(buffered);
   };
     const previousRawMode = stdin.isRaw;
    let rawModeEnabled = false;
    let terminalModesSaved = false;
    let primaryFailure: { readonly error: unknown } | undefined;
    try {
    rawModeEnabled = stdin.setRawMode !== undefined;
    stdin.setRawMode?.(true);
    stdin.on("data", onMouseData);
    stdout.on("resize", onResize);
         stdout.write(startTerminalMouseFrame());
         terminalModesSaved = true;
     removeEvents = client.onEvent((event) => {
       cacheSessionEvent(sessionEventCache, event);
       if (event.sessionId !== sessionId) return;
       if (!snapshotApplied) {
         return;
       }
        pendingBoardUpdate = true;
        renderScreen();
     });
     const initialEvents = await client.subscribe(mainSessionId);
     updateBoards(mergeSessionEventCache(sessionEventCache, mainSessionId, initialEvents));
     snapshotApplied = true;
     syncThinking(mainSessionId);
     removePermissions = client.onPermission((request) => {
       if (isPermissionAdmissionLocallyResolved(request, locallyResolvedPermissionAdmissions)) return;
       if (!tuiActive) { void client.respondPermission(request.requestId, { decision: "reject", feedback: "TUI is not active" }).catch(() => undefined); return; }
        stopDisplayedThinking(); interaction = clearSelection(interaction); mouseAnchor = undefined; chartHoverTarget = undefined; lastChartHitBoxes = []; permissionSelected = "allow-once";
      if (pendingPermission === undefined) pendingPermission = request; else queuedPermissions.push(request);
      commitPermissionBeforeBufferedInput(() => frameScheduler.flush(), () => { const buffered = queuedExecutionInput; queuedExecutionInput = ""; const bufferedMouse = queuedExecutionMouseInput; queuedExecutionMouseInput = ""; pendingMouseInput = ""; if (bufferedMouse.length > 0) handleBufferedPermissionMouse(bufferedMouse); if (buffered.length > 0) queuedExecutionInput += handlePermissionInput(buffered); });
    });
      renderScreen();
      for await (const line of readline) {
         if (!tuiActive) break;
         const prompt = line;
         const input = line.trim();
         if (input !== "/help" && input !== "/settings" && input !== "/list_agents") overlay = undefined;
        inputHistoryIndex = -1;
        if (input.length === 0) { flushQueuedInput(); continue; }
        if (input === "/quit" || input === "/exit") { tuiActive = false; break; }
         if (input === "/help") { overlay = "help"; renderScreen(); flushQueuedInput(); continue; }
         if (input === "/settings") { overlay = "settings"; renderScreen(); flushQueuedInput(); continue; }
         if (input === "/list_agents") { try { liveAgents = await client.listAgents(mainSessionId); } catch { liveAgents = []; showTransientNotice("Unable to list background agents."); } overlay = "agents"; renderScreen(); flushQueuedInput(); continue; }
       if (input === "/agent") { settings.agent = settings.agent === "primary" ? "build" : "primary"; renderScreen(); flushQueuedInput(); continue; }
        if (input === "/thinking") { settings.thinking = !settings.thinking; syncThinking(sessionId); renderScreen(); flushQueuedInput(); continue; }
        if (input === "/details") { settings.details = !settings.details; interaction = settings.details ? { ...interaction, expanded: new Set(allHarnessIds(boards)) } : { ...interaction, expanded: new Set() }; renderScreen(); flushQueuedInput(); continue; }
        if (/^\/scroll\s+(up|down|top|bottom)$/.test(input)) {
          const direction = input.slice("/scroll ".length) as "up" | "down" | "top" | "bottom";
          // Command navigation likewise supersedes a deferred automatic tail follow.
          if (imageArchived && (direction === "up" || direction === "top")) browsingArchivedImage = true;
           const navigation = navigateHistory(interaction, historyMode, direction, lastHistory.totalRows, historyViewportRows());
           historyMode = navigation.mode;
           interaction = navigation.state;
           const hidArchivedImage = browsingArchivedImage && historyMode === "follow";
          if (hidArchivedImage) browsingArchivedImage = false;
          renderScreen();
          if (hidArchivedImage) {
            interaction = reconcileHiddenImageScrollOffset(interaction, lastHistory.maxScrollOffset);
            renderScreen();
          }
            if (tuiActive) flushQueuedInput();
         continue;
       }
        if (input.startsWith("/open ")) {
         const requestGeneration = ++linkRequestGeneration;
         const opened = await openTerminalLink(input.slice("/open ".length).trim(), dependencies.openBrowser ?? openBrowserUrl).catch(() => false);
         if (!tuiActive) break;
         if (requestGeneration !== linkRequestGeneration) continue;
          showTransientNotice(opened ? "Link opened." : "Only credential-free http(s) links without query or fragment are allowed.");
       flushQueuedInput();
       continue;
      }
      if (/^\/harness\s+\d+$/.test(input)) {
        const index = Number(input.slice("/harness".length).trim()) - 1;
        const flows = allHarnessInteractiveItems(boards, interaction.expanded);
        const flow = flows[index];
         if (flow !== undefined) { interaction = toggleHarnessFlow(interaction, flow.id, flows); renderScreen(); }
          else showTransientNotice("Unknown harness row.");
         flushQueuedInput();
         continue;
       }
      if (input.startsWith("/model ")) {
        const selected = input.slice("/model ".length).trim();
        const separator = selected.indexOf("/");
        if (separator > 0 && separator < selected.length - 1) { settings.provider = selected.slice(0, separator); settings.model = selected.slice(separator + 1); }
        else if (selected.length > 0) settings.model = selected;
        renderScreen(); flushQueuedInput(); continue;
       }
         if (input.startsWith("/image ")) {
          imagePreviewPath = expandHomePath(input.slice("/image ".length).trim());
          const path = imagePreviewPath;
          const generation = ++imageRenderGeneration;
           imagePreview = undefined;
           imageArchived = false;
           browsingArchivedImage = false;
          renderScreen();
 const preview = await renderImage(path, availableImageRows(), terminalCellPixels);
          if (!tuiActive) break;
          if (generation === imageRenderGeneration && path === imagePreviewPath) imagePreview = preview;
         scrollToLatest();
         frameScheduler.flush();
            if (tuiActive) flushQueuedInput();
         continue;
       }
        if (input.startsWith("/")) { showTransientNotice("Unknown command. Use /help."); flushQueuedInput(); continue; }
          const promptId = `tui-${randomUUID()}`;
          const submissionSessionId = sessionId;
          const sessionSubmissions = localSubmissionIds.get(submissionSessionId) ?? new Set<string>();
          const delivery = promptDelivery(boards, sessionSubmissions.size > 0);
          sessionSubmissions.add(promptId);
          localSubmissionIds.set(submissionSessionId, sessionSubmissions);
           consolePrompt = prompt;
          consolePromptId = promptId;
        imageRenderGeneration += 1;
        if (shouldArchiveImagePreview(imagePreviewPath)) imageArchived = true;
         browsingArchivedImage = false;
        historyMode = "follow";
        frameScheduler.flush();
          syncThinking(submissionSessionId, true);
         pendingMouseInput = "";
        if (escapeTimer !== undefined) {
          clearTimeout(escapeTimer);
          escapeTimer = undefined;
        }
         void (async (): Promise<void> => {
           let response: { exitCode: 0 | 2; body: unknown } | undefined;
           try {
              response = await client.submit({ prompt, sessionId: submissionSessionId, promptId, delivery });
           } catch (error) {
             response = { exitCode: 2, body: error instanceof Error ? error.message : "Prompt execution failed" };
           } finally {
             sessionSubmissions.delete(promptId);
             if (sessionSubmissions.size === 0) localSubmissionIds.delete(submissionSessionId);
             if (consolePromptId === promptId) {
               consolePrompt = "";
               consolePromptId = undefined;
             }
             syncThinking(submissionSessionId);
             if (tuiActive && sessionId === submissionSessionId) {
               const previewPath = imagePreviewPath;
               if (previewPath !== undefined) {
                 const previewGeneration = ++imageRenderGeneration;
                 void renderImage(previewPath, availableImageRows(), terminalCellPixels).then((preview) => {
                   if (tuiActive && sessionId === submissionSessionId && previewGeneration === imageRenderGeneration && previewPath === imagePreviewPath) {
                     imagePreview = preview;
                     renderScreen();
                   }
                 });
               }
               renderScreen();
             }
           }
           if (response?.exitCode !== 0 && tuiActive && sessionId === submissionSessionId && !executionActiveFor(submissionSessionId)) {
             showTransientNotice(typeof response.body === "string" ? response.body : JSON.stringify(response.body));
           }
         })();
         flushQueuedInput();
         continue;
    }
   } catch (error) {
     primaryFailure = { error };
   } finally {
     const initialErrors = primaryFailure === undefined
       ? shutdownRequestErrors
       : [primaryFailure.error, ...shutdownRequestErrors];
     runTuiCleanup(
       () => {
         const errors: unknown[] = [];
         const runCleanupStep = (step: () => void): void => {
           try {
             step();
           } catch (error) {
             errors.push(error);
           }
         };
         tuiActive = false;
         runCleanupStep(() => executionController.abort());
         permissionPressHandled = false;
         overlayPressButton = undefined;
         overlayPressDragged = false;
         runCleanupStep(() => rejectPendingPermissions("TUI closed"));
         runCleanupStep(removeEvents);
         runCleanupStep(removePermissions);
         runCleanupStep(stopDisplayedThinking);
         if (copyNoticeTimer !== undefined) runCleanupStep(() => clearTimeout(copyNoticeTimer));
         if (transientNoticeTimer !== undefined) runCleanupStep(() => clearTimeout(transientNoticeTimer));
         runCleanupStep(frameScheduler.cancel);
         runCleanupStep(imagePainter.cancel);
         if (escapeTimer !== undefined) runCleanupStep(() => clearTimeout(escapeTimer));
          runCleanupStep(() => readline.close());
          runCleanupStep(() => abortSignal?.removeEventListener("abort", onAbort));
          runCleanupStep(() => stdin.off("data", onMouseData));
         runCleanupStep(() => stdout.off("resize", onResize));
         runCleanupStep(() => stdin.pause());
         runCleanupStep(() => readlineInput.end());
         if (errors.length === 1) throw errors[0];
         if (errors.length > 1) throw new AggregateError(errors, "TUI cleanup body failed");
       },
      () => {
        if (rawModeEnabled && previousRawMode !== undefined) stdin.setRawMode?.(previousRawMode);
       },
       () => stdout.write(shutdownTerminalFrame(usedKittyGraphics, terminalModesSaved)),
       initialErrors,
     );
  }
  return { exitCode: 0, body: "" };
}

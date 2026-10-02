import { fail, MAX_TOOL_RESULT, redactJson, type Json, type Result } from "../domain.js";
import type { ToolDefinition } from "../runtime.js";

export type ChartKind = "line-chart" | "bar-chart" | "kline-chart" | "heatmap-chart" | "pie-chart";
export interface ChartPoint { label: string; value: number; }
export interface KlineCandle { label: string; open: number; high: number; low: number; close: number; volume: number; }
export interface HeatmapDescriptor { kind: "heatmap-chart"; title: string; rows: readonly string[]; columns: readonly string[]; values: readonly (readonly (number | null)[])[]; }
export interface PieSlice { label: string; value: number; }
export interface LegacyChartDescriptor { kind: "line-chart" | "bar-chart"; title: string; points: readonly ChartPoint[]; }
export interface KlineChartDescriptor { kind: "kline-chart"; title: string; candles: readonly KlineCandle[]; }
export interface PieChartDescriptor { kind: "pie-chart"; title: string; slices: readonly PieSlice[]; }
export type ChartDescriptor = LegacyChartDescriptor | KlineChartDescriptor | HeatmapDescriptor | PieChartDescriptor;
export type ChartToolInput = ChartDescriptor;

const MAX_TITLE = 80;
const MAX_LABEL = 16;
const MAX_POINTS = 64;
const MAX_HEATMAP_ROWS = 24;
const MAX_HEATMAP_COLUMNS = 48;
const MAX_HEATMAP_CELLS = 1024;
const MAX_PIE_SLICES = 32;
const MAX_NUMBER = 1_000_000_000;
const unsafeText = /[\u0000-\u001f\u007f-\u009f\u001b]/;
const kinds: readonly ChartKind[] = ["line-chart", "bar-chart", "kline-chart", "heatmap-chart", "pie-chart"];
const isChartKind = (value: unknown): value is ChartKind => typeof value === "string" && kinds.includes(value as ChartKind);
const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const keys = (value: Record<string, unknown>, allowed: readonly string[]): boolean => Object.keys(value).every((key) => allowed.includes(key));
const text = (value: unknown, maximum: number): value is string => typeof value === "string" && value.length > 0 && value.length <= maximum && !unsafeText.test(value);
const number = (value: unknown, minimum = -MAX_NUMBER, maximum = MAX_NUMBER): value is number => typeof value === "number" && Number.isFinite(value) && value >= minimum && value <= maximum;
const decodePoints = (value: unknown): Result<readonly ChartPoint[]> => {
  if (!Array.isArray(value) || value.length < 2 || value.length > MAX_POINTS) return fail("TOOL_ARGUMENT_INVALID", `points must contain 2-${MAX_POINTS} items`);
  const points: ChartPoint[] = [];
  for (const point of value) { if (!record(point) || !keys(point, ["label", "value"]) || !text(point.label, MAX_LABEL) || !number(point.value)) return fail("TOOL_ARGUMENT_INVALID", "Each point requires a bounded label and finite value"); points.push({ label: point.label, value: point.value }); }
  return { ok: true, value: points };
};
const decodeCandles = (value: unknown): Result<readonly KlineCandle[]> => {
  if (!Array.isArray(value) || value.length < 2) return fail("TOOL_ARGUMENT_INVALID", "candles must contain at least 2 items");
  const candles: KlineCandle[] = [];
  for (const candle of value) { if (!record(candle) || !keys(candle, ["label", "open", "high", "low", "close", "volume"]) || !text(candle.label, MAX_LABEL) || !number(candle.open) || !number(candle.high) || !number(candle.low) || !number(candle.close) || !number(candle.volume, 0) || candle.high < Math.max(candle.open, candle.close) || candle.low > Math.min(candle.open, candle.close)) return fail("TOOL_ARGUMENT_INVALID", "Each candle requires safe OHLCV values with high and low enclosing open and close"); candles.push({ label: candle.label, open: candle.open, high: candle.high, low: candle.low, close: candle.close, volume: candle.volume }); }
  return { ok: true, value: candles };
};
const decodeLabels = (value: unknown, name: string, maximum: number): Result<readonly string[]> => !Array.isArray(value) || value.length < 1 || value.length > maximum || value.some((label) => !text(label, MAX_LABEL)) ? fail("TOOL_ARGUMENT_INVALID", `${name} must contain bounded terminal-safe labels`) : { ok: true, value };
const decodeChart = (input: unknown): Result<ChartToolInput> => {
  if (!record(input) || !text(input.title, MAX_TITLE)) return fail("TOOL_ARGUMENT_INVALID", "title must be a non-empty terminal-safe bounded string");
  if (input.kind === undefined || input.kind === "line-chart" || input.kind === "bar-chart") { if (!keys(input, ["kind", "title", "points"])) return fail("TOOL_ARGUMENT_INVALID", "legacy charts only accept kind, title, and points"); const points = decodePoints(input.points); return points.ok ? { ok: true, value: { kind: input.kind ?? "line-chart", title: input.title, points: points.value } } : points; }
  if (!isChartKind(input.kind)) return fail("TOOL_ARGUMENT_INVALID", "kind must be a supported chart kind");
  if (input.kind === "kline-chart") { if (!keys(input, ["kind", "title", "candles"])) return fail("TOOL_ARGUMENT_INVALID", "kline charts only accept kind, title, and candles"); const candles = decodeCandles(input.candles); return candles.ok ? { ok: true, value: { kind: input.kind, title: input.title, candles: candles.value } } : candles; }
  if (input.kind === "heatmap-chart") { if (!keys(input, ["kind", "title", "rows", "columns", "values"])) return fail("TOOL_ARGUMENT_INVALID", "heatmaps only accept kind, title, rows, columns, and values"); const rows = decodeLabels(input.rows, "rows", MAX_HEATMAP_ROWS); const columns = decodeLabels(input.columns, "columns", MAX_HEATMAP_COLUMNS); if (!rows.ok || !columns.ok || !Array.isArray(input.values) || input.values.length !== rows.value.length || rows.value.length * columns.value.length > MAX_HEATMAP_CELLS) return fail("TOOL_ARGUMENT_INVALID", "values must be a bounded rectangular heatmap"); const values: (number | null)[][] = []; let numeric = false; for (const row of input.values) { if (!Array.isArray(row) || row.length !== columns.value.length) return fail("TOOL_ARGUMENT_INVALID", "values must be rectangular"); const decoded: (number | null)[] = []; for (const cell of row) { if (cell !== null && !number(cell)) return fail("TOOL_ARGUMENT_INVALID", "heatmap values must be finite bounded numbers or null"); numeric ||= cell !== null; decoded.push(cell); } values.push(decoded); } return numeric ? { ok: true, value: { kind: input.kind, title: input.title, rows: rows.value, columns: columns.value, values } } : fail("TOOL_ARGUMENT_INVALID", "heatmap requires at least one numeric value"); }
  if (!keys(input, ["kind", "title", "slices"]) || !Array.isArray(input.slices) || input.slices.length < 1 || input.slices.length > MAX_PIE_SLICES) return fail("TOOL_ARGUMENT_INVALID", `slices must contain 1-${MAX_PIE_SLICES} items`);
  const slices: PieSlice[] = []; let total = 0;
  for (const slice of input.slices) { if (!record(slice) || !keys(slice, ["label", "value"]) || !text(slice.label, MAX_LABEL) || !number(slice.value, 0)) return fail("TOOL_ARGUMENT_INVALID", "Each slice requires a bounded label and nonnegative value"); slices.push({ label: slice.label, value: slice.value }); total += slice.value; }
  return total > 0 ? { ok: true, value: { kind: "pie-chart", title: input.title, slices } } : fail("TOOL_ARGUMENT_INVALID", "pie slices must have a positive total");
};
export const isChartDescriptor = (value: unknown): value is ChartDescriptor => decodeChart(value).ok && record(value) && typeof value.kind === "string";
const chartJson = (chart: ChartDescriptor): Json => {
  switch (chart.kind) {
    case "line-chart": case "bar-chart": return { kind: chart.kind, title: chart.title, points: chart.points.map((point) => ({ label: point.label, value: point.value })) };
    case "kline-chart": return { kind: chart.kind, title: chart.title, candles: chart.candles.map((candle) => ({ ...candle })) };
    case "heatmap-chart": return { kind: chart.kind, title: chart.title, rows: [...chart.rows], columns: [...chart.columns], values: chart.values.map((row) => [...row]) };
    case "pie-chart": return { kind: chart.kind, title: chart.title, slices: chart.slices.map((slice) => ({ ...slice })) };
  }
};
const safeTextPattern = "^[^\\u0000-\\u001f\\u007f-\\u009f\\u001b]+$";
const titleSchema = { type: "string", minLength: 1, maxLength: MAX_TITLE, pattern: safeTextPattern };
const labelSchema = { type: "string", minLength: 1, maxLength: MAX_LABEL, pattern: safeTextPattern };
const numberSchema = { type: "number", minimum: -MAX_NUMBER, maximum: MAX_NUMBER };
const pointSchema = { type: "object", required: ["label", "value"], additionalProperties: false, properties: { label: labelSchema, value: numberSchema } };
const candleSchema = { type: "object", required: ["label", "open", "high", "low", "close", "volume"], additionalProperties: false, properties: { label: labelSchema, open: numberSchema, high: numberSchema, low: numberSchema, close: numberSchema, volume: { type: "number", minimum: 0, maximum: MAX_NUMBER } } };
const heatmapCellSchema = { oneOf: [numberSchema, { type: "null" }] };
const heatmapRowSchema = { type: "array", minItems: 1, maxItems: MAX_HEATMAP_COLUMNS, items: heatmapCellSchema };
const sliceSchema = { type: "object", required: ["label", "value"], additionalProperties: false, properties: { label: labelSchema, value: { type: "number", minimum: 0, maximum: MAX_NUMBER } } };
const chartSchema = (): Record<string, Json> => ({
  type: "object", additionalProperties: false,
  properties: { kind: { type: "string", enum: [...kinds] }, title: titleSchema, points: { type: "array" }, candles: { type: "array" }, rows: { type: "array" }, columns: { type: "array" }, values: { type: "array" }, slices: { type: "array" } },
  oneOf: [
    { type: "object", required: ["title", "points"], additionalProperties: false, properties: { kind: { type: "string", enum: ["line-chart"] }, title: titleSchema, points: { type: "array", minItems: 2, maxItems: MAX_POINTS, items: pointSchema } } },
    { type: "object", required: ["kind", "title", "points"], additionalProperties: false, properties: { kind: { type: "string", const: "bar-chart" }, title: titleSchema, points: { type: "array", minItems: 2, maxItems: MAX_POINTS, items: pointSchema } } },
    { type: "object", required: ["kind", "title", "candles"], additionalProperties: false, properties: { kind: { type: "string", const: "kline-chart" }, title: titleSchema, candles: { type: "array", minItems: 2, items: candleSchema } } },
    { type: "object", required: ["kind", "title", "rows", "columns", "values"], additionalProperties: false, properties: { kind: { type: "string", const: "heatmap-chart" }, title: titleSchema, rows: { type: "array", minItems: 1, maxItems: MAX_HEATMAP_ROWS, items: labelSchema }, columns: { type: "array", minItems: 1, maxItems: MAX_HEATMAP_COLUMNS, items: labelSchema }, values: { type: "array", minItems: 1, maxItems: MAX_HEATMAP_ROWS, items: heatmapRowSchema } } },
    { type: "object", required: ["kind", "title", "slices"], additionalProperties: false, properties: { kind: { type: "string", const: "pie-chart" }, title: titleSchema, slices: { type: "array", minItems: 1, maxItems: MAX_PIE_SLICES, items: sliceSchema } } },
  ],
});
export const chartTool = (): ToolDefinition<ChartToolInput, ChartDescriptor> => ({ advertisement: { name: "render_chart", description: "Render a compact financial chart with line, bar, candlestick, heatmap, or pie data", inputSchema: chartSchema() }, durableResultLimit: MAX_TOOL_RESULT, decode: decodeChart, authorize: () => ({ ok: true, value: undefined }), execute: (input) => JSON.stringify(redactJson(chartJson(input))).length > MAX_TOOL_RESULT ? fail("TOOL_ARGUMENT_INVALID", `chart result must fit within ${MAX_TOOL_RESULT} durable characters`) : { ok: true, value: input }, encode: chartJson });

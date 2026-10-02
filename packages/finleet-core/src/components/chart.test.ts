import assert from "node:assert/strict";
import test from "node:test";
import { MAX_TOOL_RESULT, type Json } from "../domain.js";
import type { ToolContext } from "../runtime.js";
import { chartTool, isChartDescriptor } from "./chart.js";

const encodedKind = (value: unknown): string | undefined => typeof value === "object" && value !== null && !Array.isArray(value) && typeof Object.getOwnPropertyDescriptor(value, "kind")?.value === "string" ? Object.getOwnPropertyDescriptor(value, "kind")?.value : undefined;
type JsonObject = { readonly [key: string]: Json };
const jsonObject = (value: unknown): JsonObject | undefined => typeof value === "object" && value !== null && !Array.isArray(value) ? value as JsonObject : undefined;
const binance24Candles = Array.from({ length: 24 }, (_unused, index) => ({ label: `2026-01-02 ${String(9 + Math.floor(index / 2)).padStart(2, "0")}:${index % 2 === 0 ? "30" : "00"}`, open: 97.125 + index * 0.1875, high: 97.8125 + index * 0.203125, low: 96.9375 + index * 0.15625, close: 97.4375 + index * 0.171875, volume: 12034.567 + index * 137.891 }));
const context: ToolContext = { sessionId: "s", agentId: "a", assistantMessageId: "m", providerCallId: "p", permissions: new Set() };

test("chart descriptor validation rejects malformed or excessive data", () => {
  assert.equal(isChartDescriptor({ kind: "line-chart", title: "FIN", points: [{ label: "only", value: 1 }] }), false);
  assert.equal(isChartDescriptor({ kind: "line-chart", title: "FIN", points: [{ label: "a", value: 1 }, { label: "b", value: Number.NaN }] }), false);
  assert.equal(isChartDescriptor({ kind: "other", title: "FIN", points: [{ label: "a", value: 1 }, { label: "b", value: 2 }] }), false);
  assert.equal(isChartDescriptor({ kind: "line-chart", title: "FIN\nINJECTED", points: [{ label: "a", value: 1 }, { label: "b", value: 2 }] }), false);
  assert.equal(isChartDescriptor({ kind: "line-chart", title: "FIN", points: [{ label: "a\u001b[31m", value: 1 }, { label: "b", value: 2 }] }), false);
});

test("render_chart tool decodes, encodes, and bounds durable descriptors", async () => {
  const tool = chartTool();
  const decoded = tool.decode({ title: "FIN", points: [{ label: "a", value: 1 }, { label: "b", value: 2 }] });
  assert.equal(decoded.ok, true);
  if (!decoded.ok) return;
  const output = await tool.execute(decoded.value, context);
  assert.equal(output.ok, true);
  if (!output.ok) return;
  assert.equal(isChartDescriptor(tool.encode(output.value)), true);
  assert.equal(encodedKind(tool.encode(output.value)), "line-chart");
  const kline = tool.decode({ kind: "kline-chart", title: "BTCUSDT 30m", candles: binance24Candles });
  assert.equal(kline.ok, true);
  if (!kline.ok) return;
  const klineOutput = await tool.execute(kline.value, context);
  assert.equal(klineOutput.ok, true);
  if (!klineOutput.ok) return;
  const encoded = JSON.stringify(tool.encode(klineOutput.value));
  assert.equal(tool.durableResultLimit, MAX_TOOL_RESULT);
  assert.ok(encoded.length > 512 && encoded.length <= MAX_TOOL_RESULT);
});

test("render_chart advertises strict schemas for every chart kind", () => {
  const schema = chartTool().advertisement.inputSchema;
  assert.equal(schema.type, "object");
  assert.equal(schema.additionalProperties, false);
  assert.ok(Array.isArray(schema.oneOf));
  const branches = schema.oneOf.filter((branch): branch is JsonObject => jsonObject(branch) !== undefined);
  assert.deepEqual(branches.map((branch) => jsonObject(branch.properties)?.kind), [{ type: "string", enum: ["line-chart"] }, { type: "string", const: "bar-chart" }, { type: "string", const: "kline-chart" }, { type: "string", const: "heatmap-chart" }, { type: "string", const: "pie-chart" }]);
  for (const branch of branches) assert.equal(branch.additionalProperties, false);
  assert.equal(jsonObject(jsonObject(jsonObject(branches[2]?.properties)?.candles)?.items)?.additionalProperties, false);
  assert.equal(jsonObject(jsonObject(branches[2]?.properties)?.candles)?.maxItems, undefined);
  const heatmapCell = jsonObject(jsonObject(jsonObject(jsonObject(branches[3]?.properties)?.values)?.items)?.items);
  assert.deepEqual(Array.isArray(heatmapCell?.oneOf) ? heatmapCell.oneOf.map((item) => jsonObject(item)?.type) : [], ["number", "null"]);
  assert.equal(jsonObject(jsonObject(jsonObject(branches[4]?.properties)?.slices)?.items)?.additionalProperties, false);
});

test("render_chart kinds decode canonically and reject invalid structures", async () => {
  const tool = chartTool();
  const points = [{ label: "a", value: -2 }, { label: "b", value: 4 }];
  for (const [input, expected] of [[{ title: "FIN", points }, "line-chart"], [{ kind: "line-chart", title: "FIN", points }, "line-chart"], [{ kind: "bar-chart", title: "FIN", points }, "bar-chart"]] as const) {
    const decoded = tool.decode(input);
    assert.equal(decoded.ok, true);
    if (decoded.ok) assert.equal(decoded.value.kind, expected);
  }
  assert.equal(tool.decode({ kind: "scatter-chart", title: "FIN", points }).ok, false);
  assert.equal(tool.decode({ kind: "line-chart", title: "FIN", points, extra: true }).ok, false);
  assert.equal(tool.decode({ kind: "line-chart", title: "FIN", points: [{ label: "a", value: 1, extra: true }, { label: "b", value: 2 }] }).ok, false);
  const kline = { kind: "kline-chart" as const, title: "OHLCV", candles: [{ label: "09:30", open: -2, high: 4, low: -3, close: 3, volume: 10 }, { label: "09:31", open: 3, high: 5, low: 2, close: 4, volume: 12 }] };
  const heatmap = { kind: "heatmap-chart" as const, title: "FLOW", rows: ["Buy", "Sell"], columns: ["A", "B", "C"], values: [[1, null, 3], [-2, 0, 4]] };
  const pie = { kind: "pie-chart" as const, title: "MIX", slices: [{ label: "A", value: 2 }, { label: "B", value: 1 }, { label: "Zero", value: 0 }] };
  for (const chart of [kline, heatmap, pie]) assert.equal(tool.decode(chart).ok, true);
  assert.equal(tool.decode({ ...kline, candles: [{ ...kline.candles[0], high: -3 }, kline.candles[1]] }).ok, false);
  assert.equal(tool.decode({ ...heatmap, values: [[null, null, null], [null, null, null]] }).ok, false);
  assert.equal(tool.decode({ ...pie, slices: [{ label: "A", value: -1 }] }).ok, false);
});

test("new chart descriptors round trip strictly and reject additional fields", async () => {
  const tool = chartTool();
  const kline = { kind: "kline-chart" as const, title: "OHLCV", candles: [{ label: "09:30", open: -2, high: 4, low: -3, close: 3, volume: 10 }, { label: "09:31", open: 3, high: 5, low: 2, close: 4, volume: 12 }] };
  const heatmap = { kind: "heatmap-chart" as const, title: "FLOW", rows: ["Buy", "Sell"], columns: ["A", "B", "C"], values: [[1, null, 3], [-2, 0, 4]] };
  const pie = { kind: "pie-chart" as const, title: "MIX", slices: [{ label: "A", value: 2 }, { label: "B", value: 1 }, { label: "Zero", value: 0 }] };
  for (const chart of [kline, heatmap, pie]) {
    const decoded = tool.decode(chart);
    assert.equal(decoded.ok, true);
    if (!decoded.ok) continue;
    const output = await tool.execute(decoded.value, context);
    assert.equal(output.ok, true);
    if (output.ok) assert.deepEqual(tool.encode(output.value), chart);
  }
  assert.equal(tool.decode({ ...kline, candles: [{ ...kline.candles[0], extra: true }, kline.candles[1]] }).ok, false);
  assert.equal(tool.decode({ ...heatmap, values: [[1, 2], [3, 4]] }).ok, false);
  assert.equal(tool.decode({ ...pie, extra: true }).ok, false);
});

test("K-line decoding has no count cap while durable output remains bounded", async () => {
  const tool = chartTool();
  const candles = Array.from({ length: 65 }, (_unused, index) => ({ label: `p${index}`, open: index, high: index + 2, low: index - 1, close: index + 1, volume: 0 }));
  const decoded = tool.decode({ kind: "kline-chart", title: "DENSE", candles });
  assert.equal(decoded.ok, true);
  if (!decoded.ok || decoded.value.kind !== "kline-chart") return;
  assert.equal(decoded.value.candles.length, 65);
  const denseOutput = await tool.execute(decoded.value, context);
  if (!denseOutput.ok) assert.equal(denseOutput.error.code, "TOOL_ARGUMENT_INVALID");
  const aggregate = tool.decode({ kind: "kline-chart", title: "Aggregate", candles: Array.from({ length: 512 }, (_unused, index) => ({ ...binance24Candles[index % binance24Candles.length]!, label: `p${index}`, volume: 12_034.567 + index })) });
  assert.equal(aggregate.ok, true);
  if (!aggregate.ok) return;
  const output = await tool.execute(aggregate.value, context);
  assert.equal(output.ok, false);
  if (!output.ok) assert.match(output.error.message, new RegExp(String(MAX_TOOL_RESULT)));
});

test("render_chart sizes the redacted durable representation", async () => {
  const tool = chartTool();
  const candles = Array.from({ length: 100 }, (_unused, index) => ({ ...binance24Candles[index % binance24Candles.length]!, label: "api_key=secret", volume: index }));
  const decoded = tool.decode({ kind: "kline-chart", title: "api_key=secret", candles });
  assert.equal(decoded.ok, true);
  if (!decoded.ok) return;
  const output = await tool.execute(decoded.value, context);
  assert.equal(output.ok, true);
});

import { isChartDescriptor, type ChartDescriptor, type ChartKind } from "finleet-core";
import { createRasterGraphic, type RasterGraphic } from "../kitty-graphics.js";
import { Jimp, JimpMime, loadFont, measureText } from "jimp";
import { SANS_16_WHITE } from "jimp/fonts";
import { hitTestChart, layoutChart, type ChartHitRegion, type ChartLayout, type ChartLayoutOptions } from "./chart-layout.js";

export { hitTestChart, layoutChart, type ChartHitRegion, type ChartLayout } from "./chart-layout.js";
export type { ChartDescriptor, ChartKind } from "finleet-core";

export interface ChartSurfaceDimensions {
  readonly width: number;
  readonly height: number;
  readonly outputRows: number;
  readonly yLabelWidth: 5 | 8;
  readonly plotWidth: number;
}

export interface ChartSurfaceLayout {
  readonly dimensions: ChartSurfaceDimensions;
  readonly plotOrigin: { readonly column: number; readonly row: number };
  readonly layout: ChartLayout;
}

const CHART_WIDTH = 72;
const CHART_HEIGHT = 12;
const MIN_CHART_WIDTH = 13;
const MIN_CHART_HEIGHT = 8;
const MAX_CHART_RASTER_PIXELS = 1_000_000;
const CHART_SUPERSAMPLING = 2;
const unsafeText = /[\u0000-\u001f\u007f-\u009f\u001b]/;
const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const chartAnsi = { amber: "\x1b[38;5;214m", blue: "\x1b[38;5;24m", cyan: "\x1b[38;5;45m", dim: "\x1b[2m", muted: "\x1b[38;5;245m", reset: "\x1b[0m" } as const;
const graphemes = (value: string): readonly string[] => Array.from(graphemeSegmenter.segment(value), (part) => part.segment);
const graphemeWidth = (value: string): number => {
  if (value.includes("\u20e3") || /\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(value)) return 2;
  let width = 0;
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint === 0x200d || codePoint === 0xfe0e || codePoint === 0xfe0f || (codePoint >= 0x0300 && codePoint <= 0x036f) || (codePoint >= 0x1ab0 && codePoint <= 0x1aff) || (codePoint >= 0x1dc0 && codePoint <= 0x1dff) || (codePoint >= 0x20d0 && codePoint <= 0x20ff) || (codePoint >= 0xfe20 && codePoint <= 0xfe2f) || (codePoint >= 0x1f3fb && codePoint <= 0x1f3ff)) continue;
    const wide = codePoint >= 0x1100 && (codePoint <= 0x115f || codePoint === 0x2329 || codePoint === 0x232a || (codePoint >= 0x2e80 && codePoint <= 0xa4cf) || (codePoint >= 0xac00 && codePoint <= 0xd7a3) || (codePoint >= 0xf900 && codePoint <= 0xfaff) || (codePoint >= 0xfe10 && codePoint <= 0xfe19) || (codePoint >= 0xfe30 && codePoint <= 0xfe6f) || (codePoint >= 0xff00 && codePoint <= 0xff60) || (codePoint >= 0xffe0 && codePoint <= 0xffe6) || (codePoint >= 0x1f300 && codePoint <= 0x1faff));
    width = Math.max(width, wide ? 2 : 1);
  }
  return width;
};
const cellWidth = (value: string): number => graphemes(value).reduce((total, grapheme) => total + graphemeWidth(grapheme), 0);
const truncateCells = (value: string, limit: number): string => {
  let used = 0;
  let output = "";
  for (const grapheme of graphemes(value)) {
    const width = graphemeWidth(grapheme);
    if (used + width > limit) break;
    output += grapheme;
    used += width;
  }
  return output;
};
const padCellsStart = (value: string, width: number): string => `${" ".repeat(Math.max(0, width - cellWidth(value)))}${value}`;
const writeCells = (row: string[], left: number, right: number, value: string): void => {
  let column = Math.max(0, left);
  for (const grapheme of graphemes(value)) {
    const width = graphemeWidth(grapheme);
    if (width < 1 || column + width - 1 > right || column >= row.length) break;
    row[column] = grapheme;
    for (let offset = 1; offset < width && column + offset < row.length; offset += 1) row[column + offset] = "";
    column += width;
  }
};

const chartValues = (chart: ChartDescriptor): readonly number[] => {
  if (chart.kind === "line-chart" || chart.kind === "bar-chart") return chart.points.map((point) => point.value);
  if (chart.kind === "kline-chart") return chart.candles.map((candle) => candle.close);
  if (chart.kind === "heatmap-chart") return chart.values.flatMap((row) => row.filter((value): value is number => value !== null));
  if (chart.kind === "pie-chart") return chart.slices.map((slice) => slice.value);
  return [];
};
const chartLabels = (chart: ChartDescriptor): readonly string[] => {
  if (chart.kind === "line-chart" || chart.kind === "bar-chart") return chart.points.map((point) => point.label);
  if (chart.kind === "kline-chart") return chart.candles.map((candle) => candle.label);
  if (chart.kind === "heatmap-chart") return chart.columns;
  if (chart.kind === "pie-chart") return chart.slices.map((slice) => slice.label);
  return [];
};
const chartLayoutOptions = (chart: ChartDescriptor): ChartLayoutOptions => {
  if (chart.kind === "kline-chart") return { candles: chart.candles };
  if (chart.kind === "heatmap-chart") return { heatmap: chart.values };
  if (chart.kind === "pie-chart") return { pieValues: chart.slices.map((slice) => slice.value) };
  return {};
};

/** Resolve terminal-cell geometry shared by ANSI rendering and screen-space hover translation. */
export const layoutChartSurface = (chart: ChartDescriptor, width = CHART_WIDTH, height = CHART_HEIGHT): ChartSurfaceLayout => {
  const safeWidth = Number.isFinite(width) ? Math.max(MIN_CHART_WIDTH, Math.min(CHART_WIDTH, Math.floor(width))) : CHART_WIDTH;
  const safeHeight = Number.isFinite(height) ? Math.max(MIN_CHART_HEIGHT, Math.min(CHART_HEIGHT, Math.floor(height))) : CHART_HEIGHT;
  const yLabelWidth: 5 | 8 = safeWidth <= 18 ? 5 : 8;
  const plotWidth = Math.max(1, safeWidth - yLabelWidth - 3);
  const plotOrigin = { column: yLabelWidth + 2, row: 1 };
  const layout = layoutChart(chart.kind, chartValues(chart), { left: plotOrigin.column, top: plotOrigin.row, right: plotOrigin.column + plotWidth - 1, bottom: plotOrigin.row + safeHeight - 1 }, chartLayoutOptions(chart));
  return { dimensions: { width: safeWidth, height: safeHeight, outputRows: safeHeight + 3, yLabelWidth, plotWidth }, plotOrigin, layout };
};

const formatChartValue = (value: number, maxWidth = 8): string => {
  const plain = Number.isInteger(value) ? value.toString() : value.toFixed(2);
  if (plain.length <= maxWidth) return plain;
  for (let precision = 2; precision >= 0; precision -= 1) {
    const compact = value.toExponential(precision);
    if (compact.length <= maxWidth) return compact;
  }
  return value.toExponential(0).slice(0, maxWidth);
};
const numericExtrema = (values: readonly number[], fallbackMinimum: number, fallbackMaximum: number): { readonly minimum: number; readonly maximum: number } => {
  const first = values[0];
  if (first === undefined) return { minimum: fallbackMinimum, maximum: fallbackMaximum };
  let minimum = first;
  let maximum = first;
  for (let index = 1; index < values.length; index += 1) {
    const value = values[index]!;
    minimum = Math.min(minimum, value);
    maximum = Math.max(maximum, value);
  }
  return { minimum, maximum };
};
const widestLabel = (labels: readonly string[]): number => labels.reduce((width, label) => Math.max(width, label.length), 0);
const safeRasterText = (value: string, limit: number): string => Array.from(value).filter((character) => !unsafeText.test(character)).slice(0, limit).join("");
const pixelOffset = (width: number, x: number, y: number): number => (y * width + x) * 4;
const setPixel = (data: Buffer, width: number, height: number, x: number, y: number, color: readonly [number, number, number]): void => {
  if (x < 0 || y < 0 || x >= width || y >= height) return;
  const offset = pixelOffset(width, x, y);
  data[offset] = color[0]; data[offset + 1] = color[1]; data[offset + 2] = color[2]; data[offset + 3] = 255;
};
const drawLine = (data: Buffer, width: number, height: number, fromX: number, fromY: number, toX: number, toY: number, color: readonly [number, number, number], thickness = 1): void => {
  const steps = Math.max(Math.abs(toX - fromX), Math.abs(toY - fromY));
  const radius = Math.max(0, Math.floor((thickness - 1) / 2));
  for (let step = 0; step <= steps; step += 1) {
    const x = Math.round(fromX + (toX - fromX) * step / Math.max(1, steps));
    const y = Math.round(fromY + (toY - fromY) * step / Math.max(1, steps));
    for (let offsetY = -radius; offsetY <= radius; offsetY += 1) for (let offsetX = -radius; offsetX <= radius; offsetX += 1) setPixel(data, width, height, x + offsetX, y + offsetY, color);
  }
};
const drawPoint = (data: Buffer, width: number, height: number, x: number, y: number, color: readonly [number, number, number], radius = 2): void => {
  for (let offsetY = -radius; offsetY <= radius; offsetY += 1) for (let offsetX = -radius; offsetX <= radius; offsetX += 1) if (offsetX * offsetX + offsetY * offsetY <= radius * radius) setPixel(data, width, height, x + offsetX, y + offsetY, color);
};
const drawBar = (data: Buffer, width: number, height: number, left: number, top: number, right: number, bottom: number, color: readonly [number, number, number]): void => {
  for (let y = top; y <= bottom; y += 1) for (let x = left; x <= right; x += 1) setPixel(data, width, height, x, y, color);
};
const pieAngle = (x: number, y: number, centerX: number, centerY: number): number => (Math.atan2(x - centerX, -(y - centerY)) + Math.PI * 2) % (Math.PI * 2);
const pieSliceAt = (layout: ChartLayout, x: number, y: number): number => {
  const center = layout.pieCenter ?? { x: 0, y: 0 };
  const angle = pieAngle(x, y, center.x, center.y);
  return layout.slices?.find((slice) => angle >= slice.startAngle && (angle < slice.endAngle || (slice === layout.slices?.at(-1) && angle <= slice.endAngle)))?.index ?? 0;
};

type ChartRenderer = {
  readonly metadata: string;
  renderSurface(rows: string[][], layout: ChartLayout, chart: ChartDescriptor): void;
  renderRaster(pixels: Buffer, width: number, height: number, layout: ChartLayout): void;
};

const heatmapGlyph = (value: number | null, minimum: number, maximum: number): string => {
  if (value === null) return "·";
  const intensity = maximum === minimum ? 3 : Math.max(0, Math.min(3, Math.round((value - minimum) / (maximum - minimum) * 3)));
  return ["░", "▒", "▓", "█"][intensity] ?? "░";
};

const chartRegistry: { readonly [Kind in ChartKind]: ChartRenderer } = {
  "line-chart": {
    metadata: "line · area",
    renderSurface(rows, layout) {
      const lineRows = Array.from({ length: layout.bounds.bottom - layout.bounds.top + 1 }, () => Array.from({ length: layout.bounds.right - layout.bounds.left + 1 }, () => false));
      const pointCells = new Set<string>();
      for (const point of layout.points) {
        const lineRow = lineRows[point.y - layout.bounds.top];
        if (lineRow !== undefined) lineRow[point.x - layout.bounds.left] = true;
        pointCells.add(`${point.y}:${point.x}`);
        const previous = layout.points[point.index - 1];
        if (previous === undefined) continue;
        for (let cursor = Math.min(previous.x, point.x); cursor <= Math.max(previous.x, point.x); cursor += 1) {
          const ratio = (cursor - previous.x) / Math.max(1, point.x - previous.x);
          const row = Math.round(previous.y + (point.y - previous.y) * ratio);
          const lineAtRow = lineRows[row - layout.bounds.top];
          if (lineAtRow !== undefined) lineAtRow[cursor - layout.bounds.left] = true;
        }
      }
      for (let column = layout.bounds.left; column <= layout.bounds.right; column += 1) {
        const localColumn = column - layout.bounds.left;
        const columnRows = lineRows.flatMap((line, row) => line[localColumn] === true ? [row + layout.bounds.top] : []);
        const lineRow = columnRows[0] ?? -1;
        for (let row = layout.bounds.top; row <= layout.bounds.bottom; row += 1) if (lineRow >= 0 && row > lineRow && rows[row]![column] === " ") rows[row]![column] = "░";
        for (const row of columnRows) {
           const previous = column > layout.bounds.left ? lineRows.findIndex((line) => line[localColumn - 1] === true) + layout.bounds.top : -1;
           const next = column < layout.bounds.right ? lineRows.findIndex((line) => line[localColumn + 1] === true) + layout.bounds.top : -1;
          rows[row]![column] = pointCells.has(`${row}:${column}`) ? "●" : columnRows.length > 1 ? "│" : previous === row || next === row ? "━" : previous > row || next > row ? "╱" : "╲";
        }
      }
    },
    renderRaster(pixels, width, height, layout) {
      const line: readonly [number, number, number] = [0, 180, 210];
      const point: readonly [number, number, number] = [255, 184, 77];
      for (let index = 1; index < layout.points.length; index += 1) { const previous = layout.points[index - 1]; const current = layout.points[index]; if (previous !== undefined && current !== undefined) drawLine(pixels, width, height, previous.x, previous.y, current.x, current.y, line, CHART_SUPERSAMPLING); }
      for (const chartPoint of layout.points) drawPoint(pixels, width, height, chartPoint.x, chartPoint.y, point, 2 * CHART_SUPERSAMPLING);
    },
  },
  "bar-chart": {
    metadata: "bar",
    renderSurface(rows, layout) { for (const point of layout.points) { const glyph = point.y <= layout.baseline ? "█" : "▓"; for (let row = point.bar.top; row <= point.bar.bottom; row += 1) for (let column = point.bar.left; column <= point.bar.right; column += 1) rows[row]![column] = glyph; } for (let column = layout.bounds.left; column <= layout.bounds.right; column += 1) if (rows[layout.baseline]![column] === " ") rows[layout.baseline]![column] = "━"; },
    renderRaster(pixels, width, height, layout) { const positive: readonly [number, number, number] = [0, 180, 210]; const negative: readonly [number, number, number] = [255, 184, 77]; for (const point of layout.points) drawBar(pixels, width, height, point.bar.left, point.bar.top, point.bar.right, point.bar.bottom, point.y <= layout.baseline ? positive : negative); drawLine(pixels, width, height, layout.bounds.left, layout.baseline, layout.bounds.right, layout.baseline, [55, 65, 70], CHART_SUPERSAMPLING); },
  },
  "kline-chart": {
    metadata: "OHLCV · candles",
    renderSurface(rows, layout) {
      for (const candle of layout.candles ?? []) {
        const wickGlyph = "│";
        for (let row = candle.wick.top; row <= candle.wick.bottom; row += 1) rows[row]![candle.x] = wickGlyph;
        const bodyGlyph = candle.rising ? "█" : "▓";
        for (let row = candle.body.top; row <= candle.body.bottom; row += 1) for (let column = candle.body.left; column <= candle.body.right; column += 1) rows[row]![column] = bodyGlyph;
        const volumeGlyph = candle.rising ? "▆" : "▂";
        if (candle.volumeVisible) for (let row = candle.volume.top; row <= candle.volume.bottom; row += 1) for (let column = candle.volume.left; column <= candle.volume.right; column += 1) rows[row]![column] = volumeGlyph;
      }
      const volumeTop = layout.volumeBounds?.top;
      if (volumeTop !== undefined && volumeTop > layout.bounds.top) for (let column = layout.bounds.left; column <= layout.bounds.right; column += 1) rows[volumeTop - 1]![column] = "┄";
    },
    renderRaster(pixels, width, height, layout) {
      const rising: readonly [number, number, number] = [0, 190, 155];
      const falling: readonly [number, number, number] = [255, 130, 75];
      const volume: readonly [number, number, number] = [150, 150, 150];
      for (const candle of layout.candles ?? []) { const color = candle.rising ? rising : falling; drawLine(pixels, width, height, candle.x, candle.wick.top, candle.x, candle.wick.bottom, color, CHART_SUPERSAMPLING); drawBar(pixels, width, height, candle.body.left, candle.body.top, candle.body.right, candle.body.bottom, color); if (candle.volumeVisible) drawBar(pixels, width, height, candle.volume.left, candle.volume.top, candle.volume.right, candle.volume.bottom, volume); }
      const divider = layout.volumeBounds === undefined ? undefined : layout.volumeBounds.top - 1;
      if (divider !== undefined) drawLine(pixels, width, height, layout.bounds.left, divider, layout.bounds.right, divider, [55, 65, 70], CHART_SUPERSAMPLING);
    },
  },
  "heatmap-chart": {
    metadata: "heatmap · intensity",
    renderSurface(rows, layout) { for (const cell of layout.heatmapCells ?? []) for (let row = cell.bounds.top; row <= cell.bounds.bottom; row += 1) for (let column = cell.bounds.left; column <= cell.bounds.right; column += 1) rows[row]![column] = heatmapGlyph(cell.value, layout.minimum, layout.maximum); },
    renderRaster(pixels, width, height, layout) { const colors: readonly (readonly [number, number, number])[] = [[25, 45, 55], [0, 120, 145], [0, 190, 190], [255, 184, 77]]; for (const cell of layout.heatmapCells ?? []) { const intensity = cell.value === null ? 0 : layout.maximum === layout.minimum ? 3 : Math.max(0, Math.min(3, Math.round((cell.value - layout.minimum) / (layout.maximum - layout.minimum) * 3))); const bounds = cell.bounds; drawBar(pixels, width, height, bounds.left, bounds.top, bounds.right, bounds.bottom, colors[intensity] ?? colors[0]!); } },
  },
  "pie-chart": {
    metadata: "pie · share",
    renderSurface(rows, layout, chart) {
      const center = layout.pieCenter ?? { x: layout.bounds.left, y: layout.bounds.top };
      const radius = layout.pieRadius ?? 1;
      const glyphs = ["█", "▓", "▒", "░", "▉", "▊"];
      for (let row = Math.max(layout.bounds.top, center.y - radius); row <= Math.min(layout.bounds.bottom, center.y + radius); row += 1) for (let column = Math.max(layout.bounds.left, center.x - radius * 2); column <= Math.min(layout.bounds.right, center.x + radius * 2); column += 1) {
        const distance = Math.hypot((column - center.x) / 2, row - center.y);
        if (distance > radius) continue;
        rows[row]![column] = glyphs[pieSliceAt(layout, column, row) % glyphs.length] ?? "█";
      }
      const total = chart.kind === "pie-chart" ? chart.slices.reduce((sum, slice) => sum + slice.value, 0) : 1;
      if (chart.kind === "pie-chart") for (const [index, slice] of chart.slices.entries()) { const region = layout.slices?.[index]?.bounds; if (region === undefined) continue; const percent = total === 0 ? 0 : slice.value / total * 100; const text = `${glyphs[index % glyphs.length]} ${truncateCells(slice.label, Math.max(1, region.right - region.left - 7))} ${percent.toFixed(0)}%`; writeCells(rows[region.top]!, region.left, region.right, text); }
    },
    renderRaster(pixels, width, height, layout) {
      const center = layout.pieCenter ?? { x: layout.bounds.left, y: layout.bounds.top };
      const radius = Math.max(1, layout.pieRadius ?? 1);
      const colors: readonly (readonly [number, number, number])[] = [[0, 180, 210], [255, 184, 77], [0, 190, 155], [180, 100, 220], [210, 90, 120], [145, 190, 80]];
      for (let y = center.y - radius; y <= center.y + radius; y += 1) for (let x = center.x - radius * 2; x <= center.x + radius * 2; x += 1) if (Math.hypot((x - center.x) / 2, y - center.y) <= radius) setPixel(pixels, width, height, x, y, colors[pieSliceAt(layout, x, y) % colors.length] ?? colors[0]!);
    },
  },
};

/** Rasterize a bounded opaque chart into a protocol-neutral terminal graphic. */
export const renderChartGraphic = async (chart: ChartDescriptor, maxColumns: number, maxRows: number, cellWidth = 8, cellHeight = 16): Promise<RasterGraphic | undefined> => {
  if (!isChartDescriptor(chart) || !Number.isFinite(maxColumns) || !Number.isFinite(maxRows) || !Number.isFinite(cellWidth) || !Number.isFinite(cellHeight) || maxColumns < 1 || maxRows < 1 || cellWidth <= 0 || cellHeight <= 0) return undefined;
  const columns = Math.floor(maxColumns);
  const rows = Math.floor(maxRows);
  const width = Math.max(16 * CHART_SUPERSAMPLING, Math.min(columns * Math.floor(cellWidth) * CHART_SUPERSAMPLING, 1_600));
  const height = Math.max(16 * CHART_SUPERSAMPLING, Math.min(rows * Math.floor(cellHeight) * CHART_SUPERSAMPLING, Math.floor(MAX_CHART_RASTER_PIXELS / width)));
  if (width * height > MAX_CHART_RASTER_PIXELS || width < 1 || height < 1) return undefined;
  try {
    const image = new Jimp({ width, height, color: 0x121212ff });
    const pixels = image.bitmap.data;
    const font = await loadFont(SANS_16_WHITE);
    const padding = Math.max(4, Math.floor(Math.min(width, height) / 20));
    const fontHeight = 16;
    const fontWidth = 16;
    const values = chartValues(chart);
    const axisExtrema = chart.kind === "kline-chart"
      ? chart.candles.reduce((range, candle) => ({ minimum: Math.min(range.minimum, candle.low), maximum: Math.max(range.maximum, candle.high) }), { minimum: chart.candles[0]?.low ?? 0, maximum: chart.candles[0]?.high ?? 1 })
      : numericExtrema(values, 0, 1);
    const rawMinimum = axisExtrema.minimum;
    const rawMaximum = axisExtrema.maximum;
    const minimum = chart.kind === "bar-chart" ? Math.min(0, rawMinimum) : chart.kind === "pie-chart" ? 0 : rawMinimum;
    const maximum = chart.kind === "bar-chart" ? Math.max(0, rawMaximum) : chart.kind === "pie-chart" ? Math.max(1, rawMaximum) : rawMaximum;
    const priceLabels = chart.kind === "pie-chart" ? ["", "", "", "", ""] : Array.from({ length: 5 }, (_unused, index) => formatChartValue(maximum - (maximum - minimum) * index / 4));
    const volumeMaximum = chart.kind === "kline-chart" ? chart.candles.reduce((maximumValue, candle) => Math.max(maximumValue, candle.volume), 0) : 0;
    const volumeLabels = chart.kind === "kline-chart" && volumeMaximum > 0 ? Array.from({ length: 5 }, (_unused, index) => formatChartValue(volumeMaximum * (4 - index) / 4)) : [];
    const yLabelWidth = Math.max(1, widestLabel([...priceLabels, ...volumeLabels]));
    const yAxisWidth = yLabelWidth * fontWidth;
    const axisGap = Math.max(3, Math.floor(padding / 2));
    const titleTop = padding;
    const top = titleTop + fontHeight + axisGap;
    const left = padding + yAxisWidth + axisGap;
    const right = Math.max(left + 1, width - padding - 1);
    const xLabelTop = height - padding - fontHeight;
    const bottom = xLabelTop - axisGap;
    if (right - left < 16 || bottom - top < 16) return undefined;
    const layout = layoutChart(chart.kind, values, { left, top, right, bottom }, chartLayoutOptions(chart));
    const grid: readonly [number, number, number] = [55, 65, 70];
    const drawAxisBand = (band: { readonly top: number; readonly bottom: number }): void => {
      for (let index = 0; index <= 4; index += 1) drawLine(pixels, width, height, left, Math.round(band.top + (band.bottom - band.top) * index / 4), right, Math.round(band.top + (band.bottom - band.top) * index / 4), grid, CHART_SUPERSAMPLING);
      drawLine(pixels, width, height, left, band.top, left, band.bottom, grid, CHART_SUPERSAMPLING);
      drawLine(pixels, width, height, left, band.bottom, right, band.bottom, grid, CHART_SUPERSAMPLING);
    };
    const priceBounds = layout.priceBounds ?? { top, bottom };
    drawAxisBand(priceBounds);
    if (layout.volumeBounds !== undefined) drawAxisBand(layout.volumeBounds);
    const divider = layout.volumeBounds === undefined ? undefined : layout.volumeBounds.top - 1;
    if (divider !== undefined) drawLine(pixels, width, height, left, divider, right, divider, grid, CHART_SUPERSAMPLING);
    chartRegistry[chart.kind].renderRaster(pixels, width, height, layout);
    const text = safeRasterText(chart.title, Math.max(1, Math.floor(width / 6)));
    image.print({ font, x: padding, y: titleTop, text, maxWidth: Math.max(1, width - padding * 2), maxHeight: fontHeight });
    const printAxisLabels = (band: { readonly top: number; readonly bottom: number }, labels: readonly string[]): void => {
      for (const [index, label] of labels.entries()) { const tickY = Math.round(band.top + (band.bottom - band.top) * index / 4); if (label.length > 0) image.print({ font, x: padding, y: Math.max(band.top, Math.min(band.bottom - fontHeight, tickY - Math.floor(fontHeight / 2))), text: label, maxWidth: yAxisWidth, maxHeight: fontHeight }); }
    };
    printAxisLabels(priceBounds, priceLabels);
    if (layout.volumeBounds !== undefined) printAxisLabels(layout.volumeBounds, volumeLabels);
    if (chart.kind === "heatmap-chart") for (const cell of layout.heatmapCells ?? []) if (cell.columnIndex === 0) image.print({ font, x: padding, y: Math.max(top, Math.min(bottom - fontHeight, cell.bounds.top)), text: safeRasterText(truncateCells(chart.rows[cell.rowIndex] ?? "", Math.max(1, yLabelWidth)), yLabelWidth), maxWidth: yAxisWidth, maxHeight: fontHeight });
    const labels = chartLabels(chart);
    const xLabelWidth = Math.max(1, Math.floor((right - left) / (fontWidth * 3)));
    const xLabelIndices = chart.kind === "pie-chart" ? [] : [0, Math.floor((labels.length - 1) / 2), labels.length - 1];
    for (const index of new Set(xLabelIndices)) { const label = safeRasterText(truncateCells(labels[index] ?? "", xLabelWidth), xLabelWidth); const labelPixels = measureText(font, label); const anchor = chart.kind === "heatmap-chart" ? layout.heatmapCells?.find((cell) => cell.rowIndex === 0 && cell.columnIndex === index)?.bounds : chart.kind === "kline-chart" ? layout.candles?.[index] === undefined ? undefined : { left: layout.candles[index]!.x, right: layout.candles[index]!.x } : layout.points[index] === undefined ? undefined : { left: layout.points[index].x, right: layout.points[index].x }; const anchorX = anchor === undefined ? left : Math.round((anchor.left + anchor.right) / 2); image.print({ font, x: Math.max(left, Math.min(right - labelPixels, anchorX - Math.floor(labelPixels / 2))), y: xLabelTop, text: label, maxWidth: Math.max(1, right - left), maxHeight: fontHeight }); }
    if (chart.kind === "pie-chart") for (const [index, slice] of chart.slices.entries()) { const region = layout.slices?.[index]?.bounds; if (region === undefined) continue; const total = chart.slices.reduce((sum, item) => sum + item.value, 0); image.print({ font, x: region.left, y: Math.max(top, Math.min(bottom - fontHeight, region.top)), text: safeRasterText(`${slice.label} ${(slice.value / total * 100).toFixed(0)}%`, Math.max(1, right - region.left)), maxWidth: Math.max(1, right - region.left), maxHeight: fontHeight }); }
    const png = await image.getBuffer(JimpMime.png);
    return createRasterGraphic(png, width / CHART_SUPERSAMPLING, height / CHART_SUPERSAMPLING, columns, rows, cellWidth, cellHeight);
  } catch {
    return undefined;
  }
};

/** Render a detailed, dependency-free terminal chart surface from the shared descriptor. */
export const renderChartSurface = (chart: ChartDescriptor, width = CHART_WIDTH, height = CHART_HEIGHT): string => {
  const surface = layoutChartSurface(chart, width, height);
  const { dimensions, layout } = surface;
  const rows: string[][] = Array.from({ length: dimensions.height + surface.plotOrigin.row }, () => Array.from({ length: dimensions.width }, () => " "));
  for (let row = layout.bounds.top; row <= layout.bounds.bottom; row += 1) for (let column = layout.bounds.left; column <= layout.bounds.right; column += 1) rows[row]![column] = chart.kind === "heatmap-chart" ? "·" : row === layout.bounds.bottom ? "─" : (column - layout.bounds.left) % 8 === 0 || (row - layout.bounds.top) % 3 === 0 ? "┄" : " ";
  chartRegistry[chart.kind].renderSurface(rows, layout, chart);
  const yLabel = (row: number): string => {
    if (chart.kind === "pie-chart") return " ".repeat(dimensions.yLabelWidth);
    if (chart.kind === "heatmap-chart") { const rowIndex = Math.min(chart.rows.length - 1, Math.max(0, Math.floor((row - layout.bounds.top) * chart.rows.length / Math.max(1, dimensions.height)))); return padCellsStart(truncateCells(chart.rows[rowIndex] ?? "", dimensions.yLabelWidth), dimensions.yLabelWidth); }
    const price = layout.priceBounds;
    const top = price?.top ?? layout.bounds.top;
    const bottom = price?.bottom ?? layout.bounds.bottom;
    const volume = layout.volumeBounds;
    if (chart.kind === "kline-chart" && volume !== undefined && row >= volume.top) {
      const minimum = layout.volumeMinimum ?? 0;
      const maximum = layout.volumeMaximum ?? minimum;
      return formatChartValue(maximum - (maximum - minimum) * (row - volume.top) / Math.max(1, volume.bottom - volume.top), dimensions.yLabelWidth).padStart(dimensions.yLabelWidth);
    }
    if (chart.kind === "kline-chart" && volume !== undefined && row > bottom) return " ".repeat(dimensions.yLabelWidth);
    return formatChartValue(layout.maximum - (layout.maximum - layout.minimum) * (row - top) / Math.max(1, bottom - top), dimensions.yLabelWidth).padStart(dimensions.yLabelWidth);
  };
  const xLabelWidth = Math.max(1, Math.floor((dimensions.plotWidth - 2) / 3));
  const labels = chartLabels(chart);
  const xLabelIndices = [0, Math.floor((labels.length - 1) / 2), labels.length - 1].filter((index, position, all) => all.indexOf(index) === position);
  const xLabels = chart.kind === "pie-chart" ? "" : xLabelIndices.map((index) => truncateCells(labels[index] ?? "", xLabelWidth)).join(" ");
  const xLabelRow = chart.kind === "kline-chart"
    ? (() => {
      const row = Array.from({ length: dimensions.width }, () => " ");
      for (const index of xLabelIndices) {
        const label = truncateCells(labels[index] ?? "", xLabelWidth);
        const labelWidth = cellWidth(label);
        const anchor = layout.candles?.[index]?.x ?? layout.points[index]?.x ?? layout.bounds.left;
        const labelLeft = Math.max(layout.bounds.left, Math.min(layout.bounds.right - labelWidth + 1, anchor - Math.floor(labelWidth / 2)));
        writeCells(row, labelLeft, Math.min(layout.bounds.right, row.length - 1), label);
      }
      return row.join("");
    })()
    : `${" ".repeat(surface.plotOrigin.column)}${xLabels}`;
  let latestText = "";
  if (chart.kind === "line-chart" || chart.kind === "bar-chart") {
    const latest = chart.points.at(-1);
    if (latest !== undefined) latestText = `${truncateCells(latest.label, Math.max(1, Math.floor(dimensions.width / 4)))} ${formatChartValue(latest.value, dimensions.yLabelWidth)}`;
  } else if (chart.kind === "kline-chart") {
    const latest = chart.candles.at(-1);
    if (latest !== undefined) latestText = `${truncateCells(latest.label, Math.max(1, Math.floor(dimensions.width / 5)))} C:${formatChartValue(latest.close, dimensions.yLabelWidth)}`;
  }
  const metadata = chartRegistry[chart.kind].metadata;
  const compactHeader = dimensions.width <= 28;
  const titleWidth = Math.max(1, dimensions.width - 2 - cellWidth(metadata) - 2 - (latestText.length === 0 ? 0 : cellWidth(latestText) + 2));
  const title = compactHeader ? `${chartAnsi.amber}▌ ${truncateCells(chart.title, Math.max(1, dimensions.width - 2))}${chartAnsi.reset}` : `${chartAnsi.amber}▌ ${truncateCells(chart.title, titleWidth)}${chartAnsi.reset} ${chartAnsi.muted}${metadata}${chartAnsi.reset}`;
  const header = compactHeader || latestText.length === 0 ? title : `${title}  ${chartAnsi.cyan}${latestText}${chartAnsi.reset}`;
  const plotLines = rows.slice(surface.plotOrigin.row).map((line, index) => { const row = index + surface.plotOrigin.row; const content = line.slice(layout.bounds.left, layout.bounds.right + 1).join(""); const volumeTop = layout.volumeBounds?.top; const mutedPane = chart.kind === "kline-chart" && volumeTop !== undefined && row >= volumeTop - 1; const colored = mutedPane ? `${chartAnsi.muted}${content}${chartAnsi.reset}` : `${chartAnsi.blue}${content.replace(/░/g, `${chartAnsi.dim}░${chartAnsi.blue}`)}${chartAnsi.reset}`; return `${chartAnsi.muted}${yLabel(row)} │${chartAnsi.reset}${colored}`; });
  return [header, ...plotLines, `${chartAnsi.muted}${" ".repeat(dimensions.yLabelWidth)} └${"─".repeat(dimensions.plotWidth)}┘${chartAnsi.reset}`, xLabelRow].join("\n");
};

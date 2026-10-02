import type { ChartKind } from "finleet-core";

export type { ChartKind } from "finleet-core";

export interface ChartLayoutBounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface ChartLayoutPoint {
  readonly index: number;
  readonly x: number;
  readonly y: number;
  readonly bar: ChartLayoutBounds;
}

export type ChartHitRegion =
  | (ChartLayoutBounds & { readonly kind: "line-chart" | "bar-chart"; readonly pointIndex: number })
  | (ChartLayoutBounds & { readonly kind: "kline-chart"; readonly pointIndex: number; readonly candleIndex: number; readonly series: "candle" | "volume" })
  | (ChartLayoutBounds & { readonly kind: "heatmap-chart"; readonly pointIndex: number; readonly rowIndex: number; readonly columnIndex: number; readonly value: number })
  | (ChartLayoutBounds & { readonly kind: "pie-chart"; readonly pointIndex: number; readonly sliceIndex: number });

export interface ChartLayoutCandle {
  readonly index: number;
  readonly x: number;
  readonly openY: number;
  readonly highY: number;
  readonly lowY: number;
  readonly closeY: number;
  readonly body: ChartLayoutBounds;
  readonly wick: ChartLayoutBounds;
  readonly volume: ChartLayoutBounds;
  readonly volumeVisible: boolean;
  readonly rising: boolean;
}

export interface ChartLayoutCell {
  readonly rowIndex: number;
  readonly columnIndex: number;
  readonly value: number | null;
  readonly bounds: ChartLayoutBounds;
}

export interface ChartLayoutSlice {
  readonly index: number;
  readonly startAngle: number;
  readonly endAngle: number;
  readonly bounds: ChartLayoutBounds;
}

export interface ChartLayoutOptions {
  readonly candles?: readonly { readonly open: number; readonly high: number; readonly low: number; readonly close: number; readonly volume: number }[];
  readonly heatmap?: readonly (readonly (number | null)[])[];
  readonly pieValues?: readonly number[];
}

export interface ChartLayout {
  readonly kind: ChartKind;
  readonly bounds: ChartLayoutBounds;
  readonly minimum: number;
  readonly maximum: number;
  readonly baseline: number;
  readonly points: readonly ChartLayoutPoint[];
  readonly hitRegions: readonly ChartHitRegion[];
  readonly priceBounds?: ChartLayoutBounds;
  readonly volumeBounds?: ChartLayoutBounds;
  readonly volumeMinimum?: number;
  readonly volumeMaximum?: number;
  readonly candles?: readonly ChartLayoutCandle[];
  readonly heatmapCells?: readonly ChartLayoutCell[];
  readonly pieCenter?: { readonly x: number; readonly y: number };
  readonly pieRadius?: number;
  readonly slices?: readonly ChartLayoutSlice[];
}

const clamp = (value: number, minimum: number, maximum: number): number => Math.max(minimum, Math.min(maximum, value));
const normalize = (value: number, minimum: number, maximum: number): number => maximum === minimum ? 0.5 : (value - minimum) / (maximum - minimum);
const extrema = (values: readonly number[], fallbackMinimum: number, fallbackMaximum: number): { readonly minimum: number; readonly maximum: number } => {
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
const integerBounds = (bounds: ChartLayoutBounds): ChartLayoutBounds => ({
  left: Math.floor(bounds.left),
  top: Math.floor(bounds.top),
  right: Math.max(Math.floor(bounds.left), Math.floor(bounds.right)),
  bottom: Math.max(Math.floor(bounds.top), Math.floor(bounds.bottom)),
});
const boundedRegion = <T extends ChartHitRegion>(region: T, bounds: ChartLayoutBounds): T => ({
  ...region,
  left: clamp(region.left, bounds.left, bounds.right),
  top: clamp(region.top, bounds.top, bounds.bottom),
  right: clamp(region.right, bounds.left, bounds.right),
  bottom: clamp(region.bottom, bounds.top, bounds.bottom),
}) as T;
const xPosition = (bounds: ChartLayoutBounds, index: number, count: number): number => Math.round(bounds.left + (bounds.right - bounds.left) * index / Math.max(1, count - 1));
const candleXPosition = (bounds: ChartLayoutBounds, index: number, count: number): number => {
  const width = bounds.right - bounds.left + 1;
  return clamp(Math.round(bounds.left + width * (index + 0.5) / Math.max(1, count)), bounds.left, bounds.right);
};
const barBounds = (x: number, halfWidth: number, top: number, bottom: number, bounds: ChartLayoutBounds): ChartLayoutBounds => ({
  left: clamp(x - halfWidth, bounds.left, bounds.right),
  top: clamp(Math.min(top, bottom), bounds.top, bounds.bottom),
  right: clamp(x + halfWidth, bounds.left, bounds.right),
  bottom: clamp(Math.max(top, bottom), bounds.top, bounds.bottom),
});

/** Create deterministic plot-local geometry shared by ANSI, raster, and TUI hit testing. */
export const layoutChart = (kind: ChartKind, values: readonly number[], bounds: ChartLayoutBounds, options: ChartLayoutOptions = {}): ChartLayout => {
  const plot = integerBounds(bounds);
  const safeValues = values.length > 0 ? values : [0];
  const candles = options.candles ?? [];
  const heatmap = options.heatmap ?? [];
  const pieValues = options.pieValues ?? [];
  const raw = extrema(safeValues, 0, 1);
  const rawMinimum = raw.minimum;
  const rawMaximum = raw.maximum;
  const minimum = kind === "bar-chart" ? Math.min(0, rawMinimum) : rawMinimum;
  const maximum = kind === "bar-chart" ? Math.max(0, rawMaximum) : rawMaximum;
  const y = (value: number, range = plot): number => Math.round(range.bottom - normalize(value, minimum, maximum) * (range.bottom - range.top));
  const baseline = y(0);
  const spacing = (plot.right - plot.left) / Math.max(1, safeValues.length - 1);
  const points = values.map((value, index): ChartLayoutPoint => {
    const x = xPosition(plot, index, values.length);
    const valueY = y(value);
    const halfBarWidth = Math.max(0, Math.floor(Math.max(1, spacing) * 0.35));
    const bar = barBounds(x, halfBarWidth, valueY, baseline, plot);
    return { index, x, y: valueY, bar };
  });

  if (kind === "kline-chart") {
    const candleValues = candles.length > 0 ? candles : values.map((close) => ({ open: close, high: close, low: close, close, volume: 0 }));
    const firstCandle = candleValues[0];
    let candleMinimum = firstCandle?.low ?? 0;
    let candleMaximum = firstCandle?.high ?? 0;
    let volumeMaximum = 0;
    for (const candle of candleValues) {
      candleMinimum = Math.min(candleMinimum, candle.low);
      candleMaximum = Math.max(candleMaximum, candle.high);
      volumeMaximum = Math.max(volumeMaximum, candle.volume);
    }
    const hasVolume = volumeMaximum > 0;
    const candlePriceBottom = hasVolume ? Math.max(plot.top, plot.bottom - Math.max(2, Math.floor((plot.bottom - plot.top + 1) * 0.28)) - 1) : plot.bottom;
    const candlePrice = { ...plot, bottom: candlePriceBottom };
    const candleVolume = hasVolume ? { ...plot, top: Math.min(plot.bottom, candlePriceBottom + 2) } : undefined;
    const priceY = (value: number): number => Math.round(candlePrice.bottom - normalize(value, candleMinimum, candleMaximum) * (candlePrice.bottom - candlePrice.top));
    const candleSlotWidth = (plot.right - plot.left + 1) / Math.max(1, candleValues.length);
    const candleHalfWidth = Math.max(0, Math.floor(Math.min(candleSlotWidth * 0.28, Math.max(1, Math.floor((plot.bottom - plot.top + 1) * 0.04)))));
    const candleGeometry = candleValues.map((candle, index): ChartLayoutCandle => {
      const x = candleXPosition(plot, index, candleValues.length);
      const openY = priceY(candle.open);
      const closeY = priceY(candle.close);
      const highY = priceY(candle.high);
      const lowY = priceY(candle.low);
      const body = barBounds(x, candleHalfWidth, openY, closeY, candlePrice);
      const wick = barBounds(x, 0, highY, lowY, candlePrice);
      const volume = candleVolume === undefined
        ? barBounds(x, 0, plot.bottom, plot.bottom, plot)
        : barBounds(x, candleHalfWidth, Math.round(candleVolume.bottom - normalize(candle.volume, 0, volumeMaximum) * (candleVolume.bottom - candleVolume.top)), candleVolume.bottom, candleVolume);
      return { index, x, openY, highY, lowY, closeY, body, wick, volume, volumeVisible: candle.volume > 0, rising: candle.close >= candle.open };
    });
    const hitRegions: ChartHitRegion[] = [];
    for (const candle of candleGeometry) {
      hitRegions.push(boundedRegion({ kind, pointIndex: candle.index, candleIndex: candle.index, series: "candle", ...candle.body }, plot));
      if ((candleValues[candle.index]?.volume ?? 0) > 0 && candleVolume !== undefined) hitRegions.push(boundedRegion({ kind, pointIndex: candle.index, candleIndex: candle.index, series: "volume", ...candle.volume }, candleVolume));
    }
    return { kind, bounds: plot, minimum: candleMinimum, maximum: candleMaximum, baseline: priceY(0), points, hitRegions, priceBounds: candlePrice, ...(candleVolume === undefined ? {} : { volumeBounds: candleVolume, volumeMinimum: 0, volumeMaximum }), candles: candleGeometry };
  }

  if (kind === "heatmap-chart") {
    const matrix = heatmap.length > 0 ? heatmap : [values];
    const rowCount = Math.max(1, matrix.length);
    const columnCount = Math.max(1, ...matrix.map((row) => row.length));
    const numericValues = matrix.flatMap((row) => row.filter((value): value is number => value !== null));
    const cellMinimum = numericValues.length > 0 ? Math.min(...numericValues) : 0;
    const cellMaximum = numericValues.length > 0 ? Math.max(...numericValues) : 1;
    const cells: ChartLayoutCell[] = [];
    const hitRegions: ChartHitRegion[] = [];
    for (let rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
      for (let columnIndex = 0; columnIndex < columnCount; columnIndex += 1) {
        const row = matrix[rowIndex] ?? [];
        const value = row[columnIndex] ?? null;
        const cell = {
          left: plot.left + Math.floor((plot.right - plot.left + 1) * columnIndex / columnCount),
          top: plot.top + Math.floor((plot.bottom - plot.top + 1) * rowIndex / rowCount),
          right: plot.left + Math.floor((plot.right - plot.left + 1) * (columnIndex + 1) / columnCount) - 1,
          bottom: plot.top + Math.floor((plot.bottom - plot.top + 1) * (rowIndex + 1) / rowCount) - 1,
        };
        const cellBounds = { ...cell, right: Math.max(cell.left, cell.right), bottom: Math.max(cell.top, cell.bottom) };
        cells.push({ rowIndex, columnIndex, value, bounds: cellBounds });
        if (value !== null) hitRegions.push(boundedRegion({ kind, pointIndex: rowIndex * columnCount + columnIndex, rowIndex, columnIndex, value, ...cellBounds }, plot));
      }
    }
    return { kind, bounds: plot, minimum: cellMinimum, maximum: cellMaximum, baseline: plot.bottom, points: [], hitRegions, heatmapCells: cells };
  }

  if (kind === "pie-chart") {
    const valuesForSlices = pieValues.length > 0 ? pieValues : values.map((value) => Math.max(0, value));
    const total = Math.max(1, valuesForSlices.reduce((sum, value) => sum + value, 0));
    const width = plot.right - plot.left + 1;
    const legendLeft = width >= 14 ? plot.left + Math.floor(width * 0.58) : plot.left;
    const pieBounds = { ...plot, right: Math.max(plot.left, legendLeft - 2) };
    const center = { x: Math.round((pieBounds.left + pieBounds.right) / 2), y: Math.round((pieBounds.top + pieBounds.bottom) / 2) };
    const radius = Math.max(1, Math.min(Math.floor((pieBounds.right - pieBounds.left) / 2), Math.floor((pieBounds.bottom - pieBounds.top) / 2)));
    const slices: ChartLayoutSlice[] = [];
    const hitRegions: ChartHitRegion[] = [];
    let angle = 0;
    for (let index = 0; index < valuesForSlices.length; index += 1) {
      const endAngle = angle + valuesForSlices[index]! / total * Math.PI * 2;
      const rowTop = plot.top + Math.floor((plot.bottom - plot.top + 1) * index / Math.max(1, valuesForSlices.length));
      const rowBottom = plot.top + Math.floor((plot.bottom - plot.top + 1) * (index + 1) / Math.max(1, valuesForSlices.length)) - 1;
      const region = { left: legendLeft, top: rowTop, right: plot.right, bottom: Math.max(rowTop, rowBottom) };
      slices.push({ index, startAngle: angle, endAngle, bounds: region });
      hitRegions.push(boundedRegion({ kind, pointIndex: index, sliceIndex: index, ...region }, plot));
      angle = endAngle;
    }
    return { kind, bounds: plot, minimum: 0, maximum: total, baseline: plot.bottom, points: [], hitRegions, pieCenter: center, pieRadius: radius, slices };
  }

  const hitRegions: ChartHitRegion[] = points.map((point): ChartHitRegion => kind === "bar-chart"
    ? boundedRegion({ kind, pointIndex: point.index, ...point.bar }, plot)
    : boundedRegion({ kind, pointIndex: point.index, left: point.x - 1, top: point.y - 1, right: point.x + 1, bottom: point.y + 1 }, plot));
  return { kind, bounds: plot, minimum, maximum, baseline, points, hitRegions };
};

/** Return the first plot-local hover target containing the coordinate, if one exists. */
export const hitTestChart = (layout: ChartLayout, x: number, y: number): ChartHitRegion | undefined => layout.hitRegions.find((region) => x >= region.left && x <= region.right && y >= region.top && y <= region.bottom);

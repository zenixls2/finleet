import assert from "node:assert/strict";
import test from "node:test";
import { Jimp } from "jimp";
import { hitTestChart, layoutChart, layoutChartSurface, renderChartGraphic, renderChartSurface } from "./chart.js";

test("chart surface renders bounded labeled points", () => {
  const chart = { kind: "line-chart" as const, title: "FIN", points: [{ label: "open", value: 10 }, { label: "close", value: 14 }] };
  const rendered = renderChartSurface(chart, 20, 4);
  assert.match(rendered, /▌ FIN/);
  assert.match(rendered, /●/);
  assert.match(rendered, /op\s+cl/);
  assert.equal(rendered.split("\n").length, 11);
  assert.match(rendered, /░/);
  assert.match(rendered, /└/);
});

test("renderChartSurface falls back for non-finite dimensions", () => {
  const chart = { kind: "line-chart" as const, title: "FIN", points: [{ label: "a", value: 1 }, { label: "b", value: 2 }] };
  assert.match(renderChartSurface(chart, Number.NaN, Number.POSITIVE_INFINITY), /▌ FIN/);
});

test("renderChartSurface keeps compact charts within a narrow terminal width", () => {
  const chart = { kind: "line-chart" as const, title: "FIN", points: [{ label: "open", value: -1_000_000_000 }, { label: "close", value: 1_000_000_000 }] };
  const rendered = renderChartSurface(chart, 13, 8).replace(/\x1b\[[0-9;]*m/g, "");
  assert.equal(rendered.split("\n").every((line) => line.length <= 13), true);
  assert.match(rendered, /e\+/);
});

test("renderChartSurface truncates Unicode labels without splitting graphemes", () => {
  const chart = { kind: "line-chart" as const, title: "東京📈market", points: [{ label: "東京📈open", value: 1 }, { label: "東京📈close", value: 2 }] };
  const rendered = renderChartSurface(chart, 13, 8);
  assert.equal(rendered.includes("�"), false);
  assert.equal(rendered.split("\n").every((line) => !line.includes("\ud800")), true);
});

test("renderChartSurface budgets keycaps, flags, and wide latest labels by terminal cells", () => {
  const chart = { kind: "line-chart" as const, title: "🇯🇵1️⃣2️⃣3️⃣4️⃣5️⃣", points: [{ label: "🇯🇵東京📈", value: 1 }, { label: "🇯🇵東京📈", value: 2 }] };
  const rendered = renderChartSurface(chart, 40, 8).replace(/\x1b\[[0-9;]*m/g, "");
  const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  const width = (line: string): number => Array.from(segmenter.segment(line), ({ segment }) => /\u20e3|\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(segment) ? 2 : Array.from(segment).filter((character) => !/[\u0300-\u036f\u200d\ufe0e\ufe0f]/u.test(character)).length).reduce((total, value) => total + value, 0);
  assert.equal(rendered.split("\n").every((line) => width(line) <= 40), true);
});

test("renderChartSurface preserves dense point collisions in compact columns", () => {
  const chart = { kind: "line-chart" as const, title: "DENSE", points: Array.from({ length: 64 }, (_, index) => ({ label: `p${index}`, value: index % 7 })) };
  const rendered = renderChartSurface(chart, 13, 8);
  assert.ok((rendered.match(/●/g) ?? []).length > 5);
});

test("layoutChartSurface exposes clamped terminal coordinates shared with rendered glyphs", () => {
  const cases = [
    { kind: "line-chart" as const, values: [0, 10], width: 20, height: 8 },
    { kind: "bar-chart" as const, values: [-4, 6], width: 20, height: 8 },
    { kind: "bar-chart" as const, values: [-4, 6], width: 1, height: 99 },
  ];
  for (const { kind, values, width, height } of cases) {
    const chart = { kind, title: "FIN", points: values.map((value, index) => ({ label: `p${index}`, value })) };
    const surface = layoutChartSurface(chart, width, height);
    assert.equal(surface.dimensions.width, Math.max(13, Math.min(72, Math.floor(width))));
    assert.equal(surface.dimensions.height, Math.max(8, Math.min(12, Math.floor(height))));
    assert.equal(surface.dimensions.outputRows, surface.dimensions.height + 3);
    assert.equal(surface.plotOrigin.column, surface.dimensions.yLabelWidth + 2);
    assert.equal(surface.plotOrigin.row, 1);
    assert.equal(surface.layout.bounds.left, surface.plotOrigin.column);
    assert.equal(surface.layout.bounds.top, surface.plotOrigin.row);
    assert.equal(surface.layout.bounds.right, surface.plotOrigin.column + surface.dimensions.plotWidth - 1);
    assert.equal(surface.layout.bounds.bottom, surface.plotOrigin.row + surface.dimensions.height - 1);
    for (const [index, region] of surface.layout.hitRegions.entries()) {
      assert.equal(region.left >= surface.layout.bounds.left && region.right <= surface.layout.bounds.right && region.top >= surface.layout.bounds.top && region.bottom <= surface.layout.bounds.bottom, true);
      assert.equal(hitTestChart(surface.layout, surface.layout.points[index]!.x, surface.layout.points[index]!.y)?.pointIndex, index);
    }
    const lines = renderChartSurface(chart, width, height).replace(/\x1b\[[0-9;]*m/g, "").split("\n");
    assert.equal(lines.length, surface.dimensions.outputRows);
    if (kind === "line-chart") {
      const anchor = surface.layout.points[0]!;
      assert.equal(lines[anchor.y]?.[anchor.x], "●");
    } else {
      const negative = surface.layout.points[0]!;
      const positive = surface.layout.points[1]!;
      assert.equal(lines[negative.bar.top]?.[negative.bar.left], "▓");
      assert.equal(lines[positive.bar.top]?.[positive.bar.left], "█");
    }
  }
});

test("chart rasterizer returns a bounded opaque PNG", async () => {
  const chart = { kind: "line-chart" as const, title: "FIN <safe>", points: [{ label: "open", value: 10 }, { label: "close", value: 14 }] };
  const graphic = await renderChartGraphic(chart, 18, 6, 8, 16);
  assert.ok(graphic !== undefined);
  assert.ok(graphic.columns <= 18);
  assert.ok(graphic.rows <= 6);
  const png = await Jimp.read(Buffer.from(graphic.data));
  assert.equal(png.bitmap.width, 288);
  assert.equal(png.bitmap.height, 192);
  assert.equal(png.bitmap.data.every((_value, index) => index % 4 !== 3 || png.bitmap.data[index] === 255), true);
});

test("chart rasterizer reserves separate title and labeled axis regions", async () => {
  const chart = { kind: "line-chart" as const, title: "BTC/USD — Today", points: [{ label: "00:00", value: 76_255.85 }, { label: "12:00", value: 76_500.86 }, { label: "23:00", value: 76_705.87 }] };
  const graphic = await renderChartGraphic(chart, 18, 6, 8, 16);
  assert.ok(graphic !== undefined);
  if (graphic === undefined) return;
  const png = await Jimp.read(Buffer.from(graphic.data));
  const hasNonBackgroundPixel = (left: number, top: number, right: number, bottom: number): boolean => {
    for (let y = top; y < bottom; y += 1) for (let x = left; x < right; x += 1) {
      const offset = (y * png.bitmap.width + x) * 4;
      if (png.bitmap.data[offset] !== 18 || png.bitmap.data[offset + 1] !== 18 || png.bitmap.data[offset + 2] !== 18) return true;
    }
    return false;
  };
  assert.equal(hasNonBackgroundPixel(8, 8, 280, 24), true, "title region");
  assert.equal(hasNonBackgroundPixel(8, 40, 88, 152), true, "y-axis label region");
  assert.equal(hasNonBackgroundPixel(96, 168, 280, 184), true, "x-axis label region");
});

test("chart kinds share deterministic layout, ANSI, PNG, and bounded hit regions", async () => {
  const cases = [
    { kind: "line-chart" as const, values: [-4, 0, 8], expectedGlyph: "●" },
    { kind: "bar-chart" as const, values: [-4, 0, 8], expectedGlyph: "█" },
    { kind: "bar-chart" as const, values: [3, 3, 3], expectedGlyph: "█" },
  ];
  for (const { kind, values, expectedGlyph } of cases) await test(`${kind} geometry and render`, async () => {
    const points = values.map((value, index) => ({ label: `p${index}`, value }));
    const chart = { kind, title: "Mixed values", points };
    const layout = layoutChart(kind, values, { left: 2, top: 3, right: 18, bottom: 11 });
    assert.equal(layout.kind, kind);
    assert.equal(layout.points.length, points.length);
    assert.equal(layout.hitRegions.length, points.length);
    for (const [index, region] of layout.hitRegions.entries()) {
      assert.equal(region.kind, kind);
      assert.equal(region.pointIndex, index);
      assert.equal(region.left >= 2 && region.right <= 18 && region.top >= 3 && region.bottom <= 11, true);
      assert.equal(hitTestChart(layout, layout.points[index]!.x, layout.points[index]!.y)?.pointIndex, index);
    }
    assert.equal(JSON.stringify(layout), JSON.stringify(layoutChart(kind, values, { left: 2, top: 3, right: 18, bottom: 11 })));
    assert.match(renderChartSurface(chart, 30, 8), new RegExp(expectedGlyph));
    const graphic = await renderChartGraphic(chart, 18, 6, 8, 16);
    assert.ok(graphic !== undefined);
    if (graphic === undefined) return;
    const png = await Jimp.read(Buffer.from(graphic.data));
    assert.equal(png.bitmap.width, 288);
    assert.equal(png.bitmap.height, 192);
  });
});

test("new chart kinds keep fixed bounded ANSI geometry and semantic hit regions", async () => {
  const cases = [
    { chart: { kind: "kline-chart" as const, title: "KLINE", candles: [{ label: "A", open: 1, high: 4, low: 0, close: 3, volume: 5 }, { label: "B", open: 3, high: 5, low: 2, close: 2, volume: 2 }] }, glyphs: ["│", "█", "▆"] },
    { chart: { kind: "heatmap-chart" as const, title: "HEAT", rows: ["R1", "R2"], columns: ["C1", "C2"], values: [[1, null], [4, 2]] }, glyphs: ["░", "█", "·"] },
    { chart: { kind: "pie-chart" as const, title: "PIE", slices: [{ label: "A", value: 3 }, { label: "B", value: 1 }] }, glyphs: ["█", "A", "B"] },
  ] as const;
  for (const { chart, glyphs } of cases) {
    const narrow = renderChartSurface(chart, 13, 8).replace(/\x1b\[[0-9;]*m/g, "");
    assert.equal(narrow.split("\n").length, 11);
    assert.equal(narrow.split("\n").every((line) => line.length <= 13), true);
    for (const glyph of glyphs) assert.match(narrow, new RegExp(glyph));
    const normal = renderChartSurface(chart, 40, 10);
    assert.equal(normal.split("\n").length, 13);
    const surface = layoutChartSurface(chart, 40, 10);
    const again = layoutChartSurface(chart, 40, 10);
    assert.deepEqual(surface.layout, again.layout);
    assert.equal(surface.layout.hitRegions.every((region) => region.left >= surface.layout.bounds.left && region.right <= surface.layout.bounds.right && region.top >= surface.layout.bounds.top && region.bottom <= surface.layout.bounds.bottom), true);
    assert.ok(surface.layout.hitRegions.length > 0);
    for (const region of surface.layout.hitRegions) assert.equal(hitTestChart(surface.layout, region.left, region.top)?.pointIndex, region.pointIndex);
    const graphic = await renderChartGraphic(chart, 18, 6, 8, 16);
    assert.ok(graphic !== undefined);
    if (graphic !== undefined) {
      assert.equal(graphic.columns <= 18 && graphic.rows <= 6, true);
      const png = await Jimp.read(Buffer.from(graphic.data));
      assert.equal(png.bitmap.data.every((_value, index) => index % 4 !== 3 || png.bitmap.data[index] === 255), true);
    }
  }
  assert.equal(await renderChartGraphic({ kind: "pie-chart", title: "PIE", slices: [{ label: "A", value: 1 }] }, 0, 6), undefined);
});

test("zero-volume K-line candles keep candle targets but draw no volume", () => {
  const chart = { kind: "kline-chart" as const, title: "ZERO", candles: [{ label: "A", open: 1, high: 3, low: 0, close: 2, volume: 0 }, { label: "B", open: 2, high: 4, low: 1, close: 3, volume: 5 }] };
  const surface = layoutChartSurface(chart, 40, 10);
  assert.equal(surface.layout.hitRegions.some((region) => region.kind === "kline-chart" && region.series === "volume" && region.candleIndex === 0), false);
  assert.equal(surface.layout.hitRegions.some((region) => region.kind === "kline-chart" && region.series === "candle" && region.candleIndex === 0), true);
  assert.equal(surface.layout.candles?.[0]?.volumeVisible, false);
  const rendered = renderChartSurface(chart, 40, 10);
  assert.match(rendered, /█|▓/);
});

test("K-line geometry uses centered bounded candle slots and conditional volume panes", () => {
  const bounds = { left: 4, top: 2, right: 44, bottom: 22 };
  const sparseCandles = [
    { open: 10, high: 14, low: 8, close: 13, volume: 0 },
    { open: 13, high: 16, low: 11, close: 12, volume: 0 },
  ];
  const sparse = layoutChart("kline-chart", [13, 12], bounds, { candles: sparseCandles });
  const first = sparse.candles?.[0];
  const second = sparse.candles?.[1];
  assert.ok(first !== undefined && second !== undefined);
  if (first === undefined || second === undefined) return;
  assert.ok(first.x > bounds.left && second.x < bounds.right, "sparse candles stay inset from plot edges");
  const sparseHalfWidthCap = Math.max(1, Math.floor((bounds.bottom - bounds.top + 1) * 0.04));
  assert.equal(first.body.right - first.x, sparseHalfWidthCap, "sparse candle right edge uses the height-derived cap");
  assert.equal(first.x - first.body.left, sparseHalfWidthCap, "sparse candle left edge uses the height-derived cap");
  assert.equal(first.wick.left, first.x);
  assert.equal(first.wick.right, first.x);
  assert.equal(second.wick.left, second.x);
  assert.equal(second.wick.right, second.x);
  assert.ok(first.body.right < second.body.left, "sparse candle bodies have generous spacing");
  assert.deepEqual(sparse.priceBounds, bounds);
  assert.equal(sparse.volumeBounds, undefined);

  const denseCandles = Array.from({ length: 12 }, (_unused, index) => ({ open: index, high: index + 2, low: index - 1, close: index + 1, volume: 0 }));
  const dense = layoutChart("kline-chart", denseCandles.map((candle) => candle.close), { left: 0, top: 0, right: 59, bottom: 20 }, { candles: denseCandles });
  for (let index = 1; index < (dense.candles?.length ?? 0); index += 1) {
    const previous = dense.candles?.[index - 1];
    const current = dense.candles?.[index];
    assert.ok(previous !== undefined && current !== undefined);
    if (previous !== undefined && current !== undefined) assert.ok(previous.body.right < current.body.left, `dense candle bodies do not overlap at ${index}`);
  }

  const positive = layoutChart("kline-chart", [13, 12], bounds, { candles: sparseCandles.map((candle, index) => ({ ...candle, volume: index + 1 })) });
  assert.ok(positive.volumeBounds !== undefined);
  assert.equal(positive.priceBounds?.bottom, positive.volumeBounds === undefined ? undefined : positive.volumeBounds.top - 2);
  assert.equal(positive.candles?.every((candle) => candle.volumeVisible), true);
});

test("very dense K-line layouts retain every candle within shared render bounds", async () => {
  const candles = Array.from({ length: 200 }, (_unused, index) => ({ label: `p${index}`, open: index, high: index + 3, low: index - 2, close: index + (index % 2), volume: index + 1 }));
  const chart = { kind: "kline-chart" as const, title: "DENSE", candles };
  const surface = layoutChartSurface(chart, 40, 10);
  assert.equal(surface.layout.candles?.length, candles.length);
  assert.equal(surface.layout.volumeMinimum, 0);
  assert.equal(surface.layout.volumeMaximum, candles.length);
  assert.equal(surface.layout.candles?.every((candle) => candle.body.left >= surface.layout.priceBounds!.left && candle.body.right <= surface.layout.priceBounds!.right && candle.wick.top >= surface.layout.priceBounds!.top && candle.wick.bottom <= surface.layout.priceBounds!.bottom && candle.volume.top >= surface.layout.volumeBounds!.top && candle.volume.bottom <= surface.layout.volumeBounds!.bottom), true);
  assert.equal(surface.layout.hitRegions.every((region) => region.left >= surface.layout.bounds.left && region.right <= surface.layout.bounds.right && region.top >= surface.layout.bounds.top && region.bottom <= surface.layout.bounds.bottom), true);
  const lines = renderChartSurface(chart, 40, 10).replace(/\x1b\[[0-9;]*m/g, "").split("\n");
  assert.equal(lines.every((line) => line.length <= 40), true);
  const graphic = await renderChartGraphic(chart, 18, 6, 8, 16);
  assert.ok(graphic !== undefined);
});

test("K-line volume uses an independent ANSI scale and muted native pixels", async () => {
  const chart = { kind: "kline-chart" as const, title: "VOLUME", candles: [{ label: "A", open: 1, high: 5, low: 0, close: 4, volume: 10 }, { label: "B", open: 4, high: 6, low: 2, close: 2, volume: 250 }] };
  const surface = layoutChartSurface(chart, 40, 10);
  assert.equal(surface.layout.volumeMinimum, 0);
  assert.equal(surface.layout.volumeMaximum, 250);
  assert.ok(surface.layout.volumeBounds !== undefined);
  if (surface.layout.volumeBounds === undefined) return;
  const lines = renderChartSurface(chart, 40, 10).replace(/\x1b\[[0-9;]*m/g, "").split("\n");
  assert.equal(lines[surface.layout.volumeBounds.top]?.slice(0, surface.dimensions.yLabelWidth).trim(), "250");
  assert.equal(lines[surface.layout.volumeBounds.bottom]?.slice(0, surface.dimensions.yLabelWidth).trim(), "0");
  assert.doesNotMatch(lines.slice(1, surface.dimensions.height + 1).join("\n"), /VOL/);
  const volumeLine = lines[surface.layout.volumeBounds.top] ?? "";
  assert.match(volumeLine, /▆|▂/);
  const graphic = await renderChartGraphic(chart, 18, 6, 8, 16);
  assert.ok(graphic !== undefined);
  if (graphic === undefined) return;
  const png = await Jimp.read(Buffer.from(graphic.data));
  const hasPixel = (red: number, green: number, blue: number): boolean => {
    for (let offset = 0; offset < png.bitmap.data.length; offset += 4) if (png.bitmap.data[offset] === red && png.bitmap.data[offset + 1] === green && png.bitmap.data[offset + 2] === blue) return true;
    return false;
  };
  assert.equal(hasPixel(150, 150, 150), true);
  assert.equal(hasPixel(0, 190, 155), true);
  assert.equal(hasPixel(255, 130, 75), true);
});

test("heatmap raster label anchors follow separated cell positions", () => {
  const chart = { kind: "heatmap-chart" as const, title: "FLOW", rows: ["R"], columns: ["A", "B", "C"], values: [[1, 2, 3]] };
  const layout = layoutChartSurface(chart, 40, 10).layout;
  const cells = layout.heatmapCells?.filter((cell) => cell.rowIndex === 0) ?? [];
  assert.equal(cells.length, 3);
  assert.ok((cells[0]?.bounds.left ?? 0) < (cells[1]?.bounds.left ?? 0));
  assert.ok((cells[1]?.bounds.left ?? 0) < (cells[2]?.bounds.left ?? 0));
  assert.ok((cells[0]?.bounds.right ?? 0) < (cells[2]?.bounds.left ?? 0));
});

test("heatmap native raster labels occupy separated x bands", async () => {
  const chart = { kind: "heatmap-chart" as const, title: "FLOW", rows: ["R"], columns: ["LEFT", "MID", "RIGHT"], values: [[1, 2, 3]] };
  const graphic = await renderChartGraphic(chart, 18, 6, 8, 16);
  assert.ok(graphic !== undefined);
  if (graphic === undefined) return;
  const png = await Jimp.read(Buffer.from(graphic.data));
  const hasBrightInk = (left: number, right: number): boolean => {
    for (let y = Math.max(0, png.bitmap.height - 32); y < png.bitmap.height - 2; y += 1) for (let x = left; x < right; x += 1) {
      const offset = (y * png.bitmap.width + x) * 4;
      if ((png.bitmap.data[offset] ?? 0) > 180 && (png.bitmap.data[offset + 1] ?? 0) > 180 && (png.bitmap.data[offset + 2] ?? 0) > 180) return true;
    }
    return false;
  };
  assert.equal(hasBrightInk(0, png.bitmap.width / 3), true);
  assert.equal(hasBrightInk(png.bitmap.width / 3, png.bitmap.width * 2 / 3), true);
  assert.equal(hasBrightInk(png.bitmap.width * 2 / 3, png.bitmap.width), true);
});

test("constant heatmaps use maximum intensity in ANSI and native raster output", async () => {
  const chart = { kind: "heatmap-chart" as const, title: "CONSTANT", rows: ["R"], columns: ["A", "B"], values: [[7, 7]] };
  assert.match(renderChartSurface(chart, 40, 10), /█/);
  const graphic = await renderChartGraphic(chart, 18, 6, 8, 16);
  assert.ok(graphic !== undefined);
  if (graphic === undefined) return;
  const png = await Jimp.read(Buffer.from(graphic.data));
  let hasMaximumIntensity = false;
  for (let offset = 0; offset < png.bitmap.data.length; offset += 4) if (png.bitmap.data[offset] === 255 && png.bitmap.data[offset + 1] === 184 && png.bitmap.data[offset + 2] === 77) hasMaximumIntensity = true;
  assert.equal(hasMaximumIntensity, true);
});

test("K-line native axis labels follow candle low and high extrema", async () => {
  const compact = { kind: "kline-chart" as const, title: "RANGE", candles: [{ label: "A", open: 10, high: 11, low: 9, close: 10, volume: 1 }, { label: "B", open: 10, high: 12, low: 8, close: 10, volume: 1 }] };
  const wide = { kind: "kline-chart" as const, title: "RANGE", candles: [{ label: "A", open: 10, high: 100, low: -100, close: 10, volume: 1 }, { label: "B", open: 10, high: 80, low: -80, close: 10, volume: 1 }] };
  const compactGraphic = await renderChartGraphic(compact, 18, 6, 8, 16);
  const wideGraphic = await renderChartGraphic(wide, 18, 6, 8, 16);
  assert.ok(compactGraphic !== undefined && wideGraphic !== undefined);
  if (compactGraphic === undefined || wideGraphic === undefined) return;
  const compactPng = await Jimp.read(Buffer.from(compactGraphic.data));
  const widePng = await Jimp.read(Buffer.from(wideGraphic.data));
  const axisBand = (image: Awaited<ReturnType<typeof Jimp.read>>): number[] => {
    const pixels: number[] = [];
    for (let y = 32; y < image.bitmap.height - 32; y += 1) for (let x = 0; x < 80; x += 1) {
      const offset = (y * image.bitmap.width + x) * 4;
      pixels.push(image.bitmap.data[offset] ?? 0, image.bitmap.data[offset + 1] ?? 0, image.bitmap.data[offset + 2] ?? 0);
    }
    return pixels;
  };
  assert.notDeepEqual(axisBand(compactPng), axisBand(widePng));
});

test("K-line x-axis labels follow centered candle anchors in native and ANSI output", async () => {
  const chart = { kind: "kline-chart" as const, title: "ANCHORS", candles: [{ label: "FIRST", open: 1, high: 4, low: 0, close: 3, volume: 1 }, { label: "LAST", open: 3, high: 5, low: 2, close: 2, volume: 1 }] };
  const surface = layoutChartSurface(chart, 40, 10);
  const labelRow = renderChartSurface(chart, 40, 10).split("\n").at(-1) ?? "";
  const firstCandle = surface.layout.candles?.[0];
  const lastCandle = surface.layout.candles?.[1];
  assert.ok(firstCandle !== undefined && lastCandle !== undefined);
  if (firstCandle === undefined || lastCandle === undefined) return;
  assert.equal(labelRow.length, 40);
  assert.equal(labelRow.indexOf("FIRST") + Math.floor("FIRST".length / 2), firstCandle.x);
  assert.equal(labelRow.indexOf("LAST") + Math.floor("LAST".length / 2), lastCandle.x);

  const graphic = await renderChartGraphic(chart, 18, 6, 8, 16);
  assert.ok(graphic !== undefined);
  if (graphic === undefined) return;
  const png = await Jimp.read(Buffer.from(graphic.data));
  const padding = Math.max(4, Math.floor(Math.min(png.bitmap.width, png.bitmap.height) / 20));
  const fontHeight = 16;
  const axisGap = Math.max(3, Math.floor(padding / 2));
  const top = padding + fontHeight + axisGap;
  const xLabelTop = png.bitmap.height - padding - fontHeight;
  const axisValues = chart.candles.flatMap((candle) => [candle.low, candle.high]);
  const axisMinimum = Math.min(...axisValues);
  const axisMaximum = Math.max(...axisValues);
  const axisLabels = Array.from({ length: 5 }, (_unused, index) => axisMaximum - (axisMaximum - axisMinimum) * index / 4).map((value) => Number.isInteger(value) ? value.toString() : value.toFixed(2));
  const left = padding + Math.max(...axisLabels.map((label) => label.length)) * 16 + axisGap;
  const right = Math.max(left + 1, png.bitmap.width - padding - 1);
  const bottom = xLabelTop - axisGap;
  const nativeLayout = layoutChart("kline-chart", chart.candles.map((candle) => candle.close), { left, top, right, bottom }, { candles: chart.candles });
  const brightX = (minimum: number, maximum: number): number[] => {
    const pixels: number[] = [];
    for (let y = xLabelTop; y < png.bitmap.height - padding; y += 1) for (let x = minimum; x <= maximum; x += 1) {
      const offset = (y * png.bitmap.width + x) * 4;
      if ((png.bitmap.data[offset] ?? 0) > 180 && (png.bitmap.data[offset + 1] ?? 0) > 180 && (png.bitmap.data[offset + 2] ?? 0) > 180) pixels.push(x);
    }
    return pixels;
  };
  const firstInk = brightX(left, Math.floor((left + right) / 2));
  const lastInk = brightX(Math.ceil((left + right) / 2), right);
  assert.ok(firstInk.length > 0 && lastInk.length > 0);
  const assertInkCentered = (ink: readonly number[], anchor: number): void => {
    const inkMidpoint = (Math.min(...ink) + Math.max(...ink)) / 2;
    assert.ok(Math.abs(inkMidpoint - anchor) <= 2, `expected ink midpoint ${inkMidpoint} near candle anchor ${anchor}`);
  };
  assertInkCentered(firstInk, nativeLayout.candles?.[0]?.x ?? 0);
  assertInkCentered(lastInk, nativeLayout.candles?.[1]?.x ?? 0);
});

test("heatmap row labels preserve fixed terminal width with wide graphemes", () => {
  const chart = { kind: "heatmap-chart" as const, title: "FLOW", rows: ["東京東京", "市場市場"], columns: ["A", "B"], values: [[1, 2], [3, 4]] };
  const rendered = renderChartSurface(chart, 40, 10).replace(/\x1b\[[0-9;]*m/g, "");
  const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  const width = (line: string): number => Array.from(segmenter.segment(line), ({ segment }) => {
    if (/\u20e3|\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(segment)) return 2;
    let graphemeWidth = 0;
    for (const character of segment) {
      const codePoint = character.codePointAt(0) ?? 0;
      if (/\p{Mark}|\u200d|\ufe0e|\ufe0f/u.test(character)) continue;
      const wide = codePoint >= 0x1100 && (codePoint <= 0x115f || codePoint === 0x2329 || codePoint === 0x232a || (codePoint >= 0x2e80 && codePoint <= 0xa4cf) || (codePoint >= 0xac00 && codePoint <= 0xd7a3) || (codePoint >= 0xf900 && codePoint <= 0xfaff) || (codePoint >= 0xfe10 && codePoint <= 0xfe19) || (codePoint >= 0xfe30 && codePoint <= 0xfe6f) || (codePoint >= 0xff00 && codePoint <= 0xff60) || (codePoint >= 0xffe0 && codePoint <= 0xffe6) || (codePoint >= 0x1f300 && codePoint <= 0x1faff));
      graphemeWidth = Math.max(graphemeWidth, wide ? 2 : 1);
    }
    return graphemeWidth;
  }).reduce((total, value) => total + value, 0);
  assert.equal(rendered.split("\n").every((line) => width(line) <= 40), true);
});

test("zero-volume K-line raster collapses the volume pane into the price pane", async () => {
  const chart = { kind: "kline-chart" as const, title: "ZERO", candles: [{ label: "A", open: 1, high: 3, low: 0, close: 2, volume: 0 }, { label: "B", open: 2, high: 4, low: 1, close: 3, volume: 0 }] };
  const layout = layoutChartSurface(chart, 40, 10).layout;
  assert.equal(layout.volumeBounds, undefined);
  assert.equal(layout.volumeMinimum, undefined);
  assert.equal(layout.volumeMaximum, undefined);
  assert.equal(layout.priceBounds?.bottom, layout.bounds.bottom);
  assert.equal(layout.hitRegions.some((region) => region.kind === "kline-chart" && region.series === "volume"), false);
  const graphic = await renderChartGraphic(chart, 18, 6, 8, 16);
  assert.ok(graphic !== undefined);
  if (graphic === undefined) return;
  const png = await Jimp.read(Buffer.from(graphic.data));
  let coloredInExpandedPricePane = false;
  for (let y = Math.floor(png.bitmap.height * 0.68); y < Math.floor(png.bitmap.height * 0.88); y += 1) for (let x = 0; x < png.bitmap.width; x += 1) {
    const offset = (y * png.bitmap.width + x) * 4;
    const red = png.bitmap.data[offset] ?? 0;
    const green = png.bitmap.data[offset + 1] ?? 0;
    const blue = png.bitmap.data[offset + 2] ?? 0;
    if ((green > 140 && red < 40 && blue > 100) || (red > 220 && green > 70 && green < 170 && blue < 120)) coloredInExpandedPricePane = true;
  }
  assert.equal(coloredInExpandedPricePane, true);
});

test("pie legend preserves complex graphemes within terminal-cell bounds", () => {
  const chart = { kind: "pie-chart" as const, title: "PIE", slices: [{ label: "👩‍💻🇯🇵é1️⃣東京", value: 2 }, { label: "🏳️‍🌈", value: 1 }] };
  const rendered = renderChartSurface(chart, 40, 10).replace(/\x1b\[[0-9;]*m/g, "");
  const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  const width = (line: string): number => Array.from(segmenter.segment(line), ({ segment }) => /\u20e3|\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(segment) ? 2 : Array.from(segment).filter((character) => !/[\u0300-\u036f\u200d\ufe0e\ufe0f]/u.test(character)).length).reduce((total, value) => total + value, 0);
  assert.equal(rendered.split("\n").every((line) => width(line) <= 40), true);
  assert.doesNotMatch(rendered, /�/);
});

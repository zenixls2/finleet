import assert from "node:assert/strict";
import test from "node:test";
import { Jimp } from "jimp";
import { encodeIterm2Graphic, encodeKittyPng } from "./image-protocols.js";
import { extractLatexGraphicSegments, latexGraphicKey, rasterCellGeometry, renderLatexGraphic } from "./latex-graphics.js";

test("LaTeX extraction ignores fenced code and preserves display mode", () => {
  assert.deepEqual(extractLatexGraphicSegments(String.raw`Inline \(x^2\)
\`\`\`latex
\frac{a}{b}
\`\`\`
Display $$y^2$$`), [
    { source: "x^2", displayMode: false },
    { source: "y^2", displayMode: true },
  ]);
});

test("LaTeX cache keys distinguish display and inline math", () => {
  assert.notEqual(
    latexGraphicKey({ source: "x", displayMode: false }),
    latexGraphicKey({ source: "x", displayMode: true }),
  );
});

test("raster cell geometry uses physical terminal pixels", () => {
  assert.deepEqual(rasterCellGeometry(41, 33, 20, 8, 16, 32), { columns: 3, rows: 2 });
});

test("raster cell geometry keeps a supersampled bitmap at the same cell footprint", () => {
  const native = rasterCellGeometry(41, 33, 20, 8, 16, 32);
  const supersampled = rasterCellGeometry(82 / 2, 66 / 2, 20, 8, 16, 32);
  assert.deepEqual(supersampled, native);
});

test("LaTeX rasterization is bounded and can use Kitty or OSC transport", async () => {
  const graphic = await renderLatexGraphic({ source: String.raw`\frac{a}{b}`, displayMode: true }, 18, 4);
  assert.ok(graphic !== undefined);
  if (graphic === undefined) return;
  assert.ok(graphic.columns <= 18);
  assert.ok(graphic.rows <= 4);
  assert.match(encodeKittyPng(graphic.data, 4096, graphic.columns, graphic.rows), /^\x1b_G/);
  const osc = encodeIterm2Graphic(graphic);
  const payload = /:([A-Za-z0-9+/=]*)\x07$/.exec(osc)?.[1];
  assert.deepEqual(Buffer.from(payload ?? "", "base64"), Buffer.from(graphic.data));
});

test("inline LaTeX fits a one-row Assistant fallback for OSC transport", async () => {
  const graphic = await renderLatexGraphic({ source: "x^2", displayMode: false }, 18, 1, 8, 16);
  assert.ok(graphic !== undefined);
  if (graphic === undefined) return;
  assert.equal(graphic.rows, 1);
  assert.ok(graphic.columns <= 18);
  assert.match(encodeIterm2Graphic(graphic), /^\x1b\]1337;File=inline=1;/);
});

test("LaTeX rasterization leaves safety bleed around square roots", async () => {
  const graphic = await renderLatexGraphic({ source: String.raw`\sqrt{x^2+y^2}`, displayMode: true }, 24, 3);
  assert.ok(graphic !== undefined);
  const image = await Jimp.read(Buffer.from(graphic.data));
  const background = 0x121212ff;
  for (let x = 0; x < image.bitmap.width; x += 1) {
    assert.equal(image.getPixelColor(x, 0), background);
    assert.equal(image.getPixelColor(x, image.bitmap.height - 1), background);
  }
  for (let y = 0; y < image.bitmap.height; y += 1) {
    assert.equal(image.getPixelColor(0, y), background);
    assert.equal(image.getPixelColor(image.bitmap.width - 1, y), background);
  }
});

test("oversized LaTeX falls back without rasterization", async () => {
  assert.equal(await renderLatexGraphic({ source: "x".repeat(2_049), displayMode: false }, 20), undefined);
});

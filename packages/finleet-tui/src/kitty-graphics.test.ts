import assert from "node:assert/strict";
import test from "node:test";
import { createRasterGraphic, rasterCellGeometry } from "./kitty-graphics.js";

test("shared raster geometry bounds physical pixels to the requested cells", () => {
  assert.deepEqual(rasterCellGeometry(320, 96, 20, 4, 16, 32), { columns: 20, rows: 3 });
});

test("shared PNG raster carries computed placement geometry without a transport payload", () => {
  const graphic = createRasterGraphic(new Uint8Array([137, 80, 78, 71]), 48, 32, 8, 4, 8, 16);
  assert.deepEqual({ columns: graphic?.columns, rows: graphic?.rows }, { columns: 6, rows: 2 });
  assert.deepEqual(graphic?.data, new Uint8Array([137, 80, 78, 71]));
});

test("shared raster rejects empty data and non-finite geometry", () => {
  assert.equal(createRasterGraphic(new Uint8Array(), 48, 32, 8, 4, 8, 16), undefined);
  assert.equal(createRasterGraphic(new Uint8Array([1]), 48, 32, Number.NaN, 4, 8, 16), undefined);
  assert.equal(createRasterGraphic(new Uint8Array([1]), 48, 32, 8, Number.POSITIVE_INFINITY, 8, 16), undefined);
});

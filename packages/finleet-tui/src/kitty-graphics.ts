/** Protocol-neutral PNG raster sized for a terminal-cell footprint. */
export interface RasterGraphic {
  data: Uint8Array;
  columns: number;
  rows: number;
}

export interface TerminalCellPixelSize { width: number; height: number; }

/** Parse the CSI 16t response reporting physical character-cell pixels. */
export const parseTerminalCellPixelSize = (input: string): TerminalCellPixelSize | undefined => {
  const match = /\x1b\[6;(\d+);(\d+)t/.exec(input);
  if (match === null) return undefined;
  const height = Number(match[1]);
  const width = Number(match[2]);
  return Number.isSafeInteger(width) && Number.isSafeInteger(height) && width > 0 && height > 0 ? { width, height } : undefined;
};

/** Fit a bitmap into physical terminal cells without exceeding its text footprint. */
export const rasterCellGeometry = (width: number, height: number, maxColumns: number, maxRows: number, cellWidth: number, cellHeight: number): { columns: number; rows: number } => {
  const scale = Math.min(1, (maxColumns * cellWidth) / Math.max(1, width), (maxRows * cellHeight) / Math.max(1, height));
  const columns = Math.max(1, Math.min(Math.floor(maxColumns), Math.ceil(width * scale / Math.max(1, cellWidth))));
  const rows = Math.max(1, Math.min(Math.floor(maxRows), Math.ceil(height * scale / Math.max(1, cellHeight))));
  return { columns, rows };
};

/** Build one bounded PNG raster using physical pixel geometry and terminal cells. */
export const createRasterGraphic = (png: Uint8Array, width: number, height: number, maxColumns: number, maxRows: number, cellWidth: number, cellHeight: number): RasterGraphic | undefined => {
  if (png.byteLength === 0 || ![width, height, maxColumns, maxRows, cellWidth, cellHeight].every(Number.isFinite) || width <= 0 || height <= 0 || maxColumns < 1 || maxRows < 1 || cellWidth <= 0 || cellHeight <= 0) return undefined;
  const geometry = rasterCellGeometry(width, height, maxColumns, maxRows, cellWidth, cellHeight);
  return { data: png, ...geometry };
};

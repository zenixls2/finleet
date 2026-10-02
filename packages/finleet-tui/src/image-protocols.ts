import { createSupportsTerminalGraphics } from "supports-terminal-graphics";
import type { RasterGraphic } from "./kitty-graphics.js";

export type ImageProtocol = "kitty" | "iterm2" | "sixel" | "ansi";
export interface ImageCapabilities { kitty: boolean; iterm2: boolean; sixel: boolean; }
export interface RgbaImage { width: number; height: number; data: Uint8Array; }

export const detectImageCapabilities = (stream: { isTTY?: boolean }): ImageCapabilities => createSupportsTerminalGraphics(stream);

/** Select the native protocol, preferring iTerm2's OSC transport over its Kitty compatibility mode. */
export const selectImageProtocol = (capabilities: ImageCapabilities, terminalProgram = ""): ImageProtocol => capabilities.iterm2 && terminalProgram === "iTerm.app" ? "iterm2" : capabilities.kitty ? "kitty" : capabilities.iterm2 ? "iterm2" : capabilities.sixel ? "sixel" : "ansi";

/** Remove Kitty image placements before rebuilding the text frame. */
export const clearKittyImages = (): string => "\x1b_Ga=d,d=A,q=2\x1b\\";

const kittyIdParameter = (name: "i" | "p", value: number | undefined): string => {
  if (value === undefined) return "";
  if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${name} must be a positive safe integer`);
  return `${name}=${value},`;
};

const terminalCells = (value: number): number => Number.isFinite(value) ? Math.max(1, Math.floor(value)) : 1;

export const deleteKittyPlacement = (placementId: number): string => `\x1b_Ga=d,d=p,p=${kittyIdParameter("p", placementId).slice(2, -1)},q=2\x1b\\`;

/** Release stored Kitty image data after its final placement is removed. */
export const deleteKittyImage = (imageId: number): string => `\x1b_Ga=d,d=i,i=${kittyIdParameter("i", imageId).slice(2, -1)},q=2\x1b\\`;

/** Repaint a stored Kitty image at the current cursor position without retransmitting its bytes. */
export const placeKittyImage = (imageId: number, placementId: number, columns: number, rows: number): string => {
  const geometry = `c=${terminalCells(columns)},r=${terminalCells(rows)},`;
  return `\x1b_Ga=p,${kittyIdParameter("i", imageId)}${kittyIdParameter("p", placementId)}${geometry}C=1,q=2\x1b\\`;
};

export const encodeKittyPng = (data: Uint8Array, chunkSize = 4096, columns?: number, rows?: number, imageId?: number, placementId?: number): string => {
  if (!Number.isSafeInteger(chunkSize) || chunkSize <= 0) throw new RangeError("chunkSize must be a positive safe integer");
  const encoded = Buffer.from(data).toString("base64");
  const chunks: string[] = [];
  for (let offset = 0; offset < encoded.length; offset += chunkSize) chunks.push(encoded.slice(offset, offset + chunkSize));
  const geometry = columns === undefined || rows === undefined ? "" : `c=${terminalCells(columns)},r=${terminalCells(rows)},`;
  const identifiers = `${kittyIdParameter("i", imageId)}${kittyIdParameter("p", placementId)}`;
  if (chunks.length === 0) return `\x1b_Ga=T,f=100,q=2,${identifiers}${geometry}m=0;\x1b\\`;
  return chunks.map((chunk, index) => `\x1b_G${index === 0 ? `a=T,f=100,q=2,${identifiers}${geometry}` : ""}m=${index === chunks.length - 1 ? 0 : 1};${chunk}\x1b\\`).join("");
};

export const encodeIterm2Png = (data: Uint8Array, columns?: number, rows?: number): string => {
  const geometry = columns === undefined || rows === undefined ? "" : `width=${terminalCells(columns)};height=${terminalCells(rows)};`;
  return `\x1b]1337;File=inline=1;size=${data.byteLength};preserveAspectRatio=0;doNotMoveCursor=1;${geometry}:${Buffer.from(data).toString("base64")}\x07`;
};

/** Encode a protocol-neutral PNG raster as an inline iTerm2 OSC 1337 image. */
export const encodeIterm2Graphic = (graphic: RasterGraphic): string => encodeIterm2Png(graphic.data, graphic.columns, graphic.rows);

const quantizedColor = (red: number, green: number, blue: number): number => ((red >> 5) << 5) | ((green >> 5) << 2) | (blue >> 6);
const colorComponents = (color: number): readonly [number, number, number] => [((color >> 5) & 7) * 255 / 7, ((color >> 2) & 7) * 255 / 7, (color & 3) * 255 / 3];
const sixelColor = (index: number, color: readonly [number, number, number]): string => `#${index};2;${Math.round(color[0] * 100 / 255)};${Math.round(color[1] * 100 / 255)};${Math.round(color[2] * 100 / 255)}`;
const bitmapOffset = (image: RgbaImage, x: number, y: number): number => (y * image.width + x) * 4;

export const encodeSixel = (image: RgbaImage, maxWidth = 80, maxHeight?: number): string => {
  const widthLimit = Math.max(1, Math.min(Math.floor(maxWidth), image.width));
  const widthScale = widthLimit / Math.max(1, image.width);
  const heightLimit = Math.max(1, Math.floor(maxHeight ?? Number.MAX_SAFE_INTEGER));
  const scale = Math.min(widthScale, heightLimit / Math.max(1, image.height));
  const width = Math.max(1, Math.min(widthLimit, Math.ceil(image.width * scale)));
  const height = Math.max(1, Math.min(heightLimit, Math.ceil(image.height * scale)));
  const palette = new Map<number, number>();
  const pixels = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const sourceX = Math.min(image.width - 1, Math.floor(x / scale));
    const sourceY = Math.min(image.height - 1, Math.floor(y / scale));
    const offset = bitmapOffset(image, sourceX, sourceY);
    const color = quantizedColor(image.data[offset] ?? 0, image.data[offset + 1] ?? 0, image.data[offset + 2] ?? 0);
    if (!palette.has(color)) palette.set(color, palette.size);
    pixels[y * width + x] = palette.get(color) ?? 0;
  }
  const colors = [...palette.keys()];
  let output = "\x1bPq";
  output += colors.map((color, index) => sixelColor(index, colorComponents(color))).join("");
  for (let band = 0; band < height; band += 6) {
    let bandOutput = "";
    for (let paletteIndex = 0; paletteIndex < colors.length; paletteIndex += 1) {
      let row = "";
      let hasPixels = false;
      for (let x = 0; x < width; x += 1) {
        let mask = 0;
        for (let bit = 0; bit < 6; bit += 1) if (band + bit < height && pixels[(band + bit) * width + x] === paletteIndex) { mask |= 1 << bit; hasPixels = true; }
        row += String.fromCharCode(63 + mask);
      }
      if (hasPixels) bandOutput += `#${paletteIndex}${row}$`;
    }
    output += `${bandOutput.endsWith("$") ? bandOutput.slice(0, -1) : bandOutput}-`;
  }
  return `${output}\x1b\\`;
};

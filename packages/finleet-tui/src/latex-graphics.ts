import { renderLatexToPng } from "opentui-math/graphics";
import { Jimp } from "jimp";
import { createRasterGraphic, type RasterGraphic } from "./kitty-graphics.js";

export { rasterCellGeometry } from "./kitty-graphics.js";

const MAX_SOURCE_LENGTH = 2_048;
const MAX_RASTER_PIXELS = 1_000_000;
const SUPERSAMPLING = 2;
const LAYOUT_PIXEL_RATIO = 2;
const RASTER_PADDING = SUPERSAMPLING * 2;
const LATEX_BACKGROUND = 0x121212ff;

export interface LatexGraphicSegment {
  source: string;
  displayMode: boolean;
}

export interface LatexGraphicMatch {
  segment: LatexGraphicSegment;
  start: number;
  end: number;
}

export type LatexRasterGraphic = RasterGraphic;

const latexDelimiter = /\$\$([\s\S]*?)\$\$|\\\[([\s\S]*?)\\\]|\\\(([\s\S]*?)\\\)|(?<![\w$])\$([^$\n]+?)\$(?![\w$])/g;

/** Locate only math outside fenced Markdown code blocks. */
export const extractLatexGraphicMatches = (text: string): readonly LatexGraphicMatch[] => {
  const matches: LatexGraphicMatch[] = [];
  let fenced = false;
  let normalLines: string[] = [];
  let normalStart = 0;
  let offset = 0;
  const flush = (): void => {
    const normal = normalLines.join("\n");
    latexDelimiter.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = latexDelimiter.exec(normal)) !== null) {
      matches.push({
        segment: { source: match[1] ?? match[2] ?? match[3] ?? match[4] ?? "", displayMode: match[1] !== undefined || match[2] !== undefined },
        start: normalStart + match.index,
        end: normalStart + match.index + match[0].length,
      });
    }
    normalLines = [];
  };
  for (const line of text.split("\n")) {
    if (/^\s*```/.test(line)) {
      flush();
      fenced = !fenced;
      normalStart = offset + line.length + 1;
      offset += line.length + 1;
      continue;
    }
    if (!fenced) {
      if (normalLines.length === 0) normalStart = offset;
      normalLines.push(line);
    }
    offset += line.length + 1;
  }
  flush();
  return matches;
};

/** Extract only math outside fenced Markdown code blocks. */
export const extractLatexGraphicSegments = (text: string): readonly LatexGraphicSegment[] => extractLatexGraphicMatches(text).map((match) => match.segment);

export const latexGraphicKey = (segment: LatexGraphicSegment): string => `${segment.displayMode ? "display" : "inline"}\u0000${segment.source}`;

/** Rasterize bounded LaTeX into a protocol-neutral terminal graphic. Errors deliberately fall back to cells. */
export const renderLatexGraphic = async (segment: LatexGraphicSegment, maxColumns: number, maxRows = 8, cellWidth = 8, cellHeight = 16): Promise<LatexRasterGraphic | undefined> => {
  if (segment.source.length > MAX_SOURCE_LENGTH || maxColumns < 1 || maxRows < 1 || !Number.isFinite(cellWidth) || !Number.isFinite(cellHeight) || cellWidth <= 0 || cellHeight <= 0) return undefined;
  try {
    const pixelRatio = LAYOUT_PIXEL_RATIO * SUPERSAMPLING;
    const maxRasterWidth = Math.max(8 * SUPERSAMPLING, Math.floor(maxColumns * cellWidth * SUPERSAMPLING));
    const maxRasterHeight = Math.max(16 * SUPERSAMPLING, Math.floor(maxRows * cellHeight * SUPERSAMPLING));
    const maxRasterPixels = MAX_RASTER_PIXELS * SUPERSAMPLING * SUPERSAMPLING;
    const contentMaxWidth = Math.max(1, maxRasterWidth - RASTER_PADDING * 2);
    const contentMaxHeight = Math.max(1, maxRasterHeight - RASTER_PADDING * 2);
    const image = await renderLatexToPng(segment.source, {
      displayMode: segment.displayMode,
      // CSS layout still targets the physical cell height. The extra raster density
      // is downscaled by Kitty into the same c/r footprint below.
      fontSize: Math.max(8, Math.floor(cellHeight / LAYOUT_PIXEL_RATIO)),
      pixelRatio,
      backgroundColor: "#121212",
      foregroundColor: "#eeeeee",
      maxRasterWidth: contentMaxWidth,
      maxRasterHeight: contentMaxHeight,
      maxRasterPixels,
      maxSourceLength: MAX_SOURCE_LENGTH,
      maxExpandedLength: 8_192,
      maxDepth: 32,
    });
    const source = await Jimp.read(Buffer.from(image.png));
    if (source.bitmap.width > contentMaxWidth || source.bitmap.height > contentMaxHeight) source.scaleToFit({ w: contentMaxWidth, h: contentMaxHeight });
    const width = source.bitmap.width + RASTER_PADDING * 2;
    const height = source.bitmap.height + RASTER_PADDING * 2;
    if (width > maxRasterWidth || height > maxRasterHeight || width * height > maxRasterPixels) return undefined;
    const padded = new Jimp({ width, height, color: LATEX_BACKGROUND });
    padded.composite(source, RASTER_PADDING, RASTER_PADDING);
    const png = await padded.getBuffer("image/png");
    return createRasterGraphic(png, width / SUPERSAMPLING, height / SUPERSAMPLING, maxColumns, maxRows, cellWidth, cellHeight);
  } catch {
    return undefined;
  }
};

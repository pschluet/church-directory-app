/**
 * QR codes, drawn by us from a bare matrix of modules.
 *
 * `qrcode-generator` does the hard part (Reed-Solomon, masking, picking a
 * version) and is imported lazily so its weight stays out of the precached
 * shell: almost nobody opens a share sheet. Everything after that -- the SVG
 * path, the PNG, the PDF rectangles -- is plain geometry over `boolean[][]`,
 * kept pure so it can be tested in jsdom, which has no canvas
 * (the convention `images.ts` sets: test the maths, not the pixels).
 */

/** The quiet zone the QR spec asks for around the symbol, in modules. */
export const QR_QUIET_ZONE = 4;

/**
 * The module matrix for `text`: `true` is a dark module, indexed `[row][col]`.
 *
 * Error correction "M" (about 15% recoverable) is the usual compromise for a
 * code that is printed or shown on a screen: "H" would make the symbol
 * denser for protection a clean flyer does not need, and a denser code is
 * harder for a phone to read from across a room. Type number 0 lets the
 * library pick the smallest version that fits.
 */
export async function qrModules(text: string): Promise<boolean[][]> {
  const { default: qrcode } = await import("qrcode-generator");
  const qr = qrcode(0, "M");
  qr.addData(text);
  qr.make();
  const count = qr.getModuleCount();
  return Array.from({ length: count }, (_, row) =>
    Array.from({ length: count }, (_, col) => qr.isDark(row, col))
  );
}

/** A horizontal run of dark modules: `w` of them starting at column `x` in row `y`. */
export interface QrRun {
  x: number;
  y: number;
  w: number;
}

/**
 * Every dark module, merged into horizontal runs, in module units with the
 * origin at the symbol's own top-left corner (no quiet zone).
 *
 * Runs rather than one rectangle per module because neighbouring rectangles
 * rasterise with hairline seams between them at fractional scales; one wider
 * rectangle has no seam to show. It is also several times fewer shapes. The SVG
 * and the PDF both draw from this, so they cannot disagree.
 */
export function qrRuns(modules: boolean[][]): QrRun[] {
  const runs: QrRun[] = [];
  modules.forEach((row, y) => {
    let start = -1;
    for (let x = 0; x <= row.length; x += 1) {
      const dark = x < row.length && row[x] === true;
      if (dark && start < 0) start = x;
      if (!dark && start >= 0) {
        runs.push({ x: start, y, w: x - start });
        start = -1;
      }
    }
  });
  return runs;
}

/**
 * One SVG path covering every dark module.
 *
 * The coordinate space is the `viewBox` `0 0 viewBoxSize viewBoxSize`, where
 * one unit is one module and `viewBoxSize = modules.length + 2 * margin`: the
 * symbol sits `margin` units in from every edge, leaving the quiet zone empty.
 * Because it is unitless, the same path scales to any rendered size.
 */
export function qrSvgPath(
  modules: boolean[][],
  { margin = QR_QUIET_ZONE }: { margin?: number } = {}
): { d: string; viewBoxSize: number } {
  const d = qrRuns(modules)
    .map((run) => `M${run.x + margin} ${run.y + margin}h${run.w}v1h-${run.w}z`)
    .join("");
  return { d, viewBoxSize: modules.length + 2 * margin };
}

/**
 * The code as a PNG, `px` pixels square, on white with the quiet zone.
 *
 * White is painted explicitly: a transparent PNG shows whatever is behind it,
 * and a dark-mode image viewer turns that black, which no scanner can read. The
 * scale is rounded down to whole pixels per module so edges stay crisp, and
 * the canvas is sized to match, so the result can be a few pixels under `px`.
 */
export function qrPngBlob(modules: boolean[][], px: number): Promise<Blob> {
  const total = modules.length + 2 * QR_QUIET_ZONE;
  const scale = Math.max(1, Math.floor(px / total));
  const canvas = document.createElement("canvas");
  canvas.width = total * scale;
  canvas.height = total * scale;
  const context = canvas.getContext("2d");
  if (!context) return Promise.reject(new Error("Canvas is not available"));
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = "#000000";
  for (const run of qrRuns(modules)) {
    context.fillRect(
      (run.x + QR_QUIET_ZONE) * scale,
      (run.y + QR_QUIET_ZONE) * scale,
      run.w * scale,
      scale
    );
  }
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("Could not encode PNG"))),
      "image/png"
    );
  });
}

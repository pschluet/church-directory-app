/**
 * Renders a PDF's pages to canvases, for the in-app document viewer.
 *
 * pdf.js is roughly a megabyte, so it is only ever loaded through the dynamic
 * import below -- nobody pays for it until they open a PDF. The legacy build,
 * not the modern one: the modern build leans on very recent JavaScript, and
 * an installed app on an iPhone runs whatever iOS that phone has.
 *
 * Each page is drawn `width` CSS pixels wide, at up to twice that in device
 * pixels, and appended to `container` in order.
 */
export async function renderPdfPages(
  data: ArrayBuffer,
  container: HTMLElement,
  width: number,
  signal: AbortSignal,
  onFirstPage: () => void
): Promise<number> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  /*
   * A Worker built by Vite (the `new URL(..., import.meta.url)` form), not
   * pdf.js's own `workerSrc`: that would ship the worker as a `.mjs` file,
   * and the deploy's S3 sync does not reliably serve `.mjs` as JavaScript --
   * which a module worker refuses to run. Vite emits this one as `.js`.
   * Started once and kept: pdf.js shares the port between documents.
   */
  pdfjs.GlobalWorkerOptions.workerPort ??= new Worker(
    new URL("pdfjs-dist/legacy/build/pdf.worker.min.mjs", import.meta.url),
    { type: "module" }
  );
  const task = pdfjs.getDocument({ data: new Uint8Array(data) });
  signal.addEventListener("abort", () => void task.destroy());
  const pdf = await task.promise;

  // Sharp on a retina screen without drawing absurdly large canvases.
  const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);

  for (let number = 1; number <= pdf.numPages; number++) {
    if (signal.aborted) break;
    const page = await pdf.getPage(number);
    const unscaled = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: (width / unscaled.width) * pixelRatio });
    const canvas = document.createElement("canvas");
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    canvas.className = "block w-full bg-white shadow";
    canvas.setAttribute("aria-label", `Page ${number} of ${pdf.numPages}`);
    canvas.setAttribute("role", "img");
    container.append(canvas);
    await page.render({ canvas, viewport }).promise;
    // Shown as soon as there is a page to look at, not after the last one.
    if (number === 1) onFirstPage();
  }
  return pdf.numPages;
}

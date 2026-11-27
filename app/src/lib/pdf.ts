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

type PdfJs = typeof import("pdfjs-dist/legacy/build/pdf.mjs");

/** How long opening a document may take before the worker is presumed dead. */
export const OPEN_TIMEOUT_MS = 10_000;

/*
 * The worker every document shares, until one fails.
 *
 * It used to be started once and kept for good. But iOS can kill a worker --
 * under memory pressure, typically -- and a dead worker stays dead: every PDF
 * after it failed to open, ones that had opened fine before included, until
 * the member swiped the whole app closed. So a failed render throws the
 * worker away, and the next attempt starts a new one.
 */
let worker: Worker | null = null;

function startWorker(pdfjs: PdfJs): void {
  worker?.terminate();
  /*
   * A Worker built by Vite (the `new URL(..., import.meta.url)` form), not
   * pdf.js's own `workerSrc`: that would ship the worker as a `.mjs` file,
   * and the deploy's S3 sync does not reliably serve `.mjs` as JavaScript --
   * which a module worker refuses to run. Vite emits this one as `.js`.
   */
  worker = new Worker(new URL("pdfjs-dist/legacy/build/pdf.worker.min.mjs", import.meta.url), {
    type: "module",
  });
  pdfjs.GlobalWorkerOptions.workerPort = worker;
}

export async function renderPdfPages(
  data: ArrayBuffer,
  container: HTMLElement,
  width: number,
  signal: AbortSignal,
  onFirstPage: () => void
): Promise<number> {
  const pdfjs: PdfJs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  if (!worker) startWorker(pdfjs);
  try {
    return await draw(pdfjs, data, container, width, signal, onFirstPage);
  } catch (error) {
    if (signal.aborted) throw error;
    // Most likely the worker, not the file: one more go on a fresh one.
    console.error("PDF render failed; retrying with a new worker", error);
    startWorker(pdfjs);
    container.replaceChildren();
    return await draw(pdfjs, data, container, width, signal, onFirstPage);
  }
}

async function draw(
  pdfjs: PdfJs,
  data: ArrayBuffer,
  container: HTMLElement,
  width: number,
  signal: AbortSignal,
  onFirstPage: () => void
): Promise<number> {
  // A copy: pdf.js transfers the bytes it is given, and a retry needs them.
  const task = pdfjs.getDocument({ data: new Uint8Array(data.slice(0)) });
  const destroy = () => void task.destroy();
  signal.addEventListener("abort", destroy);
  try {
    // A dead worker may never answer at all, which would spin forever.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const pdf = await Promise.race([
      task.promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("PDF worker did not respond")), OPEN_TIMEOUT_MS);
      }),
    ]).finally(() => clearTimeout(timer));

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
  } catch (error) {
    destroy();
    throw error;
  } finally {
    signal.removeEventListener("abort", destroy);
  }
}

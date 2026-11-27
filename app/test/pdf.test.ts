import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// jsdom has neither workers nor canvas, so pdf.js is stood in for here.
const pdfjs = vi.hoisted(() => ({
  GlobalWorkerOptions: { workerPort: null as unknown },
  getDocument: vi.fn(),
}));
vi.mock("pdfjs-dist/legacy/build/pdf.mjs", () => pdfjs);

class FakeWorker {
  static started: FakeWorker[] = [];
  terminated = false;
  constructor() {
    FakeWorker.started.push(this);
  }
  terminate() {
    this.terminated = true;
  }
}

function openable(pages = 1) {
  const page = {
    getViewport: ({ scale }: { scale: number }) => ({ width: 100 * scale, height: 150 * scale }),
    render: () => ({ promise: Promise.resolve() }),
  };
  return {
    promise: Promise.resolve({ numPages: pages, getPage: async () => page }),
    destroy: vi.fn(),
  };
}

function broken() {
  const promise = Promise.reject(new Error("Worker was terminated"));
  promise.catch(() => {});
  return { promise, destroy: vi.fn() };
}

async function freshModule() {
  vi.resetModules();
  return import("../src/lib/pdf");
}

describe("renderPdfPages", () => {
  beforeEach(() => {
    FakeWorker.started = [];
    pdfjs.getDocument.mockReset();
    pdfjs.GlobalWorkerOptions.workerPort = null;
    vi.stubGlobal("Worker", FakeWorker);
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("shares one worker between documents that open fine", async () => {
    const { renderPdfPages } = await freshModule();
    pdfjs.getDocument.mockImplementation(() => openable(2));
    const container = document.createElement("div");
    const signal = new AbortController().signal;

    await renderPdfPages(new ArrayBuffer(8), container, 300, signal, () => {});
    await renderPdfPages(new ArrayBuffer(8), container, 300, signal, () => {});

    expect(FakeWorker.started).toHaveLength(1);
  });

  it("starts a new worker and tries again when the old one has died", async () => {
    const { renderPdfPages } = await freshModule();
    pdfjs.getDocument.mockImplementationOnce(broken).mockImplementation(() => openable(2));
    const container = document.createElement("div");
    const first = vi.fn();

    const pages = await renderPdfPages(
      new ArrayBuffer(8),
      container,
      300,
      new AbortController().signal,
      first
    );

    expect(pages).toBe(2);
    expect(container.querySelectorAll("canvas")).toHaveLength(2);
    expect(first).toHaveBeenCalledTimes(1);
    expect(FakeWorker.started).toHaveLength(2);
    expect(FakeWorker.started[0]?.terminated).toBe(true);
    expect(pdfjs.GlobalWorkerOptions.workerPort).toBe(FakeWorker.started[1]);
  });

  it("gives up after the retry fails too, leaving a fresh worker for next time", async () => {
    const { renderPdfPages } = await freshModule();
    pdfjs.getDocument.mockImplementation(broken);
    const container = document.createElement("div");
    const signal = new AbortController().signal;

    await expect(
      renderPdfPages(new ArrayBuffer(8), container, 300, signal, () => {})
    ).rejects.toThrow();
    expect(FakeWorker.started).toHaveLength(2);

    pdfjs.getDocument.mockImplementation(() => openable());
    await renderPdfPages(new ArrayBuffer(8), container, 300, signal, () => {});
    expect(FakeWorker.started).toHaveLength(2);
  });

  it("does not wait forever on a worker that never answers", async () => {
    vi.useFakeTimers();
    const { renderPdfPages, OPEN_TIMEOUT_MS } = await freshModule();
    const silent = { promise: new Promise(() => {}), destroy: vi.fn() };
    pdfjs.getDocument.mockImplementationOnce(() => silent).mockImplementation(() => openable());

    const result = renderPdfPages(
      new ArrayBuffer(8),
      document.createElement("div"),
      300,
      new AbortController().signal,
      () => {}
    );
    await vi.advanceTimersByTimeAsync(OPEN_TIMEOUT_MS);

    await expect(result).resolves.toBe(1);
    expect(silent.destroy).toHaveBeenCalled();
    expect(FakeWorker.started).toHaveLength(2);
  });

  it("does not retry once the viewer has been closed", async () => {
    const { renderPdfPages } = await freshModule();
    const controller = new AbortController();
    pdfjs.getDocument.mockImplementation(() => {
      controller.abort();
      return broken();
    });

    await expect(
      renderPdfPages(
        new ArrayBuffer(8),
        document.createElement("div"),
        300,
        controller.signal,
        () => {}
      )
    ).rejects.toThrow();
    expect(pdfjs.getDocument).toHaveBeenCalledTimes(1);
    expect(FakeWorker.started).toHaveLength(1);
  });
});

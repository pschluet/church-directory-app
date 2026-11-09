import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DocumentViewer, type ViewableDocument } from "../src/components/DocumentViewer";

// jsdom has neither canvas nor workers, so pdf.js itself cannot run here.
const renderPdfPages = vi.hoisted(() => vi.fn());
vi.mock("../src/lib/pdf", () => ({ renderPdfPages }));

function doc(overrides: Partial<ViewableDocument> = {}): ViewableDocument {
  return {
    filename: "bulletin.pdf",
    contentType: "application/pdf",
    byteSize: 2048,
    downloadUrl: "/bulletin.pdf",
    ...overrides,
  };
}

function serve(body: string) {
  const fetch = vi.fn(async () => ({ ok: true, blob: async () => new Blob([body]) }));
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

describe("DocumentViewer", () => {
  beforeEach(() => {
    renderPdfPages.mockReset();
    renderPdfPages.mockImplementation(
      async (_data: ArrayBuffer, container: HTMLElement, _w: number, _s: AbortSignal, first) => {
        for (const n of [1, 2]) {
          const canvas = document.createElement("canvas");
          canvas.setAttribute("role", "img");
          canvas.setAttribute("aria-label", `Page ${n} of 2`);
          container.append(canvas);
          if (n === 1) first();
        }
        return 2;
      }
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("draws every page of a PDF", async () => {
    const fetch = serve("%PDF");
    render(<DocumentViewer document={doc()} onClose={() => {}} />);
    expect(screen.getByRole("dialog", { name: "bulletin.pdf" })).toBeInTheDocument();
    expect(await screen.findByRole("img", { name: "Page 1 of 2" })).toBeVisible();
    expect(screen.getByRole("img", { name: "Page 2 of 2" })).toBeInTheDocument();
    expect(fetch).toHaveBeenCalledWith("/bulletin.pdf", expect.anything());
  });

  it("says so, rather than spinning forever, when a PDF cannot be drawn", async () => {
    serve("not a pdf");
    renderPdfPages.mockRejectedValue(new Error("Invalid PDF"));
    render(<DocumentViewer document={doc()} onClose={() => {}} />);
    expect(await screen.findByText("Couldn't show this document here.")).toBeInTheDocument();
  });

  it("shows plain text as text", async () => {
    serve("Bring a dish to share");
    render(
      <DocumentViewer
        document={doc({ filename: "notes.txt", contentType: "text/plain" })}
        onClose={() => {}}
      />
    );
    expect(await screen.findByText("Bring a dish to share")).toBeInTheDocument();
    expect(renderPdfPages).not.toHaveBeenCalled();
  });

  it("gives an Office file a card to download from where files cannot be shared", async () => {
    serve("docx");
    render(
      <DocumentViewer
        document={doc({
          filename: "minutes.docx",
          contentType: "application/msword",
          downloadUrl: "/minutes.docx",
        })}
        onClose={() => {}}
      />
    );
    expect(await screen.findByText(/can't be previewed here/)).toBeInTheDocument();
    const link = screen.getByRole("link", { name: "Download" });
    expect(link).toHaveAttribute("href", "/minutes.docx");
    expect(link).toHaveAttribute("download", "minutes.docx");
  });

  it("hands the file to the share sheet where the device can share files", async () => {
    serve("docx");
    const share = vi.fn(async () => {});
    vi.stubGlobal("navigator", { ...navigator, share, canShare: () => true });
    render(
      <DocumentViewer
        document={doc({
          filename: "minutes.docx",
          contentType: "application/msword",
          downloadUrl: "/minutes.docx",
        })}
        onClose={() => {}}
      />
    );
    await screen.findByText(/can't be previewed here/);
    await userEvent.click(screen.getByRole("button", { name: "Share" }));
    expect(share).toHaveBeenCalledTimes(1);
    const shared = (share.mock.calls[0] as unknown as [ShareData])[0];
    const file = shared.files?.[0];
    expect(file?.name).toBe("minutes.docx");
    expect(file?.type).toBe("application/msword");
    expect(screen.queryByRole("link", { name: "Download" })).not.toBeInTheDocument();
  });

  it("closes from the Close button and from Escape", async () => {
    serve("%PDF");
    const onClose = vi.fn();
    render(<DocumentViewer document={doc()} onClose={onClose} />);
    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(2));
  });
});

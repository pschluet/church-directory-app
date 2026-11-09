import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { renderPdfPages } from "../lib/pdf";
import { useDismissable } from "./ui";

export interface ViewableDocument {
  filename: string;
  contentType: string;
  byteSize: number;
  downloadUrl: string | null;
}

type Shown =
  | { state: "loading" }
  | { state: "pdf" }
  | { state: "text"; text: string }
  | { state: "card" }
  | { state: "failed" };

/**
 * A group post's document, opened inside the app.
 *
 * Not a link to the file. Installed on an iPhone home screen, the app has no
 * back button, and iOS opens a same-origin file in the app's own window --
 * `download` and `target="_blank"` both included -- leaving its preview with
 * no way back to the conversation. Here the file never leaves the app: a PDF
 * is drawn page by page, plain text and CSV are shown as text, and anything
 * else (Word, Excel, PowerPoint) gets a card. All of them have a Close button
 * and a Share button, whose sheet is where iOS offers Save to Files and
 * "Open in" -- and which has its own Cancel.
 */
export function DocumentViewer({
  document: doc,
  onClose,
}: {
  document: ViewableDocument;
  onClose: () => void;
}) {
  useDismissable(onClose);
  const closeRef = useRef<HTMLButtonElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const pagesRef = useRef<HTMLDivElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [shown, setShown] = useState<Shown>({ state: "loading" });

  useEffect(() => {
    closeRef.current?.focus();
  }, []);

  // By value, not by object: a refetched message hands over an equal but new
  // attachment, which must not start the document over.
  const { filename, contentType, downloadUrl } = doc;

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    const isPdf = contentType === "application/pdf";
    const isText = contentType === "text/plain" || contentType === "text/csv";

    (async () => {
      if (!downloadUrl) throw new Error("No file to show");
      const response = await fetch(downloadUrl, { signal });
      if (!response.ok) throw new Error(`Could not load ${filename}`);
      const blob = await response.blob();
      if (signal.aborted) return;
      // Fetched up front, so a tap on Share can hand it over at once: iOS only
      // shares inside the tap itself, not after a download it had to wait for.
      setFile(new File([blob], filename, { type: contentType }));

      if (isPdf) {
        const container = pagesRef.current;
        if (!container) return;
        container.replaceChildren();
        // The page column's width, less its padding: pages fill it edge to edge.
        const width = Math.min(scrollRef.current?.clientWidth || window.innerWidth, 768) - 24;
        await renderPdfPages(await blob.arrayBuffer(), container, width, signal, () =>
          setShown({ state: "pdf" })
        );
      } else if (isText) {
        setShown({ state: "text", text: await blob.text() });
      } else {
        setShown({ state: "card" });
      }
    })().catch(() => {
      if (!signal.aborted) setShown({ state: "failed" });
    });

    return () => controller.abort();
  }, [filename, contentType, downloadUrl]);

  return createPortal(
    <div
      className="fixed inset-0 z-[60] flex flex-col bg-surface-muted"
      role="dialog"
      aria-modal="true"
      aria-label={doc.filename}
    >
      <div
        className="flex shrink-0 items-center gap-2 border-b border-line bg-surface px-3 pb-2"
        style={{ paddingTop: "calc(env(safe-area-inset-top) + 0.5rem)" }}
      >
        <button
          ref={closeRef}
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="tap-target text-3xl leading-none text-ink-muted transition hover:text-primary"
        >
          ×
        </button>
        <p className="min-w-0 flex-1 truncate font-bold text-ink">{doc.filename}</p>
        {/* The card carries its own, larger one. */}
        {shown.state !== "card" && shown.state !== "failed" && (
          <ShareButton document={doc} file={file} />
        )}
      </div>

      <div
        ref={scrollRef}
        className="min-h-0 flex-1 overflow-auto"
        style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
      >
        {shown.state === "loading" && <Loading />}
        {/* Always mounted, so the PDF has somewhere to draw before it is shown. */}
        <div
          ref={pagesRef}
          className={`mx-auto flex max-w-3xl flex-col gap-3 p-3 ${shown.state === "pdf" ? "" : "hidden"}`}
        />
        {shown.state === "text" && (
          <pre className="mx-auto max-w-3xl whitespace-pre-wrap break-words p-4 font-mono text-sm text-ink [overflow-wrap:anywhere]">
            {shown.text}
          </pre>
        )}
        {(shown.state === "card" || shown.state === "failed") && (
          <div className="mx-auto flex max-w-md flex-col items-center gap-3 p-8 text-center">
            <span className="flex h-16 w-16 items-center justify-center rounded-md border border-line bg-surface text-sm text-ink-muted">
              File
            </span>
            <p className="break-words font-bold text-ink [overflow-wrap:anywhere]">
              {doc.filename}
            </p>
            <p className="text-sm text-ink-muted">
              {shown.state === "failed"
                ? "Couldn't show this document here."
                : `${formatBytes(doc.byteSize)} · This kind of file can't be previewed here.`}
            </p>
            <ShareButton document={doc} file={file} prominent />
          </div>
        )}
      </div>
    </div>,
    document.body
  );
}

function Loading() {
  return (
    <div className="flex items-center justify-center gap-3 py-12 text-ink-muted" role="status">
      <span className="h-5 w-5 animate-spin rounded-full border-2 border-line border-t-primary" />
      <span>Loading document…</span>
    </div>
  );
}

/**
 * The share sheet where the browser can share files (phones), and a plain
 * download link where it cannot (desktops, which have a back button anyway).
 */
function ShareButton({
  document: doc,
  file,
  prominent = false,
}: {
  document: ViewableDocument;
  file: File | null;
  prominent?: boolean;
}) {
  const style = prominent
    ? "tap-target inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 font-bold text-white hover:bg-primary-dark"
    : "tap-target inline-flex items-center justify-center rounded-md px-3 py-1 font-bold text-accent hover:underline";
  const canShareFile =
    file !== null &&
    typeof navigator.share === "function" &&
    typeof navigator.canShare === "function" &&
    navigator.canShare({ files: [file] });

  if (canShareFile) {
    return (
      <button
        type="button"
        className={style}
        onClick={() => {
          navigator.share({ files: [file], title: doc.filename }).catch(() => {
            // Cancelled, most likely -- nothing to tell anyone.
          });
        }}
      >
        Share
      </button>
    );
  }
  if (!doc.downloadUrl) return null;
  return (
    <a href={doc.downloadUrl} download={doc.filename} className={style}>
      Download
    </a>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

import { useState } from "react";
import { createPortal } from "react-dom";
import { downloadBlob, safeFilename } from "../lib/download";
import { qrModules, qrPngBlob } from "../lib/qr";
import { QrCode } from "./QrCode";
import { Button, useDismissable } from "./ui";

/** The PNG is saved large enough to print; the screen copy is vector and scales freely. */
const PNG_PX = 1024;

/**
 * An event's QR code, full screen, for holding up to a room.
 *
 * Full screen done with CSS (`fixed inset-0`), not the Fullscreen API -- the
 * call `MapView` already made: iOS Safari will not take a `div` full screen, and
 * an installed PWA has no browser chrome to leave it with. A fixed overlay with
 * its own close button and Escape works the same everywhere.
 *
 * `Modal` is a centred dialog capped at a reading width, which is the opposite of
 * what is wanted here, so this is its own overlay in the same visual language,
 * sharing `useDismissable` for Escape and the scroll lock.
 */
export function EventQrModal({
  open,
  onClose,
  url,
  title,
}: {
  open: boolean;
  onClose: () => void;
  url: string;
  title: string;
}) {
  if (!open) return null;
  return <EventQrOverlay onClose={onClose} url={url} title={title} />;
}

// Split from the wrapper so the hooks (and the scroll lock) exist only while open.
function EventQrOverlay({
  onClose,
  url,
  title,
}: {
  onClose: () => void;
  url: string;
  title: string;
}) {
  useDismissable(onClose);
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard?.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard access can be refused; the URL is on screen to copy by hand.
    }
  }

  async function downloadPng() {
    setFailed(false);
    try {
      const blob = await qrPngBlob(await qrModules(url), PNG_PX);
      downloadBlob(blob, `${safeFilename(title, "event")}-qr.png`);
    } catch {
      setFailed(true);
    }
  }

  // Portalled for the same reason as `Modal`: an ancestor with a transform would
  // turn `fixed` into "relative to that ancestor".
  return createPortal(
    <div
      className="fixed inset-0 z-50 flex flex-col items-center gap-4 overflow-y-auto bg-surface p-4 md:p-6"
      role="dialog"
      aria-modal="true"
      aria-label={`QR code for ${title}`}
    >
      <div className="flex w-full items-start justify-between gap-4">
        <h2 className="text-xl font-bold text-ink">{title}</h2>
        <button
          type="button"
          className="tap-target text-2xl leading-none text-ink-muted transition hover:text-primary"
          aria-label="Close"
          onClick={onClose}
        >
          ×
        </button>
      </div>

      {/* As large as the viewport allows, leaving room for the text and buttons. */}
      <div className="flex min-h-0 w-full flex-1 items-center justify-center">
        <QrCode
          value={url}
          title={`QR code for ${title}`}
          className="w-[min(100%,70vh)] rounded-lg border border-line"
        />
      </div>

      <p className="break-all text-center text-sm text-ink-muted">{url}</p>

      <div className="flex flex-wrap justify-center gap-3">
        <Button variant="secondary" onClick={() => void downloadPng()}>
          Download PNG
        </Button>
        <Button variant="secondary" onClick={() => void copy()}>
          {copied ? "Copied" : "Copy link"}
        </Button>
      </div>
      {failed && (
        <p role="alert" className="text-sm text-primary">
          Could not make the image.
        </p>
      )}
    </div>,
    document.body
  );
}

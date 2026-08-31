import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useDismissable } from "./ui";

/**
 * A photo at full size.
 *
 * Not built on `Modal`: that renders inline, caps its width at `md:max-w-2xl`
 * and always shows a title bar, all of which fight a photo that wants the
 * viewport. This portals to the body, uses a dark scrim so the image is what the
 * eye lands on, and sizes with `object-contain` so nothing is cropped -- the
 * point of opening it.
 *
 * The large rendition is only requested when this mounts, which is why a
 * directory page never pays for it.
 */
export function PhotoLightbox({
  src,
  alt,
  onClose,
}: {
  src: string;
  alt: string;
  onClose: () => void;
}) {
  useDismissable(onClose);
  const closeRef = useRef<HTMLButtonElement>(null);
  const [loaded, setLoaded] = useState(false);

  // Move focus into the dialog, so Tab stays here and a screen reader announces
  // it. Focus returns to the photo that opened it via the opener's own ref.
  useEffect(() => {
    closeRef.current?.focus();
  }, []);

  return createPortal(
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-ink/90 p-4"
      role="dialog"
      aria-modal="true"
      aria-label={alt}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <button
        ref={closeRef}
        type="button"
        onClick={onClose}
        aria-label="Close"
        className="tap-target absolute right-3 top-3 text-3xl leading-none text-surface/80 transition hover:text-surface"
      >
        ×
      </button>

      {!loaded && (
        <span
          role="status"
          aria-label="Loading photo"
          className="absolute h-8 w-8 animate-spin rounded-full border-2 border-surface/30 border-t-surface"
        />
      )}

      <img
        src={src}
        alt={alt}
        onLoad={() => setLoaded(true)}
        className={`max-h-[90vh] max-w-[90vw] rounded-md object-contain transition-opacity ${
          loaded ? "opacity-100" : "opacity-0"
        }`}
      />
    </div>,
    document.body
  );
}

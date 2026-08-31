import { useRef, useState } from "react";
import { initials } from "../lib/format";
import { PhotoLightbox } from "./PhotoLightbox";

const SIZES = {
  sm: { className: "h-10 w-10 text-sm", px: 40 },
  md: { className: "h-14 w-14 text-base", px: 56 },
  lg: { className: "h-28 w-28 text-2xl md:h-36 md:w-36 md:text-3xl", px: 144 },
} as const;

/**
 * A person's or family's photo, falling back to their initials.
 *
 * `thumbUrl` is a small square rendition -- 320px, so it is sharp at every size
 * here including `lg` on a 2x screen -- rather than the original, which used to
 * mean a 56px card downloading up to 5MB.
 */
export function Avatar({
  thumbUrl,
  fullUrl,
  person,
  size = "md",
}: {
  thumbUrl: string | null;
  /** When set, the photo can be clicked to open full-screen. */
  fullUrl?: string | null;
  person: { firstName: string; lastName: string | null };
  size?: keyof typeof SIZES;
}) {
  const { className, px } = SIZES[size];
  const shared = `${className} shrink-0 rounded-full object-cover`;
  // A photo whose URL is valid but whose object is gone would otherwise render
  // as a broken-image icon; the initials are a better answer. Remembering which
  // URL failed rather than a bare boolean matters: uploading a replacement
  // changes the prop without remounting, and a boolean would keep showing
  // initials for the new photo too.
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const [zoomed, setZoomed] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);

  if (thumbUrl && failedUrl !== thumbUrl) {
    const image = (
      <img
        src={thumbUrl}
        alt=""
        // Width and height are fixed by CSS at every size, so these only tell
        // the decoder what to expect -- there is no layout shift to prevent.
        width={px}
        height={px}
        loading="lazy"
        decoding="async"
        onError={() => setFailedUrl(thumbUrl)}
        className={`${shared} border border-line bg-surface-muted`}
      />
    );

    if (!fullUrl) return image;

    return (
      <>
        <button
          ref={buttonRef}
          type="button"
          onClick={() => setZoomed(true)}
          aria-label={`Show ${person.firstName}'s photo full screen`}
          className="shrink-0 rounded-full transition hover:opacity-90 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          {image}
        </button>
        {zoomed && (
          <PhotoLightbox
            src={fullUrl}
            alt={`${person.firstName} ${person.lastName ?? ""}`.trim()}
            onClose={() => {
              setZoomed(false);
              buttonRef.current?.focus();
            }}
          />
        )}
      </>
    );
  }

  return (
    <span
      aria-hidden="true"
      className={`${shared} flex items-center justify-center bg-surface-muted font-bold text-accent ring-1 ring-line`}
    >
      {initials(person) || "?"}
    </span>
  );
}

import { useRef, useState } from "react";
import { PhotoLightbox } from "./PhotoLightbox";

/**
 * A family's photo, shown whole.
 *
 * Deliberately not an `Avatar`: a family photo is a group, and a circle crops
 * most of one out. `object-contain` inside a box built from the stored crop
 * dimensions means nothing is cut off and nothing shifts as it loads.
 */
export function FamilyPhoto({
  thumbUrl,
  fullUrl,
  width,
  height,
  familyName,
}: {
  thumbUrl: string;
  fullUrl: string | null;
  /** From the free-form crop; null for photos that predate cropping. */
  width: number | null;
  height: number | null;
  familyName: string;
}) {
  const [zoomed, setZoomed] = useState(false);
  // Which URL failed, not whether one did: replacing the photo changes the prop
  // without remounting, and a boolean would hide the new one as well.
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const alt = `The ${familyName} family`;

  if (failedUrl === thumbUrl) return null;

  const image = (
    <img
      src={thumbUrl}
      alt={alt}
      // Reserving the box before the bytes arrive is the whole reason the crop
      // dimensions are stored. Without them, fall back to a 4:3 box rather than
      // letting the page jump.
      width={width ?? 4}
      height={height ?? 3}
      loading="lazy"
      decoding="async"
      onError={() => setFailedUrl(thumbUrl)}
      className="h-auto w-full rounded-lg border border-line bg-surface-muted object-contain"
    />
  );

  return (
    <>
      <div className="w-full max-w-sm">
        {fullUrl ? (
          <button
            ref={buttonRef}
            type="button"
            onClick={() => setZoomed(true)}
            aria-label={`Show the ${familyName} family photo full screen`}
            className="block w-full rounded-lg transition hover:opacity-90 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            {image}
          </button>
        ) : (
          image
        )}
      </div>
      {zoomed && fullUrl && (
        <PhotoLightbox
          src={fullUrl}
          alt={alt}
          onClose={() => {
            setZoomed(false);
            buttonRef.current?.focus();
          }}
        />
      )}
    </>
  );
}

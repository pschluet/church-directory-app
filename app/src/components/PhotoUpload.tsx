import { Suspense, lazy, useRef, useState } from "react";
import { MAX_PHOTO_BYTES, PHOTO_CONTENT_TYPES } from "@shared";
import { uploadPhoto } from "../lib/api";
import type { Renditions } from "../lib/images";
import { Avatar } from "./Avatar";
import { FamilyPhoto } from "./FamilyPhoto";
import { Button, Spinner } from "./ui";

/**
 * Loaded on demand. react-image-crop and its stylesheet are only needed by
 * someone editing a photo, and keeping them out of the initial bundle is worth
 * more than the split costs -- the pages this feature exists to speed up are
 * the ones that never open a cropper.
 */
const PhotoCropper = lazy(() =>
  import("./PhotoCropper").then((m) => ({ default: m.PhotoCropper }))
);

export interface UploadedPhoto {
  photoKey: string;
  /** The full rendition's size; only a family stores it, since its crop is free-form. */
  width: number;
  height: number;
}

/**
 * Picks a photo, frames it, and uploads the renditions.
 *
 * The file is not uploaded on selection any more: it opens the cropper, and what
 * goes to S3 is what was framed, downscaled to the sizes the app actually
 * renders. The original never leaves the browser.
 */
export function PhotoUpload({
  owner,
  thumbUrl,
  fullUrl,
  person,
  photoWidth = null,
  photoHeight = null,
  onUploaded,
  onRemove,
  /**
   * Keeps the controls under the photo at every width. The person page puts
   * this in a narrow left column, where letting it spread sideways pushes the
   * buttons into the details beside it.
   */
  stacked = false,
}: {
  owner: { personId: string } | { familyId: string };
  thumbUrl: string | null;
  fullUrl: string | null;
  person: { firstName: string; lastName: string | null };
  photoWidth?: number | null;
  photoHeight?: number | null;
  onUploaded: (photo: UploadedPhoto) => Promise<void> | void;
  onRemove?: () => Promise<void> | void;
  stacked?: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cropping, setCropping] = useState<File | null>(null);

  const isFamily = "familyId" in owner;

  function handleFile(file: File): void {
    setError(null);

    if (!(PHOTO_CONTENT_TYPES as readonly string[]).includes(file.type)) {
      setError("Choose a JPEG, PNG or WebP image.");
      return;
    }
    // The decode is the only part of this that scales with the original: Safari
    // cannot decode straight to a smaller bitmap, so the whole photo has to fit
    // in memory before MAX_WORKING_PIXELS can bound anything. Everything after
    // that point is working-copy sized.
    if (file.size > MAX_PHOTO_BYTES) {
      setError(`That image is too large — the limit is ${MAX_PHOTO_BYTES / 1024 / 1024} MB.`);
      return;
    }

    setCropping(file);
  }

  async function upload(renditions: Renditions): Promise<void> {
    setBusy(true);
    try {
      const photoKey = await uploadPhoto(owner, renditions);
      await onUploaded({
        photoKey,
        width: renditions.size.width,
        height: renditions.size.height,
      });
      setCropping(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "The photo could not be uploaded.");
      // Leave the cropper open: re-framing is cheaper than picking the file again.
      throw err;
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  return (
    <div
      className={
        stacked
          ? "flex flex-col items-center gap-3"
          : "flex flex-col items-center gap-3 sm:flex-row sm:items-start"
      }
    >
      {isFamily && thumbUrl ? (
        <FamilyPhoto
          thumbUrl={thumbUrl}
          fullUrl={fullUrl}
          width={photoWidth}
          height={photoHeight}
          familyName={person.firstName}
        />
      ) : (
        <Avatar thumbUrl={thumbUrl} fullUrl={fullUrl} person={person} size="lg" />
      )}

      <div
        className={
          stacked
            ? "flex flex-col items-center gap-2"
            : "flex flex-col items-center gap-2 sm:items-start"
        }
      >
        <input
          ref={inputRef}
          type="file"
          accept={PHOTO_CONTENT_TYPES.join(",")}
          className="sr-only"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) handleFile(file);
          }}
        />
        <div
          className={`flex flex-wrap gap-2 ${stacked ? "justify-center" : "justify-center sm:justify-start"}`}
        >
          <Button variant="secondary" disabled={busy} onClick={() => inputRef.current?.click()}>
            {busy ? "Uploading…" : thumbUrl ? "Change photo" : "Add photo"}
          </Button>
          {thumbUrl && onRemove && (
            <Button variant="ghost" disabled={busy} onClick={() => void onRemove()}>
              Remove
            </Button>
          )}
        </div>
        {error && (
          <p role="alert" className="text-sm font-bold text-primary">
            {error}
          </p>
        )}
      </div>

      {cropping && (
        <Suspense fallback={<Spinner label="Opening the photo" />}>
          <PhotoCropper
            file={cropping}
            owner={isFamily ? "family" : "person"}
            onCancel={() => {
              setCropping(null);
              if (inputRef.current) inputRef.current.value = "";
            }}
            onCropped={upload}
          />
        </Suspense>
      )}
    </div>
  );
}

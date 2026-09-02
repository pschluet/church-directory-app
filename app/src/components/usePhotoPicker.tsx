import { Suspense, lazy, useRef, useState } from "react";
import type { ReactNode } from "react";
import { MAX_PHOTO_BYTES, PHOTO_CONTENT_TYPES } from "@shared";
import { uploadPhoto } from "../lib/api";
import type { Renditions } from "../lib/images";
import { Spinner } from "./ui";

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
 * Picking a photo, framing it, and uploading the renditions -- without any
 * opinion about what the control looks like.
 *
 * Headless because both pages that use it drive the picker from a three-dots
 * menu and render the photo themselves: on the family page "don't show the add
 * a photo button or the photo placeholder unless a family photo has been added"
 * leaves nothing for a built-in button and preview to be, and on the person page
 * the photo sits in a column of its own, away from the menu that acts on it.
 *
 * `elements` has to be rendered somewhere for `open()` to work -- it is the file
 * input the click goes to, plus the cropper once a file is chosen.
 */
export function usePhotoPicker({
  owner,
  onUploaded,
}: {
  owner: { personId: string } | { familyId: string };
  onUploaded: (photo: UploadedPhoto) => Promise<void> | void;
}): {
  open: () => void;
  elements: ReactNode;
  busy: boolean;
  error: string | null;
} {
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

  const elements = (
    <>
      {/*
       * Hidden from assistive technology and from the tab order, not merely
       * from view. It is only ever opened by `open()` -- a visible button on the
       * person page, a menu item on the family page -- so left in the tree it is
       * a second, unlabelled "Choose File" control that a keyboard user has to
       * tab past and a screen reader announces with no hint of what it is for.
       */}
      <input
        ref={inputRef}
        type="file"
        accept={PHOTO_CONTENT_TYPES.join(",")}
        className="sr-only"
        tabIndex={-1}
        aria-hidden="true"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) handleFile(file);
        }}
      />
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
    </>
  );

  return { open: () => inputRef.current?.click(), elements, busy, error };
}

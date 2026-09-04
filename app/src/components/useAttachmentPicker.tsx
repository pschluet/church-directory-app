import { useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  MAX_PHOTO_BYTES,
  PHOTO_CONTENT_TYPES,
  PRAYER_REQUEST_MAX_IMAGES,
  type PrayerRequestImage,
} from "@shared";
import { uploadPrayerRequestImage } from "../lib/api";
import { loadWorkingImage, renderRenditions } from "../lib/images";

/**
 * Picking, downscaling and uploading prayer request attachments.
 *
 * Deliberately not `usePhotoPicker`, and not an option on it. That hook exists
 * to frame *one* photo: it opens the cropper on every file and hands back a
 * single key. An attachment is a different job in three ways --
 *
 *   - there can be several, chosen in one go (`multiple`);
 *   - there is no crop. A prayer request attachment is a photo of a person or a
 *     place, shown at whatever shape it was taken in, so the "crop" is the
 *     whole frame. Asking someone to drag a rectangle around four photos in a
 *     row to post one prayer request is friction for nothing;
 *   - a failure has to be per-file. Picking four and having the third fail
 *     should keep the other three, not reset the form.
 *
 * What it does reuse is everything that matters: `loadWorkingImage` for the
 * decode, the EXIF-orientation fix and the iOS canvas ceiling, and
 * `renderRenditions` for the two downscaled renditions. Those are the parts
 * that were hard to get right.
 */

export interface AttachmentPicker {
  /** Opens the file chooser. */
  open: () => void;
  /** Must be rendered somewhere for `open()` to work -- it is the file input. */
  elements: ReactNode;
  images: PrayerRequestImage[];
  remove: (photoKey: string) => void;
  reset: () => void;
  busy: boolean;
  error: string | null;
  full: boolean;
}

export function useAttachmentPicker(): AttachmentPicker {
  const inputRef = useRef<HTMLInputElement>(null);
  const [images, setImages] = useState<PrayerRequestImage[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const full = images.length >= PRAYER_REQUEST_MAX_IMAGES;

  async function handleFiles(files: File[]): Promise<void> {
    setError(null);
    setBusy(true);

    // Read the count off the state we are about to extend rather than off
    // `images`, which is a snapshot from this render: four files chosen at once
    // would each see the same empty list and all four would pass a check
    // against it.
    let accepted = images.length;
    const problems: string[] = [];

    try {
      for (const file of files) {
        if (accepted >= PRAYER_REQUEST_MAX_IMAGES) {
          problems.push(`Only ${PRAYER_REQUEST_MAX_IMAGES} photos can be attached.`);
          break;
        }
        if (!(PHOTO_CONTENT_TYPES as readonly string[]).includes(file.type)) {
          problems.push(`${file.name} is not a JPEG, PNG or WebP image.`);
          continue;
        }
        // The decode is the only step that scales with the original -- Safari
        // cannot decode straight to a smaller bitmap -- so the byte ceiling has
        // to be checked before `loadWorkingImage` bounds anything.
        if (file.size > MAX_PHOTO_BYTES) {
          problems.push(`${file.name} is larger than ${MAX_PHOTO_BYTES / 1024 / 1024} MB.`);
          continue;
        }

        try {
          const working = await loadWorkingImage(file);
          const renditions = await renderRenditions(
            working,
            { x: 0, y: 0, width: working.width, height: working.height },
            "attachment"
          );
          const photoKey = await uploadPrayerRequestImage(renditions);
          accepted += 1;
          setImages((previous) => [
            ...previous,
            { photoKey, width: renditions.size.width, height: renditions.size.height },
          ]);
        } catch (err) {
          // Per file, so one bad photo does not discard the others.
          problems.push(err instanceof Error ? err.message : `${file.name} could not be added.`);
        }
      }
    } finally {
      setBusy(false);
      // Cleared so choosing the same file again still fires `change`.
      if (inputRef.current) inputRef.current.value = "";
      if (problems.length > 0) setError(problems.join(" "));
    }
  }

  const elements = (
    // Hidden from assistive technology and from the tab order, not merely from
    // view -- the same reasoning as usePhotoPicker: it is only ever opened by
    // `open()`, so left in the tree it is a second unlabelled "Choose File"
    // control to tab past.
    <input
      ref={inputRef}
      type="file"
      multiple
      accept={PHOTO_CONTENT_TYPES.join(",")}
      className="sr-only"
      tabIndex={-1}
      aria-hidden="true"
      onChange={(event) => {
        const files = Array.from(event.target.files ?? []);
        if (files.length > 0) void handleFiles(files);
      }}
    />
  );

  return {
    open: () => inputRef.current?.click(),
    elements,
    images,
    remove: (photoKey) => setImages((previous) => previous.filter((i) => i.photoKey !== photoKey)),
    reset: () => {
      setImages([]);
      setError(null);
    },
    busy,
    error,
    full,
  };
}

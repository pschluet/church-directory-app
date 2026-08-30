import { useRef, useState } from "react";
import { MAX_PHOTO_BYTES, PHOTO_CONTENT_TYPES } from "@shared";
import { uploadPhoto } from "../lib/api";
import { Avatar } from "./Avatar";
import { Button } from "./ui";

/**
 * Uploads a photo straight to S3 with a presigned URL, then hands the key back
 * so the caller can attach it.
 */
export function PhotoUpload({
  owner,
  photoUrl,
  person,
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
  photoUrl: string | null;
  person: { firstName: string; lastName: string | null };
  onUploaded: (photoKey: string) => Promise<void> | void;
  onRemove?: () => Promise<void> | void;
  stacked?: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleFile(file: File): Promise<void> {
    setError(null);

    if (!(PHOTO_CONTENT_TYPES as readonly string[]).includes(file.type)) {
      setError("Choose a JPEG, PNG or WebP image.");
      return;
    }
    if (file.size > MAX_PHOTO_BYTES) {
      setError(`That image is too large — the limit is ${MAX_PHOTO_BYTES / 1024 / 1024} MB.`);
      return;
    }

    setBusy(true);
    try {
      await onUploaded(await uploadPhoto(owner, file));
    } catch (err) {
      setError(err instanceof Error ? err.message : "The photo could not be uploaded.");
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
      <Avatar photoUrl={photoUrl} person={person} size="lg" />

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
            if (file) void handleFile(file);
          }}
        />
        <div
          className={`flex flex-wrap gap-2 ${stacked ? "justify-center" : "justify-center sm:justify-start"}`}
        >
          <Button variant="secondary" disabled={busy} onClick={() => inputRef.current?.click()}>
            {busy ? "Uploading…" : photoUrl ? "Change photo" : "Add photo"}
          </Button>
          {photoUrl && onRemove && (
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
    </div>
  );
}

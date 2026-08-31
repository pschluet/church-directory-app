import { useCallback, useEffect, useRef, useState } from "react";
import ReactCrop, { centerCrop, makeAspectCrop, type Crop, type PixelCrop } from "react-image-crop";
import "react-image-crop/dist/ReactCrop.css";
import {
  loadWorkingImage,
  renderRenditions,
  workingPreviewBlob,
  type Renditions,
  type WorkingImage,
} from "../lib/images";
import { Button, Modal, Spinner } from "./ui";

/**
 * Frames a photo before it is uploaded.
 *
 * A person crops to a locked square, shown as a circle because that is how the
 * avatar renders -- framing against the shape it will actually take. A family
 * crop is free-form: the family photo is displayed whole, not as a circle, so
 * whatever rectangle suits the group is the right one.
 *
 * The file is decoded once into a bounded working copy -- oriented, and capped at
 * MAX_WORKING_PIXELS -- and that copy is what both this preview and the final
 * render use. Two reasons it is not the raw file: handing that to an <img> and
 * then drawing the same element to a canvas does not agree on orientation, so a
 * phone photo would save rotated away from what was framed; and a canvas the size
 * of a modern phone photo is over the limit iOS Safari silently returns blank
 * above, which would save the photo black.
 */
export function PhotoCropper({
  file,
  owner,
  onCancel,
  onCropped,
}: {
  file: File;
  owner: "person" | "family";
  onCancel: () => void;
  onCropped: (renditions: Renditions) => Promise<void> | void;
}) {
  const [working, setWorking] = useState<WorkingImage | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [crop, setCrop] = useState<Crop>();
  const [pixelCrop, setPixelCrop] = useState<PixelCrop>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const imgRef = useRef<HTMLImageElement>(null);

  const circular = owner === "person";
  const aspect = circular ? 1 : undefined;

  useEffect(() => {
    let url: string | null = null;
    let cancelled = false;

    void (async () => {
      try {
        const loaded = await loadWorkingImage(file);
        const blob = await workingPreviewBlob(loaded);
        if (cancelled) return;
        url = URL.createObjectURL(blob);
        setWorking(loaded);
        setPreviewUrl(url);
      } catch {
        // The decode is the one step a large file can still legitimately fail:
        // Safari cannot decode straight to a smaller bitmap, so the whole photo
        // has to fit in memory first. Say so rather than blaming the file.
        if (!cancelled) {
          setError("Your device could not process a photo that large. Try a smaller copy.");
        }
      }
    })();

    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [file]);

  /** Starts with the largest centred crop, so confirming immediately is sane. */
  const onImageLoad = useCallback(
    (event: React.SyntheticEvent<HTMLImageElement>) => {
      const { width, height } = event.currentTarget;
      const initial = aspect
        ? centerCrop(makeAspectCrop({ unit: "%", width: 90 }, aspect, width, height), width, height)
        : centerCrop({ unit: "%" as const, width: 90, height: 90, x: 0, y: 0 }, width, height);
      setCrop(initial);
    },
    [aspect]
  );

  async function confirm(): Promise<void> {
    if (!working || !pixelCrop || !imgRef.current) return;
    setBusy(true);
    setError(null);
    try {
      // react-image-crop reports against the rendered <img>, which is scaled to
      // fit the dialog. The preview was encoded from the working copy, so this
      // converts into the working copy's pixels -- the same space the crop is
      // drawn from.
      const scaleX = working.width / imgRef.current.width;
      const scaleY = working.height / imgRef.current.height;
      const renditions = await renderRenditions(
        working,
        {
          x: pixelCrop.x * scaleX,
          y: pixelCrop.y * scaleY,
          width: pixelCrop.width * scaleX,
          height: pixelCrop.height * scaleY,
        },
        owner
      );
      await onCropped(renditions);
    } catch (err) {
      setError(err instanceof Error ? err.message : "That photo could not be processed.");
      setBusy(false);
    }
  }

  return (
    <Modal wide title={circular ? "Position the photo" : "Choose what to show"} onClose={onCancel}>
      <div className="space-y-4">
        <p className="text-ink-muted">
          {circular
            ? "Drag and resize the circle to frame the face."
            : "Drag a box around what the photo should show. Any shape is fine."}
        </p>

        {previewUrl ? (
          <div className="flex justify-center bg-surface-muted p-2">
            <ReactCrop
              crop={crop}
              onChange={(_, percentCrop) => setCrop(percentCrop)}
              onComplete={(c) => setPixelCrop(c)}
              aspect={aspect}
              circularCrop={circular}
              keepSelection
              minWidth={32}
              minHeight={32}
              // The height cap has to live here, not on the <img>: ReactCrop's
              // stylesheet sets `max-height: inherit` on the child image, which
              // beats anything set on the image itself. Put it on the image and
              // a tall photo renders full size and pushes Save off the screen.
              className="max-h-[55vh]"
            >
              {/* Sized to the dialog; confirm() scales back to source pixels. */}
              <img ref={imgRef} src={previewUrl} alt="" onLoad={onImageLoad} />
            </ReactCrop>
          </div>
        ) : (
          !error && <Spinner label="Opening the photo" />
        )}

        {error && (
          <p role="alert" className="font-bold text-primary">
            {error}
          </p>
        )}

        <div className="flex flex-col gap-2 sm:flex-row">
          <Button
            type="button"
            onClick={() => void confirm()}
            disabled={busy || !pixelCrop || !working}
          >
            {busy ? "Saving…" : "Save photo"}
          </Button>
          <Button variant="ghost" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
        </div>
      </div>
    </Modal>
  );
}

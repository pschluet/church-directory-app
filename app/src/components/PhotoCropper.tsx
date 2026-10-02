import { useCallback, useEffect, useRef, useState } from "react";
import ReactCrop, {
  centerCrop,
  convertToPercentCrop,
  convertToPixelCrop,
  makeAspectCrop,
  type Crop,
  type PixelCrop,
} from "react-image-crop";
import "react-image-crop/dist/ReactCrop.css";
import "./PhotoCropper.css";
import {
  FAMILY_CARD_ASPECT,
  cropAtAspect,
  loadWorkingImage,
  renderRenditions,
  workingPreviewBlob,
  type CropRect,
  type Renditions,
  type WorkingImage,
} from "../lib/images";
import { Button, Modal, Spinner } from "./ui";

/**
 * Frames a photo before it is uploaded.
 *
 * A person crops to a locked square, shown as a circle because that is how the
 * avatar renders -- one step, framing against the shape it will actually take.
 * A family crop is two steps: free-form first, for the family's own page, same
 * as it always was; then a second crop shaped like the families-page card --
 * 3:2, rounded top corners -- taken from the *whole* original rather than from
 * the first crop, because the card has never been what anyone framed. It opens
 * on the smallest card-shaped rectangle that contains the first crop
 * (`cropAtAspect`), so confirming straight through still shows the subject
 * already chosen.
 *
 * The file is decoded once into a bounded working copy -- oriented, and capped
 * at MAX_WORKING_PIXELS -- and that copy is what every step's preview and the
 * final render use. Two reasons it is not the raw file: handing that to an
 * <img> and then drawing the same element to a canvas does not agree on
 * orientation, so a phone photo would save rotated away from what was framed;
 * and a canvas the size of a modern phone photo is over the limit iOS Safari
 * silently returns blank above, which would save the photo black.
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

  /** Which step a family is on. A person has only ever the one. */
  const [step, setStep] = useState<"main" | "card">("main");
  /** The first crop, in working-copy pixels, kept so Back can restore it. */
  const [mainCrop, setMainCrop] = useState<CropRect>();

  const circular = owner === "person";
  const aspect = circular ? 1 : step === "card" ? FAMILY_CARD_ASPECT : undefined;

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

  /**
   * The current selection, converted from the rendered <img>'s pixels into
   * working-copy pixels -- the space `renderRenditions` and `cropAtAspect`
   * both want, and the one space a window resize between steps cannot make
   * stale.
   */
  function toWorkingRect(px: PixelCrop): CropRect | null {
    if (!working || !imgRef.current) return null;
    const scaleX = working.width / imgRef.current.width;
    const scaleY = working.height / imgRef.current.height;
    return {
      x: px.x * scaleX,
      y: px.y * scaleY,
      width: px.width * scaleX,
      height: px.height * scaleY,
    };
  }

  /**
   * Sets both `crop` and `pixelCrop` from a rect in working-copy pixels.
   *
   * Needed for every *programmatic* step change. ReactCrop only calls
   * `onComplete` on the one transition from no crop to a crop -- which is
   * what populates `pixelCrop` on first mount with no drag -- so a step
   * change, which goes from one defined crop to another, never fires it
   * again. Left alone, `pixelCrop` would still describe the step just left.
   */
  function applyWorkingRect(rect: CropRect) {
    if (!working || !imgRef.current) return;
    const percent = convertToPercentCrop({ unit: "px", ...rect }, working.width, working.height);
    setCrop(percent);
    setPixelCrop(convertToPixelCrop(percent, imgRef.current.width, imgRef.current.height));
  }

  /** Family only: freezes the first crop and opens the card-shaped second one. */
  function goToCard() {
    if (!working || !pixelCrop) return;
    const rect = toWorkingRect(pixelCrop);
    if (!rect) return;
    setMainCrop(rect);
    applyWorkingRect(
      cropAtAspect(rect, FAMILY_CARD_ASPECT, { width: working.width, height: working.height })
    );
    setStep("card");
  }

  /** Restores the first crop exactly as it was left. */
  function goToMain() {
    if (mainCrop) applyWorkingRect(mainCrop);
    setStep("main");
  }

  async function confirm(): Promise<void> {
    if (!working || !pixelCrop) return;
    const current = toWorkingRect(pixelCrop);
    if (!current) return;
    setBusy(true);
    setError(null);
    try {
      const crops =
        owner === "family" && mainCrop ? { main: mainCrop, card: current } : { main: current };
      const renditions = await renderRenditions(working, crops, owner);
      await onCropped(renditions);
    } catch (err) {
      setError(err instanceof Error ? err.message : "That photo could not be processed.");
      setBusy(false);
    }
  }

  const title =
    owner === "person"
      ? "Position the photo"
      : step === "main"
        ? "Choose what to show"
        : "Frame the directory card";

  const body =
    owner === "person"
      ? "Drag and resize the circle to frame the face."
      : step === "main"
        ? "Drag a box around what the photo should show. Any shape is fine."
        : "This is the shape the photo takes in the families list. Pick any part of the original — it does not have to match the last step.";

  return (
    <Modal wide title={title} onClose={onCancel}>
      <div className="space-y-4">
        <p className="text-ink-muted">{body}</p>

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
              className={step === "card" ? "max-h-[55vh] PhotoCropper--card" : "max-h-[55vh]"}
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
          {owner === "family" && step === "main" ? (
            <Button type="button" onClick={goToCard} disabled={busy || !pixelCrop || !working}>
              Next
            </Button>
          ) : (
            <Button
              type="button"
              onClick={() => void confirm()}
              disabled={busy || !pixelCrop || !working}
            >
              {busy ? "Saving…" : "Save photo"}
            </Button>
          )}
          {owner === "family" && step === "card" && (
            <Button type="button" variant="secondary" onClick={goToMain} disabled={busy}>
              Back
            </Button>
          )}
          <Button variant="ghost" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
        </div>
      </div>
    </Modal>
  );
}

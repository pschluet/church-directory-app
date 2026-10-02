import { MAX_RENDITION_BYTES, type PhotoRendition } from "@shared";

/**
 * Cropping and downscaling in the browser, before anything is uploaded.
 *
 * The point is the sizes. An avatar renders at 56px in a directory card and
 * 144px on a detail page; uploading the untouched original meant a card
 * downloaded up to 5MB to draw a thumbnail. Two renditions go up instead, and
 * the big one is only ever fetched when someone opens the full-screen view.
 *
 * The arithmetic here is deliberately separated from the canvas work: jsdom has
 * no canvas, so the maths is what can actually be tested.
 */

export interface Size {
  width: number;
  height: number;
}

/** A crop rectangle in source-image pixels. */
export interface CropRect extends Size {
  x: number;
  y: number;
}

/**
 * The largest canvas iOS Safari will accept.
 *
 * Above this it does not throw -- it hands back a blank canvas, so the photo
 * saves black with no error anywhere. Anything sized from a source photo has to
 * stay under it. See MAX_WORKING_PIXELS.
 */
export const MAX_CANVAS_PIXELS = 16_777_216;

/**
 * The pixel budget for the working copy every crop is taken from.
 *
 * Half the iOS ceiling, so there is room for the browser's own allocations, and
 * 32MB of canvas. Sized against RENDITION_LIMITS rather than picked round: a 3:2
 * photo becomes 3464x2309, and the largest rendition is the family `full` at
 * 1600px, so any crop covering roughly 46% of the frame or more still fills it
 * exactly. Tighter crops get softer, which is true of cropping in general.
 *
 * Raising this trades memory for sharpness on tight crops. It must stay below
 * MAX_CANVAS_PIXELS.
 */
export const MAX_WORKING_PIXELS = 8_000_000;

/** What a photo is for, which is what decides how large its renditions are. */
export type RenditionOwner = "person" | "family" | "attachment";

/** The long edge each rendition is allowed, per owner kind. */
export const RENDITION_LIMITS: Record<RenditionOwner, Record<PhotoRendition, number>> = {
  // Square, and shown at 144px at most -- 320 covers that at 2x with headroom.
  // The full size is for the lightbox.
  person: { thumb: 320, full: 1024 },
  // Free-form, and shown considerably larger than an avatar.
  family: { thumb: 800, full: 1600 },
  // A prayer request attachment. The thumbnail is a strip tile on a card, so it
  // is smaller than a family photo's; the full size matches, because both end
  // up in the same lightbox.
  attachment: { thumb: 480, full: 1600 },
};

export const RENDITION_QUALITY: Record<PhotoRendition, number> = {
  thumb: 0.82,
  full: 0.85,
};

/** The families-page card's aspect ratio. Must match --aspect-card-photo. */
export const FAMILY_CARD_ASPECT = 3 / 2;

/**
 * The long edge of the families-page card rendition: 800 gives 800x533 at 3:2,
 * which covers the widest card (a ~400px column at lg) on a 2x screen. Same
 * number as the family `thumb` for the same reason.
 */
export const CARD_RENDITION_LIMIT = 800;

/**
 * Scales a size down to fit a square of `max`, preserving aspect ratio. Never
 * upscales: a small source stays small rather than being interpolated up to a
 * larger file for no extra detail.
 */
export function fitWithin(size: Size, max: number): Size {
  const longest = Math.max(size.width, size.height);
  if (longest <= max) return { width: Math.round(size.width), height: Math.round(size.height) };
  const scale = max / longest;
  return {
    width: Math.max(1, Math.round(size.width * scale)),
    height: Math.max(1, Math.round(size.height * scale)),
  };
}

/**
 * Scales a size down to fit within a total pixel count, preserving aspect ratio.
 *
 * Area rather than long edge, because what matters is memory and the canvas
 * ceiling -- both of which scale with width times height. A panorama is wide but
 * cheap; capping its long edge would shrink it far more than necessary.
 */
export function fitWithinPixels(size: Size, maxPixels: number): Size {
  const pixels = size.width * size.height;
  if (pixels <= maxPixels) {
    return { width: Math.round(size.width), height: Math.round(size.height) };
  }
  const scale = Math.sqrt(maxPixels / pixels);
  return {
    width: Math.max(1, Math.floor(size.width * scale)),
    height: Math.max(1, Math.floor(size.height * scale)),
  };
}

/**
 * Clamps a crop to the image it came from.
 *
 * react-image-crop reports in the coordinate space of the rendered <img>, and a
 * rounded or dragged-past-the-edge rectangle can end up a pixel or two outside
 * the source. Drawing that leaves a transparent sliver down one side.
 */
export function clampCrop(crop: CropRect, source: Size): CropRect {
  const width = Math.max(1, Math.min(Math.round(crop.width), source.width));
  const height = Math.max(1, Math.min(Math.round(crop.height), source.height));
  return {
    x: Math.max(0, Math.min(Math.round(crop.x), source.width - width)),
    y: Math.max(0, Math.min(Math.round(crop.y), source.height - height)),
    width,
    height,
  };
}

/**
 * The smallest rectangle of `aspect` that contains `crop`, centred on it and
 * pulled inside `bounds`.
 *
 * This is where the families-page card crop opens. Growing the short side
 * rather than shrinking the long one means nothing the uploader framed in the
 * first crop is lost, so confirming straight through shows the subject they
 * already chose. A cover rectangle can be larger than the image -- a tall crop
 * of a portrait photo, say -- so it is scaled back on the ratio before being
 * clamped; `clampCrop` caps the axes independently and would otherwise
 * flatten it off-ratio.
 */
export function cropAtAspect(crop: CropRect, aspect: number, bounds: Size): CropRect {
  let width = Math.max(crop.width, crop.height * aspect);
  let height = width / aspect;
  const scale = Math.min(1, bounds.width / width, bounds.height / height);
  width *= scale;
  height *= scale;
  const cx = crop.x + crop.width / 2;
  const cy = crop.y + crop.height / 2;
  return clampCrop({ x: cx - width / 2, y: cy - height / 2, width, height }, bounds);
}

/** The output size for one rendition of a crop. */
export function renditionSize(crop: Size, owner: RenditionOwner, rendition: PhotoRendition): Size {
  return fitWithin(crop, RENDITION_LIMITS[owner][rendition]);
}

/**
 * The format renditions are encoded as.
 *
 * Every engine in use encodes WebP, but `toBlob` falls back to PNG for a type it
 * cannot produce -- silently, and a PNG photo is several times the size. So
 * check rather than assume, and prefer JPEG over an unasked-for PNG.
 */
let cachedType: "image/webp" | "image/jpeg" | undefined;
export function encodeType(): "image/webp" | "image/jpeg" {
  if (cachedType) return cachedType;
  try {
    const canvas = document.createElement("canvas");
    canvas.width = 1;
    canvas.height = 1;
    cachedType = canvas.toDataURL("image/webp").startsWith("data:image/webp")
      ? "image/webp"
      : "image/jpeg";
  } catch {
    cachedType = "image/jpeg";
  }
  return cachedType;
}

/** The bounded copy of a photo that the crop UI and the final render share. */
export interface WorkingImage {
  canvas: HTMLCanvasElement;
  width: number;
  height: number;
}

/**
 * Decodes a photo, orients it, and downscales it to a bounded working copy.
 *
 * Two things are being solved at once.
 *
 * Orientation has to be normalised before the crop UI sees the image, not after.
 * A browser rotates an <img> according to EXIF when it renders it, but
 * `drawImage` of the same element does not reliably do the same -- so a phone
 * photo would be cropped in one orientation and saved in another. Normalising up
 * front means every coordinate afterwards is in one space.
 *
 * Size has to be bounded because the decoded original can be enormous: a 48MP
 * phone photo is around 195MB of RGBA, and a canvas that size is nearly 3x over
 * the limit iOS Safari silently returns a blank canvas above. So the full-size
 * bitmap is never drawn anywhere near a canvas -- it is downscaled in a single
 * drawImage into a canvas already inside MAX_WORKING_PIXELS, then released.
 *
 * The decode itself cannot be made cheaper: createImageBitmap's resizeWidth /
 * resizeHeight / resizeQuality options would let the browser decode straight to
 * a smaller bitmap, but Safari implements none of them. That is why the caller
 * still needs a byte ceiling on the file someone picks.
 */
export async function loadWorkingImage(file: File): Promise<WorkingImage> {
  const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  try {
    const out = fitWithinPixels({ width: bitmap.width, height: bitmap.height }, MAX_WORKING_PIXELS);

    const canvas = document.createElement("canvas");
    canvas.width = out.width;
    canvas.height = out.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Could not process that image");
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    // One step, straight from the decoded bitmap to the working size. Drawing at
    // full size first is what used to blow past the iOS canvas limit.
    ctx.drawImage(bitmap, 0, 0, bitmap.width, bitmap.height, 0, 0, out.width, out.height);

    return { canvas, width: out.width, height: out.height };
  } finally {
    // Release the large allocation promptly, and even if the draw threw.
    bitmap.close();
  }
}

/**
 * A displayable copy of the working image, for the crop UI's <img>.
 *
 * Encoded rather than handed the original file, because the original still
 * carries its EXIF orientation: the browser would apply it to the <img> on top
 * of the rotation already baked into the working canvas, and the crop would be
 * framed against a differently-oriented image than the one drawn. Encoded as
 * WebP rather than canvas.toBlob()'s default PNG, which for a large photo is a
 * lossless re-encode of the whole thing.
 */
export function workingPreviewBlob(working: WorkingImage): Promise<Blob> {
  return toBlob(working.canvas, encodeType(), 0.92);
}

function drawTo(source: CanvasImageSource, crop: CropRect, out: Size): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = out.width;
  canvas.height = out.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Could not process that image");
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(source, crop.x, crop.y, crop.width, crop.height, 0, 0, out.width, out.height);
  return canvas;
}

function toBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("Could not process that image"))),
      type,
      quality
    );
  });
}

/** The two crops a render can draw from. */
export interface RenderCrops {
  /** Framed for the subject's own page; what `thumb` and `full` are drawn from. */
  main: CropRect;
  /**
   * Framed for the families-page card. Families only, and taken from the
   * whole image rather than from `main`.
   */
  card?: CropRect;
}

export interface Renditions {
  contentType: "image/webp" | "image/jpeg";
  blobs: { thumb: Blob; full: Blob; card?: Blob };
  /**
   * The `full` rendition's size -- the *main* crop's -- so the UI can reserve
   * its box. The card's ratio is fixed, so it needs no dimensions of its own.
   */
  size: Size;
}

async function renderOne(
  source: WorkingImage,
  rawCrop: CropRect,
  out: Size,
  contentType: "image/webp" | "image/jpeg",
  quality: number
): Promise<Blob> {
  const crop = clampCrop(rawCrop, { width: source.width, height: source.height });
  const blob = await toBlob(drawTo(source.canvas, crop, out), contentType, quality);
  if (blob.size > MAX_RENDITION_BYTES) {
    // The server caps this too; failing here gives a message that names the
    // photo rather than a 400 from a presign call.
    throw new Error("That photo is too detailed to process. Try a smaller crop.");
  }
  return blob;
}

/**
 * Renders a crop into both renditions, and a second crop into a third if the
 * caller is framing a families-page card.
 *
 * Downscaling in one step from the source rather than chaining thumb-from-full:
 * the crop is at most a few thousand pixels either way, so the extra quality
 * from a stepped resize is not worth a second decode.
 */
export async function renderRenditions(
  source: WorkingImage,
  crops: RenderCrops,
  owner: RenditionOwner
): Promise<Renditions> {
  const bounds = { width: source.width, height: source.height };
  const main = clampCrop(crops.main, bounds);
  const contentType = encodeType();

  const [thumb, full] = await Promise.all([
    renderOne(
      source,
      main,
      renditionSize(main, owner, "thumb"),
      contentType,
      RENDITION_QUALITY.thumb
    ),
    renderOne(
      source,
      main,
      renditionSize(main, owner, "full"),
      contentType,
      RENDITION_QUALITY.full
    ),
  ]);

  let card: Blob | undefined;
  if (crops.card) {
    const rect = clampCrop(crops.card, bounds);
    card = await renderOne(
      source,
      rect,
      fitWithin(rect, CARD_RENDITION_LIMIT),
      contentType,
      RENDITION_QUALITY.thumb
    );
  }

  return {
    contentType,
    blobs: { thumb, full, ...(card ? { card } : {}) },
    size: renditionSize(main, owner, "full"),
  };
}

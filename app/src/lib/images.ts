import { MAX_RENDITION_BYTES, PHOTO_RENDITIONS, type PhotoRendition } from "@shared";

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

/** The long edge each rendition is allowed, per owner kind. */
export const RENDITION_LIMITS: Record<"person" | "family", Record<PhotoRendition, number>> = {
  // Square, and shown at 144px at most -- 320 covers that at 2x with headroom.
  // The full size is for the lightbox.
  person: { thumb: 320, full: 1024 },
  // Free-form, and shown considerably larger than an avatar.
  family: { thumb: 800, full: 1600 },
};

export const RENDITION_QUALITY: Record<PhotoRendition, number> = {
  thumb: 0.82,
  full: 0.85,
};

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

/** The output size for one rendition of a crop. */
export function renditionSize(
  crop: Size,
  owner: "person" | "family",
  rendition: PhotoRendition
): Size {
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

/**
 * Decodes a file with its EXIF orientation already applied.
 *
 * This has to happen before the crop UI sees the image, not after. A browser
 * rotates an <img> according to EXIF when it renders it, but `drawImage` of the
 * same element does not reliably do the same -- so a phone photo would be
 * cropped in one orientation and saved in another. Normalising up front means
 * every coordinate afterwards is in one space.
 */
export async function decodeOriented(file: File): Promise<ImageBitmap> {
  return createImageBitmap(file, { imageOrientation: "from-image" });
}

function drawTo(source: ImageBitmap, crop: CropRect, out: Size): HTMLCanvasElement {
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

export interface Renditions {
  contentType: "image/webp" | "image/jpeg";
  blobs: Record<PhotoRendition, Blob>;
  /** The `full` rendition's size, stored so the UI can reserve its box. */
  size: Size;
}

/**
 * Renders a crop into both renditions.
 *
 * Downscaling in one step from the source rather than chaining thumb-from-full:
 * the crop is at most a few thousand pixels either way, so the extra quality
 * from a stepped resize is not worth a second decode.
 */
export async function renderRenditions(
  source: ImageBitmap,
  rawCrop: CropRect,
  owner: "person" | "family"
): Promise<Renditions> {
  const crop = clampCrop(rawCrop, { width: source.width, height: source.height });
  const contentType = encodeType();

  const entries = await Promise.all(
    PHOTO_RENDITIONS.map(async (rendition) => {
      const out = renditionSize(crop, owner, rendition);
      const blob = await toBlob(
        drawTo(source, crop, out),
        contentType,
        RENDITION_QUALITY[rendition]
      );
      if (blob.size > MAX_RENDITION_BYTES) {
        // The server caps this too; failing here gives a message that names the
        // photo rather than a 400 from a presign call.
        throw new Error("That photo is too detailed to process. Try a smaller crop.");
      }
      return [rendition, blob] as const;
    })
  );

  return {
    contentType,
    blobs: Object.fromEntries(entries) as Record<PhotoRendition, Blob>,
    size: renditionSize(crop, owner, "full"),
  };
}

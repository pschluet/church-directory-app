/**
 * Handing a file to the browser's own download, and naming it.
 *
 * Two small pieces that were born inside `vcard.ts`, the app's first download,
 * and pulled out here when the event flyer and QR code became the second and
 * third: each of them would otherwise have grown its own copy of the
 * blob-and-anchor dance and its own idea of which characters a filesystem
 * rejects.
 */

/**
 * Saves a blob under a filename, via a throwaway `<a download>`.
 *
 * There is no cross-browser API for "save this" other than clicking a link, and
 * Safari wants the link attached to the document before it will honour the
 * click. The object URL is revoked straight after: the click has already handed
 * the blob to the browser, and holding it would pin the whole file in memory
 * for the life of the page.
 */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

/**
 * A name with everything a filesystem objects to removed, or `fallback` if that
 * leaves nothing.
 *
 * Strips rather than replaces: `A/B` becoming `AB` is a worse name than it
 * could be, but never a surprising one, and the user can rename the file. The
 * extension is the caller's to add -- this only ever sees the part a person
 * typed.
 */
export function safeFilename(name: string, fallback: string): string {
  const cleaned = name
    // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "")
    .trim();
  return cleaned || fallback;
}

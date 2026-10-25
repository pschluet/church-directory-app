import type { PersonDto, SpecialDateDto } from "@shared";
import { downloadBlob, safeFilename } from "./download";
import { fullName } from "./format";

/**
 * Turning a person into a contact card, so a member can save them to their
 * phone.
 *
 * vCard 3.0, because iOS, macOS and Google Contacts all import it reliably.
 * Built from the record already on screen: the API has already withheld
 * anything this viewer may not see (a hidden birth year arrives as `null`), so
 * nothing here needs to ask who is looking.
 */

export interface VCardPhoto {
  base64: string;
}

/** The longest edge of an embedded photo; a contact card has no use for more. */
const PHOTO_MAX_EDGE = 512;

/** Apple's own marker for "no year", which its Contacts reads as a day and month only. */
const OMIT_YEAR = "1604";

/** RFC 2426 escaping for a text value. */
function escapeText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/\r?\n/g, "\\n")
    .replace(/,/g, "\\,")
    .replace(/;/g, "\\;");
}

/**
 * Lines are limited to 75 octets; a longer one continues on the next line after
 * a single space. Counted in UTF-8 bytes, and never split inside a character.
 */
function fold(line: string): string {
  const encoder = new TextEncoder();
  if (encoder.encode(line).length <= 75) return line;
  const parts: string[] = [];
  let current = "";
  let bytes = 0;
  // The continuation lines start with a space, which counts against the limit.
  let limit = 75;
  for (const char of line) {
    const size = encoder.encode(char).length;
    if (bytes + size > limit) {
      parts.push(current);
      current = "";
      bytes = 0;
      limit = 74;
    }
    current += char;
    bytes += size;
  }
  parts.push(current);
  return parts.join("\r\n ");
}

const two = (n: number): string => String(n).padStart(2, "0");

/** The date as vCard wants it, and whether the year is real or Apple's placeholder. */
function dateValue(date: SpecialDateDto): { value: string; omitYear: boolean } {
  const omitYear = date.year == null;
  const year = omitYear ? OMIT_YEAR : String(date.year).padStart(4, "0");
  return { value: `${year}-${two(date.month)}-${two(date.day)}`, omitYear };
}

/**
 * Apple wraps its built-in labels as `_$!<Anniversary>!$_` and shows them
 * localised; anything else is a custom label and must be plain text, or the
 * wrapper is displayed literally.
 */
const EXTRA_DATE_LABELS: Record<string, string> = {
  ANNIVERSARY: "_$!<Anniversary>!$_",
  FEAST_DAY: "name day",
};

export function buildVCard(person: PersonDto, photo?: VCardPhoto | null): string {
  const lines: string[] = ["BEGIN:VCARD", "VERSION:3.0"];

  lines.push(`N:${escapeText(person.lastName ?? "")};${escapeText(person.firstName)};;;`);
  lines.push(`FN:${escapeText(fullName(person))}`);

  if (person.phone) lines.push(`TEL;TYPE=CELL:${escapeText(person.phone)}`);
  if (person.altPhone) lines.push(`TEL;TYPE=VOICE:${escapeText(person.altPhone)}`);
  if (person.email) lines.push(`EMAIL;TYPE=INTERNET:${escapeText(person.email)}`);

  if (person.occupation) lines.push(`TITLE:${escapeText(person.occupation)}`);

  const street = [person.addressLine1, person.addressLine2].filter(Boolean).join(", ");
  const address = [street, person.city, person.state, person.postalCode, person.country];
  if (address.some((part) => part?.trim())) {
    lines.push(`ADR;TYPE=HOME:;;${address.map((part) => escapeText(part ?? "")).join(";")}`);
  }

  const birthday = person.specialDates.find((date) => date.type === "BIRTHDAY");
  if (birthday) {
    const { value, omitYear } = dateValue(birthday);
    lines.push(omitYear ? `BDAY;X-APPLE-OMIT-YEAR=${OMIT_YEAR}:${value}` : `BDAY:${value}`);
  }

  let item = 0;
  for (const date of person.specialDates) {
    const label = EXTRA_DATE_LABELS[date.type];
    if (!label) continue;
    item += 1;
    const { value, omitYear } = dateValue(date);
    lines.push(
      omitYear
        ? `item${item}.X-ABDATE;X-APPLE-OMIT-YEAR=${OMIT_YEAR}:${value}`
        : `item${item}.X-ABDATE:${value}`,
      `item${item}.X-ABLabel:${label}`
    );
  }

  if (photo) lines.push(`PHOTO;ENCODING=b;TYPE=JPEG:${photo.base64}`);

  lines.push("END:VCARD");
  return `${lines.map(fold).join("\r\n")}\r\n`;
}

/** `Layla Haddad.vcf`, minus anything a filesystem objects to. */
export function vCardFilename(person: PersonDto): string {
  return `${safeFilename(fullName(person), "contact")}.vcf`;
}

/**
 * The photo as base64 JPEG, or null if it cannot be had. Contacts apps do not
 * reliably take WebP, which is what is stored, so it is redrawn on a canvas.
 * Best effort by design: a card without a picture beats no card.
 */
async function loadPhotoAsJpegBase64(url: string | null): Promise<VCardPhoto | null> {
  if (!url) return null;
  try {
    const response = await fetch(url, { credentials: "same-origin" });
    if (!response.ok) return null;
    const bitmap = await createImageBitmap(await response.blob());
    const scale = Math.min(1, PHOTO_MAX_EDGE / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext("2d");
    if (!context) return null;
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close?.();
    const dataUrl = canvas.toDataURL("image/jpeg", 0.9);
    const prefix = "data:image/jpeg;base64,";
    return dataUrl.startsWith(prefix) ? { base64: dataUrl.slice(prefix.length) } : null;
  } catch {
    return null;
  }
}

export async function downloadVCard(person: PersonDto): Promise<void> {
  const photo = await loadPhotoAsJpegBase64(person.fullUrl ?? person.thumbUrl);
  const blob = new Blob([buildVCard(person, photo)], { type: "text/vcard;charset=utf-8" });
  downloadBlob(blob, vCardFilename(person));
}

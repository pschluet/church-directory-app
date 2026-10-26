import { downloadBlob, safeFilename } from "./download";
import { formatEventTimes, parseIsoDate } from "./format";
import { QR_QUIET_ZONE, qrModules, qrRuns } from "./qr";

/**
 * A one-page US-letter flyer for an event, as a PDF made entirely in the
 * browser.
 *
 * Split in two on purpose. `flyerLayout` is pure: it decides every box,
 * baseline and wrapped line as plain numbers. `downloadEventFlyer` is the thin
 * shell that replays that layout into jsPDF. jsdom has no canvas, so the
 * pixels cannot be tested, but the maths -- does it fit, does the description
 * clip, does anything cross a margin -- can be, and that is where flyers go
 * wrong (the convention `images.ts` sets). jsPDF is imported lazily, inside
 * `downloadEventFlyer`, so it stays out of the precached shell.
 *
 * Set in Helvetica, jsPDF's built-in. The app's own face, `@fontsource/karla`,
 * ships only woff2, which jsPDF cannot embed; embedding a Karla TTF would need
 * a new fixed-name asset threaded through the cache lists in deploy.yml. Later,
 * not now.
 *
 * Coordinates are PDF points (1/72 in) with the origin at the page's top-left
 * and y growing downwards, as jsPDF uses. Text `y` is the baseline.
 */

export interface FlyerEvent {
  title: string;
  description: string | null;
  /** yyyy-mm-dd, a calendar date with no timezone. */
  eventDate: string;
  /** HH:MM, 24-hour. */
  startTime: string | null;
  endTime: string | null;
  location: string | null;
  organizationName: string;
  cancelled?: boolean;
}

/**
 * How text is measured, injected so the layout does not need a jsPDF instance.
 *
 * jsPDF's `splitTextToSize` lives on the document, and a test cannot make one
 * without loading the library. A test passes a deterministic fake instead
 * (say, every character `fontSize * 0.5` wide), which also makes the expected
 * line breaks easy to work out by hand.
 */
export interface TextMeasure {
  /** Wraps one paragraph (no newlines) to `maxWidth` points. */
  split(text: string, maxWidth: number, fontSize: number, bold?: boolean): string[];
  /** The width in points of a single line. */
  width(text: string, fontSize: number, bold?: boolean): number;
}

export interface FlyerText {
  text: string;
  x: number;
  /** The baseline. */
  y: number;
  size: number;
  bold: boolean;
  align: "left" | "center";
}

export interface FlyerBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface FlyerRow {
  label: FlyerText;
  value: FlyerText[];
}

export interface FlyerLayout {
  page: { width: number; height: number };
  margin: number;
  /** The coloured band across the top, full bleed. */
  band: FlyerBox;
  organization: FlyerText[];
  /** The "CANCELLED" stamp, when the event is cancelled. */
  cancelled: { box: FlyerBox; text: FlyerText } | null;
  title: FlyerText[];
  rule: FlyerBox;
  rows: FlyerRow[];
  description: FlyerText[];
  /** True when the description was cut short and ends in an ellipsis. */
  descriptionClipped: boolean;
  /**
   * The QR symbol and its quiet zone: a `size` square whose modules are
   * `scale` points wide, so the symbol starts `QR_QUIET_ZONE * scale` inside.
   */
  qr: { x: number; y: number; size: number; scale: number; moduleCount: number };
  caption: FlyerText;
  url: FlyerText[];
}

export const PAGE = { width: 612, height: 792 } as const;
export const MARGIN = 54;
/** About two inches, big enough to scan from a bulletin board. */
export const QR_SIZE = 144;

const COLOR = {
  /** `--color-primary` */
  primary: "#b42d23",
  /** `--color-accent` */
  accent: "#b88c51",
  /** `--color-ink` */
  ink: "#333333",
  white: "#ffffff",
} as const;

const TITLE_SIZE = 34;
const TITLE_LEADING = 40;
const TITLE_MAX_LINES = 4;
const ORG_SIZE = 20;
const ORG_LEADING = 24;
const ROW_LABEL_SIZE = 10;
const ROW_VALUE_SIZE = 16;
const ROW_LEADING = 21;
const LABEL_WIDTH = 84;
const DESCRIPTION_SIZE = 12;
const DESCRIPTION_LEADING = 16;
const CAPTION_SIZE = 14;
const URL_SIZE = 9;
const URL_LEADING = 11;
const ELLIPSIS = "…";

/** "Sunday, November 2, 2026". The year is always there: a flyer outlives the week it is made in. */
export function formatFlyerDate(iso: string): string {
  return parseIsoDate(iso).toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

/** Wraps text that may contain newlines, keeping blank lines as paragraph gaps. */
function wrapParagraphs(
  text: string,
  maxWidth: number,
  size: number,
  measure: TextMeasure,
  bold = false
): string[] {
  return text
    .replace(/\r\n?/g, "\n")
    .trim()
    .split("\n")
    .flatMap((paragraph) =>
      paragraph.trim() === "" ? [""] : measure.split(paragraph.trim(), maxWidth, size, bold)
    );
}

/**
 * Keeps the first `maxLines` lines, the last of them ending in an ellipsis.
 *
 * The ellipsis is made to fit by trimming the kept line, not by overflowing it:
 * a line already at full width plus a "…" would run past the right margin.
 */
function clampLines(
  lines: string[],
  maxLines: number,
  maxWidth: number,
  size: number,
  measure: TextMeasure,
  bold = false
): { lines: string[]; clipped: boolean } {
  if (lines.length <= maxLines) return { lines, clipped: false };
  if (maxLines <= 0) return { lines: [], clipped: true };
  const kept = lines.slice(0, maxLines);
  let last = (kept[maxLines - 1] ?? "").trimEnd().replace(/[.,;:!?\-–—]+$/, "");
  while (last.length > 0 && measure.width(last + ELLIPSIS, size, bold) > maxWidth) {
    last = last.slice(0, -1).trimEnd();
  }
  kept[maxLines - 1] = last + ELLIPSIS;
  return { lines: kept, clipped: true };
}

function textLines(
  lines: string[],
  x: number,
  firstBaseline: number,
  leading: number,
  size: number,
  bold: boolean,
  align: "left" | "center" = "left"
): FlyerText[] {
  return lines.map((text, index) => ({
    text,
    x,
    y: firstBaseline + index * leading,
    size,
    bold,
    align,
  }));
}

/**
 * Where everything on the page goes.
 *
 * Laid out top-down (band, title, rule, details, description) with the QR block
 * pinned to the foot, and the description given whatever is left between them.
 * That ordering is the point: a long description is the one thing whose length
 * is unbounded, so it alone is clamped and ellipsised, rather than pushing the
 * QR code onto a second page where nobody would find it. The title is clamped
 * too, as a pathological title would otherwise do the same.
 *
 * `moduleCount` is the QR symbol's side in modules, which sets how large each
 * module is drawn so the whole code (with quiet zone) is `QR_SIZE` square.
 */
export function flyerLayout(
  event: FlyerEvent,
  url: string,
  measure: TextMeasure,
  moduleCount = 29
): FlyerLayout {
  const contentWidth = PAGE.width - 2 * MARGIN;
  const centerX = PAGE.width / 2;

  // The band: the parish name reversed out in white.
  const orgWrapped = clampLines(
    wrapParagraphs(event.organizationName, contentWidth, ORG_SIZE, measure, true),
    2,
    contentWidth,
    ORG_SIZE,
    measure,
    true
  ).lines;
  const bandHeight = 36 + orgWrapped.length * ORG_LEADING;
  const band = { x: 0, y: 0, w: PAGE.width, h: bandHeight };
  // Baselines centred in the band: the cap height sits about 0.7 of the size above.
  const orgFirst = (bandHeight - (orgWrapped.length - 1) * ORG_LEADING) / 2 + ORG_SIZE * 0.35;
  const organization = textLines(orgWrapped, MARGIN, orgFirst, ORG_LEADING, ORG_SIZE, true);

  let cursor = bandHeight + 32;

  let cancelled: FlyerLayout["cancelled"] = null;
  if (event.cancelled) {
    const size = 16;
    const label = "CANCELLED";
    const boxW = measure.width(label, size, true) + 24;
    const box = { x: MARGIN, y: cursor, w: boxW, h: 30 };
    cancelled = {
      box,
      text: {
        text: label,
        x: MARGIN + boxW / 2,
        y: cursor + 20.5,
        size,
        bold: true,
        align: "center",
      },
    };
    cursor += box.h + 16;
  }

  // The title.
  const titleWrapped = clampLines(
    wrapParagraphs(event.title, contentWidth, TITLE_SIZE, measure, true),
    TITLE_MAX_LINES,
    contentWidth,
    TITLE_SIZE,
    measure,
    true
  ).lines;
  const title = textLines(
    titleWrapped,
    MARGIN,
    cursor + TITLE_SIZE * 0.8,
    TITLE_LEADING,
    TITLE_SIZE,
    true
  );
  cursor += titleWrapped.length * TITLE_LEADING + 8;

  const rule = { x: MARGIN, y: cursor, w: contentWidth, h: 3 };
  cursor += rule.h + 22;

  // Date, time and location as labelled rows.
  const rowSpecs: Array<[string, string]> = [["DATE", formatFlyerDate(event.eventDate)]];
  const times = formatEventTimes(event.startTime, event.endTime);
  if (times) rowSpecs.push(["TIME", times]);
  if (event.location?.trim()) rowSpecs.push(["LOCATION", event.location.trim()]);
  const valueX = MARGIN + LABEL_WIDTH;
  const rows: FlyerRow[] = rowSpecs.map(([label, value]) => {
    const wrapped = clampLines(
      wrapParagraphs(value, contentWidth - LABEL_WIDTH, ROW_VALUE_SIZE, measure),
      3,
      contentWidth - LABEL_WIDTH,
      ROW_VALUE_SIZE,
      measure
    ).lines;
    const top = cursor;
    cursor += wrapped.length * ROW_LEADING + 8;
    return {
      // The label shares its row's first baseline, so the two read as one line.
      label: {
        text: label,
        x: MARGIN,
        y: top + 14,
        size: ROW_LABEL_SIZE,
        bold: true,
        align: "left",
      },
      value: textLines(wrapped, valueX, top + 14, ROW_LEADING, ROW_VALUE_SIZE, false),
    };
  });
  cursor += 6;

  // The foot, laid out upward from the bottom margin.
  const urlWrapped = clampLines(
    wrapParagraphs(url, contentWidth, URL_SIZE, measure),
    2,
    contentWidth,
    URL_SIZE,
    measure
  ).lines;
  const lastUrlBaseline = PAGE.height - MARGIN;
  const firstUrlBaseline = lastUrlBaseline - (urlWrapped.length - 1) * URL_LEADING;
  const captionBaseline = firstUrlBaseline - 16;
  const qrBottom = captionBaseline - CAPTION_SIZE * 0.75 - 6;
  const qrTop = qrBottom - QR_SIZE;
  const scale = QR_SIZE / (moduleCount + 2 * QR_QUIET_ZONE);

  // The description gets what is left above the QR block.
  const descriptionLimit = qrTop - 18;
  const maxLines = Math.floor((descriptionLimit - cursor) / DESCRIPTION_LEADING);
  const wrapped = event.description?.trim()
    ? wrapParagraphs(event.description, contentWidth, DESCRIPTION_SIZE, measure)
    : [];
  const clamped = clampLines(wrapped, maxLines, contentWidth, DESCRIPTION_SIZE, measure);
  const description = textLines(
    clamped.lines,
    MARGIN,
    cursor + DESCRIPTION_SIZE * 0.8,
    DESCRIPTION_LEADING,
    DESCRIPTION_SIZE,
    false
  );

  return {
    page: { ...PAGE },
    margin: MARGIN,
    band,
    organization,
    cancelled,
    title,
    rule,
    rows,
    description,
    descriptionClipped: clamped.clipped,
    qr: { x: centerX - QR_SIZE / 2, y: qrTop, size: QR_SIZE, scale, moduleCount },
    caption: {
      text: "Scan to RSVP",
      x: centerX,
      y: captionBaseline,
      size: CAPTION_SIZE,
      bold: true,
      align: "center",
    },
    url: textLines(urlWrapped, centerX, firstUrlBaseline, URL_LEADING, URL_SIZE, false, "center"),
  };
}

/** `#rrggbb` as the three channels jsPDF's colour setters take. */
function rgb(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/**
 * Builds the flyer and offers it as `<title>.pdf`.
 *
 * The QR code is drawn as vector rectangles from the same runs the on-screen
 * SVG uses, not embedded as a bitmap: it stays razor sharp however the PDF is
 * scaled or printed. `url` is always what the code encodes.
 */
export async function downloadEventFlyer(event: FlyerEvent, url: string): Promise<void> {
  const [{ jsPDF }, modules] = await Promise.all([import("jspdf"), qrModules(url)]);
  const doc = new jsPDF({ unit: "pt", format: "letter" });

  const font = (size: number, bold: boolean) => {
    doc.setFont("helvetica", bold ? "bold" : "normal");
    doc.setFontSize(size);
  };
  const measure: TextMeasure = {
    split(text, maxWidth, size, bold = false) {
      font(size, bold);
      return doc.splitTextToSize(text, maxWidth) as string[];
    },
    width(text, size, bold = false) {
      font(size, bold);
      return doc.getTextWidth(text);
    },
  };

  const layout = flyerLayout(event, url, measure, modules.length);
  const draw = (line: FlyerText, color: string) => {
    font(line.size, line.bold);
    doc.setTextColor(...rgb(color));
    doc.text(line.text, line.x, line.y, { align: line.align });
  };

  doc.setFillColor(...rgb(COLOR.primary));
  doc.rect(layout.band.x, layout.band.y, layout.band.w, layout.band.h, "F");
  for (const line of layout.organization) draw(line, COLOR.white);

  if (layout.cancelled) {
    const { box, text } = layout.cancelled;
    doc.setDrawColor(...rgb(COLOR.primary));
    doc.setLineWidth(2);
    doc.rect(box.x, box.y, box.w, box.h, "S");
    draw(text, COLOR.primary);
  }

  for (const line of layout.title) draw(line, COLOR.ink);

  doc.setFillColor(...rgb(COLOR.accent));
  doc.rect(layout.rule.x, layout.rule.y, layout.rule.w, layout.rule.h, "F");

  for (const row of layout.rows) {
    draw(row.label, COLOR.accent);
    for (const line of row.value) draw(line, COLOR.ink);
  }
  for (const line of layout.description) draw(line, COLOR.ink);

  // One path, filled once, rather than a rect per run. Separate rects are each
  // anti-aliased on their own, so two that merely touch leave a hairline seam
  // between rows -- visible on screen, liable to print, and noise to a
  // scanner. Every subpath winds the same way, so a nonzero fill is their
  // union.
  doc.setFillColor(0, 0, 0);
  const { qr } = layout;
  const origin = QR_QUIET_ZONE * qr.scale;
  for (const run of qrRuns(modules)) {
    const x = qr.x + origin + run.x * qr.scale;
    const y = qr.y + origin + run.y * qr.scale;
    const w = run.w * qr.scale;
    doc
      .moveTo(x, y)
      .lineTo(x + w, y)
      .lineTo(x + w, y + qr.scale)
      .lineTo(x, y + qr.scale)
      .close();
  }
  doc.fill();
  draw(layout.caption, COLOR.ink);
  for (const line of layout.url) draw(line, COLOR.ink);

  downloadBlob(doc.output("blob"), `${safeFilename(event.title, "event")}.pdf`);
}

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type FlyerEvent,
  type FlyerLayout,
  type TextMeasure,
  downloadEventFlyer,
  flyerLayout,
  formatFlyerDate,
  glyphWidth,
  graphemes,
  textRuns,
  wrapLine,
} from "../src/lib/eventFlyer";
import { stubDownload } from "./utils";

/** Every character is half its font size wide, so wrapping is easy to predict. */
const fake: TextMeasure = {
  width: (text, size) => text.length * size * 0.5,
  split(text, maxWidth, size) {
    const perLine = Math.max(1, Math.floor(maxWidth / (size * 0.5)));
    const lines: string[] = [];
    let current = "";
    for (const word of text.split(" ")) {
      const next = current ? `${current} ${word}` : word;
      if (next.length > perLine && current) {
        lines.push(current);
        current = word;
      } else {
        current = next;
      }
    }
    if (current) lines.push(current);
    return lines;
  },
};

const URL = "https://example.org/e/abc123";

function event(overrides: Partial<FlyerEvent> = {}): FlyerEvent {
  return {
    title: "Parish Picnic",
    description: "Bring a dish to share.",
    eventDate: "2026-11-02",
    startTime: "18:00",
    endTime: "20:00",
    location: "St. Mary Hall",
    organizationName: "St. Mary Parish",
    cancelled: false,
    ...overrides,
  };
}

function allText(layout: FlyerLayout) {
  return [
    ...layout.organization,
    ...(layout.cancelled ? [layout.cancelled.text] : []),
    ...layout.title,
    ...layout.rows.flatMap((row) => [row.label, ...row.value]),
    ...layout.description,
    layout.caption,
    ...layout.url,
  ];
}

describe("formatFlyerDate", () => {
  it("spells the day out in full, with the year", () => {
    expect(formatFlyerDate("2026-11-02")).toBe("Monday, November 2, 2026");
  });
});

describe("textRuns", () => {
  it("splits emoji out of Helvetica text, one grapheme per glyph", () => {
    expect(textRuns("bowling 🎳")).toEqual([
      { kind: "text", text: "bowling " },
      { kind: "glyph", text: "🎳" },
    ]);
    expect(textRuns("👨‍👩‍👧‍👦🇺🇸❤️").map((r) => r.text)).toEqual(["👨‍👩‍👧‍👦", "🇺🇸", "❤️"]);
  });

  it("keeps WinAnsi punctuation and accents as text", () => {
    expect(textRuns("Café – “hi”… €5 ™")).toEqual([{ kind: "text", text: "Café – “hi”… €5 ™" }]);
  });

  it("keeps other scripts Helvetica lacks together as one run", () => {
    expect(textRuns("Καλή αντάμωση! 🎳")).toEqual([
      { kind: "script", text: "Καλή" },
      { kind: "text", text: " " },
      { kind: "script", text: "αντάμωση" },
      { kind: "text", text: "! " },
      { kind: "glyph", text: "🎳" },
    ]);
  });
});

describe("wrapLine", () => {
  const width = (t: string) => graphemes(t).length;
  it("wraps on words", () => {
    expect(wrapLine("aa bb cc", 5, width)).toEqual(["aa bb", "cc"]);
  });
  it("breaks an over-long word between graphemes", () => {
    expect(wrapLine("🎳🎳🎳", 2, width)).toEqual(["🎳🎳", "🎳"]);
  });
});

describe("flyerLayout", () => {
  it("lays out the labelled rows", () => {
    const layout = flyerLayout(event(), URL, fake);
    expect(layout.rows.map((row) => row.label.text)).toEqual(["DATE", "TIME", "LOCATION"]);
    expect(layout.rows[1]?.value[0]?.text).toBe("6:00 – 8:00 PM");
  });

  it("leaves out rows with nothing to say", () => {
    const layout = flyerLayout(
      event({ startTime: null, endTime: null, location: null }),
      URL,
      fake
    );
    expect(layout.rows.map((row) => row.label.text)).toEqual(["DATE"]);
  });

  it("keeps all text inside the margins and the page", () => {
    const layout = flyerLayout(event({ title: "A very long title ".repeat(8) }), URL, fake);
    for (const line of allText(layout)) {
      const width = fake.width(line.text, line.size);
      const left = line.align === "center" ? line.x - width / 2 : line.x;
      expect(left).toBeGreaterThanOrEqual(layout.margin - 0.01);
      expect(left + width).toBeLessThanOrEqual(layout.page.width - layout.margin + 0.01);
      expect(line.y).toBeLessThanOrEqual(layout.page.height - layout.margin + 0.01);
    }
  });

  it("wraps a long title over several lines", () => {
    const layout = flyerLayout(
      event({ title: "Annual Parish Picnic and Summer Celebration" }),
      URL,
      fake
    );
    expect(layout.title.length).toBeGreaterThan(1);
  });

  it("heads the page with the parish name over a thin rule, no solid band", () => {
    const layout = flyerLayout(event(), URL, fake);
    const { headerRule, margin, page } = layout;
    expect(headerRule.x).toBe(margin);
    expect(headerRule.w).toBe(page.width - 2 * margin);
    expect(headerRule.h).toBeLessThanOrEqual(1.5);
    expect(layout.organization.at(-1)!.y).toBeLessThan(headerRule.y);
    expect(layout.title[0]!.y - layout.title[0]!.size).toBeGreaterThan(headerRule.y);
  });

  it("wraps and clips a description with emoji without breaking them", () => {
    // A measure that, like the real one, gives each glyph a square.
    const width = (text: string, size: number) =>
      textRuns(text).reduce(
        (sum, run) =>
          sum + (run.kind === "glyph" ? glyphWidth(size) : graphemes(run.text).length * size * 0.5),
        0
      );
    const measure: TextMeasure = {
      width,
      split: (text, maxWidth, size) => wrapLine(text, maxWidth, (t) => width(t, size)),
    };
    const layout = flyerLayout(
      event({ description: "Bowling 🎳 then cake 🍰 for 👨‍👩‍👧‍👦 ".repeat(200) }),
      URL,
      measure
    );
    expect(layout.descriptionClipped).toBe(true);
    for (const line of layout.description) {
      expect(width(line.text, line.size)).toBeLessThanOrEqual(
        layout.page.width - 2 * layout.margin + 0.01
      );
      // No lone surrogate halves left behind by wrapping or ellipsising.
      expect(line.text).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
      expect(line.text).not.toMatch(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
    }
  });

  it("draws a QR about two inches square, centred, inside the margins", () => {
    const { qr, page, margin } = flyerLayout(event(), URL, fake, 29);
    expect(qr.size).toBe(144);
    expect(qr.x + qr.size / 2).toBe(page.width / 2);
    expect(qr.y + qr.size).toBeLessThanOrEqual(page.height - margin);
    expect(qr.scale * (29 + 8)).toBeCloseTo(144);
  });

  it("ellipsises a 2000-character description above the QR block", () => {
    const layout = flyerLayout(event({ description: "lorem ipsum ".repeat(170) }), URL, fake);
    expect(layout.descriptionClipped).toBe(true);
    const last = layout.description.at(-1)!;
    expect(last.text.endsWith("…")).toBe(true);
    expect(last.y).toBeLessThan(layout.qr.y);
    expect(fake.width(last.text, last.size)).toBeLessThanOrEqual(
      layout.page.width - 2 * layout.margin
    );
  });

  it("does not clip a short description", () => {
    const layout = flyerLayout(event(), URL, fake);
    expect(layout.descriptionClipped).toBe(false);
    expect(layout.description.map((l) => l.text).join(" ")).toBe("Bring a dish to share.");
  });

  it("keeps paragraph breaks in the description", () => {
    const layout = flyerLayout(event({ description: "One\n\nTwo" }), URL, fake);
    expect(layout.description.map((l) => l.text)).toEqual(["One", "", "Two"]);
  });

  it("marks a cancelled event", () => {
    expect(flyerLayout(event(), URL, fake).cancelled).toBeNull();
    const layout = flyerLayout(event({ cancelled: true }), URL, fake);
    expect(layout.cancelled?.text.text).toBe("CANCELLED");
    // It pushes the title down rather than overlapping it.
    expect(layout.cancelled!.box.y + layout.cancelled!.box.h).toBeLessThan(layout.title[0]!.y);
  });
});

describe("downloadEventFlyer", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("offers a PDF named for the event", async () => {
    const { create, clicked } = stubDownload();
    await downloadEventFlyer(event({ title: "Picnic: Fun/Games" }), URL);

    const blob = create.mock.calls[0]?.[0] as Blob;
    expect(clicked()?.download).toBe("Picnic FunGames.pdf");
    expect(blob.type).toBe("application/pdf");
    expect(blob.size).toBeGreaterThan(500);
  });
});

import { isSafeHref, parseBody, splitLinks, type Inline, type ListBlock } from "./rich-text";

/**
 * What a notification email shows of a post, as HTML and as plain text.
 *
 * In full, by request: a message reads as it does in the app -- its formatting,
 * its lists, its links -- a poll lists every option, and an event says when
 * and where. What an email cannot carry is said in words instead: a photo is
 * "1 photo", and a file is its name, both opened from the app. Neither is
 * linked: they sit behind the app's signed cookies (see photo-cookies.ts), so
 * a link from an inbox would only ever be a broken image or an error page.
 *
 * Inline styles only, because email clients strip stylesheets. Everything a
 * member wrote is escaped, and only addresses `isSafeHref` allows become links.
 */

export interface EmailEvent {
  title: string;
  /** "Saturday, November 14 · 8:00 – 10:00 AM" -- already formatted. */
  when: string;
  location: string | null;
  /** Plain text; addresses in it become links. */
  description: string | null;
  cancelled: boolean;
}

export interface EmailPoll {
  question: string;
  /** In the order the poll lists them. */
  options: string[];
  allowsMultiple: boolean;
}

export interface EmailAttachments {
  images: number;
  /** File names, in order. Shown, never linked. */
  files: string[];
}

export interface EmailContent {
  /** The text, or null when the post has none (a poll, an event, attachments only). */
  body: string | null;
  /** `rich`: a group message in the composer's markup. `plain`: typed into a textarea. */
  bodyFormat: "rich" | "plain";
  event: EmailEvent | null;
  poll: EmailPoll | null;
  attachments: EmailAttachments;
  /** The body was longer than the email carries; the rest is in the app. */
  truncated: boolean;
}

const INK = "#333333";
const MUTED = "#6b6b6b";
const ACCENT = "#b42d23";
const LINE = "#e5e0d8";
const TINT = "#faf8f5";
const LINK_STYLE = `color:${ACCENT};text-decoration:underline;`;

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function link(href: string, inner: string): string {
  return `<a href="${escapeHtml(href)}" style="${LINK_STYLE}">${inner}</a>`;
}

/** Plain text with bare addresses as links -- the email's LinkifiedText. */
function linkifyHtml(text: string): string {
  return splitLinks(text)
    .map((run) => (run.kind === "url" ? link(run.url, escapeHtml(run.url)) : escapeHtml(run.text)))
    .join("");
}

// ---------------------------------------------------------------------------
// Body: HTML
// ---------------------------------------------------------------------------

/**
 * Inline nodes as HTML. `inLink` is the same guard GroupDetail's renderer has:
 * a bare address inside a link's own text must not become a second, nested link.
 */
function inlineHtml(nodes: Inline[], inLink = false): string {
  return nodes
    .map((node) => {
      if (node.kind === "text") return inLink ? escapeHtml(node.text) : linkifyHtml(node.text);
      const inner = inlineHtml(node.children, inLink || node.kind === "link");
      switch (node.kind) {
        case "bold":
          return `<strong>${inner}</strong>`;
        case "italic":
          return `<em>${inner}</em>`;
        case "underline":
          return `<u>${inner}</u>`;
        case "strike":
          return `<s>${inner}</s>`;
        case "link":
          // The parser only makes a link of a safe address; checked again here
          // because this is the line that writes an href.
          return isSafeHref(node.href) ? link(node.href, inner) : inner;
      }
      return inner;
    })
    .join("");
}

function listHtml(list: ListBlock): string {
  const tag = list.ordered ? "ol" : "ul";
  const start = list.ordered && list.start !== 1 ? ` start="${list.start}"` : "";
  const items = list.items
    .map(
      (item) =>
        `<li style="margin:0 0 4px;">${item.lines.map((line) => inlineHtml(line)).join("<br>")}${item.children.map(listHtml).join("")}</li>`
    )
    .join("");
  return `<${tag}${start} style="margin:4px 0;padding-left:24px;">${items}</${tag}>`;
}

/** A message or prayer request as HTML: paragraphs, lists, formatting, links. */
export function bodyHtml(body: string, format: "rich" | "plain"): string {
  if (format === "plain") return linkifyHtml(body).replace(/\r?\n/g, "<br>");

  // Consecutive lines are one paragraph with line breaks, the way the app
  // shows them; a blank line closes it.
  const out: string[] = [];
  let lines: string[] = [];
  const flush = () => {
    if (lines.length) out.push(`<p style="margin:0 0 8px;">${lines.join("<br>")}</p>`);
    lines = [];
  };
  for (const block of parseBody(body)) {
    if (block.kind === "list") {
      flush();
      out.push(listHtml(block));
    } else if (block.content.length === 0) {
      flush();
    } else {
      lines.push(inlineHtml(block.content));
    }
  }
  flush();
  return out.join("");
}

// ---------------------------------------------------------------------------
// Body: plain text
// ---------------------------------------------------------------------------

/**
 * Inline nodes as plain text. A link with its own words keeps them, followed by
 * the address in brackets -- the plain-text part has no other way to say where
 * a link goes. A link whose words *are* the address is said once.
 */
function inlineText(nodes: Inline[]): string {
  return nodes
    .map((node) => {
      if (node.kind === "text") return node.text;
      const inner = inlineText(node.children);
      if (node.kind !== "link") return inner;
      return inner.trim() === node.href ? node.href : `${inner} (${node.href})`;
    })
    .join("");
}

function listText(list: ListBlock, depth: number): string[] {
  return list.items.flatMap((item, k) => {
    const marker = list.ordered ? `${list.start + k}.` : "•";
    const pad = "  ".repeat(depth);
    const [head = [], ...rest] = item.lines;
    return [
      `${pad}${marker} ${inlineText(head)}`,
      ...rest.map((l) => `${pad}  ${inlineText(l)}`),
      ...item.children.flatMap((child) => listText(child, depth + 1)),
    ];
  });
}

export function bodyText(body: string, format: "rich" | "plain"): string {
  if (format === "plain") return body;
  return parseBody(body)
    .flatMap((block) => (block.kind === "line" ? [inlineText(block.content)] : listText(block, 0)))
    .join("\n");
}

// ---------------------------------------------------------------------------
// The whole item's content
// ---------------------------------------------------------------------------

function pluralPhotos(n: number): string {
  return `${n} photo${n === 1 ? "" : "s"}`;
}

/** Everything below an item's heading and above its button, as HTML. */
export function contentHtml(content: EmailContent): string {
  const parts: string[] = [];

  if (content.event) {
    const e = content.event;
    parts.push(`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:12px 0 0;background:${TINT};border:1px solid ${LINE};border-radius:8px;">
                  <tr><td style="padding:12px 16px;font-size:15px;line-height:1.5;color:${INK};">${
                    e.cancelled
                      ? `<p style="margin:0 0 4px;font-size:12px;font-weight:bold;letter-spacing:0.5px;text-transform:uppercase;color:${ACCENT};">Cancelled</p>`
                      : ""
                  }<p style="margin:0 0 6px;font-size:16px;font-weight:bold;${e.cancelled ? "text-decoration:line-through;" : ""}">${escapeHtml(e.title)}</p>
                    <p style="margin:0;">&#128467;&nbsp; ${escapeHtml(e.when)}</p>${
                      e.location
                        ? `
                    <p style="margin:2px 0 0;">&#128205;&nbsp; ${linkifyHtml(e.location)}</p>`
                        : ""
                    }${
                      e.description
                        ? `
                    <p style="margin:10px 0 0;">${bodyHtml(e.description, "plain")}</p>`
                        : ""
                    }
                  </td></tr>
                </table>`);
  }

  if (content.poll) {
    const p = content.poll;
    const mark = p.allowsMultiple ? "&#9744;" : "&#9675;";
    const options = p.options
      .map(
        (option) =>
          `<tr><td style="padding:8px 12px;border-top:1px solid ${LINE};font-size:15px;color:${INK};"><span style="color:${MUTED};">${mark}</span>&nbsp; ${escapeHtml(option)}</td></tr>`
      )
      .join("");
    parts.push(`<p style="margin:12px 0 2px;font-size:16px;font-weight:bold;color:${INK};">${escapeHtml(p.question)}</p>
                <p style="margin:0 0 8px;font-size:13px;color:${MUTED};">${p.allowsMultiple ? "Pick one or more" : "Pick one"}</p>
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ${LINE};border-top:0;border-radius:8px;">${options}</table>`);
  }

  if (content.body) {
    parts.push(
      `<div style="margin:12px 0 0;font-size:15px;line-height:1.5;color:${INK};">${bodyHtml(content.body, content.bodyFormat)}</div>`
    );
  }

  if (content.truncated) {
    parts.push(
      `<p style="margin:4px 0 0;font-size:14px;color:${MUTED};font-style:italic;">… Read the rest in the app.</p>`
    );
  }

  const { images, files } = content.attachments;
  if (images > 0 || files.length > 0) {
    const rows: string[] = [];
    if (images > 0) {
      rows.push(
        `<p style="margin:0;">&#128247;&nbsp; ${pluralPhotos(images)} <span style="color:${MUTED};">— open the app to see ${images === 1 ? "it" : "them"}</span></p>`
      );
    }
    for (const name of files) {
      rows.push(`<p style="margin:0;">&#128206;&nbsp; ${escapeHtml(name)}</p>`);
    }
    if (files.length > 0) {
      rows.push(
        `<p style="margin:2px 0 0;color:${MUTED};">Open the app to download ${files.length === 1 ? "it" : "them"}.</p>`
      );
    }
    parts.push(
      `<div style="margin:12px 0 0;padding:10px 12px;border:1px dashed ${LINE};border-radius:8px;font-size:14px;line-height:1.6;color:${INK};">${rows.join("")}</div>`
    );
  }

  return parts.join("\n                ");
}

/** The same, as lines of plain text. */
export function contentText(content: EmailContent): string[] {
  const lines: string[] = [];
  if (content.event) {
    const e = content.event;
    lines.push("", `${e.cancelled ? "CANCELLED: " : ""}${e.title}`, `When: ${e.when}`);
    if (e.location) lines.push(`Where: ${e.location}`);
    if (e.description) lines.push("", e.description);
  }
  if (content.poll) {
    const p = content.poll;
    lines.push("", `Poll: ${p.question} (${p.allowsMultiple ? "pick one or more" : "pick one"})`);
    for (const option of p.options) lines.push(`  ${p.allowsMultiple ? "[ ]" : "( )"} ${option}`);
  }
  if (content.body) lines.push("", bodyText(content.body, content.bodyFormat));
  if (content.truncated) lines.push("… Read the rest in the app.");
  const { images, files } = content.attachments;
  if (images > 0) lines.push("", `[${pluralPhotos(images)} -- open the app to see them]`);
  if (files.length > 0) {
    if (images === 0) lines.push("");
    for (const name of files) lines.push(`[File: ${name}]`);
    lines.push("Open the app to download.");
  }
  return lines;
}

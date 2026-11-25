/**
 * Message formatting: the parser for the small Markdown-like subset group
 * messages are stored in, and the plain-text form of a message.
 *
 * Lives in the API, and reaches the SPA through `@shared` (app/src/lib/richText.ts
 * re-exports it and adds the editor conversion), because both sides need the
 * same reading of a body: the SPA to render and preview a message, the API to
 * quote one in a notification email. Two copies of a parser drift; one cannot.
 *
 * The syntax, one line per line of the message:
 *
 *   **bold**   _italic_   ++underline++   ~~strike~~   [text](https://…)
 *   <#group-id>  a # mention of a group (see GROUP_MENTION_TOKEN)
 *   - a bulleted item      1. a numbered item      (indent 2+ spaces to nest)
 *
 * A backslash before punctuation makes it literal, which is how the composer
 * keeps a typed "_" or "[" from turning into formatting. Anything that does not
 * parse is simply shown as typed, so an old plain message reads as it always did.
 */

export type Inline =
  | { kind: "text"; text: string }
  | { kind: "bold" | "italic" | "underline" | "strike"; children: Inline[] }
  | { kind: "link"; href: string; children: Inline[] }
  | { kind: "groupMention"; groupId: string };

export type ListBlock = {
  kind: "list";
  ordered: boolean;
  start: number;
  items: { lines: Inline[][]; children: ListBlock[] }[];
};

export type Block = { kind: "line"; content: Inline[] } | ListBlock;

// ---------------------------------------------------------------------------
// # group mentions
// ---------------------------------------------------------------------------

/**
 * A # mention of a group is stored as `<#group-id>`, never as the group's name:
 * the body goes to every reader, and a Secret group's name must not. Each
 * reader's copy of the post carries the names it may see (`groupMentions` on
 * GroupPostDto, resolved per caller by services/group-mentions.ts).
 *
 * The composer escapes a typed "<" before "#", so typed text never makes one.
 */
export const GROUP_MENTION_TOKEN =
  /<#([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})>/gi;

/** The token for a group, as the composer writes it. */
export function groupMentionToken(groupId: string): string {
  return `<#${groupId}>`;
}

/** What a group mention says when the reader may not see the group's name. */
export const SECRET_GROUP_LABEL = "secret group";

/** Turns a group id into the words a reader sees, without the "#". */
export type GroupLabel = (groupId: string) => string | null | undefined;

/** The ids of every group mentioned in `body`, each once. */
export function groupMentionIds(body: string): string[] {
  const ids = new Set<string>();
  for (const line of body.split(/\r?\n/)) collectIds(parseInline(line), ids);
  return [...ids];
}

function collectIds(nodes: Inline[], into: Set<string>): void {
  for (const node of nodes) {
    if (node.kind === "groupMention") into.add(node.groupId);
    else if (node.kind !== "text") collectIds(node.children, into);
  }
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

const ESCAPABLE = /[!-/:-@[-`{-~]/;
const PAIRED = [
  ["**", "bold"],
  ["++", "underline"],
  ["~~", "strike"],
] as const;

/** Only these become links; anything else (javascript:, data:) stays text. */
export function isSafeHref(href: string): boolean {
  return /^(https?:\/\/|mailto:)/i.test(href);
}

function isWordChar(c: string | undefined): boolean {
  return c !== undefined && /[\p{L}\p{N}]/u.test(c);
}

/** The next unescaped `delim` at or after `from`, before `end`, that `ok` accepts. */
function findCloser(
  s: string,
  from: number,
  end: number,
  delim: string,
  ok: (at: number) => boolean = () => true
): number {
  for (let j = from; j < end; j++) {
    if (s[j] === "\\") {
      j++;
      continue;
    }
    if (s.startsWith(delim, j) && j + delim.length <= end && ok(j)) return j;
  }
  return -1;
}

function unescapeText(s: string): string {
  return s.replace(/\\([!-/:-@[-`{-~])/g, "$1");
}

function parseRange(s: string, start: number, end: number): Inline[] {
  const out: Inline[] = [];
  let buf = "";
  const flush = () => {
    if (buf) out.push({ kind: "text", text: buf });
    buf = "";
  };

  let i = start;
  outer: while (i < end) {
    const c = s[i]!;
    if (c === "\\" && i + 1 < end && ESCAPABLE.test(s[i + 1]!)) {
      buf += s[i + 1];
      i += 2;
      continue;
    }

    for (const [delim, kind] of PAIRED) {
      if (!s.startsWith(delim, i) || /\s/.test(s[i + 2] ?? " ")) continue;
      const close = findCloser(s, i + 2, end, delim);
      if (close > i + 2) {
        flush();
        out.push({ kind, children: parseRange(s, i + 2, close) });
        i = close + 2;
        continue outer;
      }
    }

    // Underscores inside a word (snake_case) are not italics.
    if (c === "_" && !isWordChar(s[i - 1]) && !/\s/.test(s[i + 1] ?? " ")) {
      const close = findCloser(s, i + 1, end, "_", (at) => !isWordChar(s[at + 1]));
      if (close > i + 1) {
        flush();
        out.push({ kind: "italic", children: parseRange(s, i + 1, close) });
        i = close + 1;
        continue;
      }
    }

    if (c === "<" && s[i + 1] === "#") {
      const token = new RegExp(GROUP_MENTION_TOKEN.source, "iy");
      token.lastIndex = i;
      const match = token.exec(s);
      if (match && i + match[0].length <= end) {
        flush();
        out.push({ kind: "groupMention", groupId: match[1]!.toLowerCase() });
        i += match[0].length;
        continue;
      }
    }

    if (c === "[") {
      const closeText = findCloser(s, i + 1, end, "]");
      if (closeText > i && s[closeText + 1] === "(") {
        const closeHref = findCloser(s, closeText + 2, end, ")");
        if (closeHref > closeText + 2) {
          const href = unescapeText(s.slice(closeText + 2, closeHref));
          const children = parseRange(s, i + 1, closeText);
          flush();
          if (isSafeHref(href)) out.push({ kind: "link", href, children });
          else out.push(...children);
          i = closeHref + 1;
          continue;
        }
      }
    }

    buf += c;
    i++;
  }
  flush();
  return out;
}

export function parseInline(line: string): Inline[] {
  return parseRange(line, 0, line.length);
}

type Marker = { indent: number; ordered: boolean; number: number; rest: string };

function listMarker(line: string): Marker | null {
  const bullet = /^( *)- (.*)$/.exec(line);
  if (bullet) return { indent: bullet[1]!.length, ordered: false, number: 1, rest: bullet[2]! };
  const ordered = /^( *)(\d{1,9})\. (.*)$/.exec(line);
  if (ordered) {
    return {
      indent: ordered[1]!.length,
      ordered: true,
      number: Number(ordered[2]),
      rest: ordered[3]!,
    };
  }
  return null;
}

function leadingSpaces(line: string): number {
  return line.length - line.trimStart().length;
}

/** A list starting at `lines[i]`, and the index of the first line after it. */
function parseList(lines: string[], i: number): [ListBlock, number] {
  const first = listMarker(lines[i]!)!;
  const indent = first.indent;
  const list: ListBlock = { kind: "list", ordered: first.ordered, start: first.number, items: [] };

  while (i < lines.length) {
    const line = lines[i]!;
    const marker = listMarker(line);
    const item = list.items.at(-1);
    if (marker && marker.indent <= indent + 1 && marker.indent >= indent) {
      if (marker.ordered !== list.ordered) break;
      list.items.push({ lines: [parseInline(marker.rest)], children: [] });
      i++;
    } else if (marker && item && marker.indent >= indent + 2) {
      const [nested, next] = parseList(lines, i);
      item.children.push(nested);
      i = next;
    } else if (item && line.trim() !== "" && leadingSpaces(line) >= indent + 2) {
      // A line break inside the item.
      item.lines.push(parseInline(line.trimStart()));
      i++;
    } else {
      break;
    }
  }
  return [list, i];
}

export function parseBody(body: string): Block[] {
  const lines = body.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    if (listMarker(lines[i]!)) {
      const [list, next] = parseList(lines, i);
      blocks.push(list);
      i = next;
    } else {
      blocks.push({ kind: "line", content: parseInline(lines[i]!) });
      i++;
    }
  }
  return blocks;
}

// ---------------------------------------------------------------------------
// Plain text
// ---------------------------------------------------------------------------

/** A group mention as words: "#Name", or "#secret group" when the name is unknown. */
export function groupMentionText(groupId: string, groupLabel?: GroupLabel): string {
  return `#${groupLabel?.(groupId) || SECRET_GROUP_LABEL}`;
}

function inlineText(nodes: Inline[], groupLabel?: GroupLabel): string {
  return nodes
    .map((n) => {
      if (n.kind === "text") return n.text;
      if (n.kind === "groupMention") return groupMentionText(n.groupId, groupLabel);
      return inlineText(n.children, groupLabel);
    })
    .join("");
}

function listText(list: ListBlock, depth: number, groupLabel?: GroupLabel): string[] {
  return list.items.flatMap((item, k) => {
    const marker = list.ordered ? `${list.start + k}.` : "•";
    const pad = "  ".repeat(depth);
    const [head = [], ...rest] = item.lines;
    return [
      `${pad}${marker} ${inlineText(head, groupLabel)}`,
      ...rest.map((l) => `${pad}  ${inlineText(l, groupLabel)}`),
      ...item.children.flatMap((child) => listText(child, depth + 1, groupLabel)),
    ];
  });
}

/**
 * The message as someone would read it aloud: formatting gone, list items
 * bulleted or numbered. For previews, copying, @ mention matching, and
 * deciding whether a message has any words at all. A # group mention reads as
 * "#Name" when `groupLabel` knows the name, else "#secret group".
 */
export function toPlainText(body: string, groupLabel?: GroupLabel): string {
  return parseBody(body)
    .flatMap((block) =>
      block.kind === "line"
        ? [inlineText(block.content, groupLabel)]
        : listText(block, 0, groupLabel)
    )
    .join("\n");
}

// ---------------------------------------------------------------------------
// The editor's document (ProseMirror JSON) <-> body

// ---------------------------------------------------------------------------
// Bare web addresses
// ---------------------------------------------------------------------------

/**
 * Bare web addresses in plain text -- a prayer request, an event description,
 * or the text of a message -- found the same way by the app (LinkifiedText) and
 * the notification email, so a link that works in one works in the other.
 *
 * Only http(s) addresses match, so `javascript:` and the like can never become
 * a link.
 */
const URL_PATTERN = /https?:\/\/[^\s<>"]+/gi;

/** Punctuation that, at the very end, almost always ends the sentence rather than the address. */
const TRAILING = /[.,;:!?'"]$/;

/**
 * Where the address really ends: "see https://x.org." means https://x.org, and
 * "(https://x.org)" leaves its closing paren behind -- but a paren the address
 * opened itself, as in a Wikipedia link, stays.
 */
function trimUrl(url: string): string {
  let end = url.length;
  for (;;) {
    const last = url[end - 1];
    if (last !== undefined && TRAILING.test(last)) {
      end--;
      continue;
    }
    const pair = last === ")" ? "(" : last === "]" ? "[" : null;
    if (pair) {
      const head = url.slice(0, end);
      const opens = head.split(pair).length - 1;
      const closes = head.split(last!).length - 1;
      if (closes > opens) {
        end--;
        continue;
      }
    }
    return url.slice(0, end);
  }
}

export type LinkedText = { kind: "text"; text: string } | { kind: "url"; url: string };

/** `text` split into runs of plain text and bare web addresses, in order. */
export function splitLinks(text: string): LinkedText[] {
  const out: LinkedText[] = [];
  let last = 0;
  for (const match of text.matchAll(URL_PATTERN)) {
    const url = trimUrl(match[0]);
    // "https://" alone (or with only punctuation after it) is not an address.
    if (/^https?:\/\/$/i.test(url)) continue;
    const start = match.index;
    if (start > last) out.push({ kind: "text", text: text.slice(last, start) });
    out.push({ kind: "url", url });
    last = start + url.length;
  }
  if (last < text.length) out.push({ kind: "text", text: text.slice(last) });
  return out;
}

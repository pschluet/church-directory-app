/**
 * Message formatting: what the composer's Aa row can do, kept as plain text in
 * a post's `body` so the wire format, the server, and every message written
 * before formatting existed are all unchanged.
 *
 * The syntax is a small Markdown-like subset, one line per line of the message:
 *
 *   **bold**   _italic_   ++underline++   ~~strike~~   [text](https://…)
 *   - a bulleted item      1. a numbered item      (indent 2+ spaces to nest)
 *
 * A backslash before punctuation makes it literal, which is how the composer
 * keeps a typed "_" or "[" from turning into formatting. Anything that does not
 * parse is simply shown as typed, so an old plain message reads as it always did.
 *
 * One parser serves three jobs -- rendering a message, loading one into the
 * editor to change it, and stripping it to plain text for previews -- so what
 * the composer shows and what everyone else sees cannot drift apart.
 */

export type Inline =
  | { kind: "text"; text: string }
  | { kind: "bold" | "italic" | "underline" | "strike"; children: Inline[] }
  | { kind: "link"; href: string; children: Inline[] };

export type ListBlock = {
  kind: "list";
  ordered: boolean;
  start: number;
  items: { lines: Inline[][]; children: ListBlock[] }[];
};

export type Block = { kind: "line"; content: Inline[] } | ListBlock;

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

function inlineText(nodes: Inline[]): string {
  return nodes.map((n) => (n.kind === "text" ? n.text : inlineText(n.children))).join("");
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

/**
 * The message as someone would read it aloud: formatting gone, list items
 * bulleted or numbered. For previews, copying, @ mention matching, and
 * deciding whether a message has any words at all.
 */
export function toPlainText(body: string): string {
  return parseBody(body)
    .flatMap((block) => (block.kind === "line" ? [inlineText(block.content)] : listText(block, 0)))
    .join("\n");
}

// ---------------------------------------------------------------------------
// The editor's document (ProseMirror JSON) <-> body
// ---------------------------------------------------------------------------

/** The shape of Tiptap's `editor.getJSON()`, as much of it as is used here. */
export type DocNode = {
  type: string;
  attrs?: Record<string, unknown>;
  content?: DocNode[];
  text?: string;
  marks?: { type: string; attrs?: Record<string, unknown> }[];
};

const MARK_OF = { bold: "bold", italic: "italic", underline: "underline", strike: "strike" };

function inlineToDoc(nodes: Inline[], marks: DocNode["marks"] = []): DocNode[] {
  return nodes.flatMap((node): DocNode[] => {
    if (node.kind === "text") {
      return node.text
        ? [{ type: "text", text: node.text, ...(marks.length ? { marks } : {}) }]
        : [];
    }
    const mark =
      node.kind === "link"
        ? { type: "link", attrs: { href: node.href } }
        : { type: MARK_OF[node.kind] };
    return inlineToDoc(node.children, [...marks, mark]);
  });
}

function linesToParagraph(lines: Inline[][]): DocNode {
  const content = lines.flatMap((line, k) => [
    ...(k > 0 ? [{ type: "hardBreak" }] : []),
    ...inlineToDoc(line),
  ]);
  return content.length ? { type: "paragraph", content } : { type: "paragraph" };
}

function listToDoc(list: ListBlock): DocNode {
  return {
    type: list.ordered ? "orderedList" : "bulletList",
    ...(list.ordered ? { attrs: { start: list.start } } : {}),
    content: list.items.map((item) => ({
      type: "listItem",
      content: [linesToParagraph(item.lines), ...item.children.map(listToDoc)],
    })),
  };
}

/** A stored body as the editor's document, for editing a message. */
export function bodyToDoc(body: string): DocNode {
  return {
    type: "doc",
    content: parseBody(body).map((block) =>
      block.kind === "line" ? linesToParagraph([block.content]) : listToDoc(block)
    ),
  };
}

const MARK_ORDER = ["link", "bold", "italic", "underline", "strike"];
const MARK_SYNTAX: Record<string, [string, string]> = {
  bold: ["**", "**"],
  italic: ["_", "_"],
  underline: ["++", "++"],
  strike: ["~~", "~~"],
};

type OpenMark = { type: string; href?: string };

function sameMark(a: OpenMark, b: OpenMark): boolean {
  return a.type === b.type && a.href === b.href;
}

function openSyntax(mark: OpenMark): string {
  return mark.type === "link" ? "[" : MARK_SYNTAX[mark.type]![0];
}

function closeSyntax(mark: OpenMark): string {
  if (mark.type !== "link") return MARK_SYNTAX[mark.type]![1];
  const href = (mark.href ?? "").replace(/\\/g, "\\\\").replace(/\)/g, "%29").replace(/ /g, "%20");
  return `](${href})`;
}

/**
 * Typed text, made safe from being read as formatting: backslashes, underscores
 * and brackets always, and *, + or ~ where two in a row (or one at the edge of
 * a formatted run) could pair up with something.
 */
function escapeText(text: string): string {
  return text.replace(/[\\_[\]]/g, "\\$&").replace(/([*+~])(?=\1|$)|^([*+~])/g, "\\$&");
}

function marksOf(node: DocNode): OpenMark[] {
  return (node.marks ?? [])
    .filter((m) => MARK_ORDER.includes(m.type))
    .sort((a, b) => MARK_ORDER.indexOf(a.type) - MARK_ORDER.indexOf(b.type))
    .map((m) =>
      m.type === "link" ? { type: "link", href: String(m.attrs?.href ?? "") } : { type: m.type }
    );
}

type Run = { text: string; marks: OpenMark[] } | { text: "\n"; marks: null };

/**
 * The paragraph as runs of text and their marks, with the spaces at the edges
 * of a formatted run split off and given only the marks the text on both sides
 * of them shares -- "**bold **" or "** bold**" would not read back as bold.
 */
function toRuns(content: DocNode[]): Run[] {
  const runs: Run[] = [];
  for (const node of content) {
    if (node.type === "hardBreak") runs.push({ text: "\n", marks: null });
    else if (node.type === "text" && node.text) {
      const marks = marksOf(node);
      const [, lead = "", core = "", trail = ""] = /^(\s*)(.*?)(\s*)$/s.exec(node.text) ?? [];
      if (lead) runs.push({ text: lead, marks: [] });
      if (core) runs.push({ text: core, marks });
      if (trail) runs.push({ text: trail, marks: [] });
    }
  }
  // Spaces between two runs keep what both have in common, so "**a b**" stays whole.
  const markedNeighbour = (from: number, step: number): OpenMark[] => {
    for (let j = from; j >= 0 && j < runs.length; j += step) {
      const run = runs[j]!;
      if (run.marks === null) return [];
      if (run.text.trim() !== "") return run.marks;
    }
    return [];
  };
  return runs.map((run, k) => {
    if (run.marks === null || run.text.trim() !== "") return run;
    const before = markedNeighbour(k - 1, -1);
    const after = markedNeighbour(k + 1, 1);
    let shared = 0;
    while (
      shared < before.length &&
      shared < after.length &&
      sameMark(before[shared]!, after[shared]!)
    ) {
      shared++;
    }
    return { text: run.text, marks: before.slice(0, shared) };
  });
}

/** One paragraph's inline content, as text with hard breaks as "\n". */
function serializeInline(content: DocNode[] = []): string {
  let out = "";
  let open: OpenMark[] = [];
  const closeFrom = (k: number) => {
    for (let j = open.length - 1; j >= k; j--) out += closeSyntax(open[j]!);
    open = open.slice(0, k);
  };

  for (const run of toRuns(content)) {
    if (run.marks === null) {
      closeFrom(0);
      out += "\n";
      continue;
    }
    let k = 0;
    while (k < open.length && k < run.marks.length && sameMark(open[k]!, run.marks[k]!)) k++;
    closeFrom(k);
    for (const mark of run.marks.slice(k)) out += openSyntax(mark);
    open = run.marks;
    out += escapeText(run.text);
  }
  closeFrom(0);
  return out;
}

/** A line that would otherwise read as a list item. */
function escapeLineStart(line: string): string {
  return line.replace(/^( *)-( )/, "$1\\-$2").replace(/^( *\d{1,9})\.( )/, "$1\\.$2");
}

function serializeList(node: DocNode, indent: number, out: string[]): void {
  const ordered = node.type === "orderedList";
  const start = typeof node.attrs?.start === "number" ? node.attrs.start : 1;
  (node.content ?? []).forEach((item, k) => {
    const marker = ordered ? `${start + k}. ` : "- ";
    const pad = " ".repeat(indent);
    const contentPad = " ".repeat(indent + marker.length);
    let first = true;
    for (const child of item.content ?? []) {
      if (child.type === "bulletList" || child.type === "orderedList") {
        if (first) out.push(`${pad}${marker}`);
        serializeList(child, indent + marker.length, out);
      } else {
        for (const line of serializeInline(child.content).split("\n")) {
          out.push(
            first
              ? `${pad}${marker}${escapeLineStart(line)}`
              : `${contentPad}${escapeLineStart(line)}`
          );
          first = false;
        }
      }
      first = false;
    }
    if (first) out.push(`${pad}${marker}`);
  });
}

/** The editor's document as a body to post. Trailing empty lines are dropped. */
export function docToBody(doc: DocNode): string {
  const out: string[] = [];
  for (const block of doc.content ?? []) {
    if (block.type === "bulletList" || block.type === "orderedList") {
      serializeList(block, 0, out);
    } else {
      for (const line of serializeInline(block.content).split("\n"))
        out.push(escapeLineStart(line));
    }
  }
  while (out.length > 0 && out.at(-1)!.trim() === "") out.pop();
  return out.join("\n");
}

import type { ReactNode } from "react";

/**
 * Plain text with any bare web address turned into a link, for text typed into
 * a plain textarea (a prayer request) rather than the rich composer.
 *
 * Only http(s) addresses match, so `javascript:` and the like can never become
 * a link. Newlines are left in the text, so a parent with `whitespace-pre-line`
 * keeps the line breaks someone typed.
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

export function LinkifiedText({ text }: { text: string }) {
  const out: ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(URL_PATTERN)) {
    const url = trimUrl(match[0]);
    // "https://" alone (or with only punctuation after it) is not an address.
    if (/^https?:\/\/$/i.test(url)) continue;
    const start = match.index;
    if (start > last) out.push(text.slice(last, start));
    out.push(
      <a
        key={start}
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className="text-accent underline"
      >
        {url}
      </a>
    );
    last = start + url.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return <>{out}</>;
}

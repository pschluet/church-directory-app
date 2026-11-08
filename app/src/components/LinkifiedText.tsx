import type { ReactNode } from "react";
import { splitLinks } from "@shared";

/**
 * Plain text with any bare web address turned into a link, for text typed into
 * a plain textarea (a prayer request) rather than the rich composer.
 *
 * The addresses are found by `splitLinks` (api/src/rich-text.ts), which the
 * notification email uses too. Only http(s) addresses match, so `javascript:`
 * and the like can never become a link. Newlines are left in the text, so a
 * parent with `whitespace-pre-line` keeps the line breaks someone typed.
 */
export function LinkifiedText({ text }: { text: string }) {
  let offset = 0;
  const out: ReactNode[] = splitLinks(text).map((run) => {
    const key = offset;
    if (run.kind === "text") {
      offset += run.text.length;
      return run.text;
    }
    offset += run.url.length;
    return (
      <a
        key={key}
        href={run.url}
        target="_blank"
        rel="noopener noreferrer"
        className="text-accent underline"
      >
        {run.url}
      </a>
    );
  });
  return <>{out}</>;
}

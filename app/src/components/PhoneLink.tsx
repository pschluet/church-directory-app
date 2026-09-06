import { Highlight } from "./Highlight";
import { displayPhone } from "../lib/format";
import { phoneRanges } from "../lib/highlight";

/**
 * "Phone numbers should allow mobile users to tap to call that number."
 *
 * The href carries the raw E.164 value, which is what dialers want, while the
 * label is the formatted version people read. On a desktop the `tel:` link is
 * usually inert, so a copy button is offered alongside it.
 */
export function PhoneLink({
  phone,
  label,
  className = "",
  terms = [],
}: {
  phone: string | null;
  label?: string;
  className?: string;
  /**
   * Search terms to mark in the number, lowercased -- see lib/highlight.ts,
   * which knows that the stored E.164 and the number on screen are different
   * strings. Empty everywhere but the directory's search results.
   */
  terms?: readonly string[];
}) {
  if (!phone) return null;

  return (
    <span className={`inline-flex items-center gap-1 ${className}`}>
      <a
        href={`tel:${phone}`}
        aria-label={`Call ${label ? `${label} at ` : ""}${displayPhone(phone)}`}
        className="tap-target inline-flex items-center text-primary underline decoration-transparent transition hover:text-accent hover:decoration-current"
      >
        {/* One span, and it has to stay one. The anchor is `inline-flex`, so
            every text run directly inside it is its own anonymous flex item --
            each a block container that trims its own trailing whitespace. Marking
            "555" would split the label into three items and render
            "(312)555-0140". Inside a single span, inline flow resumes and the
            spaces survive. */}
        <span>
          <Highlight text={displayPhone(phone) ?? phone} ranges={phoneRanges(phone, terms)} />
        </span>
      </a>
      <CopyButton value={phone} />
    </span>
  );
}

function CopyButton({ value }: { value: string }) {
  return (
    <button
      type="button"
      // Useful at a desk, pointless on a phone where the number is tappable.
      className="hidden text-ink-muted transition hover:text-accent md:inline-flex"
      title="Copy number"
      aria-label="Copy phone number"
      onClick={() => void navigator.clipboard?.writeText(value)}
    >
      <svg aria-hidden="true" viewBox="0 0 20 20" className="h-4 w-4 fill-current">
        <path d="M7 3h8a2 2 0 0 1 2 2v8h-2V5H7V3Zm-2 2h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2Zm0 2v10h8V7H5Z" />
      </svg>
    </button>
  );
}

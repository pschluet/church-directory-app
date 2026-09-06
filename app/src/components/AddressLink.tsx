import { useEffect, useRef, useState } from "react";
import type { PersonSummaryDto } from "@shared";
import { formatMultilineAddress, formatSingleLineAddress, hasMappableAddress } from "../lib/format";
import {
  MAPS_PROVIDERS,
  type MapsProviderId,
  mapsProvidersFor,
  mapsUrl,
  preferredProvider,
  rememberProvider,
} from "../lib/maps";
import { Button, Modal } from "./ui";

/** The link colours PhoneLink uses, so an address and a phone number read alike. */
const LINK_CLASS =
  "tap-target block whitespace-pre-line text-left text-primary underline decoration-transparent transition hover:text-accent hover:decoration-current";

/**
 * A postal address that opens a map.
 *
 * The same idea as PhoneLink -- the text people read is the thing they tap --
 * with a complication `tel:` does not have. There are two map apps, a web page
 * cannot ask which of them is installed, and so where both are plausible the
 * member is asked rather than guessed at. Which are plausible is decided from
 * the platform in lib/maps, and the reasoning lives there.
 *
 * An address with no street line stays plain text; see `hasMappableAddress`.
 */
export function AddressLink({
  person,
  className = "",
}: {
  person: Partial<PersonSummaryDto>;
  className?: string;
}) {
  const [choosing, setChoosing] = useState(false);
  const [preferred, setPreferred] = useState(preferredProvider);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const lines = formatMultilineAddress(person);
  const address = formatSingleLineAddress(person);
  /*
   * Read at render rather than through a hook: neither the user agent nor the
   * touch count can change while the page is open, and the decision they feed
   * is unit-tested on its own, so this component only passes them along.
   */
  const providers = mapsProvidersFor(navigator.userAgent, navigator.maxTouchPoints);

  if (lines.length === 0) return null;

  const text = lines.join("\n");

  if (!hasMappableAddress(person)) {
    return <span className={`block whitespace-pre-line ${className}`}>{text}</span>;
  }

  /*
   * A remembered choice only counts while it is still on offer. Somebody who
   * picked Apple Maps on their iPhone and then opened the directory on an
   * Android tablet gets Google rather than a link to a web page they did not
   * ask for.
   */
  const only =
    providers.length === 1
      ? providers[0]
      : preferred && providers.includes(preferred)
        ? preferred
        : null;

  if (only) {
    return (
      <a
        href={mapsUrl(only, address)}
        // A new tab, so somebody who ends up on a web map still has the
        // directory where they left it. On a phone the OS claims the link
        // before a tab is ever opened.
        target="_blank"
        // noreferrer, not merely noopener: the referrer would carry this page's
        // URL, and the person's id in it, to a provider that is already being
        // handed their home address.
        rel="noreferrer"
        aria-label={`Open ${address} in ${MAPS_PROVIDERS[only].label}`}
        className={`${LINK_CLASS} ${className}`}
      >
        {text}
      </a>
    );
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        /*
         * A button rather than a link, because the tap does not navigate: it
         * asks a question. An href here would have to name one of the two maps,
         * and that one would then be what cmd-click, "open link in new tab" and
         * "copy link address" all quietly used. `aria-haspopup` as on the
         * notifications bell.
         */
        aria-haspopup="dialog"
        aria-expanded={choosing}
        aria-label={`Open ${address} in a maps app`}
        onClick={() => setChoosing(true)}
        className={`${LINK_CLASS} ${className}`}
      >
        {text}
      </button>
      {choosing && (
        <MapsChooser
          address={address}
          providers={providers}
          onChoose={(provider, remember) => {
            if (remember) {
              rememberProvider(provider);
              setPreferred(provider);
            }
            setChoosing(false);
          }}
          onDismiss={() => {
            setChoosing(false);
            // Or focus lands on <body> and the next Tab starts from the top of
            // the page, as on the notifications bell.
            triggerRef.current?.focus();
          }}
        />
      )}
    </>
  );
}

/**
 * Which map, asked once per tap unless somebody says otherwise.
 *
 * The choices are real links rather than buttons calling `window.open`: it
 * costs nothing, keeps cmd-click working inside the sheet, and means the app
 * still opens no windows of its own.
 */
function MapsChooser({
  address,
  providers,
  onChoose,
  onDismiss,
}: {
  address: string;
  providers: MapsProviderId[];
  onChoose: (provider: MapsProviderId, remember: boolean) => void;
  onDismiss: () => void;
}) {
  const [remember, setRemember] = useState(false);
  const firstRef = useRef<HTMLAnchorElement>(null);

  // Modal neither moves focus in nor traps it, so without this a Tab from the
  // address would walk the rest of the page before reaching the sheet.
  useEffect(() => {
    firstRef.current?.focus();
  }, []);

  return (
    <Modal title="Open in Maps" onClose={onDismiss}>
      {/* What is about to be opened, so nobody picks a map for the wrong house. */}
      <p className="text-sm text-ink-muted">{address}</p>

      <div className="mt-4 grid gap-2">
        {providers.map((provider, index) => (
          <a
            key={provider}
            ref={index === 0 ? firstRef : undefined}
            href={mapsUrl(provider, address)}
            target="_blank"
            rel="noreferrer"
            // Closed on the way out: coming back from the map should not find a
            // sheet still waiting to be dismissed.
            onClick={() => onChoose(provider, remember)}
            className="tap-target flex items-center justify-center rounded-md border border-primary px-4 py-3 font-bold text-primary transition hover:border-accent hover:text-accent"
          >
            {/*
              The label is the whole accessible name on purpose. The dialog is
              already titled "Open in Maps" with the address as its first
              content, so repeating the address here would have a screen reader
              read it three times.
            */}
            {MAPS_PROVIDERS[provider].label}
          </a>
        ))}
      </div>

      {/*
        A plain checkbox, for the reason given beside the notification switches:
        `role="switch"` would override the implicit role and oblige us to mirror
        the state into aria-checked by hand.
      */}
      <label className="mt-4 flex cursor-pointer items-start gap-3">
        <input
          type="checkbox"
          checked={remember}
          onChange={(event) => setRemember(event.target.checked)}
          className="mt-0.5 h-5 w-5 shrink-0 accent-primary"
        />
        <span className="min-w-0">
          <span className="block text-ink">Always use the app I pick</span>
          <span className="mt-0.5 block text-sm text-ink-muted">
            You can change this in Settings.
          </span>
        </span>
      </label>

      {/* A phone sheet is dismissed from the bottom; the × is a desk habit. */}
      <Button variant="ghost" className="mt-2 w-full" onClick={onDismiss}>
        Cancel
      </Button>
    </Modal>
  );
}

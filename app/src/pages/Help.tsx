import { useState, type ReactNode } from "react";
import { Link } from "react-router";
import { LandingFrame } from "../components/LandingFrame";
import { Badge } from "../components/ui";
import { detectPlatform, type Platform } from "../lib/platform";

/*
 * Bump with `scripts/upload-help-media.sh <ios> <android> v2` when a recording
 * is replaced: the files are cached as immutable under these names.
 */
const HELP_MEDIA_VERSION = "v1";

interface PlatformInfo {
  label: string;
  /** Pixel size of the recording, so the frame holds its space while it loads. */
  width: number;
  height: number;
  steps: ReactNode[];
  glyph: ReactNode;
}

const PLATFORMS: Record<Platform, PlatformInfo> = {
  ios: {
    label: "iPhone",
    width: 540,
    height: 1174,
    steps: [
      <>
        Open this site in <strong>Safari</strong>, tap the <strong>Share</strong> button, then{" "}
        <strong>Add to Home Screen</strong>.
      </>,
      <>Open the Directory from your home screen and sign in.</>,
      <>
        Go to <strong>Settings</strong> and turn on <strong>Notifications</strong>. Tap{" "}
        <strong>Allow</strong> when your phone asks.
      </>,
    ],
    glyph: (
      <svg viewBox="0 0 24 24" aria-hidden className="size-7 fill-current">
        <path d="M16.37 12.62c-.02-2.2 1.8-3.26 1.88-3.31-1.03-1.5-2.62-1.71-3.19-1.73-1.36-.14-2.65.8-3.34.8-.69 0-1.75-.78-2.88-.76-1.48.02-2.85.86-3.61 2.19-1.54 2.67-.39 6.63 1.1 8.8.73 1.06 1.6 2.25 2.74 2.21 1.1-.04 1.52-.71 2.85-.71 1.33 0 1.71.71 2.88.69 1.19-.02 1.94-1.08 2.66-2.15.84-1.23 1.19-2.43 1.21-2.49-.03-.01-2.3-.88-2.32-3.54ZM14.2 6.1c.6-.73 1.01-1.75.9-2.76-.87.04-1.92.58-2.54 1.31-.56.65-1.05 1.68-.92 2.67.97.07 1.96-.49 2.56-1.22Z" />
      </svg>
    ),
  },
  android: {
    label: "Android",
    width: 540,
    height: 1212,
    steps: [
      <>
        Open this site in <strong>Chrome</strong>, tap the <strong>⋮ menu</strong>, then{" "}
        <strong>Install app</strong> (or <strong>Add to Home screen</strong>).
      </>,
      <>Open the Directory from your home screen and sign in.</>,
      <>
        Go to <strong>Settings</strong> and turn on <strong>Notifications</strong>. Tap{" "}
        <strong>Allow</strong> when your phone asks.
      </>,
    ],
    glyph: (
      <svg viewBox="0 0 24 24" aria-hidden className="size-7 fill-current">
        <path d="M17.6 9.48l1.84-3.18a.38.38 0 0 0-.66-.38l-1.86 3.22a11.5 11.5 0 0 0-9.84 0L5.22 5.92a.38.38 0 0 0-.66.38l1.84 3.18A10.9 10.9 0 0 0 1 18h22a10.9 10.9 0 0 0-5.4-8.52ZM7 15.25a1.25 1.25 0 1 1 0-2.5 1.25 1.25 0 0 1 0 2.5Zm10 0a1.25 1.25 0 1 1 0-2.5 1.25 1.25 0 0 1 0 2.5Z" />
      </svg>
    ),
  },
};

const ORDER: Platform[] = ["ios", "android"];

const prefersReducedMotion = () =>
  typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

/**
 * /help -- how to put the directory on a phone and turn notifications on.
 *
 * The browser's user agent only picks which button wears the "Looks like your
 * phone" badge. Nothing plays until the visitor chooses, so a wrong guess (or a
 * desktop, which gets no badge at all) costs one tap rather than the wrong
 * walkthrough.
 *
 * Public, like /e/:token: it sits outside RootGate because it is read before
 * there is an app to sign in to. The recordings are served from S3 through
 * CloudFront at /help-media/*, not from the bundle -- see
 * scripts/upload-help-media.sh.
 */
export function Help() {
  const [suggested] = useState(() =>
    typeof navigator === "undefined"
      ? null
      : detectPlatform(navigator.userAgent, navigator.maxTouchPoints)
  );
  const [chosen, setChosen] = useState<Platform | null>(null);

  return (
    <LandingFrame>
      <div className="mx-auto max-w-xl space-y-6">
        <article className="overflow-hidden rounded-2xl border border-line bg-surface shadow-sm">
          <div className="h-1.5 bg-gradient-to-r from-primary via-primary-light to-accent" />
          <div className="space-y-6 p-6 md:p-8">
            <header className="space-y-2">
              <p className="text-sm font-bold uppercase tracking-wide text-accent">Quick help</p>
              <h1 className="text-3xl font-bold leading-tight text-ink">
                Get the app on your phone
              </h1>
              <p className="leading-relaxed text-ink-muted">
                A short walkthrough to add the Parish Directory to your home screen and turn on
                notifications, so you hear about new messages, events and prayer requests.
              </p>
            </header>

            <section aria-labelledby="help-phone" className="space-y-3">
              <h2 id="help-phone" className="font-bold text-ink">
                Which phone do you have?
              </h2>
              <div className="grid grid-cols-2 gap-3">
                {ORDER.map((platform) => (
                  <PhoneChoice
                    key={platform}
                    info={PLATFORMS[platform]}
                    selected={chosen === platform}
                    suggested={suggested === platform}
                    onSelect={() => setChosen(platform)}
                  />
                ))}
              </div>
            </section>

            {chosen && <Walkthrough platform={chosen} />}
          </div>
        </article>

        <p className="text-center">
          <Link
            to="/"
            className="font-bold text-primary underline-offset-2 hover:text-accent hover:underline"
          >
            Open the directory →
          </Link>
        </p>
      </div>
    </LandingFrame>
  );
}

function PhoneChoice({
  info,
  selected,
  suggested,
  onSelect,
}: {
  info: PlatformInfo;
  selected: boolean;
  suggested: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onSelect}
      className={`relative flex flex-col items-center gap-2 rounded-xl border px-3 pb-4 pt-6 font-bold transition ${
        selected
          ? "border-primary bg-primary text-white shadow-md"
          : "border-line bg-surface text-ink hover:border-accent hover:shadow-sm"
      }`}
    >
      {suggested && (
        // Opaque behind the badge: its own tint is translucent, and the button's
        // border would show through it.
        <span className="absolute -top-2.5 left-1/2 -translate-x-1/2 rounded-full bg-surface">
          <Badge tone="accent">Looks like your phone</Badge>
        </span>
      )}
      <span className={selected ? "text-white" : "text-primary"}>{info.glyph}</span>
      {info.label}
    </button>
  );
}

function Walkthrough({ platform }: { platform: Platform }) {
  const info = PLATFORMS[platform];
  const base = `/help-media/${platform}-setup-${HELP_MEDIA_VERSION}`;
  const reduced = prefersReducedMotion();

  return (
    <section aria-label={`${info.label} walkthrough`} className="space-y-5 border-t border-line pt-6">
      {/*
        Keyed on the platform so switching remounts the element: React would
        otherwise reuse the same <video> and only swap the attributes, leaving
        the old recording playing.
      */}
      <div className="mx-auto w-full max-w-[17rem] rounded-[2.25rem] bg-ink p-2.5 shadow-lg">
        <video
          key={platform}
          className="block w-full rounded-[1.75rem] bg-black"
          style={{ aspectRatio: `${info.width} / ${info.height}` }}
          src={`${base}.mp4`}
          poster={`${base}.jpg`}
          autoPlay={!reduced}
          controls={reduced}
          muted
          loop
          playsInline
          preload="metadata"
          aria-label={`How to install the app and turn on notifications on ${info.label}`}
        />
      </div>

      <ol className="space-y-3">
        {info.steps.map((step, index) => (
          <li key={index} className="flex gap-3 leading-relaxed text-ink">
            <span
              aria-hidden
              className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-primary text-sm font-bold text-white"
            >
              {index + 1}
            </span>
            <span>{step}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}

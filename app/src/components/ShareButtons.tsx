import type { ReactNode } from "react";

/**
 * What a row of share buttons drives: an event's (useEventShare in
 * GroupDetail) or a sign-up's (useSignupShare in GroupSignup).
 */
export interface ShareControls {
  copied: boolean;
  flyerError: string | null;
  copyLink: () => void;
  openQr: () => void;
  printFlyer: () => void;
  qrModal: ReactNode;
}

/** Copy link, QR code and PDF flyer as a row of buttons. */
export function ShareButtons({ share, size = "sm" }: { share: ShareControls; size?: "sm" | "lg" }) {
  const buttonClass =
    size === "lg"
      ? "inline-flex items-center gap-2 rounded-lg border border-line bg-surface px-4 py-2.5 font-bold text-ink shadow-sm transition hover:border-accent hover:text-primary"
      : "inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-sm font-bold text-accent transition hover:bg-accent-light/30";
  const iconClass = size === "lg" ? "h-5 w-5 fill-current" : "h-4 w-4 fill-current";
  return (
    <div>
      <div className={`flex flex-wrap items-center ${size === "lg" ? "gap-2" : "gap-1"}`}>
        <button type="button" className={buttonClass} onClick={share.copyLink}>
          <svg aria-hidden="true" viewBox="0 0 20 20" className={iconClass}>
            <path d="M11.3 3.7a3.8 3.8 0 0 1 5.4 5.4l-2.2 2.2a3.8 3.8 0 0 1-5.4 0 .8.8 0 0 1 1.1-1.1 2.2 2.2 0 0 0 3.2 0l2.2-2.2a2.2 2.2 0 0 0-3.2-3.2l-.9.9a.8.8 0 0 1-1.1-1.1l.9-.9Zm-2.2 5a2.2 2.2 0 0 0-3.2 0l-2.2 2.2a2.2 2.2 0 0 0 3.2 3.2l.9-.9a.8.8 0 1 1 1.1 1.1l-.9.9a3.8 3.8 0 0 1-5.4-5.4l2.2-2.2a3.8 3.8 0 0 1 5.4 0 .8.8 0 1 1-1.1 1.1Z" />
          </svg>
          <span aria-live="polite">{share.copied ? "Copied" : "Copy link"}</span>
        </button>
        <button type="button" className={buttonClass} onClick={share.openQr}>
          <svg aria-hidden="true" viewBox="0 0 20 20" className={iconClass}>
            <path d="M3 3h6v6H3V3Zm1.6 1.6v2.8h2.8V4.6H4.6ZM11 3h6v6h-6V3Zm1.6 1.6v2.8h2.8V4.6h-2.8ZM3 11h6v6H3v-6Zm1.6 1.6v2.8h2.8v-2.8H4.6ZM11 11h2v2h-2v-2Zm2 2h2v2h-2v-2Zm2-2h2v2h-2v-2Zm0 4h2v2h-2v-2Zm-4 0h2v2h-2v-2Z" />
          </svg>
          QR code
        </button>
        <button type="button" className={buttonClass} onClick={share.printFlyer}>
          <svg aria-hidden="true" viewBox="0 0 20 20" className={iconClass}>
            <path d="M5 2h7.6L16 5.4V17a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1Zm1 1.6v12.8h8.4V6.2h-2.6a.8.8 0 0 1-.8-.8V3.6H6Zm1.6 6.2h4.8a.8.8 0 0 1 0 1.6H7.6a.8.8 0 0 1 0-1.6Zm0 3h4.8a.8.8 0 0 1 0 1.6H7.6a.8.8 0 0 1 0-1.6Z" />
          </svg>
          PDF flyer
        </button>
      </div>
      {share.flyerError && (
        <p role="alert" className="mt-1 text-sm font-bold text-primary">
          {share.flyerError}
        </p>
      )}
      {share.qrModal}
    </div>
  );
}

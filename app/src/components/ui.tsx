import { useEffect } from "react";
import type { ReactNode } from "react";

/**
 * The small shared pieces. Kept in one file because each is a handful of lines
 * and they are almost always imported together.
 */

export function Spinner({ label = "Loading" }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-3 py-12 text-ink-muted" role="status">
      <span className="h-5 w-5 animate-spin rounded-full border-2 border-line border-t-primary" />
      <span>{label}…</span>
    </div>
  );
}

export function ErrorNotice({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div role="alert" className="rounded-md border border-primary/30 bg-primary/5 p-4 text-ink">
      <p>{message}</p>
      {onRetry && (
        <button type="button" onClick={onRetry} className="mt-2 font-bold text-primary underline">
          Try again
        </button>
      )}
    </div>
  );
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="rounded-md border border-dashed border-line bg-surface-muted px-6 py-12 text-center">
      <p className="font-bold text-ink">{title}</p>
      {children && <div className="mt-2 text-ink-muted">{children}</div>}
    </div>
  );
}

export function PageHeading({
  title,
  subtitle,
  actions,
}: {
  title: string;
  subtitle?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="mb-6 flex flex-col gap-3 md:mb-8 md:flex-row md:items-end md:justify-between">
      <div>
        <h1 className="text-2xl font-bold text-ink md:text-3xl">{title}</h1>
        {subtitle && <p className="mt-1 text-ink-muted">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </header>
  );
}

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";

const BUTTON_STYLES: Record<ButtonVariant, string> = {
  primary: "bg-primary text-white hover:bg-primary-dark disabled:bg-primary/50",
  secondary: "border border-primary text-primary hover:border-accent hover:text-accent",
  ghost: "text-ink-muted hover:text-primary",
  danger: "border border-primary text-primary hover:bg-primary hover:text-white",
};

export function Button({
  variant = "primary",
  className = "",
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant }) {
  return (
    <button
      type="button"
      {...props}
      className={`tap-target inline-flex items-center justify-center gap-2 rounded-md px-4 py-2 font-bold transition disabled:cursor-not-allowed disabled:opacity-60 ${BUTTON_STYLES[variant]} ${className}`}
    />
  );
}

/** A labelled form field. Inputs are full width and 16px to avoid iOS zoom. */
export function Field({
  label,
  hint,
  error,
  children,
  className = "",
}: {
  label: string;
  hint?: ReactNode;
  error?: string | null;
  children: ReactNode;
  className?: string;
}) {
  return (
    // The input arrives as `children` and is wrapped by this label, which is a
    // valid implicit association -- the rule just cannot see through the prop.
    // biome-ignore lint/a11y/noLabelWithoutControl: the control is `children`
    <label className={`block ${className}`}>
      <span className="mb-1 block font-bold text-ink">{label}</span>
      {children}
      {hint && !error && <span className="mt-1 block text-sm text-ink-muted">{hint}</span>}
      {error && (
        <span role="alert" className="mt-1 block text-sm font-bold text-primary">
          {error}
        </span>
      )}
    </label>
  );
}

export const inputClass =
  "w-full rounded-md border border-line bg-surface px-3 py-2 text-ink placeholder:text-ink-muted/60 focus:border-accent focus:outline-none";

/**
 * Closes on Escape and stops the page behind from scrolling.
 *
 * Shared by Modal and PhotoLightbox: on a phone the scrim covers the viewport,
 * so without the lock a scroll gesture that misses the dialog moves the page
 * underneath it instead.
 */
export function useDismissable(onClose: () => void): void {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [onClose]);
}

export function Modal({
  title,
  onClose,
  children,
  /** For a dialog that needs the width, such as the photo cropper. */
  wide = false,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
}) {
  useDismissable(onClose);

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-ink/40 p-0 md:items-center md:p-6"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      {/* Full-height sheet on a phone, centred dialog from md up. */}
      <div
        className={`max-h-[92vh] w-full overflow-y-auto rounded-t-xl bg-surface p-5 shadow-xl md:rounded-xl md:p-6 ${
          wide ? "md:max-w-4xl" : "md:max-w-2xl"
        }`}
      >
        <div className="mb-4 flex items-start justify-between gap-4">
          <h2 className="text-xl font-bold text-ink">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="tap-target -mr-2 -mt-2 text-2xl leading-none text-ink-muted hover:text-primary"
          >
            ×
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

/**
 * A modal that asks before doing something that cannot be undone from the same
 * screen. Pass the consequence as children -- "Are you sure?" on its own tells
 * nobody anything.
 */
export function ConfirmDialog({
  title,
  confirmLabel = "Confirm",
  busy = false,
  onConfirm,
  onClose,
  children,
}: {
  title: string;
  confirmLabel?: string;
  busy?: boolean;
  onConfirm: () => void;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <Modal title={title} onClose={onClose}>
      <div className="space-y-4">
        <div className="text-ink-muted">{children}</div>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Button variant="danger" onClick={onConfirm} disabled={busy}>
            {busy ? "Working…" : confirmLabel}
          </Button>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
        </div>
      </div>
    </Modal>
  );
}

export function Badge({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: "neutral" | "primary" | "accent";
}) {
  const tones = {
    neutral: "bg-surface-muted text-ink-muted ring-line",
    primary: "bg-primary/10 text-primary ring-primary/20",
    accent: "bg-accent/10 text-accent ring-accent/30",
  } as const;
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-bold ring-1 ${tones[tone]}`}
    >
      {children}
    </span>
  );
}

import { initials } from "../lib/format";

const SIZES = {
  sm: "h-10 w-10 text-sm",
  md: "h-14 w-14 text-base",
  lg: "h-28 w-28 text-2xl md:h-36 md:w-36 md:text-3xl",
} as const;

/** A person's or family's photo, falling back to their initials. */
export function Avatar({
  photoUrl,
  person,
  size = "md",
}: {
  photoUrl: string | null;
  person: { firstName: string; lastName: string | null };
  size?: keyof typeof SIZES;
}) {
  const shared = `${SIZES[size]} shrink-0 rounded-full object-cover`;

  if (photoUrl) {
    return (
      <img
        src={photoUrl}
        alt=""
        loading="lazy"
        className={`${shared} border border-line bg-surface-muted`}
      />
    );
  }

  return (
    <span
      aria-hidden="true"
      className={`${shared} flex items-center justify-center bg-surface-muted font-bold text-accent ring-1 ring-line`}
    >
      {initials(person) || "?"}
    </span>
  );
}

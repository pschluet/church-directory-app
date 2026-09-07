import { useNavStack } from "./NavStack";

/**
 * The chevron in the top left, and nothing until there is somewhere to go.
 *
 * Deliberately the quietest control in the header: `text-ink-muted` where the
 * bell and the gear are `text-ink`, and no border or fill of its own. It is the
 * one thing up there that is not a destination -- it undoes rather than does --
 * and drawing it at the same weight as the parish name would give the top of
 * every page a piece of chrome competing with its own title.
 *
 * A real history pop rather than a `Link` back to the parent, which is what
 * makes the previous page come back *as it was* -- its scroll offset, its open
 * filters, the month you had paged the calendar to. A link would push a third
 * entry and rebuild that page from its defaults.
 *
 * Inline SVG, per the convention in SettingsLink and SearchField -- the app
 * ships no icon package.
 */
export function BackButton() {
  const { canGoBack, goBack } = useNavStack();

  if (!canGoBack) return null;

  return (
    <button
      type="button"
      aria-label="Back"
      onClick={goBack}
      /*
       * `-ml-2` pulls the 44px tap target back to the optical edge of the
       * container's `px-4`, the same trick the hamburger uses with `-mr-2` at
       * the other end of the row.
       *
       * From `md` up the header turns into a centred column, so the button
       * leaves the flow and pins itself to the corner instead -- see the
       * `md:contents` group in AppShell for why that is enough.
       */
      className="tap-target -ml-2 inline-flex shrink-0 items-center justify-center rounded-md text-ink-muted transition hover:bg-surface-muted hover:text-primary md:absolute md:left-2 md:top-2 md:ml-0"
    >
      <svg aria-hidden="true" viewBox="0 0 20 20" className="h-5 w-5 fill-current">
        <path d="M12.71 4.29a1 1 0 0 1 0 1.42L8.42 10l4.29 4.29a1 1 0 0 1-1.42 1.42l-5-5a1 1 0 0 1 0-1.42l5-5a1 1 0 0 1 1.42 0Z" />
      </svg>
    </button>
  );
}

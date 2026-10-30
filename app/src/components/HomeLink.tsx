import type { MouseEvent } from "react";
import { NavLink } from "./nav";
import { useNavStack } from "./NavStack";

/**
 * Home, and a clean slate: the stack is discarded and the chevron goes with it,
 * so the directory becomes the start of the session again rather than one more
 * rung to climb back down.
 *
 * Shared by the two ways home -- the parish name in the desktop header and the
 * house beside the bell on a phone -- so they cannot drift apart.
 *
 * Both stay real links. They keep their `href`, so cmd-click and right-click
 * behave and a screen reader still announces where they go; only a plain left
 * click is taken over here. Modified and non-primary clicks are handed straight
 * back, which is what the guard is for -- React Router's Link calls this first
 * and defers to `defaultPrevented`, so declining to prevent is how it is told to
 * carry on as normal.
 */
export function useGoHomeClick() {
  const { resetToHome } = useNavStack();
  return (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.defaultPrevented) return;
    if (event.button !== 0) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    resetToHome();
  };
}

/**
 * The house beside the bell, on a phone only.
 *
 * It stands in for the parish name, which the phone header drops to leave room.
 * From `md` up the name is back and "Directory" sits in the visible nav bar, so
 * a third way home would be clutter -- AppShell only renders this in the
 * `md:hidden` group.
 *
 * Inline SVG, per the convention in SettingsLink -- the app ships no icon
 * package.
 */
export function HomeLink() {
  const goHome = useGoHomeClick();
  return (
    <NavLink
      to="/"
      end
      aria-label="Home"
      onClick={goHome}
      className={({ isActive }) =>
        `tap-target inline-flex items-center justify-center rounded-md transition hover:bg-surface-muted hover:text-primary ${
          isActive ? "text-primary" : "text-ink"
        }`
      }
    >
      <svg aria-hidden="true" viewBox="0 0 20 20" className="h-5 w-5 fill-current">
        <path d="M9.29 2.3a1 1 0 0 1 1.42 0l7 7A1 1 0 0 1 17 11h-1v5.5a1.5 1.5 0 0 1-1.5 1.5H12v-4.5a.5.5 0 0 0-.5-.5h-3a.5.5 0 0 0-.5.5V18H5.5A1.5 1.5 0 0 1 4 16.5V11H3a1 1 0 0 1-.71-1.7l7-7Z" />
      </svg>
    </NavLink>
  );
}

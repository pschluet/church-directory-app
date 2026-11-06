import { NavLink } from "./nav";

/**
 * The people beside the house, on a phone only.
 *
 * Groups is where members go most often after the directory itself, and on a
 * phone it otherwise sits behind the hamburger. From `md` up "Groups" is in the
 * visible nav bar, so AppShell only renders this in the `md:hidden` group.
 *
 * Not `end`, so it stays lit on a group's own pages -- a thread or an event is
 * still "in Groups".
 *
 * Inline SVG, per the convention in SettingsLink -- the app ships no icon
 * package.
 */
export function GroupsLink() {
  return (
    <NavLink
      to="/groups"
      aria-label="Groups"
      className={({ isActive }) =>
        `tap-target inline-flex items-center justify-center rounded-md transition hover:bg-surface-muted hover:text-primary ${
          isActive ? "text-primary" : "text-ink"
        }`
      }
    >
      <svg aria-hidden="true" viewBox="0 0 20 20" className="h-5 w-5 fill-current">
        {/* Two people behind, one in front: heads, then shoulders. */}
        <circle cx="4.5" cy="6.5" r="2" />
        <circle cx="15.5" cy="6.5" r="2" />
        <path d="M0.5 14.5a4 4 0 0 1 6.2-3.35A6.4 6.4 0 0 0 4.6 15.5H1.5a1 1 0 0 1-1-1Z" />
        <path d="M19.5 14.5a4 4 0 0 0-6.2-3.35 6.4 6.4 0 0 1 2.1 4.35h3.1a1 1 0 0 0 1-1Z" />
        <circle cx="10" cy="5.5" r="3" />
        <path d="M4.5 16.5a5.5 5.5 0 0 1 11 0 1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1Z" />
      </svg>
    </NavLink>
  );
}

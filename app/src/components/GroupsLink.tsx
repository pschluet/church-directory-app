import { NavLink } from "./nav";
import { PeopleIcon } from "./PeopleIcon";

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
 * The same two people as the member count on a group row (PeopleIcon), so
 * the header and the list read as one thing.
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
      <PeopleIcon className="h-5 w-5" />
    </NavLink>
  );
}

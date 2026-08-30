import { useEffect, useState } from "react";
import { NavLink, Outlet, useLocation } from "react-router";
import { useAuth } from "../context/AuthContext";
import { useMe } from "../context/MeContext";

/**
 * The frame every page sits in, following allsaintsorthodox.org's structure:
 * a thin red utility bar, the parish name, then the navigation, with a red
 * footer.
 *
 * Mobile first. Under `md` the navigation is a drawer behind a hamburger and
 * the header collapses to one compact row; from `md` up it is the full
 * horizontal bar, sticky on scroll, as on the parish site.
 */

interface NavItem {
  to: string;
  label: string;
  adminOnly?: boolean;
  superAdminOnly?: boolean;
}

const NAV_ITEMS: NavItem[] = [
  { to: "/", label: "Directory" },
  { to: "/search", label: "Search" },
  { to: "/dates", label: "Special Dates" },
  { to: "/me", label: "My Details" },
  { to: "/admin/users", label: "People & Accounts", adminOnly: true },
  { to: "/admin/organizations", label: "Churches", superAdminOnly: true },
];

export function AppShell() {
  const { me, isAdmin, isSuperAdmin, switchOrganization } = useMe();
  const { signOut, email } = useAuth();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const location = useLocation();

  // Navigating should always close the drawer, including via the back button.
  useEffect(() => setDrawerOpen(false), [location.pathname]);

  const items = NAV_ITEMS.filter(
    (item) => (!item.adminOnly || isAdmin) && (!item.superAdminOnly || isSuperAdmin)
  );

  const organizationName = me?.organization?.name ?? "Parish Directory";

  return (
    <div className="flex min-h-screen flex-col">
      {/* Utility bar: the organization's name, mirroring the parish site's
          address bar. Hidden on phones, where vertical space is precious. */}
      <div className="hidden bg-primary px-4 py-1.5 text-center text-sm text-white md:block">
        {organizationName}
      </div>

      <header className="sticky top-0 z-40 border-b border-line bg-surface shadow-sm">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-4 py-3 md:flex-col md:gap-2 md:py-4">
          {/*
            min-w-0 lets a long parish name wrap instead of forcing the flex row
            wider than the viewport -- without it the name pushes the menu
            button off the right edge on a phone and the whole page scrolls
            sideways.
          */}
          <NavLink
            to="/"
            className="min-w-0 text-lg font-bold leading-tight text-ink transition hover:text-accent md:text-center md:text-2xl"
          >
            {organizationName}
          </NavLink>

          <button
            type="button"
            className="tap-target -mr-2 flex shrink-0 items-center justify-center text-ink md:hidden"
            aria-expanded={drawerOpen}
            aria-controls="main-nav"
            aria-label={drawerOpen ? "Close menu" : "Open menu"}
            onClick={() => setDrawerOpen((open) => !open)}
          >
            <svg aria-hidden="true" viewBox="0 0 24 24" className="h-7 w-7 fill-current">
              {drawerOpen ? (
                <path d="M6.4 5 5 6.4l5.6 5.6L5 17.6 6.4 19l5.6-5.6L17.6 19 19 17.6 13.4 12 19 6.4 17.6 5 12 10.6 6.4 5Z" />
              ) : (
                <path d="M3 6h18v2H3V6Zm0 5h18v2H3v-2Zm0 5h18v2H3v-2Z" />
              )}
            </svg>
          </button>

          {/* From md up this is the horizontal bar; below md it is the drawer,
              toggled by the button above. */}
          <nav
            id="main-nav"
            aria-label="Main"
            data-testid="main-nav"
            data-variant={drawerOpen ? "drawer-open" : "drawer-closed"}
            className={`${
              drawerOpen ? "block" : "hidden"
            } absolute left-0 right-0 top-full border-b border-line bg-surface px-4 pb-4 shadow-lg md:static md:block md:border-0 md:p-0 md:shadow-none`}
          >
            <ul className="flex flex-col gap-1 md:flex-row md:flex-wrap md:justify-center md:gap-1">
              {items.map((item) => (
                <li key={item.to}>
                  <NavLink
                    to={item.to}
                    end={item.to === "/"}
                    className={({ isActive }) =>
                      `tap-target flex items-center rounded-md px-3 py-2 font-bold transition md:py-1.5 ${
                        isActive
                          ? "bg-primary/10 text-primary"
                          : "text-ink hover:bg-surface-muted hover:text-accent"
                      }`
                    }
                  >
                    {item.label}
                  </NavLink>
                </li>
              ))}
            </ul>

            {isSuperAdmin && me && me.availableOrganizations.length > 0 && (
              <div className="mt-3 border-t border-line pt-3 md:mt-2">
                <label className="flex items-center gap-2 text-sm text-ink-muted">
                  <span className="font-bold">Viewing</span>
                  <select
                    value={me.organization?.id ?? ""}
                    onChange={(event) => void switchOrganization(event.target.value)}
                    className="tap-target flex-1 rounded-md border border-line bg-surface px-2 py-1 md:flex-none"
                  >
                    {me.availableOrganizations.map((org) => (
                      <option key={org.id} value={org.id}>
                        {org.name}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            )}

            <div className="mt-3 border-t border-line pt-3 text-sm text-ink-muted md:hidden">
              <p className="mb-2 truncate">{email ?? me?.appUser.email}</p>
              <button
                type="button"
                onClick={() => void signOut()}
                className="tap-target font-bold text-primary"
              >
                Sign out
              </button>
            </div>
          </nav>
        </div>

        {/* The desktop account row; on a phone this lives inside the drawer. */}
        <div className="mx-auto hidden max-w-6xl items-center justify-end gap-4 px-4 pb-2 text-sm text-ink-muted md:flex">
          <span>{email ?? me?.appUser.email}</span>
          <button
            type="button"
            onClick={() => void signOut()}
            className="font-bold text-primary transition hover:text-accent"
          >
            Sign out
          </button>
        </div>
      </header>

      {/* max-w keeps content readable rather than stretching across a wide
          monitor; px scales up with the viewport. */}
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 md:px-6 md:py-10">
        <Outlet />
      </main>

      <footer className="mt-8 bg-primary px-4 py-6 text-center text-sm text-white/90">
        <p>{organizationName}</p>
        <p className="mt-1 text-white/70">
          Parish directory — please keep your details up to date.
        </p>
      </footer>
    </div>
  );
}

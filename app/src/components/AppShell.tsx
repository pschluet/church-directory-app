import { useEffect, useRef, useState } from "react";
import { NavLink, Outlet, useLocation } from "react-router";
import { useAuth } from "../context/AuthContext";
import { useMe } from "../context/MeContext";
import { NotificationBell } from "./NotificationBell";
import { SettingsLink } from "./SettingsLink";
import { useRealtimeRefresh } from "./useRealtimeRefresh";

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
  { to: "/dates", label: "Special Dates" },
  { to: "/prayer-requests", label: "Prayer Requests" },
  { to: "/families", label: "Families" },
  { to: "/me", label: "My Details" },
  { to: "/admin/users", label: "People & Accounts", adminOnly: true },
  { to: "/admin/organizations", label: "Churches", superAdminOnly: true },
];

export function AppShell() {
  const { me, isAdmin, isSuperAdmin, switchOrganization } = useMe();
  // Once, here: the bell below is rendered twice (phone and desktop copies),
  // so this cannot live inside it.
  useRealtimeRefresh();
  const { signOut, email } = useAuth();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const location = useLocation();
  const navRef = useRef<HTMLElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);

  // Navigating should always close the drawer, including via the back button.
  useEffect(() => setDrawerOpen(false), [location.pathname]);

  /*
   * Tapping the page with the drawer open should dismiss it. This listens on
   * the document rather than putting a backdrop over the page, so the tap still
   * reaches whatever was under it -- a backdrop would swallow the first tap and
   * make every link a two-tap affair while the menu is open.
   *
   * pointerdown rather than click so it closes as the finger lands, and the
   * toggle is excluded because its own handler already flips the state.
   */
  useEffect(() => {
    if (!drawerOpen) return;

    function handlePointerDown(event: PointerEvent) {
      const target = event.target as Node | null;
      if (!target) return;
      if (navRef.current?.contains(target) || toggleRef.current?.contains(target)) return;
      setDrawerOpen(false);
    }

    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [drawerOpen]);

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

          {/*
            The bell has to appear twice, because this row is not the same row at
            both sizes: under `md` it is [parish name | controls], and from `md`
            up the container turns `md:flex-col` and centres, which would drop
            anything here underneath the title. So the phone copy sits next to
            the hamburger and the desktop copy lives in the account row below,
            each hidden at the other breakpoint. Restructuring the header to
            share one is a bigger change than a bell warrants.
          */}
          <div className="flex shrink-0 items-center gap-0.5 md:hidden">
            <NotificationBell />
            <SettingsLink />

            <button
              ref={toggleRef}
              type="button"
              className="tap-target -mr-2 flex shrink-0 items-center justify-center text-ink"
              aria-expanded={drawerOpen}
              aria-controls="main-nav"
              aria-label={drawerOpen ? "Close menu" : "Open menu"}
              onClick={() => setDrawerOpen((open) => !open)}
            >
              {/*
                Three bars that fold into a cross, rather than swapping one icon
                for another. The outer two sit 7px either side of the middle and
                animate purely by transform -- translating to the centre and
                rotating -- which the compositor can handle without a reflow.
                The middle bar just fades.
              */}
              <span aria-hidden="true" className="relative block h-4 w-6">
                <span
                  className={`absolute left-0 top-0 block h-0.5 w-full rounded-full bg-current transition-transform duration-200 ease-out ${
                    drawerOpen ? "translate-y-[7px] rotate-45" : ""
                  }`}
                />
                <span
                  className={`absolute left-0 top-1/2 block h-0.5 w-full -translate-y-1/2 rounded-full bg-current transition-opacity duration-200 ease-out ${
                    drawerOpen ? "opacity-0" : "opacity-100"
                  }`}
                />
                <span
                  className={`absolute bottom-0 left-0 block h-0.5 w-full rounded-full bg-current transition-transform duration-200 ease-out ${
                    drawerOpen ? "-translate-y-[7px] -rotate-45" : ""
                  }`}
                />
              </span>
            </button>
          </div>

          {/* From md up this is the horizontal bar; below md it is the drawer,
              toggled by the button above. */}
          <nav
            ref={navRef}
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
          <NotificationBell />
          <SettingsLink />
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

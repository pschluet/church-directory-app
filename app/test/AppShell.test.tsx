import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Link, MemoryRouter, Route, Routes, useNavigate } from "react-router";
import { NavStackProvider } from "../src/components/NavStack";
import { QueryClientProvider } from "@tanstack/react-query";
import type { MeDto, Role } from "@shared";
import { AppShell } from "../src/components/AppShell";
import { testQueryClient } from "./utils";

/*
 * The contexts are stubbed rather than exercised: this file is about the shell's
 * navigation and its breakpoint behaviour, and the real providers would pull in
 * Amplify and a live /api/me.
 */
const signOut = vi.fn();

/*
 * The shell now renders the notification bell, which fetches its own count.
 * Stubbed to an empty inbox: the bell's own behaviour is
 * test/NotificationBell.test.tsx, and here it only has to be renderable.
 */
vi.mock("../src/lib/api", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/api")>("../src/lib/api");
  return { ...actual, api: vi.fn(() => Promise.resolve({ unreadCount: 0, notifications: [] })) };
});

vi.mock("../src/context/AuthContext", () => ({
  useAuth: () => ({ signOut, email: "paul@example.com" }),
}));

/*
 * Mounted here and nowhere else, so the shell is the only thing that can prove
 * it runs at all. Stubbed rather than exercised -- its own behaviour is
 * test/usePushRegistration.test.tsx.
 */
const usePushRegistration = vi.fn();

vi.mock("../src/components/usePushRegistration", () => ({
  usePushRegistration: () => usePushRegistration(),
}));

const meState = {
  role: "USER" as Role,
  availableOrganizations: [] as { id: string; name: string }[],
};
const switchOrganization = vi.fn();

vi.mock("../src/context/MeContext", () => ({
  useMe: () => ({
    me: {
      appUser: { email: "paul@example.com", role: meState.role },
      organization: { id: "org-1", name: "All Saints" },
      availableOrganizations: meState.availableOrganizations,
    } as unknown as MeDto,
    isAdmin: meState.role === "ADMIN" || meState.role === "SUPER_ADMIN",
    isSuperAdmin: meState.role === "SUPER_ADMIN",
    canApprovePrayerRequests: meState.role !== "USER",
    switchOrganization,
  }),
}));

/** Stands in for the browser's own back button, which the chevron cannot
    intercept and which must animate correctly all the same. */
function BrowserBack() {
  const navigate = useNavigate();
  return (
    <button type="button" onClick={() => void navigate(-1)}>
      Browser back
    </button>
  );
}

function renderShell(role: Role = "USER", orgs: { id: string; name: string }[] = []) {
  meState.role = role;
  meState.availableOrganizations = orgs;
  return render(
    <QueryClientProvider client={testQueryClient()}>
      <MemoryRouter initialEntries={["/"]}>
        <Routes>
          {/*
            The shell reads the nav stack for its back chevron, so the provider
            has to be here too -- in the app it wraps the shell from the layout
            route (see App.tsx). A second page to navigate to, so cases about the
            chevron have somewhere to go.
          */}
          <Route
            element={
              <NavStackProvider>
                <AppShell />
                <BrowserBack />
              </NavStackProvider>
            }
          >
            <Route
              index
              element={
                <>
                  <p>Directory page</p>
                  <Link to="/people/1">Open a person</Link>
                  {/* A push that only changes the query string, which is what
                      Directory's filter checkbox does. */}
                  <Link to="/?shown=all">Narrow the list</Link>
                </>
              }
            />
            <Route
              path="people/:id"
              element={
                <>
                  <p>Person page</p>
                  {/* Same path, different query string -- what Directory's
                      filter and the audit log's do, and what the chevron has
                      to step over rather than treat as a page. */}
                  <Link to="/people/1?shown=all">Change a filter</Link>
                </>
              }
            />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

describe("AppShell navigation", () => {
  it("keeps this device's push subscription registered to the signed-in account", () => {
    // The shell is where usePushRegistration is mounted, once, for the same
    // reason useRealtimeRefresh is: the bell it would otherwise live in renders
    // twice, and this must not run twice.
    renderShell();
    expect(usePushRegistration).toHaveBeenCalled();
  });

  it("shows the parish name and the page", () => {
    renderShell();
    expect(screen.getAllByText("All Saints").length).toBeGreaterThan(0);
    expect(screen.getByText("Directory page")).toBeInTheDocument();
  });

  it("gives a member only the member pages", () => {
    renderShell("USER");
    expect(screen.getByRole("link", { name: "Directory" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Special Dates" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Prayer Requests" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Families" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "My Details" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /people & accounts/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Churches" })).not.toBeInTheDocument();
  });

  it("puts a notifications bell and a settings gear in the top right at both sizes", () => {
    renderShell();
    // Twice each: once beside the hamburger on a phone, once in the account row
    // from md up. Both are in the document; CSS hides one.
    expect(screen.getAllByRole("button", { name: "Notifications" })).toHaveLength(2);
    expect(screen.getAllByRole("link", { name: "Settings" })).toHaveLength(2);
  });

  it("keeps settings out of the main navigation", () => {
    // It is a page somebody visits once, reached from the gear. In the nav it
    // would sit alongside Directory and Families as though it were somewhere
    // people go.
    renderShell();
    const nav = screen.getByTestId("main-nav");
    expect(nav.textContent).not.toMatch(/settings/i);
  });

  it("gives an admin the accounts page but not the churches page", () => {
    renderShell("ADMIN");
    expect(screen.getByRole("link", { name: /people & accounts/i })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Churches" })).not.toBeInTheDocument();
  });

  it("gives a super admin everything, plus an organization switcher", async () => {
    renderShell("SUPER_ADMIN", [
      { id: "org-1", name: "All Saints" },
      { id: "org-2", name: "St. George" },
    ]);
    expect(screen.getByRole("link", { name: "Churches" })).toBeInTheDocument();

    const select = screen.getByLabelText(/viewing/i);
    await userEvent.selectOptions(select, "org-2");
    expect(switchOrganization).toHaveBeenCalledWith("org-2");
  });

  it("hides the switcher from everyone else", () => {
    renderShell("ADMIN", [{ id: "org-1", name: "All Saints" }]);
    expect(screen.queryByLabelText(/viewing/i)).not.toBeInTheDocument();
  });

  it("signs out", async () => {
    renderShell();
    // Two buttons exist -- one in the drawer, one in the desktop row -- and
    // only one is visible at a time by breakpoint.
    await userEvent.click(screen.getAllByRole("button", { name: /sign out/i })[0]!);
    expect(signOut).toHaveBeenCalled();
  });
});

describe("AppShell responsive behaviour", () => {
  /*
   * jsdom does not apply CSS, so a computed-style assertion would be
   * meaningless. What can be checked is the mechanism: the hamburger's state,
   * and that the nav carries the mobile-first classes (hidden by default,
   * shown from md) rather than the reverse.
   */
  it("keeps the drawer closed to begin with", () => {
    renderShell();
    const toggle = screen.getByRole("button", { name: /open menu/i });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByTestId("main-nav")).toHaveAttribute("data-variant", "drawer-closed");
  });

  it("opens and closes the drawer from the hamburger", async () => {
    renderShell();
    const toggle = screen.getByRole("button", { name: /open menu/i });

    await userEvent.click(toggle);
    expect(screen.getByRole("button", { name: /close menu/i })).toHaveAttribute(
      "aria-expanded",
      "true"
    );
    expect(screen.getByTestId("main-nav")).toHaveAttribute("data-variant", "drawer-open");

    await userEvent.click(screen.getByRole("button", { name: /close menu/i }));
    expect(screen.getByTestId("main-nav")).toHaveAttribute("data-variant", "drawer-closed");
  });

  it("is mobile-first: the nav is hidden until md, and the hamburger stops at md", () => {
    renderShell();
    const nav = screen.getByTestId("main-nav");
    expect(nav.className).toContain("hidden");
    expect(nav.className).toContain("md:block");
    expect(nav.className).not.toContain("md:hidden");

    // `md:hidden` sits on the group that holds the phone-side bell and the
    // hamburger, not on the button itself -- both disappear together at md,
    // where the desktop copies take over.
    const phoneControls = screen.getByRole("button", { name: /open menu/i }).parentElement;
    expect(phoneControls?.className).toContain("md:hidden");
  });

  it("keeps the hamburger a full-size touch target", () => {
    renderShell();
    expect(screen.getByRole("button", { name: /open menu/i })).toHaveClass("tap-target");
  });

  /*
   * The icon is three bars that fold into a cross rather than two swapped
   * icons, so what is worth asserting is that the same three elements persist
   * across the toggle and that only their transforms change -- swap one for the
   * other and there is nothing left to animate.
   */
  it("folds the same three bars into a cross instead of swapping icons", async () => {
    renderShell();
    const toggle = screen.getByRole("button", { name: /open menu/i });
    const bars = () => Array.from(toggle.querySelectorAll("span > span"));

    expect(bars()).toHaveLength(3);
    const [top, middle, bottom] = bars();
    expect(top!.className).toContain("transition-transform");
    expect(top!.className).not.toContain("rotate-45");
    expect(middle!.className).toContain("opacity-100");

    await userEvent.click(toggle);

    // The very same nodes, re-styled -- not replaced.
    const [openTop, openMiddle, openBottom] = bars();
    expect(openTop).toBe(top);
    expect(openBottom).toBe(bottom);
    expect(openTop!.className).toContain("rotate-45");
    expect(openBottom!.className).toContain("-rotate-45");
    expect(openMiddle!.className).toContain("opacity-0");
  });

  it("closes the drawer when the page behind it is tapped", async () => {
    renderShell();
    await userEvent.click(screen.getByRole("button", { name: /open menu/i }));
    expect(screen.getByTestId("main-nav")).toHaveAttribute("data-variant", "drawer-open");

    await userEvent.click(screen.getByText("Directory page"));
    expect(screen.getByTestId("main-nav")).toHaveAttribute("data-variant", "drawer-closed");
  });

  it("stays open when the drawer itself is tapped", async () => {
    renderShell("SUPER_ADMIN", [
      { id: "org-1", name: "All Saints" },
      { id: "org-2", name: "St. George" },
    ]);
    await userEvent.click(screen.getByRole("button", { name: /open menu/i }));

    // The organization switcher lives inside the drawer; using it must not
    // dismiss the thing it is inside.
    await userEvent.click(screen.getByLabelText(/viewing/i));
    expect(screen.getByTestId("main-nav")).toHaveAttribute("data-variant", "drawer-open");
  });

  it("still closes from the hamburger, which the outside handler ignores", async () => {
    renderShell();
    const toggle = screen.getByRole("button", { name: /open menu/i });
    await userEvent.click(toggle);

    // If the document listener treated this as an outside tap it would close
    // the drawer and the button's own handler would reopen it.
    await userEvent.click(screen.getByRole("button", { name: /close menu/i }));
    expect(screen.getByTestId("main-nav")).toHaveAttribute("data-variant", "drawer-closed");
  });

  it("listens only while the drawer is open", async () => {
    const addSpy = vi.spyOn(document, "addEventListener");
    const removeSpy = vi.spyOn(document, "removeEventListener");
    renderShell();

    const pointerListeners = () =>
      addSpy.mock.calls.filter(([type]) => type === "pointerdown").length;
    expect(pointerListeners()).toBe(0);

    await userEvent.click(screen.getByRole("button", { name: /open menu/i }));
    expect(pointerListeners()).toBe(1);

    await userEvent.click(screen.getByRole("button", { name: /close menu/i }));
    expect(removeSpy.mock.calls.some(([type]) => type === "pointerdown")).toBe(true);
  });

  it("caps the content width so it does not stretch on a wide monitor", () => {
    renderShell();
    expect(document.querySelector("main")?.className).toContain("max-w-6xl");
  });
});

/*
 * The audit log pins its day headings directly beneath this header, so it needs
 * to know how tall the header is -- and that is not one number: it changes at
 * `md`, changes again when a super admin's organization switcher appears inside
 * it, and changes again if a long parish name wraps.
 */
describe("the published header height", () => {
  const readVar = () => document.documentElement.style.getPropertyValue("--app-header-height");

  function stubHeaderHeight(height: number) {
    // jsdom lays nothing out, so every box is 0x0 unless it is told otherwise.
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      height,
    } as unknown as DOMRect);
  }

  it("publishes the header's measured height on mount", () => {
    stubHeaderHeight(167);
    renderShell();
    expect(readVar()).toBe("167px");
  });

  /*
   * Signing out unmounts the shell, and `scroll-padding-top` in theme.css reads
   * this too -- so a value left behind would keep the sign-in screen, which has
   * no header, scrolling as though it had a tall one.
   */
  it("withdraws the value when the shell goes away", () => {
    stubHeaderHeight(167);
    const { unmount } = renderShell();
    expect(readVar()).toBe("167px");

    unmount();
    expect(readVar()).toBe("");
  });

  /*
   * jsdom has no ResizeObserver, which is also the fallback path in an older
   * browser: the height is still measured, and a window resize re-measures it.
   */
  it("re-measures when the window changes size", () => {
    stubHeaderHeight(70);
    renderShell();
    expect(readVar()).toBe("70px");

    stubHeaderHeight(232);
    window.dispatchEvent(new Event("resize"));
    expect(readVar()).toBe("232px");
  });
});

describe("the back chevron", () => {
  const chevron = () => screen.queryByRole("button", { name: "Back" });

  it("is not there where you started", () => {
    /*
     * The point of the whole nav stack: at the first entry there is nothing
     * behind it that belongs to the app, and offering to go back would either
     * do nothing or leave the app entirely. That is also the case for somebody
     * arriving on a deep link from outside.
     */
    renderShell();
    expect(chevron()).not.toBeInTheDocument();
  });

  it("stays away when a filter pushed an entry for the same page", async () => {
    /*
     * Directory's "account holders only" pushes on purpose, so the browser's
     * back button undoes it. That is a history entry but it is not somewhere
     * you went: offering to go "back" from the directory to the directory is
     * the chevron claiming the page has a parent when it has not.
     */
    renderShell();
    await userEvent.click(screen.getByRole("link", { name: "Narrow the list" }));

    expect(chevron()).not.toBeInTheDocument();
  });

  it("appears once you have gone somewhere, as a full-size touch target", async () => {
    renderShell();
    await userEvent.click(screen.getByRole("link", { name: "Open a person" }));

    expect(await screen.findByText("Person page")).toBeInTheDocument();
    const back = chevron();
    expect(back).toBeInTheDocument();
    expect(back).toHaveClass("tap-target");
  });

  it("goes back to the page you came from", async () => {
    renderShell();
    await userEvent.click(screen.getByRole("link", { name: "Open a person" }));
    await screen.findByText("Person page");

    await userEvent.click(screen.getByRole("button", { name: "Back" }));

    expect(await screen.findByText("Directory page")).toBeInTheDocument();
    // And back at the start, it takes itself away again.
    expect(chevron()).not.toBeInTheDocument();
  });

  it("steps over entries that only changed the query string", async () => {
    /*
     * Directory's "account holders only" and each of the audit log's filters
     * push deliberately, so the browser's own back button undoes them. This is
     * the other half of that decision: the chevron is a *page* back button, so
     * two filter changes must not cost two taps and two full page slides.
     */
    renderShell();
    await userEvent.click(screen.getByRole("link", { name: "Open a person" }));
    await screen.findByText("Person page");
    await userEvent.click(screen.getByRole("link", { name: "Change a filter" }));
    await userEvent.click(screen.getByRole("link", { name: "Change a filter" }));

    await userEvent.click(screen.getByRole("button", { name: "Back" }));

    expect(await screen.findByText("Directory page")).toBeInTheDocument();
  });

  /*
   * The direction the CSS animates from. Asserted here because it is the only
   * part of the transition a test can see: jsdom has no
   * `document.startViewTransition`, so React Router takes its un-animated path
   * and the keyframes in theme.css never run.
   */
  it("tells the stylesheet which way the page should slide", async () => {
    renderShell();
    await userEvent.click(screen.getByRole("link", { name: "Open a person" }));
    await screen.findByText("Person page");
    expect(document.documentElement.dataset.nav).toBe("forward");

    await userEvent.click(screen.getByRole("button", { name: "Back" }));
    await screen.findByText("Directory page");
    expect(document.documentElement.dataset.nav).toBe("back");
  });

  it("does not slide the page sideways to apply or undo a filter", async () => {
    /*
     * The chevron steps over same-page entries, but the browser's own back
     * button cannot be made to -- so the direction has to say "none" and let the
     * stylesheet cross-fade instead. Sliding the whole directory off to the
     * right to untick a checkbox is the artefact this prevents, and it is only
     * reachable by the one control we do not own.
     */
    renderShell();

    await userEvent.click(screen.getByRole("link", { name: "Narrow the list" }));
    expect(document.documentElement.dataset.nav).toBe("none");

    await userEvent.click(screen.getByRole("button", { name: "Browser back" }));
    await waitFor(() => expect(document.documentElement.dataset.nav).toBe("none"));
  });

  it("starts over when the header title is clicked", async () => {
    /*
     * The title is not one more step deeper. Clicking it goes home *and*
     * discards the stack, so the directory becomes the start of the session
     * again -- which means the chevron has to go with it, and the page has to
     * slide away to the right rather than in from it.
     */
    renderShell();
    await userEvent.click(screen.getByRole("link", { name: "Open a person" }));
    await screen.findByText("Person page");
    expect(chevron()).toBeInTheDocument();

    await userEvent.click(screen.getAllByRole("link", { name: "All Saints" })[0] as HTMLElement);

    expect(await screen.findByText("Directory page")).toBeInTheDocument();
    expect(chevron()).not.toBeInTheDocument();
    expect(document.documentElement.dataset.nav).toBe("back");
  });

  it("keeps the title a real link for modified clicks", async () => {
    // It has to stay openable in a new tab, and announce itself as a link. Only
    // the plain left click is taken over.
    renderShell();
    await userEvent.click(screen.getByRole("link", { name: "Open a person" }));
    await screen.findByText("Person page");

    const title = screen.getAllByRole("link", { name: "All Saints" })[0] as HTMLElement;
    expect(title).toHaveAttribute("href", "/");

    /*
     * A cmd-click is the browser's business -- open in a new tab -- so neither
     * the reset nor the router should react to it, and the page must not move.
     *
     * One `userEvent` instance for all three steps, deliberately: the top-level
     * `userEvent.click` sets itself up afresh each call and would drop the held
     * modifier, sending a plain click and testing the opposite of this.
     */
    const user = userEvent.setup();
    await user.keyboard("{Meta>}");
    await user.click(title);
    await user.keyboard("{/Meta}");

    expect(screen.getByText("Person page")).toBeInTheDocument();
    expect(chevron()).toBeInTheDocument();
  });

  it("marks the chrome that must not slide with the page", () => {
    /*
     * Both of these are siblings of the page content, so without a transition
     * name of their own they are captured as part of the sliding snapshot and
     * travel off to the right with it -- which the red utility bar visibly did.
     * The names themselves live in theme.css and jsdom applies no CSS, so what
     * is worth pinning here is that the hooks the stylesheet needs are present.
     */
    const { container } = renderShell();
    expect(container.querySelector("[data-app-header]")).toBeInTheDocument();
    expect(container.querySelector("[data-app-utility-bar]")).toBeInTheDocument();
  });

  it("leaves no direction behind when the shell goes away", async () => {
    // Signing out unmounts the shell, and a stale attribute would describe a
    // navigation that is over -- the same reason the header height is withdrawn.
    const { unmount } = renderShell();
    await userEvent.click(screen.getByRole("link", { name: "Open a person" }));
    await screen.findByText("Person page");

    unmount();
    expect(document.documentElement.dataset.nav).toBeUndefined();
  });
});

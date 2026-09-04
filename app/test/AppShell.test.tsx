import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
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

function renderShell(role: Role = "USER", orgs: { id: string; name: string }[] = []) {
  meState.role = role;
  meState.availableOrganizations = orgs;
  return render(
    <QueryClientProvider client={testQueryClient()}>
      <MemoryRouter initialEntries={["/"]}>
        <Routes>
          <Route element={<AppShell />}>
            <Route index element={<p>Directory page</p>} />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

describe("AppShell navigation", () => {
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

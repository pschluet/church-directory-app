import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import type { MeDto, Role } from "@shared";
import { AppShell } from "../src/components/AppShell";

/*
 * The contexts are stubbed rather than exercised: this file is about the shell's
 * navigation and its breakpoint behaviour, and the real providers would pull in
 * Amplify and a live /api/me.
 */
const signOut = vi.fn();

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
    switchOrganization,
  }),
}));

function renderShell(role: Role = "USER", orgs: { id: string; name: string }[] = []) {
  meState.role = role;
  meState.availableOrganizations = orgs;
  return render(
    <MemoryRouter initialEntries={["/"]}>
      <Routes>
        <Route element={<AppShell />}>
          <Route index element={<p>Directory page</p>} />
        </Route>
      </Routes>
    </MemoryRouter>
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
    expect(screen.getByRole("link", { name: "Search" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Special Dates" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Families" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "My Details" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /people & accounts/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Churches" })).not.toBeInTheDocument();
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

    expect(screen.getByRole("button", { name: /open menu/i }).className).toContain("md:hidden");
  });

  it("keeps the hamburger a full-size touch target", () => {
    renderShell();
    expect(screen.getByRole("button", { name: /open menu/i })).toHaveClass("tap-target");
  });

  it("caps the content width so it does not stretch on a wide monitor", () => {
    renderShell();
    expect(document.querySelector("main")?.className).toContain("max-w-6xl");
  });
});

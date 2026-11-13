import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route, Routes } from "react-router";
import type { PublicSignupDto } from "@shared";
import { PublicSignup } from "../src/pages/PublicSignup";
import { saveEditTokens } from "../src/lib/signups";
import { renderWithProviders } from "./utils";

const apiMock = vi.hoisted(() => vi.fn());

vi.mock("../src/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/api")>()),
  api: (...args: unknown[]) => apiMock(...args),
}));

vi.mock("../src/context/AuthContext", () => ({
  useAuth: () => ({
    status: "signedOut",
    email: null,
    error: null,
    busy: false,
    requestCode: vi.fn(),
    submitCode: vi.fn(),
    restart: vi.fn(),
  }),
}));

const TOGGLE = "Not a member? Sign up without an account.";

function signupDto(overrides: Partial<PublicSignupDto> = {}): PublicSignupDto {
  return {
    title: "Fall Festival Potluck",
    description: "Bring something to share.",
    template: "CUSTOM",
    importantInfo: null,
    noteMode: "OFF",
    notePrompt: null,
    writeInsEnabled: false,
    writeInMax: null,
    writeInCount: 0,
    closesOn: null,
    closed: false,
    cancelled: false,
    organizationName: "All Saints",
    groupName: "Hospitality Guild",
    slots: [
      {
        id: "s1",
        date: null,
        label: "Main dish",
        capacity: 3,
        taken: 1,
        isWriteIn: false,
        closed: false,
        entries: [{ id: "e1", quantity: 1, note: null }],
      },
    ],
    ...overrides,
  } as PublicSignupDto;
}

function stub(result: () => Promise<unknown>) {
  apiMock.mockImplementation((path: string) =>
    path === "/public/signups/tok123"
      ? result()
      : Promise.reject(new Error(`unexpected api call ${path}`))
  );
}

function renderPage(url = "/s/tok123") {
  return renderWithProviders(
    <Routes>
      <Route path="/s/:token" element={<PublicSignup />} />
    </Routes>,
    { initialEntries: [url] }
  );
}

beforeEach(() => {
  apiMock.mockReset();
  window.localStorage.clear();
});

describe("PublicSignup: signed out", () => {
  it("leads with sign-in and folds the sign-up away until asked", async () => {
    stub(() => Promise.resolve(signupDto()));
    renderPage();

    expect(
      await screen.findByRole("heading", { name: "Fall Festival Potluck" })
    ).toBeInTheDocument();
    expect(screen.getByText("Bring something to share.")).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Members: sign in to sign up" })
    ).toBeInTheDocument();

    const toggle = screen.getByRole("button", { name: TOGGLE });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("Main dish")).toBeNull();
    expect(screen.queryByLabelText("First name")).toBeNull();

    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("Main dish")).toBeInTheDocument();
  });

  it("starts unfolded when the URL carries an edit link", async () => {
    stub(() => Promise.resolve(signupDto()));
    renderPage("/s/tok123?entry=e1.secret");

    const toggle = await screen.findByRole("button", { name: TOGGLE });
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("Main dish")).toBeInTheDocument();
  });

  it("starts unfolded when this browser already signed up", async () => {
    saveEditTokens("tok123", { e1: "secret" });
    stub(() => Promise.resolve(signupDto()));
    renderPage();

    const toggle = await screen.findByRole("button", { name: TOGGLE });
    expect(toggle).toHaveAttribute("aria-expanded", "true");
  });

  it("offers nothing to do for a removed sign-up", async () => {
    stub(() => Promise.resolve(signupDto({ cancelled: true })));
    renderPage();

    expect(await screen.findByText("This sign-up has been removed.")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Members: sign in" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Not a member/ })).toBeNull();
    expect(screen.queryByText("Main dish")).toBeNull();
  });

  it("shows a bare sign-in gate when the sign-up is not public", async () => {
    const { ApiError } = await import("../src/lib/api");
    stub(() => Promise.reject(new ApiError(404, "Not found")));
    renderPage();

    expect(
      await screen.findByRole("heading", { name: "Sign in to see this sign-up." })
    ).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("Not a member");
  });
});

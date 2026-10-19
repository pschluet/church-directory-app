import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Login } from "../src/pages/Login";
import { renderWithProviders } from "./utils";

const apiMock = vi.fn();
vi.mock("../src/lib/api", () => ({
  api: (...args: unknown[]) => apiMock(...args),
  DEV_AUTH: false,
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

const CHURCHES = [
  { id: "org-1", name: "All Saints" },
  { id: "org-2", name: "St. George" },
];

describe("Login: request to be added", () => {
  beforeEach(() => {
    apiMock.mockReset();
    apiMock.mockImplementation((path: string) => {
      if (path === "/directory-requests/churches") return Promise.resolve({ churches: CHURCHES });
      return Promise.resolve({ ok: true });
    });
  });

  async function open() {
    renderWithProviders(<Login />);
    await userEvent.click(screen.getByRole("button", { name: "Request to be added" }));
    return screen.findByRole("dialog", { name: "Request to be added" });
  }

  it("opens a dialog listing the churches", async () => {
    await open();
    expect(await screen.findByRole("option", { name: "All Saints" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "St. George" })).toBeInTheDocument();
    expect(apiMock).toHaveBeenCalledWith("/directory-requests/churches", {
      withOrg: false,
      signal: expect.anything(),
    });
  });

  it("carries over an address already typed into the sign-in box", async () => {
    renderWithProviders(<Login />);
    await userEvent.type(screen.getByLabelText("Email address"), "maria@example.com");
    await userEvent.click(screen.getByRole("button", { name: "Request to be added" }));
    const dialog = await screen.findByRole("dialog", { name: "Request to be added" });
    expect(dialog.querySelector("input[type=email]")).toHaveValue("maria@example.com");
  });

  it("will not send until every field is filled", async () => {
    await open();
    await screen.findByRole("option", { name: "All Saints" });
    const send = screen.getByRole("button", { name: "Send request" });
    expect(send).toBeDisabled();

    await userEvent.type(screen.getByLabelText("First name"), "Maria");
    await userEvent.type(screen.getByLabelText("Last name"), "Lopez");
    await userEvent.type(screen.getAllByLabelText("Email address").at(-1)!, "maria@example.com");
    expect(send).toBeDisabled();
    await userEvent.selectOptions(screen.getByLabelText("Church"), "org-2");
    expect(send).toBeEnabled();
  });

  it("sends the request signed out and says what happens next", async () => {
    await open();
    await screen.findByRole("option", { name: "All Saints" });
    await userEvent.type(screen.getByLabelText("First name"), "Maria");
    await userEvent.type(screen.getByLabelText("Last name"), "Lopez");
    await userEvent.type(screen.getAllByLabelText("Email address").at(-1)!, "maria@example.com");
    await userEvent.selectOptions(screen.getByLabelText("Church"), "org-1");
    await userEvent.click(screen.getByRole("button", { name: "Send request" }));

    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith("/directory-requests", {
        method: "POST",
        withOrg: false,
        body: {
          firstName: "Maria",
          lastName: "Lopez",
          email: "maria@example.com",
          organizationId: "org-1",
          website: undefined,
        },
      })
    );
    expect(await screen.findByRole("dialog", { name: "Request sent" })).toBeInTheDocument();
    expect(screen.getByText(/you will get an email/)).toBeInTheDocument();
  });
});

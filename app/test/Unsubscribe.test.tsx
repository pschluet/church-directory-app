import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Unsubscribe } from "../src/pages/Unsubscribe";
import { renderWithProviders } from "./utils";

/**
 * The page behind a notification email's "Unsubscribe" link. The case that
 * matters most is the one that does nothing: arriving must not unsubscribe,
 * because mail filters open every link in a message before the reader does.
 */

const apiMock = vi.fn();

vi.mock("../src/lib/api", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/api")>("../src/lib/api");
  return { ...actual, api: (...args: unknown[]) => apiMock(...args) };
});

const TOKEN = "11111111-2222-4333-8444-555555555555";

describe("Unsubscribe", () => {
  beforeEach(() => {
    apiMock.mockReset();
    apiMock.mockResolvedValue(undefined);
  });

  it("asks first, and does nothing just by being opened", async () => {
    renderWithProviders(<Unsubscribe />, { initialEntries: [`/unsubscribe?token=${TOKEN}`] });
    expect(
      await screen.findByRole("heading", { name: "Stop notification emails?" })
    ).toBeInTheDocument();
    expect(apiMock).not.toHaveBeenCalled();
  });

  it("unsubscribes with the token when asked to", async () => {
    renderWithProviders(<Unsubscribe />, { initialEntries: [`/unsubscribe?token=${TOKEN}`] });
    await userEvent.click(await screen.findByRole("button", { name: "Unsubscribe" }));
    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith("/public/email-unsubscribe", {
        method: "POST",
        query: { token: TOKEN },
        withOrg: false,
      })
    );
    expect(
      await screen.findByRole("heading", { name: "You are unsubscribed" })
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Settings" })).toHaveAttribute("href", "/settings");
  });

  it("explains a link with no token", async () => {
    renderWithProviders(<Unsubscribe />, { initialEntries: ["/unsubscribe"] });
    expect(
      await screen.findByRole("heading", { name: "That link is incomplete" })
    ).toBeInTheDocument();
  });
});

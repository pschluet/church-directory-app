import { afterEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Help } from "../src/pages/Help";
import { renderWithProviders } from "./utils";

const IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const ANDROID =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36";
const DESKTOP =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

function renderHelp(userAgent: string) {
  vi.stubGlobal("navigator", { userAgent, maxTouchPoints: 0 });
  return renderWithProviders(<Help />);
}

function video(): HTMLVideoElement | null {
  return document.querySelector("video");
}

describe("Help", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("asks which phone, and plays nothing until one is chosen", () => {
    renderHelp(DESKTOP);

    expect(screen.getByRole("heading", { name: "Get the app on your phone" })).toBeInTheDocument();
    expect(screen.getByText(/turn on\s+notifications/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /iPhone/ })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button", { name: /Android/ })).toHaveAttribute(
      "aria-pressed",
      "false"
    );
    expect(video()).toBeNull();
  });

  it("marks the iPhone as the likely one from an iPhone's user agent", () => {
    renderHelp(IPHONE);

    expect(screen.getByRole("button", { name: /iPhone/ })).toHaveTextContent(
      "Looks like your phone"
    );
    expect(screen.getByRole("button", { name: /Android/ })).not.toHaveTextContent(
      "Looks like your phone"
    );
  });

  it("marks Android as the likely one from an Android user agent", () => {
    renderHelp(ANDROID);

    expect(screen.getByRole("button", { name: /Android/ })).toHaveTextContent(
      "Looks like your phone"
    );
    expect(screen.getByRole("button", { name: /iPhone/ })).not.toHaveTextContent(
      "Looks like your phone"
    );
  });

  it("suggests nothing on a desktop", () => {
    renderHelp(DESKTOP);

    expect(screen.queryByText("Looks like your phone")).not.toBeInTheDocument();
  });

  it("does not choose for the visitor, even when it has a guess", () => {
    renderHelp(IPHONE);

    expect(video()).toBeNull();
  });

  it("shows the iPhone recording once iPhone is chosen", async () => {
    renderHelp(DESKTOP);

    await userEvent.click(screen.getByRole("button", { name: /iPhone/ }));

    expect(screen.getByRole("button", { name: /iPhone/ })).toHaveAttribute("aria-pressed", "true");
    expect(video()).toHaveAttribute("src", "/help-media/ios-setup-v1.mp4");
    expect(video()).toHaveAttribute("poster", "/help-media/ios-setup-v1.jpg");
    expect(screen.getByText("Add to Home Screen")).toBeInTheDocument();
  });

  it("shows the Android recording once Android is chosen, and swaps when switched", async () => {
    renderHelp(DESKTOP);

    await userEvent.click(screen.getByRole("button", { name: /Android/ }));
    expect(video()).toHaveAttribute("src", "/help-media/android-setup-v1.mp4");
    expect(screen.getByText("Install app", { exact: false })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /iPhone/ }));
    expect(document.querySelectorAll("video")).toHaveLength(1);
    expect(video()).toHaveAttribute("src", "/help-media/ios-setup-v1.mp4");
    expect(screen.getByRole("button", { name: /Android/ })).toHaveAttribute(
      "aria-pressed",
      "false"
    );
  });

  it("loops the recording silently, inline, so a phone does not open a player", async () => {
    renderHelp(ANDROID);

    await userEvent.click(screen.getByRole("button", { name: /Android/ }));

    const el = video()!;
    expect(el.muted).toBe(true);
    expect(el.loop).toBe(true);
    expect(el).toHaveAttribute("playsinline");
    expect(el.autoplay).toBe(true);
  });

  it("links on to the directory", () => {
    renderHelp(DESKTOP);

    expect(screen.getByRole("link", { name: /Open the directory/ })).toHaveAttribute("href", "/");
  });
});

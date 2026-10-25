import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { EventQrModal } from "../src/components/EventQrModal";

const URL = "https://example.org/e/abc123";

describe("EventQrModal", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("renders nothing while closed", () => {
    render(<EventQrModal open={false} onClose={() => {}} url={URL} title="Picnic" />);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("shows the title, the link and the code", async () => {
    render(<EventQrModal open onClose={() => {}} url={URL} title="Picnic" />);
    expect(screen.getByRole("dialog", { name: "QR code for Picnic" })).toBeInTheDocument();
    expect(screen.getByText(URL)).toBeInTheDocument();
    expect(await screen.findByRole("img", { name: "QR code for Picnic" })).toBeInTheDocument();
  });

  it("copies the link and says so", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    render(<EventQrModal open onClose={() => {}} url={URL} title="Picnic" />);

    await userEvent.click(screen.getByRole("button", { name: "Copy link" }));
    expect(writeText).toHaveBeenCalledWith(URL);
    await waitFor(() => expect(screen.getByRole("button", { name: "Copied" })).toBeInTheDocument());
  });

  it("closes on Escape and on the close button", async () => {
    const onClose = vi.fn();
    render(<EventQrModal open onClose={onClose} url={URL} title="Picnic" />);
    await userEvent.keyboard("{Escape}");
    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});

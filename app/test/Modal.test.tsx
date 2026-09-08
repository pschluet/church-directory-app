import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { Modal } from "../src/components/ui";

/**
 * Where the modal renders, which turned out to matter.
 *
 * `position: fixed` is only relative to the viewport while no ancestor has made
 * itself a containing block. Google's InfoWindow positions its bubble with a
 * transform and clips it, so the maps chooser opened from an address inside a
 * map popover came out as an unusable sliver a few pixels wide, trapped in the
 * bubble. Nothing else in the app has an ancestor that does that, which is why
 * it went unnoticed — and why a test that only checks the modal's contents
 * would keep passing while it happened.
 */
describe("Modal", () => {
  it("renders into the body rather than where it was written", () => {
    const { container } = render(
      <div style={{ transform: "translate(10px, 10px)", overflow: "hidden" }}>
        <Modal title="Open in Maps" onClose={vi.fn()}>
          <p>Apple Maps or Google Maps</p>
        </Modal>
      </div>
    );

    const dialog = screen.getByRole("dialog", { name: "Open in Maps" });
    expect(dialog).toBeInTheDocument();
    // The point: not inside the transformed, clipping ancestor.
    expect(container.contains(dialog)).toBe(false);
    expect(document.body.contains(dialog)).toBe(true);
  });

  it("is still findable and still closes", async () => {
    // Portalling must not have quietly broken every other caller.
    const onClose = vi.fn();
    render(
      <Modal title="Rename church" onClose={onClose}>
        <p>Body</p>
      </Modal>
    );
    expect(screen.getByText("Body")).toBeInTheDocument();

    const { default: userEvent } = await import("@testing-library/user-event");
    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalled();
  });
});

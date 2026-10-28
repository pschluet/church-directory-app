import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
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

  it("cannot be dismissed when dismissable is false", async () => {
    const onClose = vi.fn();
    render(
      <Modal title="Group Guidelines" onClose={onClose} dismissable={false}>
        <p>Body</p>
      </Modal>
    );
    expect(screen.queryByRole("button", { name: "Close" })).not.toBeInTheDocument();

    const { default: userEvent } = await import("@testing-library/user-event");
    await userEvent.keyboard("{Escape}");
    await userEvent.click(screen.getByRole("dialog", { name: "Group Guidelines" }));
    expect(onClose).not.toHaveBeenCalled();
  });

  describe("on a phone with the keyboard up", () => {
    // On iOS `position: fixed` ignores the keyboard, so a sheet pinned to the
    // layout viewport sits behind it and Safari pans it off screen to reveal
    // the focused field. The overlay follows the visual viewport instead.
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    function stubViewport(height: number, offsetTop: number) {
      const listeners: Record<string, () => void> = {};
      const viewport = {
        height,
        offsetTop,
        addEventListener: (type: string, listener: () => void) => {
          listeners[type] = listener;
        },
        removeEventListener: vi.fn(),
      };
      vi.stubGlobal("visualViewport", viewport);
      return { viewport, listeners };
    }

    it("covers only what is on screen, and follows it as the keyboard opens", () => {
      const { viewport, listeners } = stubViewport(800, 0);
      render(
        <Modal title="Add a link" onClose={vi.fn()}>
          <input aria-label="Link" />
        </Modal>
      );
      const dialog = screen.getByRole("dialog", { name: "Add a link" });
      expect(dialog.style.top).toBe("0px");
      expect(dialog.style.height).toBe("800px");

      // The keyboard takes the bottom of the screen and Safari pans a little.
      viewport.height = 450;
      viewport.offsetTop = 40;
      act(() => listeners.resize?.());
      expect(dialog.style.top).toBe("40px");
      expect(dialog.style.height).toBe("450px");
      expect(dialog).not.toHaveClass("inset-y-0");
    });

    it("stops listening once closed", () => {
      const { viewport } = stubViewport(800, 0);
      const { unmount } = render(
        <Modal title="Add a link" onClose={vi.fn()}>
          <p>Body</p>
        </Modal>
      );
      unmount();
      expect(viewport.removeEventListener).toHaveBeenCalledWith("resize", expect.any(Function));
      expect(viewport.removeEventListener).toHaveBeenCalledWith("scroll", expect.any(Function));
    });
  });

  it("fills the window where there is no visual viewport to follow", () => {
    vi.stubGlobal("visualViewport", undefined);
    render(
      <Modal title="Rename church" onClose={vi.fn()}>
        <p>Body</p>
      </Modal>
    );
    const dialog = screen.getByRole("dialog", { name: "Rename church" });
    expect(dialog).toHaveClass("inset-y-0");
    expect(dialog.style.height).toBe("");
    vi.unstubAllGlobals();
  });
});

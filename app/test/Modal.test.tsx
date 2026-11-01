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
});

/**
 * On iOS a software keyboard shrinks only the visual viewport, so a fixed sheet
 * pinned to the bottom of the layout viewport ended up behind it -- the "Add a
 * link" dialog could not be seen while typing in it.
 */
describe("Modal and the on-screen keyboard", () => {
  class FakeViewport extends EventTarget {
    constructor(
      public height: number,
      public offsetTop = 0
    ) {
      super();
    }
  }

  afterEach(() => {
    Reflect.deleteProperty(window, "visualViewport");
  });

  it("leaves the sheet where it is while nothing covers the screen", () => {
    window.innerHeight = 800;
    Object.defineProperty(window, "visualViewport", {
      value: new FakeViewport(800, 0),
      configurable: true,
    });
    render(
      <Modal title="Add a link" onClose={vi.fn()}>
        <input aria-label="Link" />
      </Modal>
    );
    const dialog = screen.getByRole("dialog", { name: "Add a link" });
    expect(dialog.style.paddingBottom).toBe("");
  });

  it("lifts the sheet above the keyboard when the viewport shrinks", () => {
    window.innerHeight = 800;
    const viewport = new FakeViewport(800, 0);
    Object.defineProperty(window, "visualViewport", { value: viewport, configurable: true });
    render(
      <Modal title="Add a link" onClose={vi.fn()}>
        <input aria-label="Link" />
      </Modal>
    );

    // The keyboard opens, and iOS pans the page down a little.
    viewport.height = 480;
    viewport.offsetTop = 40;
    act(() => {
      viewport.dispatchEvent(new Event("resize"));
    });

    const dialog = screen.getByRole("dialog", { name: "Add a link" });
    // The backdrop still fills the screen; the sheet is lifted by what is covered.
    expect(dialog.className).toContain("inset-0");
    expect(dialog.style.paddingBottom).toBe("280px");
    // And it leaves room for the keyboard rather than keeping 92% of the window.
    expect((dialog.firstElementChild as HTMLElement).style.maxHeight).toBe("442px");
  });

  it("works the covered area out from the overlay, not from innerHeight", () => {
    // When iOS scrolls the page to reveal a field, innerHeight shrinks (812 became
    // 756 in the "New poll" sheet) while the fixed overlay stays full height. Going
    // by innerHeight left the sheet 56px too low, its buttons under the keyboard.
    window.innerHeight = 756;
    const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight");
    Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
      configurable: true,
      get: () => 812,
    });
    try {
      const viewport = new FakeViewport(416, 192);
      Object.defineProperty(window, "visualViewport", { value: viewport, configurable: true });
      render(
        <Modal title="New poll" onClose={vi.fn()}>
          <input aria-label="Question" />
        </Modal>
      );
      const dialog = screen.getByRole("dialog", { name: "New poll" });
      expect(dialog.style.paddingBottom).toBe("204px"); // 812 - 192 - 416, not 756 - 192 - 416
    } finally {
      if (original) Object.defineProperty(HTMLElement.prototype, "offsetHeight", original);
      else Reflect.deleteProperty(HTMLElement.prototype, "offsetHeight");
    }
  });

  it("does not take a pinch-zoom for a keyboard", () => {
    window.innerHeight = 800;
    const viewport = Object.assign(new FakeViewport(400, 0), { scale: 2 });
    Object.defineProperty(window, "visualViewport", { value: viewport, configurable: true });
    render(
      <Modal title="Add a link" onClose={vi.fn()}>
        <input aria-label="Link" />
      </Modal>
    );
    const dialog = screen.getByRole("dialog", { name: "Add a link" });
    expect(dialog.style.paddingBottom).toBe("");
  });

  it("keeps its CSS sizing where the browser has no visual viewport", () => {
    render(
      <Modal title="Add a link" onClose={vi.fn()}>
        <input aria-label="Link" />
      </Modal>
    );
    const dialog = screen.getByRole("dialog", { name: "Add a link" });
    expect(dialog.style.paddingBottom).toBe("");
    expect(dialog.className).toContain("inset-0");
  });
});

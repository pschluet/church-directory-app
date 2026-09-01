import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MenuButton, MenuItem } from "../src/components/ui";

function renderMenu(onSelect = vi.fn()) {
  render(
    <>
      <button type="button">Outside</button>
      <MenuButton label="Family actions">
        <MenuItem onSelect={onSelect}>Rename family</MenuItem>
        <MenuItem onSelect={onSelect}>Add a photo</MenuItem>
        <MenuItem danger onSelect={onSelect}>
          Remove photo
        </MenuItem>
      </MenuButton>
    </>
  );
  return { onSelect, trigger: screen.getByRole("button", { name: "Family actions" }) };
}

const itemNames = () =>
  screen.getAllByRole("menuitem").map((item) => item.textContent?.trim() ?? "");

describe("MenuButton", () => {
  it("keeps its items out of the page until it is opened", () => {
    renderMenu();
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("opens on click and reports it to assistive technology", async () => {
    const { trigger } = renderMenu();
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(trigger).toHaveAttribute("aria-haspopup", "menu");

    await userEvent.click(trigger);

    expect(screen.getByRole("menu")).toBeInTheDocument();
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(itemNames()).toEqual(["Rename family", "Add a photo", "Remove photo"]);
  });

  it("moves focus to the first item so the arrow keys have somewhere to start", async () => {
    const { trigger } = renderMenu();
    await userEvent.click(trigger);

    expect(screen.getByRole("menuitem", { name: "Rename family" })).toHaveFocus();
  });

  it("walks down and up with the arrow keys, wrapping at both ends", async () => {
    const { trigger } = renderMenu();
    await userEvent.click(trigger);

    await userEvent.keyboard("{ArrowDown}");
    expect(screen.getByRole("menuitem", { name: "Add a photo" })).toHaveFocus();

    await userEvent.keyboard("{ArrowDown}");
    expect(screen.getByRole("menuitem", { name: "Remove photo" })).toHaveFocus();

    // Wraps forward...
    await userEvent.keyboard("{ArrowDown}");
    expect(screen.getByRole("menuitem", { name: "Rename family" })).toHaveFocus();

    // ...and back.
    await userEvent.keyboard("{ArrowUp}");
    expect(screen.getByRole("menuitem", { name: "Remove photo" })).toHaveFocus();
  });

  it("jumps to either end with Home and End", async () => {
    const { trigger } = renderMenu();
    await userEvent.click(trigger);

    await userEvent.keyboard("{End}");
    expect(screen.getByRole("menuitem", { name: "Remove photo" })).toHaveFocus();

    await userEvent.keyboard("{Home}");
    expect(screen.getByRole("menuitem", { name: "Rename family" })).toHaveFocus();
  });

  it("runs the item and closes on click", async () => {
    const { trigger, onSelect } = renderMenu();
    await userEvent.click(trigger);
    await userEvent.click(screen.getByRole("menuitem", { name: "Add a photo" }));

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("runs the focused item on Enter", async () => {
    const { trigger, onSelect } = renderMenu();
    await userEvent.click(trigger);
    await userEvent.keyboard("{Enter}");

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("closes on Escape and hands focus back to the button", async () => {
    const { trigger, onSelect } = renderMenu();
    await userEvent.click(trigger);
    await userEvent.keyboard("{Escape}");

    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    // Otherwise focus lands on <body> and the next Tab restarts at the top.
    expect(trigger).toHaveFocus();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("closes when something else on the page is pressed", async () => {
    const { trigger, onSelect } = renderMenu();
    await userEvent.click(trigger);
    await userEvent.click(screen.getByRole("button", { name: "Outside" }));

    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("closes again when its own button is pressed a second time", async () => {
    const { trigger } = renderMenu();
    await userEvent.click(trigger);
    await userEvent.click(trigger);

    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });
});

/**
 * jsdom gives every element a 0x0 box, so placement cannot be exercised without
 * saying where things are. Puts the trigger `roomBelow` pixels above the bottom
 * of a 800px viewport and gives the panel a real height.
 */
function stubGeometry({ roomBelow, panelHeight }: { roomBelow: number; panelHeight: number }) {
  const VIEWPORT = 800;
  Object.defineProperty(window, "innerHeight", { writable: true, value: VIEWPORT });
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    const isPanel = this.getAttribute("role") === "menu";
    const top = isPanel ? 0 : VIEWPORT - roomBelow - 44;
    const height = isPanel ? panelHeight : 44;
    return {
      x: 0,
      y: top,
      top,
      bottom: top + height,
      left: 0,
      right: 224,
      width: 224,
      height,
      toJSON: () => ({}),
    } as DOMRect;
  });
}

describe("MenuButton placement", () => {
  it("opens below the button when there is room", async () => {
    stubGeometry({ roomBelow: 400, panelHeight: 120 });
    const { trigger } = renderMenu();
    await userEvent.click(trigger);

    const panel = screen.getByRole("menu");
    expect(panel.className).toContain("top-full");
    expect(panel.className).not.toContain("bottom-full");
  });

  it("flips above the button when the panel would not fit below", async () => {
    // The last row of a list near the bottom of the screen: 20px of room for a
    // 120px panel. Before this, the panel hung off-screen -- and inside a
    // clipping ancestor, revealing it scrolled the list instead.
    stubGeometry({ roomBelow: 20, panelHeight: 120 });
    const { trigger } = renderMenu();
    await userEvent.click(trigger);

    const panel = screen.getByRole("menu");
    expect(panel.className).toContain("bottom-full");
    expect(panel.className).not.toContain("top-full");
  });

  it("stays below when neither side fits, rather than pinning to the top", async () => {
    // A panel taller than the viewport: flipping gains nothing and would put the
    // first item off the top instead of the last off the bottom.
    stubGeometry({ roomBelow: 700, panelHeight: 2000 });
    const { trigger } = renderMenu();
    await userEvent.click(trigger);

    expect(screen.getByRole("menu").className).toContain("top-full");
  });

  it("measures again on the next open, rather than reusing the last placement", async () => {
    stubGeometry({ roomBelow: 20, panelHeight: 120 });
    const { trigger } = renderMenu();
    await userEvent.click(trigger);
    expect(screen.getByRole("menu").className).toContain("bottom-full");

    await userEvent.click(trigger);
    stubGeometry({ roomBelow: 400, panelHeight: 120 });
    await userEvent.click(trigger);
    expect(screen.getByRole("menu").className).toContain("top-full");
  });
});

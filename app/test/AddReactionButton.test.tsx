import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { AddReactionButton } from "../src/components/Reactions";

describe("AddReactionButton", () => {
  it("lets a press take focus, as any button does, by default", () => {
    render(<AddReactionButton onPick={vi.fn()} />);
    const notPrevented = fireEvent.mouseDown(screen.getByRole("button", { name: "Add reaction" }));
    expect(notPrevented).toBe(true);
  });

  it("keeps focus where it was when asked, for a button beside a text field", () => {
    render(<AddReactionButton keepFocus label="Add emoji" onPick={vi.fn()} />);
    const notPrevented = fireEvent.mouseDown(screen.getByRole("button", { name: "Add emoji" }));
    expect(notPrevented).toBe(false);
  });
});

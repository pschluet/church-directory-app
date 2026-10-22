import { describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Field, Modal, Select } from "../src/components/ui";

const MONTHS = [
  { value: "1", label: "January" },
  { value: "2", label: "February" },
  { value: "3", label: "March" },
  { value: "5", label: "May" },
];

function Harness({
  initial = "1",
  onChange = () => {},
  ...props
}: Partial<React.ComponentProps<typeof Select>> & { initial?: string }) {
  const [value, setValue] = useState(initial);
  return (
    <Field label="Month">
      <Select
        options={MONTHS}
        {...props}
        value={value}
        onChange={(next) => {
          setValue(next);
          onChange(next);
        }}
      />
    </Field>
  );
}

const trigger = () => screen.getByRole("combobox", { name: "Month" });

describe("Select", () => {
  it("shows the chosen label, and opens a list with it marked", async () => {
    render(<Harness initial="2" />);
    expect(trigger()).toHaveTextContent("February");
    expect(trigger()).toHaveAttribute("aria-expanded", "false");

    await userEvent.click(trigger());
    expect(trigger()).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("option", { name: "February" })).toHaveAttribute(
      "aria-selected",
      "true"
    );
    expect(screen.getAllByRole("option")).toHaveLength(4);
  });

  it("picks an option on click, closes, and keeps focus on the button", async () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    await userEvent.click(trigger());
    await userEvent.click(screen.getByRole("option", { name: "March" }));

    expect(onChange).toHaveBeenCalledWith("3");
    expect(trigger()).toHaveTextContent("March");
    // Inside a Field the button sits in a <label>; a click that reached it would
    // open the list straight back up.
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(trigger()).toHaveFocus();
  });

  it("does not report the option that is already chosen as a change", async () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    await userEvent.click(trigger());
    await userEvent.click(screen.getByRole("option", { name: "January" }));
    expect(onChange).not.toHaveBeenCalled();
  });

  it("is driven from the keyboard", async () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    trigger().focus();

    await userEvent.keyboard("{ArrowDown}");
    expect(screen.getByRole("listbox")).toBeInTheDocument();
    await userEvent.keyboard("{ArrowDown}{ArrowDown}");
    expect(trigger()).toHaveAttribute(
      "aria-activedescendant",
      screen.getByRole("option", { name: "March" }).id
    );
    await userEvent.keyboard("{End}{Enter}");
    expect(onChange).toHaveBeenLastCalledWith("5");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("jumps to an option by typing its first letters", async () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    trigger().focus();
    await userEvent.keyboard("{Enter}");
    await userEvent.keyboard("ma");
    await userEvent.keyboard("{Enter}");
    expect(onChange).toHaveBeenCalledWith("3");
  });

  it("closes on Escape without closing the dialog it sits in", async () => {
    const onClose = vi.fn();
    render(
      <Modal title="Date" onClose={onClose}>
        <Harness />
      </Modal>
    );
    await userEvent.click(trigger());
    await userEvent.keyboard("{Escape}");

    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(trigger()).toHaveFocus();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("closes when something else on the page is pressed", async () => {
    render(
      <>
        <Harness />
        <button type="button">Elsewhere</button>
      </>
    );
    await userEvent.click(trigger());
    await userEvent.click(screen.getByRole("button", { name: "Elsewhere" }));
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("stays open while the page scrolls under it", async () => {
    render(<Harness />);
    await userEvent.click(trigger());
    window.dispatchEvent(new Event("scroll"));
    document.dispatchEvent(new Event("scroll"));
    await new Promise((resolve) => requestAnimationFrame(resolve));
    expect(screen.getByRole("listbox")).toBeInTheDocument();
  });

  it("shows the placeholder until something is chosen", () => {
    render(<Harness initial="" placeholder="Choose a month…" />);
    expect(trigger()).toHaveTextContent("Choose a month…");
  });

  it("will not open while disabled", async () => {
    render(<Harness disabled />);
    expect(trigger()).toBeDisabled();
    await userEvent.click(trigger());
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("holds a form back while it is required and empty", async () => {
    const onSubmit = vi.fn((event: React.FormEvent) => event.preventDefault());
    render(
      <form onSubmit={onSubmit}>
        <Harness initial="" required placeholder="Choose a month…" />
        <button type="submit">Save</button>
      </form>
    );
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onSubmit).not.toHaveBeenCalled();

    await userEvent.click(trigger());
    await userEvent.click(screen.getByRole("option", { name: "May" }));
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });
});

import { describe, expect, it } from "vitest";
import { useState } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MultiSelect } from "../src/components/ui";

const COLORS = [
  { value: "red", label: "Red" },
  { value: "green", label: "Green" },
  { value: "blue", label: "Blue" },
];

function Harness({ initial = [] as string[] }) {
  const [values, setValues] = useState(initial);
  return (
    <MultiSelect
      aria-label="Colors"
      allLabel="All colors"
      summarize={(count) => `${count} colors`}
      options={COLORS}
      values={values}
      onChange={setValues}
    />
  );
}

const trigger = () => screen.getByRole("combobox", { name: "Colors" });

describe("MultiSelect", () => {
  it("names nothing, one, or how many are chosen", async () => {
    render(<Harness />);
    expect(trigger()).toHaveTextContent("All colors");

    await userEvent.click(trigger());
    await userEvent.click(screen.getByRole("option", { name: "Green" }));
    expect(trigger()).toHaveTextContent("Green");

    await userEvent.click(screen.getByRole("option", { name: "Red" }));
    expect(trigger()).toHaveTextContent("2 colors");
    expect(screen.getByRole("option", { name: "Red" })).toHaveAttribute("aria-selected", "true");
  });

  it("toggles from the keyboard and stays open until Escape", async () => {
    render(<Harness initial={["blue"]} />);
    trigger().focus();

    await userEvent.keyboard("{ArrowDown}");
    expect(screen.getByRole("listbox", { name: "Colors" })).toBeInTheDocument();

    // Opens on the first option; Enter toggles it on, End then Space toggles Blue off.
    await userEvent.keyboard("{Enter}");
    await userEvent.keyboard("{End}");
    await userEvent.keyboard(" ");
    expect(trigger()).toHaveTextContent("Red");
    expect(screen.getByRole("listbox")).toBeInTheDocument();

    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(trigger()).toHaveFocus();
  });
});

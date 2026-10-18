import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SuggestInput } from "../src/components/SuggestInput";
import { renderWithProviders } from "./utils";

const fetchSuggestions = vi.fn();

function Harness({ onEscape }: { onEscape?: () => void }) {
  const [value, setValue] = useState("");
  return (
    <div onKeyDown={(event) => event.key === "Escape" && onEscape?.()}>
      <form onSubmit={(event) => event.preventDefault()}>
        <SuggestInput
          label="Occupation"
          value={value}
          onChange={setValue}
          queryKey={(term) => ["occupations", term]}
          fetchSuggestions={(term, signal) => fetchSuggestions(term, signal)}
        />
      </form>
    </div>
  );
}

const box = () => screen.getByRole("combobox", { name: "Occupation" });

describe("SuggestInput", () => {
  it("suggests after a pause in typing, and fills the box from a click", async () => {
    fetchSuggestions.mockReset().mockResolvedValue(["Teacher", "Tennis coach"]);
    renderWithProviders(<Harness />);

    await userEvent.type(box(), "te");
    await userEvent.click(await screen.findByRole("option", { name: "Teacher" }));

    expect(box()).toHaveValue("Teacher");
    expect(fetchSuggestions).toHaveBeenCalledWith("te", expect.anything());
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("picks the highlighted option with the keyboard, and only then", async () => {
    fetchSuggestions.mockReset().mockResolvedValue(["Teacher", "Tennis coach"]);
    renderWithProviders(<Harness />);

    await userEvent.type(box(), "te");
    await screen.findByRole("option", { name: "Tennis coach" });
    await userEvent.keyboard("{ArrowDown}{ArrowDown}{Enter}");

    expect(box()).toHaveValue("Tennis coach");
  });

  it("keeps free text that is not in the list", async () => {
    fetchSuggestions.mockReset().mockResolvedValue(["Teacher"]);
    renderWithProviders(<Harness />);

    await userEvent.type(box(), "Tea");
    await screen.findByRole("option", { name: "Teacher" });
    await userEvent.type(box(), "pot maker{Enter}");

    expect(box()).toHaveValue("Teapot maker");
  });

  it("shows nothing when there is nothing to suggest", async () => {
    fetchSuggestions.mockReset().mockResolvedValue([]);
    renderWithProviders(<Harness />);

    await userEvent.type(box(), "zz");
    await waitFor(() => expect(fetchSuggestions).toHaveBeenCalled());
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("does not suggest exactly what is already typed", async () => {
    fetchSuggestions.mockReset().mockResolvedValue(["Teacher"]);
    renderWithProviders(<Harness />);

    await userEvent.type(box(), "teacher");
    await waitFor(() => expect(fetchSuggestions).toHaveBeenCalled());
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("closes the list on Escape without letting the dialog around it hear", async () => {
    fetchSuggestions.mockReset().mockResolvedValue(["Teacher"]);
    const onEscape = vi.fn();
    renderWithProviders(<Harness onEscape={onEscape} />);

    await userEvent.type(box(), "te");
    await screen.findByRole("listbox");
    await userEvent.keyboard("{Escape}");

    expect(screen.queryByRole("listbox")).toBeNull();
    expect(onEscape).not.toHaveBeenCalled();
  });
});

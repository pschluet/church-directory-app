import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { GROUP_GUIDELINES, type MeDto } from "@shared";
import { GroupGuidelinesInfo } from "../src/components/GroupGuidelinesInfo";

let agreedAt: string | null = "2026-10-18T15:00:00.000Z";

vi.mock("../src/context/MeContext", () => ({
  useMe: () => ({ me: { groupGuidelinesAgreedAt: agreedAt } as unknown as MeDto }),
}));

describe("GroupGuidelinesInfo", () => {
  it("opens the guidelines with the date they were agreed to, and closes", async () => {
    render(<GroupGuidelinesInfo />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "View group guidelines" }));
    const expected = new Date(agreedAt!).toLocaleDateString(undefined, {
      month: "long",
      day: "numeric",
      year: "numeric",
    });
    expect(
      screen.getByText(`These are the group guidelines you agreed to on ${expected}.`)
    ).toBeInTheDocument();
    expect(screen.getAllByRole("listitem")).toHaveLength(GROUP_GUIDELINES.length);

    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("still lists the guidelines without a date", async () => {
    agreedAt = null;
    render(<GroupGuidelinesInfo />);
    await userEvent.click(screen.getByRole("button", { name: "View group guidelines" }));
    expect(
      screen.getByText("These are the group guidelines for using the groups page.")
    ).toBeInTheDocument();
  });
});

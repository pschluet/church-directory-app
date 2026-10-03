import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { FamilySummaryDto } from "@shared";
import { FamilyPicker, type PickedFamily } from "../src/components/FamilyPicker";
import { renderWithProviders } from "./utils";

vi.mock("../src/context/MeContext", () => ({
  useMe: () => ({ organizationId: "org-1" }),
}));

function family(
  overrides: Partial<FamilySummaryDto> & { id: string; name: string }
): FamilySummaryDto {
  return {
    memberCount: 0,
    memberNames: [],
    thumbUrl: null,
    cardUrl: null,
    pendingJoinRequestId: null,
    ...overrides,
  };
}

const HADDAD = family({ id: "fam-1", name: "Haddad", memberNames: ["Layla", "Sami"] });
const NASSIF = family({ id: "fam-2", name: "Nassif" });
const IVANOV = family({ id: "fam-3", name: "Ivanov", memberNames: ["Boris"] });

function renderPicker(
  props: Partial<React.ComponentProps<typeof FamilyPicker>> & {
    onChange?: (f: PickedFamily | null) => void;
  } = {}
) {
  const onChange = props.onChange ?? vi.fn();
  renderWithProviders(
    <FamilyPicker
      label="Search for a family"
      value={null}
      families={[HADDAD, NASSIF, IVANOV]}
      {...props}
      onChange={onChange}
    />
  );
  return { onChange };
}

const box = () => screen.getByRole("combobox", { name: /search for a family/i });

/*
 * Matching happens synchronously over the `families` prop, with no `api`
 * mock -- unlike PersonPicker, there is no server round trip to wait on. The
 * fake timers are only for LookupPicker's own 250ms debounce, same reason
 * PersonPicker.test.tsx needs them.
 */
describe("FamilyPicker", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const user = () => userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

  it("shows every candidate once opened, before anything is typed", async () => {
    renderPicker();
    await user().click(box());
    vi.advanceTimersByTime(250);

    expect(await screen.findByRole("option", { name: /Haddad/ })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /Nassif/ })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /Ivanov/ })).toBeInTheDocument();
  });

  it("narrows to what was typed, after a pause", async () => {
    renderPicker();
    await user().type(box(), "had");
    vi.advanceTimersByTime(250);

    expect(await screen.findByRole("option", { name: /Haddad/ })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /Nassif/ })).not.toBeInTheDocument();
  });

  it("requires every typed term, the same as the families page's own search", async () => {
    const families = [HADDAD, family({ id: "fam-4", name: "Haddad Nassif" }), NASSIF];
    renderPicker({ families });
    await user().type(box(), "nas had");
    vi.advanceTimersByTime(250);

    expect(await screen.findByRole("option", { name: /Haddad Nassif/ })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "Haddad" })).not.toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "Nassif" })).not.toBeInTheDocument();
  });

  it("leaves out the ids it's told to, entirely", async () => {
    renderPicker({ excludeFamilyIds: ["fam-1"] });
    await user().click(box());
    vi.advanceTimersByTime(250);

    await screen.findByRole("option", { name: /Nassif/ });
    expect(screen.queryByRole("option", { name: /Haddad/ })).not.toBeInTheDocument();
  });

  it("shows the members as the detail line, or says there are none", async () => {
    renderPicker();
    await user().click(box());
    vi.advanceTimersByTime(250);

    expect(await screen.findByText("Layla, Sami")).toBeInTheDocument();
    expect(screen.getByText("No members yet")).toBeInTheDocument();
  });

  it("picks an option with the mouse", async () => {
    const { onChange } = renderPicker();
    await user().click(box());
    vi.advanceTimersByTime(250);

    await user().click(await screen.findByRole("option", { name: /Haddad/ }));
    expect(onChange).toHaveBeenCalledWith({ id: "fam-1", name: "Haddad" });
  });

  it("picks the highlighted option with the keyboard", async () => {
    const { onChange } = renderPicker();
    await user().type(box(), "a");
    vi.advanceTimersByTime(250);
    await screen.findByRole("option", { name: /Haddad/ });

    await user().keyboard("{ArrowDown}{Enter}");
    expect(onChange).toHaveBeenCalledWith({ id: "fam-2", name: "Nassif" });
  });

  it("says so, by name, when nothing matches", async () => {
    renderPicker();
    await user().type(box(), "zzz");
    vi.advanceTimersByTime(250);

    // Not LookupPicker's default person-oriented wording.
    expect(await screen.findByText(/No family matches “zzz”/)).toBeInTheDocument();
    expect(screen.queryByText(/No one matches/)).not.toBeInTheDocument();
  });

  it("says there is nothing to choose from when every family is excluded", async () => {
    renderPicker({
      families: [HADDAD],
      excludeFamilyIds: ["fam-1"],
    });
    await user().click(box());
    vi.advanceTimersByTime(250);

    expect(await screen.findByText(/no families to choose from/i)).toBeInTheDocument();
  });

  it("offers a way to clear a chosen family", async () => {
    const { onChange } = renderPicker({ value: { id: "fam-1", name: "Haddad" } });
    await user().click(screen.getByRole("button", { name: /clear haddad/i }));

    expect(onChange).toHaveBeenCalledWith(null);
    expect(box()).toHaveValue("");
  });
});

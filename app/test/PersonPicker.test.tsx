import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { PersonLookupDto } from "@shared";
import { PersonPicker, type PickedPerson } from "../src/components/PersonPicker";
import { renderWithProviders } from "./utils";

const api = vi.fn();
vi.mock("../src/lib/api", () => ({
  api: (...args: unknown[]) => api(...args),
  DEV_AUTH: false,
  uploadPhoto: vi.fn(),
}));

vi.mock("../src/context/MeContext", () => ({
  useMe: () => ({ organizationId: "org-1" }),
}));

const MARIA: PersonLookupDto = { id: "maria-id", name: "Maria Schlueter", familyName: "Schlueter" };
const MARIO: PersonLookupDto = { id: "mario-id", name: "Mario Popov", familyName: "Popov" };

function renderPicker(value: PickedPerson | null = null) {
  const onChange = vi.fn();
  renderWithProviders(
    <PersonPicker
      label="Married to"
      value={value}
      onChange={onChange}
      excludePersonId="person-id"
    />
  );
  return { onChange };
}

const box = () => screen.getByRole("combobox", { name: /married to/i });

describe("PersonPicker", () => {
  beforeEach(() => {
    api.mockReset();
    api.mockResolvedValue({ people: [MARIA, MARIO] });
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** userEvent needs its own timer wiring once the debounce is faked. */
  const user = () => userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

  it("searches on the server after a pause, not on every keystroke", async () => {
    renderPicker();
    await user().type(box(), "mar");

    // Still inside the debounce window.
    expect(api).not.toHaveBeenCalled();

    vi.advanceTimersByTime(250);
    await waitFor(() => expect(api).toHaveBeenCalledTimes(1));
    expect(api).toHaveBeenCalledWith("/directory/lookup", {
      // React Query hands the query function an abort signal, which api()
      // forwards to fetch.
      signal: expect.any(AbortSignal),
      query: { q: "mar", exclude: "person-id" },
    });

    expect(await screen.findByRole("option", { name: /Maria Schlueter/ })).toBeInTheDocument();
  });

  it("picks the highlighted option with the keyboard", async () => {
    const { onChange } = renderPicker();
    const u = user();
    await u.type(box(), "mar");
    vi.advanceTimersByTime(250);
    await screen.findByRole("option", { name: /Maria Schlueter/ });

    // First Down opens/keeps the list on the first row; a second moves on.
    await u.keyboard("{ArrowDown}{Enter}");

    expect(onChange).toHaveBeenCalledWith({ id: "mario-id", name: "Mario Popov" });
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("picks an option with the mouse", async () => {
    const { onChange } = renderPicker();
    const u = user();
    await u.click(box());
    vi.advanceTimersByTime(250);

    await u.click(await screen.findByRole("option", { name: /Maria Schlueter/ }));
    expect(onChange).toHaveBeenCalledWith({ id: "maria-id", name: "Maria Schlueter" });
  });

  it("shows the family name so like-named people can be told apart", async () => {
    renderPicker();
    await user().click(box());
    vi.advanceTimersByTime(250);

    expect(await screen.findByText("Schlueter family")).toBeInTheDocument();
    expect(screen.getByText("Popov family")).toBeInTheDocument();
  });

  it("closes on Escape and restores the chosen name", async () => {
    renderPicker({ id: "maria-id", name: "Maria Schlueter" });
    const u = user();
    await u.type(box(), "xyz");
    expect(box()).toHaveValue("Maria Schlueterxyz");

    await u.keyboard("{Escape}");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(box()).toHaveValue("Maria Schlueter");
  });

  it("says so when nothing matches", async () => {
    api.mockResolvedValue({ people: [] });
    renderPicker();
    await user().type(box(), "zzz");
    vi.advanceTimersByTime(250);

    expect(await screen.findByText(/No one matches “zzz”/)).toBeInTheDocument();
  });

  // Typing over a chosen name has to un-choose it, or the stored id and the
  // visible text drift apart.
  it("clears the selection as soon as the text is edited", async () => {
    const { onChange } = renderPicker({ id: "maria-id", name: "Maria Schlueter" });
    await user().type(box(), "x");
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it("offers a way to clear a chosen person", async () => {
    const { onChange } = renderPicker({ id: "maria-id", name: "Maria Schlueter" });
    await user().click(screen.getByRole("button", { name: /clear maria schlueter/i }));

    expect(onChange).toHaveBeenCalledWith(null);
    expect(box()).toHaveValue("");
  });
});

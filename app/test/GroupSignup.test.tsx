import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { GroupSignupDto, MeDto } from "@shared";
import { SignupBlock, SignupComposerModal, signupPayload } from "../src/components/GroupSignup";
import { renderWithProviders } from "./utils";

const apiMock = vi.fn();
vi.mock("../src/lib/api", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/api")>("../src/lib/api");
  return { ...actual, api: (...args: unknown[]) => apiMock(...args) };
});
vi.mock("../src/context/MeContext", () => ({
  useMe: () => ({
    me: { organization: { name: "All Saints" } } as unknown as MeDto,
    isAdmin: false,
    organizationId: "org-1",
    maps: null,
  }),
}));

function signup(overrides: Partial<GroupSignupDto> = {}): GroupSignupDto {
  return {
    title: "Parish Potluck",
    description: null,
    template: "POTLUCK",
    recipient: null,
    importantInfo: null,
    noteMode: "REQUIRED",
    notePrompt: "What are you bringing?",
    writeInsEnabled: false,
    writeInMax: null,
    writeInCount: 0,
    publicEnabled: false,
    shareToken: "TOKEN",
    closesOn: null,
    closed: false,
    canManage: false,
    slots: [
      {
        id: "main",
        date: null,
        label: "Main dish",
        capacity: 4,
        taken: 1,
        isWriteIn: false,
        closed: false,
        entries: [
          {
            id: "e1",
            personId: "person-ann",
            name: "Ann Lee",
            quantity: 1,
            note: "Lasagna",
            isPublic: false,
            isMine: false,
            email: null,
            canRemove: false,
          },
        ],
      },
      {
        id: "dessert",
        date: null,
        label: "Dessert",
        capacity: 1,
        taken: 0,
        isWriteIn: false,
        closed: false,
        entries: [],
      },
    ],
    ...overrides,
  };
}

function renderBlock(value: GroupSignupDto, canSignUp = true) {
  const onChanged = vi.fn().mockResolvedValue(undefined);
  renderWithProviders(
    <SignupBlock
      signup={value}
      groupId="g1"
      postId="p1"
      canSignUp={canSignUp}
      onChanged={onChanged}
    />
  );
  return { onChanged };
}

describe("SignupBlock", () => {
  beforeEach(() => {
    apiMock.mockReset();
    apiMock.mockResolvedValue({});
  });

  it("shows each slot with how full it is and who is bringing what", () => {
    renderBlock(signup());
    expect(screen.getByText("Main dish")).toBeInTheDocument();
    expect(screen.getByText("1 of 4")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Ann Lee" })).toHaveAttribute(
      "href",
      "/people/person-ann"
    );
    expect(screen.getByText(/Lasagna/)).toBeInTheDocument();
  });

  it("asks for the note, and a quantity only when the slot has room for more than one", async () => {
    renderBlock(signup());
    await userEvent.click(screen.getByRole("button", { name: "Sign up for Dessert" }));
    expect(screen.queryByLabelText("How many")).not.toBeInTheDocument();
    const submit = screen.getByRole("button", { name: "Sign up" });
    expect(submit).toBeDisabled();
    await userEvent.type(screen.getByLabelText("What are you bringing?"), "Pie");
    await userEvent.click(submit);
    expect(apiMock).toHaveBeenCalledWith("/groups/g1/posts/p1/signup/entries", {
      method: "POST",
      body: { slotId: "dessert", quantity: 1, note: "Pie" },
    });

    await userEvent.click(screen.getByRole("button", { name: "Sign up for Main dish" }));
    expect(screen.getByLabelText("How many")).toBeInTheDocument();
    expect(screen.getByText("3 spots left")).toBeInTheDocument();
  });

  it("asks for no note when the organizer wants none", async () => {
    renderBlock(signup({ noteMode: "NONE" }));
    await userEvent.click(screen.getByRole("button", { name: "Sign up for Dessert" }));
    expect(screen.queryByLabelText(/bringing/)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Sign up" }));
    expect(apiMock).toHaveBeenCalledWith("/groups/g1/posts/p1/signup/entries", {
      method: "POST",
      body: { slotId: "dessert", quantity: 1, note: null },
    });
  });

  it("lets you change or remove your own entry, and hides Sign up on that slot", async () => {
    const mine = signup();
    mine.slots[0]!.entries[0] = { ...mine.slots[0]!.entries[0]!, isMine: true, canRemove: true };
    renderBlock(mine);
    expect(screen.queryByRole("button", { name: "Sign up for Main dish" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Remove" }));
    expect(apiMock).toHaveBeenCalledWith("/groups/g1/posts/p1/signup/entries/e1", {
      method: "DELETE",
      body: undefined,
    });
  });

  it("offers write-ins with how many are left", async () => {
    renderBlock(
      signup({ noteMode: "NONE", writeInsEnabled: true, writeInMax: 5, writeInCount: 2 })
    );
    await userEvent.click(screen.getByRole("button", { name: /Add your own item/ }));
    await userEvent.type(screen.getByLabelText("What are you bringing?"), "Gold coins");
    await userEvent.clear(screen.getByLabelText("How many"));
    await userEvent.type(screen.getByLabelText("How many"), "12");
    await userEvent.click(screen.getByRole("button", { name: "Add it" }));
    expect(apiMock).toHaveBeenCalledWith("/groups/g1/posts/p1/signup/entries", {
      method: "POST",
      body: { writeIn: "Gold coins", quantity: 12, note: null },
    });
  });

  it("shows the recipient and the important info", () => {
    renderBlock(
      signup({
        recipient: { personId: "person-bo", name: "Bo Park" },
        importantInfo: "No nuts, please",
      })
    );
    expect(screen.getByRole("link", { name: "Bo Park" })).toHaveAttribute(
      "href",
      "/people/person-bo"
    );
    expect(screen.getByText("No nuts, please")).toBeInTheDocument();
  });

  it("offers nothing to sign up for when closed", () => {
    renderBlock(
      signup({ closed: true, slots: signup().slots.map((s) => ({ ...s, closed: true })) })
    );
    expect(screen.getByText("Sign-ups are closed")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Sign up for/ })).not.toBeInTheDocument();
  });
});

describe("SignupComposerModal", () => {
  beforeEach(() => {
    apiMock.mockReset();
    apiMock.mockResolvedValue({});
  });

  it("starts from a template and posts its slots", async () => {
    const onPosted = vi.fn().mockResolvedValue(undefined);
    renderWithProviders(<SignupComposerModal groupId="g1" onClose={vi.fn()} onPosted={onPosted} />);
    await userEvent.click(screen.getByRole("button", { name: /Stockings/ }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByLabelText("Slot 1 name")).toHaveValue("Oranges");
    await userEvent.click(within(dialog).getByRole("button", { name: "Post sign-up" }));
    expect(apiMock).toHaveBeenCalledWith("/groups/g1/posts", {
      method: "POST",
      body: expect.objectContaining({
        kind: "SIGNUP",
        signup: expect.objectContaining({
          title: "St. Nicholas stockings",
          template: "STOCKINGS",
          noteMode: "NONE",
          writeInsEnabled: true,
          writeInMax: 5,
          slots: [
            { date: null, label: "Oranges", capacity: 30 },
            { date: null, label: "Chocolate coins", capacity: 30 },
            { date: null, label: "Candy canes", capacity: 30 },
          ],
        }),
      }),
    });
    expect(onPosted).toHaveBeenCalled();
  });

  it("fills dates from a range for a meal train", async () => {
    renderWithProviders(<SignupComposerModal groupId="g1" onClose={vi.fn()} onPosted={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: /Meal train/ }));
    await userEvent.type(screen.getByLabelText("From"), "2026-12-01");
    await userEvent.type(screen.getByLabelText("Through"), "2026-12-03");
    await userEvent.click(screen.getByRole("button", { name: "Add 3 dates" }));
    expect(screen.getByLabelText("Slot 3 date")).toHaveValue("2026-12-03");
  });
});

describe("signupPayload", () => {
  it("drops blank rows and dates when slots are not dated", () => {
    const payload = signupPayload({
      template: "CUSTOM",
      title: " Setup crew ",
      description: "",
      recipient: null,
      importantInfo: "",
      noteMode: "NONE",
      notePrompt: "ignored",
      writeInsEnabled: false,
      writeInMax: "3",
      closesOn: "",
      publicEnabled: true,
      dated: false,
      slots: [
        { date: "2026-12-01", label: "Tables", capacity: "4" },
        { date: "", label: " ", capacity: "" },
      ],
    });
    expect(payload).toMatchObject({
      title: "Setup crew",
      notePrompt: null,
      writeInMax: null,
      publicEnabled: true,
      slots: [{ date: null, label: "Tables", capacity: 4 }],
    });
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route, Routes, useLocation, useNavigationType } from "react-router";
import type { PublicEventDto } from "@shared";
import { PublicEvent } from "../src/pages/PublicEvent";
import { formatDayLabel } from "../src/lib/format";
import { renderWithProviders } from "./utils";

const auth = vi.hoisted(() => ({ status: "signedOut" as string }));
const apiMock = vi.hoisted(() => vi.fn());

vi.mock("../src/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/api")>()),
  api: (...args: unknown[]) => apiMock(...args),
}));

vi.mock("../src/context/AuthContext", () => ({
  useAuth: () => ({
    status: auth.status,
    email: null,
    error: null,
    busy: false,
    requestCode: vi.fn(),
    submitCode: vi.fn(),
    restart: vi.fn(),
  }),
}));

function isoInDays(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() + days);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

const EVENT_DATE = isoInDays(10);

function eventDto(overrides: Partial<PublicEventDto> = {}): PublicEventDto {
  return {
    title: "Harvest Supper",
    description: "Bring a dish to share.",
    eventDate: EVENT_DATE,
    startTime: "18:00",
    endTime: "20:00",
    location: "Parish Hall, 12 Elm St",
    cancelled: false,
    publicRsvpEnabled: true,
    organizationName: "All Saints",
    groupName: "Hospitality Guild",
    rsvpCounts: { yes: 0, no: 0, maybe: 0, attending: 0 },
    ...overrides,
  };
}

function notFound() {
  return import("../src/lib/api").then(({ ApiError }) => new ApiError(404, "Not found"));
}

function stubApi(routes: Record<string, () => Promise<unknown>>) {
  apiMock.mockImplementation((path: string) => {
    const handler = routes[path];
    return handler ? handler() : Promise.reject(new Error(`unexpected api call ${path}`));
  });
}

function Where() {
  const type = useNavigationType();
  return (
    <p data-testid="where" data-nav-type={type}>
      {useLocation().pathname}
    </p>
  );
}

function renderPage(token = "tok123") {
  return renderWithProviders(
    <>
      <Routes>
        <Route path="/e/:token" element={<PublicEvent />} />
        <Route path="/groups/:id/events/:postId" element={<p>event page stub</p>} />
      </Routes>
      <Where />
    </>,
    { initialEntries: [`/e/${token}`] }
  );
}

async function openChoices() {
  await userEvent.click(
    await screen.findByRole("button", {
      name: "Not a member? Request to join or RSVP without joining.",
    })
  );
}

/** The non-member form; the sign-in form above it also has an "Email address". */
function formEl(): HTMLElement {
  return screen.getByLabelText("First name").closest("form") as HTMLElement;
}

async function fillPerson(first = "Maria", last = "Lopez", email = "  Maria@Example.COM ") {
  const form = within(formEl());
  await userEvent.type(form.getByLabelText("First name"), first);
  await userEvent.type(form.getByLabelText("Last name"), last);
  await userEvent.type(form.getByLabelText("Email address"), email);
}

interface Post {
  path: string;
  options: { method: string; body: Record<string, unknown> };
}

const postCalls = (): Post[] =>
  apiMock.mock.calls
    .filter(([, options]) => options?.method === "POST")
    .map(([path, options]) => ({ path, options }));

beforeEach(() => {
  apiMock.mockReset();
  auth.status = "signedOut";
});

describe("PublicEvent: signed in", () => {
  beforeEach(() => {
    auth.status = "signedIn";
  });

  it("resolves the token and replaces the URL with the event's page", async () => {
    stubApi({
      "/events/by-token/tok123": () => Promise.resolve({ groupId: "g1", postId: "p1" }),
    });
    renderPage();

    await waitFor(() =>
      expect(screen.getByTestId("where")).toHaveTextContent("/groups/g1/events/p1")
    );
    expect(screen.getByTestId("where")).toHaveAttribute("data-nav-type", "REPLACE");
    expect(screen.getByText("event page stub")).toBeInTheDocument();
    expect(apiMock).toHaveBeenCalledTimes(1);
    expect(apiMock).toHaveBeenCalledWith(
      "/events/by-token/tok123",
      expect.objectContaining({ withOrg: false })
    );
    expect(apiMock.mock.calls.some(([path]) => String(path).startsWith("/public/"))).toBe(false);
    expect(screen.queryByText("Harvest Supper")).not.toBeInTheDocument();
  });

  it("says the link is not valid on a 404, without the sign-in gate", async () => {
    stubApi({ "/events/by-token/tok123": async () => Promise.reject(await notFound()) });
    renderPage();

    expect(await screen.findByText("That event link is not valid.")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Sign in to see this event." })).toBeNull();
    expect(screen.getByTestId("where")).toHaveTextContent("/e/tok123");
  });
});

describe("PublicEvent: signed out", () => {
  it("shows the event, a sign-in form, and the non-member choices on request", async () => {
    stubApi({ "/public/events/tok123": () => Promise.resolve(eventDto()) });
    renderPage();

    expect(await screen.findByRole("heading", { name: "Harvest Supper" })).toBeInTheDocument();
    expect(apiMock).toHaveBeenCalledWith(
      "/public/events/tok123",
      expect.objectContaining({ withOrg: false })
    );
    expect(screen.getByText(new RegExp(formatDayLabel(EVENT_DATE)))).toBeInTheDocument();
    const where = screen.getByRole("link", { name: "Parish Hall, 12 Elm St" });
    expect(where).toHaveAttribute(
      "href",
      `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent("Parish Hall, 12 Elm St")}`
    );
    expect(screen.getByText("Hosted by")).toHaveTextContent("Hosted by Hospitality Guild");
    expect(screen.getByText("Bring a dish to share.")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Members: sign in to RSVP" })).toBeInTheDocument();

    const toggle = screen.getByRole("button", {
      name: "Not a member? Request to join or RSVP without joining.",
    });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("button", { name: "RSVP without joining" })).toBeNull();

    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("button", { name: "RSVP without joining" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Request to join" })).toBeInTheDocument();
  });

  it("does not say who hosts it when there is no group name", async () => {
    stubApi({ "/public/events/tok123": () => Promise.resolve(eventDto({ groupName: null })) });
    renderPage();

    await screen.findByRole("heading", { name: "Harvest Supper" });
    expect(screen.queryByText(/Hosted by/)).not.toBeInTheDocument();
  });

  it("says how many are going counting everyone, not just members", async () => {
    stubApi({
      "/public/events/tok123": () =>
        Promise.resolve(eventDto({ rsvpCounts: { yes: 1, no: 0, maybe: 0, attending: 6 } })),
    });
    renderPage();

    expect(await screen.findByText("6 people are going")).toBeInTheDocument();
  });

  it("says nothing about who is going when nobody is", async () => {
    stubApi({ "/public/events/tok123": () => Promise.resolve(eventDto()) });
    renderPage();

    await screen.findByRole("heading", { name: "Harvest Supper" });
    expect(screen.queryByText(/going$/)).not.toBeInTheDocument();
  });

  describe("RSVP without joining", () => {
    beforeEach(() => {
      stubApi({
        "/public/events/tok123": () => Promise.resolve(eventDto()),
        "/public/events/tok123/rsvp": () => Promise.resolve(undefined),
      });
    });

    async function openRsvp() {
      renderPage();
      await openChoices();
      await userEvent.click(screen.getByRole("button", { name: "RSVP without joining" }));
    }

    it("rejects an empty form with field errors and sends nothing", async () => {
      await openRsvp();
      await userEvent.click(screen.getByRole("button", { name: "RSVP" }));

      expect(await screen.findByText("Enter your first name")).toBeInTheDocument();
      expect(screen.getByText("Enter a valid email address")).toBeInTheDocument();
      expect(screen.getByLabelText(/Number of guests/)).toBeInvalid();
      expect(screen.getByLabelText(/Number of guests/)).toHaveAttribute("aria-invalid", "true");
      expect(postCalls()).toHaveLength(0);
    });

    it("sends the trimmed, lowercased address and a guest count of 0", async () => {
      await openRsvp();
      await fillPerson();
      await userEvent.type(screen.getByLabelText(/Number of guests/), "0");
      await userEvent.click(screen.getByRole("button", { name: "RSVP" }));

      const status = await screen.findByRole("status");
      expect(status).toHaveTextContent(/^You are on the list for Harvest Supper\./);
      expect(status).not.toHaveTextContent(", with");
      expect(postCalls()).toHaveLength(1);
      expect(postCalls()[0]?.path).toBe("/public/events/tok123/rsvp");
      expect(postCalls()[0]?.options).toMatchObject({
        method: "POST",
        body: {
          firstName: "Maria",
          lastName: "Lopez",
          email: "maria@example.com",
          guestCount: 0,
        },
      });
    });

    it("confirms the title and the number of guests", async () => {
      await openRsvp();
      await fillPerson();
      await userEvent.type(screen.getByLabelText(/Number of guests/), "2");
      await userEvent.click(screen.getByRole("button", { name: "RSVP" }));

      expect(await screen.findByRole("status")).toHaveTextContent(
        "You are on the list for Harvest Supper, with 2 guests"
      );
      expect(postCalls()[0]?.options.body.guestCount).toBe(2);
    });
  });

  describe("request to join", () => {
    beforeEach(() => {
      stubApi({
        "/public/events/tok123": () => Promise.resolve(eventDto()),
        "/public/events/tok123/join-request": () => Promise.resolve(undefined),
      });
    });

    async function openJoin() {
      renderPage();
      await openChoices();
      await userEvent.click(screen.getByRole("button", { name: "Request to join" }));
    }

    it("rejects a blank field and sends nothing", async () => {
      await openJoin();
      const form = within(formEl());
      await userEvent.type(form.getByLabelText("First name"), "Maria");
      await userEvent.type(form.getByLabelText("Email address"), "maria@example.com");
      await userEvent.click(screen.getAllByRole("button", { name: "Request to join" }).at(-1)!);

      expect(await screen.findByText("Enter your last name")).toBeInTheDocument();
      expect(postCalls()).toHaveLength(0);
    });

    it("sends the request and confirms it", async () => {
      await openJoin();
      await fillPerson();
      await userEvent.click(screen.getAllByRole("button", { name: "Request to join" }).at(-1)!);

      expect(await screen.findByRole("status")).toHaveTextContent(
        "We have passed that on to the parish office. Someone will be in touch."
      );
      expect(postCalls()).toHaveLength(1);
      expect(postCalls()[0]?.path).toBe("/public/events/tok123/join-request");
      expect(postCalls()[0]?.options).toMatchObject({
        method: "POST",
        body: { firstName: "Maria", lastName: "Lopez", email: "maria@example.com" },
      });
    });
  });

  it("offers nothing to do for a cancelled event", async () => {
    stubApi({ "/public/events/tok123": () => Promise.resolve(eventDto({ cancelled: true })) });
    renderPage();

    expect(await screen.findByText("This event has been cancelled.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Not a member/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "RSVP without joining" })).toBeNull();
    expect(screen.queryByLabelText(/Number of guests/)).toBeNull();
  });

  it("shows a bare sign-in gate, naming nothing, when the event is not public", async () => {
    stubApi({ "/public/events/tok123": async () => Promise.reject(await notFound()) });
    renderPage();

    expect(
      await screen.findByRole("heading", { name: "Sign in to see this event." })
    ).toBeInTheDocument();
    const text = document.body.textContent ?? "";
    expect(text).not.toContain("Harvest Supper");
    expect(text).not.toContain("Hospitality Guild");
    expect(text).not.toContain("All Saints");
    for (const label of [
      "Request to join",
      "RSVP without joining",
      "Not a member",
      "Request to be added",
    ]) {
      expect(text).not.toContain(label);
    }
  });
});

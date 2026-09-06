import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useLocation } from "react-router";
import { renderWithProviders } from "./utils";
import type { AuditActorDto, AuditLogEntryDto, AuditLogFilterOptionsDto } from "@shared";
import { AuditLog } from "../src/pages/AuditLog";

const api = vi.fn();
vi.mock("../src/lib/api", () => ({
  api: (...args: unknown[]) => api(...args),
  DEV_AUTH: false,
}));

vi.mock("../src/context/MeContext", () => ({
  useMe: () => ({ organizationId: "org-1", isSuperAdmin: false }),
}));

function entry(overrides: Partial<AuditLogEntryDto> = {}): AuditLogEntryDto {
  return {
    id: "1",
    createdAt: new Date().toISOString(),
    action: "person.update",
    entityType: "person",
    entityId: "person-1",
    actor: { appUserId: "au-1", email: "ada@test.example", name: "Ada Admin" },
    target: { label: "Maria Schlueter", missing: false },
    changes: { firstName: "Maria" },
    unassignedOrganization: false,
    ...overrides,
  };
}

const OPTIONS: AuditLogFilterOptionsDto = {
  actions: ["person.update", "family.create"],
  entityTypes: ["person", "family"],
};

const ACTORS: AuditActorDto[] = [
  { appUserId: "au-1", email: "ada@test.example", name: "Ada Admin" },
  { appUserId: "au-2", email: "boris@test.example", name: "Boris Popov" },
];

interface Options {
  query?: Record<string, string | number | undefined>;
  repeated?: Record<string, string[]>;
}

/** Opens the filter sheet, which is where every control other than the chips lives. */
async function openSheet() {
  await user().click(screen.getByRole("button", { name: /filters/i }));
  return screen.findByRole("dialog");
}

/**
 * Answers the two filter endpoints always, and hands /audit off to the case's
 * own stub.
 *
 * `/audit/actors` serves both modes the picker needs: resolving the ids a URL
 * already carries, and matching a typed term.
 */
function actorsFor(options: Options): { actors: AuditActorDto[] } {
  const ids = options.repeated?.actorId ?? [];
  if (ids.length > 0) {
    return { actors: ACTORS.filter((actor) => ids.includes(actor.appUserId!)) };
  }
  const term = String(options.query?.q ?? "").toLowerCase();
  return {
    actors: term ? ACTORS.filter((actor) => actor.name!.toLowerCase().includes(term)) : ACTORS,
  };
}

function respondWith(log: (options: Options) => unknown) {
  api.mockImplementation((path: string, options: Options = {}) => {
    if (path === "/audit/filters") return Promise.resolve(OPTIONS);
    if (path === "/audit/actors") return Promise.resolve(actorsFor(options));
    if (path === "/audit") return Promise.resolve(log(options));
    throw new Error(`unexpected path ${path}`);
  });
}

function LocationProbe() {
  return <span data-testid="search">{useLocation().search}</span>;
}

function renderPage(initialEntries = ["/audit-log"]) {
  return renderWithProviders(
    <>
      <AuditLog />
      <LocationProbe />
    </>,
    { initialEntries }
  );
}

/** Just the /audit calls, in order -- the filters call is noise for these. */
function auditCalls(): Options[] {
  return (api.mock.calls as [string, Options][])
    .filter((call) => call[0] === "/audit")
    .map((call) => call[1]);
}

function lastAuditCall(): Options {
  const calls = auditCalls();
  const last = calls[calls.length - 1];
  if (!last) throw new Error("nothing called /audit");
  return last;
}

const user = () => userEvent.setup();
const search = () => screen.getByTestId("search").textContent ?? "";

beforeEach(() => {
  api.mockReset();
});

describe("AuditLog", () => {
  it("lists what happened, who did it and when", async () => {
    respondWith(() => ({
      entries: [entry({ id: "1" })],
      nextCursor: null,
    }));

    renderPage();

    expect(await screen.findByText("Maria Schlueter")).toBeInTheDocument();
    expect(screen.getByText("Person edited")).toBeInTheDocument();
    expect(screen.getByText(/Ada Admin/)).toBeInTheDocument();
    expect(screen.getByText("1 entry, newest first")).toBeInTheDocument();
  });

  it("expands an entry to show what was recorded", async () => {
    respondWith(() => ({ entries: [entry()], nextCursor: null }));

    renderPage();
    const row = await screen.findByRole("button", { expanded: false });
    expect(screen.queryByText("Submitted values")).not.toBeInTheDocument();

    await user().click(row);

    expect(screen.getByText("Submitted values")).toBeInTheDocument();
    expect(screen.getByRole("button", { expanded: true })).toBeInTheDocument();
  });

  describe("what an entry says when its people are gone", () => {
    /*
     * `actor_app_user_id` is `on delete set null` and no name is copied onto the
     * row, so this is the ordinary state of an entry after an account is
     * deleted. An empty space would read as a rendering fault.
     */
    it("says the actor was deleted rather than showing a blank", async () => {
      respondWith(() => ({
        entries: [entry({ actor: { appUserId: null, email: null, name: null } })],
        nextCursor: null,
      }));

      renderPage();
      expect(await screen.findByText(/a deleted account/i)).toBeInTheDocument();
    });

    it("falls back to the actor's address when they have no directory record", async () => {
      respondWith(() => ({
        entries: [entry({ actor: { appUserId: "au-9", email: "super@test.example", name: null } })],
        nextCursor: null,
      }));

      renderPage();
      expect(await screen.findByText(/super@test\.example/)).toBeInTheDocument();
    });

    /*
     * `entity_id` is deliberately not a foreign key so the trail outlives what
     * it describes, which makes this ordinary too -- and it still says what kind
     * of thing is missing.
     */
    it("names the kind of record when the target is gone", async () => {
      respondWith(() => ({
        entries: [
          entry({
            action: "family.delete",
            entityType: "family",
            target: { label: null, missing: true },
          }),
        ],
        nextCursor: null,
      }));

      renderPage();
      expect(await screen.findByText(/family, since deleted/i)).toBeInTheDocument();
    });
  });

  describe("filters", () => {
    /*
     * There were Today / 7 days / 30 days presets. They duplicated the scroll on
     * a newest-first page that loads more as you go, so what is left is the case
     * scrolling cannot reach: a window back in the history.
     */
    it("has no date presets", async () => {
      respondWith(() => ({ entries: [entry()], nextCursor: null }));

      renderPage();
      await screen.findByText("Maria Schlueter");

      expect(screen.queryByRole("button", { name: "7 days" })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "30 days" })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "All time" })).not.toBeInTheDocument();
    });

    it("sends a chosen date window as instants, with the last day included", async () => {
      respondWith(() => ({ entries: [entry()], nextCursor: null }));

      renderPage(["/audit-log?from=2026-03-01&to=2026-03-31"]);
      await screen.findByText("Maria Schlueter");

      /*
       * The conversion happens in the browser because `created_at` is a moment
       * and "the 1st" is a question about the reader's timezone. `to` is
       * midnight *after* the last day wanted, which is what makes the 31st
       * count -- the API compares it with `<`.
       */
      const query = lastAuditCall().query!;
      expect(query.from).toBe(new Date(2026, 2, 1).toISOString());
      expect(query.to).toBe(new Date(2026, 3, 1).toISOString());
    });

    it("takes one open-ended end of a window", async () => {
      respondWith(() => ({ entries: [entry()], nextCursor: null }));

      renderPage(["/audit-log?from=2026-03-01"]);
      await screen.findByText("Maria Schlueter");

      const query = lastAuditCall().query!;
      expect(query.from).toBe(new Date(2026, 2, 1).toISOString());
      expect(query.to).toBeUndefined();
    });

    it("writes a typed date into the URL", async () => {
      respondWith(() => ({ entries: [entry()], nextCursor: null }));

      renderPage();
      await screen.findByText("Maria Schlueter");
      await openSheet();

      await user().type(screen.getByLabelText("From"), "2026-03-01");

      await waitFor(() => expect(search()).toContain("from=2026-03-01"));
    });

    it("sends multi-selects as repeated parameters", async () => {
      respondWith(() => ({ entries: [entry()], nextCursor: null }));

      renderPage(["/audit-log?action=person.update&action=family.create"]);
      await screen.findByText("Maria Schlueter");

      expect(auditCalls()[0]!.repeated!.action).toEqual(["person.update", "family.create"]);
    });

    /*
     * The bug the directory page carries a comment about: handing `setParams` a
     * fresh object wipes every sibling filter. There are four of them here.
     */
    it("merges a new filter into the ones already set", async () => {
      respondWith(() => ({ entries: [entry()], nextCursor: null }));

      renderPage(["/audit-log?action=person.update"]);
      await screen.findByText("Maria Schlueter");

      await openSheet();
      await user().click(await screen.findByRole("checkbox", { name: "Family" }));

      await waitFor(() => expect(search()).toContain("entityType=family"));
      expect(search()).toContain("action=person.update");
    });

    it("takes a filter off again when its chip is clicked", async () => {
      respondWith(() => ({ entries: [entry()], nextCursor: null }));

      renderPage(["/audit-log?action=person.update"]);
      await screen.findByText("Maria Schlueter");

      await user().click(
        screen.getByRole("button", { name: /person edited.*remove this filter/i })
      );

      await waitFor(() => expect(search()).not.toContain("action="));
    });

    it("clears every filter at once", async () => {
      respondWith(() => ({ entries: [entry()], nextCursor: null }));

      renderPage(["/audit-log?action=person.update&entityType=person&from=2026-03-01"]);
      await screen.findByText("Maria Schlueter");

      await user().click(screen.getAllByRole("button", { name: /^clear all$/i })[0]!);

      await waitFor(() => expect(search()).toBe(""));
    });

    /*
     * A checkbox per account was replaced by a typeahead: the actor list only
     * grows, and at parish scale a list of checkboxes is a control nobody can
     * use.
     */
    it("picks an actor by typing a name", async () => {
      respondWith(() => ({ entries: [entry()], nextCursor: null }));

      renderPage();
      await screen.findByText("Maria Schlueter");
      await openSheet();

      const box = screen.getByRole("combobox", { name: /people who have made changes/i });
      await user().type(box, "boris");

      await user().click(await screen.findByRole("option", { name: /Boris Popov/ }));

      await waitFor(() => expect(search()).toContain("actorId=au-2"));
    });

    it("does not offer someone already chosen", async () => {
      respondWith(() => ({ entries: [entry()], nextCursor: null }));

      renderPage(["/audit-log?actorId=au-2"]);
      await screen.findByText("Maria Schlueter");
      await openSheet();

      // Focused but not typed into, which is also the "look before you know
      // what you are looking for" case: an empty term lists everybody.
      await user().click(screen.getByRole("combobox", { name: /people who have made changes/i }));

      // Boris is already a chip; Ada is not.
      expect(await screen.findByRole("option", { name: /Ada Admin/ })).toBeInTheDocument();
      expect(screen.queryByRole("option", { name: /Boris Popov/ })).not.toBeInTheDocument();
    });

    /*
     * The picker can only name what was just typed, so a shared or reloaded URL
     * arrives with nothing but a uuid. Without resolving it the chip would read
     * "Selected person".
     */
    it("names an actor the URL already carries", async () => {
      respondWith(() => ({ entries: [entry()], nextCursor: null }));

      renderPage(["/audit-log?actorId=au-1"]);

      expect(
        await screen.findByRole("button", { name: /Ada Admin.*remove this filter/i })
      ).toBeInTheDocument();
    });

    it("keeps several actors at once", async () => {
      respondWith(() => ({ entries: [entry()], nextCursor: null }));

      renderPage(["/audit-log?actorId=au-1"]);
      await screen.findByText("Maria Schlueter");
      await openSheet();

      const box = screen.getByRole("combobox", { name: /people who have made changes/i });
      await user().type(box, "boris");
      await user().click(await screen.findByRole("option", { name: /Boris Popov/ }));

      await waitFor(() => {
        const params = new URLSearchParams(search());
        expect(params.getAll("actorId").sort()).toEqual(["au-1", "au-2"]);
      });
    });

    it("says a filter is what emptied the list, and offers the way out", async () => {
      respondWith(() => ({ entries: [], nextCursor: null }));

      renderPage(["/audit-log?action=family.create"]);

      expect(await screen.findByText(/nothing matches these filters/i)).toBeInTheDocument();
      expect(screen.queryByText(/nothing recorded yet/i)).not.toBeInTheDocument();
    });

    it("says nothing is recorded when nothing is, and no filter is set", async () => {
      respondWith(() => ({ entries: [], nextCursor: null }));

      renderPage();

      expect(await screen.findByText(/nothing recorded yet/i)).toBeInTheDocument();
    });
  });

  describe("paging", () => {
    it("follows the cursor and appends the next page", async () => {
      respondWith((options) =>
        options.query?.cursorId
          ? {
              entries: [entry({ id: "2", target: { label: "Boris Popov", missing: false } })],
              nextCursor: null,
            }
          : {
              entries: [entry({ id: "1" })],
              nextCursor: { createdAt: "2024-01-01T00:00:00.000Z", id: "1" },
            }
      );

      renderPage();
      await screen.findByText("Maria Schlueter");

      await user().click(screen.getByRole("button", { name: /show more/i }));

      expect(await screen.findByText("Boris Popov")).toBeInTheDocument();
      expect(screen.getByText("Maria Schlueter")).toBeInTheDocument();

      const query = lastAuditCall().query!;
      expect(query.cursorCreatedAt).toBe("2024-01-01T00:00:00.000Z");
      expect(query.cursorId).toBe("1");
    });

    /*
     * Every filter is in the query key, so this is what that buys: a page of the
     * old filter cannot be appended to the new list, and no cursor is carried
     * across from the wrong set. Without it this needed a request counter.
     */
    it("does not let a page of the old filter land on the new list", async () => {
      let settleStale: ((value: unknown) => void) | undefined;
      api.mockImplementation((path: string, options: Options = {}) => {
        if (path === "/audit/filters") return Promise.resolve(OPTIONS);
        if (path === "/audit/actors") return Promise.resolve(actorsFor(options));
        if (path !== "/audit") throw new Error(`unexpected path ${path}`);

        // "Show more" is held open until after the filter change is answered.
        if (options.query?.cursorId) {
          return new Promise((resolve) => {
            settleStale = resolve;
          });
        }
        const filtered = (options.repeated?.entityType ?? []).length > 0;
        return Promise.resolve({
          entries: [
            filtered
              ? entry({ id: "9", target: { label: "Popov family", missing: false } })
              : entry({ id: "1" }),
          ],
          nextCursor: filtered ? null : { createdAt: "2024-01-01T00:00:00.000Z", id: "1" },
        });
      });

      renderPage();
      await screen.findByText("Maria Schlueter");

      await user().click(screen.getByRole("button", { name: /show more/i }));
      await openSheet();
      await user().click(await screen.findByRole("checkbox", { name: "Family" }));
      expect(await screen.findByText("Popov family")).toBeInTheDocument();

      await act(async () => {
        settleStale?.({
          entries: [entry({ id: "77", target: { label: "Stale row", missing: false } })],
          nextCursor: null,
        });
      });

      expect(screen.queryByText("Stale row")).not.toBeInTheDocument();
      expect(screen.getByText("Popov family")).toBeInTheDocument();
    });

    /*
     * jsdom has no IntersectionObserver and neither do some browsers, which is
     * why the button is not merely a fallback -- it is the only way to page by
     * keyboard, and the only one a screen reader will find.
     */
    it("still pages with no IntersectionObserver at all", async () => {
      expect(globalThis.IntersectionObserver).toBeUndefined();

      respondWith((options) =>
        options.query?.cursorId
          ? {
              entries: [entry({ id: "2", target: { label: "Boris Popov", missing: false } })],
              nextCursor: null,
            }
          : {
              entries: [entry({ id: "1" })],
              nextCursor: { createdAt: "2024-01-01T00:00:00.000Z", id: "1" },
            }
      );

      renderPage();
      await screen.findByText("Maria Schlueter");
      await user().click(screen.getByRole("button", { name: /show more/i }));

      expect(await screen.findByText("Boris Popov")).toBeInTheDocument();
    });

    describe("with an observer available", () => {
      let trigger: (() => void) | undefined;

      beforeEach(() => {
        class StubObserver {
          constructor(private readonly callback: IntersectionObserverCallback) {
            trigger = () =>
              this.callback(
                [{ isIntersecting: true } as IntersectionObserverEntry],
                this as unknown as IntersectionObserver
              );
          }
          observe() {}
          disconnect() {
            trigger = undefined;
          }
          unobserve() {}
          takeRecords() {
            return [];
          }
        }
        vi.stubGlobal("IntersectionObserver", StubObserver);
      });

      afterEach(() => {
        trigger = undefined;
        vi.unstubAllGlobals();
      });

      it("loads the next page when the sentinel comes into range", async () => {
        respondWith((options) =>
          options.query?.cursorId
            ? {
                entries: [entry({ id: "2", target: { label: "Boris Popov", missing: false } })],
                nextCursor: null,
              }
            : {
                entries: [entry({ id: "1" })],
                nextCursor: { createdAt: "2024-01-01T00:00:00.000Z", id: "1" },
              }
        );

        renderPage();
        await screen.findByText("Maria Schlueter");

        await act(async () => {
          trigger?.();
        });

        expect(await screen.findByText("Boris Popov")).toBeInTheDocument();
      });

      it("stops observing once there is nothing left to load", async () => {
        respondWith(() => ({ entries: [entry()], nextCursor: null }));

        renderPage();
        await screen.findByText("Maria Schlueter");

        // Disconnected, so a sentinel left sitting in view cannot fire a
        // request per frame.
        expect(trigger).toBeUndefined();
      });
    });
  });

  it("offers a retry when the log cannot be read", async () => {
    api.mockImplementation((path: string, options: Options = {}) => {
      if (path === "/audit/filters") return Promise.resolve(OPTIONS);
      if (path === "/audit/actors") return Promise.resolve(actorsFor(options));
      return Promise.reject(new Error("Not allowed"));
    });

    renderPage();

    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText("Not allowed")).toBeInTheDocument();
    expect(within(alert).getByRole("button", { name: /try again/i })).toBeInTheDocument();
  });
});

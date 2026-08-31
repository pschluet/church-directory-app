import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { PersonSummaryDto } from "@shared";
import { Directory } from "../src/pages/Directory";
import { renderWithProviders, testQueryClient } from "./utils";

/**
 * What the cache is for, and the one way it can be got wrong.
 *
 * These are deliberately about two mounts rather than one: everything a single
 * mount does is already covered in Directory.test.tsx, and neither of the
 * things below is visible until you leave a page and come back to it.
 */

const api = vi.fn();
vi.mock("../src/lib/api", () => ({
  api: (...args: unknown[]) => api(...args),
  DEV_AUTH: false,
}));

// A super admin switching parish is the only way this changes, and it is what
// every org-scoped query key is namespaced by.
const meState = { organizationId: "org-1" };
vi.mock("../src/context/MeContext", () => ({
  useMe: () => ({ organizationId: meState.organizationId }),
}));

function person(id: string, firstName: string, lastName: string): PersonSummaryDto {
  return {
    id,
    organizationId: meState.organizationId,
    familyId: null,
    familyName: null,
    appUserId: null,
    firstName,
    lastName,
    email: null,
    phone: null,
    altPhone: null,
    addressLine1: null,
    addressLine2: null,
    city: null,
    state: null,
    postalCode: null,
    country: null,
    patronSaint: null,
    photoUrl: null,
    thumbUrl: null,
    fullUrl: null,
    canEdit: false,
  };
}

const ANNA = person("anna-id", "Anna", "Ivanova");
const BORIS = person("boris-id", "Boris", "Petrov");
const OTHER_PARISH = person("nadia-id", "Nadia", "Costa");

const calls = (path: string) => api.mock.calls.filter(([called]) => called === path);

describe("the directory cache", () => {
  beforeEach(() => {
    api.mockReset();
    meState.organizationId = "org-1";
  });

  it("keeps the pages it has already loaded when the page is left and come back to", async () => {
    // Two pages of one, so "Show more" has somewhere to go.
    api.mockImplementation((path: string, options?: { query?: { cursorId?: string } }) => {
      if (path !== "/directory") throw new Error(`unexpected path ${path}`);
      if (options?.query?.cursorId) {
        return Promise.resolve({ people: [BORIS], nextCursor: null });
      }
      return Promise.resolve({
        people: [ANNA],
        nextCursor: { lastName: "Ivanova", firstName: "Anna", id: "anna-id" },
      });
    });

    // The window the app itself runs with, since that is what decides whether
    // coming back reuses the answer or revalidates behind it.
    const queryClient = testQueryClient({ staleTime: 30_000 });
    const first = renderWithProviders(<Directory />, { queryClient });
    await screen.findByText("Anna Ivanova");

    await userEvent.click(screen.getByRole("button", { name: /show more/i }));
    expect(await screen.findByText("Boris Petrov")).toBeInTheDocument();
    expect(calls("/directory")).toHaveLength(2);

    // Opening a person and pressing back is this, as far as the query is
    // concerned: the page unmounts and mounts again on the same cache.
    first.unmount();
    renderWithProviders(<Directory />, { queryClient });

    // Both pages are there at once rather than after a spinner, and the second
    // one was never asked for again.
    expect(screen.getByText("Anna Ivanova")).toBeInTheDocument();
    expect(screen.getByText("Boris Petrov")).toBeInTheDocument();
    expect(screen.getByText("2 people, by last name")).toBeInTheDocument();
    expect(calls("/directory")).toHaveLength(2);
  });

  it("never shows one parish's directory to another", async () => {
    api.mockImplementation((path: string, options?: { query?: Record<string, unknown> }) => {
      if (path !== "/directory") throw new Error(`unexpected path ${path}`);
      // The org is not in the arguments at all -- api() reads it from
      // localStorage -- which is exactly why the key has to carry it.
      void options;
      const people = meState.organizationId === "org-1" ? [ANNA] : [OTHER_PARISH];
      return Promise.resolve({ people, nextCursor: null });
    });

    const queryClient = testQueryClient({ staleTime: 30_000 });
    const first = renderWithProviders(<Directory />, { queryClient });
    await screen.findByText("Anna Ivanova");

    first.unmount();
    meState.organizationId = "org-2";
    const second = renderWithProviders(<Directory />, { queryClient });

    await waitFor(() => expect(screen.getByText("Nadia Costa")).toBeInTheDocument());
    expect(screen.queryByText("Anna Ivanova")).not.toBeInTheDocument();
    expect(calls("/directory")).toHaveLength(2);

    // And the first parish's entry is still its own, not overwritten by the
    // second parish's answer arriving under a shared key.
    second.unmount();
    meState.organizationId = "org-1";
    renderWithProviders(<Directory />, { queryClient });

    expect(screen.getByText("Anna Ivanova")).toBeInTheDocument();
    expect(screen.queryByText("Nadia Costa")).not.toBeInTheDocument();
    // Still two: coming back to org-1 was served straight from the cache.
    expect(calls("/directory")).toHaveLength(2);
  });
});

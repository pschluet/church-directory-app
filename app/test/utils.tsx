import { vi } from "vitest";
import type { ReactNode } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

/**
 * A client with the retries and the window-focus refetch turned off.
 *
 * The default backoff would leave every `waitFor` racing a second attempt, and
 * `gcTime: Infinity` keeps an unmounted page's answers around, which is the
 * whole point of the cases that mount something twice.
 */
export function testQueryClient(queries: Record<string, unknown> = {}): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Infinity, refetchOnWindowFocus: false, ...queries },
      mutations: { retry: false },
    },
  });
}

/**
 * Everything a page needs to render outside the app.
 *
 * A fresh client unless one is handed in, because a shared one would carry one
 * case's answers into the next. Pass `queryClient` when the case is *about*
 * what survives between two mounts.
 */
export function renderWithProviders(
  ui: ReactNode,
  {
    initialEntries = ["/"],
    queryClient = testQueryClient(),
  }: { initialEntries?: string[]; queryClient?: QueryClient } = {}
) {
  return {
    queryClient,
    ...render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={initialEntries}>{ui}</MemoryRouter>
      </QueryClientProvider>
    ),
  };
}

/** Opens a `Select` and returns its list. */
export async function openOptions(trigger: HTMLElement): Promise<HTMLElement> {
  await userEvent.click(trigger);
  return screen.getByRole("listbox");
}

/**
 * Picks an option from a `Select` by its value -- what `userEvent.selectOptions`
 * did for the native `<select>` it replaced.
 */
export async function chooseOption(trigger: HTMLElement, value: string): Promise<void> {
  const list = await openOptions(trigger);
  const option = list.querySelector<HTMLElement>(`[role="option"][data-value="${value}"]`);
  if (!option) throw new Error(`No option with the value "${value}"`);
  await userEvent.click(option);
}

/**
 * Stands in for the browser's save-a-file, so a test can see what was offered.
 *
 * jsdom has neither object URLs nor a download to speak of, so `URL` is
 * stubbed and the anchor's `click` is intercepted. Callers must undo it
 * (`vi.unstubAllGlobals()` and `vi.restoreAllMocks()`) in `afterEach`.
 */
export function stubDownload() {
  const create = vi.fn().mockReturnValue("blob:download");
  const revoke = vi.fn();
  vi.stubGlobal("URL", { createObjectURL: create, revokeObjectURL: revoke });
  let clicked: HTMLAnchorElement | null = null;
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
    this: HTMLAnchorElement
  ) {
    clicked = this;
  });
  return { create, revoke, clicked: () => clicked };
}

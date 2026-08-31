import { QueryClient } from "@tanstack/react-query";
import { ApiError } from "./api";

/**
 * The cache the whole SPA shares.
 *
 * Held in memory only. A localStorage persister would make a revisit paint
 * instantly, but it would also leave the parish's phone numbers and addresses
 * on the disk of whatever phone was last signed in, which is not a trade worth
 * making for a page load.
 */
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        // Nothing was cached at all before this, so any window is an
        // improvement. Thirty seconds is long enough that going into a person
        // and back is instant, and short enough that an edit made on another
        // page shows up without anyone thinking about it.
        staleTime: 30_000,
        // This is a phone in a pocket; refetching every time it comes back to
        // the foreground is churn nobody asked for. Writes invalidate what
        // they touched instead.
        refetchOnWindowFocus: false,
        // A 401, 403 or 404 will not become a 200 by asking again -- retrying
        // those just delays the message.
        retry: (count, error) => !(error instanceof ApiError && error.status < 500) && count < 2,
      },
    },
  });
}

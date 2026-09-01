/**
 * Every cache key in the app, in one place.
 *
 * `api()` reads the active organization out of localStorage itself and appends
 * `?orgId=` -- it is a hidden input to every request that no caller passes. A
 * key that leaves it out would happily serve one parish's directory to another,
 * so every org-scoped key is namespaced by it here, by construction. `/me` and
 * `/organizations` are not: one is the source of the organization and the other
 * is fetched with `withOrg: false`.
 *
 * The nesting is deliberate as well. Keys are matched by prefix, so
 * invalidating `families(orgId)` sweeps the list, every family detail and every
 * candidates list in one call.
 */
export const qk = {
  me: () => ["me"] as const,
  organizations: () => ["organizations"] as const,

  org: (orgId: string | null) => ["org", orgId] as const,

  directoryRoot: (orgId: string | null) => [...qk.org(orgId), "directory"] as const,
  directory: (orgId: string | null, accountHoldersOnly: boolean) =>
    [...qk.directoryRoot(orgId), "browse", { accountHoldersOnly }] as const,
  directorySearch: (orgId: string | null, q: string, accountHoldersOnly: boolean) =>
    [...qk.directoryRoot(orgId), "search", { q, accountHoldersOnly }] as const,
  directoryLookup: (
    orgId: string | null,
    q: string,
    exclude?: string,
    accounts?: "only" | "none"
  ) =>
    [
      ...qk.directoryRoot(orgId),
      "lookup",
      { q, exclude: exclude ?? null, accounts: accounts ?? null },
    ] as const,

  families: (orgId: string | null) => [...qk.org(orgId), "families"] as const,
  family: (orgId: string | null, id: string) => [...qk.families(orgId), id] as const,
  familyCandidates: (orgId: string | null, id: string) =>
    [...qk.family(orgId, id), "candidates"] as const,
  pendingJoinRequests: (orgId: string | null) =>
    [...qk.families(orgId), "join-requests", "pending"] as const,

  persons: (orgId: string | null) => [...qk.org(orgId), "persons"] as const,
  person: (orgId: string | null, id: string) => [...qk.persons(orgId), id] as const,
  pendingMerges: (orgId: string | null) => [...qk.persons(orgId), "merges", "pending"] as const,

  adminUsers: (orgId: string | null) => [...qk.org(orgId), "admin", "users"] as const,

  specialDates: (orgId: string | null) => [...qk.org(orgId), "special-dates"] as const,
  upcomingDates: (orgId: string | null, start: string, days: number) =>
    [...qk.specialDates(orgId), "upcoming", { start, days }] as const,
  calendar: (orgId: string | null, year: number, month: number) =>
    [...qk.specialDates(orgId), "calendar", { year, month }] as const,
};

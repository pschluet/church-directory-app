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

  /**
   * Not org-namespaced, and deliberately so: a notification belongs to an
   * account. The only caller who can act outside their own parish is a super
   * admin, whose notifications still come from their home one, so keying these
   * by the active organization would empty their bell every time they looked at
   * somebody else's parish.
   *
   * Siblings rather than nested, so refreshing the bell does not also refetch
   * the settings page's switches.
   */
  notifications: () => ["notifications"] as const,
  notificationPreferences: () => ["notification-preferences"] as const,

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
  /**
   * The family page's year ahead. Nested under the family rather than under
   * `specialDates` so that adding a member -- which changes whose dates these
   * are -- invalidates it along with everything else about the family.
   */
  familyUpcomingDates: (orgId: string | null, id: string, start: string) =>
    [...qk.family(orgId, id), "upcoming", { start }] as const,
  pendingJoinRequests: (orgId: string | null) =>
    [...qk.families(orgId), "join-requests", "pending"] as const,

  persons: (orgId: string | null) => [...qk.org(orgId), "persons"] as const,
  person: (orgId: string | null, id: string) => [...qk.persons(orgId), id] as const,
  pendingMerges: (orgId: string | null) => [...qk.persons(orgId), "merges", "pending"] as const,

  adminUsers: (orgId: string | null) => [...qk.org(orgId), "admin", "users"] as const,

  /**
   * The audit log. Nested so that the page's entries and the filter options it
   * offers are both swept by one prefix, and org-namespaced like everything
   * else here -- a super admin switching parish is looking at a different log,
   * not a stale copy of the last one.
   *
   * `filters` is in the entries key rather than beside it, which is what makes
   * changing a filter a new cache entry instead of a race that appends rows
   * from the old filter onto the new list.
   */
  auditLog: (orgId: string | null) => [...qk.org(orgId), "audit-log"] as const,
  auditLogEntries: (orgId: string | null, filters: unknown) =>
    [...qk.auditLog(orgId), "entries", filters] as const,
  auditLogFilterOptions: (orgId: string | null) =>
    [...qk.auditLog(orgId), "filter-options"] as const,
  /** The actor typeahead, keyed on the debounced term like the directory's. */
  auditActorLookup: (orgId: string | null, term: string) =>
    [...qk.auditLog(orgId), "actors", "lookup", { term }] as const,
  /**
   * The names behind the actor ids a URL already carries. Sorted, so arriving
   * at the same pair of people from either direction is one cache entry.
   */
  auditActorsByIds: (orgId: string | null, ids: string[]) =>
    [...qk.auditLog(orgId), "actors", "by-id", { ids: [...ids].sort() }] as const,

  prayerRequests: (orgId: string | null) => [...qk.org(orgId), "prayer-requests"] as const,
  /**
   * Nested under the feed, so approving something can invalidate both the page
   * and the review queue with one prefix match.
   */
  pendingPrayerRequests: (orgId: string | null) =>
    [...qk.prayerRequests(orgId), "pending"] as const,

  specialDates: (orgId: string | null) => [...qk.org(orgId), "special-dates"] as const,
  upcomingDates: (orgId: string | null, start: string, days: number) =>
    [...qk.specialDates(orgId), "upcoming", { start, days }] as const,
  calendar: (orgId: string | null, year: number, month: number) =>
    [...qk.specialDates(orgId), "calendar", { year, month }] as const,
};

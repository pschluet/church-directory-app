import { createContext, useCallback, useContext, useEffect, useMemo } from "react";
import type { ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { MeDto } from "@shared";
import { api, ApiError, getActiveOrganizationId, setActiveOrganizationId } from "../lib/api";
import { qk } from "../lib/queryKeys";

/**
 * Who the signed-in person is, as far as the directory is concerned.
 *
 * Role and organization come from the API rather than from the token, because
 * they live in Postgres -- a Cognito group cannot express "which organization
 * is this admin scoped to". Everything in the UI that depends on permissions
 * reads from here.
 *
 * The cache holds the answer; this context stays because `organizationId` is
 * the scope every other query is keyed by, and because the shape below is what
 * the rest of the app already speaks.
 */

interface MeContextValue {
  me: MeDto | null;
  loading: boolean;
  error: string | null;
  reload: () => Promise<void>;
  isAdmin: boolean;
  isSuperAdmin: boolean;
  /** The organization the UI is currently showing. */
  organizationId: string | null;
  /** Super admins only; a no-op for everyone else. */
  switchOrganization: (organizationId: string) => Promise<void>;
}

const MeContext = createContext<MeContextValue | null>(null);

async function fetchMe(signal: AbortSignal): Promise<MeDto> {
  try {
    return await api<MeDto>("/me", { signal });
  } catch (err) {
    /*
     * The organization a super admin was last viewing is remembered in
     * localStorage and sent on every request. If that church is later deleted
     * -- or the id simply belongs to another environment's database -- the API
     * rightly refuses it, and the stored value then breaks every page with no
     * way for the user to clear it. Drop it and try once more.
     */
    if (err instanceof ApiError && err.status === 404 && getActiveOrganizationId()) {
      setActiveOrganizationId(null);
      try {
        return await api<MeDto>("/me", { signal });
      } catch {
        // Fall through: the original refusal is the more useful message.
      }
    }
    throw err;
  }
}

export function MeProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: qk.me(),
    queryFn: ({ signal }) => fetchMe(signal),
    // Who you are and what you may do changes far less often than the
    // directory does.
    staleTime: 60_000,
  });

  const me = query.data ?? null;

  // Through the client rather than `query.refetch`, which is rebuilt on every
  // render and would make this -- and the context value around it -- unstable.
  const reload = useCallback(async () => {
    await queryClient.refetchQueries({ queryKey: qk.me() });
  }, [queryClient]);

  /*
   * A super admin has no organization of their own, so on first sign-in there
   * is nothing to show until they pick one. Selecting the first available
   * organization is friendlier than an empty directory with no explanation.
   */
  useEffect(() => {
    if (!me?.appUser) return;
    const stored = getActiveOrganizationId();
    if (me.organization) {
      if (stored !== me.organization.id) setActiveOrganizationId(me.organization.id);
      return;
    }
    const first = me.availableOrganizations[0];
    if (!stored && first) {
      setActiveOrganizationId(first.id);
      void queryClient.invalidateQueries({ queryKey: qk.me() });
    }
  }, [me, queryClient]);

  const switchOrganization = useCallback(
    async (organizationId: string) => {
      /*
       * Load-bearing, and the reason this is not a bare setter. `api()` reads
       * the organization out of localStorage at the moment it builds the
       * request, so anything already in flight would come back holding the new
       * parish's rows and be written under the old parish's key.
       */
      await queryClient.cancelQueries();
      setActiveOrganizationId(organizationId);
      await queryClient.refetchQueries({ queryKey: qk.me() });
    },
    [queryClient]
  );

  const value = useMemo<MeContextValue>(
    () => ({
      me,
      loading: query.isPending,
      error: query.error ? (query.error.message ?? "Could not load your account") : null,
      reload,
      isAdmin: me?.appUser.role === "ADMIN" || me?.appUser.role === "SUPER_ADMIN",
      isSuperAdmin: me?.appUser.role === "SUPER_ADMIN",
      organizationId: me?.organization?.id ?? null,
      switchOrganization,
    }),
    [me, query.isPending, query.error, reload, switchOrganization]
  );

  return <MeContext.Provider value={value}>{children}</MeContext.Provider>;
}

export function useMe(): MeContextValue {
  const ctx = useContext(MeContext);
  if (!ctx) throw new Error("useMe must be used within a MeProvider");
  return ctx;
}

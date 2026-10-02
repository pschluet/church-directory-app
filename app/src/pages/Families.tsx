import { useMemo, useState, type ReactNode } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { FamilySummaryDto } from "@shared";
import { familyWriteSchema, searchTerms } from "@shared";
import { api } from "../lib/api";
import { highlightRanges, matchesTerm } from "../lib/highlight";
import { qk } from "../lib/queryKeys";
import { useMe } from "../context/MeContext";
import { Highlight } from "../components/Highlight";
import { Link } from "../components/nav";
import { SearchField } from "../components/SearchField";
import {
  Badge,
  Button,
  ConfirmDialog,
  EmptyState,
  ErrorNotice,
  Field,
  Modal,
  PageHeading,
  Spinner,
  inputClass,
} from "../components/ui";

/**
 * Every family in the parish, so one can be created or joined without first
 * finding a member and going through their record.
 *
 * Joining is a request an existing member approves -- except for admins, whose
 * request the API approves on the spot, which is why their button says "Join"
 * rather than "Ask to join".
 */
export function Families() {
  const { me, isAdmin, organizationId, reload: reloadMe } = useMe();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [params, setParams] = useSearchParams();
  const query = params.get("q") ?? "";
  const [creating, setCreating] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmMove, setConfirmMove] = useState<FamilySummaryDto | null>(null);
  // Kept apart from the query's own error: a request that fails must not
  // replace the list with a notice.
  const [actionError, setActionError] = useState<string | null>(null);

  // The organization is in the key, so a super admin switching parish is
  // looking at a different set of families without anything having to say so.
  const familiesQuery = useQuery({
    queryKey: qk.families(organizationId),
    queryFn: ({ signal }) => api<{ families: FamilySummaryDto[] }>("/families", { signal }),
  });

  const families = familiesQuery.data?.families ?? [];
  const loading = familiesQuery.isPending;
  const error = actionError ?? familiesQuery.error?.message ?? null;

  /*
   * Searched on the client: the whole list is already here, so there is no
   * request to debounce and the box can write straight to the URL. It is in
   * the URL at all so that coming Back from a family page finds the search
   * still in place. `replace`, as on the Directory, so Back is not an undo of
   * single letters.
   *
   * Split by the same `searchTerms` the Directory uses, and every term has to
   * be in the name -- the same AND the directory search applies.
   */
  function setQuery(next: string): void {
    setParams(
      (prev) => {
        const updated = new URLSearchParams(prev);
        if (next.trim() === "") updated.delete("q");
        else updated.set("q", next);
        return updated;
      },
      { replace: true }
    );
  }
  const terms = useMemo(() => searchTerms(query).map((term) => term.toLowerCase()), [query]);
  const searching = terms.length > 0;
  const shown = useMemo(
    () =>
      searching
        ? families.filter((family) => terms.every((term) => matchesTerm(family.name, term)))
        : families,
    [families, terms, searching]
  );

  const myPersonId = me?.appUser.personId ?? null;
  const myFamilyId = me?.person?.familyId ?? null;
  const myFamilyName = families.find((f) => f.id === myFamilyId)?.name ?? null;
  // A list, not one: the pending index is unique per (family, person), so
  // somebody with no family can have asked several at once.
  const outstanding = families.filter((f) => f.pendingJoinRequestId !== null);

  async function requestToJoin(family: FamilySummaryDto): Promise<void> {
    setBusyId(family.id);
    setActionError(null);
    try {
      await api(`/families/${family.id}/join-requests`, { method: "POST" });
      setConfirmMove(null);
      await queryClient.invalidateQueries({ queryKey: qk.families(organizationId) });
      // An admin's request is approved immediately, so their own family changed.
      await reloadMe();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Could not send that request");
    } finally {
      setBusyId(null);
    }
  }

  function rowAction(family: FamilySummaryDto) {
    if (!myPersonId) return null;
    if (family.id === myFamilyId) return <Badge tone="accent">Your family</Badge>;
    // Accent, matching a prayer request that is waiting for review. `primary`
    // is what that page uses for the request it turned down, and this is not
    // that. "Requested" was a past-tense fact; this says who it is on.
    if (family.pendingJoinRequestId) return <Badge tone="accent">Waiting for approval</Badge>;

    // Leaving a family behind is worth a warning; joining from nowhere is not.
    const needsWarning = myFamilyId !== null;
    return (
      <Button
        variant="secondary"
        disabled={busyId === family.id}
        onClick={() => (needsWarning ? setConfirmMove(family) : void requestToJoin(family))}
      >
        {isAdmin ? "Join" : "Ask to join"}
      </Button>
    );
  }

  return (
    <>
      <PageHeading
        title="Families"
        subtitle={
          loading
            ? undefined
            : searching
              ? `${shown.length} of ${families.length} ${families.length === 1 ? "family" : "families"}`
              : `${families.length} ${families.length === 1 ? "family" : "families"}`
        }
        actions={
          <div className="flex w-full flex-col gap-3 md:w-auto md:flex-row md:items-center">
            <SearchField
              value={query}
              onChange={setQuery}
              label="Search families"
              placeholder="Search by family name…"
            />
            {/* Creating means joining unless you are an admin, and joining
                needs a directory record. */}
            {(isAdmin || myPersonId) && (
              <Button onClick={() => setCreating(true)}>Create a family</Button>
            )}
          </div>
        }
      />

      {/* The count above is a plain <p> nothing re-reads; this announces it. */}
      <p role="status" className="sr-only">
        {searching && !loading
          ? shown.length === 0
            ? `No family matches ${query.trim()}`
            : `${shown.length} ${shown.length === 1 ? "family matches" : "families match"} ${query.trim()}`
          : ""}
      </p>

      {error && <ErrorNotice message={error} onRetry={() => void familiesQuery.refetch()} />}

      {!myPersonId && (
        <ErrorNotice message="Your directory record is missing, so you cannot join a family. Ask a parish administrator to look into it." />
      )}

      {/*
        The row badge says a request is waiting; this says what it is waiting
        on, once, rather than in every row -- and it is the acknowledgement the
        flow never had, since asking otherwise just swaps a button for a badge
        in the same few pixels. Both sentences are written out rather than
        assembled from fragments so the punctuation cannot come apart.
      */}
      {outstanding.length > 0 && (
        <p className="mb-6 rounded-lg border border-line bg-surface-muted p-4 text-ink-muted">
          {outstanding.length === 1
            ? `You have asked to join the ${outstanding[0]!.name} family. Someone already in it — or a parish administrator — has to approve that before you are added.`
            : `You have asked to join ${outstanding.length} families — ${outstanding.map((f) => f.name).join(", ")}. Someone already in each — or a parish administrator — has to approve that before you are added.`}
        </p>
      )}

      {loading ? (
        <Spinner label="Loading families" />
      ) : families.length === 0 ? (
        <EmptyState title="No families yet">
          Create the first one and everyone else can ask to join it.
        </EmptyState>
      ) : shown.length === 0 ? (
        <EmptyState title={`Nothing matches “${query.trim()}”`}>
          <p>Check the spelling, or try a shorter fragment of the family name.</p>
          <p className="mt-3">
            <Button variant="ghost" onClick={() => setQuery("")}>
              Show all families
            </Button>
          </p>
        </EmptyState>
      ) : (
        /*
          A multi-column flow, not a grid: a family with no photo makes a
          shorter card, and a grid would still size every row to its tallest
          cell, stretching the short ones to match and wasting the space a
          photo-less card gave back. Columns lay each card out at its own
          height and let the next one start right where it ended, so several
          short cards pack into the vertical span one tall neighbor takes.
          `break-inside-avoid` on the `<li>` stops a card being split across
          two columns; `gap` only sets the width *between* columns here, so
          the space *within* one is the `<li>`'s own margin, not the parent's.
        */
        <ul className="columns-1 gap-4 sm:columns-2 lg:columns-3">
          {shown.map((family) => (
            <li key={family.id} className="mb-4 break-inside-avoid">
              <FamilyCard family={family} terms={terms} action={rowAction(family)} />
            </li>
          ))}
        </ul>
      )}

      {confirmMove && (
        <ConfirmDialog
          title="Ask to join this family?"
          confirmLabel={isAdmin ? "Join" : "Send request"}
          busy={busyId === confirmMove.id}
          onConfirm={() => void requestToJoin(confirmMove)}
          onClose={() => setConfirmMove(null)}
        >
          You are in the {myFamilyName ?? "current"} family. If this is approved you will move to{" "}
          {confirmMove.name}, and any details you share with your current family will be cleared.
        </ConfirmDialog>
      )}

      {creating && (
        <CreateFamilyModal
          isAdmin={isAdmin}
          myPersonId={myPersonId}
          myFamilyName={myFamilyName}
          existingNames={families.map((f) => f.name)}
          onClose={() => setCreating(false)}
          onCreated={async (created, joined) => {
            setCreating(false);
            if (joined) {
              await reloadMe();
              // Opted in like every Link, so this arrival slides in and, more to
              // the point, so the chevron can slide back out of it.
              void navigate(`/families/${created.id}`, { viewTransition: true });
            } else {
              // Stay put so several can be set up in a row.
              await queryClient.invalidateQueries({ queryKey: qk.families(organizationId) });
            }
          }}
        />
      )}
    </>
  );
}

/**
 * One family in the grid: its photo across the top where there is one, then
 * the name -- with the join action beside it -- and everyone in it.
 *
 * The photo, the name and the member names all open the family page. Only the
 * name is a tab stop: three links to one place per card would triple every
 * keyboard user's journey. The member names stay readable to a screen reader;
 * the photo, which says nothing the name does not, is hidden from one.
 *
 * A family with no photo gets no banner at all, not a placeholder -- the
 * column layout in the parent is what makes that cheap: a shorter card packs
 * against the next one instead of leaving a gap the height of its tallest
 * neighbor.
 */
function FamilyCard({
  family,
  terms,
  action,
}: {
  family: FamilySummaryDto;
  terms: readonly string[];
  action: ReactNode;
}) {
  // Which URL failed rather than whether one did, as in FamilyPhoto: a
  // replacement photo changes the prop without remounting.
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  // The card rendition is framed for this exact box; a family photographed
  // before it existed falls back to the free-form thumbnail, which is cropped
  // for the detail page and simply gets centre-cropped here same as today.
  const preferred = family.cardUrl ?? family.thumbUrl;
  const photo = preferred && failedUrl !== preferred ? preferred : null;
  const to = `/families/${family.id}`;

  return (
    <article className="group flex flex-col overflow-hidden rounded-card-photo border border-line bg-surface shadow-sm transition hover:border-accent hover:shadow-md">
      {photo && (
        <Link
          to={to}
          tabIndex={-1}
          aria-hidden="true"
          className="block aspect-card-photo overflow-hidden border-b border-line bg-surface-muted"
        >
          <img
            src={photo}
            alt={`The ${family.name} family`}
            loading="lazy"
            decoding="async"
            onError={() => setFailedUrl(photo)}
            className="h-full w-full object-cover transition duration-300 group-hover:scale-[1.03]"
          />
        </Link>
      )}

      {/* The names share the title's column rather than sitting under the
          whole row, so a Join button -- a full tap target, taller than the
          title -- cannot push them away from the name they belong to. */}
      <div className="flex flex-1 items-start justify-between gap-3 p-4">
        {/* `min-w-0` lets a long name wrap instead of pushing the action out
            of the card; `break-words` handles one with no spaces. */}
        <div className="min-w-0 flex-1">
          <h3 className="break-words text-lg font-bold leading-snug text-ink">
            <Link to={to} className="transition hover:text-accent">
              <Highlight text={family.name} ranges={highlightRanges(family.name, terms)} />
            </Link>
          </h3>
          <Link
            to={to}
            tabIndex={-1}
            className="block break-words text-sm text-ink-muted transition hover:text-ink"
          >
            {family.memberNames.length > 0 ? (
              family.memberNames.join(", ")
            ) : (
              <span className="italic">No members yet</span>
            )}
          </Link>
        </div>
        {action && <div className="shrink-0">{action}</div>}
      </div>
    </article>
  );
}

function CreateFamilyModal({
  isAdmin,
  myPersonId,
  myFamilyName,
  existingNames,
  onClose,
  onCreated,
}: {
  isAdmin: boolean;
  myPersonId: string | null;
  myFamilyName: string | null;
  existingNames: string[];
  onClose: () => void;
  onCreated: (created: { id: string; name: string }, joined: boolean) => Promise<void>;
}) {
  // An admin setting a family up for someone else is the common case, and
  // defaulting this on would quietly move them out of their own family.
  const canChoose = isAdmin && myPersonId !== null;
  const [name, setName] = useState("");
  const [join, setJoin] = useState(!isAdmin);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Only an admin may opt out of joining, and an admin with no directory record
  // of their own has nothing to join with.
  const joining = canChoose ? join : !isAdmin;
  const duplicate = existingNames.some((n) => n.toLowerCase() === name.trim().toLowerCase());

  async function submit(): Promise<void> {
    const parsed = familyWriteSchema.safeParse({ name });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "That name is not valid");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const created = await api<{ id: string; name: string }>("/families", {
        method: "POST",
        body: { name: parsed.data.name, join: joining },
      });
      await onCreated(created, joining);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create that family");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="Create a family" onClose={onClose}>
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <Field
          label="Family name"
          hint={duplicate ? `There is already a family called ${name.trim()}.` : undefined}
        >
          <input
            className={inputClass}
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={150}
            autoFocus
          />
        </Field>

        {canChoose && (
          <label className="flex items-start gap-2 text-sm text-ink-muted">
            <input
              type="checkbox"
              checked={join}
              onChange={(event) => setJoin(event.target.checked)}
              className="mt-1"
            />
            <span>
              Put me in this family
              {myFamilyName && ` — this moves you out of the ${myFamilyName} family`}
            </span>
          </label>
        )}

        {joining && myFamilyName && (
          <p className="text-sm font-bold text-primary">
            You are in the {myFamilyName} family. Creating this one moves you out of it, and any
            details you share with them will be cleared.
          </p>
        )}

        {error && (
          <p role="alert" className="font-bold text-primary">
            {error}
          </p>
        )}

        <div className="flex flex-col gap-2 sm:flex-row">
          <Button type="submit" disabled={busy || name.trim() === ""}>
            {busy ? "Creating…" : "Create"}
          </Button>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
        </div>
      </form>
    </Modal>
  );
}

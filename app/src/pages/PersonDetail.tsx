import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  FamilyDto,
  FamilySummaryDto,
  MergeRequestDto,
  PersonDto,
  PersonMergeResultDto,
  SpecialDateDto,
} from "@shared";
import { api } from "../lib/api";
import { qk } from "../lib/queryKeys";
import { useMe } from "../context/MeContext";
import { Avatar } from "../components/Avatar";
import { PersonForm } from "../components/PersonForm";
import { PhoneLink } from "../components/PhoneLink";
import { AddressLink } from "../components/AddressLink";
import { usePhotoPicker } from "../components/usePhotoPicker";
import { SpecialDateForm } from "../components/SpecialDateForm";
import { PersonPicker, type PickedPerson } from "../components/PersonPicker";
import {
  Badge,
  Button,
  ConfirmDialog,
  ErrorNotice,
  InfoPopover,
  MenuButton,
  MenuItem,
  Modal,
  Spinner,
} from "../components/ui";
import {
  formatMonthDay,
  formatMultilineAddress,
  fullName,
  showYearCountLabel,
  specialDateDetail,
  specialDateLabel,
  specialDatePartner,
} from "../lib/format";

/**
 * One person's full record, and the place their details and dates are edited.
 *
 * Stacked on a phone; photo beside details from `md` up.
 */
export function PersonDetail() {
  const { id } = useParams<{ id: string }>();
  const { me, isAdmin, organizationId, reload: reloadMe } = useMe();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [editing, setEditing] = useState(false);
  const [addingDate, setAddingDate] = useState(false);
  const [editingDateId, setEditingDateId] = useState<string | null>(null);
  const [merging, setMerging] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [removingDate, setRemovingDate] = useState<SpecialDateDto | null>(null);
  const [busy, setBusy] = useState(false);
  // Kept apart from the query's own error: a failed action must not replace the
  // record with a notice.
  const [actionError, setActionError] = useState<string | null>(null);

  const personQuery = useQuery({
    queryKey: qk.person(organizationId, id ?? ""),
    queryFn: ({ signal }) => api<PersonDto>(`/persons/${id}`, { signal }),
    enabled: Boolean(id),
  });
  const person = personQuery.data ?? null;

  /*
   * Both of these used to hang off the person fetch inside a Promise.all, each
   * with a `.catch(() => fallback)` so that a refusal did not take the page
   * down with it. As their own queries they keep that: `enabled` decides
   * whether to ask at all, and their errors are simply not read.
   *
   * The family is needed for the inheritance pickers. The anniversary partner
   * is not fetched here any more -- SpecialDateForm's picker searches the
   * directory as you type.
   */
  const familyQuery = useQuery({
    queryKey: qk.family(organizationId, person?.familyId ?? ""),
    queryFn: ({ signal }) => api<FamilyDto>(`/families/${person?.familyId}`, { signal }),
    enabled: Boolean(person?.familyId),
  });
  const family = familyQuery.data ?? null;

  // Only an admin may move someone between families, so only they need a list
  // to choose from.
  const familiesQuery = useQuery({
    queryKey: qk.families(organizationId),
    queryFn: ({ signal }) => api<{ families: FamilySummaryDto[] }>("/families", { signal }),
    enabled: isAdmin,
  });
  const families = familiesQuery.data?.families ?? [];

  /*
   * Merge requests the caller is party to. Wider than "waiting on me" on
   * purpose: the same list also decides whether to offer a merge at all, since
   * only one can be pending per person.
   */
  const mergesQuery = useQuery({
    queryKey: qk.pendingMerges(organizationId),
    queryFn: ({ signal }) =>
      api<{ mergeRequests: MergeRequestDto[] }>("/merges/pending", { signal }),
  });
  const merges = mergesQuery.data?.mergeRequests ?? [];

  const reload = async () => {
    await queryClient.invalidateQueries({ queryKey: qk.person(organizationId, id ?? "") });
  };

  // A date belongs to the person, but it is also what Special Dates counts.
  const reloadDates = async () => {
    await Promise.all([
      reload(),
      queryClient.invalidateQueries({ queryKey: qk.specialDates(organizationId) }),
    ]);
  };

  /*
   * `PATCH /persons/:id` and `PUT /persons/:id/photo` both hand back the whole
   * record, so it goes straight into the cache -- refetching what the server
   * has already said would be a round trip for nothing. The directory still
   * has to be told, because a rename or a new photo shows on the cards there.
   */
  const applyPerson = (updated: PersonDto): void => {
    queryClient.setQueryData(qk.person(organizationId, updated.id), updated);
    void queryClient.invalidateQueries({ queryKey: qk.directoryRoot(organizationId) });
  };

  /*
   * A merge reaches almost everything: the two records, the families they
   * belong to, the cards in the directory and the dates that moved. `reloadMe`
   * on top of that, because an approved merge can change the caller's own
   * family -- either because it was their record that moved, or because someone
   * joined theirs.
   *
   * `result` is present only when the merge actually happened -- an admin needs
   * no approval, so their request goes through in the same call. When it does,
   * the record this page is showing may be the one that was just retired, and
   * invalidating without moving first would refetch it and render "Person not
   * found" over a merge that in fact succeeded. So follow the survivor, and drop
   * the dead record from the cache rather than leaving it to 404.
   */
  const reloadAfterMerge = async (result?: PersonMergeResultDto | null): Promise<void> => {
    if (result && result.mergedPersonId === id) {
      void navigate(`/people/${result.personId}`, { replace: true });
      queryClient.removeQueries({ queryKey: qk.person(organizationId, result.mergedPersonId) });
    }
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: qk.persons(organizationId) }),
      queryClient.invalidateQueries({ queryKey: qk.families(organizationId) }),
      queryClient.invalidateQueries({ queryKey: qk.directoryRoot(organizationId) }),
      queryClient.invalidateQueries({ queryKey: qk.specialDates(organizationId) }),
    ]);
    await reloadMe();
  };

  const decideMerge = async (
    mergeRequest: MergeRequestDto,
    decision: "approve" | "deny"
  ): Promise<void> => {
    setBusy(true);
    setActionError(null);
    try {
      const decided = await api<{ result?: PersonMergeResultDto }>(
        `/merges/${mergeRequest.id}/${decision}`,
        { method: "POST" }
      );
      await reloadAfterMerge(decided.result ?? null);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Could not decide that merge");
    } finally {
      setBusy(false);
    }
  };

  /*
   * Keyed off the route param rather than `person.id`, because a hook has to be
   * called on every render -- including the ones that return the spinner or the
   * notice just below.
   *
   * The picker is headless: it owns the hidden file input and the cropper, and
   * the visible way in is the menu beside the name.
   */
  const savePhotoKey = async (photoKey: string | null): Promise<void> => {
    applyPerson(
      await api<PersonDto>(`/persons/${id}/photo`, { method: "PUT", body: { photoKey } })
    );
  };
  const photoPicker = usePhotoPicker({
    owner: { personId: id ?? "" },
    onUploaded: ({ photoKey }) => savePhotoKey(photoKey),
  });

  if (personQuery.isPending) return <Spinner label="Loading" />;
  if (personQuery.error) {
    return (
      <ErrorNotice message={personQuery.error.message} onRetry={() => void personQuery.refetch()} />
    );
  }
  if (!person) return null;

  const name = fullName(person);
  const address = formatMultilineAddress(person);
  const editingDate = person.specialDates.find((date) => date.id === editingDateId);

  const isOwnRecord = person.id === me?.appUser.personId;
  const hasAccount = person.appUserId !== null;
  // Only one merge can be pending per person, so an existing one replaces the
  // offer to start another.
  const pendingMerge =
    merges.find((m) => m.accountPersonId === person.id || m.duplicatePersonId === person.id) ??
    null;

  /*
   * Two ways in, and which one you get depends on whose record you are looking
   * at rather than on a choice in the form:
   *
   *   your own      -> "this account-less person is also me"
   *   a relative's  -> "this account holder is really this relative"
   *
   * `canEdit` is the server's own rule (canEditPerson), so the button appears
   * exactly where the request would be allowed.
   */
  const canMergeOwn = isOwnRecord && hasAccount;
  const canMergeRelative = !isOwnRecord && !hasAccount && person.canEdit;
  const mergeOffer = pendingMerge
    ? null
    : canMergeOwn
      ? ("own" as const)
      : canMergeRelative
        ? ("relative" as const)
        : null;

  const removeDate = async (date: SpecialDateDto): Promise<void> => {
    setBusy(true);
    setActionError(null);
    try {
      await api(`/special-dates/${date.id}`, { method: "DELETE" });
      setRemovingDate(null);
      await reloadDates();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Could not remove that date");
    } finally {
      setBusy(false);
    }
  };

  const deletePerson = async (): Promise<void> => {
    setBusy(true);
    setActionError(null);
    try {
      await api(`/persons/${person.id}`, { method: "DELETE" });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: qk.persons(organizationId) }),
        queryClient.invalidateQueries({ queryKey: qk.families(organizationId) }),
        queryClient.invalidateQueries({ queryKey: qk.directoryRoot(organizationId) }),
        queryClient.invalidateQueries({ queryKey: qk.specialDates(organizationId) }),
      ]);
      // Staying here would leave the page fetching a person the API now 404s.
      void navigate(person.familyId ? `/families/${person.familyId}` : "/", { replace: true });
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Could not delete that person");
      setBusy(false);
    }
  };

  return (
    <>
      {actionError && (
        <p role="alert" className="mb-4 font-bold text-primary">
          {actionError}
        </p>
      )}

      {pendingMerge?.canDecide && (
        <section className="mb-6 rounded-lg border border-accent/40 bg-accent/5 p-4">
          <h2 className="mb-2 font-bold text-ink">Waiting on you</h2>
          <p className="mb-3 text-ink-muted">
            {pendingMerge.requestedByPersonName} asked to merge{" "}
            <strong>{pendingMerge.duplicatePersonName}</strong>
            {pendingMerge.duplicateFamilyName
              ? ` of the ${pendingMerge.duplicateFamilyName} family`
              : ""}{" "}
            into the record for <strong>{pendingMerge.accountPersonName}</strong>. The account
            holder's details are kept, and anything only the other record has is added to them.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button disabled={busy} onClick={() => void decideMerge(pendingMerge, "approve")}>
              Approve
            </Button>
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() => void decideMerge(pendingMerge, "deny")}
            >
              Decline
            </Button>
          </div>
        </section>
      )}

      {pendingMerge && !pendingMerge.canDecide && (
        <p className="mb-6 rounded-lg border border-line bg-surface-muted p-4 text-ink-muted">
          A merge with <strong>{pendingMerge.duplicatePersonName}</strong> is waiting to be
          approved.
        </p>
      )}
      <div className="mb-6 flex flex-col gap-5 md:flex-row md:items-start md:gap-8">
        {/* Fixed-width sidebar from md up, so the photo never crowds the
            details beside it. Nothing but the photo lives here any more -- its
            controls are in the menu by the name. */}
        <div className="flex shrink-0 flex-col items-center gap-3 md:w-44">
          <Avatar thumbUrl={person.thumbUrl} fullUrl={person.fullUrl} person={person} size="lg" />
          {/* The file input and the cropper, with no control of their own. */}
          {person.canEdit && photoPicker.elements}
          {photoPicker.error && (
            <p role="alert" className="text-center text-sm font-bold text-primary">
              {photoPicker.error}
            </p>
          )}
        </div>

        <div className="min-w-0 flex-1">
          {/* Two children rather than one wrapping row: the menu has to stay on
              the name's line, and a long name with a badge after it has to be
              free to wrap underneath without taking the menu down with it. */}
          <div className="flex items-start justify-between gap-3">
            <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
              <h1 className="text-2xl font-bold text-ink md:text-3xl">{name}</h1>
              {person.appUserId === null && <Badge>No account</Badge>}
            </div>
            {/* Everything that acts on the record, in one place: a row of
                buttons here competed with the details it edits, and the photo
                controls sat a column away from the rest. */}
            {person.canEdit && (
              <MenuButton label={`Actions for ${name}`} className="shrink-0">
                <MenuItem onSelect={photoPicker.open}>
                  {person.thumbUrl ? "Change photo" : "Add a photo"}
                </MenuItem>
                {person.thumbUrl && (
                  <MenuItem danger onSelect={() => void savePhotoKey(null)}>
                    Remove photo
                  </MenuItem>
                )}
                <MenuItem onSelect={() => setEditing(true)}>Edit details</MenuItem>
                {mergeOffer && (
                  <MenuItem onSelect={() => setMerging(true)}>
                    {mergeOffer === "own"
                      ? "Merge a duplicate into my record"
                      : "Merge into an account holder"}
                  </MenuItem>
                )}
                {!hasAccount && (
                  <MenuItem danger onSelect={() => setConfirmDelete(true)}>
                    Delete this person
                  </MenuItem>
                )}
              </MenuButton>
            )}
          </div>

          {person.familyId && (
            <p className="mt-1 text-ink-muted">
              <Link to={`/families/${person.familyId}`} className="text-primary hover:text-accent">
                {person.familyName} family
              </Link>
            </p>
          )}

          <dl className="mt-4 grid gap-x-8 gap-y-3 md:grid-cols-2">
            <DetailRow label="Phone" inheritedFrom={person.inheritedFrom.phone?.name}>
              {person.phone ? <PhoneLink phone={person.phone} label={name} /> : <NotSet />}
            </DetailRow>

            <DetailRow label="Alternate phone" inheritedFrom={person.inheritedFrom.altPhone?.name}>
              {person.altPhone ? <PhoneLink phone={person.altPhone} label={name} /> : <NotSet />}
            </DetailRow>

            <DetailRow label="Email" inheritedFrom={person.inheritedFrom.email?.name}>
              {person.email ? (
                <a
                  href={`mailto:${person.email}`}
                  className="break-all text-primary hover:text-accent"
                >
                  {person.email}
                </a>
              ) : (
                <NotSet />
              )}
            </DetailRow>

            <DetailRow label="Patron saint">
              {person.patronSaint ? <span>{person.patronSaint}</span> : <NotSet />}
            </DetailRow>

            <DetailRow
              label="Address"
              inheritedFrom={person.inheritedFrom.address?.name}
              className="md:col-span-2"
            >
              {address.length > 0 ? <AddressLink person={person} /> : <NotSet />}
            </DetailRow>
          </dl>
        </div>
      </div>

      <section className="rounded-lg border border-line bg-surface p-4 md:p-6">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-xl font-bold text-ink">Special dates</h2>
          {person.canEdit && (
            <Button variant="secondary" onClick={() => setAddingDate(true)}>
              Add a date
            </Button>
          )}
        </div>

        {person.specialDates.length === 0 ? (
          <p className="text-ink-muted">No dates recorded yet.</p>
        ) : (
          <ul className="divide-y divide-line">
            {person.specialDates.map((date) => {
              const detail = specialDateDetail(date);
              const isTheirs = date.personId === person.id;
              const partner = specialDatePartner(date, person.id);
              return (
                // Same split as the heading: the type and the menu are the row
                // on a phone, and everything else about the date wraps below.
                <li key={date.id} className="flex items-start gap-3 py-2">
                  <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1">
                    <span className="font-bold text-ink">{specialDateLabel(date.type)}</span>
                    <span className="inline-flex items-center gap-1.5">
                      {formatMonthDay(date.month, date.day, date.year)}
                      {/* A year we can see while `showYearCount` is off means the
                          API judged us allowed to -- the person themselves, an
                          admin, or the other half of an anniversary. Everyone
                          else received `year: null`, so no "is this my page"
                          check is needed here. */}
                      {date.year != null && !date.showYearCount && (
                        <InfoPopover
                          label={`Why can I see the year of this ${specialDateLabel(date.type).toLowerCase()}?`}
                          title="Not shown to others"
                        >
                          “{showYearCountLabel(date.type)}” is off for this date, so other members
                          see only the day and month.
                        </InfoPopover>
                      )}
                    </span>
                    {detail && <span className="text-sm font-bold text-accent">{detail}</span>}
                    {partner && (
                      <span className="text-sm text-ink-muted">
                        with{" "}
                        <Link
                          to={`/people/${partner.id}`}
                          className="text-primary transition hover:text-accent"
                        >
                          {partner.name}
                        </Link>
                      </span>
                    )}
                  </div>
                  {person.canEdit && isTheirs && (
                    // The date is in the label because nothing stops someone
                    // holding two of the same type, and "Actions for
                    // anniversary" twice over tells a screen reader nothing.
                    <MenuButton
                      label={`Actions for ${specialDateLabel(date.type).toLowerCase()} on ${formatMonthDay(date.month, date.day)}`}
                      className="shrink-0"
                    >
                      <MenuItem onSelect={() => setEditingDateId(date.id)}>Edit date</MenuItem>
                      <MenuItem danger onSelect={() => setRemovingDate(date)}>
                        Remove date
                      </MenuItem>
                    </MenuButton>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {merging && mergeOffer && (
        <MergeModal
          person={person}
          mode={mergeOffer}
          onClose={() => setMerging(false)}
          mergesImmediately={isAdmin}
          onRequested={async (result) => {
            setMerging(false);
            await reloadAfterMerge(result);
          }}
        />
      )}

      {removingDate && (
        <ConfirmDialog
          title={`Remove this ${specialDateLabel(removingDate.type).toLowerCase()}?`}
          confirmLabel="Remove"
          busy={busy}
          onConfirm={() => void removeDate(removingDate)}
          onClose={() => setRemovingDate(null)}
        >
          {formatMonthDay(removingDate.month, removingDate.day, removingDate.year)} will no longer
          appear on {person.firstName}'s record or in Special Dates.
        </ConfirmDialog>
      )}

      {confirmDelete && (
        <ConfirmDialog
          title={`Delete ${name}?`}
          confirmLabel="Delete"
          busy={busy}
          onConfirm={() => void deletePerson()}
          onClose={() => setConfirmDelete(false)}
        >
          {name} will be removed from the directory, along with any special dates recorded for them.
          Anyone in the family who takes a detail from them — a surname, an address — will go back
          to their own. This cannot be undone from here.
        </ConfirmDialog>
      )}

      {editing && (
        <Modal title={`Edit ${name}`} onClose={() => setEditing(false)}>
          <PersonForm
            person={person}
            familyMembers={family?.members ?? []}
            families={isAdmin ? families : undefined}
            onCancel={() => setEditing(false)}
            onSaved={(updated) => {
              applyPerson(updated);
              setEditing(false);
              // A move changes which relatives the inheritance pickers offer,
              // and which family lists them.
              if (updated.familyId !== person.familyId) {
                void reload();
                void queryClient.invalidateQueries({ queryKey: qk.families(organizationId) });
              }
            }}
          />
        </Modal>
      )}

      {(addingDate || editingDate) && (
        <Modal
          title={editingDate ? "Edit date" : `Add a date for ${person.firstName}`}
          onClose={() => {
            setAddingDate(false);
            setEditingDateId(null);
          }}
        >
          <SpecialDateForm
            personId={person.id}
            existing={editingDate}
            onCancel={() => {
              setAddingDate(false);
              setEditingDateId(null);
            }}
            onSaved={async () => {
              setAddingDate(false);
              setEditingDateId(null);
              await reloadDates();
            }}
          />
        </Modal>
      )}
    </>
  );
}

/**
 * Picks the other half of a merge and sends the request.
 *
 * `mode` is which side of the merge the person on screen is, which is what
 * decides both halves of the payload and which way the picker has to be
 * filtered -- the surviving record can only be an account holder, and the
 * duplicate can only be someone without one.
 */
function MergeModal({
  person,
  mode,
  mergesImmediately,
  onClose,
  onRequested,
}: {
  person: PersonDto;
  mode: "own" | "relative";
  /** An admin needs no approval, so their request takes effect on submit. */
  mergesImmediately: boolean;
  onClose: () => void;
  onRequested: (result: PersonMergeResultDto | null) => Promise<void>;
}) {
  const [other, setOther] = useState<PickedPerson | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isOwn = mode === "own";
  const name = fullName(person);
  const accountName = isOwn ? name : (other?.name ?? "");
  const duplicateName = isOwn ? (other?.name ?? "") : name;

  async function submit(): Promise<void> {
    if (!other) {
      setError("Choose the other record first");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      // `result` comes back only when the merge already happened, which is what
      // tells the page whether the record it is showing still exists.
      const created = await api<{ result?: PersonMergeResultDto }>("/merges", {
        method: "POST",
        body: {
          accountPersonId: isOwn ? person.id : other.id,
          duplicatePersonId: isOwn ? other.id : person.id,
        },
      });
      await onRequested(created.result ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not ask for that merge");
      setBusy(false);
      setConfirming(false);
    }
  }

  if (confirming && other) {
    return (
      <ConfirmDialog
        title="Merge these two records?"
        confirmLabel={mergesImmediately ? "Merge now" : "Send request"}
        busy={busy}
        onConfirm={() => void submit()}
        onClose={() => setConfirming(false)}
      >
        <strong>{duplicateName}</strong> will be folded into the record for{" "}
        <strong>{accountName}</strong> and removed from the directory.{" "}
        {accountName ? `${accountName}'s` : "The account holder's"} own details are kept; anything
        only the other record has is added to them, and they move into that record's family.{" "}
        {mergesImmediately
          ? "As an administrator this takes effect straight away, with nobody to ask."
          : isOwn
            ? "If that record is in your own family this takes effect straight away, since it is already yours to change; otherwise it waits for someone in that family to approve."
            : "It takes effect once that person approves."}{" "}
        This cannot be undone.
      </ConfirmDialog>
    );
  }

  return (
    <Modal
      title={isOwn ? "Merge a duplicate into my record" : "Merge into an account holder"}
      onClose={onClose}
    >
      <div className="space-y-4">
        <PersonPicker
          label={isOwn ? "The duplicate record" : "The account holder"}
          hint={
            isOwn
              ? "Someone in the directory with no account of their own who is really you."
              : `Whose account ${name} should be merged into.`
          }
          value={other}
          onChange={setOther}
          excludePersonId={person.id}
          accounts={isOwn ? "none" : "only"}
        />

        {error && (
          <p role="alert" className="font-bold text-primary">
            {error}
          </p>
        )}

        <div className="flex flex-col gap-2 sm:flex-row">
          <Button disabled={busy || !other} onClick={() => setConfirming(true)}>
            Continue
          </Button>
          <Button variant="ghost" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function DetailRow({
  label,
  inheritedFrom,
  className = "",
  children,
}: {
  label: string;
  inheritedFrom?: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={className}>
      <dt className="text-sm font-bold uppercase tracking-wide text-ink-muted">{label}</dt>
      <dd className="mt-0.5">
        {children}
        {inheritedFrom && (
          <span className="mt-0.5 block text-xs text-ink-muted">Shared with {inheritedFrom}</span>
        )}
      </dd>
    </div>
  );
}

function NotSet() {
  return <span className="text-ink-muted">—</span>;
}

import { useState } from "react";
import { useParams } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { FamilyDto, FamilyMemberDto, PersonDto, UpcomingDatesDto } from "@shared";
import { api } from "../lib/api";
import { qk } from "../lib/queryKeys";
import { todayIso } from "../lib/format";
import { useMe } from "../context/MeContext";
import { FamilyMemberList } from "../components/FamilyMemberList";
import { usePhotoPicker } from "../components/PhotoUpload";
import { FamilyPhoto } from "../components/FamilyPhoto";
import { SpecialDateList } from "../components/SpecialDateList";
import {
  Button,
  ConfirmDialog,
  EmptyState,
  ErrorNotice,
  Field,
  MenuButton,
  MenuItem,
  Modal,
  PageHeading,
  Spinner,
  inputClass,
} from "../components/ui";

/**
 * How far ahead the family's dates run: "starting from today and going to 1
 * year from now".
 *
 * 365 rather than 366 so every annual date lands exactly once. A 366-day window
 * starting today ends on today's month and day next year, which would list
 * every date falling on it twice.
 */
const YEAR_AHEAD_DAYS = 365;

/**
 * A family: its members, its photo, its year of special dates, and the requests
 * waiting to join it.
 *
 * Any member with an account can add family members who have none -- "a family
 * might have children that don't have an account in the app" -- approve requests
 * from others, and arrange the household into whatever order makes sense to
 * them.
 *
 * Every management action lives behind a menu rather than a row of buttons. The
 * page is read far more often than it is edited, and on a phone the buttons cost
 * more room than the members they act on.
 */
export function FamilyDetail() {
  const { id } = useParams<{ id: string }>();
  const { me, organizationId, reload: reloadMe } = useMe();
  const queryClient = useQueryClient();
  const [addingMember, setAddingMember] = useState(false);
  const [newFirstName, setNewFirstName] = useState("");
  const [newLastName, setNewLastName] = useState("");
  const [busy, setBusy] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState("");
  const [removing, setRemoving] = useState<FamilyMemberDto | null>(null);
  const [addingExisting, setAddingExisting] = useState(false);
  /*
   * Only ever set by a mutation. The read's own failure is `familyQuery.error`,
   * and keeping the two apart is what lets the page below stay on screen when a
   * write goes wrong -- see the branch under this.
   */
  const [actionError, setActionError] = useState<string | null>(null);
  /*
   * A drag is applied here first and sent afterwards. Without it the members
   * would snap back to the server's order for as long as the round trip takes,
   * which on a phone reads as the drag having failed.
   */
  const [pendingOrder, setPendingOrder] = useState<string[] | null>(null);

  const myPersonId = me?.appUser.personId ?? null;
  // Fixed for the life of the render so the age the API computes and the window
  // the dates run over cannot straddle midnight.
  const [today] = useState(todayIso);

  const familyQuery = useQuery({
    queryKey: qk.family(organizationId, id ?? ""),
    queryFn: ({ signal }) => api<FamilyDto>(`/families/${id}`, { query: { today }, signal }),
    enabled: Boolean(id),
  });

  const datesQuery = useQuery({
    queryKey: qk.familyUpcomingDates(organizationId, id ?? "", today),
    queryFn: ({ signal }) =>
      api<UpcomingDatesDto>("/special-dates/upcoming", {
        query: { start: today, days: YEAR_AHEAD_DAYS, familyId: id! },
        signal,
      }),
    enabled: Boolean(id),
  });

  const family = familyQuery.data ?? null;
  const error = actionError ?? familyQuery.error?.message ?? null;

  async function attachPhoto(photoKey: string | null, width?: number, height?: number) {
    // The crop is free-form here, so its dimensions go with the key: they are
    // what lets the photo's box be reserved before it loads.
    await api(`/families/${id}/photo`, {
      method: "PUT",
      body: photoKey ? { photoKey, photoWidth: width, photoHeight: height } : { photoKey: null },
    });
    await reload();
  }

  // Keyed off the route param, not `family.id`: this has to be called on every
  // render, including the one that returns the spinner below.
  const photoPicker = usePhotoPicker({
    owner: { familyId: id ?? "" },
    onUploaded: ({ photoKey, width, height }) => attachPhoto(photoKey, width, height),
  });

  // Members, the family list that counts them, and the join requests admins
  // see all hang off the same prefix.
  const reload = async () => {
    await queryClient.invalidateQueries({ queryKey: qk.families(organizationId) });
  };

  // Deliberately not an early return on `error`: a failed mutation must not
  // replace the whole page with a notice and lose the family being worked on.
  if (familyQuery.isPending) return <Spinner label="Loading family" />;
  if (!family) {
    return error ? (
      <ErrorNotice message={error} onRetry={() => void familyQuery.refetch()} />
    ) : null;
  }

  async function addMember(): Promise<void> {
    setBusy(true);
    try {
      await api<PersonDto>("/persons", {
        method: "POST",
        body: { firstName: newFirstName, lastName: newLastName || null, familyId: family!.id },
      });
      setAddingMember(false);
      setNewFirstName("");
      setNewLastName("");
      await reload();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Could not add that person");
    } finally {
      setBusy(false);
    }
  }

  async function decide(requestId: string, decision: "approve" | "deny"): Promise<void> {
    await api(`/families/join-requests/${requestId}/${decision}`, { method: "POST" });
    await reload();
    // Approving someone may have been us, which changes our own family.
    await reloadMe();
  }

  async function removeMember(member: FamilyMemberDto): Promise<void> {
    setBusy(true);
    setActionError(null);
    try {
      await api(`/families/${family!.id}/members/${member.id}`, { method: "DELETE" });
      setRemoving(null);
      await reload();
      // Leaving changes what the caller may edit, here and everywhere else.
      if (member.id === myPersonId) await reloadMe();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Could not remove them");
    } finally {
      setBusy(false);
    }
  }

  async function reorder(personIds: string[]): Promise<void> {
    setPendingOrder(personIds);
    setActionError(null);
    try {
      await api(`/families/${family!.id}/member-order`, { method: "PUT", body: { personIds } });
      await reload();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Could not save that order");
    } finally {
      // Either the reload has brought the saved order back or the order never
      // took; either way the server's answer is the one to show now.
      setPendingOrder(null);
    }
  }

  async function requestToJoin(): Promise<void> {
    setBusy(true);
    try {
      await api(`/families/${family!.id}/join-requests`, { method: "POST" });
      await reload();
      await reloadMe();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Could not send that request");
    } finally {
      setBusy(false);
    }
  }

  // A drag in flight wins over the cached order behind it.
  const members = pendingOrder
    ? pendingOrder
        .map((personId) => family.members.find((m) => m.id === personId))
        .filter((m): m is FamilyMemberDto => Boolean(m))
    : family.members;

  return (
    <>
      <PageHeading
        title={family.name}
        subtitle={`${family.members.length} ${family.members.length === 1 ? "member" : "members"}`}
        // The only action here is a three-dots menu, which does not deserve a
        // row of its own on a phone.
        compactActions={family.canEdit}
        actions={
          <>
            {family.canEdit && (
              <MenuButton label="Family actions">
                <MenuItem onSelect={photoPicker.open}>
                  {family.thumbUrl ? "Change photo" : "Add a photo"}
                </MenuItem>
                {family.thumbUrl && (
                  <MenuItem danger onSelect={() => void attachPhoto(null)}>
                    Remove photo
                  </MenuItem>
                )}
                <MenuItem onSelect={() => setAddingMember(true)}>Create a new person</MenuItem>
                <MenuItem onSelect={() => setAddingExisting(true)}>Add an existing person</MenuItem>
                <MenuItem
                  onSelect={() => {
                    setName(family.name);
                    setRenaming(true);
                  }}
                >
                  Rename family
                </MenuItem>
              </MenuButton>
            )}
            {/* Not in the menu: for someone who is not in this family, this is
                the whole reason they opened the page. */}
            {!family.isMember && !family.canEdit && myPersonId && (
              <Button onClick={() => void requestToJoin()} disabled={busy}>
                Ask to join this family
              </Button>
            )}
          </>
        }
      />

      {/* The file input and the cropper, with no control of their own: the photo
          is added from the menu above. */}
      {family.canEdit && photoPicker.elements}

      {/* Only ever a photo. "Don't show the add a photo button or the photo
          placeholder unless a family photo has been added" -- so a family
          without one gets the space back rather than an empty circle. */}
      {family.thumbUrl && (
        <div className="mb-6 flex flex-col items-center gap-4">
          <FamilyPhoto
            thumbUrl={family.thumbUrl}
            fullUrl={family.fullUrl}
            width={family.photoWidth}
            height={family.photoHeight}
            familyName={family.name}
          />
        </div>
      )}

      {/* A failed mutation reports here rather than replacing the page. */}
      {error && <ErrorNotice message={error} />}
      {photoPicker.error && (
        <p role="alert" className="mb-4 font-bold text-primary">
          {photoPicker.error}
        </p>
      )}

      {family.pendingJoinRequests.length > 0 && (
        <section className="mb-6 rounded-lg border border-accent/40 bg-accent/5 p-4">
          <h2 className="mb-3 font-bold text-ink">Waiting to join</h2>
          <ul className="space-y-2">
            {family.pendingJoinRequests.map((request) => (
              <li
                key={request.id}
                className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between"
              >
                <span>{request.personName}</span>
                <span className="flex gap-2">
                  <Button onClick={() => void decide(request.id, "approve")}>Approve</Button>
                  <Button variant="ghost" onClick={() => void decide(request.id, "deny")}>
                    Decline
                  </Button>
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {family.members.length === 0 ? (
        <EmptyState title="Nobody in this family yet" />
      ) : (
        <FamilyMemberList
          members={members}
          anniversaries={family.anniversaries}
          canEdit={family.canEdit}
          myPersonId={myPersonId}
          onRemove={setRemoving}
          onReorder={(personIds) => void reorder(personIds)}
        />
      )}

      <section className="mt-8">
        <h2 className="mb-3 text-xl font-bold text-ink">The year ahead</h2>
        {datesQuery.isPending ? (
          <Spinner label="Loading dates" />
        ) : datesQuery.error ? (
          <ErrorNotice
            message={datesQuery.error.message}
            onRetry={() => void datesQuery.refetch()}
          />
        ) : (
          <SpecialDateList
            days={datesQuery.data?.days ?? []}
            emptyTitle="No special dates in the next year"
          />
        )}
      </section>

      {addingMember && (
        <Modal title="Add a family member" onClose={() => setAddingMember(false)}>
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              void addMember();
            }}
          >
            <p className="text-ink-muted">
              For someone without their own account — a child, for example. Anyone in the family
              with an account can keep their details up to date.
            </p>
            <div className="grid gap-4 md:grid-cols-2">
              <Field label="First name">
                <input
                  className={inputClass}
                  required
                  value={newFirstName}
                  onChange={(event) => setNewFirstName(event.target.value)}
                />
              </Field>
              <Field label="Last name" hint="Leave blank to inherit it from a parent afterwards">
                <input
                  className={inputClass}
                  value={newLastName}
                  onChange={(event) => setNewLastName(event.target.value)}
                />
              </Field>
            </div>
            <div className="flex flex-col gap-2 sm:flex-row">
              <Button type="submit" disabled={busy || newFirstName.trim() === ""}>
                {busy ? "Adding…" : "Add"}
              </Button>
              <Button variant="ghost" onClick={() => setAddingMember(false)}>
                Cancel
              </Button>
            </div>
          </form>
        </Modal>
      )}

      {renaming && (
        <Modal title="Rename family" onClose={() => setRenaming(false)}>
          <form
            className="space-y-4"
            onSubmit={async (event) => {
              event.preventDefault();
              setBusy(true);
              try {
                await api(`/families/${family.id}`, { method: "PATCH", body: { name } });
                setRenaming(false);
                await reload();
              } finally {
                setBusy(false);
              }
            }}
          >
            <Field label="Family name">
              <input
                className={inputClass}
                required
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </Field>
            <div className="flex flex-col gap-2 sm:flex-row">
              <Button type="submit" disabled={busy}>
                Save
              </Button>
              <Button variant="ghost" onClick={() => setRenaming(false)}>
                Cancel
              </Button>
            </div>
          </form>
        </Modal>
      )}

      {removing && (
        <ConfirmDialog
          title={removing.id === myPersonId ? "Leave this family?" : "Remove from family?"}
          confirmLabel={removing.id === myPersonId ? "Leave" : "Remove"}
          busy={busy}
          onConfirm={() => void removeMember(removing)}
          onClose={() => setRemoving(null)}
        >
          {removing.id === myPersonId ? (
            <>
              You will leave the {family.name} family. Any details you share with them will be
              cleared, and you will have to ask to join again.
            </>
          ) : removing.appUserId ? (
            <>
              {removing.firstName} will be removed from the {family.name} family and any details
              they share with relatives will be cleared. They can ask to join again.
            </>
          ) : (
            <>
              {removing.firstName} has no account of their own. Removing them clears any details
              they share with the family — they will have no family until someone adds them back.
            </>
          )}
        </ConfirmDialog>
      )}

      {addingExisting && (
        <AddExistingMemberModal
          familyId={family.id}
          familyName={family.name}
          onClose={() => setAddingExisting(false)}
          onAdded={async () => {
            setAddingExisting(false);
            await reload();
          }}
        />
      )}
    </>
  );
}

/**
 * Adds someone already in the directory who has no family. Only people without
 * an account appear: anyone with one joins by asking, which is the whole point
 * of the request flow.
 */
function AddExistingMemberModal({
  familyId,
  familyName,
  onClose,
  onAdded,
}: {
  familyId: string;
  familyName: string;
  onClose: () => void;
  onAdded: () => Promise<void>;
}) {
  const { organizationId } = useMe();
  const [personId, setPersonId] = useState("");
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const candidatesQuery = useQuery({
    queryKey: qk.familyCandidates(organizationId, familyId),
    queryFn: ({ signal }) =>
      api<{ candidates: { id: string; name: string }[] }>(`/families/${familyId}/candidates`, {
        signal,
      }),
  });

  // A failure here still shows the modal's empty state, as it did before, with
  // the reason above it.
  const candidates = candidatesQuery.isPending ? null : (candidatesQuery.data?.candidates ?? []);
  const error = actionError ?? candidatesQuery.error?.message ?? null;

  async function submit(): Promise<void> {
    setBusy(true);
    setActionError(null);
    try {
      await api(`/families/${familyId}/members`, { method: "POST", body: { personId } });
      await onAdded();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Could not add them");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="Add an existing person" onClose={onClose}>
      {candidates === null ? (
        <Spinner label="Loading people" />
      ) : candidates.length === 0 ? (
        <EmptyState title="Nobody to add">
          Everyone in the directory without an account already belongs to a family.
        </EmptyState>
      ) : (
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <p className="text-ink-muted">
            Someone already in the directory who has no family, such as a person removed from{" "}
            {familyName} by mistake.
          </p>
          <Field label="Person">
            <select
              className={inputClass}
              value={personId}
              onChange={(event) => setPersonId(event.target.value)}
            >
              <option value="">Choose someone</option>
              {candidates.map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {candidate.name}
                </option>
              ))}
            </select>
          </Field>
          {error && (
            <p role="alert" className="font-bold text-primary">
              {error}
            </p>
          )}
          <div className="flex flex-col gap-2 sm:flex-row">
            <Button type="submit" disabled={busy || personId === ""}>
              {busy ? "Adding…" : "Add"}
            </Button>
            <Button variant="ghost" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
          </div>
        </form>
      )}
    </Modal>
  );
}

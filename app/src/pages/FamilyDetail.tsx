import { useCallback, useEffect, useState } from "react";
import { useParams } from "react-router";
import type { FamilyDto, PersonDto, PersonSummaryDto } from "@shared";
import { api } from "../lib/api";
import { useMe } from "../context/MeContext";
import { PersonCard } from "../components/PersonCard";
import { PhotoUpload } from "../components/PhotoUpload";
import { Avatar } from "../components/Avatar";
import {
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
 * A family: its members, its photo, and the requests waiting to join it.
 *
 * Any member with an account can add family members who have none -- "a family
 * might have children that don't have an account in the app" -- and approve
 * requests from others.
 */
export function FamilyDetail() {
  const { id } = useParams<{ id: string }>();
  const { me, reload: reloadMe } = useMe();
  const [family, setFamily] = useState<FamilyDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [addingMember, setAddingMember] = useState(false);
  const [newFirstName, setNewFirstName] = useState("");
  const [newLastName, setNewLastName] = useState("");
  const [busy, setBusy] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState("");
  const [removing, setRemoving] = useState<PersonSummaryDto | null>(null);
  const [addingExisting, setAddingExisting] = useState(false);

  const myPersonId = me?.appUser.personId ?? null;

  const load = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    setError(null);
    try {
      const loaded = await api<FamilyDto>(`/families/${id}`);
      setFamily(loaded);
      setName(loaded.name);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load that family");
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  // Deliberately not an early return on `error`: a failed mutation must not
  // replace the whole page with a notice and lose the family being worked on.
  if (loading) return <Spinner label="Loading family" />;
  if (!family) {
    return error ? <ErrorNotice message={error} onRetry={() => void load()} /> : null;
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
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not add that person");
    } finally {
      setBusy(false);
    }
  }

  async function decide(requestId: string, decision: "approve" | "deny"): Promise<void> {
    await api(`/families/join-requests/${requestId}/${decision}`, { method: "POST" });
    await load();
    // Approving someone may have been us, which changes our own family.
    await reloadMe();
  }

  async function removeMember(member: PersonSummaryDto): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await api(`/families/${family!.id}/members/${member.id}`, { method: "DELETE" });
      setRemoving(null);
      await load();
      // Leaving changes what the caller may edit, here and everywhere else.
      if (member.id === myPersonId) await reloadMe();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not remove them");
    } finally {
      setBusy(false);
    }
  }

  async function requestToJoin(): Promise<void> {
    setBusy(true);
    try {
      await api(`/families/${family!.id}/join-requests`, { method: "POST" });
      await load();
      await reloadMe();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not send that request");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageHeading
        title={family.name}
        subtitle={`${family.members.length} ${family.members.length === 1 ? "member" : "members"}`}
        actions={
          <>
            {family.canEdit && (
              <>
                <Button variant="secondary" onClick={() => setAddingMember(true)}>
                  Create a new person
                </Button>
                <Button variant="secondary" onClick={() => setAddingExisting(true)}>
                  Add an existing person
                </Button>
                <Button variant="ghost" onClick={() => setRenaming(true)}>
                  Rename
                </Button>
              </>
            )}
            {!family.isMember && !family.canEdit && myPersonId && (
              <Button onClick={() => void requestToJoin()} disabled={busy}>
                Ask to join this family
              </Button>
            )}
          </>
        }
      />

      <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-center">
        {family.canEdit ? (
          <PhotoUpload
            owner={{ familyId: family.id }}
            photoUrl={family.photoUrl}
            person={{ firstName: family.name, lastName: null }}
            onUploaded={async (photoKey) => {
              await api(`/families/${family.id}/photo`, { method: "PUT", body: { photoKey } });
              await load();
            }}
            onRemove={async () => {
              await api(`/families/${family.id}/photo`, {
                method: "PUT",
                body: { photoKey: null },
              });
              await load();
            }}
          />
        ) : (
          family.photoUrl && (
            <Avatar
              photoUrl={family.photoUrl}
              person={{ firstName: family.name, lastName: null }}
              size="lg"
            />
          )
        )}
      </div>

      {/* A failed mutation reports here rather than replacing the page. */}
      {error && <ErrorNotice message={error} />}

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
        <ul className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
          {family.members.map((member) => (
            <li key={member.id} className="flex flex-col gap-1">
              <PersonCard person={member} />
              {family.canEdit && (
                <button
                  type="button"
                  className="tap-target self-end text-sm font-bold text-primary hover:text-accent"
                  onClick={() => setRemoving(member)}
                >
                  {member.id === myPersonId ? "Leave this family" : "Remove from family"}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

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
                await load();
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
            await load();
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
  const [candidates, setCandidates] = useState<{ id: string; name: string }[] | null>(null);
  const [personId, setPersonId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const { candidates: loaded } = await api<{ candidates: { id: string; name: string }[] }>(
          `/families/${familyId}/candidates`
        );
        setCandidates(loaded);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not load people");
        setCandidates([]);
      }
    })();
  }, [familyId]);

  async function submit(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await api(`/families/${familyId}/members`, { method: "POST", body: { personId } });
      await onAdded();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not add them");
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

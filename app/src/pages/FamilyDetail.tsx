import { useCallback, useEffect, useState } from "react";
import { useParams } from "react-router";
import type { FamilyDto, PersonDto } from "@shared";
import { api } from "../lib/api";
import { useMe } from "../context/MeContext";
import { PersonCard } from "../components/PersonCard";
import { PhotoUpload } from "../components/PhotoUpload";
import { Avatar } from "../components/Avatar";
import {
  Button,
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

  if (loading) return <Spinner label="Loading family" />;
  if (error) return <ErrorNotice message={error} onRetry={() => void load()} />;
  if (!family) return null;

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
                  Add a family member
                </Button>
                <Button variant="ghost" onClick={() => setRenaming(true)}>
                  Rename
                </Button>
              </>
            )}
            {!family.isMember && !family.canEdit && me?.appUser.personId && (
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
            <li key={member.id}>
              <PersonCard person={member} />
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
    </>
  );
}

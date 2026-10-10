import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  GROUP_DESCRIPTION_MAX,
  GROUP_TITLE_MAX,
  GROUP_VISIBILITIES,
  groupCreateSchema,
  groupVisibilityLabel,
  type GroupPostReportDto,
  type GroupSummaryDto,
  type GroupVisibility,
} from "@shared";
import { api } from "../lib/api";
import { qk } from "../lib/queryKeys";
import { useMe } from "../context/MeContext";
import { Link } from "../components/nav";
import {
  Badge,
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
 * Every group the caller may know about: Public and Private ones parish-wide,
 * Secret ones only if they are a member or a parish admin -- the server
 * already filters this, so the page only has to render what it is given. See
 * requirements/groups.md for the visibility rules.
 */
export function Groups() {
  const { me, isAdmin, organizationId } = useMe();
  const queryClient = useQueryClient();
  const [creating, setCreating] = useState(false);

  const groupsQuery = useQuery({
    queryKey: qk.groups(organizationId),
    queryFn: ({ signal }) => api<{ groups: GroupSummaryDto[] }>("/groups", { signal }),
  });

  // Every open report parish-wide, so an admin learns about a reported post
  // even in a group they are not a member of. `enabled` keeps this off the
  // wire entirely for anyone below ADMIN -- the endpoint would 403 anyway.
  const reportsQuery = useQuery({
    queryKey: qk.allGroupReports(organizationId),
    queryFn: ({ signal }) => api<{ reports: GroupPostReportDto[] }>("/groups/reports", { signal }),
    enabled: isAdmin,
  });

  const groups = groupsQuery.data?.groups ?? [];
  const reports = reportsQuery.data?.reports ?? [];
  const canCreate = Boolean(me?.appUser.personId);

  const mine = groups.filter((g) => g.myRole !== null);
  const others = groups.filter((g) => g.myRole === null);

  return (
    <>
      <PageHeading
        title="Groups"
        subtitle={`${groups.length} ${groups.length === 1 ? "group" : "groups"}`}
        actions={canCreate && <Button onClick={() => setCreating(true)}>Start a group</Button>}
      />

      {groupsQuery.error && (
        <ErrorNotice
          message={groupsQuery.error.message}
          onRetry={() => void groupsQuery.refetch()}
        />
      )}

      {!canCreate && (
        <ErrorNotice message="Your directory record is missing, so you cannot create or join a group. Ask a parish administrator to look into it." />
      )}

      {reports.length > 0 && (
        <section className="mb-6 rounded-lg border border-accent/40 bg-accent/5 p-4">
          <h2 className="mb-2 font-bold text-ink">
            {reports.length === 1 ? "One post has" : `${reports.length} posts have`} been reported
          </h2>
          <ul className="space-y-1 text-sm">
            {reports.map((report) => (
              <li key={report.id}>
                <Link
                  to={`/groups/${report.groupId}`}
                  className="font-bold text-accent hover:underline"
                >
                  {report.groupTitle}
                </Link>
                <span className="text-ink-muted"> — “{report.postExcerpt}”</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {groupsQuery.isPending ? (
        <Spinner label="Loading groups" />
      ) : groups.length === 0 ? (
        <EmptyState title="No groups yet">
          Start one for a ministry, a study, or anything else the parish organizes around.
        </EmptyState>
      ) : (
        <>
          {mine.length > 0 && (
            <section className="mb-8">
              <h2 className="mb-3 font-bold text-ink">Yours</h2>
              <GroupGrid groups={mine} />
            </section>
          )}
          {others.length > 0 && (
            <section>
              {mine.length > 0 && <h2 className="mb-3 font-bold text-ink">More groups</h2>}
              <GroupGrid groups={others} />
            </section>
          )}
        </>
      )}

      {creating && (
        <CreateGroupModal
          existingTitles={groups.map((g) => g.title)}
          onClose={() => setCreating(false)}
          onCreated={async () => {
            setCreating(false);
            await queryClient.invalidateQueries({ queryKey: qk.groups(organizationId) });
          }}
        />
      )}
    </>
  );
}

function GroupGrid({ groups }: { groups: GroupSummaryDto[] }) {
  return (
    <ul className="columns-1 gap-4 sm:columns-2 lg:columns-3">
      {groups.map((group) => (
        <li key={group.id} className="mb-4 break-inside-avoid">
          <GroupCard group={group} />
        </li>
      ))}
    </ul>
  );
}

const VISIBILITY_TONE: Record<GroupVisibility, "neutral" | "accent" | "primary"> = {
  PUBLIC: "neutral",
  PRIVATE: "accent",
  SECRET: "primary",
};

function GroupCard({ group }: { group: GroupSummaryDto }) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const photo = group.thumbUrl && failedUrl !== group.thumbUrl ? group.thumbUrl : null;

  return (
    <Link
      to={`/groups/${group.id}`}
      className="group flex flex-col overflow-hidden rounded-card-photo border border-line bg-surface shadow-sm transition hover:border-accent hover:shadow-md"
    >
      {photo && (
        <div className="aspect-card-photo overflow-hidden border-b border-line bg-surface-muted">
          <img
            src={photo}
            alt=""
            loading="lazy"
            decoding="async"
            onError={() => setFailedUrl(photo)}
            className="h-full w-full object-cover transition duration-300 group-hover:scale-[1.03]"
          />
        </div>
      )}

      <div className="flex flex-1 flex-col gap-2 p-4">
        <div className="flex items-start justify-between gap-2">
          <h3 className="min-w-0 break-words text-lg font-bold leading-snug text-ink transition group-hover:text-accent">
            {group.title}
          </h3>
          {group.unreadCount > 0 && <Badge tone="primary">{group.unreadCount} new</Badge>}
        </div>

        {group.description && (
          <p className="line-clamp-2 break-words text-sm text-ink-muted">{group.description}</p>
        )}

        <div className="mt-auto flex flex-wrap items-center gap-2 pt-1">
          <Badge tone={VISIBILITY_TONE[group.visibility]}>
            {groupVisibilityLabel(group.visibility)}
          </Badge>
          <span className="text-sm text-ink-muted">
            {group.memberCount} {group.memberCount === 1 ? "member" : "members"}
          </span>
          {group.myRole === "ADMIN" && <Badge tone="accent">Admin</Badge>}
          {group.pendingJoinRequestId && <Badge tone="accent">Waiting for approval</Badge>}
        </div>
      </div>
    </Link>
  );
}

function CreateGroupModal({
  existingTitles,
  onClose,
  onCreated,
}: {
  existingTitles: string[];
  onClose: () => void;
  onCreated: () => Promise<void>;
}) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [visibility, setVisibility] = useState<GroupVisibility>("PUBLIC");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const duplicate = existingTitles.some((t) => t.toLowerCase() === title.trim().toLowerCase());

  async function submit(): Promise<void> {
    const parsed = groupCreateSchema.safeParse({ title, description, visibility });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "That is not valid");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api("/groups", { method: "POST", body: parsed.data });
      await onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create that group");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="Start a group" onClose={onClose}>
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <Field
          label="Title"
          hint={duplicate ? `There is already a group called ${title.trim()}.` : undefined}
        >
          <input
            className={inputClass}
            value={title}
            maxLength={GROUP_TITLE_MAX}
            onChange={(event) => setTitle(event.target.value)}
            autoFocus
            required
          />
        </Field>

        <Field label="Description" hint="Optional.">
          <textarea
            className={`${inputClass} min-h-24`}
            value={description}
            maxLength={GROUP_DESCRIPTION_MAX}
            onChange={(event) => setDescription(event.target.value)}
          />
        </Field>

        <fieldset>
          <legend className="mb-1 font-bold text-ink">Who can join</legend>
          <div className="space-y-2">
            {GROUP_VISIBILITIES.map((option) => (
              <label key={option} className="flex items-start gap-2 text-sm">
                <input
                  type="radio"
                  name="visibility"
                  checked={visibility === option}
                  onChange={() => setVisibility(option)}
                  className="mt-1"
                />
                <span>
                  <span className="font-bold text-ink">{groupVisibilityLabel(option)}</span>
                  <span className="block text-ink-muted">{VISIBILITY_HELP[option]}</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>

        {error && (
          <p role="alert" className="font-bold text-primary">
            {error}
          </p>
        )}

        <div className="flex flex-col gap-2 sm:flex-row">
          <Button type="submit" disabled={busy || title.trim() === ""}>
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

const VISIBILITY_HELP: Record<GroupVisibility, string> = {
  PUBLIC: "Anyone can see it, join it, and read its messages.",
  PRIVATE: "Anyone can see it exists, but joining takes an invite or your request to be approved.",
  SECRET: "Only members — and parish administrators — can see it exists at all.",
};

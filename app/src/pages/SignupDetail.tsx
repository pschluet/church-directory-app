import { useEffect, useRef, useState } from "react";
import { Navigate, useLocation, useParams } from "react-router";
import { useMutation, useQuery } from "@tanstack/react-query";
import type { GroupDto, GroupPostDto } from "@shared";
import { api, ApiError } from "../lib/api";
import { qk } from "../lib/queryKeys";
import { eventDetailPath, flashMessage, threadPath, useMessageTarget } from "../lib/messageLinks";
import { formatPostedAt } from "../lib/format";
import { useMe } from "../context/MeContext";
import { Link } from "../components/nav";
import { useGroupLive } from "../components/useGroupLive";
import { Button, ConfirmDialog, ErrorNotice, Spinner, useNow } from "../components/ui";
import { ShareButtons } from "../components/ShareButtons";
import { SignupBlock, SignupComposerModal, useSignupShare } from "../components/GroupSignup";
import {
  ChatComposer,
  JoinBar,
  MembersOnly,
  ReplyList,
  ReportModal,
  joinState,
  useGroupPageActions,
  useThreadReplies,
} from "./GroupDetail";
import { PostPageHeader } from "./EventDetail";

/**
 * One sign-up, on a page of its own -- the sign-up twin of EventDetail.tsx.
 * Its share link sends a signed-in reader here, its card's title leads here,
 * and "Reply" on a sign-up comes here, since its discussion lives on this page
 * rather than in a chat thread.
 *
 * Laid out as the event page is: the sign-up itself as the hero, the
 * organizer's controls in plain sight, the share tools, then the conversation.
 * Every piece is the group page's own -- the slots, the share actions, the
 * reply list and composer -- so a sign-up behaves the same wherever it is
 * reached. Access is the group's too (GET /groups/:id/posts/:postId).
 */
export function SignupDetail() {
  const { id, postId: postIdParam } = useParams<{ id: string; postId: string }>();
  const groupId = id!;
  const postId = postIdParam!;
  const { organizationId } = useMe();
  const location = useLocation();
  const now = useNow();
  const { refresh, joinActions, actionError } = useGroupPageActions(groupId);

  const groupQuery = useQuery({
    queryKey: qk.group(organizationId, groupId),
    queryFn: ({ signal }) => api<GroupDto>(`/groups/${groupId}`, { signal }),
    refetchOnWindowFocus: true,
  });
  const group = groupQuery.data;
  const canSeeContent = Boolean(
    group && (group.visibility === "PUBLIC" || group.myRole !== null || group.viewingAsAdmin)
  );

  const postQuery = useQuery({
    queryKey: qk.groupPost(organizationId, groupId, postId),
    queryFn: ({ signal }) => api<GroupPostDto>(`/groups/${groupId}/posts/${postId}`, { signal }),
    enabled: canSeeContent,
    refetchOnWindowFocus: true,
  });
  const post = postQuery.data;

  // Live, like the group page: a new entry or reply arrives on its own.
  useGroupLive(groupId, { enabled: canSeeContent });

  if (groupQuery.isPending) return <Spinner label="Loading the sign-up" />;
  if (groupQuery.error || !group) {
    return (
      <ErrorNotice
        message={
          groupQuery.error instanceof ApiError && groupQuery.error.status === 404
            ? "That group was not found."
            : (groupQuery.error?.message ?? "Could not load that group")
        }
        onRetry={() => void groupQuery.refetch()}
      />
    );
  }

  const header = (
    <PostPageHeader group={group} groupId={groupId} label="Sign-up" defaultTab="signups" />
  );

  if (!canSeeContent || (postQuery.error instanceof ApiError && postQuery.error.status === 403)) {
    return (
      <>
        {header}
        <MembersOnly group={group} joinActions={joinActions} what="this sign-up" />
      </>
    );
  }
  if (postQuery.isPending) return <Spinner label="Loading the sign-up" />;
  if (postQuery.error || !post) {
    return (
      <>
        {header}
        <ErrorNotice
          message={
            postQuery.error instanceof ApiError && postQuery.error.status === 404
              ? "That sign-up was not found."
              : (postQuery.error?.message ?? "Could not load that sign-up")
          }
          onRetry={() => void postQuery.refetch()}
        />
      </>
    );
  }
  // Not a sign-up: send it where it belongs, keeping any reply it names.
  if (post.kind !== "SIGNUP") {
    const rootId = post.parentPostId ?? post.id;
    return (
      <Navigate
        to={{
          pathname:
            post.kind === "EVENT" && !post.parentPostId
              ? eventDetailPath(groupId, rootId)
              : threadPath(groupId, rootId),
          // A reply keeps being named, so its thread opens on it.
          search: location.search || (post.parentPostId ? `?message=${post.id}` : ""),
        }}
        replace
        state={location.state}
      />
    );
  }

  return (
    <>
      {header}
      {actionError && (
        <div className="mb-4">
          <ErrorNotice message={actionError} />
        </div>
      )}
      <SignupPage
        group={group}
        groupId={groupId}
        post={post}
        now={now}
        joinActions={joinActions}
        focusComposer={Boolean(
          (location.state as { focusComposer?: boolean } | null)?.focusComposer
        )}
        onChanged={refresh}
      />
    </>
  );
}

function SignupPage({
  group,
  groupId,
  post,
  now,
  joinActions,
  focusComposer,
  onChanged,
}: {
  group: GroupDto;
  groupId: string;
  post: GroupPostDto;
  now: Date;
  joinActions: ReturnType<typeof useGroupPageActions>["joinActions"];
  focusComposer: boolean;
  onChanged: () => Promise<unknown>;
}) {
  // A deleted sign-up is gone, as the API returns it: only its discussion stays.
  const signup = post.deletedAt === null ? post.signup : null;

  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [reporting, setReporting] = useState<GroupPostDto | null>(null);
  const [editingReply, setEditingReply] = useState<GroupPostDto | null>(null);

  const share = useSignupShare(signup);

  const remove = useMutation({
    mutationFn: () => api(`/groups/${groupId}/posts/${post.id}`, { method: "DELETE" }),
    onSuccess: async () => {
      setConfirmDelete(false);
      await onChanged();
    },
  });

  const { repliesQuery, replies, items } = useThreadReplies(groupId, post.id, now, true);
  const replyCount = replies?.length ?? post.replyCount;

  // Arrived by a link to one of the replies: scroll the page to it and light it,
  // once per navigation (see useMessageTarget).
  const { targetId, targetKey } = useMessageTarget();
  const handledTarget = useRef<string | null>(null);
  useEffect(() => {
    if (!targetId || !replies || handledTarget.current === targetKey) return;
    handledTarget.current = targetKey;
    flashMessage(targetId);
  }, [replies, targetId, targetKey]);

  return (
    <div className="space-y-6 pb-8">
      {!signup ? (
        <div
          role="status"
          className="rounded-xl border border-primary/40 bg-primary/5 px-4 py-3 font-bold text-primary"
        >
          This sign-up has been deleted.
        </div>
      ) : (
        <section aria-labelledby="signup-title" className="space-y-0">
          <SignupBlock
            signup={signup}
            groupId={groupId}
            postId={post.id}
            canSignUp={group.canReact}
            onChanged={onChanged}
            page
          />
          <p className="px-2 pt-2 text-sm text-ink-muted">
            Posted by{" "}
            <Link
              to={`/people/${post.authorPersonId}`}
              className="font-bold text-ink hover:text-accent hover:underline"
            >
              {post.authorName}
            </Link>{" "}
            · {formatPostedAt(post.createdAt, now)}
            {post.editedAt && " · edited"}
          </p>
        </section>
      )}

      {/* The organizer's controls, in plain sight: this is the sign-up's one authoritative page. */}
      {signup && (post.canEdit || post.canDelete || post.canReport) && (
        <div className="flex flex-wrap gap-2">
          {post.canEdit && (
            <Button variant="secondary" onClick={() => setEditing(true)}>
              Edit sign-up
            </Button>
          )}
          {post.canDelete && (
            <Button variant="danger" onClick={() => setConfirmDelete(true)}>
              Delete sign-up
            </Button>
          )}
          {post.canReport && (
            <Button variant="ghost" onClick={() => setReporting(post)}>
              Report
            </Button>
          )}
        </div>
      )}

      {signup && (
        <section
          aria-labelledby="signup-share"
          className="rounded-2xl border border-line bg-surface p-6 shadow-sm"
        >
          <h2 id="signup-share" className="text-lg font-bold text-ink">
            Share this sign-up
          </h2>
          <p className="mb-4 mt-1 text-sm text-ink-muted">
            {signup.publicEnabled
              ? "Anyone with the link can see this sign-up and sign up without an account."
              : "The link opens this page for members of the directory. Anybody else is asked to sign in."}
          </p>
          <ShareButtons share={share} size="lg" />
        </section>
      )}

      <section aria-labelledby="signup-discussion" className="space-y-3">
        <h2
          id="signup-discussion"
          className="flex items-center gap-3 text-xs font-bold uppercase tracking-wide text-ink-muted"
        >
          <span className="h-px flex-1 bg-line" />
          {replyCount === 0
            ? "Discussion"
            : `Discussion · ${replyCount} ${replyCount === 1 ? "reply" : "replies"}`}
          <span className="h-px flex-1 bg-line" />
        </h2>

        {repliesQuery.isPending ? (
          <Spinner label="Loading replies" />
        ) : repliesQuery.error ? (
          <ErrorNotice
            message={repliesQuery.error.message}
            onRetry={() => void repliesQuery.refetch()}
          />
        ) : (
          <>
            {replyCount === 0 && (
              <p className="px-2 text-center text-sm text-ink-muted">
                {group.canReply ? "Ask a question about this sign-up." : "Nobody has replied yet."}
              </p>
            )}
            <ReplyList
              items={items}
              group={group}
              groupId={groupId}
              now={now}
              onReport={setReporting}
              onChanged={onChanged}
              onEdit={setEditingReply}
              editingId={editingReply?.id ?? null}
              parentKind="SIGNUP"
            />
          </>
        )}

        <div className="border-t border-line pt-3">
          {group.canReply || editingReply ? (
            <>
              <JoinBar compact group={group} actions={joinActions} />
              <ChatComposer
                groupId={groupId}
                members={group.members}
                parentPostId={post.id}
                placeholder="Reply…"
                autoFocus={focusComposer}
                editing={editingReply}
                onEditDone={() => setEditingReply(null)}
                onPosted={onChanged}
              />
            </>
          ) : joinState(group) ? (
            <JoinBar group={group} actions={joinActions} />
          ) : (
            <p className="text-sm text-ink-muted">You cannot reply in this group.</p>
          )}
        </div>
      </section>

      {editing && (
        <SignupComposerModal
          groupId={groupId}
          post={post}
          onClose={() => setEditing(false)}
          onPosted={async () => {
            setEditing(false);
            await onChanged();
          }}
        />
      )}

      {confirmDelete && (
        <ConfirmDialog
          title="Delete this sign-up?"
          confirmLabel="Delete it"
          busy={remove.isPending}
          onConfirm={() => remove.mutate()}
          onClose={() => setConfirmDelete(false)}
        >
          <p>A placeholder stays in its place so any replies keep their context.</p>
        </ConfirmDialog>
      )}

      {reporting && (
        <ReportModal
          post={reporting}
          groupId={groupId}
          onClose={() => setReporting(null)}
          onReported={async () => {
            setReporting(null);
            await onChanged();
          }}
        />
      )}
    </div>
  );
}

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  PRAYER_REQUEST_BODY_MAX,
  PRAYER_REQUEST_MAX_IMAGES,
  PRAYER_REQUEST_TITLE_MAX,
  prayerRequestCreateSchema,
  type PrayerRequestDto,
  type PrayerRequestImageDto,
} from "@shared";
import { ApiError, api } from "../lib/api";
import { qk } from "../lib/queryKeys";
import { formatPostedAt } from "../lib/format";
import { useMe } from "../context/MeContext";
import { useAttachmentPicker } from "../components/useAttachmentPicker";
import { PhotoLightbox } from "../components/PhotoLightbox";
import {
  Badge,
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
  useNow,
} from "../components/ui";

/**
 * The prayer requests page.
 *
 * One list for the parish and one for the author, from one endpoint: a request
 * is invisible to everyone but its author until a reviewer approves it, so
 * "Yours" is where somebody watches theirs move from waiting to posted. The
 * server decides all of that and sends `isMine`, `canDecide` and `canDelete`
 * per row; nothing here re-derives a permission.
 *
 * A reviewer's queue is a banner on this same page rather than a route of its
 * own. Reviewing is a handful of decisions a week, prompted by a notification,
 * and a separate screen would be one more place to remember to visit.
 */

interface Feed {
  prayerRequests: PrayerRequestDto[];
}

export function PrayerRequests() {
  const { me, canApprovePrayerRequests, organizationId } = useMe();
  const queryClient = useQueryClient();
  const [composing, setComposing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<PrayerRequestDto | null>(null);
  // Kept apart from the query's own error, so a failed action never replaces
  // the list with a notice.
  const [actionError, setActionError] = useState<string | null>(null);

  /*
   * Nothing on this page polls. It updates three ways: a push, forwarded to
   * open tabs by the service worker (see useRealtimeRefresh); coming back to
   * the app; and the refresh button.
   *
   * `refetchOnWindowFocus` is on for these two and the bell's inbox, and
   * nowhere else in the app -- the default in lib/queryClient.ts is off. The
   * page needs it because the bell has it: without it, returning to the app
   * could show a badge reading "1 new" above a list that does not contain it.
   * It only fires when the data is already stale (30s) or was invalidated.
   */
  const feedQuery = useQuery({
    queryKey: qk.prayerRequests(organizationId),
    queryFn: ({ signal }) => api<Feed>("/prayer-requests", { signal }),
    refetchOnWindowFocus: true,
  });

  const queueQuery = useQuery({
    queryKey: qk.pendingPrayerRequests(organizationId),
    queryFn: ({ signal }) => api<Feed>("/prayer-requests/pending", { signal }),
    enabled: canApprovePrayerRequests,
    refetchOnWindowFocus: true,
  });

  /*
   * One prefix match sweeps the feed and the queue, which is why the queue key
   * is nested under the feed's. The bell is a separate key and a separate
   * concern -- approving something notifies everyone *else*, so the reviewer's
   * own count does not change -- but a member who lands here from a
   * notification wants the badge to settle, so it is refreshed too.
   */
  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: qk.prayerRequests(organizationId) }),
      queryClient.invalidateQueries({ queryKey: qk.notifications() }),
    ]);

  /*
   * Acting on a row somebody else already dealt with is not the caller's
   * mistake, so it is reconciled rather than reported.
   *
   * The server answers 409 on a request that has already been reviewed and 404
   * on one that is gone; both mean "your copy of this list is out of date".
   * Refreshing makes the stale row disappear, which is what the caller wanted
   * to happen to it anyway. This matters more now that nothing polls: the
   * window in which a reviewer can be looking at a decided queue used to be a
   * minute and is now open-ended.
   */
  function handleActionError(err: unknown, fallback: string): void {
    if (err instanceof ApiError && (err.status === 409 || err.status === 404)) {
      setActionError("Somebody else got there first — this list has been refreshed.");
      void refresh();
      return;
    }
    setActionError(err instanceof Error ? err.message : fallback);
  }

  const decide = useMutation({
    mutationFn: ({ id, decision }: { id: string; decision: "approve" | "reject" }) =>
      api(`/prayer-requests/${id}/${decision}`, { method: "POST" }),
    onSuccess: refresh,
    onError: (err) => handleActionError(err, "Could not record that decision"),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api(`/prayer-requests/${id}`, { method: "DELETE" }),
    onSuccess: async () => {
      setConfirmDelete(null);
      await refresh();
    },
    onError: (err) => {
      setConfirmDelete(null);
      handleActionError(err, "Could not remove that request");
    },
  });

  const all = feedQuery.data?.prayerRequests ?? [];
  const posted = all.filter((request) => request.status === "APPROVED");
  /*
   * "Yours" is only the requests of the caller's that are *not* posted -- the
   * ones waiting on a reviewer and the ones declined. Once a request is posted
   * it belongs in the parish list like everybody else's; keeping it in both
   * rendered the same card twice, menu and all.
   */
  const mine = all.filter((request) => request.isMine && request.status !== "APPROVED");
  // A reviewer's own pending request is in this list; it is filtered out below
  // rather than by the server, so the count they see matches the queue.
  const queue = (queueQuery.data?.prayerRequests ?? []).filter((request) => request.canDecide);

  const error = actionError ?? feedQuery.error?.message ?? null;
  const canPost = Boolean(me?.appUser.personId);
  const fetching = feedQuery.isFetching || queueQuery.isFetching;
  /*
   * One clock for every relative time on this page -- the cards and the
   * "Updated" label alike. Without it they freeze at the moment they were
   * rendered, which is how a page left open came to disagree with the bell
   * about when the same request was posted.
   */
  const now = useNow();

  return (
    <>
      <PageHeading
        title="Prayer Requests"
        subtitle={`${posted.length} ${posted.length === 1 ? "request" : "requests"} from the last month`}
        actions={
          <>
            <RefreshButton
              busy={fetching}
              updatedAt={feedQuery.dataUpdatedAt}
              now={now}
              onRefresh={() => void refresh()}
            />
            {canPost && <Button onClick={() => setComposing(true)}>Ask for prayers</Button>}
          </>
        }
      />

      {error && <ErrorNotice message={error} onRetry={() => void feedQuery.refetch()} />}

      {!canPost && (
        <ErrorNotice message="Your directory record is missing, so you cannot post a prayer request. Ask a parish administrator to look into it." />
      )}

      {queue.length > 0 && (
        <section className="mb-6 rounded-lg border border-accent/40 bg-accent/5 p-4">
          <h2 className="mb-2 font-bold text-ink">
            {queue.length === 1 ? "One request is" : `${queue.length} requests are`} waiting for
            review
          </h2>
          <p className="mb-3 text-sm text-ink-muted">
            Nobody else can see these until you post them.
          </p>
          <ul className="space-y-3">
            {queue.map((request) => (
              <li key={request.id} className="rounded-md border border-line bg-surface p-3">
                <RequestBody request={request} />
                <div className="mt-3 flex flex-col gap-2 sm:flex-row">
                  <Button
                    disabled={decide.isPending}
                    onClick={() => decide.mutate({ id: request.id, decision: "approve" })}
                  >
                    Post it
                  </Button>
                  <Button
                    variant="danger"
                    disabled={decide.isPending}
                    onClick={() => decide.mutate({ id: request.id, decision: "reject" })}
                  >
                    Decline
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      {mine.length > 0 && (
        <section className="mb-8">
          <h2 className="mb-3 font-bold text-ink">Yours, not yet posted</h2>
          <ul className="space-y-3">
            {mine.map((request) => (
              <RequestCard
                key={request.id}
                request={request}
                now={now}
                onDelete={() => setConfirmDelete(request)}
              />
            ))}
          </ul>
        </section>
      )}

      {feedQuery.isPending ? (
        <Spinner label="Loading prayer requests" />
      ) : posted.length === 0 ? (
        <EmptyState title="No prayer requests this month">
          {!canPost
            ? "Nothing has been posted in the last month."
            : canApprovePrayerRequests
              ? "Ask for prayers and it goes straight up for the parish to see."
              : "Ask for prayers and a reviewer will post it for the parish to see."}
        </EmptyState>
      ) : (
        <>
          {mine.length > 0 && <h2 className="mb-3 font-bold text-ink">From the parish</h2>}
          <ul className="space-y-3">
            {posted.map((request) => (
              <RequestCard
                key={request.id}
                request={request}
                now={now}
                onDelete={() => setConfirmDelete(request)}
              />
            ))}
          </ul>
        </>
      )}

      {composing && (
        <ComposeModal
          postsDirectly={canApprovePrayerRequests}
          onClose={() => setComposing(false)}
          onPosted={async () => {
            setComposing(false);
            await refresh();
          }}
        />
      )}

      {confirmDelete && (
        <ConfirmDialog
          title="Remove this prayer request?"
          confirmLabel="Remove it"
          busy={remove.isPending}
          onConfirm={() => remove.mutate(confirmDelete.id)}
          onClose={() => setConfirmDelete(null)}
        >
          <p>
            “{confirmDelete.title}” and any photos attached to it will be deleted for good. This
            cannot be undone.
          </p>
        </ConfirmDialog>
      )}
    </>
  );
}

/**
 * Refresh, and how stale the list is.
 *
 * The button exists because nothing polls: a member without notifications
 * enabled has no other way to pull in what has been posted since they opened
 * the page. The timestamp beside it exists because the button alone implies the
 * data *might* be old without saying whether that means three seconds or three
 * hours.
 *
 * Icon-only, inline SVG, on the same footing as MenuButton -- the app ships no
 * icon package. `aria-label` because there is no text to read.
 */
function RefreshButton({
  busy,
  updatedAt,
  now,
  onRefresh,
}: {
  busy: boolean;
  /** `dataUpdatedAt`; 0 before the first fetch lands. */
  updatedAt: number;
  now: Date;
  onRefresh: () => void;
}) {
  return (
    <span className="flex items-center gap-2">
      {updatedAt > 0 && (
        // Rendered once, so it ages while the page sits open. The focus
        // refetch re-renders it on return, which is when anyone looks.
        // The `·` separator rather than "Updated <label>", because
        // formatPostedAt capitalises its relative labels and falls back to a
        // date -- lowercasing it would turn "4 May" into "4 may".
        <span className="text-sm text-ink-muted">
          Updated · {formatPostedAt(new Date(updatedAt).toISOString(), now)}
        </span>
      )}
      <button
        type="button"
        aria-label="Refresh"
        onClick={onRefresh}
        // Disabled while in flight, so a double tap cannot queue two rounds.
        disabled={busy}
        className="tap-target inline-flex items-center justify-center rounded-md text-ink-muted transition hover:bg-surface-muted hover:text-primary disabled:cursor-not-allowed disabled:opacity-60"
      >
        <svg
          aria-hidden="true"
          viewBox="0 0 20 20"
          className={`h-5 w-5 fill-current ${busy ? "animate-spin" : ""}`}
        >
          {/*
            A circular arrow. The ring is *stroked*, not filled: a filled arc
            path closes across its own chord and renders as a blob rather than a
            ring. It runs from 0 degrees the long way round to -45, leaving the
            gap at the top right for the head.
          */}
          <path
            d="M16 10a6 6 0 1 1-1.76-4.24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
          />
          {/*
            The head, declared pointing straight down about the origin and then
            rotated onto the arc's tangent -- the same trick as the gear's teeth
            in SettingsLink, so the geometry is arithmetic rather than a
            hand-fitted path. Transforms apply right to left: rotate, then move
            to the arc's end at (14.24, 5.76).
          */}
          <path d="M-2.2 0h4.4l-2.2 3.2z" transform="translate(14.24 5.76) rotate(-45)" />
        </svg>
      </button>
    </span>
  );
}

/** The status of one of the caller's own requests. Posted rows need no badge. */
function StatusBadge({ request }: { request: PrayerRequestDto }) {
  if (request.status === "PENDING") return <Badge tone="accent">Waiting for review</Badge>;
  if (request.status === "REJECTED") return <Badge tone="primary">Not posted</Badge>;
  return null;
}

function RequestBody({ request }: { request: PrayerRequestDto }) {
  return (
    <>
      <p className="font-bold text-ink">{request.title}</p>
      <p className="text-sm text-ink-muted">{request.authorName}</p>
      {/* whitespace-pre-line so the paragraph breaks someone typed survive. */}
      <p className="mt-2 whitespace-pre-line text-ink">{request.body}</p>
      <ImageStrip images={request.images} title={request.title} />
    </>
  );
}

function RequestCard({
  request,
  now,
  onDelete,
}: {
  request: PrayerRequestDto;
  now: Date;
  onDelete: () => void;
}) {
  return (
    <li className="rounded-lg border border-line bg-surface p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <p className="min-w-0 truncate font-bold text-ink">{request.title}</p>
            <StatusBadge request={request} />
          </div>
          <p className="text-sm text-ink-muted">
            {request.authorName}
            {request.postedAt && ` · ${formatPostedAt(request.postedAt, now)}`}
          </p>
        </div>
        {/* No menu at all rather than an empty one, as on the accounts page. */}
        {request.canDelete && (
          <MenuButton label={`Actions for ${request.title}`}>
            <MenuItem danger onSelect={onDelete}>
              Remove
            </MenuItem>
          </MenuButton>
        )}
      </div>

      <p className="mt-2 whitespace-pre-line text-ink">{request.body}</p>

      {request.status === "REJECTED" && request.rejectionReason && (
        <p className="mt-2 text-sm text-ink-muted">
          <span className="font-bold">Why: </span>
          {request.rejectionReason}
        </p>
      )}

      <ImageStrip images={request.images} title={request.title} />
    </li>
  );
}

/**
 * The attachments, as a row of tiles that open full size.
 *
 * Fixed-height tiles with `object-cover`, so four photos of four different
 * shapes still make one tidy strip; the lightbox is where the whole frame is
 * shown. `width`/`height` are set on the img so the row does not reflow as the
 * thumbnails arrive.
 */
function ImageStrip({ images, title }: { images: PrayerRequestImageDto[]; title: string }) {
  const [open, setOpen] = useState<PrayerRequestImageDto | null>(null);
  if (images.length === 0) return null;

  return (
    <>
      <ul className="mt-3 flex flex-wrap gap-2">
        {images.map((image, index) => (
          <li key={image.id}>
            {/*
              The button carries the label and the image is decorative: a
              thumbnail inside a control that opens it has nothing of its own to
              describe, and alt text here would be announced twice.
            */}
            <button
              type="button"
              aria-label={`View photo ${index + 1} of ${images.length} for ${title}`}
              className="block overflow-hidden rounded-md border border-line"
              onClick={() => setOpen(image)}
            >
              <img
                src={image.thumbUrl ?? undefined}
                alt=""
                width={image.width ?? undefined}
                height={image.height ?? undefined}
                className="h-24 w-24 object-cover sm:h-28 sm:w-28"
                loading="lazy"
              />
            </button>
          </li>
        ))}
      </ul>
      {open?.fullUrl && (
        <PhotoLightbox src={open.fullUrl} alt={title} onClose={() => setOpen(null)} />
      )}
    </>
  );
}

/**
 * The compose form.
 *
 * Validated with the API's own schema before the round trip, then the server's
 * `issues[]` mapped the same way -- the convention PersonForm established, so a
 * rule only one side knows about still lands on the right field.
 */
function ComposeModal({
  postsDirectly,
  onClose,
  onPosted,
}: {
  /** Whether the caller may post without review, which changes what to promise. */
  postsDirectly: boolean;
  onClose: () => void;
  onPosted: () => Promise<void>;
}) {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const picker = useAttachmentPicker();

  async function submit(): Promise<void> {
    setError(null);
    setFieldErrors({});

    const parsed = prayerRequestCreateSchema.safeParse({ title, body, images: picker.images });
    if (!parsed.success) {
      const errors: Record<string, string> = {};
      for (const issue of parsed.error.issues) {
        const key = String(issue.path[0] ?? "");
        if (key && !errors[key]) errors[key] = issue.message;
      }
      setFieldErrors(errors);
      return;
    }

    setSaving(true);
    try {
      await api("/prayer-requests", { method: "POST", body: parsed.data });
      await onPosted();
    } catch (err) {
      if (err instanceof ApiError && err.issues?.length) {
        setFieldErrors(
          Object.fromEntries(err.issues.map((issue) => [issue.path.split(".")[0]!, issue.message]))
        );
      }
      setError(err instanceof Error ? err.message : "Could not post that request");
    } finally {
      setSaving(false);
    }
  }

  const busy = saving || picker.busy;

  return (
    <Modal title="Ask for prayers" onClose={onClose}>
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <Field label="Title" error={fieldErrors.title}>
          <input
            className={inputClass}
            value={title}
            maxLength={PRAYER_REQUEST_TITLE_MAX}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="For my mother"
            required
          />
        </Field>

        <Field
          label="What would you like prayed for?"
          error={fieldErrors.body}
          hint={
            postsDirectly
              ? "This goes up straight away, and everyone in the parish will be notified."
              : "A reviewer reads this before it is posted, so nobody else sees it yet."
          }
        >
          <textarea
            className={`${inputClass} min-h-32`}
            value={body}
            maxLength={PRAYER_REQUEST_BODY_MAX}
            onChange={(event) => setBody(event.target.value)}
            required
          />
        </Field>

        <div>
          <p className="mb-1 font-bold text-ink">Photos</p>
          {picker.images.length > 0 && (
            <ul className="mb-2 flex flex-wrap gap-2">
              {picker.images.map((image, index) => (
                <li key={image.photoKey} className="relative">
                  <img
                    src={`/${image.photoKey}thumb`}
                    alt={`Attachment ${index + 1}`}
                    className="h-20 w-20 rounded-md border border-line object-cover"
                  />
                  <button
                    type="button"
                    aria-label={`Remove attachment ${index + 1}`}
                    onClick={() => picker.remove(image.photoKey)}
                    className="absolute -right-2 -top-2 flex h-6 w-6 items-center justify-center rounded-full border border-line bg-surface text-lg leading-none text-ink-muted shadow-sm hover:text-primary"
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
          )}
          <Button variant="secondary" onClick={picker.open} disabled={picker.busy || picker.full}>
            {picker.busy
              ? "Adding…"
              : picker.full
                ? `${PRAYER_REQUEST_MAX_IMAGES} photos is the limit`
                : "Add photos"}
          </Button>
          {picker.error && (
            <p role="alert" className="mt-1 text-sm font-bold text-primary">
              {picker.error}
            </p>
          )}
          {picker.elements}
        </div>

        {error && (
          <p role="alert" className="font-bold text-primary">
            {error}
          </p>
        )}

        <div className="flex flex-col gap-2 sm:flex-row">
          <Button type="submit" disabled={busy || title.trim() === "" || body.trim() === ""}>
            {saving ? "Posting…" : postsDirectly ? "Post it" : "Send for review"}
          </Button>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
        </div>
      </form>
    </Modal>
  );
}

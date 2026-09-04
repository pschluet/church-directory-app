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

  const feedQuery = useQuery({
    queryKey: qk.prayerRequests(organizationId),
    queryFn: ({ signal }) => api<Feed>("/prayer-requests", { signal }),
  });

  const queueQuery = useQuery({
    queryKey: qk.pendingPrayerRequests(organizationId),
    queryFn: ({ signal }) => api<Feed>("/prayer-requests/pending", { signal }),
    enabled: canApprovePrayerRequests,
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

  const decide = useMutation({
    mutationFn: ({ id, decision }: { id: string; decision: "approve" | "reject" }) =>
      api(`/prayer-requests/${id}/${decision}`, { method: "POST" }),
    onSuccess: refresh,
    onError: (err) =>
      setActionError(err instanceof Error ? err.message : "Could not record that decision"),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api(`/prayer-requests/${id}`, { method: "DELETE" }),
    onSuccess: async () => {
      setConfirmDelete(null);
      await refresh();
    },
    onError: (err) =>
      setActionError(err instanceof Error ? err.message : "Could not remove that request"),
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

  return (
    <>
      <PageHeading
        title="Prayer Requests"
        subtitle={`${posted.length} ${posted.length === 1 ? "request" : "requests"} from the last month`}
        actions={canPost && <Button onClick={() => setComposing(true)}>Ask for prayers</Button>}
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

function RequestCard({ request, onDelete }: { request: PrayerRequestDto; onDelete: () => void }) {
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
            {request.postedAt && ` · ${formatPostedAt(request.postedAt)}`}
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

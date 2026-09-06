import type { Caller } from "../auth";
import { type Queryable, one } from "../db";
import { photoUrls } from "../photos";
import { fullName, type PrayerRequestDto, type PrayerRequestStatus } from "../types";

/**
 * Reading prayer requests, and deciding who may see which of them.
 *
 * The visibility rule is the whole feature. A request is written *about*
 * somebody -- someone ill, someone travelling, someone who has died -- so
 * nobody but its author sees it until a reviewer has approved it. Three
 * audiences, one table:
 *
 *   everyone   approved requests posted within the last month
 *   the author their own requests, whatever their status
 *   reviewers  the pending queue, so there is something to review
 *
 * The month is applied in SQL rather than in the SPA, so the rows genuinely do
 * not leave the database. `posted_at` is what it is measured against and what
 * the page is ordered by -- see V8__prayer_requests.sql for why that is not the
 * same as the submitted time.
 */

/**
 * The visible window, as a Postgres interval literal.
 *
 * "The last month" and not "the last 30 days": a request posted on the 31st of
 * January should drop off at the end of February, which is what `1 month`
 * means and what someone reading the page would expect.
 */
export const PRAYER_REQUEST_WINDOW = "1 month";

export interface PrayerRequestRow {
  id: string;
  organization_id: string;
  author_person_id: string;
  author_first_name: string;
  author_last_name: string | null;
  /** Null when the decider's record has since been deleted; see V8. */
  decided_by_first_name: string | null;
  decided_by_last_name: string | null;
  title: string;
  body: string;
  status: PrayerRequestStatus;
  submitted_at: Date | string;
  posted_at: Date | string | null;
  decided_at: Date | string | null;
  rejection_reason: string | null;
  images: PrayerRequestImageRow[] | null;
}

interface PrayerRequestImageRow {
  id: string;
  photo_key: string;
  width: number | null;
  height: number | null;
}

/**
 * Joins `persons_resolved` rather than `persons` for the author, so a member
 * who inherits the family surname is not credited with a blank last name. The
 * reviewer who decided it is joined the same way, but with a LEFT join:
 * `decided_by_person_id` is `on delete set null` (see V8), so losing that
 * account must leave the decision standing rather than the row unreadable.
 *
 * The images arrive as one aggregated JSON column rather than as extra rows.
 * The alternative -- a plain join -- multiplies every request by its
 * attachments and leaves the caller to stitch them back together, which for a
 * list endpoint means either doing that by hand or issuing a second query per
 * row. `order by position` inside the aggregate is what preserves the order the
 * author chose.
 */
export const PRAYER_REQUEST_SELECT = `
  select pr.id,
         pr.organization_id,
         pr.author_person_id,
         a.first_name as author_first_name,
         a.last_name  as author_last_name,
         d.first_name as decided_by_first_name,
         d.last_name  as decided_by_last_name,
         pr.title,
         pr.body,
         pr.status,
         pr.submitted_at,
         pr.posted_at,
         pr.decided_at,
         pr.rejection_reason,
         (
           select coalesce(
                    json_agg(
                      json_build_object(
                        'id', i.id,
                        'photo_key', i.photo_key,
                        'width', i.width,
                        'height', i.height
                      )
                      order by i.position
                    ),
                    '[]'::json
                  )
             from prayer_request_images i
            where i.prayer_request_id = pr.id
         ) as images
    from prayer_requests pr
    join persons_resolved a on a.id = pr.author_person_id
    left join persons_resolved d on d.id = pr.decided_by_person_id
`;

/** A reviewer may decide anything still pending in the parish they are acting in. */
export function canDecidePrayerRequest(
  caller: Caller,
  row: Pick<PrayerRequestRow, "organization_id" | "status">
): boolean {
  if (row.organization_id !== caller.organizationId) return false;
  if (row.status !== "PENDING") return false;
  return caller.canApprovePrayerRequests;
}

/**
 * The author may withdraw their own request at any point in its life, and an
 * admin may remove any of them. A reviewer's power stops at deciding: rejecting
 * a request leaves the author able to see why and to delete it themselves,
 * which is a different thing from the request vanishing.
 */
export function canDeletePrayerRequest(
  caller: Caller,
  row: Pick<PrayerRequestRow, "organization_id" | "author_person_id">
): boolean {
  if (row.organization_id !== caller.organizationId) return false;
  if (caller.isAdmin) return true;
  return caller.personId !== null && caller.personId === row.author_person_id;
}

export function toPrayerRequest(row: PrayerRequestRow, caller: Caller): PrayerRequestDto {
  const isMine = caller.personId !== null && caller.personId === row.author_person_id;
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    status: row.status,
    authorPersonId: row.author_person_id,
    authorName: fullName({
      firstName: row.author_first_name,
      lastName: row.author_last_name,
    }),
    submittedAt: new Date(row.submitted_at).toISOString(),
    postedAt: row.posted_at ? new Date(row.posted_at).toISOString() : null,
    decidedAt: row.decided_at ? new Date(row.decided_at).toISOString() : null,
    // The author, so they know why theirs was declined, and reviewers, who
    // wrote the note and get it back on the response to their own decision.
    // Not the parish -- though a rejected request is never in anyone else's
    // list anyway, so this is a second lock on a door that is already shut.
    rejectionReason: isMine || caller.canApprovePrayerRequests ? row.rejection_reason : null,
    // Gated identically, and for a reason that is not belt-and-braces here: an
    // *approved* request is in everybody's list, so sending this ungated would
    // tell the whole parish which reviewer posted each one. Who decided is the
    // author's business and the reviewers' own.
    decidedByName:
      (isMine || caller.canApprovePrayerRequests) && row.decided_by_first_name !== null
        ? fullName({
            firstName: row.decided_by_first_name,
            lastName: row.decided_by_last_name,
          })
        : null,
    images: (row.images ?? []).map((image) => {
      const { thumbUrl, fullUrl } = photoUrls(image.photo_key);
      return { id: image.id, thumbUrl, fullUrl, width: image.width, height: image.height };
    }),
    canDecide: canDecidePrayerRequest(caller, row),
    canDelete: canDeletePrayerRequest(caller, row),
    isMine,
  };
}

/** Scoped by organization, so another parish's request 404s rather than 403s. */
export async function loadPrayerRequestRow(
  q: Queryable,
  id: string,
  organizationId: string
): Promise<PrayerRequestRow | null> {
  return one<PrayerRequestRow>(
    q,
    `${PRAYER_REQUEST_SELECT} where pr.id = $1 and pr.organization_id = $2`,
    [id, organizationId]
  );
}

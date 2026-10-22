import { type Queryable, one } from "../db";
import { groupAttachmentFileUrl, photoUrls } from "../photos";
import type { GroupAccess } from "./groups";
import {
  fullName,
  type GroupPostAttachmentDto,
  type GroupPostDto,
  type GroupPostKind,
  type GroupRsvpResponse,
} from "../types";

/**
 * Reading group posts -- the feed, a thread's replies, and a single post.
 *
 * One query shape serves all three: `GROUP_POST_SELECT` aggregates each post's
 * attachments and mentions as JSON, the same way `PRAYER_REQUEST_SELECT`
 * aggregates its images, so a list of N posts costs one query rather than N+1.
 * RSVP counts and the caller's own RSVP are scalar subqueries for the same
 * reason -- cheap, and only ever relevant for an EVENT-kind post.
 *
 * `$1` is always the caller's own `app_user_id`, bound first in every query
 * that uses this SELECT, so "my RSVP" can be resolved without a second round
 * trip and without every other caller's `$N` numbering having to shift around
 * it.
 */
export const GROUP_POST_SELECT = `
  select p.id,
         p.group_id,
         p.author_person_id,
         a.first_name as author_first_name,
         a.last_name as author_last_name,
         a.photo_key as author_photo_key,
         p.parent_post_id,
         p.kind,
         p.body,
         p.mentions_everyone,
         p.edited_at,
         p.deleted_at,
         (p.deleted_by_person_id = p.author_person_id) as deleted_by_self,
         p.created_at,
         ge.title as event_title,
         ge.description as event_description,
         ge.event_date,
         ge.start_time,
         ge.end_time,
         ge.location as event_location,
         (select count(*)::int from group_posts r where r.parent_post_id = p.id) as reply_count,
         (select max(r.created_at) from group_posts r where r.parent_post_id = p.id) as last_reply_at,
         (
           select coalesce(
                    json_agg(
                      json_build_object(
                        'id', att.id,
                        'kind', att.kind,
                        'filename', att.filename,
                        'contentType', att.content_type,
                        'byteSize', att.byte_size,
                        'photoKey', att.photo_key,
                        'width', att.width,
                        'height', att.height
                      )
                      order by att.position
                    ),
                    '[]'::json
                  )
             from group_post_attachments att
            where att.post_id = p.id
         ) as attachments,
         (
           select coalesce(
                    json_agg(
                      json_build_object(
                        'appUserId', m.app_user_id,
                        'personId', mp.id,
                        'firstName', mp.first_name,
                        'lastName', mp.last_name
                      )
                    ),
                    '[]'::json
                  )
             from group_post_mentions m
             join persons_resolved mp on mp.app_user_id = m.app_user_id
            where m.post_id = p.id
         ) as mentions,
         (
           select coalesce(
                    json_agg(
                      json_build_object('emoji', e.emoji, 'reactors', e.reactors)
                      order by e.first_at
                    ),
                    '[]'::json
                  )
             from (
               select x.emoji,
                      min(x.created_at) as first_at,
                      json_agg(
                        json_build_object(
                          'appUserId', x.app_user_id,
                          'personId', rp.id,
                          'firstName', rp.first_name,
                          'lastName', rp.last_name
                        )
                        order by x.created_at
                      ) as reactors
                 from group_post_reactions x
                 join persons_resolved rp on rp.app_user_id = x.app_user_id
                where x.post_id = p.id
                group by x.emoji
             ) e
         ) as reactions,
         (select count(*) filter (where r.response = 'YES')::int
            from group_event_rsvps r where r.post_id = p.id) as rsvp_yes,
         (select count(*) filter (where r.response = 'NO')::int
            from group_event_rsvps r where r.post_id = p.id) as rsvp_no,
         (select count(*) filter (where r.response = 'MAYBE')::int
            from group_event_rsvps r where r.post_id = p.id) as rsvp_maybe,
         (select r.response from group_event_rsvps r
           where r.post_id = p.id and r.app_user_id = $1) as my_rsvp_response,
         (select r.guest_count from group_event_rsvps r
           where r.post_id = p.id and r.app_user_id = $1) as my_rsvp_guest_count
    from group_posts p
    join persons_resolved a on a.id = p.author_person_id
    left join group_events ge on ge.post_id = p.id
`;

interface AttachmentRow {
  id: string;
  kind: "IMAGE" | "FILE";
  filename: string;
  contentType: string;
  byteSize: number;
  photoKey: string;
  width: number | null;
  height: number | null;
}

interface MentionRow {
  appUserId: string;
  personId: string;
  firstName: string;
  lastName: string | null;
}

interface ReactionRow {
  emoji: string;
  reactors: MentionRow[];
}

export interface GroupPostRow {
  id: string;
  group_id: string;
  author_person_id: string;
  author_first_name: string;
  author_last_name: string | null;
  author_photo_key: string | null;
  parent_post_id: string | null;
  kind: GroupPostKind;
  body: string | null;
  mentions_everyone: boolean;
  edited_at: Date | string | null;
  deleted_at: Date | string | null;
  deleted_by_self: boolean | null;
  created_at: Date | string;
  event_title: string | null;
  event_description: string | null;
  event_date: Date | string | null;
  start_time: string | null;
  end_time: string | null;
  event_location: string | null;
  reply_count: number;
  last_reply_at: Date | string | null;
  attachments: AttachmentRow[];
  mentions: MentionRow[];
  reactions: ReactionRow[];
  rsvp_yes: number;
  rsvp_no: number;
  rsvp_maybe: number;
  my_rsvp_response: GroupRsvpResponse | null;
  my_rsvp_guest_count: number | null;
}

function toAttachmentDto(row: AttachmentRow): GroupPostAttachmentDto {
  const isImage = row.kind === "IMAGE";
  const { thumbUrl, fullUrl } = isImage
    ? photoUrls(row.photoKey)
    : { thumbUrl: null, fullUrl: null };
  return {
    id: row.id,
    kind: row.kind,
    filename: row.filename,
    contentType: row.contentType,
    byteSize: row.byteSize,
    thumbUrl,
    fullUrl,
    width: row.width,
    height: row.height,
    downloadUrl: isImage ? null : groupAttachmentFileUrl(row.photoKey),
  };
}

/** yyyy-mm-dd, as the browser sent it -- see V16__groups.sql for why this is a naive local date. */
function toIsoDate(value: Date | string): string {
  if (typeof value === "string") return value.slice(0, 10);
  return value.toISOString().slice(0, 10);
}

/** HH:MM, trimming the seconds Postgres's `time` type returns. */
function toHm(value: string | null): string | null {
  return value ? value.slice(0, 5) : null;
}

export function toGroupPostDto(
  row: GroupPostRow,
  access: GroupAccess,
  callerPersonId: string | null
): GroupPostDto {
  const isMine = callerPersonId !== null && callerPersonId === row.author_person_id;
  const isDeleted = row.deleted_at !== null;

  return {
    id: row.id,
    groupId: row.group_id,
    authorPersonId: row.author_person_id,
    authorName: fullName({ firstName: row.author_first_name, lastName: row.author_last_name }),
    authorThumbUrl: photoUrls(row.author_photo_key).thumbUrl,
    parentPostId: row.parent_post_id,
    kind: row.kind,
    body: isDeleted ? null : row.body,
    editedAt: row.edited_at ? new Date(row.edited_at).toISOString() : null,
    deletedAt: row.deleted_at ? new Date(row.deleted_at).toISOString() : null,
    deletedBySelf: isDeleted ? row.deleted_by_self : null,
    createdAt: new Date(row.created_at).toISOString(),
    attachments: isDeleted ? [] : row.attachments.map(toAttachmentDto),
    mentions: isDeleted
      ? []
      : row.mentions.map((m) => ({
          appUserId: m.appUserId,
          personId: m.personId,
          name: fullName({ firstName: m.firstName, lastName: m.lastName }),
        })),
    mentionsEveryone: !isDeleted && row.mentions_everyone,
    // A tombstone keeps no reactions, as it keeps no attachments.
    reactions: isDeleted
      ? []
      : row.reactions.map((r) => ({
          emoji: r.emoji,
          reactedByMe:
            callerPersonId !== null && r.reactors.some((m) => m.personId === callerPersonId),
          reactors: r.reactors.map((m) => ({
            appUserId: m.appUserId,
            personId: m.personId,
            name: fullName({ firstName: m.firstName, lastName: m.lastName }),
          })),
        })),
    event:
      row.kind === "EVENT" && row.event_date !== null
        ? {
            title: row.event_title ?? "",
            description: row.event_description,
            eventDate: toIsoDate(row.event_date),
            startTime: toHm(row.start_time),
            endTime: toHm(row.end_time),
            location: row.event_location,
            rsvpCounts: { yes: row.rsvp_yes, no: row.rsvp_no, maybe: row.rsvp_maybe },
            myRsvp:
              row.my_rsvp_response !== null
                ? { response: row.my_rsvp_response, guestCount: row.my_rsvp_guest_count ?? 0 }
                : null,
          }
        : null,
    replyCount: row.reply_count,
    lastReplyAt: row.last_reply_at ? new Date(row.last_reply_at).toISOString() : null,
    canEdit: !isDeleted && isMine,
    canDelete: !isDeleted && (isMine || access.canModerate),
    canReport: !isDeleted && !isMine && access.canReadContent,
    canRestore: isDeleted && row.kind === "EVENT" && isMine && row.deleted_by_self === true,
  };
}

export async function loadGroupPostRow(
  q: Queryable,
  callerAppUserId: string,
  postId: string,
  groupId: string
): Promise<GroupPostRow | null> {
  return one<GroupPostRow>(q, `${GROUP_POST_SELECT} where p.id = $2 and p.group_id = $3`, [
    callerAppUserId,
    postId,
    groupId,
  ]);
}

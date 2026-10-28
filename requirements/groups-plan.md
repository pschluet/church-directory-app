# Groups feature — engineering plan

## Context

`requirements/groups.md` describes a Groups feature: member-created groups with three
visibility levels, threaded messaging, file attachments, event posts with RSVP, @mentions,
and per-group notification preferences. It is the largest feature added to the directory so
far and the first to need **per-resource permissions** — group admin / member is a second
axis entirely separate from the existing `ROLE_RANK` ladder.

This document is the engineering companion to `requirements/groups.md`: it carries the
schema, file paths, and implementation sequencing that the product-facing requirements doc
intentionally leaves out.

**Outcome:** a `Groups` page alongside Directory / Families / Prayer Requests.

---

## Decisions made

| Area | Decision |
|---|---|
| Notification channels | **In-app bell/badge + web push.** No email, no SMS. |
| Freshness | Bell and the groups list: SW `postMessage` → query invalidation. An **open** group polls `GET /groups/:id/live` every 2s while visible (activity stamp + who is typing, see V20); no refresh button. No WebSocket: the VPC has no NAT or interface endpoints, so pushing from the Lambda would add a new API and a paid route out. |
| Invites | **Instant add.** An invited person is a member immediately. |
| Group end-of-life | Group admin **archives** (read-only, hidden from browse). Hard delete is parish-admin only. |
| Attachments | **Images + documents.** Video deferred to a later phase. |
| Eligibility | **Only people with an `app_users` login.** Account-less `persons` are hidden from the picker. |
| Admin model | **Multiple group admins.** Creator is the first; admins can promote others. |
| Audit scope | Lifecycle, membership, and moderation. **Not** ordinary posts. |
| Conversions | Any transition **except → Public**. Adds Public→Secret and Private→Secret to the draft's two. |
| Event fields | Add **location**, **optional end time**, **RSVP Yes/Maybe/No**, **guest count (+N)**. |
| Admin reach | Full access, **disclosed in the UI** on every out-of-group view of a Private or Secret group. |
| Join requests | Private groups get **"Request to join" → group admins approve/deny**, mirroring `family_join_requests`. |
| Reporting | **Anyone who can read a post can report it**, to group admins *and* parish admins. |
| Retention | **Posts expire 5 years after creation**, purged by a scheduled job along with their attachments. |

---

## Assumptions filling the remaining gaps

These were not in the original draft and were not worth blocking on. Override any of them.

**Membership**
- Groups are org-scoped (`organization_id`), like every other entity.
- A group admin cannot leave while they are the only admin — they must promote someone first.
- Removing or losing a member leaves their past posts in place, still attributed.
- Public groups: join/leave freely; rejoining restores full history. No size cap.
- **No age gating.** `special_dates` birthdays have an optional year, so the app cannot
  reliably identify minors. If children should be excluded from groups, that needs a policy
  and a data change — flagging, not solving.

**Visibility**
- Non-members of a Private group see title, description, image, and member *count* — not the
  member list, not messages.
- On any conversion, current members are grandfathered and keep full history.

**Posts**
- Threading is exactly **one level** — replies attach to a root post, no reply-to-reply.
- Deletion is **soft** with a tombstone ("Message deleted") so replies keep their anchor.
  Attachments are purged from S3 immediately.
- Edited posts show an "edited" marker. No edit time limit.
- Plain text with linkified URLs. No markdown, no link previews.
- Keyset pagination, newest-first (`AuditLog.tsx` pattern). Prayer Requests' unpaginated
  one-month window will not survive a busy group.
- **No reactions** in v1. (Added afterwards: Slack-style emoji reactions -- see groups.md, Messaging.)
- @mentions resolve to **group members only**; duplicate names disambiguate by family name
  via `persons_resolved.search_text`. No `@everyone`.
- "Restrict who can post" = an admins-only toggle, not a per-member allowlist.

**Attachments**
- Images reuse `renderRenditions` / `useAttachmentPicker`. Documents take a new raw
  passthrough — no canvas decode, stored as one object.
- Allowlist: existing image types + PDF, docx/xlsx/pptx, txt, csv. 25MB cap (`MAX_PHOTO_BYTES`).
- Because keys are extensionless, original filename, content-type, and byte size are stored
  in the DB and used for the download `Content-Disposition`.

**Events**
- Stored as a naive local date + optional times, rendered as entered. The app has no timezone
  column, and a parish event is always in the parish's own time — do **not** round-trip UTC.
- Events tab splits Upcoming / Past.
- Editing date, time, or location after RSVPs keeps the RSVPs and notifies everyone who RSVP'd.
- Cancelling = deleting the post; the tombstone reads "Event cancelled".

**Reporting**
- Eligibility follows read access: if you can see the post, you can report it. That means a
  parish admin can report inside a secret group, which is consistent with the
  disclosed-and-audited access decision above.
- A report carries an optional free-text reason and goes to **both** the group's admins and
  parish admins — a group admin may be the problem.
- One open report per (post, reporter), enforced by a unique partial index, so the button
  can't be spammed. Re-reporting is allowed once the first is resolved.
- Resolving is either **dismiss** or **delete the post** (an existing admin power). Either way
  the report closes and the reporter is not told who acted.
- Reports survive the post being deleted, so the audit trail stays readable.

**Retention**
- `POST_RETENTION_YEARS = 5`, one constant in `api/src/types.ts`.
- Expiry is a **hard delete**, not a tombstone — the point is that the data is gone. It is
  irreversible and runs without warning anyone.
- A post expires 5 years after its own `created_at`, **but a root post is retained until its
  last reply has also expired** so threads never orphan. A thread kept alive by recent replies
  therefore survives; only the genuinely dormant is purged.
- Event posts expire 5 years after `greatest(created_at, event_date)` — a far-future event
  must not vanish before it happens.
- Attachments are deleted from S3 in the same pass via `deletePhoto`. Lifecycle rules on the
  bucket won't work: the keys don't encode a date and the DB is the source of truth.
- Reports, mentions, and RSVPs cascade with their post.

**Notifications**
- Per-group preference: **All posts** (default) / Mentions only / None.
- Push bodies are **counts only** ("3 new messages in Youth Group") — never message content.
  A secret group's text must not appear on a lock screen.
- One `tag` per group so a group replaces its own notification, never Prayer Requests'.

---

## Open items worth a product call before/while coding

1. **Attachment authorization is weaker than message authorization.** `photo-cookies.ts`
   issues CloudFront signed cookies scoped to `/photos/{orgId}/*`. Any member of the parish
   who has the URL can fetch a secret group's attachment, even though they cannot read the
   message it came from. The ULID in the key makes it unguessable, but that is obscurity, not
   authorization. Options: accept it (consistent with how family photos already work), or
   route group attachments through an authorizing Lambda endpoint instead of CloudFront.
   **Recommend accepting for v1 and noting it**, since the same exposure already exists for
   every photo in the app.
2. **The 5-year purge is silent and irreversible.** Nobody is warned, and there is no export.
   If a parish ever needs records for a dispute, they're gone. Cheap mitigations if wanted:
   say so in the group-creation copy, or have the job write a monthly summary row to the
   audit log (planned below) so at least the *fact* of deletion is on record.

---

## Implementation

### Migration — `db/migrations/V16__groups.sql`

Match the existing migrations' heavy-comment style: justify every constraint and index.

- `groups` — `id`, `organization_id`, `title`, `description` (the photo columns were dropped in V32),
  `visibility` (CHECK `PUBLIC|PRIVATE|SECRET`), `posting_restricted`, `invites_restricted`,
  `replies_restricted`, `archived_at`, `created_by_person_id`, timestamps.
- `group_members` — PK `(group_id, app_user_id)`, `person_id`, `role` (CHECK `ADMIN|MEMBER`),
  `notification_pref` (CHECK `ALL|MENTIONS|NONE`), `last_read_at`, `joined_at`. `last_read_at`
  is what drives the per-group unread badge.
- `group_join_requests` — copy `family_join_requests` verbatim in shape, including the unique
  partial index for one PENDING per (group, person).
- `group_posts` — `group_id`, `author_person_id`, `parent_post_id` (self-FK, null = root),
  `kind` (CHECK `MESSAGE|EVENT`), `body`, `edited_at`, `deleted_at`, `deleted_by_person_id`.
  CHECK that a reply's parent is itself a root (enforces one-level threading).
- `group_post_attachments` — `post_id`, `photo_key`, `kind` (CHECK `IMAGE|FILE`), `filename`,
  `content_type`, `byte_size`, `width`/`height` (nullable together), `position`.
- `group_events` — PK `post_id`, `title`, `description`, `event_date`, `start_time`,
  `end_time`, `location`. CHECK `end_time` requires `start_time`.
- `group_event_rsvps` — PK `(post_id, app_user_id)`, `response` (CHECK `YES|NO|MAYBE`),
  `guest_count`, `updated_at`.
- `group_post_mentions` — PK `(post_id, app_user_id)`; drives mention notifications.
- `group_post_reactions` — PK `(post_id, app_user_id, emoji)` (V22); one row per person per emoji
  per post. Insert and delete both bump `groups.activity_at` so an open page's poll picks them up.
- `group_post_reports` — `post_id`, `group_id`, `reporter_app_user_id`, `reporter_person_id`,
  `reason`, `status` (CHECK `PENDING|RESOLVED|DISMISSED`), `created_at`, `decided_at`,
  `decided_by_person_id`. Unique partial index for one PENDING per (post, reporter), same
  shape as `family_join_requests`. `post_id` is `on delete set null` with the group and a
  denormalised post excerpt retained, so resolving by deletion doesn't erase the report.
- **Alter `notifications`**: add `group_id`, `group_post_id`; drop and recreate
  `notifications_type_valid` and `notifications_prayer_request_present` — follow V11's exact
  drop/recreate pattern. New types: `GROUP_POST`, `GROUP_MENTION`, `GROUP_JOIN_REQUEST`,
  `GROUP_EVENT`, `GROUP_POST_REPORT`.

Index `group_posts (group_id, created_at)` serves both the feed's keyset pagination and the
retention scan.

`persons_resolved` needs no change — no new `persons` columns.

### Shared types — `api/src/types.ts`

Add enums mirroring every CHECK, Zod schemas for each payload, and the DTOs. Extend
`AUDIT_ENTITY_TYPES` + labels with `group` and `groupPost`; extend `AUDIT_ACTIONS` + labels
with `group.create`, `group.update`, `group.convertVisibility`, `group.archive`,
`group.delete`, `group.addMember`, `group.removeMember`, `group.leave`, `group.promoteAdmin`,
`group.demoteAdmin`, `group.approveJoinRequest`, `group.denyJoinRequest`,
`group.post.adminDelete`, `group.post.report`, `group.post.resolveReport`,
`group.post.dismissReport`, `group.post.expire`.
**`api/test/audit-actions.test.ts` fails if any call-site action string is missing here.**
Also add `POST_RETENTION_YEARS = 5`.

### API

- `api/src/services/groups.ts` — visibility/permission predicates. The central one is
  `groupAccess(q, caller, groupId) → { isMember, groupRole, canRead, canPost, canReply,
  canInvite, canModerate }`. Every route reads this; no route re-derives rules.
  Add `assertCanModerateGroup` etc. to `api/src/services/access.ts` to keep the convention.
- `api/src/services/group-notifications.ts` — `fanOutGroupPost` / `fanOutGroupMention`,
  returning the inserted `app_user_id`s so push and durable rows agree by construction
  (same contract as `fanOutPrayerRequest`). Preferences come from
  `group_members.notification_pref`, not `notification_preferences`.
- `api/src/routes/groups.ts` — one file, mounted with `app.route("/groups", groups)` in
  `api/src/api.ts`. Covers list/create/update/convert/archive/delete, members,
  invites, join requests, posts, replies, attachments, events, RSVPs,
  `POST /groups/:id/read`, `POST /groups/:id/posts/:postId/report`, and
  `GET|POST /groups/:id/reports` for the moderation queue. A parish-wide
  `GET /groups/reports` lists open reports across every group for `requireRole("ADMIN")`.
- `api/src/services/group-retention.ts` — `expireGroupPosts(db, { now })`, pure and
  parameterised on `now` so tests can backdate instead of waiting five years. Deletes in one
  transaction per org, collects the attachment keys first, then calls `deletePhoto` after the
  commit (same ordering rationale as push: a rollback can't un-delete an S3 object, and
  holding a connection across S3 calls is worse). Writes one `group.post.expire` audit row
  per org with `{ posts, attachments, bytes }` in `changes` and a null actor.
- Push fan-out runs **after the transaction commits, awaited, failure-swallowing** — copy
  `pushToNotified` from `api/src/routes/prayer-requests.ts`.
- `api/src/routes/uploads.ts` — add `POST /uploads/group-attachment`. Scope the key to
  `caller.personId` (like prayer-request images) so uploads can precede the post row.
- `api/src/photos.ts` — add a `group-post` owner kind and a non-image passthrough that skips
  rendition generation.
- `api/src/routes/audit.ts` — add `group` / `groupPost` branches to the `TARGET_LABEL` CASE.
- `api/src/services/audit-references.ts` — add a `groups` branch to the union query and a
  `TYPE_RANK` entry.

### Infra — `infra/lib/church-directory-stack.ts`

Mirror the existing **EventBridge daily geocode refresh** rule for the retention purge; run it
daily so each pass is small. Reuse that rule's invocation mechanism exactly rather than
inventing a second one. Give the Lambda `s3:DeleteObject` on the photos bucket if the geocode
path doesn't already carry it, and assert the new rule in
`infra/test/church-directory-stack.test.ts`.

### App

- `app/src/pages/Groups.tsx` — browse/create. Card grid; reuse the Families card layout.
  Secret groups appear only for members. Unread badge per card.
- `app/src/pages/GroupDetail.tsx` — Messages / Files / Events tabs. Title tap opens the
  members modal (searchable list, description, admins, admin settings).
- Components: `GroupPost`, `GroupReplyThread`, `GroupComposer` (reuse
  `useAttachmentPicker`), `EventComposer`, `RsvpControl`, `MentionPicker`, `GroupMembersModal`,
  `GroupAdminSettings`, `ReportPostModal`, `ReportQueue`. Group image uses `usePhotoPicker`
  with a free-form crop.
- Reporting UI: a "Report" item in each post's overflow menu, hidden on your own posts. Open
  reports surface as a banner at the top of the group — copy the reviewer-queue banner in
  `PrayerRequests.tsx:216` ("N posts are waiting for review") — shown to group admins and
  parish admins. Parish-wide open reports also get a banner on `/groups`.
- `app/src/lib/queryKeys.ts` — nest so one prefix sweeps a group's subtree:
  `groups(orgId)` → `group(orgId, id)` → `groupPosts` / `groupFiles` / `groupEvents`.
- `app/src/components/useRealtimeRefresh.ts` — **keep the single bare
  `"prayer-requests-changed"` signal** and add a groups-subtree invalidation beside the
  existing two. The service worker has no auth context and must not carry group identity in
  the payload; with `refetchType: "active"` the extra invalidation costs at most one fetch.
- `app/src/pages/GroupDetail.tsx` and `Groups.tsx` set `refetchOnWindowFocus: true`
  per-query (global default is off) and get a `RefreshButton` with the `dataUpdatedAt` +
  `useNow()` "Updated · N ago" label, copied from `PrayerRequests.tsx:342`.
- `app/src/App.tsx` — `/groups` and `/groups/:id`. `app/src/components/AppShell.tsx` —
  add to `NAV_ITEMS` with an unread badge. **All forward links must come from
  `app/src/components/nav.tsx`** or the back view-transition breaks.
- `app/src/pages/Settings.tsx` — a global groups notification switch above the per-group ones.

### Tests

- `api/test/helpers/testDb.ts` — add every new table to `TABLES` **in FK-safe order**.
- `api/test/api.groups.test.ts` — the visibility matrix is the heart of it: for each of
  {public, private, secret} × {non-member, member, group admin, parish admin, super admin},
  assert list / read / post / invite / moderate. Plus conversion legality, admin succession,
  soft-delete tombstones, one-level threading, and mention fan-out.
- `api/test/api.authz.test.ts` — extend with group routes.
- `api/test/group-retention.test.ts` — insert backdated rows via the `now` parameter and
  assert: a 6-year-old thread goes; a 6-year-old root with a 1-year-old reply **stays**; a
  far-future event created 6 years ago stays; attachment keys are handed to `deletePhoto`
  (`PHOTO_STORAGE=local` makes this observable); one audit row per org with correct counts.
- `app/test/Groups.test.tsx`, `app/test/GroupDetail.test.tsx` via `renderWithProviders`,
  including the report flow and the moderation banner's role gating.

### Suggested order

0. Write `requirements/groups.md` and `requirements/groups-plan.md` (this document).
1. Migration + types + `services/groups.ts` + read-only list/detail routes & tests.
2. Membership: invite, join, leave, remove, promote, join requests.
3. Messages + replies + soft delete + pagination.
4. Attachments (images first, then the document passthrough).
5. Events + RSVP.
6. Mentions, notifications, push, unread badges.
7. Reporting + moderation queue.
8. Audit wiring, admin-view disclosure, archive/delete.
9. Retention job + EventBridge rule.
10. Reconcile both requirements files against what actually shipped.

---

## Verification

- `npm test` at the root (API suite needs Postgres up via `docker compose`; it skips offline).
- `npm run typecheck -w api` type-checks both tsconfigs; Biome for lint/format.
- Manually, against a local stack with `PHOTO_STORAGE=local` and `PUSH_MODE=local`: create one
  group of each visibility with two accounts in different roles, and walk the matrix —
  confirm a non-member cannot see a secret group in the list *or* by direct URL, and that a
  private group's messages 403 while its metadata loads.
- Freshness: open two browser profiles on the same group, post from one, confirm the other
  updates within a couple of seconds, and shows "is typing…" while the other types.
- Audit: confirm group actions land in `/audit-log` with group titles resolved, and that ordinary
  posts do **not** appear.
- Reporting: report a post as a plain member, confirm the banner appears for the group admin
  *and* the parish admin but not for other members, that deleting the post closes the report
  without erasing it, and that the reporter cannot file a second open report on the same post.
- Retention: run `expireGroupPosts` manually against a seeded local DB with a backdated `now`
  rather than waiting on the schedule, and confirm the local photo directory shrinks.

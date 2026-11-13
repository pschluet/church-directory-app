import { createHash, randomBytes } from "node:crypto";
import { HTTPException } from "hono/http-exception";
import { one, type Queryable } from "../db";
import {
  fullName,
  type GroupSignupDto,
  type GroupSignupFields,
  type PublicSignupSlotDto,
  type SignupNoteMode,
  type SignupSlotDto,
  type SignupTemplate,
} from "../types";

/**
 * Sign-ups (see V39__group_signups.sql): a list of slots people put entries in.
 *
 * The rules that span rows live here, shared by the members' routes
 * (routes/groups.ts) and the public share page (routes/public.ts):
 *
 *   * capacity -- the sum of a slot's entry quantities never exceeds it. Every
 *     write locks the slot row first, so two people taking the last spot at
 *     once cannot both succeed;
 *   * write-ins -- a signer's own item is a new slot owned by their entry,
 *     capped at `write_in_max`, and removed with the entry;
 *   * closing -- nothing is taken once the sign-up's `closes_on` (or a slot's
 *     own date) is over, judged as generously as an event's "past": only once
 *     the day has ended in UTC-12.
 */

/** "Today is over everywhere" -- the same generous rule as an event's is_past. */
const PAST = "(now() at time zone 'UTC' - interval '12 hours')::date";

/**
 * Every slot of a sign-up, its entries inside, as one JSON array -- so a feed of
 * N posts costs no extra queries, like a poll's options. `postIdExpr` is the
 * SQL expression for the post id in the enclosing query.
 */
export function signupSlotsSubselect(postIdExpr: string): string {
  return `(
    select coalesce(
             json_agg(
               json_build_object(
                 'id', s.id,
                 'date', s.slot_date,
                 'label', s.label,
                 'capacity', s.capacity,
                 'isWriteIn', s.is_write_in,
                 'past', coalesce(s.slot_date < ${PAST}, false),
                 'entries', (
                   select coalesce(
                            json_agg(
                              json_build_object(
                                'id', e.id,
                                'appUserId', e.app_user_id,
                                'personId', ep.id,
                                'firstName', coalesce(ep.first_name, e.first_name),
                                'lastName', coalesce(ep.last_name, e.last_name),
                                'email', e.email,
                                'quantity', e.quantity,
                                'note', e.note
                              )
                              order by e.created_at
                            ),
                            '[]'::json
                          )
                     from group_signup_entries e
                     left join persons_resolved ep on ep.app_user_id = e.app_user_id
                    where e.slot_id = s.id
                 )
               )
               order by s.is_write_in, s.position, s.created_at
             ),
             '[]'::json
           )
      from group_signup_slots s
     where s.post_id = ${postIdExpr}
  )`;
}

/** The sign-up's own columns, for GROUP_POST_SELECT. `gsu` is group_signups. */
export const SIGNUP_COLUMNS = `
         gsu.title as signup_title,
         gsu.description as signup_description,
         gsu.template as signup_template,
         gsu.recipient_person_id as signup_recipient_person_id,
         (select rp.first_name from persons_resolved rp where rp.id = gsu.recipient_person_id)
           as signup_recipient_first_name,
         (select rp.last_name from persons_resolved rp where rp.id = gsu.recipient_person_id)
           as signup_recipient_last_name,
         gsu.important_info as signup_important_info,
         gsu.note_mode as signup_note_mode,
         gsu.note_prompt as signup_note_prompt,
         gsu.write_ins_enabled as signup_write_ins_enabled,
         gsu.write_in_max as signup_write_in_max,
         gsu.public_enabled as signup_public_enabled,
         gsu.share_token as signup_share_token,
         gsu.closes_on as signup_closes_on,
         coalesce(gsu.closes_on < ${PAST}, false) as signup_past_close,
         ${signupSlotsSubselect("gsu.post_id")} as signup_slots`;

export interface SignupEntryRow {
  id: string;
  appUserId: string | null;
  personId: string | null;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  quantity: number;
  note: string | null;
}

export interface SignupSlotRow {
  id: string;
  date: string | null;
  label: string | null;
  capacity: number | null;
  isWriteIn: boolean;
  past: boolean;
  entries: SignupEntryRow[];
}

/** The SIGNUP_COLUMNS half of a GroupPostRow. */
export interface SignupColumnsRow {
  signup_title: string | null;
  signup_description: string | null;
  signup_template: SignupTemplate | null;
  signup_recipient_person_id: string | null;
  signup_recipient_first_name: string | null;
  signup_recipient_last_name: string | null;
  signup_important_info: string | null;
  signup_note_mode: SignupNoteMode | null;
  signup_note_prompt: string | null;
  signup_write_ins_enabled: boolean | null;
  signup_write_in_max: number | null;
  signup_public_enabled: boolean | null;
  signup_share_token: string | null;
  signup_closes_on: Date | string | null;
  signup_past_close: boolean | null;
  signup_slots: SignupSlotRow[] | null;
}

function toIsoDate(value: Date | string | null): string | null {
  if (value === null) return null;
  if (typeof value === "string") return value.slice(0, 10);
  return value.toISOString().slice(0, 10);
}

function taken(slot: SignupSlotRow): number {
  return slot.entries.reduce((sum, e) => sum + e.quantity, 0);
}

export function toGroupSignupDto(
  row: SignupColumnsRow,
  options: { callerPersonId: string | null; canManage: boolean; deleted: boolean }
): GroupSignupDto {
  const closed = options.deleted || row.signup_past_close === true;
  const slots = row.signup_slots ?? [];
  return {
    title: row.signup_title ?? "",
    description: row.signup_description,
    template: row.signup_template ?? "CUSTOM",
    recipient:
      row.signup_recipient_person_id && row.signup_recipient_first_name !== null
        ? {
            personId: row.signup_recipient_person_id,
            name: fullName({
              firstName: row.signup_recipient_first_name,
              lastName: row.signup_recipient_last_name,
            }),
          }
        : null,
    importantInfo: row.signup_important_info,
    noteMode: row.signup_note_mode ?? "NONE",
    notePrompt: row.signup_note_prompt,
    writeInsEnabled: row.signup_write_ins_enabled === true,
    writeInMax: row.signup_write_in_max,
    writeInCount: slots.filter((s) => s.isWriteIn).length,
    publicEnabled: row.signup_public_enabled === true,
    shareToken: row.signup_share_token ?? "",
    closesOn: toIsoDate(row.signup_closes_on),
    closed,
    canManage: options.canManage,
    slots: slots.map(
      (slot): SignupSlotDto => ({
        id: slot.id,
        date: toIsoDate(slot.date),
        label: slot.label,
        capacity: slot.capacity,
        taken: taken(slot),
        isWriteIn: slot.isWriteIn,
        closed: closed || slot.past,
        entries: slot.entries.map((e) => {
          const isMine = e.personId !== null && e.personId === options.callerPersonId;
          const isPublic = e.appUserId === null;
          return {
            id: e.id,
            personId: e.personId,
            name: fullName({ firstName: e.firstName ?? "Someone", lastName: e.lastName }),
            quantity: e.quantity,
            note: e.note,
            isPublic,
            isMine,
            email: isPublic && options.canManage ? e.email : null,
            canRemove: isMine || options.canManage,
          };
        }),
      })
    ),
  };
}

/** What the public page shows of a slot: what is being brought, never who. */
export function toPublicSignupSlotDto(slot: SignupSlotRow, closed: boolean): PublicSignupSlotDto {
  return {
    id: slot.id,
    date: toIsoDate(slot.date),
    label: slot.label,
    capacity: slot.capacity,
    taken: taken(slot),
    isWriteIn: slot.isWriteIn,
    closed: closed || slot.past,
    entries: slot.entries.map((e) => ({ id: e.id, quantity: e.quantity, note: e.note })),
  };
}

// ---------------------------------------------------------------------------
// Creating and editing the sign-up itself
// ---------------------------------------------------------------------------

export async function insertSignup(
  tx: Queryable,
  postId: string,
  fields: GroupSignupFields,
  shareToken: string
): Promise<void> {
  await tx.query(
    `insert into group_signups
       (post_id, title, description, template, recipient_person_id, important_info,
        note_mode, note_prompt, write_ins_enabled, write_in_max, public_enabled,
        share_token, closes_on)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
    [
      postId,
      fields.title,
      fields.description ?? null,
      fields.template,
      fields.recipientPersonId ?? null,
      fields.importantInfo ?? null,
      fields.noteMode,
      fields.notePrompt ?? null,
      fields.writeInsEnabled,
      fields.writeInsEnabled ? (fields.writeInMax ?? null) : null,
      fields.publicEnabled ?? false,
      shareToken,
      fields.closesOn ?? null,
    ]
  );
  // No slots at all is one general, unlimited slot: "sign up and say what you
  // are bringing". Stored as a real row so entries always have a slot.
  const slots =
    fields.slots.length > 0 ? fields.slots : [{ date: null, label: null, capacity: null }];
  for (const [position, slot] of slots.entries()) {
    await insertSlot(tx, postId, slot, position);
  }
}

async function insertSlot(
  tx: Queryable,
  postId: string,
  slot: { date?: string | null; label?: string | null; capacity?: number | null },
  position: number
): Promise<void> {
  await tx.query(
    `insert into group_signup_slots (post_id, slot_date, label, capacity, position)
     values ($1, $2, $3, $4, $5)`,
    [postId, slot.date ?? null, slot.label ?? null, slot.capacity ?? null, position]
  );
}

/**
 * The organizer's edit. Slots listed with an id are updated in place (keeping
 * their entries); new ones are added; organizer slots left out are removed,
 * entries and all -- the app asks before sending that. Write-ins are never
 * touched: they belong to the people who added them.
 */
export async function updateSignup(
  tx: Queryable,
  postId: string,
  fields: GroupSignupFields
): Promise<void> {
  // Entry writes take this same lock, so nobody signs up into a slot while
  // its capacity is being checked and changed here.
  await lockSignup(tx, postId);
  await tx.query(
    `update group_signups
        set title = $2, description = $3, template = $4, recipient_person_id = $5,
            important_info = $6, note_mode = $7, note_prompt = $8, write_ins_enabled = $9,
            write_in_max = $10, public_enabled = coalesce($11, public_enabled), closes_on = $12
      where post_id = $1`,
    [
      postId,
      fields.title,
      fields.description ?? null,
      fields.template,
      fields.recipientPersonId ?? null,
      fields.importantInfo ?? null,
      fields.noteMode,
      fields.notePrompt ?? null,
      fields.writeInsEnabled,
      fields.writeInsEnabled ? (fields.writeInMax ?? null) : null,
      fields.publicEnabled ?? null,
      fields.closesOn ?? null,
    ]
  );

  const { rows: existing } = await tx.query<{ id: string; taken: number }>(
    `select s.id, coalesce(sum(e.quantity), 0)::int as taken
       from group_signup_slots s
       left join group_signup_entries e on e.slot_id = s.id
      where s.post_id = $1 and not s.is_write_in
      group by s.id`,
    [postId]
  );
  const takenById = new Map(existing.map((s) => [s.id, s.taken]));

  for (const slot of fields.slots) {
    if (slot.id && !takenById.has(slot.id)) {
      throw new HTTPException(400, { message: "That slot is not on this sign-up" });
    }
    const already = slot.id ? (takenById.get(slot.id) ?? 0) : 0;
    if (slot.capacity != null && slot.capacity < already) {
      throw new HTTPException(409, {
        message: `${slot.label ?? slot.date ?? "A slot"} already has ${already} signed up`,
      });
    }
  }

  const keep = fields.slots.map((s) => s.id).filter((id): id is string => Boolean(id));
  await tx.query(
    `delete from group_signup_slots
      where post_id = $1 and not is_write_in and id <> all($2::uuid[])`,
    [postId, keep]
  );

  const slots = fields.slots.length > 0 ? fields.slots : null;
  if (!slots) {
    // Back to one general slot -- keep the one already there if it is general.
    const general = await one<{ id: string }>(
      tx,
      `select id from group_signup_slots
        where post_id = $1 and not is_write_in and slot_date is null and label is null`,
      [postId]
    );
    if (!general) await insertSlot(tx, postId, {}, 0);
    return;
  }
  for (const [position, slot] of slots.entries()) {
    if (slot.id) {
      await tx.query(
        `update group_signup_slots
            set slot_date = $2, label = $3, capacity = $4, position = $5
          where id = $1`,
        [slot.id, slot.date ?? null, slot.label ?? null, slot.capacity ?? null, position]
      );
    } else {
      await insertSlot(tx, postId, slot, position);
    }
  }
}

// ---------------------------------------------------------------------------
// Entries
// ---------------------------------------------------------------------------

/** What every entry write needs to know about the sign-up, read under lock. */
export interface SignupState {
  post_id: string;
  note_mode: SignupNoteMode;
  note_prompt: string | null;
  write_ins_enabled: boolean;
  write_in_max: number | null;
  public_enabled: boolean;
  closed: boolean;
}

/**
 * Locks the sign-up row for the rest of the transaction. Every entry write
 * goes through here first, so writes to one sign-up are serialized: that is
 * what keeps both capacity and the write-in cap honest under concurrency.
 */
export async function lockSignup(tx: Queryable, postId: string): Promise<SignupState> {
  const row = await one<SignupState>(
    tx,
    `select gsu.post_id, gsu.note_mode, gsu.note_prompt, gsu.write_ins_enabled,
            gsu.write_in_max, gsu.public_enabled,
            (p.deleted_at is not null or coalesce(gsu.closes_on < ${PAST}, false)) as closed
       from group_signups gsu
       join group_posts p on p.id = gsu.post_id
      where gsu.post_id = $1
      for update of gsu`,
    [postId]
  );
  if (!row) throw new HTTPException(404, { message: "Sign-up not found" });
  return row;
}

interface SlotState {
  id: string;
  label: string | null;
  capacity: number | null;
  is_write_in: boolean;
  past: boolean;
  /** Everyone else's quantity -- the entry being changed is left out. */
  taken: number;
}

async function loadSlot(
  tx: Queryable,
  postId: string,
  slotId: string,
  excludingEntryId: string | null
): Promise<SlotState> {
  const slot = await one<SlotState>(
    tx,
    `select s.id, s.label, s.capacity, s.is_write_in,
            coalesce(s.slot_date < ${PAST}, false) as past,
            (select coalesce(sum(e.quantity), 0)::int from group_signup_entries e
              where e.slot_id = s.id and e.id is distinct from $3::uuid) as taken
       from group_signup_slots s
      where s.id = $1 and s.post_id = $2`,
    [slotId, postId, excludingEntryId]
  );
  if (!slot) throw new HTTPException(404, { message: "That slot is not on this sign-up" });
  return slot;
}

function assertOpen(signup: SignupState, slot?: SlotState): void {
  if (signup.closed) throw new HTTPException(409, { message: "This sign-up is closed" });
  if (slot?.past) throw new HTTPException(409, { message: "That date has passed" });
}

function assertRoom(slot: SlotState, quantity: number): void {
  if (slot.capacity === null) return;
  const left = slot.capacity - slot.taken;
  if (quantity > left) {
    throw new HTTPException(409, {
      message: left <= 0 ? "That slot is full" : `Only ${left} left in that slot`,
    });
  }
}

/** The note as the sign-up asks for it: dropped when it asks for none, required when it says so. */
function resolveNote(signup: SignupState, note: string | null | undefined): string | null {
  if (signup.note_mode === "NONE") return null;
  if (signup.note_mode === "REQUIRED" && !note) {
    throw new HTTPException(400, { message: signup.note_prompt ?? "Say what you are bringing" });
  }
  return note ?? null;
}

async function assertWriteInFree(
  tx: Queryable,
  postId: string,
  label: string,
  exceptSlotId: string | null
) {
  const clash = await one<{ id: string }>(
    tx,
    `select id from group_signup_slots
      where post_id = $1 and lower(label) = lower($2) and id is distinct from $3::uuid`,
    [postId, label, exceptSlotId]
  );
  if (clash) throw new HTTPException(409, { message: `"${label}" is already on the list` });
}

export type EntryOwner =
  | { appUserId: string }
  | { firstName: string; lastName: string; email: string; editTokenHash: string };

/** Signs somebody up. Returns the new entry's id. Call inside a transaction. */
export async function createSignupEntry(
  tx: Queryable,
  signup: SignupState,
  input: { slotId?: string; writeIn?: string; quantity: number; note?: string | null },
  owner: EntryOwner
): Promise<string> {
  assertOpen(signup);
  let slotId: string;
  let note: string | null;

  if (input.writeIn) {
    if (!signup.write_ins_enabled) {
      throw new HTTPException(400, { message: "This sign-up does not take your own items" });
    }
    if (signup.write_in_max !== null) {
      const count = await one<{ n: number }>(
        tx,
        "select count(*)::int as n from group_signup_slots where post_id = $1 and is_write_in",
        [signup.post_id]
      );
      if ((count?.n ?? 0) >= signup.write_in_max) {
        throw new HTTPException(409, { message: "There is no more room for your own items" });
      }
    }
    await assertWriteInFree(tx, signup.post_id, input.writeIn, null);
    const created = await one<{ id: string }>(
      tx,
      `insert into group_signup_slots (post_id, label, capacity, position, is_write_in)
       values ($1, $2, $3, 0, true) returning id`,
      [signup.post_id, input.writeIn, input.quantity]
    );
    slotId = created!.id;
    // The label is what they are bringing; a note would only repeat it.
    note = null;
  } else {
    const slot = await loadSlot(tx, signup.post_id, input.slotId!, null);
    if (slot.is_write_in) {
      throw new HTTPException(409, { message: "That item is somebody else's -- add your own" });
    }
    assertOpen(signup, slot);
    assertRoom(slot, input.quantity);
    note = resolveNote(signup, input.note);
    slotId = slot.id;
  }

  const isMember = "appUserId" in owner;
  try {
    const created = await one<{ id: string }>(
      tx,
      `insert into group_signup_entries
         (post_id, slot_id, app_user_id, first_name, last_name, email, edit_token_hash, quantity, note)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       returning id`,
      [
        signup.post_id,
        slotId,
        isMember ? owner.appUserId : null,
        isMember ? null : owner.firstName,
        isMember ? null : owner.lastName,
        isMember ? null : owner.email,
        isMember ? null : owner.editTokenHash,
        input.quantity,
        note,
      ]
    );
    return created!.id;
  } catch (err) {
    if ((err as { code?: string }).code === "23505") {
      throw new HTTPException(409, {
        message: "You have already signed up for that -- change your entry instead",
      });
    }
    throw err;
  }
}

export interface EntryState {
  id: string;
  slot_id: string;
  app_user_id: string | null;
  edit_token_hash: string | null;
  is_write_in: boolean;
}

export async function loadEntry(
  tx: Queryable,
  postId: string,
  entryId: string
): Promise<EntryState> {
  const entry = await one<EntryState>(
    tx,
    `select e.id, e.slot_id, e.app_user_id, e.edit_token_hash, s.is_write_in
       from group_signup_entries e
       join group_signup_slots s on s.id = e.slot_id
      where e.id = $1 and e.post_id = $2`,
    [entryId, postId]
  );
  if (!entry) throw new HTTPException(404, { message: "That entry is not on this sign-up" });
  return entry;
}

/** Changes an entry's quantity, note, or (for a write-in) what it is. */
export async function updateSignupEntry(
  tx: Queryable,
  signup: SignupState,
  entry: EntryState,
  input: { quantity?: number; note?: string | null; writeIn?: string }
): Promise<void> {
  const slot = await loadSlot(tx, signup.post_id, entry.slot_id, entry.id);
  assertOpen(signup, slot);

  if (entry.is_write_in) {
    if (input.writeIn) await assertWriteInFree(tx, signup.post_id, input.writeIn, slot.id);
    await tx.query(
      `update group_signup_slots
          set label = coalesce($2, label), capacity = coalesce($3, capacity)
        where id = $1`,
      [slot.id, input.writeIn ?? null, input.quantity ?? null]
    );
    if (input.quantity !== undefined) {
      await tx.query("update group_signup_entries set quantity = $2 where id = $1", [
        entry.id,
        input.quantity,
      ]);
    }
    return;
  }

  if (input.writeIn) throw new HTTPException(400, { message: "Only your own item can be renamed" });
  if (input.quantity !== undefined) assertRoom(slot, input.quantity);
  const noteChanges = input.note !== undefined;
  await tx.query(
    `update group_signup_entries
        set quantity = coalesce($2, quantity),
            note = case when $3::boolean then $4::text else note end
      where id = $1`,
    [
      entry.id,
      input.quantity ?? null,
      noteChanges,
      noteChanges ? resolveNote(signup, input.note) : null,
    ]
  );
}

/** Removes an entry, and a write-in's slot with it. */
export async function deleteSignupEntry(tx: Queryable, entry: EntryState): Promise<void> {
  if (entry.is_write_in) {
    // Cascades to the entry.
    await tx.query("delete from group_signup_slots where id = $1", [entry.slot_id]);
  } else {
    await tx.query("delete from group_signup_entries where id = $1", [entry.id]);
  }
}

// ---------------------------------------------------------------------------
// Public edit tokens
// ---------------------------------------------------------------------------

/** A fresh edit token and the hash that is all the database ever keeps. */
export function newEditToken(): { token: string; hash: string } {
  const token = randomBytes(24).toString("base64url");
  return { token, hash: hashEditToken(token) };
}

export function hashEditToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

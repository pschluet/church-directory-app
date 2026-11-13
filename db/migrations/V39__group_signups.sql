-- Sign-ups: a fourth kind of group post, beside MESSAGE, EVENT and POLL.
--
-- One shape covers potlucks, meal trains, pick-a-date lists, donation
-- drives and whatever comes next: a sign-up is a list of slots, and people
-- put entries in slots.
--
--   * A slot has an optional date, an optional label and an optional capacity
--     (null = unlimited). "Main dish x4", "Sunday 6 Dec x1", "Oranges x10" and
--     a single blank unlimited slot ("bring anything") are all just slots.
--   * An entry is one person's commitment to a slot: a quantity (how many of
--     the slot's spots it fills) and, when the sign-up asks for one, a note
--     ("What are you bringing?").
--   * Write-ins: when the organizer allows it, a signer can add their own slot
--     -- the label is exactly what they are bringing. A write-in slot belongs
--     to the entry that made it and goes when that entry does. `write_in_max`
--     caps how many there can be.
--
-- `template` only records which starting point the organizer picked, so the
-- app can show a fitting icon. Nothing branches on it: the fields themselves
-- say how the sign-up behaves.
--
-- Entries come from members (app_user_id) or, when the organizer opened the
-- share page to the public, from people without an account (name + email +
-- the hash of an edit token handed back once, so they can change or cancel
-- their entry later without an account and without the app emailing anyone).
--
-- Capacity is a cross-row rule (sum of entry quantities <= slot capacity), so
-- the API enforces it by locking the slot row before it writes an entry.
--
-- Everything cascades from the post, so retention's hard delete takes the
-- slots and entries with it.

alter table group_posts drop constraint group_posts_kind_valid;
alter table group_posts
  add constraint group_posts_kind_valid
    check (kind in ('MESSAGE', 'EVENT', 'POLL', 'SIGNUP'));

create table group_signups (
  post_id             uuid    primary key references group_posts (id) on delete cascade,
  title               text    not null,
  description         text,
  template            text    not null default 'CUSTOM',
  -- Whom the sign-up is for (a meal train's family). Not required, and the
  -- sign-up outlives the person record if it is ever removed.
  recipient_person_id uuid    references persons (id) on delete set null,
  -- A highlighted box: dietary restrictions, drop-off instructions...
  important_info      text,
  note_mode           text    not null default 'NONE',
  note_prompt         text,
  write_ins_enabled   boolean not null default false,
  write_in_max        int,
  public_enabled      boolean not null default false,
  -- Same rules as group_events.share_token (see V30): a ULID set at creation,
  -- never rotated, so a printed flyer keeps working.
  share_token         text    not null,
  -- Last day sign-ups are taken, naive local like every date here.
  closes_on           date,

  constraint group_signups_title_not_blank check (btrim(title) <> ''),
  constraint group_signups_template_valid
    check (template in ('POTLUCK', 'MEAL_TRAIN', 'DATES', 'DONATIONS', 'CUSTOM')),
  constraint group_signups_note_mode_valid check (note_mode in ('NONE', 'OPTIONAL', 'REQUIRED')),
  constraint group_signups_write_in_max_positive check (write_in_max is null or write_in_max > 0)
);

create unique index group_signups_share_token_key on group_signups (share_token);

create table group_signup_slots (
  id                     uuid        primary key default gen_random_uuid(),
  post_id                uuid        not null references group_signups (post_id) on delete cascade,
  slot_date              date,
  label                  text,
  capacity               int,
  position               int         not null,
  is_write_in            boolean     not null default false,
  created_at             timestamptz not null default clock_timestamp(),

  constraint group_signup_slots_capacity_positive check (capacity is null or capacity > 0),
  constraint group_signup_slots_label_not_blank check (label is null or btrim(label) <> ''),
  constraint group_signup_slots_write_in_has_label check (not is_write_in or label is not null),
  constraint group_signup_slots_position_not_negative check (position >= 0)
);

create index group_signup_slots_post_idx on group_signup_slots (post_id, position);

create table group_signup_entries (
  id              uuid        primary key default gen_random_uuid(),
  post_id         uuid        not null references group_signups (post_id) on delete cascade,
  slot_id         uuid        not null references group_signup_slots (id) on delete cascade,
  -- A member's entry...
  app_user_id     uuid        references app_users (id) on delete cascade,
  -- ...or a stranger's, through the public share page.
  first_name      text,
  last_name       text,
  email           citext,
  edit_token_hash text,
  quantity        int         not null default 1,
  note            text,
  created_at      timestamptz not null default clock_timestamp(),
  updated_at      timestamptz not null default clock_timestamp(),

  constraint group_signup_entries_member_or_public check (
    (app_user_id is not null
       and first_name is null and last_name is null and email is null
       and edit_token_hash is null)
    or
    (app_user_id is null
       and btrim(first_name) <> '' and btrim(last_name) <> '' and btrim(email) <> ''
       and edit_token_hash is not null)
  ),
  constraint group_signup_entries_quantity_sane check (quantity between 1 and 999),
  constraint group_signup_entries_note_not_blank check (note is null or btrim(note) <> '')
);

-- One entry per person per slot: a second sign-up for the same slot is a
-- change to the first, made through PATCH.
create unique index group_signup_entries_member_once_idx
  on group_signup_entries (slot_id, app_user_id) where app_user_id is not null;
create unique index group_signup_entries_public_once_idx
  on group_signup_entries (slot_id, email) where email is not null;
create index group_signup_entries_post_idx on group_signup_entries (post_id);

create trigger group_signup_entries_set_updated_at
  before update on group_signup_entries
  for each row execute function set_updated_at();

-- Signing up moves the group's activity stamp so an open page (see V20)
-- refetches and everyone watching sees the slot fill, as a poll vote does.
create function touch_group_activity_for_signup_entry() returns trigger as $fn$
begin
  update groups set activity_at = clock_timestamp()
   where id = (select group_id from group_posts where id = coalesce(new.post_id, old.post_id));
  return coalesce(new, old);
end;
$fn$ language plpgsql;

create trigger group_signup_entries_touch_activity
  after insert or update or delete on group_signup_entries
  for each row execute function touch_group_activity_for_signup_entry();

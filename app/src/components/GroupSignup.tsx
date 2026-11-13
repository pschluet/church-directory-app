import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { useMutation } from "@tanstack/react-query";
import { useLocation } from "react-router";
import {
  GROUP_SIGNUP_DESCRIPTION_MAX,
  GROUP_SIGNUP_INFO_MAX,
  GROUP_SIGNUP_MAX_CAPACITY,
  GROUP_SIGNUP_MAX_SLOTS,
  GROUP_SIGNUP_MAX_WRITE_INS,
  GROUP_SIGNUP_NOTE_MAX,
  GROUP_SIGNUP_PROMPT_MAX,
  GROUP_SIGNUP_SLOT_LABEL_MAX,
  GROUP_SIGNUP_TITLE_MAX,
  type GroupPostDto,
  type GroupSignupDto,
  type SignupNoteMode,
  type SignupTemplate,
} from "@shared";
import { useMe } from "../context/MeContext";
import { api } from "../lib/api";
import { downloadEventFlyer } from "../lib/eventFlyer";
import { formatDayLabel, parseIsoDate } from "../lib/format";
import { feedState, signupDetailPath } from "../lib/messageLinks";
import {
  datesBetween,
  isGeneralOnly,
  SIGNUP_TEMPLATE_SPECS,
  signupFlyerRows,
  signupShareUrl,
  slotTitle,
  spotsLeft,
  templateSpec,
  type DraftSlot,
} from "../lib/signups";
import { EventQrModal } from "./EventQrModal";
import { LinkifiedText } from "./LinkifiedText";
import { Link } from "./nav";
import { PersonPicker, type PickedPerson } from "./PersonPicker";
import { ShareButtons, type ShareControls } from "./ShareButtons";
import { Button, ConfirmDialog, Field, Modal, SegmentedControl, inputClass } from "./ui";

/**
 * Sign-ups in a group: the form that starts (or edits) one, from the message
 * bar's `+` menu, and the card that shows one in the conversation.
 *
 * One model covers every kind (see V39__group_signups.sql): a list of slots --
 * each with an optional date, name and number needed -- that people put
 * entries in. Templates only fill the form in. Fields appear on the signer's
 * form only when they apply: a quantity when a slot has room for more than
 * one, a note when the organizer asked for one.
 */

// ---------------------------------------------------------------------------
// Small pieces
// ---------------------------------------------------------------------------

export function SignupIcon({ className = "h-4 w-4" }: { className?: string }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20" className={`${className} fill-current`}>
      <path d="M6 2a1 1 0 0 1 1 1h6a1 1 0 1 1 2 0h.5A2.5 2.5 0 0 1 18 5.5v10a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 2 15.5v-10A2.5 2.5 0 0 1 4.5 3H5a1 1 0 0 1 1-1Zm-1.5 3a.5.5 0 0 0-.5.5v10a.5.5 0 0 0 .5.5h11a.5.5 0 0 0 .5-.5v-10a.5.5 0 0 0-.5-.5h-11Zm8.7 2.8a.8.8 0 0 1 0 1.1l-3.5 3.5a.8.8 0 0 1-1.1 0L6.8 10.6a.8.8 0 1 1 1.1-1.1l1.3 1.3 3-2.9a.8.8 0 0 1 1 0Z" />
    </svg>
  );
}

function XIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20" className="h-4 w-4 fill-current">
      <path d="M5.3 5.3a1 1 0 0 1 1.4 0L10 8.6l3.3-3.3a1 1 0 1 1 1.4 1.4L11.4 10l3.3 3.3a1 1 0 0 1-1.4 1.4L10 11.4l-3.3 3.3a1 1 0 0 1-1.4-1.4L8.6 10 5.3 6.7a1 1 0 0 1 0-1.4Z" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20" className="h-4 w-4 fill-current">
      <path d="M10 3a1 1 0 0 1 1 1v5h5a1 1 0 1 1 0 2h-5v5a1 1 0 1 1-2 0v-5H4a1 1 0 1 1 0-2h5V4a1 1 0 0 1 1-1Z" />
    </svg>
  );
}

const linkButton =
  "inline-flex items-center gap-1.5 rounded-md px-1 py-1 text-sm font-bold text-accent hover:underline";

// ---------------------------------------------------------------------------
// Starting or editing a sign-up
// ---------------------------------------------------------------------------

const WEEKDAYS = ["S", "M", "T", "W", "T", "F", "S"] as const;
const WEEKDAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

/** "Add dates…": a range and the weekdays in it, turned into one slot per date. */
function AddDatesPanel({
  defaultLabel,
  onAdd,
  onClose,
}: {
  defaultLabel: string;
  onAdd: (dates: string[], label: string, capacity: string) => void;
  onClose: () => void;
}) {
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [weekdays, setWeekdays] = useState<number[]>([]);
  const [label, setLabel] = useState(defaultLabel);
  const [capacity, setCapacity] = useState("1");
  const dates = datesBetween(start, end || start, weekdays);

  return (
    <div className="space-y-3 rounded-xl border border-accent/40 bg-accent-light/10 p-3">
      <div className="grid grid-cols-2 gap-2">
        <Field label="From">
          <input
            type="date"
            className={inputClass}
            value={start}
            onChange={(e) => setStart(e.target.value)}
          />
        </Field>
        <Field label="Through">
          <input
            type="date"
            className={inputClass}
            value={end}
            min={start || undefined}
            onChange={(e) => setEnd(e.target.value)}
          />
        </Field>
      </div>
      <div>
        <p className="mb-1 text-sm font-bold text-ink">
          On {weekdays.length === 0 ? "every day" : "these days"}
        </p>
        <div className="flex gap-1">
          {WEEKDAYS.map((letter, day) => {
            const on = weekdays.includes(day);
            return (
              <button
                key={WEEKDAY_NAMES[day]}
                type="button"
                aria-pressed={on}
                aria-label={WEEKDAY_NAMES[day]}
                onClick={() =>
                  setWeekdays((w) => (on ? w.filter((d) => d !== day) : [...w, day].sort()))
                }
                className={`size-9 rounded-full text-sm font-bold transition ${
                  on ? "bg-primary text-white" : "bg-surface text-ink hover:bg-surface-muted"
                }`}
              >
                {letter}
              </button>
            );
          })}
        </div>
      </div>
      <div className="grid grid-cols-[1fr_6rem] gap-2">
        <Field label="Name (optional)">
          <input
            className={inputClass}
            value={label}
            placeholder="Dinner"
            maxLength={GROUP_SIGNUP_SLOT_LABEL_MAX}
            onChange={(e) => setLabel(e.target.value)}
          />
        </Field>
        <Field label="Needed">
          <input
            type="number"
            min={1}
            className={inputClass}
            value={capacity}
            onChange={(e) => setCapacity(e.target.value)}
          />
        </Field>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button disabled={dates.length === 0} onClick={() => onAdd(dates, label, capacity)}>
          {dates.length === 0
            ? "Add dates"
            : `Add ${dates.length} ${dates.length === 1 ? "date" : "dates"}`}
        </Button>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

/** One row of the slot editor: an optional date, a name, and how many are needed. */
function SlotRow({
  slot,
  dated,
  index,
  onChange,
  onRemove,
}: {
  slot: DraftSlot;
  dated: boolean;
  index: number;
  onChange: (slot: DraftSlot) => void;
  onRemove: () => void;
}) {
  return (
    <li
      className={`grid items-center gap-2 ${dated ? "grid-cols-[minmax(0,9.5rem)_1fr_4.5rem_auto]" : "grid-cols-[1fr_4.5rem_auto]"}`}
    >
      {dated && (
        <input
          type="date"
          aria-label={`Slot ${index + 1} date`}
          className={`${inputClass} px-2`}
          value={slot.date}
          onChange={(e) => onChange({ ...slot, date: e.target.value })}
        />
      )}
      <input
        aria-label={`Slot ${index + 1} name`}
        className={inputClass}
        value={slot.label}
        maxLength={GROUP_SIGNUP_SLOT_LABEL_MAX}
        placeholder={slot.placeholder ?? (dated ? "Name (optional)" : "e.g. Dessert")}
        onChange={(e) => onChange({ ...slot, label: e.target.value })}
      />
      <input
        type="number"
        min={1}
        max={GROUP_SIGNUP_MAX_CAPACITY}
        aria-label={`Slot ${index + 1} number needed`}
        title="How many needed (blank for no limit)"
        className={`${inputClass} px-2 text-center`}
        value={slot.capacity}
        placeholder="∞"
        onChange={(e) => onChange({ ...slot, capacity: e.target.value })}
      />
      <button
        type="button"
        aria-label={`Remove slot ${index + 1}`}
        onClick={onRemove}
        className="tap-target inline-flex items-center justify-center rounded-full text-ink-muted transition hover:bg-surface-muted hover:text-primary"
      >
        <XIcon />
      </button>
    </li>
  );
}

function TemplatePicker({ onPick }: { onPick: (template: SignupTemplate) => void }) {
  return (
    <div className="space-y-3">
      <p className="text-ink-muted">What kind of sign-up? You can change everything after.</p>
      <ul className="grid gap-2 sm:grid-cols-2">
        {SIGNUP_TEMPLATE_SPECS.map((spec) => (
          <li key={spec.template}>
            <button
              type="button"
              onClick={() => onPick(spec.template)}
              className="flex h-full w-full items-start gap-3 rounded-xl border border-line bg-surface p-3 text-left transition hover:border-accent hover:bg-accent-light/10"
            >
              <span aria-hidden="true" className="text-2xl leading-none">
                {spec.emoji}
              </span>
              <span>
                <span className="block font-bold text-ink">{spec.name}</span>
                <span className="block text-sm text-ink-muted">{spec.blurb}</span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

interface SignupDraft {
  template: SignupTemplate;
  title: string;
  description: string;
  recipient: PickedPerson | null;
  importantInfo: string;
  noteMode: SignupNoteMode;
  notePrompt: string;
  writeInsEnabled: boolean;
  writeInMax: string;
  closesOn: string;
  publicEnabled: boolean;
  dated: boolean;
  slots: DraftSlot[];
}

function draftFromTemplate(template: SignupTemplate): SignupDraft {
  const spec = templateSpec(template);
  return {
    template,
    title: spec.title,
    description: "",
    recipient: null,
    importantInfo: "",
    noteMode: spec.noteMode,
    notePrompt: spec.notePrompt,
    writeInsEnabled: spec.writeInsEnabled,
    writeInMax: spec.writeInMax ? String(spec.writeInMax) : "",
    closesOn: "",
    publicEnabled: false,
    dated: spec.dated,
    slots: spec.slots.map((s) => ({ ...s })),
  };
}

function draftFromSignup(signup: GroupSignupDto): SignupDraft {
  const own = signup.slots.filter((s) => !s.isWriteIn);
  const general = isGeneralOnly(signup.slots);
  return {
    template: signup.template,
    title: signup.title,
    description: signup.description ?? "",
    recipient: signup.recipient
      ? { id: signup.recipient.personId, name: signup.recipient.name }
      : null,
    importantInfo: signup.importantInfo ?? "",
    noteMode: signup.noteMode,
    notePrompt: signup.notePrompt ?? "",
    writeInsEnabled: signup.writeInsEnabled,
    writeInMax: signup.writeInMax ? String(signup.writeInMax) : "",
    closesOn: signup.closesOn ?? "",
    publicEnabled: signup.publicEnabled,
    dated: own.some((s) => s.date !== null),
    slots: general
      ? []
      : own.map((s) => ({
          id: s.id,
          date: s.date ?? "",
          label: s.label ?? "",
          capacity: s.capacity === null ? "" : String(s.capacity),
          taken: s.taken,
        })),
  };
}

/** The draft as the API takes it: blank rows dropped, dates dropped unless dated. */
export function signupPayload(draft: SignupDraft) {
  const slots = draft.slots
    .map((s) => ({
      ...(s.id ? { id: s.id } : {}),
      date: draft.dated && s.date ? s.date : null,
      label: s.label.trim() || null,
      capacity: s.capacity.trim() === "" ? null : Math.max(1, Math.floor(Number(s.capacity))),
    }))
    .filter((s) => s.id || s.date || s.label);
  return {
    title: draft.title.trim(),
    description: draft.description.trim() || null,
    template: draft.template,
    recipientPersonId: draft.recipient?.id ?? null,
    importantInfo: draft.importantInfo.trim() || null,
    noteMode: draft.noteMode,
    notePrompt: draft.noteMode === "NONE" ? null : draft.notePrompt.trim() || null,
    writeInsEnabled: draft.writeInsEnabled,
    writeInMax:
      draft.writeInsEnabled && draft.writeInMax.trim() !== ""
        ? Math.max(1, Math.floor(Number(draft.writeInMax)))
        : null,
    publicEnabled: draft.publicEnabled,
    closesOn: draft.closesOn || null,
    slots,
  };
}

/**
 * Starting a sign-up (pick a template, then the form) or, given `post`, editing
 * one. A modal like the event and poll ones, so the message bar stays one line.
 */
export function SignupComposerModal({
  groupId,
  post,
  onClose,
  onPosted,
}: {
  groupId: string;
  /** The sign-up being edited; absent to start a new one. */
  post?: GroupPostDto;
  onClose: () => void;
  onPosted: () => Promise<unknown>;
}) {
  const editing = Boolean(post?.signup);
  const [draft, setDraft] = useState<SignupDraft | null>(
    post?.signup ? draftFromSignup(post.signup) : null
  );
  const [datesOpen, setDatesOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [confirmRemoval, setConfirmRemoval] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!draft) {
    return (
      <Modal title="New sign-up" onClose={onClose}>
        <TemplatePicker
          onPick={(template) => {
            const next = draftFromTemplate(template);
            setDraft(next);
            setDatesOpen(next.dated);
          }}
        />
      </Modal>
    );
  }

  const spec = templateSpec(draft.template);
  const set = (patch: Partial<SignupDraft>) => setDraft((d) => (d ? { ...d, ...patch } : d));
  const setSlot = (index: number, slot: DraftSlot) =>
    set({ slots: draft.slots.map((s, i) => (i === index ? slot : s)) });

  const originalIds = new Set(
    post?.signup?.slots.filter((s) => !s.isWriteIn && s.taken > 0).map((s) => s.id) ?? []
  );
  const keptIds = new Set(draft.slots.map((s) => s.id).filter(Boolean));
  const removingTaken = [...originalIds].filter((id) => !keptIds.has(id));
  const canSubmit = draft.title.trim() !== "" && !busy;

  async function submit(): Promise<void> {
    if (!draft) return;
    setBusy(true);
    setError(null);
    try {
      const signup = signupPayload(draft);
      if (post) {
        await api(`/groups/${groupId}/posts/${post.id}`, { method: "PATCH", body: { signup } });
      } else {
        await api(`/groups/${groupId}/posts`, {
          method: "POST",
          body: { kind: "SIGNUP", attachments: [], signup },
        });
      }
      await onPosted();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save that");
      setBusy(false);
    }
  }

  const infoField = (
    <Field label={spec.infoLabel} hint="Shown in a highlighted box above the slots.">
      <textarea
        className={`${inputClass} min-h-16`}
        value={draft.importantInfo}
        maxLength={GROUP_SIGNUP_INFO_MAX}
        placeholder={spec.infoPlaceholder}
        onChange={(e) => set({ importantInfo: e.target.value })}
      />
    </Field>
  );
  const recipientField = (
    <PersonPicker
      label="Who is it for? (optional)"
      hint="Links to their page in the directory."
      value={draft.recipient}
      onChange={(recipient) => set({ recipient })}
    />
  );

  return (
    <Modal title={editing ? "Edit sign-up" : `New sign-up · ${spec.name}`} onClose={onClose}>
      <form
        className="space-y-5"
        onSubmit={(event) => {
          event.preventDefault();
          if (!canSubmit) return;
          if (removingTaken.length > 0) setConfirmRemoval(true);
          else void submit();
        }}
      >
        <Field label="Title">
          <input
            className={inputClass}
            value={draft.title}
            maxLength={GROUP_SIGNUP_TITLE_MAX}
            placeholder={spec.titlePlaceholder}
            onChange={(e) => set({ title: e.target.value })}
            autoFocus={!editing}
          />
        </Field>
        <Field label="Details (optional)">
          <textarea
            className={`${inputClass} min-h-16`}
            value={draft.description}
            maxLength={GROUP_SIGNUP_DESCRIPTION_MAX}
            placeholder="When, where, anything else"
            onChange={(e) => set({ description: e.target.value })}
          />
        </Field>

        {spec.forSomeone && (
          <>
            {recipientField}
            {infoField}
          </>
        )}

        <fieldset className="space-y-2">
          <legend className="mb-1 font-bold text-ink">
            {draft.dated ? "Dates" : "What's needed"}
          </legend>
          <label className="flex items-center gap-2 text-sm text-ink">
            <input
              type="checkbox"
              checked={draft.dated}
              onChange={(e) => set({ dated: e.target.checked })}
              className="size-4 accent-primary"
            />
            Each slot is a date
          </label>
          {draft.slots.length === 0 ? (
            <p className="rounded-lg bg-surface-muted px-3 py-2 text-sm text-ink-muted">
              {draft.dated
                ? "Add the dates people can pick."
                : "No slots: people just sign up and say what they're bringing. Add slots to ask for specific things and how many."}
            </p>
          ) : (
            <>
              <div
                className={`grid gap-2 px-0.5 text-xs font-bold uppercase tracking-wide text-ink-muted ${draft.dated ? "grid-cols-[minmax(0,9.5rem)_1fr_4.5rem_2.75rem]" : "grid-cols-[1fr_4.5rem_2.75rem]"}`}
                aria-hidden="true"
              >
                {draft.dated && <span>Date</span>}
                <span>{draft.dated ? "Name" : "Item"}</span>
                <span className="text-center">Needed</span>
                <span />
              </div>
              <ol className="space-y-2">
                {draft.slots.map((slot, index) => (
                  <SlotRow
                    // Slots have no identity but their place until saved; the
                    // inputs are controlled, so a removal loses nothing.
                    key={slot.id ?? `new-${index}`}
                    slot={slot}
                    dated={draft.dated}
                    index={index}
                    onChange={(next) => setSlot(index, next)}
                    onRemove={() => set({ slots: draft.slots.filter((_, i) => i !== index) })}
                  />
                ))}
              </ol>
            </>
          )}
          {datesOpen && draft.dated ? (
            <AddDatesPanel
              defaultLabel=""
              onClose={() => setDatesOpen(false)}
              onAdd={(dates, label, capacity) => {
                const have = new Set(draft.slots.map((s) => `${s.date}|${s.label.trim()}`));
                const added = dates
                  .filter((date) => !have.has(`${date}|${label.trim()}`))
                  .map((date) => ({ date, label, capacity }));
                set({
                  slots: [...draft.slots, ...added]
                    .sort((a, b) => (a.date || "9999").localeCompare(b.date || "9999"))
                    .slice(0, GROUP_SIGNUP_MAX_SLOTS),
                });
                setDatesOpen(false);
              }}
            />
          ) : (
            draft.slots.length < GROUP_SIGNUP_MAX_SLOTS && (
              <div className="flex flex-wrap gap-x-4">
                <button
                  type="button"
                  className={linkButton}
                  onClick={() =>
                    set({
                      slots: [
                        ...draft.slots,
                        { date: "", label: "", capacity: draft.dated ? "1" : "" },
                      ],
                    })
                  }
                >
                  <PlusIcon />
                  Add a slot
                </button>
                {draft.dated && (
                  <button type="button" className={linkButton} onClick={() => setDatesOpen(true)}>
                    <PlusIcon />
                    Add dates…
                  </button>
                )}
              </div>
            )
          )}
        </fieldset>

        <div className="space-y-2">
          <p className="font-bold text-ink">Ask each person for a note</p>
          <SegmentedControl
            label="Ask each person for a note"
            value={draft.noteMode}
            onChange={(noteMode) => set({ noteMode })}
            options={[
              { value: "NONE", label: "No" },
              { value: "OPTIONAL", label: "Optional" },
              { value: "REQUIRED", label: "Required" },
            ]}
          />
          {draft.noteMode !== "NONE" && (
            <input
              aria-label="Question to ask"
              className={inputClass}
              value={draft.notePrompt}
              maxLength={GROUP_SIGNUP_PROMPT_MAX}
              placeholder="e.g. What are you bringing?"
              onChange={(e) => set({ notePrompt: e.target.value })}
            />
          )}
        </div>

        <div className="rounded-xl border border-line">
          <button
            type="button"
            aria-expanded={moreOpen}
            onClick={() => setMoreOpen((open) => !open)}
            className="flex w-full items-center justify-between px-3 py-2.5 text-left font-bold text-ink"
          >
            More options
            <span className="text-sm font-normal text-ink-muted">
              {[
                draft.writeInsEnabled && "Own items",
                draft.closesOn && "Closing date",
                draft.publicEnabled && "Public",
                !spec.forSomeone && draft.recipient && "For someone",
              ]
                .filter(Boolean)
                .join(" · ") || (moreOpen ? "" : "Own items, closing date, public link…")}
            </span>
          </button>
          {moreOpen && (
            <div className="space-y-4 border-t border-line p-3">
              <div className="space-y-2">
                <label className="flex items-start gap-2 text-ink">
                  <input
                    type="checkbox"
                    checked={draft.writeInsEnabled}
                    onChange={(e) => set({ writeInsEnabled: e.target.checked })}
                    className="mt-1 size-4 accent-primary"
                  />
                  <span>
                    <span className="block font-bold">Let people add their own items</span>
                    <span className="block text-sm text-ink-muted">
                      They type exactly what they're bringing.
                    </span>
                  </span>
                </label>
                {draft.writeInsEnabled && (
                  <Field label="How many own items, at most" hint="Leave blank for no limit.">
                    <input
                      type="number"
                      min={1}
                      max={GROUP_SIGNUP_MAX_WRITE_INS}
                      className={`${inputClass} max-w-28`}
                      value={draft.writeInMax}
                      onChange={(e) => set({ writeInMax: e.target.value })}
                    />
                  </Field>
                )}
              </div>
              <Field label="Last day to sign up (optional)">
                <input
                  type="date"
                  className={`${inputClass} max-w-48`}
                  value={draft.closesOn}
                  onChange={(e) => set({ closesOn: e.target.value })}
                />
              </Field>
              {!spec.forSomeone && (
                <>
                  {recipientField}
                  {infoField}
                </>
              )}
              <label className="flex items-start gap-2 text-ink">
                <input
                  type="checkbox"
                  checked={draft.publicEnabled}
                  onChange={(e) => set({ publicEnabled: e.target.checked })}
                  className="mt-1 size-4 accent-primary"
                />
                <span>
                  <span className="block font-bold">Allow public sign-up</span>
                  <span className="block text-sm text-ink-muted">
                    Anyone with the link or QR code can see the slots and sign up without an
                    account. They see what's being brought, never who.
                  </span>
                </span>
              </label>
            </div>
          )}
        </div>

        {error && (
          <p role="alert" className="text-sm font-bold text-primary">
            {error}
          </p>
        )}
        <div className="flex flex-col gap-2 sm:flex-row">
          <Button type="submit" disabled={!canSubmit}>
            {busy ? "Saving…" : editing ? "Save changes" : "Post sign-up"}
          </Button>
          {!editing && (
            <Button variant="ghost" onClick={() => setDraft(null)} disabled={busy}>
              Back
            </Button>
          )}
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
        </div>
      </form>

      {confirmRemoval && (
        <ConfirmDialog
          title="Remove slots people signed up for?"
          confirmLabel="Remove them"
          busy={busy}
          onClose={() => setConfirmRemoval(false)}
          onConfirm={() => {
            setConfirmRemoval(false);
            void submit();
          }}
        >
          <p>
            {removingTaken.length === 1
              ? "One slot you removed has"
              : "Some slots you removed have"}{" "}
            people signed up. Their entries will be removed too.
          </p>
        </ConfirmDialog>
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// The slots and their entries -- shared by the card and the public page
// ---------------------------------------------------------------------------

export interface EntryView {
  id: string;
  quantity: number;
  note: string | null;
  /** Null on the public page, which never names anybody. */
  name: string | null;
  personId: string | null;
  isMine: boolean;
  canRemove: boolean;
  email?: string | null;
}

export interface SlotView {
  id: string;
  date: string | null;
  label: string | null;
  capacity: number | null;
  taken: number;
  isWriteIn: boolean;
  closed: boolean;
  entries: EntryView[];
}

export interface SignupView {
  noteMode: SignupNoteMode;
  notePrompt: string | null;
  writeInsEnabled: boolean;
  writeInMax: number | null;
  writeInCount: number;
  closed: boolean;
  slots: SlotView[];
}

export interface EntryInput {
  slotId?: string;
  writeIn?: string;
  quantity: number;
  note: string | null;
}

type Editing =
  | { kind: "slot"; slotId: string }
  | { kind: "writeIn" }
  | { kind: "entry"; entryId: string }
  | null;

/** A slot draws one circle per spot up to this many; past it, a meter and one "+". */
const SPOT_LIMIT = 12;

/** Soft tints from the theme, picked by hashing the person, so each keeps a colour. */
const AVATAR_TONES = [
  "bg-primary/15 text-primary-dark",
  "bg-accent-light/70 text-ink",
  "bg-accent/25 text-ink",
  "bg-primary-light/25 text-primary-dark",
  "bg-ink-muted/15 text-ink",
] as const;

function avatarTone(key: string): string {
  let hash = 0;
  for (const ch of key) hash = (hash * 31 + ch.charCodeAt(0)) | 0;
  return AVATAR_TONES[Math.abs(hash) % AVATAR_TONES.length]!;
}

function nameInitials(name: string): string {
  const words = name.trim().split(/\s+/);
  return [words[0]?.[0], words.length > 1 ? words[words.length - 1]?.[0] : undefined]
    .filter(Boolean)
    .join("")
    .toUpperCase();
}

function CheckIcon({ className = "h-4 w-4" }: { className?: string }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20" className={`${className} fill-current`}>
      <path d="M16.7 5.3a1 1 0 0 1 0 1.4l-8 8a1 1 0 0 1-1.4 0l-4-4a1 1 0 1 1 1.4-1.4L8 12.6l7.3-7.3a1 1 0 0 1 1.4 0Z" />
    </svg>
  );
}

const SPOT = "relative inline-flex size-9 shrink-0 items-center justify-center rounded-full";

/**
 * A taken spot: the person's initials in their colour, or -- on the public
 * page, which names nobody -- a soft check. Your own is ringed, and tapping it
 * opens your entry to change.
 */
function TakenSpot({ entry, onOpen }: { entry: EntryView; onOpen: (() => void) | null }) {
  const label = entry.name ?? (entry.isMine ? "You" : "Taken");
  const face = entry.name ? (
    <span className="text-xs font-bold">{nameInitials(entry.name)}</span>
  ) : (
    <CheckIcon />
  );
  const tone = entry.name ? avatarTone(entry.personId ?? entry.id) : "bg-accent/20 text-accent";
  const ring = entry.isMine ? "ring-2 ring-primary ring-offset-2 ring-offset-surface" : "";
  const badge = entry.quantity > 1 && (
    <span className="absolute -right-2.5 -bottom-1.5 rounded-full border border-surface bg-ink px-1 text-[10px] font-bold leading-4 text-white tabular-nums">
      ×{entry.quantity}
    </span>
  );
  const className = `${SPOT} spot-in ${tone} ${ring}`;
  return onOpen ? (
    <button
      type="button"
      title={`${label} -- tap to change`}
      aria-label={`Change your sign-up${entry.note ? `: ${entry.note}` : ""}`}
      onClick={onOpen}
      className={`${className} transition hover:scale-105`}
    >
      {face}
      {badge}
    </button>
  ) : (
    <span title={entry.note ? `${label} -- ${entry.note}` : label} className={className}>
      {face}
      {badge}
    </span>
  );
}

/**
 * An open spot: a dashed circle with a "+" that fills on hover. Only the first
 * of a run is reachable by keyboard and named for a screen reader -- the rest
 * repeat it, and a list of identical buttons says nothing more.
 */
function OpenSpot({
  label,
  first,
  onClaim,
  text,
}: {
  label: string;
  first: boolean;
  onClaim: (() => void) | null;
  text?: string;
}) {
  const circle = (
    <span
      aria-hidden="true"
      className={`${SPOT} border-2 border-dashed transition ${
        onClaim
          ? "border-accent/70 text-accent group-hover:scale-110 group-hover:border-solid group-hover:border-accent group-hover:bg-accent-light/40 group-focus-visible:scale-110 group-focus-visible:bg-accent-light/40"
          : "border-line text-transparent"
      }`}
    >
      <PlusIcon />
    </span>
  );
  if (!onClaim) return circle;
  return (
    <button
      type="button"
      aria-label={first ? label : undefined}
      aria-hidden={first ? undefined : true}
      tabIndex={first ? undefined : -1}
      onClick={onClaim}
      className="group inline-flex items-center gap-2 rounded-full focus:outline-none"
    >
      {circle}
      {text && <span className="pr-2 text-sm font-bold text-accent">{text}</span>}
    </button>
  );
}

/** A tear-off calendar page for a dated slot. */
function DateTile({ date, past }: { date: string; past: boolean }) {
  const day = parseIsoDate(date);
  return (
    <div
      aria-hidden="true"
      className={`w-14 shrink-0 overflow-hidden rounded-lg border border-line bg-surface text-center shadow-sm ${
        past ? "opacity-50 grayscale" : ""
      }`}
    >
      <div className="bg-primary py-0.5 text-[10px] font-bold uppercase tracking-widest text-white">
        {day.toLocaleDateString(undefined, { weekday: "short" })}
      </div>
      <div className="pt-0.5 text-2xl font-bold leading-none text-ink">{day.getDate()}</div>
      <div className="pb-1 text-[10px] font-bold uppercase tracking-wider text-ink-muted">
        {day.toLocaleDateString(undefined, { month: "short" })}
      </div>
    </div>
  );
}

/** − n + for how many: big targets, and the number can still be typed. */
function Stepper({
  value,
  max,
  onChange,
}: {
  value: string;
  max: number;
  onChange: (value: string) => void;
}) {
  const n = Math.floor(Number(value)) || 0;
  const step =
    "inline-flex size-9 items-center justify-center text-lg font-bold text-ink transition hover:bg-surface-muted disabled:opacity-40";
  return (
    <div className="inline-flex items-center overflow-hidden rounded-full border border-line bg-surface">
      <button
        type="button"
        aria-label="One fewer"
        className={step}
        disabled={n <= 1}
        onClick={() => onChange(String(Math.max(1, n - 1)))}
      >
        −
      </button>
      <input
        type="number"
        min={1}
        max={max}
        aria-label="How many"
        className="w-12 border-x border-line bg-transparent py-1.5 text-center font-bold tabular-nums text-ink focus:outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      <button
        type="button"
        aria-label="One more"
        className={step}
        disabled={n >= max}
        onClick={() => onChange(String(Math.min(max, n + 1)))}
      >
        +
      </button>
    </div>
  );
}

/**
 * The claim form, as a ticket: a stub naming the slot and what is left, a
 * torn edge, then only the fields that apply -- what you are bringing for a
 * write-in, a count when there is room for more than one, a note when the
 * organizer asked for one. `extra` is the public page's name and email.
 */
function ClaimTicket({
  view,
  slot,
  entry,
  writeIn,
  busy,
  extra,
  heading,
  onSubmit,
  onCancel,
}: {
  view: SignupView;
  slot: SlotView | null;
  entry: EntryView | null;
  writeIn: boolean;
  busy: boolean;
  extra?: ReactNode;
  heading: string;
  onSubmit: (input: { writeIn?: string; quantity: number; note: string | null }) => void;
  onCancel: () => void;
}) {
  const [label, setLabel] = useState(writeIn && slot ? (slot.label ?? "") : "");
  const [quantity, setQuantity] = useState(String(entry?.quantity ?? 1));
  const [note, setNote] = useState(entry?.note ?? "");

  // Room for this entry: what is left plus what it already holds.
  const room =
    slot && !writeIn && slot.capacity !== null
      ? slot.capacity - slot.taken + (entry?.quantity ?? 0)
      : null;
  const askQuantity = writeIn || (room !== null && room > 1);
  const askNote = !writeIn && view.noteMode !== "NONE";
  const noteRequired = view.noteMode === "REQUIRED";
  const qty = Math.floor(Number(quantity));
  const valid =
    (!writeIn || label.trim() !== "") &&
    (!askQuantity || (qty >= 1 && (room === null || qty <= room))) &&
    (!askNote || !noteRequired || note.trim() !== "");
  const count = askQuantity && qty > 1 ? qty : 1;
  const submitLabel = entry
    ? "Save"
    : writeIn
      ? "Add it"
      : count > 1
        ? `Claim ${count} spots`
        : "Claim spot";

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!valid || busy) return;
    onSubmit({
      ...(writeIn ? { writeIn: label.trim() } : {}),
      quantity: askQuantity ? qty : (entry?.quantity ?? 1),
      note: askNote ? note.trim() || null : null,
    });
  }

  return (
    <form
      onSubmit={submit}
      className="mt-3 rounded-xl border border-accent/40 bg-accent-light/15 px-3 shadow-sm"
    >
      <div className="flex items-baseline justify-between gap-3 py-2">
        <p className="min-w-0 break-words text-sm font-bold uppercase tracking-wide text-accent">
          {heading}
        </p>
        {room !== null && (
          <p className="shrink-0 text-sm text-ink-muted">
            {room} {room === 1 ? "spot" : "spots"} left
          </p>
        )}
      </div>
      <div className="ticket-tear space-y-3 pt-3 pb-3">
        {extra}
        {writeIn && (
          <Field label="What are you bringing?">
            <input
              className={inputClass}
              value={label}
              maxLength={GROUP_SIGNUP_SLOT_LABEL_MAX}
              placeholder="Be specific, e.g. Wool socks, size M"
              onChange={(e) => setLabel(e.target.value)}
              autoFocus={!extra}
            />
          </Field>
        )}
        {askNote && (
          <Field label={`${view.notePrompt || "Note"}${noteRequired ? "" : " (optional)"}`}>
            <input
              className={inputClass}
              value={note}
              maxLength={GROUP_SIGNUP_NOTE_MAX}
              onChange={(e) => setNote(e.target.value)}
              autoFocus={!extra && !writeIn}
            />
          </Field>
        )}
        <div className="flex flex-wrap items-center gap-3">
          {askQuantity && (
            <Stepper
              value={quantity}
              max={room ?? GROUP_SIGNUP_MAX_CAPACITY}
              onChange={setQuantity}
            />
          )}
          <Button type="submit" disabled={!valid || busy} className="!rounded-full">
            {busy ? "Saving…" : submitLabel}
          </Button>
          <Button variant="ghost" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
        </div>
      </div>
    </form>
  );
}

function ProgressBar({ taken, capacity }: { taken: number; capacity: number }) {
  const percent = Math.min(100, Math.round((taken / capacity) * 100));
  return (
    <span
      aria-hidden="true"
      className="block h-1.5 w-full overflow-hidden rounded-full bg-surface-muted"
    >
      <span
        className={`block h-full rounded-full transition-[width] duration-500 ${
          taken >= capacity ? "bg-accent" : "bg-primary/70"
        }`}
        style={{ width: `${percent}%` }}
      />
    </span>
  );
}

/** One line of "who's bringing what", with Change and Remove where allowed. */
function EntryLine({
  entry,
  linkPeople,
  canChange,
  onChange,
  onRemove,
  busy,
}: {
  entry: EntryView;
  linkPeople: boolean;
  canChange: boolean;
  onChange: () => void;
  onRemove: () => void;
  busy: boolean;
}) {
  const who = entry.name ? (
    linkPeople && entry.personId ? (
      <Link
        to={`/people/${entry.personId}`}
        className="font-bold text-ink hover:text-accent hover:underline"
      >
        {entry.name}
      </Link>
    ) : (
      <span className="font-bold text-ink">{entry.name}</span>
    )
  ) : entry.isMine ? (
    <span className="font-bold text-ink">You</span>
  ) : null;
  const small =
    "inline-flex items-center rounded-md px-1 text-sm font-bold hover:underline disabled:opacity-50";
  return (
    <li className="flex flex-wrap items-baseline gap-x-2 text-sm">
      <span className="min-w-0 break-words text-ink">
        {who}
        {entry.isMine && entry.name && <span className="text-ink-muted"> (you)</span>}
        {entry.note && (who ? <> — {entry.note}</> : entry.note)}
        {entry.quantity > 1 && <span className="text-ink-muted"> ×{entry.quantity}</span>}
        {entry.email && <span className="text-ink-muted"> · {entry.email}</span>}
      </span>
      <span className="ml-auto flex gap-1">
        {entry.isMine && canChange && (
          <button
            type="button"
            className={`${small} text-accent`}
            onClick={onChange}
            disabled={busy}
          >
            Change
          </button>
        )}
        {entry.canRemove && (entry.isMine ? canChange : true) && (
          <button
            type="button"
            className={`${small} text-ink-muted hover:text-primary`}
            onClick={onRemove}
            disabled={busy}
          >
            Remove
          </button>
        )}
      </span>
    </li>
  );
}

/**
 * Every slot with its spots, and the ticket to claim one, change or remove.
 * Presentational: the caller says what a sign-up, change and removal do, so
 * the group card and the public page share it.
 *
 * A slot reads as a row of spots: people's initials where it is taken, dashed
 * "+" circles where it is open -- tap one to claim it. Dated slots carry a
 * tear-off calendar page, so a meal train reads like a calendar.
 */
export function SignupSlots({
  view,
  canSignUp,
  linkPeople,
  busy,
  error,
  formExtra,
  onCreate,
  onUpdate,
  onRemove,
}: {
  view: SignupView;
  canSignUp: boolean;
  linkPeople: boolean;
  busy: boolean;
  error: string | null;
  /** Fields put at the top of every sign-up form (the public page's name and email). */
  formExtra?: ReactNode;
  onCreate: (input: EntryInput) => Promise<unknown>;
  onUpdate: (entryId: string, input: Omit<EntryInput, "slotId">) => Promise<unknown>;
  onRemove: (entry: EntryView) => void;
}) {
  const [editing, setEditing] = useState<Editing>(null);
  const [showPast, setShowPast] = useState(false);
  const general = isGeneralOnly(view.slots);
  const own = view.slots.filter((s) => !s.isWriteIn);
  const writeIns = view.slots.filter((s) => s.isWriteIn);
  // Past dates fold away while the sign-up is still running.
  const past = view.closed ? [] : own.filter((s) => s.closed && s.date !== null);
  const visible = showPast ? own : own.filter((s) => !past.includes(s));
  const writeInsLeft = view.writeInMax === null ? null : view.writeInMax - view.writeInCount;
  const canWriteIn = canSignUp && !view.closed && view.writeInsEnabled && writeInsLeft !== 0;

  // A finished request closes its ticket; a failed one leaves it open with the error.
  const run = (promise: Promise<unknown>) =>
    void promise.then(() => setEditing(null)).catch(() => undefined);

  function slotRow(slot: SlotView): ReactNode {
    const left = spotsLeft(slot);
    const mine = slot.entries.find((e) => e.isMine);
    const fullTitle = general ? "Who's bringing what" : slotTitle(slot);
    // With a date tile, the tile says the date; the heading is just the name.
    const heading = slot.date ? slot.label : fullTitle;
    const claimable = canSignUp && !slot.closed && !mine && left !== 0 && !slot.isWriteIn;
    const claimOpen = editing?.kind === "slot" && editing.slotId === slot.id;
    const claim = claimable ? () => setEditing({ kind: "slot", slotId: slot.id }) : null;
    const claimLabel = `Sign up${fullTitle ? ` for ${fullTitle}` : ""}`;
    const editingEntry =
      editing?.kind === "entry" ? slot.entries.find((e) => e.id === editing.entryId) : undefined;
    const perSpot = slot.capacity !== null && slot.capacity <= SPOT_LIMIT && !slot.isWriteIn;
    const openCount = perSpot
      ? (left ?? 0)
      : claimable || (!slot.isWriteIn && left !== 0 && !slot.closed)
        ? 1
        : 0;
    // Lines only where they add something: a name, a note, or your own buttons.
    const lines = slot.entries.filter((e) => e.name || e.note || e.isMine || e.canRemove);
    // A one-person slot (a meal-train day, a flower Sunday) says who beside the
    // avatar rather than on a line of its own, so the row stays one tile tall.
    const inline = slot.entries.length === 1 && lines.length === 1 && openCount === 0;
    const lineFor = (entry: EntryView) =>
      editingEntry?.id === entry.id ? null : (
        <EntryLine
          key={entry.id}
          entry={entry}
          linkPeople={linkPeople}
          canChange={!slot.closed}
          busy={busy}
          onChange={() => setEditing({ kind: "entry", entryId: entry.id })}
          onRemove={() => onRemove(entry)}
        />
      );

    return (
      <li key={slot.id} className={`flex gap-3 py-3 ${slot.closed ? "opacity-70" : ""}`}>
        {slot.date && <DateTile date={slot.date} past={slot.closed} />}
        <div className="min-w-0 flex-1 space-y-2">
          <div className="flex items-center justify-between gap-3">
            {heading ? (
              <p className="min-w-0 break-words font-bold text-ink">
                {heading}
                {slot.isWriteIn && (
                  <span className="ml-2 align-middle text-xs font-bold uppercase tracking-wide text-accent">
                    Own item
                  </span>
                )}
              </p>
            ) : (
              <span />
            )}
            <p className="shrink-0 text-sm tabular-nums text-ink-muted">
              {slot.isWriteIn ? null : left === 0 ? (
                <span className="inline-flex items-center gap-1 rounded-full bg-accent/15 px-2 py-0.5 text-xs font-bold text-accent">
                  <CheckIcon className="h-3.5 w-3.5" />
                  Full
                </span>
              ) : slot.capacity === null ? (
                slot.taken > 0 ? (
                  `${slot.taken} signed up`
                ) : (
                  ""
                )
              ) : (
                `${slot.taken} of ${slot.capacity}`
              )}
            </p>
          </div>
          {slot.capacity !== null && !perSpot && !slot.isWriteIn && (
            <ProgressBar taken={slot.taken} capacity={slot.capacity} />
          )}
          <div className="flex flex-wrap items-center gap-2">
            {slot.entries.map((entry) => (
              <TakenSpot
                key={entry.id}
                entry={entry}
                onOpen={
                  entry.isMine && !slot.closed
                    ? () => setEditing({ kind: "entry", entryId: entry.id })
                    : null
                }
              />
            ))}
            {!claimOpen &&
              Array.from({ length: openCount }, (_, i) => (
                <OpenSpot
                  // Open spots are interchangeable; their place is their identity.
                  key={`open-${i}`}
                  label={claimLabel}
                  first={i === 0}
                  onClaim={claim}
                  text={
                    claim && i === openCount - 1 && openCount <= 2
                      ? slot.capacity === null
                        ? "Join"
                        : slot.entries.length === 0
                          ? "Take it"
                          : undefined
                      : undefined
                  }
                />
              ))}
            {slot.closed && slot.entries.length === 0 && (
              <span className="text-sm text-ink-muted">
                {view.closed ? "Closed" : "Date has passed"}
              </span>
            )}
            {inline && <ul className="min-w-0 flex-1">{lineFor(lines[0]!)}</ul>}
          </div>
          {!inline && lines.length > 0 && <ul className="space-y-0.5">{lines.map(lineFor)}</ul>}
          {editingEntry && (
            <ClaimTicket
              view={view}
              slot={slot}
              entry={editingEntry}
              writeIn={slot.isWriteIn}
              busy={busy}
              heading={`Your sign-up · ${fullTitle ?? "Change"}`}
              onCancel={() => setEditing(null)}
              onSubmit={(input) => run(onUpdate(editingEntry.id, input))}
            />
          )}
          {claimable && claimOpen && (
            <ClaimTicket
              view={view}
              slot={slot}
              entry={null}
              writeIn={false}
              busy={busy}
              extra={formExtra}
              heading={fullTitle ?? "Sign up"}
              onCancel={() => setEditing(null)}
              onSubmit={(input) => run(onCreate({ ...input, slotId: slot.id }))}
            />
          )}
        </div>
      </li>
    );
  }

  return (
    <div>
      {past.length > 0 && (
        <button type="button" className={linkButton} onClick={() => setShowPast((v) => !v)}>
          {showPast
            ? "Hide past dates"
            : `Show ${past.length} past ${past.length === 1 ? "date" : "dates"}`}
        </button>
      )}
      <ul className="divide-y divide-line" aria-label="Slots">
        {visible.map(slotRow)}
        {writeIns.map(slotRow)}
      </ul>
      {view.writeInsEnabled && !view.closed && (
        <div className="pt-2">
          {editing?.kind === "writeIn" ? (
            <ClaimTicket
              view={view}
              slot={null}
              entry={null}
              writeIn
              busy={busy}
              extra={formExtra}
              heading="Bring something else"
              onCancel={() => setEditing(null)}
              onSubmit={(input) => run(onCreate(input))}
            />
          ) : canWriteIn ? (
            <button
              type="button"
              onClick={() => setEditing({ kind: "writeIn" })}
              className="group flex w-full items-center gap-3 rounded-xl border-2 border-dashed border-accent/40 px-3 py-2 text-left transition hover:border-accent hover:bg-accent-light/20"
            >
              <span
                aria-hidden="true"
                className={`${SPOT} border-2 border-dashed border-accent/70 text-accent transition group-hover:scale-110 group-hover:bg-accent-light/40`}
              >
                <PlusIcon />
              </span>
              <span className="font-bold text-accent">Add your own item</span>
              {writeInsLeft !== null && (
                <span className="ml-auto text-sm text-ink-muted">{writeInsLeft} left</span>
              )}
            </button>
          ) : (
            writeInsLeft === 0 && (
              <p className="text-sm text-ink-muted">No more room for your own items.</p>
            )
          )}
        </div>
      )}
      {error && (
        <p role="alert" className="mt-2 text-sm font-bold text-primary">
          {error}
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sharing
// ---------------------------------------------------------------------------

/** Copy link, QR code and flyer for a sign-up -- the sign-up twin of useEventShare. */
export function useSignupShare(signup: GroupSignupDto | null, cancelled = false) {
  const { me } = useMe();
  const [qrOpen, setQrOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [flyerError, setFlyerError] = useState<string | null>(null);
  const url = signup ? signupShareUrl(signup.shareToken) : "";

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 2000);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const controls: ShareControls = {
    copied,
    flyerError,
    copyLink: () => {
      void navigator.clipboard?.writeText(url).then(() => setCopied(true));
    },
    openQr: () => setQrOpen(true),
    printFlyer: () => {
      if (!signup) return;
      setFlyerError(null);
      void downloadEventFlyer(
        {
          title: signup.title,
          description:
            [signup.description, signup.importantInfo].filter(Boolean).join("\n\n") || null,
          eventDate: "",
          startTime: null,
          endTime: null,
          location: null,
          organizationName: me?.organization?.name ?? "",
          cancelled,
          rows: signupFlyerRows(signup),
          callToAction: "Scan to sign up",
        },
        url
      ).catch(() => setFlyerError("Could not make the flyer. Try again."));
    },
    qrModal: signup ? (
      <EventQrModal open={qrOpen} onClose={() => setQrOpen(false)} url={url} title={signup.title} />
    ) : null,
  };
  return { url, ...controls };
}

// ---------------------------------------------------------------------------
// A sign-up in the conversation
// ---------------------------------------------------------------------------

function memberView(signup: GroupSignupDto): SignupView {
  return {
    noteMode: signup.noteMode,
    notePrompt: signup.notePrompt,
    writeInsEnabled: signup.writeInsEnabled,
    writeInMax: signup.writeInMax,
    writeInCount: signup.writeInCount,
    closed: signup.closed,
    slots: signup.slots.map((slot) => ({
      ...slot,
      entries: slot.entries.map((e) => ({
        id: e.id,
        quantity: e.quantity,
        note: e.note,
        name: e.name,
        personId: e.personId,
        isMine: e.isMine,
        canRemove: e.canRemove,
        email: e.email,
      })),
    })),
  };
}

/** Who is signed up overall: people, not quantities. */
function signedUpCount(signup: { slots: { entries: unknown[] }[] }): number {
  return signup.slots.reduce((sum, slot) => sum + slot.entries.length, 0);
}

/** The highlighted "good to know" box -- dietary restrictions, drop-off. */
export function ImportantInfo({ text }: { text: string }) {
  return (
    <div className="rounded-xl border border-accent/50 bg-accent-light/20 px-3 py-2 text-ink">
      <p className="text-xs font-bold uppercase tracking-wide text-ink-muted">Good to know</p>
      <p className="whitespace-pre-line break-words [overflow-wrap:anywhere]">
        <LinkifiedText text={text} />
      </p>
    </div>
  );
}

/**
 * A sign-up as a card: what it is and who it is for, the important-info box,
 * then every slot with its entries. Changes are live for everyone watching: an
 * entry moves the group's activity stamp (V39), which open pages poll for.
 *
 * The title opens the sign-up's own page, as an event card's header does.
 * With `page` it *is* that page's hero: the title set large and not a link,
 * and no share row -- the page has a share section of its own.
 */
export function SignupBlock({
  signup,
  groupId,
  postId,
  canSignUp,
  onChanged,
  wide = false,
  page = false,
}: {
  signup: GroupSignupDto;
  groupId: string;
  postId: string;
  /** The same rule as reacting: members of an active group. */
  canSignUp: boolean;
  onChanged: () => Promise<unknown>;
  wide?: boolean;
  /** The sign-up's own page, rather than a card in the conversation. */
  page?: boolean;
}) {
  const base = `/groups/${groupId}/posts/${postId}/signup/entries`;
  // Remembered so the sign-up page's way out returns to this tab, by popping this entry.
  const pageState = feedState(useLocation().pathname);
  const share = useSignupShare(signup);
  const [removing, setRemoving] = useState<EntryView | null>(null);
  const write = useMutation({
    mutationFn: (request: { path: string; method: string; body?: unknown }) =>
      api(request.path, { method: request.method, body: request.body }),
    onSuccess: async () => {
      await onChanged();
    },
  });
  const spec = templateSpec(signup.template);
  const count = signedUpCount(signup);

  return (
    <div
      className={
        page
          ? "overflow-hidden rounded-3xl border border-line bg-surface shadow-sm"
          : `mt-1 w-full ${wide ? "max-w-2xl" : "max-w-xl"} overflow-hidden rounded-2xl border border-line bg-surface shadow-sm`
      }
    >
      {page && <div className="h-2 bg-gradient-to-r from-primary via-primary-light to-accent" />}
      <div className={page ? "space-y-4 p-6 sm:p-8" : "space-y-3 p-4"}>
        <div>
          <p className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider text-accent">
            <SignupIcon />
            Sign-up{signup.template !== "CUSTOM" && ` · ${spec.name}`}
          </p>
          {page ? (
            <h1
              id="signup-title"
              className="mt-2 break-words text-3xl font-bold leading-tight tracking-tight text-ink sm:text-4xl"
            >
              {signup.title}
            </h1>
          ) : (
            <Link
              to={signupDetailPath(groupId, postId)}
              state={pageState}
              viewTransition
              className="group/title mt-1 block rounded-md focus-visible:outline-2 focus-visible:outline-accent"
            >
              <h3 className="break-words text-lg font-bold leading-snug text-ink group-hover/title:underline">
                {signup.title}
              </h3>
            </Link>
          )}
          {signup.recipient && (
            <p className="text-sm text-ink-muted">
              For{" "}
              <Link
                to={`/people/${signup.recipient.personId}`}
                className="font-bold text-accent hover:underline"
              >
                {signup.recipient.name}
              </Link>
            </p>
          )}
          {(signup.closesOn || signup.closed) && (
            <p className="text-sm text-ink-muted">
              {signup.closed
                ? "Sign-ups are closed"
                : `Sign up by ${formatDayLabel(signup.closesOn!)}`}
            </p>
          )}
        </div>
        {signup.description && (
          <p className="whitespace-pre-line break-words leading-snug text-ink [overflow-wrap:anywhere]">
            <LinkifiedText text={signup.description} />
          </p>
        )}
        {signup.importantInfo && <ImportantInfo text={signup.importantInfo} />}

        <SignupSlots
          view={memberView(signup)}
          canSignUp={canSignUp}
          linkPeople
          busy={write.isPending}
          error={write.error instanceof Error ? write.error.message : null}
          onCreate={(input) => write.mutateAsync({ path: base, method: "POST", body: input })}
          onUpdate={(entryId, input) =>
            write.mutateAsync({ path: `${base}/${entryId}`, method: "PATCH", body: input })
          }
          onRemove={(entry) =>
            entry.isMine
              ? write.mutate({ path: `${base}/${entry.id}`, method: "DELETE" })
              : setRemoving(entry)
          }
        />
      </div>

      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-t border-line bg-surface-muted/60 px-4 py-2">
        <span className="text-sm text-ink-muted">
          {count === 0 ? "Nobody yet" : `${count} ${count === 1 ? "entry" : "entries"}`}
          {signup.publicEnabled && " · Public"}
        </span>
        {!page && <ShareButtons share={share} />}
      </div>

      {removing && (
        <ConfirmDialog
          title="Remove this entry?"
          confirmLabel="Remove it"
          busy={write.isPending}
          onClose={() => setRemoving(null)}
          onConfirm={() => {
            write.mutate({ path: `${base}/${removing.id}`, method: "DELETE" });
            setRemoving(null);
          }}
        >
          <p>
            {removing.name ?? "This person"}'s entry
            {removing.note ? ` (${removing.note})` : ""} will be taken off the sign-up.
          </p>
        </ConfirmDialog>
      )}
    </div>
  );
}

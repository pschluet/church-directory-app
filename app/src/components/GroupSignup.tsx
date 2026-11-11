import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { useMutation } from "@tanstack/react-query";
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
import { formatDayLabel } from "../lib/format";
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
        placeholder={dated ? "Name (optional)" : "e.g. Dessert"}
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
            placeholder="What are people signing up for?"
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

/**
 * The little form under a slot. Only the fields that apply: a name for a
 * write-in, a quantity when there is room for more than one, a note when the
 * organizer asked for one. `extra` is the public page's name and email.
 */
function EntryForm({
  view,
  slot,
  entry,
  writeIn,
  busy,
  extra,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  view: SignupView;
  slot: SlotView | null;
  entry: EntryView | null;
  writeIn: boolean;
  busy: boolean;
  extra?: ReactNode;
  submitLabel: string;
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
      className="mt-2 space-y-3 rounded-xl border border-accent/40 bg-accent-light/10 p-3"
    >
      {extra}
      {writeIn && (
        <Field label="What are you bringing?">
          <input
            className={inputClass}
            value={label}
            maxLength={GROUP_SIGNUP_SLOT_LABEL_MAX}
            placeholder="Be specific, e.g. Chocolate gold coins"
            onChange={(e) => setLabel(e.target.value)}
            autoFocus={!extra}
          />
        </Field>
      )}
      {(askQuantity || askNote) && (
        <div className={`grid gap-2 ${askQuantity && askNote ? "grid-cols-[5rem_1fr]" : ""}`}>
          {askQuantity && (
            <Field label="How many">
              <input
                type="number"
                min={1}
                max={room ?? GROUP_SIGNUP_MAX_CAPACITY}
                className={`${inputClass} px-2 text-center`}
                value={quantity}
                onChange={(e) => setQuantity(e.target.value)}
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
        </div>
      )}
      {room !== null && askQuantity && (
        <p className="text-sm text-ink-muted">
          {room} {room === 1 ? "spot" : "spots"} left
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={!valid || busy}>
          {busy ? "Saving…" : submitLabel}
        </Button>
        <Button variant="ghost" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
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
  ) : (
    <span className="font-bold text-ink">{entry.isMine ? "You" : "Taken"}</span>
  );
  return (
    <li
      className={`flex flex-wrap items-baseline gap-x-2 gap-y-0.5 rounded-lg px-2 py-1 ${
        entry.isMine ? "bg-primary/10" : ""
      }`}
    >
      <span className="min-w-0 break-words">
        {who}
        {entry.isMine && entry.name && <span className="text-ink-muted"> (you)</span>}
        {entry.note && <span className="text-ink"> — {entry.note}</span>}
        {entry.quantity > 1 && <span className="text-ink-muted"> ×{entry.quantity}</span>}
        {entry.email && <span className="text-sm text-ink-muted"> · {entry.email}</span>}
      </span>
      <span className="ml-auto flex gap-1">
        {entry.isMine && canChange && (
          <button type="button" className={linkButton} onClick={onChange} disabled={busy}>
            Change
          </button>
        )}
        {entry.canRemove && (entry.isMine ? canChange : true) && (
          <button
            type="button"
            className="inline-flex items-center rounded-md px-1 py-1 text-sm font-bold text-ink-muted hover:text-primary hover:underline"
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
 * Every slot with its entries, and the forms to sign up, change or remove.
 * Presentational: the caller says what a sign-up, change and removal do, so
 * the group card and the public page share it.
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

  // A finished request closes its form; a failed one leaves it open with the error.
  const run = (promise: Promise<unknown>) =>
    void promise.then(() => setEditing(null)).catch(() => undefined);

  function slotRow(slot: SlotView): ReactNode {
    const left = spotsLeft(slot);
    const mine = slot.entries.find((e) => e.isMine);
    const title = general ? "Who's bringing what" : slotTitle(slot);
    const open = canSignUp && !slot.closed && !mine && left !== 0 && !slot.isWriteIn;
    const formOpen = editing?.kind === "slot" && editing.slotId === slot.id;
    const editingEntry =
      editing?.kind === "entry" ? slot.entries.find((e) => e.id === editing.entryId) : undefined;
    return (
      <li key={slot.id} className={`space-y-1.5 py-3 ${slot.closed ? "opacity-70" : ""}`}>
        <div className="flex items-center justify-between gap-3">
          <p className="min-w-0 break-words font-bold text-ink">
            {title}
            {slot.isWriteIn && (
              <span className="ml-2 align-middle text-xs font-bold uppercase tracking-wide text-accent">
                Own item
              </span>
            )}
          </p>
          <div className="flex shrink-0 items-center gap-3">
            <p className="shrink-0 text-sm tabular-nums text-ink-muted">
              {slot.isWriteIn
                ? `×${slot.capacity ?? 1}`
                : slot.capacity === null
                  ? slot.taken > 0
                    ? `${slot.taken} signed up`
                    : ""
                  : left === 0
                    ? "Full"
                    : `${slot.taken} of ${slot.capacity}`}
            </p>
            {open && !formOpen && (
              <Button
                variant="secondary"
                className="!px-3 !py-1 text-sm"
                onClick={() => setEditing({ kind: "slot", slotId: slot.id })}
                aria-label={`Sign up${title ? ` for ${title}` : ""}`}
              >
                Sign up
              </Button>
            )}
          </div>
        </div>
        {slot.capacity !== null && !slot.isWriteIn && slot.capacity > 1 && (
          <ProgressBar taken={slot.taken} capacity={slot.capacity} />
        )}
        {slot.entries.length > 0 && (
          <ul className="space-y-0.5">
            {slot.entries.map((entry) =>
              editingEntry?.id === entry.id ? (
                <li key={entry.id}>
                  <EntryForm
                    view={view}
                    slot={slot}
                    entry={entry}
                    writeIn={slot.isWriteIn}
                    busy={busy}
                    submitLabel="Save"
                    onCancel={() => setEditing(null)}
                    onSubmit={(input) => run(onUpdate(entry.id, input))}
                  />
                </li>
              ) : (
                <EntryLine
                  key={entry.id}
                  entry={entry}
                  linkPeople={linkPeople}
                  canChange={!slot.closed}
                  busy={busy}
                  onChange={() => setEditing({ kind: "entry", entryId: entry.id })}
                  onRemove={() => onRemove(entry)}
                />
              )
            )}
          </ul>
        )}
        {slot.closed && slot.entries.length === 0 && (
          <p className="text-sm text-ink-muted">{view.closed ? "Closed" : "Date has passed"}</p>
        )}
        {open && formOpen && (
          <EntryForm
            view={view}
            slot={slot}
            entry={null}
            writeIn={false}
            busy={busy}
            extra={formExtra}
            submitLabel="Sign up"
            onCancel={() => setEditing(null)}
            onSubmit={(input) => run(onCreate({ ...input, slotId: slot.id }))}
          />
        )}
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
        <div className="border-t border-line pt-3">
          {editing?.kind === "writeIn" ? (
            <EntryForm
              view={view}
              slot={null}
              entry={null}
              writeIn
              busy={busy}
              extra={formExtra}
              submitLabel="Add it"
              onCancel={() => setEditing(null)}
              onSubmit={(input) => run(onCreate(input))}
            />
          ) : canWriteIn ? (
            <button
              type="button"
              className={linkButton}
              onClick={() => setEditing({ kind: "writeIn" })}
            >
              <PlusIcon />
              Add your own item
              {writeInsLeft !== null && (
                <span className="font-normal text-ink-muted">({writeInsLeft} left)</span>
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
 */
export function SignupBlock({
  signup,
  groupId,
  postId,
  canSignUp,
  onChanged,
  wide = false,
}: {
  signup: GroupSignupDto;
  groupId: string;
  postId: string;
  /** The same rule as reacting: members of an active group. */
  canSignUp: boolean;
  onChanged: () => Promise<unknown>;
  wide?: boolean;
}) {
  const base = `/groups/${groupId}/posts/${postId}/signup/entries`;
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
      className={`mt-1 w-full ${wide ? "max-w-2xl" : "max-w-xl"} overflow-hidden rounded-2xl border border-line bg-surface shadow-sm`}
    >
      <div className="space-y-3 p-4">
        <div>
          <p className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider text-accent">
            <SignupIcon />
            Sign-up{signup.template !== "CUSTOM" && ` · ${spec.name}`}
          </p>
          <h3 className="mt-1 break-words text-lg font-bold leading-snug text-ink">
            {signup.title}
          </h3>
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
        <ShareButtons share={share} />
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

import { useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import {
  GROUP_POLL_MAX_OPTIONS,
  GROUP_POLL_MIN_OPTIONS,
  GROUP_POLL_OPTION_MAX,
  GROUP_POLL_QUESTION_MAX,
  type GroupPollDto,
} from "@shared";
import { api } from "../lib/api";
import { Link } from "./nav";
import { Button, Field, Modal, inputClass } from "./ui";

/**
 * Polls in a group: the form that starts one, from the message bar's `+` menu,
 * and the card that shows one in the conversation with its results.
 *
 * Results are always visible, before and after voting, and change live: a vote
 * moves the group's activity stamp (V31__group_polls.sql), which every open
 * page is already polling for (useGroupLive).
 */

// ---------------------------------------------------------------------------
// Starting a poll
// ---------------------------------------------------------------------------

/** The options as they will be sent: trimmed, blanks dropped. */
export function cleanPollOptions(options: readonly string[]): string[] {
  return options.map((o) => o.trim()).filter((o) => o !== "");
}

function hasDuplicates(options: readonly string[]): boolean {
  return new Set(options.map((o) => o.toLowerCase())).size !== options.length;
}

/**
 * A modal rather than a form in the message bar, for the same reason the event
 * one is: the bar stays one line. It opens with two empty options, the fewest a
 * poll can have; Enter in the last one adds another, as in a list editor.
 */
export function PollComposerModal({
  groupId,
  onClose,
  onPosted,
}: {
  groupId: string;
  onClose: () => void;
  onPosted: () => Promise<unknown>;
}) {
  const [question, setQuestion] = useState("");
  const [options, setOptions] = useState<string[]>(["", ""]);
  const [allowsMultiple, setAllowsMultiple] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputs = useRef<(HTMLInputElement | null)[]>([]);
  /** The option to focus once it has rendered -- a new one, or the neighbour of a removed one. */
  const focusNext = useRef<number | null>(null);

  const cleaned = cleanPollOptions(options);
  const duplicate = hasDuplicates(cleaned);
  const canSubmit =
    question.trim() !== "" && cleaned.length >= GROUP_POLL_MIN_OPTIONS && !duplicate;
  const canAdd = options.length < GROUP_POLL_MAX_OPTIONS;

  function setOption(index: number, value: string): void {
    setOptions((previous) => previous.map((o, i) => (i === index ? value : o)));
  }
  function addOption(): void {
    if (!canAdd) return;
    focusNext.current = options.length;
    setOptions((previous) => [...previous, ""]);
  }
  function removeOption(index: number): void {
    focusNext.current = Math.max(0, index - 1);
    setOptions((previous) => previous.filter((_, i) => i !== index));
  }

  async function submit(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await api(`/groups/${groupId}/posts`, {
        method: "POST",
        body: {
          kind: "POLL",
          attachments: [],
          poll: { question: question.trim(), options: cleaned, allowsMultiple },
        },
      });
      await onPosted();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not post that");
      setBusy(false);
    }
  }

  return (
    <Modal title="New poll" onClose={onClose}>
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (canSubmit && !busy) void submit();
        }}
      >
        <Field label="Question">
          <input
            className={inputClass}
            value={question}
            maxLength={GROUP_POLL_QUESTION_MAX}
            placeholder="What would you like to ask?"
            onChange={(event) => setQuestion(event.target.value)}
            autoFocus
          />
        </Field>

        <fieldset>
          <legend className="mb-1 font-bold text-ink">Options</legend>
          <ol className="space-y-2">
            {options.map((option, index) => (
              // Options have no identity but their place. The inputs are
              // controlled, so a removal that shifts the keys loses nothing.
              <li key={index} className="flex items-center gap-2">
                <ChoiceMark multiple={allowsMultiple} selected={false} />
                <input
                  ref={(el) => {
                    inputs.current[index] = el;
                    if (el && focusNext.current === index) {
                      focusNext.current = null;
                      el.focus();
                    }
                  }}
                  className={inputClass}
                  value={option}
                  maxLength={GROUP_POLL_OPTION_MAX}
                  placeholder={`Option ${index + 1}`}
                  aria-label={`Option ${index + 1}`}
                  onChange={(event) => setOption(index, event.target.value)}
                  onKeyDown={(event) => {
                    // Enter moves on to the next option, adding one at the end;
                    // it never submits from here, half-way through a list.
                    if (event.key !== "Enter") return;
                    event.preventDefault();
                    if (index < options.length - 1) inputs.current[index + 1]?.focus();
                    else if (option.trim() !== "") addOption();
                  }}
                />
                {options.length > GROUP_POLL_MIN_OPTIONS && (
                  <button
                    type="button"
                    aria-label={`Remove option ${index + 1}`}
                    onClick={() => removeOption(index)}
                    className="tap-target inline-flex shrink-0 items-center justify-center rounded-full text-ink-muted transition hover:bg-surface-muted hover:text-primary"
                  >
                    <svg aria-hidden="true" viewBox="0 0 20 20" className="h-4 w-4 fill-current">
                      <path d="M5.3 5.3a1 1 0 0 1 1.4 0L10 8.6l3.3-3.3a1 1 0 1 1 1.4 1.4L11.4 10l3.3 3.3a1 1 0 0 1-1.4 1.4L10 11.4l-3.3 3.3a1 1 0 0 1-1.4-1.4L8.6 10 5.3 6.7a1 1 0 0 1 0-1.4Z" />
                    </svg>
                  </button>
                )}
              </li>
            ))}
          </ol>
          {canAdd ? (
            <button
              type="button"
              onClick={addOption}
              className="mt-2 inline-flex items-center gap-1.5 rounded-md px-1 py-1 text-sm font-bold text-accent hover:underline"
            >
              <svg aria-hidden="true" viewBox="0 0 20 20" className="h-4 w-4 fill-current">
                <path d="M10 3a1 1 0 0 1 1 1v5h5a1 1 0 1 1 0 2h-5v5a1 1 0 1 1-2 0v-5H4a1 1 0 1 1 0-2h5V4a1 1 0 0 1 1-1Z" />
              </svg>
              Add option
            </button>
          ) : (
            <p className="mt-2 text-sm text-ink-muted">
              A poll can have up to {GROUP_POLL_MAX_OPTIONS} options.
            </p>
          )}
          {duplicate && (
            <p role="alert" className="mt-1 text-sm font-bold text-primary">
              Each option must be different.
            </p>
          )}
        </fieldset>

        <div>
          <p id="poll-choice-mode" className="mb-1 font-bold text-ink">
            People can choose
          </p>
          <div
            role="group"
            aria-labelledby="poll-choice-mode"
            className="grid grid-cols-2 overflow-hidden rounded-xl border border-line bg-surface"
          >
            {[
              { multiple: false, label: "One option" },
              { multiple: true, label: "Several options" },
            ].map(({ multiple, label }) => {
              const active = allowsMultiple === multiple;
              return (
                <button
                  key={label}
                  type="button"
                  aria-pressed={active}
                  onClick={() => setAllowsMultiple(multiple)}
                  className={`flex items-center justify-center gap-2 border-l border-line px-3 py-2.5 text-sm font-bold transition first:border-l-0 ${
                    active ? "bg-primary text-white" : "text-ink hover:bg-surface-muted"
                  }`}
                >
                  <ChoiceMark multiple={multiple} selected={active} inverted={active} />
                  {label}
                </button>
              );
            })}
          </div>
        </div>

        {error && (
          <p role="alert" className="text-sm font-bold text-primary">
            {error}
          </p>
        )}
        <div className="flex flex-col gap-2 sm:flex-row">
          <Button type="submit" disabled={busy || !canSubmit}>
            {busy ? "Posting…" : "Post poll"}
          </Button>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
        </div>
      </form>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// A poll in the conversation
// ---------------------------------------------------------------------------

/**
 * A radio (one choice) or a checkbox (several), drawn rather than native so it
 * can sit inside a button. `inverted` is for a dark background.
 */
function ChoiceMark({
  multiple,
  selected,
  inverted = false,
}: {
  multiple: boolean;
  selected: boolean;
  inverted?: boolean;
}) {
  const shape = multiple ? "rounded-md" : "rounded-full";
  const tone = inverted
    ? "border-white bg-white text-primary"
    : selected
      ? "border-primary bg-primary text-white"
      : "border-ink-muted/40 bg-surface text-transparent";
  return (
    <span
      aria-hidden="true"
      className={`inline-flex size-5 shrink-0 items-center justify-center border-2 transition ${shape} ${tone}`}
    >
      <svg aria-hidden="true" viewBox="0 0 20 20" className="h-3.5 w-3.5 fill-current">
        <path d="M16.7 5.3a1 1 0 0 1 0 1.4l-8 8a1 1 0 0 1-1.4 0l-4-4a1 1 0 1 1 1.4-1.4L8 12.6l7.3-7.3a1 1 0 0 1 1.4 0Z" />
      </svg>
    </span>
  );
}

function PollIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20" className="h-4 w-4 fill-current">
      <rect x="2" y="3" width="11" height="3.5" rx="1.75" />
      <rect x="2" y="8.25" width="16" height="3.5" rx="1.75" />
      <rect x="2" y="13.5" width="7" height="3.5" rx="1.75" />
    </svg>
  );
}

/** Whole percent of voters who picked an option; 0 with no voters. */
export function pollPercent(votes: number, voters: number): number {
  return voters === 0 ? 0 : Math.round((votes / voters) * 100);
}

/**
 * The poll as the caller will see it once `mine` is their ballot: what the card
 * shows while a vote is on its way, so a tap answers at once rather than after
 * the round trip.
 */
export function withBallot(poll: GroupPollDto, mine: readonly string[]): GroupPollDto {
  const hadVoted = poll.options.some((o) => o.votedByMe);
  const willVote = mine.length > 0;
  return {
    ...poll,
    voterCount: poll.voterCount - (hadVoted ? 1 : 0) + (willVote ? 1 : 0),
    options: poll.options.map((option) => {
      const picked = mine.includes(option.id);
      return {
        ...option,
        votedByMe: picked,
        voteCount: option.voteCount - (option.votedByMe ? 1 : 0) + (picked ? 1 : 0),
      };
    }),
  };
}

/**
 * A poll, as a card: the question, then each option as a bar filling to its
 * share of the voters, with a percentage. Tapping an option votes for it;
 * tapping your own choice again takes it back. On a multiple-choice poll each
 * option toggles on its own. The line at the foot opens who voted for what.
 */
export function PollBlock({
  poll: served,
  groupId,
  postId,
  canVote,
  onChanged,
  wide = false,
}: {
  poll: GroupPollDto;
  groupId: string;
  postId: string;
  /** Whether the caller may vote here -- the same rule as reacting. */
  canVote: boolean;
  onChanged: () => Promise<unknown>;
  wide?: boolean;
}) {
  const [pending, setPending] = useState<string[] | null>(null);
  const [showVoters, setShowVoters] = useState(false);
  const vote = useMutation({
    mutationFn: (optionIds: string[]) =>
      api(`/groups/${groupId}/posts/${postId}/vote`, { method: "PUT", body: { optionIds } }),
    onSettled: async () => {
      await onChanged();
      setPending(null);
    },
  });

  const poll = pending ? withBallot(served, pending) : served;
  const mine = poll.options.filter((o) => o.votedByMe).map((o) => o.id);
  const leading = Math.max(0, ...poll.options.map((o) => o.voteCount));

  function choose(optionId: string): void {
    if (!canVote || vote.isPending) return;
    const picked = mine.includes(optionId);
    const next = poll.allowsMultiple
      ? picked
        ? mine.filter((id) => id !== optionId)
        : [...mine, optionId]
      : picked
        ? []
        : [optionId];
    setPending(next);
    vote.mutate(next);
  }

  return (
    <div
      className={`mt-1 w-full ${wide ? "max-w-2xl" : "max-w-xl"} overflow-hidden rounded-2xl border border-line bg-surface shadow-sm`}
    >
      <div className="space-y-3 p-4">
        <div>
          <p className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider text-accent">
            <PollIcon />
            Poll · {poll.allowsMultiple ? "Choose any" : "Choose one"}
          </p>
          <h3 className="mt-1 break-words text-lg font-bold leading-snug text-ink">
            {poll.question}
          </h3>
        </div>

        <ul className="space-y-2" aria-label="Options">
          {poll.options.map((option) => {
            const percent = pollPercent(option.voteCount, poll.voterCount);
            const isLeading = option.voteCount > 0 && option.voteCount === leading;
            return (
              <li key={option.id}>
                <button
                  type="button"
                  aria-pressed={option.votedByMe}
                  aria-label={`${option.label}, ${option.voteCount} ${
                    option.voteCount === 1 ? "vote" : "votes"
                  }, ${percent}%`}
                  disabled={!canVote}
                  onClick={() => choose(option.id)}
                  className={`relative block w-full overflow-hidden rounded-xl border text-left transition disabled:cursor-default ${
                    option.votedByMe
                      ? "border-primary/70"
                      : "border-line enabled:hover:border-accent"
                  }`}
                >
                  <span
                    aria-hidden="true"
                    className={`absolute inset-y-0 left-0 transition-[width] duration-500 ease-out ${
                      option.votedByMe
                        ? "bg-primary/15"
                        : isLeading
                          ? "bg-accent-light/50"
                          : "bg-surface-muted"
                    }`}
                    style={{ width: `${percent}%` }}
                  />
                  <span className="relative flex items-center gap-3 px-3 py-2.5">
                    {canVote && (
                      <ChoiceMark multiple={poll.allowsMultiple} selected={option.votedByMe} />
                    )}
                    <span
                      className={`min-w-0 flex-1 break-words leading-snug text-ink ${
                        option.votedByMe ? "font-bold" : ""
                      }`}
                    >
                      {option.label}
                    </span>
                    <span
                      className={`shrink-0 text-sm tabular-nums ${
                        option.votedByMe ? "font-bold text-primary" : "text-ink-muted"
                      }`}
                    >
                      {percent}%
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-t border-line bg-surface-muted/60 px-4 py-2.5 text-sm">
        <button
          type="button"
          onClick={() => setShowVoters(true)}
          disabled={poll.voterCount === 0}
          className="font-bold text-accent enabled:hover:underline disabled:text-ink-muted"
        >
          {poll.voterCount === 0
            ? "No votes yet"
            : `${poll.voterCount} ${poll.voterCount === 1 ? "person" : "people"} voted`}
        </button>
        {canVote && (
          <span className="text-ink-muted">
            {mine.length > 0
              ? poll.allowsMultiple
                ? "Tap to change your choices"
                : "Tap your choice again to remove it"
              : poll.allowsMultiple
                ? "Select all that apply"
                : "Tap an option to vote"}
          </span>
        )}
      </div>

      {vote.isError && (
        <p role="alert" className="border-t border-line px-4 py-2 text-sm font-bold text-primary">
          {vote.error instanceof Error ? vote.error.message : "Could not record that vote"}
        </p>
      )}

      {showVoters && <PollVotersModal poll={poll} onClose={() => setShowVoters(false)} />}
    </div>
  );
}

/** Who voted for what, option by option -- the poll card's results with names. */
function PollVotersModal({ poll, onClose }: { poll: GroupPollDto; onClose: () => void }) {
  return (
    <Modal title="Votes" onClose={onClose}>
      <div className="space-y-4">
        <p className="font-bold text-ink">{poll.question}</p>
        {poll.options.map((option) => (
          <div key={option.id}>
            <p className="mb-1 flex items-baseline justify-between gap-2 font-bold text-ink">
              <span className="min-w-0 break-words">{option.label}</span>
              <span className="shrink-0 text-sm font-normal text-ink-muted">
                {option.voteCount} {option.voteCount === 1 ? "vote" : "votes"}
              </span>
            </p>
            {option.voters.length === 0 ? (
              <p className="text-sm text-ink-muted">Nobody yet</p>
            ) : (
              <ul className="flex flex-wrap gap-1.5">
                {option.voters.map((voter) => (
                  <li key={voter.personId}>
                    <Link
                      to={`/people/${voter.personId}`}
                      className="inline-block rounded-full bg-surface-muted px-2.5 py-1 text-sm text-ink hover:text-accent hover:underline"
                    >
                      {voter.name}
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ))}
      </div>
    </Modal>
  );
}

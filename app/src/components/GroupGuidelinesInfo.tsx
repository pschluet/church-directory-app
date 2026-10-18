import { useState } from "react";
import { GROUP_GUIDELINES } from "@shared";
import { useMe } from "../context/MeContext";
import { Modal } from "./ui";

/** The guidelines as a numbered list, shared by the gate and the reference pop-up. */
export function GroupGuidelinesList() {
  return (
    <ol className="list-decimal space-y-2 pl-5">
      {GROUP_GUIDELINES.map((guideline) => (
        <li key={guideline.title}>
          <span className="font-bold text-ink">{guideline.title}:</span>{" "}
          <span className="text-ink-muted">{guideline.body}</span>
        </li>
      ))}
    </ol>
  );
}

/**
 * An info button beside the Groups title that reopens the guidelines for
 * reference, with the date the member agreed to them. A Modal rather than an
 * InfoPopover: nine guidelines are too long for a note anchored under an icon.
 */
export function GroupGuidelinesInfo() {
  const { me } = useMe();
  const [open, setOpen] = useState(false);
  const agreedAt = me?.groupGuidelinesAgreedAt;

  return (
    <>
      <button
        type="button"
        aria-label="View group guidelines"
        className="tap-target inline-flex items-center justify-center text-ink-muted transition hover:text-accent"
        onClick={() => setOpen(true)}
      >
        <svg aria-hidden="true" viewBox="0 0 20 20" className="h-5 w-5 fill-current">
          <path d="M10 2a8 8 0 1 0 0 16 8 8 0 0 0 0-16Zm0 1.5a6.5 6.5 0 1 1 0 13 6.5 6.5 0 0 1 0-13ZM9 8.5h2v6H9v-6Zm0-3h2v2H9v-2Z" />
        </svg>
      </button>
      {open && (
        <Modal title="Group Guidelines" onClose={() => setOpen(false)}>
          <div className="space-y-4">
            <p className="text-ink-muted">
              {agreedAt
                ? `These are the group guidelines you agreed to on ${new Date(
                    agreedAt
                  ).toLocaleDateString(undefined, {
                    month: "long",
                    day: "numeric",
                    year: "numeric",
                  })}.`
                : "These are the group guidelines for using the groups page."}
            </p>
            <GroupGuidelinesList />
          </div>
        </Modal>
      )}
    </>
  );
}

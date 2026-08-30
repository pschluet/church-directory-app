import type { InheritableAttribute, PersonSummaryDto } from "@shared";

/**
 * "A Person that is a member of a family can choose to inherit the following
 * attributes from another family member."
 *
 * One of these sits above each inheritable field. When it is on, the field
 * below is disabled and shows the source's value, so it is obvious where the
 * data is coming from and that editing it here would be pointless.
 *
 * Only family members who do not themselves inherit the same attribute are
 * offered: the API allows one hop, so that no cycle can form and the resolution
 * view's single join always finds a real value.
 */
export function InheritToggle({
  attribute,
  label,
  candidates,
  sourceId,
  onChange,
  disabled,
}: {
  attribute: InheritableAttribute;
  label: string;
  candidates: PersonSummaryDto[];
  sourceId: string | null;
  onChange: (sourceId: string | null) => void;
  disabled?: boolean;
}) {
  if (candidates.length === 0) return null;

  const checked = sourceId !== null;
  const inputId = `inherit-${attribute}`;

  return (
    <div className="mb-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
      <label className="tap-target inline-flex items-center gap-2">
        <input
          id={inputId}
          type="checkbox"
          checked={checked}
          disabled={disabled}
          onChange={(event) => onChange(event.target.checked ? (candidates[0]?.id ?? null) : null)}
          className="h-4 w-4 accent-primary"
        />
        <span className="text-ink-muted">Same {label} as</span>
      </label>

      <select
        aria-label={`Whose ${label} to use`}
        value={sourceId ?? ""}
        disabled={!checked || disabled}
        onChange={(event) => onChange(event.target.value || null)}
        className="tap-target rounded-md border border-line bg-surface px-2 py-1 disabled:opacity-50"
      >
        {!checked && <option value="">choose…</option>}
        {candidates.map((candidate) => (
          <option key={candidate.id} value={candidate.id}>
            {candidate.firstName} {candidate.lastName ?? ""}
          </option>
        ))}
      </select>
    </div>
  );
}

/**
 * Family members who can act as a source for `attribute`: everyone else in the
 * family who is not already inheriting it.
 */
export function inheritanceCandidates(
  attribute: InheritableAttribute,
  personId: string,
  familyMembers: PersonSummaryDto[],
  inheritingMembers: Map<string, Set<InheritableAttribute>>
): PersonSummaryDto[] {
  return familyMembers.filter(
    (member) => member.id !== personId && !inheritingMembers.get(member.id)?.has(attribute)
  );
}

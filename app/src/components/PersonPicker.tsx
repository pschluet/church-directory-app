import type { PersonLookupDto } from "@shared";
import { api } from "../lib/api";
import { qk } from "../lib/queryKeys";
import { useMe } from "../context/MeContext";
import { LookupPicker } from "./LookupPicker";

/**
 * Choosing one person out of the parish by typing.
 *
 * The plain <select> this replaces listed everyone, which meant scrolling a
 * few hundred options -- a full-screen wheel on a phone -- and it was capped at
 * the first 200 people with nothing on screen to say so. Matching happens on
 * the server (`GET /api/directory/lookup`) rather than over a preloaded array,
 * which is what lifts that cap.
 *
 * The combobox itself is `LookupPicker`; this is the directory it searches.
 */

export interface PickedPerson {
  id: string;
  name: string;
}

export function PersonPicker({
  label,
  hint,
  value,
  onChange,
  excludePersonId,
  accounts,
  placeholder = "Start typing a name…",
}: {
  label: string;
  hint?: string;
  value: PickedPerson | null;
  onChange: (person: PickedPerson | null) => void;
  /** Whoever the picker is for, so they cannot be picked as their own partner. */
  excludePersonId?: string;
  /**
   * Narrows the list to one side of the account divide. The merge forms need
   * this: only an account holder can be the surviving record, and only someone
   * without an account can be the duplicate.
   */
  accounts?: "only" | "none";
  placeholder?: string;
}) {
  const { organizationId } = useMe();

  return (
    <LookupPicker
      label={label}
      hint={hint}
      placeholder={placeholder}
      value={value}
      onChange={(option) => onChange(option && { id: option.id, name: option.name })}
      queryKey={(term) => qk.directoryLookup(organizationId, term, excludePersonId, accounts)}
      fetchOptions={async (term, signal) => {
        const { people } = await api<{ people: PersonLookupDto[] }>("/directory/lookup", {
          signal,
          query: { q: term, exclude: excludePersonId, accounts },
        });
        return people.map((person) => ({
          id: person.id,
          name: person.name,
          detail: person.familyName ? `${person.familyName} family` : null,
        }));
      }}
    />
  );
}

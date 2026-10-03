import type { FamilySummaryDto } from "@shared";
import { searchTerms } from "@shared";
import { matchesTerm } from "../lib/highlight";
import { useMe } from "../context/MeContext";
import { qk } from "../lib/queryKeys";
import { LookupPicker, type PickedOption } from "./LookupPicker";

/**
 * Choosing one family out of the parish by typing.
 *
 * Unlike `PersonPicker`, this searches the list the host page has already
 * loaded rather than the server: `GET /families` returns every family in the
 * parish unpaginated -- the families page needs the whole thing anyway, and a
 * parish has far fewer families than people, the same scale argument that
 * page's own search box already rests on. A second request for data already
 * in hand would be the wrong kind of consistency with `PersonPicker`.
 *
 * The combobox itself is `LookupPicker`; this just searches an array instead
 * of an endpoint, with the exact same AND-every-term matching the families
 * page's search box uses, so "pick a family here" and "search for it on the
 * page" never disagree about what counts as a match.
 */

export interface PickedFamily {
  id: string;
  name: string;
}

export function FamilyPicker({
  label,
  hint,
  value,
  onChange,
  families,
  excludeFamilyIds = [],
  placeholder = "Start typing a family name…",
  emptyLabel = "No families to choose from",
}: {
  label: string;
  hint?: string;
  value: PickedFamily | null;
  onChange: (family: PickedFamily | null) => void;
  /** Already loaded by the page that hosts this picker. */
  families: FamilySummaryDto[];
  /** Left out of the results entirely -- the caller's own family, say, or one they are already waiting on. */
  excludeFamilyIds?: string[];
  placeholder?: string;
  emptyLabel?: string;
}) {
  const { organizationId } = useMe();
  const excluded = new Set(excludeFamilyIds);
  const candidates = families.filter((family) => !excluded.has(family.id));
  // Part of the query key, not just a filter applied after: the underlying
  // list is a prop that can change (a family created, a request resolved)
  // while the typed term does not, and the cache would otherwise not know to
  // recompute -- see the comment on qk.familyLookup.
  const candidateIds = candidates.map((family) => family.id);

  return (
    <LookupPicker<PickedOption>
      label={label}
      hint={hint}
      placeholder={placeholder}
      emptyLabel={emptyLabel}
      noMatchLabel={(term) => `No family matches “${term}”`}
      value={value}
      onChange={(option) => onChange(option && { id: option.id, name: option.name })}
      queryKey={(term) => qk.familyLookup(organizationId, term, candidateIds)}
      fetchOptions={(term) => {
        const terms = searchTerms(term).map((t) => t.toLowerCase());
        const matches =
          terms.length === 0
            ? candidates
            : candidates.filter((family) => terms.every((t) => matchesTerm(family.name, t)));
        return Promise.resolve(
          matches.map((family) => ({
            id: family.id,
            name: family.name,
            detail:
              family.memberNames.length > 0 ? family.memberNames.join(", ") : "No members yet",
          }))
        );
      }}
    />
  );
}

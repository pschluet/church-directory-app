import { photoUrls } from "../photos";
import { fullName, type ReactionDto } from "../types";

/**
 * Emoji reactions, as group posts and prayer requests both carry them. Each has
 * its own table (V22, V28) -- one row per (target, person, emoji) -- but the
 * same shape on the wire, so the SPA renders both with one set of components.
 */

export interface ReactorRow {
  appUserId: string;
  personId: string;
  firstName: string;
  lastName: string | null;
  /** Only selected when `withPhotos` is passed to `reactionsSubselect`. */
  photoKey?: string | null;
}

export interface ReactionRow {
  emoji: string;
  reactors: ReactorRow[];
}

/**
 * A scalar subquery yielding a target's reactions as one JSON column: emoji in
 * the order each was first used, reactors in the order they reacted. One per
 * row of a list query, rather than a join that would multiply the rows.
 *
 * `table` and `fk` are always literals from this codebase, never input.
 */
export function reactionsSubselect(
  table: string,
  fk: string,
  targetId: string,
  { withPhotos = false }: { withPhotos?: boolean } = {}
): string {
  return `(
           select coalesce(
                    json_agg(
                      json_build_object('emoji', e.emoji, 'reactors', e.reactors)
                      order by e.first_at
                    ),
                    '[]'::json
                  )
             from (
               select x.emoji,
                      min(x.created_at) as first_at,
                      json_agg(
                        json_build_object(
                          'appUserId', x.app_user_id,
                          'personId', rp.id,
                          'firstName', rp.first_name,
                          'lastName', rp.last_name${withPhotos ? ",\n                          'photoKey', rp.photo_key" : ""}
                        )
                        order by x.created_at
                      ) as reactors
                 from ${table} x
                 join persons_resolved rp on rp.app_user_id = x.app_user_id
                where x.${fk} = ${targetId}
                group by x.emoji
             ) e
         )`;
}

export function toReactionDtos(rows: ReactionRow[], callerPersonId: string | null): ReactionDto[] {
  return rows.map((r) => ({
    emoji: r.emoji,
    reactedByMe: callerPersonId !== null && r.reactors.some((m) => m.personId === callerPersonId),
    reactors: r.reactors.map((m) => ({
      appUserId: m.appUserId,
      personId: m.personId,
      name: fullName({ firstName: m.firstName, lastName: m.lastName }),
      ...(m.photoKey !== undefined ? { thumbUrl: photoUrls(m.photoKey).thumbUrl } : {}),
    })),
  }));
}

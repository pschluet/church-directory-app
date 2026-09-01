import { useMemo } from "react";
import { Link } from "react-router";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  rectSortingStrategy,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { FamilyAnniversaryDto, FamilyMemberDto } from "@shared";
import { formatMonthDay, formatMonthDayShort, fullName } from "../lib/format";
import { Avatar } from "./Avatar";
import { Badge, MenuButton, MenuItem, useMinWidth } from "./ui";

/**
 * The people in a family, "so it's easier to see the whole family at a glance".
 *
 * Deliberately not PersonCard: that card is shared with the directory, is fixed
 * at 5.5rem of text column so its grid cannot go ragged, and carries the wrong
 * four fields for this page (family name and phone, but no patron saint and no
 * age). Changing it would change the directory too.
 *
 * Two layouts, chosen in JS rather than with `md:hidden` pairs -- rendering both
 * would put every member in the document twice, and duplicate their link and
 * their menu for assistive technology as much as for the DOM:
 *
 *   - phone: one compact row each, so a whole household fits on a screen.
 *   - md up: photo tiles, where the faces are the point and there is width to
 *     spare.
 */
export function FamilyMemberList({
  members,
  anniversaries,
  canEdit,
  myPersonId,
  onRemove,
  onReorder,
}: {
  members: FamilyMemberDto[];
  anniversaries: FamilyAnniversaryDto[];
  /** Whether the caller may rearrange the family and remove people from it. */
  canEdit: boolean;
  myPersonId: string | null;
  onRemove: (member: FamilyMemberDto) => void;
  onReorder: (personIds: string[]) => void;
}) {
  const isDesktop = useMinWidth("(min-width: 48rem)");

  // Which couple, if any, each person belongs to. Indexed rather than boolean so
  // two couples in one family can be told apart by tint.
  const couples = useMemo(() => buildCouples(members, anniversaries), [members, anniversaries]);

  const sensors = useSensors(
    // A few pixels of travel before a drag begins, so a tap on the handle that
    // wobbles -- which every thumb does -- is a tap and not a one-place move.
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  function onDragEnd(event: DragEndEvent): void {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const from = members.findIndex((m) => m.id === active.id);
    const to = members.findIndex((m) => m.id === over.id);
    if (from === -1 || to === -1) return;
    onReorder(
      move(
        members.map((m) => m.id),
        from,
        to
      )
    );
  }

  const rows = members.map((member) => (
    <SortableMember
      key={member.id}
      member={member}
      couple={couples.get(member.id) ?? null}
      variant={isDesktop ? "tile" : "row"}
      canEdit={canEdit}
      isSelf={member.id === myPersonId}
      onRemove={onRemove}
    />
  ));

  const list = isDesktop ? (
    <ul className="grid grid-cols-3 gap-3 md:grid-cols-4 lg:grid-cols-6">{rows}</ul>
  ) : (
    /*
     * Deliberately not `overflow-hidden`, though that is the usual way to make
     * children respect a rounded border. It clips a row's open menu to the list
     * box, and worse: focusing the first item of a menu that sticks out makes
     * the browser scroll this container to reveal it, which slides the top row
     * out of sight. The rows round their own outer corners instead -- see
     * `first:`/`last:` on the row below.
     */
    <ul className="divide-y divide-line rounded-lg border border-line bg-surface">{rows}</ul>
  );

  // Without edit rights there is nothing to drag, so the whole sortable
  // apparatus -- and its keyboard announcements -- stays out of the tree.
  if (!canEdit) return list;

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragEnd={onDragEnd}
      accessibility={{
        screenReaderInstructions: {
          draggable:
            "Press space or enter to start rearranging this family. Use the arrow keys to move this person, then press space or enter to drop them. Press escape to cancel.",
        },
      }}
    >
      <SortableContext
        items={members.map((m) => m.id)}
        strategy={isDesktop ? rectSortingStrategy : verticalListSortingStrategy}
      >
        {list}
      </SortableContext>
    </DndContext>
  );
}

/**
 * Moves one item, returning a new array. Exported for its own test: the drag
 * itself is not usefully drivable in jsdom, but this is where an off-by-one
 * would actually live.
 */
export function move<T>(items: T[], from: number, to: number): T[] {
  const next = items.slice();
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item!);
  return next;
}

interface Couple {
  /** Which pair this is, for picking a tint. */
  index: number;
  spouseName: string;
  month: number;
  day: number;
  yearCount: number | null;
}

/**
 * Maps each spouse to their side of a couple.
 *
 * An anniversary is stored once for the pair, so both halves have to be looked
 * up here rather than read off either person.
 */
function buildCouples(
  members: FamilyMemberDto[],
  anniversaries: FamilyAnniversaryDto[]
): Map<string, Couple> {
  const byId = new Map(members.map((m) => [m.id, m]));
  const couples = new Map<string, Couple>();

  anniversaries.forEach((anniversary, index) => {
    const [a, b] = anniversary.personIds;
    const first = byId.get(a);
    const second = byId.get(b);
    // The API only pairs two members, but a family being edited in another tab
    // could hand us a stale id; skip rather than render half a couple.
    if (!first || !second) return;

    const shared = { index, month: anniversary.month, day: anniversary.day };
    couples.set(a, { ...shared, spouseName: second.firstName, yearCount: anniversary.yearCount });
    couples.set(b, { ...shared, spouseName: first.firstName, yearCount: anniversary.yearCount });
  });

  return couples;
}

/** Two tints, so two couples in one family do not read as one. */
const COUPLE_TONES = ["accent", "primary"] as const;

function AnniversaryBadge({ couple }: { couple: Couple }) {
  const years =
    couple.yearCount === null
      ? null
      : `${couple.yearCount} ${couple.yearCount === 1 ? "year" : "years"}`;
  const description = years
    ? `Married to ${couple.spouseName}, ${years}`
    : `Married to ${couple.spouseName}`;

  return (
    <Badge tone={COUPLE_TONES[couple.index % COUPLE_TONES.length]}>
      {/* The label carries the whole story; the visible pill is just the rings
          and the date, because a tile is not wide enough for a sentence.

          Drawn rather than set as a character: U+26AD, the marriage symbol, is
          missing from Karla and most UI fonts and would come out as a box, and
          the obvious substitutes read as something else -- ⌘ is a command key.
          Every other icon in this app is inline SVG for the same reason. */}
      <span className="mr-1 inline-flex items-center">
        <svg
          aria-hidden="true"
          viewBox="0 0 24 14"
          className="h-3 w-5 stroke-current"
          fill="none"
          strokeWidth="1.8"
        >
          <circle cx="8.5" cy="7" r="5.5" />
          <circle cx="15.5" cy="7" r="5.5" />
        </svg>
      </span>
      <span aria-hidden="true">{formatMonthDayShort(couple.month, couple.day)}</span>
      <span className="sr-only">
        {description}, anniversary {formatMonthDay(couple.month, couple.day)}
      </span>
    </Badge>
  );
}

function SortableMember({
  member,
  couple,
  variant,
  canEdit,
  isSelf,
  onRemove,
}: {
  member: FamilyMemberDto;
  couple: Couple | null;
  variant: "row" | "tile";
  canEdit: boolean;
  isSelf: boolean;
  onRemove: (member: FamilyMemberDto) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: member.id,
    disabled: !canEdit,
  });

  const name = fullName(member);

  // The handle, not the whole row: the row is a link to the person, and a drag
  // that starts anywhere on it would fight every tap. A handle also needs no
  // long-press, which is the other way to disambiguate the two and the one
  // nobody discovers.
  const grip = canEdit ? (
    <button
      type="button"
      // dnd-kit's own aria-describedby wires this to the instructions above.
      {...attributes}
      {...listeners}
      aria-label={`Reorder ${name}`}
      className="tap-target flex shrink-0 cursor-grab touch-none items-center justify-center text-ink-muted transition hover:text-primary active:cursor-grabbing"
    >
      <svg aria-hidden="true" viewBox="0 0 20 20" className="h-4 w-4 fill-current">
        <circle cx="7" cy="5" r="1.4" />
        <circle cx="13" cy="5" r="1.4" />
        <circle cx="7" cy="10" r="1.4" />
        <circle cx="13" cy="10" r="1.4" />
        <circle cx="7" cy="15" r="1.4" />
        <circle cx="13" cy="15" r="1.4" />
      </svg>
    </button>
  ) : null;

  const menu = canEdit ? (
    <MenuButton label={`Actions for ${name}`} className="shrink-0">
      <MenuItem danger onSelect={() => onRemove(member)}>
        {isSelf ? "Leave this family" : "Remove from family"}
      </MenuItem>
    </MenuButton>
  ) : null;

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    // Lifts the one being dragged above its neighbours' borders.
    zIndex: isDragging ? 10 : undefined,
    opacity: isDragging ? 0.85 : undefined,
  };

  if (variant === "row") {
    return (
      <li
        ref={setNodeRef}
        style={style}
        // The rows carry the list's rounded corners, since the list itself
        // cannot clip them without also clipping an open menu.
        className="flex items-center gap-1 bg-surface pr-1 first:rounded-t-lg last:rounded-b-lg"
      >
        {grip}
        <Link
          to={`/people/${member.id}`}
          className="flex min-w-0 flex-1 items-center gap-3 py-2 pl-1 transition hover:bg-surface-muted"
        >
          <Avatar thumbUrl={member.thumbUrl} person={member} size="sm" />
          {/* Two lines, and the split is the point: the name gets the first one
              to itself so it is never abbreviated, sharing it only with the age,
              which is two characters wide. Everything that used to crowd it --
              the anniversary and the account pill -- drops to the second line
              alongside the patron saint, and wraps to a third rather than
              cutting anything short. Still two lines in the common case, so the
              family stays visible at a glance. */}
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="flex items-baseline gap-2">
              <span className="break-words font-bold text-ink">{name}</span>
              {member.age !== null && (
                <span className="shrink-0 text-sm text-ink-muted">{member.age}</span>
              )}
            </span>
            {(member.patronSaint || couple || member.appUserId === null) && (
              <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-ink-muted">
                {member.patronSaint && <span className="break-words">{member.patronSaint}</span>}
                {couple && <AnniversaryBadge couple={couple} />}
                {member.appUserId === null && <Badge>No account</Badge>}
              </span>
            )}
          </span>
        </Link>
        {menu}
      </li>
    );
  }

  return (
    <li
      ref={setNodeRef}
      style={style}
      className="relative rounded-lg border border-line bg-surface transition hover:border-accent"
    >
      {/* Both controls overlay the tile so the link underneath keeps the whole
          area, rather than being squeezed into what is left beside them. */}
      {grip && <span className="absolute left-0 top-0 z-10">{grip}</span>}
      {menu && <span className="absolute right-0 top-0 z-20">{menu}</span>}

      {/* Text first, then pills, with the pills pushed to the bottom by
          `mt-auto`. Every field here is optional, so laying them out in source
          order alone would put each tile's badges at a different height and the
          row of them would read as scattered rather than as a row. */}
      <Link
        to={`/people/${member.id}`}
        className="flex h-full flex-col items-center gap-1 px-2 pb-3 pt-8 text-center"
      >
        <Avatar thumbUrl={member.thumbUrl} person={member} size="md" />
        <span className="mt-1 w-full truncate font-bold text-ink">{name}</span>
        {member.age !== null && <span className="text-sm text-ink-muted">{member.age}</span>}
        {member.patronSaint && (
          <span className="w-full truncate text-xs text-ink-muted">{member.patronSaint}</span>
        )}
        {(couple || member.appUserId === null) && (
          <span className="mt-auto flex flex-col items-center gap-1 pt-1">
            {couple && <AnniversaryBadge couple={couple} />}
            {member.appUserId === null && <Badge>No account</Badge>}
          </span>
        )}
      </Link>
    </li>
  );
}

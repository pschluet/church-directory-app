import { InfoWindow } from "@vis.gl/react-google-maps";
import type { ReactNode } from "react";
import type { MapLocationDto, MapOccupantDto } from "@shared";
import { memberPreview } from "../lib/format";
import { AddressLink } from "./AddressLink";
import { Avatar } from "./Avatar";
import { ChurchGlyphPaths, FamilyGlyphPaths } from "./mapGlyphs";
import { Link } from "./nav";

/**
 * Who lives at the pin you just tapped, said next to the pin.
 *
 * This replaced a bottom drawer and a desktop side panel, which had the wrong
 * relationship to the map: they covered it in order to describe a point on it,
 * and on a phone the drawer took over half the screen to name one household.
 *
 * A Google `InfoWindow` rather than markup positioned over the map, for two
 * reasons that would both have to be rebuilt by hand. It stays attached to its
 * marker while the map is panned and zoomed. And it **pans the map to bring
 * itself into view** if it would open off the edge -- which is the same
 * complaint as a map that runs off the bottom of the window, in miniature, and
 * the bug this feature would otherwise have shipped with.
 *
 * `headerDisabled` turns off Google's header row, which is also its close
 * button, so the bubble carries this app's `x` instead of one in a typeface
 * nothing else here uses.
 *
 * One popover per pin, not per occupant: a pin *is* an address, and two
 * families and a lodger sharing one is a case the API produces. So the
 * occupants are listed and the address is stated once underneath, because all
 * of them share it.
 */

/**
 * An explicit width, not just a `maxWidth` on the InfoWindow.
 *
 * Left to itself, the bubble lays the content out at its intrinsic width, then
 * Google clamps the bubble to its own `maxWidth` and puts a horizontal
 * scrollbar under it. Sizing the content instead means there is nothing to
 * scroll.
 *
 * `max-w-full` rather than a viewport calculation: Google already caps the
 * bubble against the width of the map, and on a narrow phone that cap is the
 * binding one -- so measuring the window here would be a second, worse guess
 * at the same number.
 */
const WIDTH_CLASS = "w-64 max-w-full";

/** Either kind of marker the Maps API will let an InfoWindow hang off. */
type PopoverAnchor = google.maps.marker.AdvancedMarkerElement | google.maps.Marker;

export function MapPopover({
  location,
  anchor,
  onClose,
}: {
  location: MapLocationDto;
  anchor: PopoverAnchor;
  onClose: () => void;
}) {
  return (
    <PopoverShell
      anchor={anchor}
      onClose={onClose}
      label={`People at ${location.formattedAddress}`}
      address={location.formattedAddress}
    >
      <ul className="space-y-3">
        {location.occupants.map((occupant) => (
          <li key={`${occupant.kind}-${occupant.id}`}>
            <Occupant occupant={occupant} />
          </li>
        ))}
      </ul>
    </PopoverShell>
  );
}

/**
 * The church's own pin.
 *
 * Its own component rather than a third kind of occupant, because it is not
 * somebody's home: there is nobody to link to and nothing to preview, just the
 * parish's name and where it is. The name comes from the signed-in member's
 * organization rather than from the map payload, which never needed it.
 */
export function ChurchPopover({
  name,
  church,
  anchor,
  onClose,
}: {
  name: string;
  church: { formattedAddress: string };
  anchor: PopoverAnchor;
  onClose: () => void;
}) {
  return (
    <PopoverShell
      anchor={anchor}
      onClose={onClose}
      label={name}
      address={church.formattedAddress}
      /*
       * Passed as the *visible* heading rather than as children. The parish's
       * name is the whole content here, so leaving the shell to render its
       * screen-reader-only copy of the label as well says it twice -- which is
       * exactly what happened, and which a test querying by role did not catch
       * because the second copy was a <p>.
       */
      heading={
        <div className="flex items-center gap-2">
          <svg
            viewBox="0 0 24 24"
            className="h-4 w-4 shrink-0 text-accent"
            fill="currentColor"
            aria-hidden="true"
          >
            <ChurchGlyphPaths />
          </svg>
          <h2 className="min-w-0 break-words font-bold text-ink">{name}</h2>
        </div>
      }
    />
  );
}

/**
 * The bubble itself: whatever it is about, then the address underneath.
 *
 * The address is always last and always once, because it is the one thing every
 * kind of pin has and the one thing a member is most likely to want to act on.
 */
function PopoverShell({
  anchor,
  onClose,
  label,
  address,
  heading,
  children,
}: {
  anchor: PopoverAnchor;
  onClose: () => void;
  /** The bubble's accessible name, since `headerDisabled` removes Google's. */
  label: string;
  address: string;
  /**
   * A visible heading, for a popover whose whole content *is* its name. Without
   * one the label is rendered for screen readers only, because repeating a
   * family name above a list of that family would say it twice.
   */
  heading?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <InfoWindow
      anchor={anchor}
      // Google's header row is also its close button; ours is below.
      headerDisabled
      // `disableAutoPan` deliberately left at its default: a bubble that opens
      // half off the edge of the map is the thing this component is for. No
      // `maxWidth` either -- the content sizes itself, see WIDTH_CLASS.
      onCloseClick={onClose}
      className="text-ink"
    >
      <div className={WIDTH_CLASS}>
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 flex-1">
            {heading ?? <h2 className="sr-only">{label}</h2>}
            {children}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            /*
             * No negative margins, unlike Modal's close button. Google sizes
             * the bubble's scroll box from this content and then gives it
             * `overflow-x: scroll`, so four pixels of overhang is a scrollbar
             * across the bottom of the popover and a focus ring clipped in
             * half. There is nothing to pull it tight against here anyway.
             */
            className="tap-target shrink-0 text-xl leading-none text-ink-muted hover:text-primary"
          >
            ×
          </button>
        </div>

        {/*
          Once, at the bottom. Given as a string rather than a Person: a pin is
          a place, and two people at one house can have typed the address
          differently -- so this is Google's own formatting of it, which is what
          geocoded.
        */}
        <div className="mt-3 border-t border-line pt-3">
          {/*
            `break-words` because a formatted address is usually full of spaces
            but does not have to be -- and with the bubble's horizontal
            scrollbar suppressed, anything that cannot wrap would be clipped
            rather than reachable.
          */}
          <AddressLink address={address} className="text-sm break-words" />
        </div>
      </div>
    </InfoWindow>
  );
}

/**
 * One household, or one person who has none.
 *
 * A family shows the names of whoever lives *here* rather than its whole
 * roster, with the same overflow the families list uses. The family name is the
 * way to the rest of them.
 */
function Occupant({ occupant }: { occupant: MapOccupantDto }) {
  if (occupant.kind === "person") {
    const self = occupant.members[0];
    return (
      <Link
        to={`/people/${occupant.id}`}
        className="flex items-center gap-3 text-ink hover:text-primary"
      >
        {self && (
          <Avatar
            person={{ firstName: self.firstName, lastName: self.lastName }}
            /*
             * `thumbUrl` only. Passing `fullUrl` would make this photo open
             * PhotoLightbox, which portals to document.body -- outside this
             * bubble's own subtree, so any dismiss-on-outside-click would fire
             * the moment it opened. Enlarging a photo belongs on the person's
             * own page, where a tap has nowhere else to go.
             */
            thumbUrl={self.thumbUrl}
            size="sm"
          />
        )}
        <span className="min-w-0 break-words font-bold">{occupant.label}</span>
      </Link>
    );
  }

  const names = occupant.members.map((member) => member.firstName);

  return (
    <div className="min-w-0">
      <div className="flex items-center gap-2">
        <svg
          viewBox="0 0 24 24"
          className="h-4 w-4 shrink-0 text-primary"
          fill="currentColor"
          aria-hidden="true"
        >
          <FamilyGlyphPaths />
        </svg>
        <Link
          to={`/families/${occupant.id}`}
          className="min-w-0 break-words font-bold text-ink hover:text-primary"
        >
          {occupant.label}
        </Link>
      </div>
      {names.length > 0 && (
        <p className="mt-0.5 pl-6 text-sm text-ink-muted">
          {/*
            No count in front of it, unlike the families list. `members` holds
            whoever lives at *this* address, so a family with somebody living
            elsewhere would be described by a number that is true of the pin and
            false of the family.
          */}
          {memberPreview(names, names.length)}
        </p>
      )}
    </div>
  );
}

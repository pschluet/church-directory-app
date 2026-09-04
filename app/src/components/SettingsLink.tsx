import { NavLink } from "react-router";

/**
 * The gear beside the bell.
 *
 * A gear rather than a nav item: the settings page holds two notification
 * switches somebody sets once, and giving it a place in the main navigation
 * would put it next to Directory and Families as though it were somewhere
 * people go. It sits next to the bell because that is what it configures.
 *
 * Inline SVG, per the convention in SearchField and InfoPopover -- the app
 * ships no icon package.
 */

/** One tooth every 45°, so the cog is symmetric by construction. */
const TOOTH_ANGLES = [0, 45, 90, 135, 180, 225, 270, 315];

export function SettingsLink() {
  return (
    <NavLink
      to="/settings"
      aria-label="Settings"
      className={({ isActive }) =>
        `tap-target inline-flex items-center justify-center rounded-md transition hover:bg-surface-muted hover:text-primary ${
          isActive ? "text-primary" : "text-ink"
        }`
      }
    >
      <svg aria-hidden="true" viewBox="0 0 20 20" className="h-5 w-5 fill-current">
        {/*
          Eight teeth, each drawn at the top and rotated into place, rather than
          one hand-written path: the shape is then symmetric because the maths
          says so, and a tooth cannot drift.
        */}
        {TOOTH_ANGLES.map((angle) => (
          <rect
            key={angle}
            x="9"
            y="1.4"
            width="2"
            height="4.4"
            rx="1"
            transform={`rotate(${angle} 10 10)`}
          />
        ))}
        {/*
          The hub, with the centre punched out by `evenodd` across two subpaths
          rather than by a second circle in the surface colour -- which would be
          the wrong colour the moment this is hovered, since the button's
          background changes.
        */}
        <path
          fillRule="evenodd"
          d="M10 4a6 6 0 1 0 0 12 6 6 0 0 0 0-12Zm0 3.4a2.6 2.6 0 1 1 0 5.2 2.6 2.6 0 0 1 0-5.2Z"
        />
      </svg>
    </NavLink>
  );
}

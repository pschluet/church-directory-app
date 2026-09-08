/**
 * The two shapes the map draws to tell a household from a person.
 *
 * Paths only, with no `<svg>` around them, because the pin and the popover want
 * the same silhouette at different sizes and with different colours. The
 * alternative was the same path data written out twice -- which is what this
 * file was extracted from, and the two had already started to be edited
 * separately.
 */

/** Two people, one behind the other. A family. */
export function FamilyGlyphPaths() {
  return (
    <>
      <circle cx="9" cy="7" r="3.2" />
      <circle cx="16.5" cy="8.5" r="2.4" />
      <path d="M2.5 19c0-3.3 2.9-5.6 6.5-5.6s6.5 2.3 6.5 5.6z" />
      <path d="M16.5 12.6c2.8 0 5 1.8 5 4.4h-4.2c0-1.7-.6-3.2-1.6-4.3z" />
    </>
  );
}

/** One person, centred. Somebody with no family. */
export function PersonGlyphPaths() {
  return (
    <>
      <circle cx="12" cy="7.5" r="3.6" />
      <path d="M4.5 20c0-3.6 3.4-6 7.5-6s7.5 2.4 7.5 6z" />
    </>
  );
}

/** A church, for the one pin on the map that is not somebody's home. */
export function ChurchGlyphPaths() {
  return (
    <>
      <path d="M12 2l1.6 3.2V8h2.9v2.2H13.6V22h-3.2V10.2H7.5V8h2.9V5.2z" />
      <path d="M4 22V13l8-4.6 8 4.6v9h-4v-5H8v5z" opacity="0.55" />
    </>
  );
}

/**
 * Two people, one behind the other: the groups glyph.
 *
 * Shared by the member count on a group row and the groups icon in the phone
 * header, so the two cannot drift apart. Size comes from the caller's
 * `className`; colour from `currentColor`.
 */
export function PeopleIcon({ className }: { className: string }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20" className={`fill-current ${className}`}>
      <circle cx="7.5" cy="6.5" r="3" />
      <path d="M1.5 16.5c0-3.3 2.7-5.5 6-5.5s6 2.2 6 5.5v.5h-12v-.5Z" />
      <circle cx="14" cy="7" r="2.4" />
      <path d="M14.5 17h4v-.6c0-2.7-2-4.6-4.6-4.6-.7 0-1.3.1-1.9.4 1.5 1.1 2.5 2.8 2.5 4.8Z" />
    </svg>
  );
}

# The Map View base map style

The parish map's base styling lives in the **Google Cloud console**, not in this repository:
Google Maps Platform → Map Styles, associated with the Map ID that
`api/src/services/geocoding.ts` holds as a constant. Editing it there takes effect with no
deploy, which is most of the point.

`map-style.json` beside this file is a copy of what is published. Nothing reads it — the
console is the source of truth — but a style nobody can find is a style nobody can restore,
and a file gives the next change a diff.

To apply it: **Map Styles → the style → Customize → the JSON tab →** paste **→ Apply → Save**,
then **Publish** if you are editing an existing style rather than creating one. Legacy-format
JSON is accepted and converted on import with a warning that the conversion is approximate, so
look at the preview before publishing.

## Why it looks like this

The pins carry the page. A household is `--color-primary` (`#b42d23`) and somebody on their
own at that address is `--color-primary-light` (`#d4564a`), a lighter tint of the same red, so
the two read as one set at two weights. "On their own" counts the address rather than the
family, so one member of a household living apart from the rest gets the lighter pin. `--color-accent` gold is reserved for the church, which is then the
only pin that is not somebody's home. The base map's whole job is to stay out of all of it:

- **Landscape is `#faf8f5`**, which is `--color-surface-muted` — the same off-white as the rest
  of the app, so the map reads as part of the page rather than as a window cut into it.
- **Roads are white with `#ece7de` casings**, a shade off `--color-line`, so the network is
  legible as texture without becoming the subject.
- **Water is `#d8e2e5`**, a muted slate. This matters more here than it sounds: Lake Michigan
  is about a third of the frame at the opening zoom, and Google's default blue makes it the
  first thing you look at.
- **Label icons are off entirely.** That also removes the interstate shields, which were the
  loudest thing on screen and tell a parishioner nothing.
- **Local road labels are off**, because street names are noise until you are zoomed well past
  the 30-mile opening view.

Two decisions worth not undoing:

- **Business POIs are hidden category by category** rather than with a blanket `poi: off`
  followed by re-enabling `poi.park`. That shorter version depends on selector precedence
  between a parent and its child, which is easy to get subtly wrong and hard to notice.
- **Places of worship are kept, in gold.** This is a parish directory. The church has its own
  gold pin, and the other churches nearby are context rather than clutter — labelled in the
  same colour, which is a quiet way of saying they are the same kind of thing.

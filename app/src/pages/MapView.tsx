import { useCallback, useEffect, useRef, useState } from "react";
// `Map` is aliased because this file also uses the built-in `Map`, and the
// import would shadow it -- `new Map(...)` then fails in a way that reads as a
// type error about map props.
import {
  APIProvider,
  AdvancedMarker,
  ControlPosition,
  Map as GoogleMap,
  MapControl,
  useMap,
} from "@vis.gl/react-google-maps";
import { MarkerClusterer } from "@googlemaps/markerclusterer";
import type { Marker } from "@googlemaps/markerclusterer";
import { useQuery } from "@tanstack/react-query";
import type { MapDto, MapLocationDto } from "@shared";
import { api } from "../lib/api";
import { qk } from "../lib/queryKeys";
import { useMe } from "../context/MeContext";
import { boundsAround, initialView } from "../lib/mapView";
import { ChurchPopover, MapPopover } from "../components/MapPopover";
import { ChurchGlyphPaths, FamilyGlyphPaths, PersonGlyphPaths } from "../components/mapGlyphs";
import { useFillViewport } from "../components/useFillViewport";
import { Link } from "../components/nav";
import { EmptyState, ErrorNotice, PageHeading, Spinner, useDismissable } from "../components/ui";

/**
 * Where everybody lives.
 *
 * Reached from the Directory rather than from the nav, per the requirement, and
 * only when this parish has Map View switched on -- `RequireMapView` in App.tsx
 * has already sent anyone else home, so a null key reaching this page can only
 * mean the deployment has no Google project.
 *
 * Two things about the shape of this file are deliberate and worth not undoing.
 *
 * **One map instance, for the life of the page.** A Dynamic Maps event is
 * billed once per `new google.maps.Map()`, and nothing else on the map is
 * billed at all -- panning, zooming, markers and clustering are free. So the
 * cost of this feature is the number of times somebody opens it, and a remount
 * is a second open. Selection state therefore lives above `<Map>` and is passed
 * down; putting it inside, or keying the map on anything that changes, would
 * quietly double the bill.
 *
 * **The map fills the page rather than sitting in the content column.** It is
 * the only page here that does, because a map in a 6xl box with margins is a
 * map you cannot see the far side of the parish on.
 */
export function MapView() {
  const { maps, organizationId, isAdmin, me } = useMe();
  // The church's popover names the parish. `/api/map` never carried it, and
  // this is the same value the header shows.
  const parishName = me?.organization?.name ?? "The church";

  const query = useQuery({
    queryKey: qk.map(organizationId),
    queryFn: ({ signal }) => api<MapDto>("/map", { signal }),
    /*
     * Deliberately not cached past a mount, which is the opposite of what this
     * started as.
     *
     * A `staleTime` here was a five-minute window in which the map showed the
     * parish as it used to be: you saved an address, came straight to the map,
     * and your own house was missing. The obvious fix is to invalidate this key
     * from every write that moves a pin -- but that is a person's address, a
     * family's name, a family move, a merge, a delete, a photo and the church
     * address, in six files, and forgetting one is silent. Getting it wrong
     * once is what this comment is for.
     *
     * So there is nothing to invalidate: opening the page fetches. It costs one
     * small read of our own database, on a page somebody navigates to
     * deliberately and rarely, and -- worth being explicit -- it is not a
     * Google call. A Dynamic Maps event is billed per `new google.maps.Map()`,
     * which happens when the component below mounts, not when this query runs.
     */
    staleTime: 0,
  });

  if (query.isPending) return <Spinner label="Loading the map" />;
  if (query.error) {
    return (
      <ErrorNotice
        message={query.error.message ?? "Could not load the map"}
        onRetry={() => void query.refetch()}
      />
    );
  }

  const data = query.data;
  if (!data) return null;

  if (!maps) {
    return (
      <>
        <PageHeading title="Map View" />
        <EmptyState title="The map is not available here">
          This deployment has no Google Maps key, so there is nothing to draw with. Everything else
          in the directory works as usual.
        </EmptyState>
      </>
    );
  }

  const view = initialView(data.church, data.locations);

  if (!view) {
    return (
      <>
        <PageHeading title="Map View" />
        <EmptyState title="Nobody is on the map yet">
          {isAdmin
            ? "No address in the parish has been placed, and the church has no address saved either — so there is nowhere to centre the map. Add the church address and check that people's addresses are complete."
            : "No addresses in the parish have been placed on a map yet."}
        </EmptyState>
      </>
    );
  }

  return (
    <>
      <PageHeading
        title="Map View"
        subtitle={`${data.locations.length} ${
          data.locations.length === 1 ? "address" : "addresses"
        } in the parish`}
      />

      {/*
        The church address is an admin's job, so only an admin is told about it.
        A member seeing this could do nothing but wonder who to tell.
      */}
      {isAdmin && !data.church && (
        <ChurchAddressNotice unmappedCount={data.unmappedCount} centredOnCentroid />
      )}
      {isAdmin && data.church && data.unmappedCount > 0 && (
        <ChurchAddressNotice unmappedCount={data.unmappedCount} centredOnCentroid={false} />
      )}

      <APIProvider apiKey={maps.browserKey}>
        <ParishMap data={data} mapId={maps.mapId} centre={view.centre} parishName={parishName} />
      </APIProvider>
    </>
  );
}

/**
 * What an admin is told, and nobody else.
 *
 * Two separate facts, deliberately in one box: the map is not centred where it
 * should be, and some people are missing from it. Both are fixed in the same
 * two places, so splitting them into two notices would be two things to
 * dismiss about one afternoon's work.
 */
function ChurchAddressNotice({
  unmappedCount,
  centredOnCentroid,
}: {
  unmappedCount: number;
  centredOnCentroid: boolean;
}) {
  return (
    <div className="mb-4 rounded-md border border-accent bg-surface-muted p-4 text-sm text-ink">
      {centredOnCentroid && (
        <p>
          <strong className="font-bold">No church address is saved.</strong> The map is centred on
          the middle of the parish instead.{" "}
          {/*
            Settings, not Churches. Churches is a super administrator's page, so
            linking there sent every other administrator to a route that bounces
            them home -- a warning that leads nowhere is worse than no warning.
            Settings has the same address form for anyone who can edit it, and a
            super administrator can still do it from Churches alongside the name.
          */}
          <Link to="/settings" className="font-bold text-primary underline">
            Add the church address
          </Link>
          .
        </p>
      )}
      {unmappedCount > 0 && (
        <p className={centredOnCentroid ? "mt-2" : undefined}>
          {unmappedCount === 1
            ? "One person has an address that could not be placed on the map."
            : `${unmappedCount} people have addresses that could not be placed on the map.`}{" "}
          Check them for typos, or re-enter them using the address suggestions.
        </p>
      )}
    </div>
  );
}

/**
 * The map, its pins, and the panel over them.
 *
 * Inside `APIProvider` so it can use the hooks, and separate from `MapView` so
 * that the page's own loading and empty states do not sit inside a provider
 * that would load the Maps script to render a sentence.
 */
function ParishMap({
  data,
  mapId,
  centre,
  parishName,
}: {
  data: MapDto;
  mapId: string;
  centre: { latitude: number; longitude: number };
  /** For the church's popover; the map payload never needed the name. */
  parishName: string;
}) {
  /*
   * Which pin is open, by id rather than by object, so a refetch that returns
   * an equal-but-new location does not close the popover somebody is reading.
   * The church is a kind of its own because it is not somebody's home -- it has
   * no occupants and no `placeId` in the payload.
   */
  const [selected, setSelected] = useState<
    { kind: "location"; placeId: string } | { kind: "church" } | null
  >(null);
  const [fullscreen, setFullscreen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  /*
   * Ignored in full screen, where the container is `fixed inset-0` and sizing
   * it is the browser's job.
   */
  const measured = useFillViewport(containerRef);
  const height = fullscreen ? undefined : (measured ?? undefined);

  return (
    <div
      ref={containerRef}
      /*
       * `relative` so the escape hatch and Google's own controls have something
       * to sit in. In full screen this covers the window, `z-50` to clear the
       * `z-40` header -- which it has to, or "full screen" would stop below the
       * parish name.
       *
       * Toggling classes rather than remounting is not a style preference: a
       * remount is another `new google.maps.Map()`, which is another billed
       * Dynamic Maps event. Entering and leaving full screen must cost nothing.
       */
      className={
        fullscreen
          ? "fixed inset-0 z-50 overflow-hidden bg-surface"
          : "relative h-[60vh] overflow-hidden rounded-xl border border-line shadow-sm md:h-[70vh]"
      }
      // The class stays as the fallback for a browser that measures nothing.
      style={height ? { height } : undefined}
    >
      <GoogleMap
        mapId={mapId}
        defaultCenter={{ lat: centre.latitude, lng: centre.longitude }}
        // Overridden immediately by the 30-mile fit below. Present because
        // `<Map>` insists on a default zoom or a default bounds.
        defaultZoom={10}
        gestureHandling="greedy"
        disableDefaultUI={false}
        mapTypeControl={false}
        streetViewControl={false}
        /*
         * Google's own full-screen control, deliberately off in favour of the
         * one below. It leans on the Fullscreen API, which will not take a
         * `div` on iOS Safari, and it hides itself below a size threshold --
         * so on the two cases that most want it, a phone and an installed PWA,
         * it is either absent or does nothing.
         */
        fullscreenControl={false}
        // Tapping empty map closes the popover, so there is always a way out.
        onClick={() => setSelected(null)}
        className="h-full w-full"
      >
        <ThirtyMileView centre={centre} />
        <ChurchMarker
          church={data.church}
          name={parishName}
          selected={selected?.kind === "church"}
          onSelect={() => setSelected({ kind: "church" })}
          onClose={() => setSelected(null)}
        />
        <Pins
          locations={data.locations}
          selectedPlaceId={selected?.kind === "location" ? selected.placeId : null}
          onSelect={(placeId) => setSelected({ kind: "location", placeId })}
          onClose={() => setSelected(null)}
        />
        {/*
          In the map's own control layer rather than absolutely positioned over
          it, so it keeps its distance from the zoom and camera controls at the
          bottom right and stays put when the container resizes. The top right
          is free because the three controls above are off.
        */}
        <MapControl position={ControlPosition.RIGHT_TOP}>
          <FullscreenButton fullscreen={fullscreen} onToggle={() => setFullscreen((on) => !on)} />
        </MapControl>
      </GoogleMap>

      {/*
        Mounted only in full screen, and a sibling of the map rather than a
        wrapper around it -- a wrapper would remount the map, and a remount is
        another billed map load. Renders nothing; it exists to hold the hook.
      */}
      {fullscreen && <FullscreenEscape onExit={() => setFullscreen(false)} />}
    </div>
  );
}

/**
 * Escape leaves full screen, and the page underneath stops scrolling.
 *
 * `useDismissable` is shared with `Modal` and `PhotoLightbox` and locks body
 * scroll, which `MenuButton` and `InfoPopover` avoid for good reason -- but
 * this genuinely covers the viewport, so the lock is right for the same reason
 * it is right for them.
 */
function FullscreenEscape({ onExit }: { onExit: () => void }) {
  useDismissable(onExit);
  return null;
}

/**
 * Full screen on every size, done with CSS.
 *
 * The accessible name changes with the state rather than relying on
 * `aria-pressed`, which a screen reader may announce as "not pressed" without
 * ever saying what pressing it would do.
 */
function FullscreenButton({ fullscreen, onToggle }: { fullscreen: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-label={fullscreen ? "Exit full screen" : "Enter full screen"}
      // `m-2.5` to match the gap Google leaves around its own controls.
      className="tap-target m-2.5 flex items-center justify-center rounded-md border border-line bg-surface text-ink-muted shadow-md transition hover:text-primary"
    >
      <svg
        viewBox="0 0 24 24"
        className="h-5 w-5"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        {fullscreen ? (
          <>
            <path d="M9 4H5a1 1 0 0 0-1 1v4" />
            <path d="M15 4h4a1 1 0 0 1 1 1v4" />
            <path d="M15 20h4a1 1 0 0 0 1-1v-4" />
            <path d="M9 20H5a1 1 0 0 1-1-1v-4" />
          </>
        ) : (
          <>
            <path d="M4 9V5a1 1 0 0 1 1-1h4" />
            <path d="M20 9V5a1 1 0 0 0-1-1h-4" />
            <path d="M20 15v4a1 1 0 0 1-1 1h-4" />
            <path d="M4 15v4a1 1 0 0 0 1 1h4" />
          </>
        )}
      </svg>
    </button>
  );
}

/**
 * "Show approximately a 30 mile radius around the church."
 *
 * Done as a `fitBounds` rather than a zoom level, because a zoom level means a
 * different number of miles on every screen -- 30 miles on a phone and 90 on a
 * desktop, from the same constant. Runs once per centre: re-running it would
 * yank the map back every time anything re-rendered, which is the behaviour of
 * a map that will not let you look at anything.
 */
function ThirtyMileView({ centre }: { centre: { latitude: number; longitude: number } }) {
  const map = useMap();
  const fitted = useRef<string | null>(null);

  useEffect(() => {
    if (!map) return;
    const key = `${centre.latitude},${centre.longitude}`;
    if (fitted.current === key) return;
    fitted.current = key;

    const { north, south, east, west } = boundsAround(centre);
    map.fitBounds({ north, south, east, west }, 0);
  }, [map, centre]);

  return null;
}

/**
 * The church, in gold because it is the one pin that is not somebody's home.
 *
 * Given a popover of its own for the same reason the homes have one: a marker
 * whose only affordance is a browser tooltip is a marker that does nothing on a
 * phone, where there is no hover.
 */
function ChurchMarker({
  church,
  name,
  selected,
  onSelect,
  onClose,
}: {
  church: MapDto["church"];
  name: string;
  selected: boolean;
  onSelect: () => void;
  onClose: () => void;
}) {
  // A ref for the same reason as ClusteredPin, though this one is not
  // clustered: re-rendering a marker to record that it exists is churn either
  // way, and two markers in one file should not disagree about how it is done.
  const marker = useRef<Marker | null>(null);
  const setMarkerRef = useCallback((element: Marker | null) => {
    marker.current = element;
  }, []);

  if (!church) return null;

  return (
    <>
      <AdvancedMarker
        position={{ lat: church.latitude, lng: church.longitude }}
        ref={setMarkerRef}
        title={church.formattedAddress}
        onClick={onSelect}
        zIndex={2}
      >
        <div className="flex h-9 w-9 items-center justify-center rounded-full border-2 border-white bg-accent shadow-md">
          <svg
            viewBox="0 0 24 24"
            className="h-5 w-5 text-white"
            fill="currentColor"
            aria-hidden="true"
          >
            <ChurchGlyphPaths />
          </svg>
        </div>
      </AdvancedMarker>
      {selected && marker.current && (
        <ChurchPopover name={name} church={church} anchor={marker.current} onClose={onClose} />
      )}
    </>
  );
}

/**
 * Every home, clustered.
 *
 * `MarkerClusterer` is imperative and wants real marker objects, so each
 * `AdvancedMarker` hands itself over through a ref as it mounts. Two things
 * about how that is done are load-bearing, and the obvious version of both is
 * wrong.
 *
 * **The registry is a ref, not state.** React 19 treats a ref callback whose
 * identity changed as a detach followed by an attach, so an inline
 * `ref={m => register(m, key)}` fires on *every* render -- once with null, once
 * with the marker. Writing that into `useState` means each of those firings
 * schedules a render, which fires the callback again: "Maximum update depth
 * exceeded", and a page that never paints. Nothing here needs a re-render when
 * a marker arrives -- the clusterer draws it -- so nothing here holds state.
 *
 * **Each pin owns its own stable callback**, memoised on its `place_id`, so a
 * re-render of this component does not detach and re-add every marker on the
 * map. Correct without it, but it would churn the whole clusterer on any
 * parent render.
 */
function Pins({
  locations,
  selectedPlaceId,
  onSelect,
  onClose,
}: {
  locations: MapLocationDto[];
  selectedPlaceId: string | null;
  onSelect: (placeId: string) => void;
  onClose: () => void;
}) {
  const map = useMap();
  const clusterer = useRef<MarkerClusterer | null>(null);
  const [markers, setMarkers] = useState<Record<string, Marker>>({});

  useEffect(() => {
    if (!map) return;
    const instance = new MarkerClusterer({ map, renderer: clusterRenderer });
    clusterer.current = instance;
    return () => {
      instance.clearMarkers();
      clusterer.current = null;
    };
  }, [map]);

  /*
   * The whole batch, in an effect, and never one marker at a time as each ref
   * fires. That version silently produced no clusters at all.
   *
   * `AdvancedMarker` attaches its ref before it has finished setting the
   * marker's `position`, so a marker handed straight to `addMarker` went into
   * SuperCluster with undefined coordinates. It cached the empty result -- and
   * then never recomputed, because its staleness check is whether the marker
   * *array* changed, and the array was the same objects forever after. So the
   * map drew every pin separately at every zoom, and whether it looked right
   * depended on whether positions happened to land in time. Registering into
   * state instead defers the add to a later commit, by which point the
   * positions are set.
   *
   * `clearMarkers` before `addMarkers` for the same staleness check: it is what
   * makes the array differ, so the algorithm reloads instead of handing back
   * what it decided the first time.
   */
  useEffect(() => {
    const instance = clusterer.current;
    if (!instance) return;
    instance.clearMarkers();
    instance.addMarkers(Object.values(markers));
  }, [markers, map]);

  /*
   * One callback for every pin, stable for the life of this component, so a
   * pin's ref never changes identity -- React 19 reads a changed ref callback
   * as detach-then-attach, and an inline one here re-registered every marker on
   * every render.
   */
  const register = useCallback((placeId: string, marker: Marker | null) => {
    setMarkers((current) => {
      if (marker) {
        if (current[placeId] === marker) return current;
        return { ...current, [placeId]: marker };
      }
      if (!(placeId in current)) return current;
      const { [placeId]: _gone, ...rest } = current;
      return rest;
    });
  }, []);

  return (
    <>
      {locations.map((location) => (
        <ClusteredPin
          key={location.placeId}
          location={location}
          register={register}
          selected={location.placeId === selectedPlaceId}
          onSelect={onSelect}
          onClose={onClose}
        />
      ))}
    </>
  );
}

function ClusteredPin({
  location,
  register,
  selected,
  onSelect,
  onClose,
}: {
  location: MapLocationDto;
  /** Hands this pin's marker to the clusterer's batch; null on the way out. */
  register: (placeId: string, marker: Marker | null) => void;
  selected: boolean;
  onSelect: (placeId: string) => void;
  onClose: () => void;
}) {
  const placeId = location.placeId;

  /*
   * The popover anchors to a real marker, so this pin keeps its own -- in a ref
   * rather than in state, and that is not a style preference.
   *
   * It was state, and it made clustering intermittent: whether a cluster bubble
   * appeared at a given zoom varied from one load to the next. `setMarker` in
   * the ref callback re-renders this component, which re-renders
   * `AdvancedMarker`, which re-asserts `marker.map` -- and hiding a marker by
   * setting `marker.map = null` is exactly how MarkerClusterer collapses one
   * into a cluster. Whichever of the two landed last won, and which that was
   * depended on when `useMap()` resolved. The comment above this component says
   * nothing here needs a re-render when a marker arrives; that was right, and
   * adding state for the popover overrode it.
   *
   * Read during render, which is safe here rather than merely convenient: a
   * marker cannot be selected before it exists, because selecting one means
   * clicking it, and the `selected` prop changing is what re-renders this.
   */
  const marker = useRef<Marker | null>(null);

  const setMarkerRef = useCallback(
    (element: Marker | null) => {
      marker.current = element;
      register(placeId, element);
    },
    [placeId, register]
  );

  return (
    <>
      <AdvancedMarker
        position={{ lat: location.latitude, lng: location.longitude }}
        ref={setMarkerRef}
        title={location.formattedAddress}
        onClick={() => onSelect(placeId)}
      >
        <Pin location={location} />
      </AdvancedMarker>
      {selected && marker.current && (
        <MapPopover location={location} anchor={marker.current} onClose={onClose} />
      )}
    </>
  );
}

/**
 * One pin.
 *
 * The liturgical red for a household and a lighter tint of it for somebody on
 * their own -- the "visual indicating that it's a family" the requirement asks
 * for, done as two weights of one colour rather than two colours, so the pins
 * read as one set. "On their own" is decided per address rather than per
 * person, so the one member of a family who lives here while the rest of them
 * are elsewhere gets the lighter pin: the API has already sent them as an
 * individual, and nothing here has to know that. Gold is left to the church, which is then the only thing on
 * the map that is not somebody's home. A badge counts the households at an
 * address, so a two-flat reads as two before you tap it.
 */
function Pin({ location }: { location: MapLocationDto }) {
  const households = location.occupants.length;
  const isFamily = location.occupants.some((occupant) => occupant.kind === "family");

  return (
    <div className="relative">
      <div
        className={`flex h-8 w-8 items-center justify-center rounded-full border-2 border-white shadow-md transition-transform hover:scale-110 ${
          isFamily ? "bg-primary" : "bg-primary-light"
        }`}
      >
        <svg
          viewBox="0 0 24 24"
          className="h-4 w-4 text-white"
          fill="currentColor"
          aria-hidden="true"
        >
          {isFamily ? <FamilyGlyphPaths /> : <PersonGlyphPaths />}
        </svg>
      </div>
      {households > 1 && (
        <span className="absolute -right-1.5 -top-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-ink px-1 text-[10px] font-bold leading-none text-white">
          {households}
        </span>
      )}
    </div>
  );
}

/**
 * "Something like a circle with '5' indicating that there are 5 entities that
 * live close."
 *
 * The default renderer draws a Google-blue bubble, which is the one thing on
 * this page that would look borrowed. This is the same shape in the parish's
 * red, growing a little with the count so a cluster of forty reads as bigger
 * than a cluster of four without needing to be read.
 */
const clusterRenderer = {
  render: ({ count, position }: { count: number; position: google.maps.LatLng }) => {
    const size = count < 10 ? 34 : count < 50 ? 42 : 50;
    const div = document.createElement("div");
    div.className =
      "flex items-center justify-center rounded-full border-2 border-white bg-primary font-bold text-white shadow-lg";
    div.style.width = `${size}px`;
    div.style.height = `${size}px`;
    div.style.fontSize = count < 100 ? "13px" : "11px";
    div.textContent = String(count);

    return new google.maps.marker.AdvancedMarkerElement({
      position,
      content: div,
      zIndex: 1,
      title: `${count} addresses`,
    });
  },
};

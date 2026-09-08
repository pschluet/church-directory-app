import { describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { Navigate, Route, Routes } from "react-router";
import { renderWithProviders } from "./utils";

/**
 * The route guard on /map.
 *
 * `App.tsx` builds its router at module scope with `createBrowserRouter`, which
 * cannot be rendered into jsdom without a full session, so the guard is
 * reproduced here against the same `useMe` field. That is a real duplication and
 * worth naming: what this pins is the *behaviour* -- a parish without Map View
 * gets sent home rather than shown an explanation -- and the one line in
 * App.tsx that has to keep matching it is three lines long.
 */

const me = vi.fn();
vi.mock("../src/context/MeContext", () => ({
  useMe: () => me(),
}));

function RequireMapView({ children }: { children: React.ReactNode }) {
  const { mapViewEnabled } = me() as { mapViewEnabled: boolean };
  if (!mapViewEnabled) return <Navigate to="/" replace />;
  return children;
}

function App() {
  return (
    <Routes>
      <Route path="/" element={<p>Directory</p>} />
      <Route
        path="/map"
        element={
          <RequireMapView>
            <p>The map</p>
          </RequireMapView>
        }
      />
    </Routes>
  );
}

describe("RequireMapView", () => {
  it("renders the map for a parish that has it", async () => {
    me.mockReturnValue({ mapViewEnabled: true });
    renderWithProviders(<App />, { initialEntries: ["/map"] });
    expect(await screen.findByText("The map")).toBeInTheDocument();
  });

  it("sends a parish without it home rather than explaining", async () => {
    // Home and not a notice, matching RequireRole and the `*` route: a page you
    // do not have is not a page worth explaining, and the Directory does not
    // offer the link in the first place.
    me.mockReturnValue({ mapViewEnabled: false });
    renderWithProviders(<App />, { initialEntries: ["/map"] });
    await waitFor(() => expect(screen.getByText("Directory")).toBeInTheDocument());
    expect(screen.queryByText("The map")).not.toBeInTheDocument();
  });
});

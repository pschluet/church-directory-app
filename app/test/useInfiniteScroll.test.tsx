import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import { useInfiniteScroll } from "../src/components/useInfiniteScroll";

function List({ root }: { root?: Element | null }) {
  const ref = useInfiniteScroll(() => {}, { enabled: true, root });
  return <div ref={ref} />;
}

describe("useInfiniteScroll", () => {
  afterEach(() => vi.unstubAllGlobals());

  function stubObserver() {
    const options: IntersectionObserverInit[] = [];
    class FakeObserver {
      constructor(_cb: unknown, init: IntersectionObserverInit) {
        options.push(init);
      }
      observe() {}
      disconnect() {}
    }
    vi.stubGlobal("IntersectionObserver", FakeObserver);
    return options;
  }

  it("observes against the window by default", () => {
    const options = stubObserver();
    render(<List />);
    expect(options.at(-1)?.root).toBeNull();
  });

  it("observes against a scroll container when given one", () => {
    const options = stubObserver();
    const pane = document.createElement("div");
    render(<List root={pane} />);
    expect(options.at(-1)?.root).toBe(pane);
  });
});

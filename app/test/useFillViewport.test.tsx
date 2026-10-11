import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { useRef } from "react";
import { useFillViewport } from "../src/components/useFillViewport";

/**
 * The map's height.
 *
 * The bug this replaced: `h-[70vh]` plus a header measuring up to 232px plus
 * the page's padding and heading does not fit in 100vh, so the bottom of the
 * map sat below the fold on every desktop. These cases are the arithmetic, and
 * the two things that made a `calc()` unworkable — a viewport that iOS reports
 * two ways, and a page that changes height above the element.
 */

function Probe({
  top,
  gap,
  min,
  holdWhileTyping,
}: {
  top: number;
  gap?: number;
  min?: number;
  holdWhileTyping?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const height = useFillViewport(ref, { gap, min, holdWhileTyping });
  return (
    <div
      ref={(node) => {
        if (node) node.getBoundingClientRect = () => ({ top }) as DOMRect;
        ref.current = node;
      }}
      data-testid="probe"
      data-height={height ?? "none"}
    />
  );
}

const measured = () => screen.getByTestId("probe").dataset.height;

describe("useFillViewport", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("fills from the element down to the bottom of the window", () => {
    vi.stubGlobal("innerHeight", 900);
    render(<Probe top={300} />);
    // 900 - 300 - 24 of breathing room.
    expect(measured()).toBe("576");
  });

  it("honours the gap it was given", () => {
    vi.stubGlobal("innerHeight", 900);
    render(<Probe top={300} gap={0} />);
    expect(measured()).toBe("600");
  });

  it("prefers the visual viewport, which is what iOS actually shows", () => {
    // `innerHeight` counts the strip the address bar sits over, so sizing to it
    // puts the bottom of the map behind browser chrome.
    vi.stubGlobal("innerHeight", 900);
    vi.stubGlobal("visualViewport", {
      height: 700,
      addEventListener: () => {},
      removeEventListener: () => {},
    });
    render(<Probe top={300} />);
    expect(measured()).toBe("376");
  });

  describe("holdWhileTyping, for a phone's keyboard", () => {
    function Typing({ top }: { top: number }) {
      return (
        <>
          <Probe top={top} gap={0} min={50} holdWhileTyping />
          <textarea aria-label="message" />
        </>
      );
    }

    function stubViewport(touch: boolean) {
      const viewport = {
        height: 700,
        addEventListener: () => {},
        removeEventListener: () => {},
      };
      vi.stubGlobal("innerHeight", 900);
      vi.stubGlobal("visualViewport", viewport);
      vi.stubGlobal(
        "matchMedia",
        vi.fn(() => ({ matches: touch, addEventListener() {}, removeEventListener() {} }))
      );
      return viewport;
    }

    it("leaves the height alone while a field has focus on a touch screen", () => {
      const viewport = stubViewport(true);
      render(<Typing top={100} />);
      expect(measured()).toBe("600");

      screen.getByLabelText("message").focus();
      // The keyboard shrinks the visual viewport.
      viewport.height = 340;
      act(() => window.dispatchEvent(new Event("resize")));
      expect(measured()).toBe("600");
    });

    it("catches up once the field lets go and the keyboard has gone", async () => {
      vi.useFakeTimers();
      try {
        const viewport = stubViewport(true);
        render(<Typing top={100} />);
        screen.getByLabelText("message").focus();
        viewport.height = 340;
        act(() => window.dispatchEvent(new Event("resize")));
        expect(measured()).toBe("600");

        viewport.height = 700;
        act(() => {
          screen.getByLabelText("message").blur();
        });
        await act(() => vi.advanceTimersByTimeAsync(500));
        expect(measured()).toBe("600");

        viewport.height = 500;
        act(() => window.dispatchEvent(new Event("resize")));
        expect(measured()).toBe("400");
      } finally {
        vi.useRealTimers();
      }
    });

    it("keeps following the window on a laptop, where focus says nothing about it", () => {
      const viewport = stubViewport(false);
      render(<Typing top={100} />);
      screen.getByLabelText("message").focus();
      viewport.height = 500;
      act(() => window.dispatchEvent(new Event("resize")));
      expect(measured()).toBe("400");
    });
  });

  it("never collapses below a usable height", () => {
    // A short window, or an element pushed a long way down, would otherwise
    // give a map a few pixels tall or a negative one.
    vi.stubGlobal("innerHeight", 400);
    render(<Probe top={380} />);
    expect(measured()).toBe("320");
  });

  it("measures down the document, not down the viewport", () => {
    /*
     * `rect.top` alone shrinks as the page scrolls, so the map would shed
     * height every time somebody scrolled and grow it back on the way up.
     * Adding `scrollY` makes the answer a property of the layout instead.
     */
    vi.stubGlobal("innerHeight", 900);
    vi.stubGlobal("scrollY", 100);
    render(<Probe top={200} />);
    // The element is 300px down the document even though it is 200px down the
    // window, so the answer matches the unscrolled case.
    expect(measured()).toBe("576");
  });

  it("re-measures when the window changes size", () => {
    vi.stubGlobal("innerHeight", 900);
    render(<Probe top={300} />);
    expect(measured()).toBe("576");

    vi.stubGlobal("innerHeight", 700);
    act(() => {
      window.dispatchEvent(new Event("resize"));
    });
    expect(measured()).toBe("376");
  });
});
